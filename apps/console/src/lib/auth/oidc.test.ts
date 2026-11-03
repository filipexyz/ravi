import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EncryptJWT, exportJWK, generateKeyPair, SignJWT } from "jose";
import { getOidcConfig, oidcProvider } from "./oidc-config";
import { beginOidcLogin, completeOidcLogin, verifiedOidcIdentity } from "./oidc-client";
import { hashBrowserSessionToken, newBrowserSessionToken, openOidcTransaction, sealOidcTransaction } from "./oidc-transaction";
import { parseOidcBootstrap } from "./oidc-bootstrap";
import { getCliAuthPublicConfig, getCliWorkosValidationConfig } from "@/server/cli/config";
import { isAnonymousModeEnabled, isWorkOSConfigured } from "./config";
import { oidcBrowserRequestAllowed, oidcInteractiveNavigationAllowed } from "./oidc-request-policy";

const config = getOidcConfig({ RAVI_OIDC_ISSUER: "https://idp.example.test/realms/test",
  RAVI_OIDC_CLIENT_ID: "console", RAVI_OIDC_CLIENT_SECRET: "synthetic-client-secret",
  RAVI_AUTH_SECRET: "synthetic-test-only-secret-at-least-32-characters", NEXT_PUBLIC_CONSOLE_URL: "https://console.example.test",
  RAVI_SINGLE_TENANT_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001" });
const transaction = { state: "a".repeat(43), nonce: "b".repeat(43), verifier: "c".repeat(43), returnTo: "/projects" };
const originalFetch = globalThis.fetch;
const originalMode = process.env.RAVI_AUTH_MODE;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env.RAVI_AUTH_MODE; else process.env.RAVI_AUTH_MODE = originalMode;
});

describe("OIDC closed installation config and bootstrap", () => {
  test("forbids insecure issuer, missing secret and wrong org ID", () => {
    expect(() => getOidcConfig({})).toThrow("configuration");
    expect(() => getOidcConfig({ RAVI_OIDC_ISSUER: "http://idp.test" })).toThrow("configuration");
    expect(oidcProvider(config.issuer)).toBe(`oidc:${config.issuer}`);
  });
  test("OIDC cannot fall back to anonymous/WorkOS or expose WorkOS CLI exchange", () => {
    process.env.RAVI_AUTH_MODE = "oidc";
    expect(isAnonymousModeEnabled()).toBe(false);
    expect(isWorkOSConfigured()).toBe(false);
    expect(getCliWorkosValidationConfig()).toBeNull();
    expect(getCliAuthPublicConfig(config.origin).mode).toBe("console_device");
    expect(getCliAuthPublicConfig(config.origin).provider).toBe("ravi-console");
  });
  const manifest = { issuer: config.issuer, organization: { id: config.organizationId, slug: "staging", name: "Staging" },
    users: [{ id: "00000000-0000-4000-8000-000000000002", subject: "subject-1", email: "owner@example.test", name: "Owner", role: "owner" }] };
  test("bootstrap requires exact issuer/org and explicit owner, no duplicate identities", () => {
    expect(parseOidcBootstrap(manifest, config).users[0]!.subject).toBe("subject-1");
    expect(() => parseOidcBootstrap({ ...manifest, issuer: "https://other.example.test" }, config)).toThrow();
    expect(() => parseOidcBootstrap({ ...manifest, users: [manifest.users[0], manifest.users[0]] }, config)).toThrow();
    expect(() => parseOidcBootstrap({ ...manifest, users: [{ ...manifest.users[0], role: "viewer" }] }, config)).toThrow();
  });
});

