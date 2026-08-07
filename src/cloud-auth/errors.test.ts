import { describe, expect, it } from "bun:test";
import { CloudAuthError, cloudAuthErrorFromUnknown } from "./errors.js";

describe("cloudAuthErrorFromUnknown", () => {
  it("preserves an already classified cloud error", () => {
    const classified = new CloudAuthError("RATE_LIMITED", "Provider rate limit reached.", { status: 429 });

    expect(cloudAuthErrorFromUnknown(classified)).toBe(classified);
  });

  it("keeps an unknown cause for diagnostics without exposing its message", () => {
    const cause = new Error("https://provider.invalid?token=private-provider-secret");
    const normalized = cloudAuthErrorFromUnknown(cause);

    expect(normalized).toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: "Cloud service request failed.",
      cause,
    });
    expect(JSON.stringify(normalized.toJSON())).not.toContain("private-provider-secret");
  });
});
