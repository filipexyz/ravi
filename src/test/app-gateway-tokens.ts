/**
 * Test-only signer for Pages app gateway tokens: local P-256 keys, a fake
 * Console JWKS served through an injected fetch, and helpers that sign target
 * grants and viewer assertions with the exact wire claims.
 */

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { randomUUID } from "node:crypto";

export const TEST_ISSUER = "https://console.ravi.test";
export const TEST_INSTALLATION_ID = "6f1c2b8e-1d2c-4b5a-9e8f-0a1b2c3d4e5f";
export const TEST_ORG_ID = "0e3c1c9a-2f4b-4d6e-8a1b-3c5d7e9f1a2b";
export const TEST_SITE_ID = "11111111-2222-4333-8444-555555555555";
export const TEST_PROJECT_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";
export const TEST_TARGET_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
export const TEST_AUDIENCE = "https://apps.example.ravi.local/slides";
export const TEST_USER_ID = "user_01JABCDEF";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface TestKey {
  kid: string;
  privateKey: SigningKey;
  publicJwk: JWK;
}

export async function createTestKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  return { kid, privateKey, publicJwk };
}

export interface FakeJwks {
  keys: JWK[];
  fetchCount: number;
  fail: boolean;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export function createFakeJwks(keys: TestKey[]): FakeJwks {
  const state: FakeJwks = {
    keys: keys.map((key) => key.publicJwk),
    fetchCount: 0,
    fail: false,
    fetch: async () => {
      state.fetchCount++;
      if (state.fail) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ keys: state.keys }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return state;
}

/**
 * JWT-shaped string with no real signature, built at runtime so no token
 * literal lives in source (secret scanners flag those). Use it as a leak
 * sentinel or for shape-only checks.
 */
export function fakeCompactJws(claims: Record<string, unknown> = { sub: "x" }): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return [encode(JSON.stringify({ alg: "ES256" })), encode(JSON.stringify(claims)), encode("signature")].join(".");
}

export async function signToken(input: {
  key: TestKey;
  claims: Record<string, unknown>;
  typ: string;
  kid?: string;
}): Promise<string> {
  return new SignJWT(input.claims)
    .setProtectedHeader({ alg: "ES256", typ: input.typ, kid: input.kid ?? input.key.kid })
    .sign(input.key.privateKey);
}

export function grantClaims(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    site: TEST_SITE_ID,
    project: TEST_PROJECT_ID,
    raviOrgId: TEST_ORG_ID,
    installation: TEST_INSTALLATION_ID,
    app: "slides",
    operations: ["slides.list", "slides.get"],
    origins: ["https://demo.ravi.page"],
    target: TEST_TARGET_ID,
    jti: randomUUID(),
    iat,
    exp: iat + 21_600,
    ...overrides,
  };
}

export function assertionClaims(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: TEST_USER_ID,
    raviUserId: TEST_USER_ID,
    raviOrgId: TEST_ORG_ID,
    site: TEST_SITE_ID,
    project: TEST_PROJECT_ID,
    actor: "human_viewer",
    jti: randomUUID(),
    iat,
    exp: iat + 60,
    ...overrides,
  };
}
