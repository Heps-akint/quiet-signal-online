import { DurableObject as DurableObjectBase } from "cloudflare:workers";
import { z } from "zod";
import {
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  clientEventSchema,
  createRoomResponseSchema,
  inviteTokenSchema,
  type ResolvedCard,
  roomIdSchema,
  roomStateSchema,
  type SeatId,
  seatIdSchema,
  type ServerEvent,
  websocketTicketSchema
} from "@shared/protocol";
import {
  bootstrapSeat,
  createPublicRoomState,
  createRoomEngineState,
  leaveRoom,
  maybeAdvanceTimedPhase,
  playLowestCard,
  readyForLevel,
  requestPause,
  requestRematch,
  requestScan,
  resumeRound,
  respondScan,
  setConnectionState,
  setPlayerName,
  type DebugRoomPreset,
  type EngineEventType,
  type EngineUpdate,
  type RoomEngineState
} from "@shared/game-core";

interface RoomDocument {
  createdAt: number;
  origin: string;
  tokens: Record<SeatId, string>;
  socketTickets: Record<SeatId, SocketTicket | null>;
  activeConnections: Record<SeatId, string | null>;
  engine: RoomEngineState;
}

type RoomDurableObjectEnv = Record<string, unknown>;

interface SocketTicket {
  value: string;
  expiresAt: number;
}

interface SocketAttachment {
  seatId: SeatId;
  connectionId: string;
}

const ROOM_STORAGE_KEY = "room";
const SOCKET_TICKET_TTL_MS = 90 * 1000;
const MAX_WEBSOCKET_MESSAGE_BYTES = 4_096;

const roomInitSchema = z.object({
  roomId: roomIdSchema,
  seed: z.number().int().nonnegative(),
  origin: z.string().url(),
  createdAt: z.number().int().nonnegative(),
  tokens: z.object({
    host: inviteTokenSchema,
    guest: inviteTokenSchema
  }),
  debugPreset: z.unknown().optional()
});

