import {
  FOCUS_TRANSITION_MS,
  MAX_LEVEL,
  MAX_PLAYER_NAME_LENGTH,
  ROOM_RESUME_TTL_MS,
  STARTING_LIVES,
  STARTING_SCANS,
  type CreateRoomRequest,
  type LevelReward,
  type PendingRequest,
  type ResolvedCard,
  type RoomPhase,
  type RoomState,
  type RoomSummary,
  type SeatId,
  seatIds
} from "@shared/protocol";

export interface InternalPlayerState {
  seatId: SeatId;
  displayName: string;
  joinedAt: number | null;
  connected: boolean;
  ready: boolean;
  hand: number[];
  lastSeenAt: number | null;
}

export interface DebugRoomPreset {
  seed?: number;
  deals: Partial<Record<number, { host: number[]; guest: number[] }>>;
}

export interface RoomEngineState {
  roomId: string;
  phase: RoomPhase;
  currentLevel: number;
  maxLevel: typeof MAX_LEVEL;
  lives: number;
  scans: number;
  seed: number;
  players: Record<SeatId, InternalPlayerState>;
  pile: ResolvedCard[];
  pendingRequest: PendingRequest;
  summary: RoomSummary;
  transitionEndsAt: number | null;
  eventId: number;
  lastActivityAt: number;
  expiresAt: number;
  debugPreset: DebugRoomPreset | null;
}

export type EngineEventType =
  | "room_snapshot"
  | "player_presence_changed"
  | "level_started"
  | "card_played"
  | "misplay_resolved"
  | "pause_state_changed"
  | "scan_state_changed"
  | "level_cleared"
  | "game_won"
  | "game_lost";

export interface EngineUpdate {
  state: RoomEngineState;
  eventType: EngineEventType;
  meta?: Record<string, unknown>;
}

function createPlayer(seatId: SeatId, displayName: string): InternalPlayerState {
  return {
    seatId,
    displayName,
    joinedAt: null,
    connected: false,
    ready: false,
    hand: [],
    lastSeenAt: null
  };
}

export function sanitizeDisplayName(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, MAX_PLAYER_NAME_LENGTH) || "Player";
}

export function levelRewards(level: number): LevelReward {
  return {
    scan: level === 2 || level === 5 || level === 8,
    life: level === 3 || level === 6 || level === 9
  };
}

export function createRoomEngineState(args: {
  roomId: string;
  seed: number;
  now: number;
  debugPreset?: DebugRoomPreset | null;
}): RoomEngineState {
  const { roomId, seed, now, debugPreset = null } = args;
  return {
    roomId,
    phase: "waiting",
    currentLevel: 1,
    maxLevel: MAX_LEVEL,
    lives: STARTING_LIVES,
    scans: STARTING_SCANS,
    seed,
    players: {
      host: createPlayer("host", "Host"),
      guest: createPlayer("guest", "Guest")
    },
    pile: [],
    pendingRequest: null,
    summary: null,
    transitionEndsAt: null,
    eventId: 0,
    lastActivityAt: now,
    expiresAt: now + ROOM_RESUME_TTL_MS,
    debugPreset
  };
}

export function normalizeDebugPreset(
  input: CreateRoomRequest["debugPreset"] | undefined
): DebugRoomPreset | null {
  if (!input) {
    return null;
  }

  const deals: DebugRoomPreset["deals"] = {};
  for (const [rawLevel, deal] of Object.entries(input.deals ?? {})) {
    const level = Number.parseInt(rawLevel, 10);
    if (Number.isNaN(level) || level < 1 || level > MAX_LEVEL) {
      throw new Error(`Invalid debug level: ${rawLevel}`);
    }
    if (deal.host.length !== level || deal.guest.length !== level) {
      throw new Error(`Debug deal for level ${level} must contain exactly ${level} cards per seat.`);
    }
    const allCards = [...deal.host, ...deal.guest];
    if (new Set(allCards).size !== allCards.length) {
      throw new Error(`Debug deal for level ${level} contains duplicate cards.`);
    }
    deals[level] = {
      host: [...deal.host].sort((left, right) => left - right),
      guest: [...deal.guest].sort((left, right) => left - right)
    };
  }

  return {
    seed: input.seed,
    deals
  };
}

function createApprovals(requesterSeatId: SeatId): { host: boolean; guest: boolean } {
  return {
    host: requesterSeatId === "host",
    guest: requesterSeatId === "guest"
  };
}

function clonePlayers(players: RoomEngineState["players"]): RoomEngineState["players"] {
  return {
    host: { ...players.host, hand: [...players.host.hand] },
    guest: { ...players.guest, hand: [...players.guest.hand] }
  };
}

