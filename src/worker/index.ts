import { Hono } from "hono";
import { z } from "zod";
import { normalizeDebugPreset } from "@shared/game-core";
import {
  bootstrapRequestSchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  ROOM_ID_ALPHABET,
  roomIdSchema
} from "@shared/protocol";
import { RoomDurableObject } from "@worker/room-durable-object";
import { SecurityGateDurableObject } from "@worker/security-gate-durable-object";

interface AppEnv {
  ROOMS: DurableObjectNamespace;
  SECURITY_GATE: DurableObjectNamespace;
  ALLOW_DEBUG_ROOM_PRESETS?: string;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const app = new Hono<{ Bindings: AppEnv }>();

const JSON_BODY_LIMIT_BYTES = 8 * 1024;

const CREATE_ROOM_RATE_LIMIT = {
  limit: 12,
  windowMs: 60 * 1000
} as const;

const BOOTSTRAP_RATE_LIMIT = {
  limit: 40,
  windowMs: 60 * 1000
} as const;

function jsonResponse(payload: unknown, status = 200, requestUrl?: URL): Response {
  const response = new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
  if (requestUrl) {
    applySecurityHeaders(response.headers, requestUrl);
  }
  return response;
}

function applySecurityHeaders(headers: Headers, requestUrl: URL): void {
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("permissions-policy", "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), fullscreen=(self)");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");

  if (requestUrl.protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
  }
}

function withSecurityHeaders(response: Response, requestUrl: URL): Response {
  if (response.status === 101) {
    return response;
  }

  const securedResponse = new Response(response.body, response);
  applySecurityHeaders(securedResponse.headers, requestUrl);
  return securedResponse;
}

function randomRoomId(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ROOM_ID_ALPHABET[value % ROOM_ID_ALPHABET.length]).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] ?? 0;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > JSON_BODY_LIMIT_BYTES) {
    throw new RequestError(413, "Request body is too large.");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > JSON_BODY_LIMIT_BYTES) {
    throw new RequestError(413, "Request body is too large.");
  }
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "Invalid JSON.");
  }
}

function isLocalOrigin(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function rejectCrossOriginRequest(request: Request, expectedOrigin: string): Response | null {
  const origin = request.headers.get("origin");
  if (!origin || origin === expectedOrigin) {
    return null;
  }
  return jsonResponse(
    {
      error: "Origin not allowed."
    },
    403,
    new URL(request.url)
  );
}

function parseRoomId(roomId: string): string {
  const parsed = roomIdSchema.safeParse(roomId);
  if (!parsed.success) {
    throw new RequestError(400, "Invalid room id.");
  }
  return parsed.data;
}

function rateLimitKey(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "anonymous";
}

async function enforceRateLimit(
  context: { env: AppEnv; req: { raw: Request } },
  scope: string,
  rule: {
    limit: number;
    windowMs: number;
  }
): Promise<Response | null> {
  const clientKey = rateLimitKey(context.req.raw);
  const stub = context.env.SECURITY_GATE.get(context.env.SECURITY_GATE.idFromName(`${scope}:${clientKey}`));
  const response = await stub.fetch("https://security/check", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(rule)
  });

  if (response.status === 429) {
    return jsonResponse(
      {
        error: "Too many requests. Slow down and try again."
      },
      429
    );
  }
  if (!response.ok) {
    throw new RequestError(503, "Request throttling is unavailable.");
  }
  return null;
}

function forwardRequestHeaders(source: Request): Headers {
  const headers = new Headers({
    "content-type": "application/json"
  });
  const origin = source.headers.get("origin");
  if (origin) {
    headers.set("origin", origin);
  }
  return headers;
}

app.get("/healthz", (context) =>
  jsonResponse(
    {
      ok: true,
      timestamp: new Date().toISOString()
    },
    200,
    new URL(context.req.url)
  )
);