const socketAttachmentSchema = z.object({
  seatId: seatIdSchema,
  connectionId: z.string().min(1)
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function randomSecret(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function isTrustedOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === expectedOrigin;
}

function messageByteLength(message: string | ArrayBuffer): number {
  if (typeof message === "string") {
    return new TextEncoder().encode(message).byteLength;
  }
  return message.byteLength;
}

export class RoomDurableObject extends DurableObjectBase<RoomDurableObjectEnv> {
  constructor(
    private readonly state: DurableObjectState,
    env: RoomDurableObjectEnv
  ) {
    super(state, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/init") {
      return this.handleInit(request);
    }

    if (request.method === "POST" && url.pathname === "/bootstrap") {
      return this.handleBootstrap(request);
    }

    if (request.method === "GET" && url.pathname === "/connect") {
      return this.handleConnect(request);
    }

    return new Response("Not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    const document = await this.readDocument();
    if (!document) {
      return;
    }

    const now = Date.now();
    if (now < document.engine.expiresAt) {
      await this.state.storage.setAlarm(document.engine.expiresAt);
      return;
    }

    for (const socket of this.state.getWebSockets()) {
      socket.close(1001, "Room expired");
    }
    await this.state.storage.deleteAll();
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (messageByteLength(message) > MAX_WEBSOCKET_MESSAGE_BYTES) {
      socket.close(1009, "Message too large");
      return;
    }

    const document = await this.readDocument();
    if (!document) {
      socket.close(1011, "Room not found");
      return;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment || !this.isActiveConnection(document, attachment)) {
      socket.close(4001, "Stale connection");
      return;
    }

    const now = Date.now();
    try {
      const rawMessage =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
      const event = clientEventSchema.parse(JSON.parse(rawMessage));

      switch (event.type) {
        case "join_room": {
          this.sendEventToSocket(
            socket,
            this.buildServerEvent(document, attachment.seatId, "room_snapshot", now, {})
          );
          return;
        }
        case "set_name": {
          await this.persistUpdate(document, setPlayerName(document.engine, attachment.seatId, event.displayName, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "ready_for_level": {
          await this.persistUpdate(document, readyForLevel(document.engine, attachment.seatId, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "play_lowest_card": {
          await this.persistUpdate(document, playLowestCard(document.engine, attachment.seatId, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "request_pause": {
          await this.persistUpdate(document, requestPause(document.engine, attachment.seatId, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "resume_round": {
          await this.persistUpdate(document, resumeRound(document.engine, attachment.seatId, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "request_scan": {
          await this.persistUpdate(document, requestScan(document.engine, attachment.seatId, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "respond_scan": {
          await this.persistUpdate(
            document,
            respondScan(document.engine, attachment.seatId, event.accepted, now),
            now,
            { seatId: attachment.seatId }
          );
          return;
        }
        case "request_rematch": {
          await this.persistUpdate(document, requestRematch(document.engine, attachment.seatId, now), now, {
            seatId: attachment.seatId
          });
          return;
        }
        case "leave_room": {
          socket.close(1000, "Client left");
          return;
        }
      }
    } catch (error) {
      this.sendError(socket, document, attachment.seatId, "invalid_state", this.errorMessage(error), now);
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.handleSocketEnd(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.handleSocketEnd(socket);
  }

  private async handleInit(request: Request): Promise<Response> {
    const existing = await this.readDocument();
    if (existing) {
      return new Response("Room already exists", { status: 409 });
    }

    const payload = roomInitSchema.parse(await request.json());
    const debugPreset = (payload.debugPreset ?? null) as DebugRoomPreset | null;
    const document: RoomDocument = {
      createdAt: payload.createdAt,
      origin: payload.origin,
      tokens: payload.tokens,
      socketTickets: {
        host: null,
        guest: null
      },
      activeConnections: {
        host: null,
        guest: null
      },
      engine: createRoomEngineState({
        roomId: payload.roomId,
        seed: payload.seed,
        now: payload.createdAt,
        debugPreset
      })
    };

    await this.writeDocument(document);
    return jsonResponse(
      createRoomResponseSchema.parse({
        roomId: payload.roomId,
        hostInviteUrl: `${payload.origin}/room/${payload.roomId}#${payload.tokens.host}`,
        guestInviteUrl: `${payload.origin}/room/${payload.roomId}#${payload.tokens.guest}`
      }),
      201
    );
  }

  private async handleBootstrap(request: Request): Promise<Response> {
    const document = await this.readDocument();
    if (!document) {
      return new Response("Room not found", { status: 404 });
    }
    if (!isTrustedOrigin(request, document.origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    const payload = bootstrapRequestSchema.parse(await request.json());
    const seatId = this.resolveSeatId(document.tokens, payload.token);
    if (!seatId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const now = Date.now();
    document.engine = bootstrapSeat(document.engine, seatId, now);
    document.socketTickets[seatId] = {
      value: randomSecret(),
      expiresAt: now + SOCKET_TICKET_TTL_MS
    };
    await this.writeDocument(document);
    this.broadcast(document, "room_snapshot", now, {});

    const socketTicket = document.socketTickets[seatId];
    if (!socketTicket) {
      return new Response("Failed to issue socket ticket", { status: 500 });
    }

    return jsonResponse(
      bootstrapResponseSchema.parse({
        roomId: document.engine.roomId,
        seatId,
        canReconnect: true,
        wsPath: `/api/rooms/${document.engine.roomId}/ws?ticket=${encodeURIComponent(socketTicket.value)}`,
        snapshot: roomStateSchema.parse(
          createPublicRoomState(document.engine, seatId, document.origin, document.tokens, now)
        )
      })
    );
  }

  private async handleConnect(request: Request): Promise<Response> {
    const document = await this.readDocument();
    if (!document) {
      return new Response("Room not found", { status: 404 });
    }
    if (!isTrustedOrigin(request, document.origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }

    const url = new URL(request.url);
    const ticket = websocketTicketSchema.safeParse(url.searchParams.get("ticket"));
    if (!ticket.success) {
      return new Response("Missing ticket", { status: 400 });
    }

    const now = Date.now();
    const seatId = this.resolveSeatIdFromSocketTicket(document.socketTickets, ticket.data, now);
    if (!seatId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    const connectionId = crypto.randomUUID();

    serverSocket.serializeAttachment({
      seatId,
      connectionId
    } satisfies SocketAttachment);
    this.state.acceptWebSocket(serverSocket, [seatId]);

    for (const otherSocket of this.state.getWebSockets(seatId)) {
      const attachment = this.readAttachment(otherSocket);
      if (!attachment || attachment.connectionId === connectionId) {
        continue;
      }
      otherSocket.close(4001, "Replaced by a newer connection");
    }

    document.socketTickets[seatId] = null;
    document.activeConnections[seatId] = connectionId;
    document.engine = setConnectionState(document.engine, seatId, true, now).state;
    await this.writeDocument(document);
    this.broadcast(document, "player_presence_changed", now, {
      seatId,
      connected: true
    });

    return new Response(null, {
      status: 101,
      webSocket: clientSocket
    });
  }

  private async handleSocketEnd(socket: WebSocket): Promise<void> {
    const document = await this.readDocument();
    if (!document) {
      return;
    }

    const attachment = this.readAttachment(socket);
    if (!attachment || !this.isActiveConnection(document, attachment)) {
      return;
    }

    document.activeConnections[attachment.seatId] = null;
    const now = Date.now();
    document.engine = leaveRoom(document.engine, attachment.seatId, now).state;
    await this.writeDocument(document);
    this.broadcast(document, "player_presence_changed", now, {
      seatId: attachment.seatId,
      connected: false
    });
  }

  private async persistUpdate(
    document: RoomDocument,
    update: EngineUpdate,
    now: number,
    meta: Record<string, unknown>
  ): Promise<void> {
    document.engine = maybeAdvanceTimedPhase(update.state, now);
    await this.writeDocument(document);
    this.broadcast(document, update.eventType, now, {
      ...meta,
      ...update.meta
    });
  }

  private async readDocument(): Promise<RoomDocument | null> {
    return (await this.state.storage.get<RoomDocument>(ROOM_STORAGE_KEY)) ?? null;
  }

  private async writeDocument(document: RoomDocument): Promise<void> {
    await this.state.storage.put(ROOM_STORAGE_KEY, document);
    await this.state.storage.setAlarm(document.engine.expiresAt);
  }

  private resolveSeatId(tokens: Record<SeatId, string>, token: string): SeatId | null {
    if (token === tokens.host) {
      return "host";
    }
    if (token === tokens.guest) {
      return "guest";
    }
    return null;
  }

  private resolveSeatIdFromSocketTicket(
    socketTickets: Record<SeatId, SocketTicket | null>,
    ticket: string,
    now: number
  ): SeatId | null {
    for (const seatId of ["host", "guest"] as const) {
      const entry = socketTickets[seatId];
      if (!entry || entry.expiresAt < now) {
        continue;
      }
      if (entry.value === ticket) {
        return seatId;
      }
    }
    return null;
  }

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    const parsed = socketAttachmentSchema.safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }

  private isActiveConnection(document: RoomDocument, attachment: SocketAttachment): boolean {
    return document.activeConnections[attachment.seatId] === attachment.connectionId;
  }

  private buildServerEvent(
    document: RoomDocument,
    viewerSeatId: SeatId,
    eventType: EngineEventType,
    now: number,
    meta: Record<string, unknown>
  ): ServerEvent {
    const snapshot = roomStateSchema.parse(
      createPublicRoomState(document.engine, viewerSeatId, document.origin, document.tokens, now)
    );

    switch (eventType) {
      case "room_snapshot":
        return {
          type: "room_snapshot",
          snapshot,
          serverTime: now
        };
      case "player_presence_changed":
        return {
          type: "player_presence_changed",
          snapshot,
          serverTime: now,
          seatId: seatIdSchema.parse(meta.seatId),
          connected: z.boolean().parse(meta.connected)
        };
      case "level_started":
        return {
          type: "level_started",
          snapshot,
          serverTime: now,
          level: snapshot.currentLevel
        };
      case "card_played":
        return {
          type: "card_played",
          snapshot,
          serverTime: now,
          seatId: seatIdSchema.parse(meta.seatId),
          card: z.number().int().parse(meta.card)
        };
      case "misplay_resolved":
        return {
          type: "misplay_resolved",
          snapshot,
          serverTime: now,
          seatId: seatIdSchema.parse(meta.seatId),
          card: z.number().int().parse(meta.card),
          discardedCards: z.array(z.custom<ResolvedCard>()).parse(meta.discardedCards)
        };
      case "pause_state_changed":
        return {
          type: "pause_state_changed",
          snapshot,
          serverTime: now,
          resumed: z.boolean().parse(meta.resumed)
        };
      case "scan_state_changed":
        return {
          type: "scan_state_changed",
          snapshot,
          serverTime: now,
          resolved: z.boolean().parse(meta.resolved),
          accepted: z.boolean().parse(meta.accepted),
          discardedCards: meta.discardedCards
            ? z.array(z.custom<ResolvedCard>()).parse(meta.discardedCards)
            : undefined
        };
      case "level_cleared":
        return {
          type: "level_cleared",
          snapshot,
          serverTime: now,
          clearedLevel: z.number().int().parse(snapshot.summary?.kind === "level_cleared" ? snapshot.summary.level : 1),
          rewards:
            snapshot.summary?.kind === "level_cleared"
              ? snapshot.summary.rewards
              : { life: false, scan: false }
        };
      case "game_won":
        return {
          type: "game_won",
          snapshot,
          serverTime: now,
          completedLevel:
            snapshot.summary?.kind === "game_won" ? snapshot.summary.level : snapshot.currentLevel
        };
      case "game_lost":
        return {
          type: "game_lost",
          snapshot,
          serverTime: now,
          failedLevel:
            snapshot.summary?.kind === "game_lost" ? snapshot.summary.level : snapshot.currentLevel
        };
    }
  }

  private broadcast(
    document: RoomDocument,
    eventType: EngineEventType,
    now: number,
    meta: Record<string, unknown>
  ): void {
    const sockets = this.state.getWebSockets();
    for (const socket of sockets) {
      const attachment = this.readAttachment(socket);
      if (!attachment || !this.isActiveConnection(document, attachment)) {
        continue;
      }
      this.sendEventToSocket(socket, this.buildServerEvent(document, attachment.seatId, eventType, now, meta));
    }
  }

  private sendEventToSocket(socket: WebSocket, event: ServerEvent): void {
    socket.send(JSON.stringify(event));
  }

  private sendError(
    socket: WebSocket,
    document: RoomDocument | null,
    viewerSeatId: SeatId | null,
    code: "unauthorized" | "invalid_state" | "validation_failed" | "conflict" | "room_not_found",
    message: string,
    now: number
  ): void {
    const snapshot =
      document && viewerSeatId
        ? createPublicRoomState(document.engine, viewerSeatId, document.origin, document.tokens, now)
        : undefined;
    socket.send(
      JSON.stringify({
        type: "room_error",
        code,
        message,
        snapshot,
        serverTime: now
      } satisfies ServerEvent)
    );
  }

  private errorMessage(error: unknown): string {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return "Couldn't process that action.";
    }
    if (error instanceof Error) {
      return error.message;
    }
    return "Unknown room error.";
  }
}


