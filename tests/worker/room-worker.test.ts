import {
  env,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapResponseSchema,
  createRoomResponseSchema
} from "@shared/protocol";

interface TestEnv {
  ROOMS: DurableObjectNamespace;
  SECURITY_GATE: DurableObjectNamespace;
  ALLOW_DEBUG_ROOM_PRESETS: string;
}

const workerEnv = env as unknown as TestEnv;

async function resetNamespace(namespace: DurableObjectNamespace): Promise<void> {
  const ids = await listDurableObjectIds(namespace);
  for (const id of ids) {
    const stub = namespace.get(id);
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      for (const socket of state.getWebSockets()) {
        socket.close(1001, "Test reset");
      }
      await state.storage.deleteAll();
    });
  }
}

function tokenFromInvite(inviteUrl: string): string {
  return new URL(inviteUrl).hash.slice(1);
}

async function bootstrap(roomId: string, token: string) {
  const response = await SELF.fetch(`https://example.com/api/rooms/${roomId}/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      token
    })
  });
  if (!response.ok) {
    throw new Error(`bootstrap failed with ${response.status}: ${await response.text()}`);
  }
  return bootstrapResponseSchema.parse(await response.json());
}

describe("room worker", () => {
  beforeEach(async () => {
    await resetNamespace(workerEnv.ROOMS);
    await resetNamespace(workerEnv.SECURITY_GATE);
  });

  it("creates a room and bootstraps both seats", async () => {
    const createResponse = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(createResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(createResponse.headers.get("x-frame-options")).toBe("DENY");
    const payload = createRoomResponseSchema.parse(await createResponse.json());

    const hostToken = tokenFromInvite(payload.hostInviteUrl);
    const guestToken = tokenFromInvite(payload.guestInviteUrl);
    const hostBootstrap = await bootstrap(payload.roomId, hostToken);
    const guestBootstrap = await bootstrap(payload.roomId, guestToken);

    expect(hostBootstrap.snapshot.phase).toBe("waiting");
    expect(hostBootstrap.wsPath).toContain("ticket=");
    expect(hostBootstrap.wsPath).not.toContain(hostToken);
    expect(guestBootstrap.snapshot.phase).toBe("between_levels");
    expect(guestBootstrap.snapshot.players.host.hasJoined).toBe(true);
    expect(guestBootstrap.snapshot.players.guest.hasJoined).toBe(true);

    const ids = await listDurableObjectIds(workerEnv.ROOMS);
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("deletes expired rooms when the alarm fires", async () => {
    const createResponse = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const payload = createRoomResponseSchema.parse(await createResponse.json());
    const stub = workerEnv.ROOMS.get(workerEnv.ROOMS.idFromName(payload.roomId));
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      const document = await state.storage.get<{ engine: { expiresAt: number } }>("room");
      if (!document) {
        throw new Error("Missing room document.");
      }
      document.engine.expiresAt = Date.now() - 1;
      await state.storage.put("room", document);
    });

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const stored = await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) =>
      state.storage.get("room")
    );
    expect(stored).toBeUndefined();
    expect(payload.roomId).toBeTruthy();
  });

  it("rejects cross-origin room creation requests", async () => {
    const response = await SELF.fetch("https://example.com/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example"
      },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Origin not allowed."
    });
  });

  it("rate limits repeated room creation from the same client ip", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await SELF.fetch("https://example.com/api/rooms", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.42"
        },
        body: JSON.stringify({})
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 12)).toEqual(new Array(12).fill(201));
    expect(statuses[12]).toBe(429);
  });
});