app.post("/api/rooms", async (context) => {
  const requestUrl = new URL(context.req.url);
  const originResponse = rejectCrossOriginRequest(context.req.raw, requestUrl.origin);
  if (originResponse) {
    return originResponse;
  }

  const limited = await enforceRateLimit(context, "create-room", CREATE_ROOM_RATE_LIMIT);
  if (limited) {
    return limited;
  }

  const parsedBody = createRoomRequestSchema.parse(await readJsonBody(context.req.raw));
  const debugPresetsEnabled =
    context.env.ALLOW_DEBUG_ROOM_PRESETS === "true" || isLocalOrigin(requestUrl);

  if (parsedBody.debugPreset && !debugPresetsEnabled) {
    return jsonResponse(
      {
        error: "Debug room presets are disabled."
      },
      403,
      requestUrl
    );
  }

  const normalizedPreset = normalizeDebugPreset(parsedBody.debugPreset);
  const origin = requestUrl.origin;
  const createdAt = Date.now();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomId = randomRoomId();
    const tokens = {
      host: randomToken(),
      guest: randomToken()
    };
    const seed = normalizedPreset?.seed ?? randomSeed();
    const stub = context.env.ROOMS.get(context.env.ROOMS.idFromName(roomId));

    const response = await stub.fetch("https://room/internal/init", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        roomId,
        seed,
        origin,
        createdAt,
        tokens,
        debugPreset: normalizedPreset
      })
    });

    if (response.status === 409) {
      continue;
    }
    if (!response.ok) {
      return jsonResponse(
        {
          error: "Failed to create room."
        },
        500,
        requestUrl
      );
    }

    const payload = createRoomResponseSchema.parse(await response.json());
    return jsonResponse(payload, 201, requestUrl);
  }

  return jsonResponse(
    {
      error: "Failed to allocate a unique room id."
    },
    500,
    requestUrl
  );
});

app.post("/api/rooms/:roomId/bootstrap", async (context) => {
  const requestUrl = new URL(context.req.url);
  const originResponse = rejectCrossOriginRequest(context.req.raw, requestUrl.origin);
  if (originResponse) {
    return originResponse;
  }

  const limited = await enforceRateLimit(context, "bootstrap-room", BOOTSTRAP_RATE_LIMIT);
  if (limited) {
    return limited;
  }

  const roomId = parseRoomId(context.req.param("roomId"));
  const payload = bootstrapRequestSchema.parse(await readJsonBody(context.req.raw));
  const stub = context.env.ROOMS.get(context.env.ROOMS.idFromName(roomId));

  return withSecurityHeaders(
    await stub.fetch("https://room/bootstrap", {
      method: "POST",
      headers: forwardRequestHeaders(context.req.raw),
      body: JSON.stringify(payload)
    }),
    requestUrl
  );
});

app.get("/api/rooms/:roomId/ws", async (context) => {
  const requestUrl = new URL(context.req.url);
  const originResponse = rejectCrossOriginRequest(context.req.raw, requestUrl.origin);
  if (originResponse) {
    return originResponse;
  }

  const roomId = parseRoomId(context.req.param("roomId"));
  const stub = context.env.ROOMS.get(context.env.ROOMS.idFromName(roomId));
  const targetUrl = new URL("https://room/connect");
  targetUrl.search = requestUrl.search;

  return stub.fetch(new Request(targetUrl.toString(), context.req.raw));
});

app.onError((error, context) => {
  console.error(error);
  const requestUrl = new URL(context.req.url);

  if (error instanceof RequestError) {
    return jsonResponse(
      {
        error: error.message
      },
      error.status,
      requestUrl
    );
  }

  if (error instanceof z.ZodError) {
    return jsonResponse(
      {
        error: "Invalid request."
      },
      400,
      requestUrl
    );
  }

  return jsonResponse(
    {
      error: "Internal error."
    },
    500,
    requestUrl
  );
});

export default app;
export { RoomDurableObject, SecurityGateDurableObject };
