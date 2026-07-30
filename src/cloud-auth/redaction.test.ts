import { describe, expect, it } from "bun:test";
import { redactCloudAuthPayload } from "./redaction.js";

describe("cloud auth redaction", () => {
  it("redacts token material without hiding safe identity and expiry metadata", () => {
    const payload = {
      session: {
        consoleUrl: "https://console.example",
        installation: { id: "ins_123" },
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
        refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
      },
      auth: {
        authorizationUrl: "https://console.example/login?code=ABC",
        verificationUri: "https://console.example/device",
        clientSecret: "client-secret",
      },
    };

    const redacted = redactCloudAuthPayload(payload);
    const encoded = JSON.stringify(redacted);

    expect(encoded).not.toContain("access-secret");
    expect(encoded).not.toContain("refresh-secret");
    expect(encoded).not.toContain("client-secret");
    expect(redacted.session.accessToken).toBe("[REDACTED]");
    expect(redacted.session.refreshToken).toBe("[REDACTED]");
    expect(redacted.session.accessTokenExpiresAt).toBe("2026-05-10T00:00:00.000Z");
    expect(redacted.session.refreshTokenExpiresAt).toBe("2026-06-10T00:00:00.000Z");
    expect(redacted.session.installation.id).toBe("ins_123");
    expect(redacted.auth.authorizationUrl).toBe("https://console.example/login?code=ABC");
  });
});
