import { describe, expect, test } from "bun:test";

import {
  authorizeRuntimeControlRequest,
  generateRuntimeLeaseToken,
  getRuntimeControlToken,
  hashRuntimeToken,
} from "./managed-runtime";

describe("managed runtime control auth", () => {
  test("requires a sufficiently long runtime control token", () => {
    expect(getRuntimeControlToken({ RAVI_RUNTIME_CONTROL_TOKEN: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      getRuntimeControlToken({
        RAVI_RUNTIME_CONTROL_TOKEN: "runtime-control-token-with-enough-length",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("runtime-control-token-with-enough-length");
  });

  test("authorizes only bearer tokens that exactly match", () => {
    const token = "runtime-control-token-with-enough-length";

    expect(
      authorizeRuntimeControlRequest(
        new Request("https://console.test/api/internal/runtime/hosts/register", {
          headers: { authorization: `Bearer ${token}` },
        }),
        token,
      ),
    ).toBe(true);

    expect(
      authorizeRuntimeControlRequest(
        new Request("https://console.test/api/internal/runtime/hosts/register", {
          headers: { authorization: "Bearer wrong-token-with-enough-length" },
        }),
        token,
      ),
    ).toBe(false);
  });
});

describe("managed runtime lease tokens", () => {
  test("generates scoped opaque lease tokens and hashes them for storage", () => {
    const token = generateRuntimeLeaseToken();
    const hash = hashRuntimeToken(token);

    expect(token).toStartWith("ravi_rlt_");
    expect(hash).toStartWith("sha256:");
    expect(hash).not.toContain(token);
    expect(hashRuntimeToken(token)).toBe(hash);
  });
});
