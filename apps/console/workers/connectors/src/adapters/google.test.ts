import { describe, expect, test } from "bun:test";

import { AdapterProviderError } from "./adapter";
import { createGoogleAdapter, type GoogleCapabilityHandler } from "./google";

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

const baseConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
};

describe("Google adapter", () => {
  test("builds authorization URL with PKCE and offline access", () => {
    const adapter = createGoogleAdapter({
      config: baseConfig,
      capabilities: new Map(),
    });
    const url = adapter.buildAuthorizationUrl({
      state: "state-abc",
      pkceChallenge: "challenge-xyz",
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
      redirectUri: "https://link.ravi.so/oauth/google/callback",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.send");
  });

  test("uses least-privilege default scopes for implemented read actions", () => {
    const adapter = createGoogleAdapter({
      config: baseConfig,
      capabilities: new Map(),
    });
    expect(adapter.defaultScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(adapter.defaultScopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(adapter.defaultScopes).not.toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(adapter.defaultScopes).not.toContain("https://www.googleapis.com/auth/calendar");
  });

  test("exchangeAuthorizationCode parses Google token response", async () => {
    const adapter = createGoogleAdapter({
      config: {
        ...baseConfig,
        fetchImpl: fakeFetch(async (url, init) => {
          expect(url).toBe("https://oauth2.googleapis.com/token");
          const body = new URLSearchParams(init!.body as string);
          expect(body.get("code")).toBe("auth-code-1");
          expect(body.get("code_verifier")).toBe("verifier-1");
          expect(body.get("grant_type")).toBe("authorization_code");
          return new Response(
            JSON.stringify({
              access_token: "ya29.access",
              refresh_token: "1//refresh",
              expires_in: 3599,
              scope: "openid email profile https://www.googleapis.com/auth/gmail.send",
              token_type: "Bearer",
              id_token: "id.token.jwt",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }),
      },
      capabilities: new Map(),
    });

    const tokens = await adapter.exchangeAuthorizationCode({
      code: "auth-code-1",
      pkceVerifier: "verifier-1",
      redirectUri: "https://link.ravi.so/oauth/google/callback",
    });

    expect(tokens.accessToken).toBe("ya29.access");
    expect(tokens.refreshToken).toBe("1//refresh");
    expect(tokens.idToken).toBe("id.token.jwt");
    expect(tokens.expiresInSeconds).toBe(3599);
    expect(tokens.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
    // Short names come back as the URLs the connect requested.
    expect(tokens.scopes).toContain("https://www.googleapis.com/auth/userinfo.email");
    expect(tokens.scopes).toContain("https://www.googleapis.com/auth/userinfo.profile");
    expect(tokens.scopes).not.toContain("email");
  });

  test("always declares the identity scopes and the write scopes", () => {
    const adapter = createGoogleAdapter({ config: baseConfig, capabilities: new Map() });
    expect(adapter.identityScopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ]);
    expect(adapter.defaultScopes).toContain("openid");
    expect(adapter.writeScopes).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(adapter.writeScopes).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  test("passes the login hint for a reconnect", () => {
    const adapter = createGoogleAdapter({ config: baseConfig, capabilities: new Map() });
    const url = new URL(
      adapter.buildAuthorizationUrl({
        state: "s",
        scopes: ["openid"],
        redirectUri: "https://link.ravi.so/oauth/google/callback",
        loginHint: "ana@example.com",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("ana@example.com");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  test("a read-only request does not inherit scopes granted earlier", () => {
    const adapter = createGoogleAdapter({ config: baseConfig, capabilities: new Map() });
    const url = new URL(
      adapter.buildAuthorizationUrl({
        state: "s",
        scopes: ["openid"],
        redirectUri: "https://link.ravi.so/oauth/google/callback",
        includeGrantedScopes: false,
      }),
    );
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  test("exchange reads the account sub and email from the id_token", async () => {
    const payload = btoa(JSON.stringify({ sub: "109876", email: "Ana@Example.com" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const adapter = createGoogleAdapter({
      config: {
        ...baseConfig,
        fetchImpl: fakeFetch(async () =>
          new Response(
            JSON.stringify({
              access_token: "ya29.access",
              expires_in: 3599,
              scope: "openid https://www.googleapis.com/auth/userinfo.email",
              id_token: `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`,
            }),
            { status: 200 },
          ),
        ),
      },
      capabilities: new Map(),
    });
    const tokens = await adapter.exchangeAuthorizationCode({
      code: "c",
      redirectUri: "https://link.ravi.so/oauth/google/callback",
    });
    expect(tokens.externalAccountId).toBe("109876");
    expect(tokens.externalAccountLogin).toBe("ana@example.com");
  });

  test("refresh failure carries the provider error code", async () => {
    const adapter = createGoogleAdapter({
      config: {
        ...baseConfig,
        fetchImpl: fakeFetch(async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
        ),
      },
      capabilities: new Map(),
    });
    const error = await adapter.refresh({ refreshToken: "1//old" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdapterProviderError);
    expect((error as AdapterProviderError).providerCode).toBe("invalid_grant");
  });

  test("exchange throws AdapterProviderError on non-200", async () => {
    const adapter = createGoogleAdapter({
      config: {
        ...baseConfig,
        fetchImpl: fakeFetch(async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
        ),
      },
      capabilities: new Map(),
    });
    await expect(
      adapter.exchangeAuthorizationCode({
        code: "bad",
        redirectUri: "https://link.ravi.so/oauth/google/callback",
      }),
    ).rejects.toBeInstanceOf(AdapterProviderError);
  });

  test("refresh sends refresh_token grant", async () => {
    let captured: URLSearchParams | null = null;
    const adapter = createGoogleAdapter({
      config: {
        ...baseConfig,
        fetchImpl: fakeFetch(async (_url, init) => {
          captured = new URLSearchParams(init!.body as string);
          return new Response(
            JSON.stringify({ access_token: "new-access", expires_in: 3600, scope: "openid" }),
            { status: 200 },
          );
        }),
      },
      capabilities: new Map(),
    });
    const bundle = await adapter.refresh({ refreshToken: "1//refresh" });
    expect(bundle.accessToken).toBe("new-access");
    expect(captured!.get("grant_type")).toBe("refresh_token");
    expect(captured!.get("refresh_token")).toBe("1//refresh");
  });

  test("revoke prefers refresh token and treats 400 as success", async () => {
    let revokedToken: string | null = null;
    const adapter = createGoogleAdapter({
      config: {
        ...baseConfig,
        fetchImpl: fakeFetch(async (_url, init) => {
          revokedToken = new URLSearchParams(init!.body as string).get("token");
          return new Response("{}", { status: 400 });
        }),
      },
      capabilities: new Map(),
    });
    await adapter.revoke({ accessToken: "ya29.x", refreshToken: "1//refresh" });
    expect(revokedToken as string | null).toBe("1//refresh");
  });

  test("executeCapability dispatches to registered handler", async () => {
    let invokedWith: { parameters: unknown; accessToken: string } | null = null;
    const handler: GoogleCapabilityHandler = {
      async execute(input) {
        invokedWith = { parameters: input.parameters, accessToken: input.accessToken };
        return { messageId: "msg-1" };
      },
    };
    const adapter = createGoogleAdapter({
      config: baseConfig,
      capabilities: new Map([["gmail.message.send", handler]]),
    });
    const result = await adapter.executeCapability({
      capability: "gmail.message.send",
      parameters: { to: ["x@example.com"] },
      accessToken: "ya29.x",
      abortSignal: new AbortController().signal,
    });
    expect(result).toEqual({ messageId: "msg-1" });
    expect(invokedWith!.accessToken).toBe("ya29.x");
  });

  test("executeCapability throws on unknown capability", async () => {
    const adapter = createGoogleAdapter({ config: baseConfig, capabilities: new Map() });
    await expect(
      adapter.executeCapability({
        capability: "gmail.unknown",
        parameters: {},
        accessToken: "ya29.x",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AdapterProviderError);
  });
});
