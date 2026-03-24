import { DurableObject as DurableObjectBase } from "cloudflare:workers";
import { z } from "zod";

interface SecurityGateDocument {
  count: number;
  resetAt: number;
}

type SecurityGateEnv = Record<string, unknown>;

const SECURITY_GATE_STORAGE_KEY = "security-gate";

const securityCheckRequestSchema = z.object({
  limit: z.number().int().positive().max(1_000),
  windowMs: z.number().int().positive().max(60 * 60 * 1000)
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export class SecurityGateDurableObject extends DurableObjectBase<SecurityGateEnv> {
  constructor(private readonly state: DurableObjectState, env: SecurityGateEnv) {
    super(state, env);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    const payload = securityCheckRequestSchema.parse(await request.json());
    const now = Date.now();
    const current = await this.state.storage.get<SecurityGateDocument>(SECURITY_GATE_STORAGE_KEY);
    const bucket =
      current && now < current.resetAt
        ? current
        : {
            count: 0,
            resetAt: now + payload.windowMs
          };

    bucket.count += 1;
    await this.state.storage.put(SECURITY_GATE_STORAGE_KEY, bucket);
    await this.state.storage.setAlarm(bucket.resetAt);

    if (bucket.count > payload.limit) {
      return jsonResponse(
        {
          allowed: false,
          resetAt: bucket.resetAt
        },
        429
      );
    }

    return jsonResponse({
      allowed: true,
      remaining: Math.max(payload.limit - bucket.count, 0),
      resetAt: bucket.resetAt
    });
  }

  override async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
