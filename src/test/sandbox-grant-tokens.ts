// Test-only token factory for the sandbox listener verifiers. Every key is
// generated at runtime (never a committed secret), so secret scanners stay
// quiet and no fixture can leak. Constants mirror Console's
// `src/shared/sandbox/grant-verify.test.ts` so the two suites stay comparable.

import {
  base64url,
  CompactSign,
  createLocalJWKSet,
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import {
  installationAudience,
  runSubject,
  SANDBOX_GATE_ISSUER,
  SANDBOX_GATE_TYP,
  SANDBOX_GRANT_TYP,
} from "../sandbox-listener/contract.js";
import { sha256Base64url } from "../sandbox-listener/gate-assertion.js";
import type { JwksFetch } from "../sandbox-listener/jwks-cache.js";

export const TEST_CONSOLE_ISSUER = "https://console.ravi.bot";
export const TEST_INSTALLATION_A = "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b";
export const TEST_INSTALLATION_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const TEST_RUN_ID = "sbr_abcdefghijklmnopqrstuvwxyz";
export const TEST_GRANT_JTI = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const TEST_REQUEST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
export const TEST_GRANT_KID = "sandbox-grant-1";
export const TEST_GATE_KID = "sandbox-gate-1";
export const TEST_ACCESS_TEAM_DOMAIN = "acme.cloudflareaccess.com";
export const TEST_ACCESS_AUD = "a".repeat(32) + "b".repeat(32);
export const TEST_ACCESS_CLIENT_ID = "0123456789abcdef0123456789abcdef.access";
export const TEST_NOW = new Date("2026-10-13T12:00:00.000Z");
export const T = Math.floor(TEST_NOW.getTime() / 1000);

export const GRANT_HEADER = { alg: "ES256", kid: TEST_GRANT_KID, typ: SANDBOX_GRANT_TYP };
export const GATE_HEADER = { alg: "ES256", kid: TEST_GATE_KID, typ: SANDBOX_GATE_TYP };

export const encoder = new TextEncoder();
export const b64 = (value: unknown) =>
  base64url.encode(encoder.encode(typeof value === "string" ? value : JSON.stringify(value)));

export type TestSigner = {
  alg: string;
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
  jwks: { keys: JWK[] };
  keySet: JWTVerifyGetKey;
};

export async function createSigner(alg: "ES256" | "ES384" | "RS256", kid: string): Promise<TestSigner> {
  const pair = await generateKeyPair(alg, { extractable: true, ...(alg === "RS256" ? { modulusLength: 2048 } : {}) });
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), alg, kid, use: "sig" };
  const jwks = { keys: [publicJwk] };
  return {
    alg,
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    jwks,
    keySet: createLocalJWKSet(jwks),
  };
}

// `CompactSign` rather than `SignJWT`: it signs any payload (arrays, strings,
// `__proto__`) and any header, which is exactly what an attacker forges.
export function signCompact(
  header: Record<string, unknown>,
  payload: unknown,
  key: CryptoKey | Uint8Array,
  critOptions?: { crit: Record<string, boolean> },
) {
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader(header as { alg: string })
    .sign(key, critOptions);
}

export function grantClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: TEST_CONSOLE_ISSUER,
    aud: installationAudience(TEST_INSTALLATION_A),
    sub: runSubject(TEST_RUN_ID),
    org: "org_123",
    inst: TEST_INSTALLATION_A,
    agent: "ravi",
    task: "task-1",
    caps: ["mutate:task:task-1", "read:task:task-1"],
    cmds: ["tasks.done", "tasks.show"],
    iat: T,
    nbf: T,
    exp: T + 600,
    jti: TEST_GRANT_JTI,
    ...overrides,
  };
}

export const TEST_REQUEST_BODY_TEXT = '{"taskId":"task-1","message":"hi"}';
// `target` is the raw request target; `body` the exact bytes (never a string).
export const TEST_REQUEST = {
  method: "POST",
  target: "/api/v1/tasks/report",
  body: encoder.encode(TEST_REQUEST_BODY_TEXT),
};

export function gateAssertionClaims(grant: string, overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: SANDBOX_GATE_ISSUER,
    aud: installationAudience(TEST_INSTALLATION_A),
    sub: runSubject(TEST_RUN_ID),
    jti: TEST_REQUEST_ID,
    cmd: "tasks.report",
    bodySha256: sha256Base64url(TEST_REQUEST.body),
    grantSha256: sha256Base64url(grant),
    iat: T,
    exp: T + 30,
    ...overrides,
  };
}

export function accessClaims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: `https://${TEST_ACCESS_TEAM_DOMAIN}`,
    aud: [TEST_ACCESS_AUD],
    sub: "",
    email: "",
    type: "app",
    common_name: TEST_ACCESS_CLIENT_ID,
    iat: T,
    exp: T + 300,
    ...overrides,
  };
}

export type FakeJwksOrigin = {
  fetch: JwksFetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  /** Replace the responder: a Response, a thrown error, or a hang (never resolves until aborted). */
  respond: (responder: Responder) => void;
};
export type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

export const jwksResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

export const failingResponder: Responder = () => {
  throw new TypeError("fetch failed");
};

export function fakeJwksOrigin(initial: Responder): FakeJwksOrigin {
  let responder = initial;
  const calls: FakeJwksOrigin["calls"] = [];
  return {
    calls,
    respond: (next) => {
      responder = next;
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  };
}