function withStateUpdate(
  state: RoomEngineState,
  now: number,
  partial: Partial<RoomEngineState>
): RoomEngineState {
  return {
    ...state,
    ...partial,
    eventId: state.eventId + 1,
    lastActivityAt: now,
    expiresAt: now + ROOM_RESUME_TTL_MS
  };
}

function bothPlayersJoined(state: RoomEngineState): boolean {
  return seatIds.every((seatId) => state.players[seatId].joinedAt !== null);
}

function allPlayersReady(state: RoomEngineState): boolean {
  return seatIds.every((seatId) => state.players[seatId].ready);
}

function allHandsEmpty(state: RoomEngineState): boolean {
  return seatIds.every((seatId) => state.players[seatId].hand.length === 0);
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let next = Math.imul(value ^ (value >>> 15), value | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeck(seed: number): number[] {
  const deck = Array.from({ length: 100 }, (_, index) => index + 1);
  const random = mulberry32(seed);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function dealHands(state: RoomEngineState, level: number): { host: number[]; guest: number[] } {
  const preset = state.debugPreset?.deals[level];
  if (preset) {
    return {
      host: [...preset.host],
      guest: [...preset.guest]
    };
  }

  const deckSeed = (state.seed ^ Math.imul(level, 0x9e3779b1)) >>> 0;
  const deck = shuffleDeck(deckSeed);
  return {
    host: deck.slice(0, level).sort((left, right) => left - right),
    guest: deck.slice(level, level * 2).sort((left, right) => left - right)
  };
}

function nextRunSeed(state: RoomEngineState, now: number): number {
  const mixedNow = now >>> 0;
  const mixedEventId = state.eventId >>> 0;
  const nextSeed =
    (state.seed ^
      Math.imul(mixedNow ^ 0x9e3779b9, 0x85ebca6b) ^
      Math.imul(mixedEventId ^ 0xc2b2ae35, 0x27d4eb2f)) >>>
    0;

  return nextSeed === state.seed ? (state.seed + 1) >>> 0 : nextSeed;
}

function viewerInviteLink(
  roomId: string,
  viewerSeatId: SeatId,
  tokens: Record<SeatId, string>,
  origin: string
): string | null {
  if (viewerSeatId !== "host") {
    return null;
  }
  return `${origin}/room/${roomId}#${tokens.guest}`;
}

function readyFlagsCleared(players: RoomEngineState["players"]): RoomEngineState["players"] {
  return {
    host: { ...players.host, ready: false },
    guest: { ...players.guest, ready: false }
  };
}

export function maybeAdvanceTimedPhase(state: RoomEngineState, now: number): RoomEngineState {
  if (state.phase !== "focus_transition" || state.transitionEndsAt === null || now < state.transitionEndsAt) {
    return state;
  }
  return {
    ...state,
    phase: "in_round",
    transitionEndsAt: null
  };
}

export function createPublicRoomState(
  state: RoomEngineState,
  viewerSeatId: SeatId,
  origin: string,
  tokens: Record<SeatId, string>,
  now: number
): RoomState {
  const advancedState = maybeAdvanceTimedPhase(state, now);
  return {
    roomId: advancedState.roomId,
    viewerSeatId,
    phase: advancedState.phase,
    currentLevel: advancedState.currentLevel,
    maxLevel: advancedState.maxLevel,
    lives: advancedState.lives,
    scans: advancedState.scans,
    players: {
      host: {
        seatId: "host",
        displayName: advancedState.players.host.displayName,
        isSelf: viewerSeatId === "host",
        hasJoined: advancedState.players.host.joinedAt !== null,
        connected: advancedState.players.host.connected,
        ready: advancedState.players.host.ready,
        hand: viewerSeatId === "host" ? [...advancedState.players.host.hand] : [],
        handCount: advancedState.players.host.hand.length,
        resume: {
          joinedAt: advancedState.players.host.joinedAt,
          lastSeenAt: advancedState.players.host.lastSeenAt,
          canReconnectUntil: advancedState.expiresAt
        }
      },
      guest: {
        seatId: "guest",
        displayName: advancedState.players.guest.displayName,
        isSelf: viewerSeatId === "guest",
        hasJoined: advancedState.players.guest.joinedAt !== null,
        connected: advancedState.players.guest.connected,
        ready: advancedState.players.guest.ready,
        hand: viewerSeatId === "guest" ? [...advancedState.players.guest.hand] : [],
        handCount: advancedState.players.guest.hand.length,
        resume: {
          joinedAt: advancedState.players.guest.joinedAt,
          lastSeenAt: advancedState.players.guest.lastSeenAt,
          canReconnectUntil: advancedState.expiresAt
        }
      }
    },
    pile: [...advancedState.pile],
    pendingRequest: advancedState.pendingRequest,
    summary: advancedState.summary,
    transitionEndsAt: advancedState.transitionEndsAt,
    eventId: advancedState.eventId,
    lastActivityAt: advancedState.lastActivityAt,
    expiresAt: advancedState.expiresAt,
    inviteLink: viewerInviteLink(advancedState.roomId, viewerSeatId, tokens, origin),
    canStartLevel:
      advancedState.phase === "between_levels" &&
      bothPlayersJoined(advancedState) &&
      !advancedState.players[viewerSeatId].ready,
    canRequestPause: advancedState.phase === "in_round" && advancedState.pendingRequest === null,
    canRequestScan:
      advancedState.phase === "in_round" &&
      advancedState.pendingRequest === null &&
      advancedState.scans > 0
  };
}

export function bootstrapSeat(state: RoomEngineState, seatId: SeatId, now: number): RoomEngineState {
  const players = clonePlayers(state.players);
  players[seatId] = {
    ...players[seatId],
    joinedAt: players[seatId].joinedAt ?? now,
    lastSeenAt: now
  };
  const nextPhase = state.phase === "waiting" && bothPlayersJoined({ ...state, players }) ? "between_levels" : state.phase;
  return withStateUpdate(state, now, {
    players,
    phase: nextPhase
  });
}

export function setConnectionState(
  state: RoomEngineState,
  seatId: SeatId,
  connected: boolean,
  now: number
): EngineUpdate {
  const players = clonePlayers(state.players);
  players[seatId] = {
    ...players[seatId],
    connected,
    lastSeenAt: now
  };
  return {
    state: withStateUpdate(state, now, { players }),
    eventType: "player_presence_changed"
  };
}

export function setPlayerName(
  state: RoomEngineState,
  seatId: SeatId,
  displayName: string,
  now: number
): EngineUpdate {
  const players = clonePlayers(state.players);
  players[seatId] = {
    ...players[seatId],
    displayName: sanitizeDisplayName(displayName),
    lastSeenAt: now
  };
  return {
    state: withStateUpdate(state, now, { players }),
    eventType: "room_snapshot"
  };
}

function startFocusedLevel(state: RoomEngineState, now: number): RoomEngineState {
  const players = readyFlagsCleared(clonePlayers(state.players));
  const hands = dealHands(state, state.currentLevel);
  players.host.hand = hands.host;
  players.guest.hand = hands.guest;
  return withStateUpdate(state, now, {
    phase: "focus_transition",
    pendingRequest: null,
    summary: null,
    transitionEndsAt: now + FOCUS_TRANSITION_MS,
    players,
    pile: []
  });
}

export function readyForLevel(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  if (state.phase !== "between_levels") {
    throw new Error("The room is not waiting for level readiness.");
  }

  const players = clonePlayers(state.players);
  players[seatId] = {
    ...players[seatId],
    ready: true,
    lastSeenAt: now
  };

  const readyState = withStateUpdate(state, now, { players });
  if (bothPlayersJoined(readyState) && allPlayersReady(readyState)) {
    return {
      state: startFocusedLevel(readyState, now),
      eventType: "level_started"
    };
  }

  return {
    state: readyState,
    eventType: "room_snapshot"
  };
}

function sortedDiscardedCards(discardedCards: ResolvedCard[], playedCard: ResolvedCard | null): ResolvedCard[] {
  const sortedDiscarded = [...discardedCards].sort((left, right) => left.value - right.value);
  return playedCard ? [...sortedDiscarded, playedCard] : sortedDiscarded;
}

function clearLevel(state: RoomEngineState, now: number): EngineUpdate {
  if (state.currentLevel >= state.maxLevel) {
    return {
      state: withStateUpdate(state, now, {
        phase: "won",
        pendingRequest: null,
        summary: {
          kind: "game_won",
          level: state.currentLevel,
          message: "All 12 levels down."
        },
        transitionEndsAt: null,
        players: readyFlagsCleared(clonePlayers(state.players))
      }),
      eventType: "game_won"
    };
  }

  const rewards = levelRewards(state.currentLevel);
  return {
    state: withStateUpdate(state, now, {
      phase: "between_levels",
      currentLevel: state.currentLevel + 1,
      lives: state.lives + (rewards.life ? 1 : 0),
      scans: state.scans + (rewards.scan ? 1 : 0),
      pendingRequest: null,
      summary: {
        kind: "level_cleared",
        level: state.currentLevel,
        rewards,
        message: `Level ${state.currentLevel} cleared.`
      },
      transitionEndsAt: null,
      players: readyFlagsCleared(clonePlayers(state.players))
    }),
    eventType: "level_cleared"
  };
}

function loseGame(state: RoomEngineState, now: number): EngineUpdate {
  return {
    state: withStateUpdate(state, now, {
      phase: "lost",
      pendingRequest: null,
        summary: {
          kind: "game_lost",
          level: state.currentLevel,
          livesRemaining: state.lives,
          message: "Out of lives."
        },
      transitionEndsAt: null,
      players: readyFlagsCleared(clonePlayers(state.players))
    }),
    eventType: "game_lost"
  };
}

export function playLowestCard(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  const advancedState = maybeAdvanceTimedPhase(state, now);
  if (advancedState.phase !== "in_round") {
    throw new Error("Cards can only be played during a live round.");
  }
  if (advancedState.pendingRequest !== null) {
    throw new Error("Resolve the pending request before playing cards.");
  }

  const players = clonePlayers(advancedState.players);
  const player = players[seatId];
  const playedValue = player.hand[0];
  if (playedValue === undefined) {
    throw new Error("No cards left to play.");
  }

  player.hand = player.hand.slice(1);
  player.lastSeenAt = now;

  const globalLowest = Math.min(
    players.host.hand[0] ?? Number.POSITIVE_INFINITY,
    players.guest.hand[0] ?? Number.POSITIVE_INFINITY,
    playedValue
  );

  let lives = advancedState.lives;
  const discardedCards: ResolvedCard[] = [];
  if (playedValue !== globalLowest) {
    lives -= 1;
    for (const currentSeatId of seatIds) {
      const currentPlayer = players[currentSeatId];
      while ((currentPlayer.hand[0] ?? Number.POSITIVE_INFINITY) < playedValue) {
        const [discarded] = currentPlayer.hand.splice(0, 1);
        discardedCards.push({
          seatId: currentSeatId,
          value: discarded,
          level: advancedState.currentLevel,
          resolution: "misplay_discard",
          timestamp: now
        });
      }
    }
  }

  const playedCard: ResolvedCard = {
    seatId,
    value: playedValue,
    level: advancedState.currentLevel,
    resolution: "played",
    timestamp: now
  };

  const pile = [...advancedState.pile, ...sortedDiscardedCards(discardedCards, playedCard)];
  const summary =
    discardedCards.length > 0
      ? {
          kind: "misplay" as const,
          level: advancedState.currentLevel,
          triggeringSeatId: seatId,
          playedCard: playedValue,
          discardedCards: sortedDiscardedCards(discardedCards, null),
          livesRemaining: lives,
          message: `Life lost. ${playedValue} landed too early.`
        }
      : null;

  const nextState = withStateUpdate(advancedState, now, {
    players,
    lives,
    pile,
    summary,
    pendingRequest: null
  });

  if (nextState.lives <= 0) {
    return loseGame(nextState, now);
  }

  if (allHandsEmpty(nextState)) {
    return clearLevel(nextState, now);
  }

  return {
    state: nextState,
    eventType: discardedCards.length > 0 ? "misplay_resolved" : "card_played",
    meta: {
      card: playedValue,
      discardedCards
    }
  };
}

export function requestPause(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  const advancedState = maybeAdvanceTimedPhase(state, now);
  if (advancedState.phase !== "in_round") {
    throw new Error("Pause is only available during a live round.");
  }
  if (advancedState.pendingRequest !== null) {
    throw new Error("Another request is already pending.");
  }
  return {
    state: withStateUpdate(advancedState, now, {
      phase: "paused",
      pendingRequest: {
        kind: "pause",
        requesterSeatId: seatId,
        approvals: createApprovals(seatId)
      }
    }),
    eventType: "pause_state_changed",
    meta: {
      resumed: false
    }
  };
}

export function resumeRound(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  if (state.phase !== "paused" || state.pendingRequest?.kind !== "pause") {
    throw new Error("The room is not paused.");
  }
  const approvals = {
    ...state.pendingRequest.approvals,
    [seatId]: true
  };
  const resumed = approvals.host && approvals.guest;
  const nextState = withStateUpdate(state, now, {
    pendingRequest: resumed
      ? null
      : {
          kind: "pause",
          requesterSeatId: state.pendingRequest.requesterSeatId,
          approvals
        },
    phase: resumed ? "focus_transition" : state.phase,
    transitionEndsAt: resumed ? now + FOCUS_TRANSITION_MS : state.transitionEndsAt,
    summary: null
  });
  return {
    state: nextState,
    eventType: "pause_state_changed",
    meta: {
      resumed
    }
  };
}

export function requestScan(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  const advancedState = maybeAdvanceTimedPhase(state, now);
  if (advancedState.phase !== "in_round") {
    throw new Error("Scan is only available during a live round.");
  }
  if (advancedState.pendingRequest !== null) {
    throw new Error("Another request is already pending.");
  }
  if (advancedState.scans <= 0) {
    throw new Error("No scan left.");
  }

  return {
    state: withStateUpdate(advancedState, now, {
      pendingRequest: {
        kind: "scan",
        requesterSeatId: seatId,
        approvals: createApprovals(seatId)
      }
    }),
    eventType: "scan_state_changed",
    meta: {
      resolved: false,
      accepted: true
    }
  };
}

export function respondScan(
  state: RoomEngineState,
  seatId: SeatId,
  accepted: boolean,
  now: number
): EngineUpdate {
  const advancedState = maybeAdvanceTimedPhase(state, now);
  if (advancedState.phase !== "in_round" || advancedState.pendingRequest?.kind !== "scan") {
    throw new Error("No scan vote is active.");
  }

  if (!accepted) {
    return {
      state: withStateUpdate(advancedState, now, {
        pendingRequest: null
      }),
      eventType: "scan_state_changed",
      meta: {
        resolved: true,
        accepted: false
      }
    };
  }

  const approvals = {
    ...advancedState.pendingRequest.approvals,
    [seatId]: true
  };
  if (!(approvals.host && approvals.guest)) {
    return {
      state: withStateUpdate(advancedState, now, {
        pendingRequest: {
          kind: "scan",
          requesterSeatId: advancedState.pendingRequest.requesterSeatId,
          approvals
        }
      }),
      eventType: "scan_state_changed",
      meta: {
        resolved: false,
        accepted: true
      }
    };
  }

  const players = clonePlayers(advancedState.players);
  const discardedCards: ResolvedCard[] = [];
  for (const currentSeatId of seatIds) {
    const value = players[currentSeatId].hand.shift();
    if (value === undefined) {
      continue;
    }
    discardedCards.push({
      seatId: currentSeatId,
      value,
      level: advancedState.currentLevel,
      resolution: "scan_discard",
      timestamp: now
    });
  }
  discardedCards.sort((left, right) => left.value - right.value);

  const nextState = withStateUpdate(advancedState, now, {
    players,
    scans: advancedState.scans - 1,
    pendingRequest: null,
    pile: [...advancedState.pile, ...discardedCards],
    summary: {
      kind: "scan",
      level: advancedState.currentLevel,
      discardedCards,
      scansRemaining: advancedState.scans - 1,
      message: "Scan spent."
    }
  });

  if (allHandsEmpty(nextState)) {
    return clearLevel(nextState, now);
  }

  return {
    state: nextState,
    eventType: "scan_state_changed",
    meta: {
      resolved: true,
      accepted: true,
      discardedCards
    }
  };
}

export function requestRematch(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  if (state.phase !== "won" && state.phase !== "lost") {
    throw new Error("Rematch is only available after the game ends.");
  }

  const players = clonePlayers(state.players);
  players[seatId] = {
    ...players[seatId],
    ready: true,
    lastSeenAt: now
  };

  const readyState = withStateUpdate(state, now, { players });
  if (!allPlayersReady(readyState)) {
    return {
      state: readyState,
      eventType: "room_snapshot"
    };
  }

  const resetState = createRoomEngineState({
    roomId: state.roomId,
    seed: state.debugPreset ? state.seed : nextRunSeed(readyState, now),
    now,
    debugPreset: state.debugPreset
  });
  resetState.players.host = {
    ...resetState.players.host,
    displayName: state.players.host.displayName,
    joinedAt: state.players.host.joinedAt,
    connected: state.players.host.connected,
    lastSeenAt: state.players.host.lastSeenAt
  };
  resetState.players.guest = {
    ...resetState.players.guest,
    displayName: state.players.guest.displayName,
    joinedAt: state.players.guest.joinedAt,
    connected: state.players.guest.connected,
    lastSeenAt: state.players.guest.lastSeenAt
  };
  resetState.phase = bothPlayersJoined(resetState) ? "between_levels" : "waiting";
  resetState.eventId = readyState.eventId + 1;
  resetState.lastActivityAt = now;
  resetState.expiresAt = now + ROOM_RESUME_TTL_MS;

  return {
    state: resetState,
    eventType: "room_snapshot"
  };
}

export function leaveRoom(state: RoomEngineState, seatId: SeatId, now: number): EngineUpdate {
  return setConnectionState(state, seatId, false, now);
}


