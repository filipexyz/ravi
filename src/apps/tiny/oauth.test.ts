import { describe, expect, test } from "bun:test";
import {
  ensureTinyOAuthAccess,
  parseTinyOAuthBundle,
  TINY_OAUTH_TOKEN_URL,
  type TinyOAuthBundle,
  type TinyOAuthFetch,
} from "./oauth.js";

const now = Date.UTC(2026, 6, 14, 12, 0, 0);

describe("Tiny OAuth v3 lifecycle", () => {
  test("fails closed on malformed or under-scoped broker bundles", () => {
    expect(() => parseTinyOAuthBundle("not-json")).toThrow("Bundle OAuth Tiny invalido");
    expect(() => parseTinyOAuthBundle(JSON.stringify({ ...bundle(), scopes: ["profile"] }))).toThrow("scope openid");
  });

  test("reuses a valid access token without network or persistence", async () => {
    let networkCalled = false;
    let persisted = false;
    const result = await ensureTinyOAuthAccess(bundle({ accessTokenExpiresAt: now + 60 * 60 * 1000 }), {
      now,
      fetchImpl: (async () => {
        networkCalled = true;
        return Response.json({});
      }) as TinyOAuthFetch,
      persist: async () => {
        persisted = true;
      },
    });
    expect(result.refreshed).toBe(false);
    expect(networkCalled).toBe(false);
    expect(persisted).toBe(false);
  });

  test("refreshes through the pinned endpoint and persists the rotated bundle", async () => {
    let requestUrl = "";
    let requestBody = "";
    let persisted: TinyOAuthBundle | null = null;
    const result = await ensureTinyOAuthAccess(bundle({ accessTokenExpiresAt: now + 60_000 }), {
      now,
      fetchImpl: (async (input, init) => {
        requestUrl = String(input);
        requestBody = String(init?.body);
        return Response.json({
          access_token: "access-token-rotated",
          refresh_token: "refresh-token-rotated",
          expires_in: 14_400,
          refresh_expires_in: 86_400,
          scope: "openid",
        });
      }) as TinyOAuthFetch,
      persist: async (next) => {
        persisted = next;
      },
    });
    expect(requestUrl).toBe(TINY_OAUTH_TOKEN_URL);
    expect(requestBody).toContain("grant_type=refresh_token");
    expect(result).toMatchObject({ accessToken: "access-token-rotated", refreshed: true });
    expect(persisted).toMatchObject({
      accessToken: "access-token-rotated",
      refreshToken: "refresh-token-rotated",
      scopes: ["openid"],
      accessTokenExpiresAt: now + 14_400_000,
      refreshTokenExpiresAt: now + 86_400_000,
    });
  });

  test("does not refresh an expired refresh token and rejects scope escalation", async () => {
    await expect(
      ensureTinyOAuthAccess(bundle({ accessTokenExpiresAt: now - 1, refreshTokenExpiresAt: now - 1 }), {
        now,
        persist: async () => {},
      }),
    ).rejects.toThrow("Refresh token Tiny expirado");

    await expect(
      ensureTinyOAuthAccess(bundle({ accessTokenExpiresAt: now - 1 }), {
        now,
        fetchImpl: (async () =>
          Response.json({
            access_token: "access-token-rotated",
            expires_in: 14_400,
            scope: "openid admin",
          })) as TinyOAuthFetch,
        persist: async () => {},
      }),
    ).rejects.toThrow("ampliar scopes");
  });
});

function bundle(overrides: Partial<TinyOAuthBundle> = {}): TinyOAuthBundle {
  return {
    version: 1,
    tokenType: "Bearer",
    clientId: "client-id-example",
    clientSecret: "client-secret-example",
    redirectUri: "https://app.example.test/oauth/tiny/callback",
    accessToken: "access-token-example",
    refreshToken: "refresh-token-example",
    accessTokenExpiresAt: now + 4 * 60 * 60 * 1000,
    refreshTokenExpiresAt: now + 24 * 60 * 60 * 1000,
    scopes: ["openid"],
    updatedAt: now,
    ...overrides,
  };
}
