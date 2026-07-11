import { describe, expect, it } from "vitest";
import { bootstrapRequestSchema } from "@shared/protocol";
import { APP_VERSION, PROTOCOL_VERSION } from "@shared/version";

describe("client and server compatibility contract", () => {
  it("accepts the current app and protocol versions", () => {
    expect(
      bootstrapRequestSchema.safeParse({
        appVersion: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        token: "1234567890abcdef"
      }).success
    ).toBe(true);
  });

  it("rejects a stale app or protocol version", () => {
    expect(
      bootstrapRequestSchema.safeParse({
        appVersion: "0.0.0-stale",
        protocolVersion: PROTOCOL_VERSION,
        token: "1234567890abcdef"
      }).success
    ).toBe(false);

    expect(
      bootstrapRequestSchema.safeParse({
        appVersion: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION + 1,
        token: "1234567890abcdef"
      }).success
    ).toBe(false);
  });
});
