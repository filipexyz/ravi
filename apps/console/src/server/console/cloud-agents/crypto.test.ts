import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { cloudAgentsConfigured, cloudSecretCodec, cloudSecretCodecFromKey } from "./crypto";
import { isCloudAgentsError } from "./errors";

const ORG = "11111111-1111-4111-8111-111111111111";
const envOf = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const scope = { organizationId: ORG, purpose: "credential" as const, recordId: "22222222-2222-4222-8222-222222222222" };

describe("cloud agents crypto", () => {
  test("round-trips, with a fresh nonce each time", () => {
    const codec = cloudSecretCodecFromKey(randomBytes(32));
    const first = codec.encrypt("value with ünïcode", scope);
    const second = codec.encrypt("value with ünïcode", scope);
    expect(first).toMatch(/^rca1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(codec.decrypt(first, scope)).toBe("value with ünïcode");
    expect(first).not.toContain("value");
  });

  test("a ciphertext moved to another organization, purpose or record does not decrypt", () => {
    const codec = cloudSecretCodecFromKey(randomBytes(32));
    const sealed = codec.encrypt("secret", scope);
    for (const other of [
      { ...scope, organizationId: "33333333-3333-4333-8333-333333333333" },
      { ...scope, purpose: "prompt" as const },
      { ...scope, recordId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      expect(() => codec.decrypt(sealed, other)).toThrow();
    }
    expect(() => cloudSecretCodecFromKey(randomBytes(32)).decrypt(sealed, scope)).toThrow();
    const [prefix, nonce, tag, body] = sealed.split(".");
    const flipped = `${prefix}.${nonce}.${tag}.${body!.slice(0, -2)}${body!.endsWith("AA") ? "AB" : "AA"}`;
    expect(() => codec.decrypt(flipped, scope)).toThrow();
    expect(() => codec.decrypt("plain", scope)).toThrow();
  });

  test("reads a 32-byte key in base64 or base64url and is unconfigured otherwise", () => {
    const key = randomBytes(32);
    const base64 = envOf({ RAVI_CLOUD_AGENTS_KEY: key.toString("base64") });
    const base64url = envOf({ RAVI_CLOUD_AGENTS_KEY: key.toString("base64url") });
    expect(cloudAgentsConfigured(base64)).toBe(true);
    expect(cloudAgentsConfigured(base64url)).toBe(true);
    const sealed = cloudSecretCodec(base64).encrypt("x", scope);
    expect(cloudSecretCodec(base64url).decrypt(sealed, scope)).toBe("x");

    expect(cloudAgentsConfigured(envOf({}))).toBe(false);
    expect(cloudAgentsConfigured(envOf({ RAVI_CLOUD_AGENTS_KEY: randomBytes(16).toString("base64") }))).toBe(false);
    let error: unknown;
    try {
      cloudSecretCodec(envOf({}));
    } catch (caught) {
      error = caught;
    }
    expect(isCloudAgentsError(error, "cloud_agents_unconfigured")).toBe(true);
    expect((error as { status: number }).status).toBe(503);
  });
});