describe("OIDC transactions and browser token", () => {
  test("subresources cannot start or end the interactive session", () => {
    expect(oidcInteractiveNavigationAllowed(new Headers())).toBe(true);
    expect(oidcInteractiveNavigationAllowed(new Headers({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }))).toBe(true);
    for (const destination of ["image", "iframe", "script", "empty"]) {
      expect(oidcInteractiveNavigationAllowed(new Headers({ "sec-fetch-dest": destination, "sec-fetch-mode": "navigate" }))).toBe(false);
    }
  });
  test("browser mutations require exact Console origin including internal approvals", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(oidcBrowserRequestAllowed(method, config.origin, config.origin)).toBe(true);
      for (const origin of [null, "null", "https://page.example.test", `${config.origin}.evil.test`, `${config.origin}:8443`]) {
        expect(oidcBrowserRequestAllowed(method, origin, config.origin)).toBe(false);
      }
    }
    expect(oidcBrowserRequestAllowed("GET", null, config.origin)).toBe(true);
  });
  test("encrypted transaction is origin/client/purpose/key-bound and rejects tampering", async () => {
    const sealed = await sealOidcTransaction(transaction, config);
    expect(sealed.includes(transaction.verifier)).toBe(false);
    expect(await openOidcTransaction(sealed, config)).toEqual(transaction);
    await expect(openOidcTransaction(sealed, { ...config, clientId: "other" })).rejects.toThrow();
    await expect(openOidcTransaction(sealed, { ...config, origin: "https://other.test" })).rejects.toThrow();
    await expect(openOidcTransaction(sealed, { ...config, secret: "another-long-test-only-secret-string" })).rejects.toThrow();
    await expect(openOidcTransaction(sealed.slice(0, -10) + "tampered00", config)).rejects.toThrow();
    await expect(sealOidcTransaction({ ...transaction, returnTo: "//evil.test" }, config)).rejects.toThrow();
  });
  test("expired transaction is refused", async () => {
    const key = createHash("sha256").update(`ravi-oidc-transaction\0${config.secret}`).digest();
    const expired = await new EncryptJWT(transaction).setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "ravi-oidc-transaction" })
      .setIssuer(config.origin).setAudience(`${config.issuer}#${config.clientId}`).setIssuedAt(1).setExpirationTime(2).encrypt(key);
    await expect(openOidcTransaction(expired, config)).rejects.toThrow();
  });
  test("session token is random and only valid opaque tokens can be hashed", () => {
    const first = newBrowserSessionToken(); const second = newBrowserSessionToken();
    expect(first).not.toBe(second);
    expect(hashBrowserSessionToken(first)).toHaveLength(64);
    expect(hashBrowserSessionToken("invalid")).toBeNull();
  });
  test("claims require verified email and exact issuer; provider roles cannot elevate", () => {
    const claims = { iss: config.issuer, sub: "sub", email: "user@example.test", email_verified: true, role: "owner" };
    expect(verifiedOidcIdentity(claims, config.issuer)).not.toHaveProperty("role");
    expect(() => verifiedOidcIdentity({ ...claims, email_verified: false }, config.issuer)).toThrow();
    expect(() => verifiedOidcIdentity({ ...claims, email_verified: "true" }, config.issuer)).toThrow();
    expect(() => verifiedOidcIdentity({ ...claims, iss: "https://evil.test" }, config.issuer)).toThrow();
  });
});

describe("real OIDC library protocol checks with isolated signed fixtures", () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  beforeAll(async () => { keys = await generateKeyPair("RS256"); wrongKeys = await generateKeyPair("RS256"); });
  async function providerFixture(overrides: Record<string, unknown> = {}, wrongSignature = false) {
    let verifierReceived: string | null = null;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    const now = Math.floor(Date.now() / 1000);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json({
        issuer: config.issuer, authorization_endpoint: `${config.issuer}/auth`, token_endpoint: `${config.issuer}/token`,
        jwks_uri: `${config.issuer}/certs`, response_types_supported: ["code"],
        subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      });
      if (url.endsWith("/certs")) return Response.json({ keys: [jwk] });
      if (url.endsWith("/token")) {
        verifierReceived = new URLSearchParams(String(init?.body)).get("code_verifier");
        if (verifierReceived !== transaction.verifier) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const id_token = await new SignJWT({ iss: config.issuer, sub: "known-subject", aud: config.clientId,
          iat: now, exp: now + 300, nonce: transaction.nonce, email: "user@example.test", email_verified: true, ...overrides })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(wrongSignature ? wrongKeys.privateKey : keys.privateKey);
        return Response.json({ token_type: "Bearer", access_token: "fixture-access-token", expires_in: 300, id_token });
      }
      throw new Error("Unexpected fixture request");
    }) as typeof fetch;
    return () => verifierReceived;
  }
  const callback = () => new URL(`${config.origin}/callback?code=fixture-code&state=${transaction.state}`);
  test("valid exchange verifies signature and binds PKCE verifier", async () => {
    const received = await providerFixture();
    const identity = await completeOidcLogin(callback(), transaction, config);
    expect(identity.subject).toBe("known-subject"); expect(received()).toBe(transaction.verifier);
  });
  test("authorization request always includes S256, state, nonce, canonical callback", async () => {
    await providerFixture();
    const login = await beginOidcLogin("/projects", config);
    expect(login.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(login.url.searchParams.get("state")).toBe(login.transaction.state);
    expect(login.url.searchParams.get("nonce")).toBe(login.transaction.nonce);
    expect(login.url.searchParams.get("redirect_uri")).toBe(`${config.origin}/callback`);
  });
  test("rejects wrong state before token exchange", async () => {
    const received = await providerFixture();
    await expect(completeOidcLogin(new URL(`${config.origin}/callback?code=code&state=wrong`), transaction, config)).rejects.toThrow();
    expect(received()).toBeNull();
  });
  test("surfaces provider rejection of the wrong PKCE verifier", async () => {
    await providerFixture();
    await expect(completeOidcLogin(callback(), { ...transaction, verifier: "d".repeat(43) }, config)).rejects.toThrow();
  });
  for (const [name, claims] of Object.entries({ issuer: { iss: "https://evil.test" }, audience: { aud: "another-client" },
    nonce: { nonce: "wrong" }, expired: { exp: 1 }, email: { email_verified: false } })) {
    test(`rejects ${name}`, async () => {
      await providerFixture(claims);
      await expect(completeOidcLogin(callback(), transaction, config)).rejects.toThrow();
    });
  }
  test("rejects wrong signature even from authenticated token endpoint", async () => {
    await providerFixture({}, true);
    await expect(completeOidcLogin(callback(), transaction, config)).rejects.toThrow();
  });
});
