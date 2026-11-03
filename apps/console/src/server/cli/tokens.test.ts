import { describe, expect, test } from "bun:test";

import {
  generateCliCredentials,
  generateRefreshToken,
  getCliAccessTokenSecret,
  hashToken,
  signCliAccessToken,
  verifyCliAccessToken,
  verifyTokenHash,
} from "./tokens";

const secret = "test-cli-access-token-secret-32-bytes-minimum";

describe("CLI token utilities", () => {
  test("hashes refresh tokens without retaining raw material", () => {
    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);

    expect(refreshToken.startsWith("ravi_crt_")).toBe(true);
    expect(refreshTokenHash.startsWith("sha256:")).toBe(true);
    expect(refreshTokenHash).not.toContain(refreshToken);
    expect(verifyTokenHash(refreshToken, refreshTokenHash)).toBe(true);
    expect(verifyTokenHash(`${refreshToken}x`, refreshTokenHash)).toBe(false);
  });

  test("signs and verifies short-lived Ravi CLI access tokens", async () => {
    const signed = await signCliAccessToken({
      secret,
      sessionId: "session-1",
      localInstallationId: "installation-1",
      organizationId: "organization-1",
      userId: "user-1",
      scopes: ["console.me.read"],
    });

    const claims = await verifyCliAccessToken(signed.accessToken, secret);

    expect(claims.sessionId).toBe("session-1");
    expect(claims.localInstallationId).toBe("installation-1");
    expect(claims.organizationId).toBe("organization-1");
    expect(claims.userId).toBe("user-1");
    expect(claims.jti).toBe(signed.accessTokenJti);
    expect(claims.scopes).toEqual(["console.me.read"]);
  });

  test("generates fresh refresh material and access jtis on rotation", async () => {
    const base = {
      secret,
      sessionId: "session-1",
      localInstallationId: "installation-1",
      organizationId: "organization-1",
      userId: "user-1",
      scopes: ["console.me.read"],
    };

    const first = await generateCliCredentials(base);
    const second = await generateCliCredentials(base);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.refreshTokenHash).not.toBe(first.refreshTokenHash);
    expect(second.accessTokenJti).not.toBe(first.accessTokenJti);
    expect(second.refreshTokenHash).not.toContain(second.refreshToken);
  });

  test("signs installation credentials without a person subject", async () => {
    const signed = await signCliAccessToken({
      secret,
      sessionId: "session-installation",
      localInstallationId: "installation-1",
      organizationId: "organization-1",
      userId: null,
      subjectType: "installation",
      scopes: ["console.installations.read", "console.installations.write"],
    });

    const claims = await verifyCliAccessToken(signed.accessToken, secret);

    expect(claims.subjectType).toBe("installation");
    expect(claims.userId).toBeNull();
    expect(claims.localInstallationId).toBe("installation-1");
  });

  test("keeps person credentials on subject_type user", async () => {
    const signed = await signCliAccessToken({
      secret,
      sessionId: "session-1",
      localInstallationId: "installation-1",
      organizationId: "organization-1",
      userId: "user-1",
      scopes: ["console.me.read"],
    });

    const claims = await verifyCliAccessToken(signed.accessToken, secret);

    expect(claims.subjectType).toBe("user");
    expect(claims.userId).toBe("user-1");
  });

  test("rejects documented placeholder secrets", () => {
    const previous = process.env.RAVI_CLI_ACCESS_TOKEN_SECRET;
    process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = "replace-with-at-least-32-characters";
    try {
      expect(getCliAccessTokenSecret()).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.RAVI_CLI_ACCESS_TOKEN_SECRET;
      } else {
        process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = previous;
      }
    }
  });
});
