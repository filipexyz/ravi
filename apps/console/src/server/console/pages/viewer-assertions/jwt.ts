import { SignJWT, type JWK } from "jose";
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";

export const VIEWER_ASSERTION_TTL_SECONDS = 60;
export const VIEWER_ASSERTION_DEFAULT_ISSUER = "https://console.ravi.bot";
export const VIEWER_ASSERTION_JWKS_PATH = "/api/public/pages/viewer-assertions/jwks";
export const VIEWER_ASSERTION_ACTOR = "human_viewer";

const KID_PATTERN = /^pages-viewer-assertion-[a-z0-9][a-z0-9-]{0,62}$/;
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"] as const;

type AssertionKeyStatus = "active" | "retired";

type LoadedAssertionKey = {
  kid: string;
  privateKey: KeyObject | null;
  publicJwk: JWK;
  status: AssertionKeyStatus;
};

type KeyCacheEntry = {
  active: LoadedAssertionKey;
  published: LoadedAssertionKey[];
};

const keyCache = new Map<string, KeyCacheEntry>();

export type ViewerAssertionSignInput = {
  audience: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  projectId: string;
  raviOrgId: string;
  raviUserId: string;
  siteId: string;
};

export async function signViewerAssertion(input: ViewerAssertionSignInput) {
  const env = input.env ?? process.env;
  const loaded = await loadAssertionKeys(env);
  const now = input.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + VIEWER_ASSERTION_TTL_SECONDS;
  const jti = randomUUID();
  const issuer = viewerAssertionIssuer(env);
  const raviUserId = input.raviUserId;

  const token = await new SignJWT({
    actor: VIEWER_ASSERTION_ACTOR,
    project: input.projectId,
    raviOrgId: input.raviOrgId,
    raviUserId,
    site: input.siteId,
  })
    .setProtectedHeader({ alg: "ES256", kid: loaded.active.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(input.audience)
    .setSubject(raviUserId)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(loaded.active.privateKey!);

  return {
    expiresAt: exp,
    jti,
    kid: loaded.active.kid,
    token,
  };
}

export async function viewerAssertionJwks(env: NodeJS.ProcessEnv = process.env) {
  const loaded = await loadAssertionKeys(env);
  return {
    keys: loaded.published.map((entry) => entry.publicJwk),
  };
}

export function viewerAssertionIssuer(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.RAVI_PAGES_VIEWER_ASSERTION_ISSUER?.trim() || VIEWER_ASSERTION_DEFAULT_ISSUER;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unavailable();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw unavailable();
  }
  if (url.pathname !== "/" && url.pathname !== "") throw unavailable();
  return url.origin;
}

export function resetViewerAssertionKeyCache() {
  keyCache.clear();
}

async function loadAssertionKeys(env: NodeJS.ProcessEnv): Promise<KeyCacheEntry> {
  const raw = env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON?.trim();
  if (!raw) throw unavailable();
  const cached = keyCache.get(raw);
  if (cached) return cached;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unavailable();
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) throw unavailable();

  const loaded: LoadedAssertionKey[] = [];
  for (const entry of parsed) {
    loaded.push(await loadAssertionKey(entry));
  }

  const active = loaded.filter((entry) => entry.status === "active");
  if (active.length !== 1 || !active[0]?.privateKey) throw unavailable();

  const value = { active: active[0], published: loaded };
  keyCache.set(raw, value);
  return value;
}

async function loadAssertionKey(value: unknown): Promise<LoadedAssertionKey> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const record = value as Record<string, unknown>;
  const kid = typeof record.kid === "string" ? record.kid.trim() : "";
  const alg = typeof record.alg === "string" ? record.alg : "ES256";
  const status = record.status === "retired" ? "retired" : record.status === "active" ? "active" : null;
  const pkcs8Pem = typeof record.pkcs8Pem === "string" ? record.pkcs8Pem : "";
  const spkiPem = typeof record.spkiPem === "string" ? record.spkiPem : "";

  if (!KID_PATTERN.test(kid) || alg !== "ES256" || !status) throw unavailable();
  if (status === "active" && !pkcs8Pem) throw unavailable();
  if (!pkcs8Pem && !spkiPem) throw unavailable();

  try {
    const privateKey = pkcs8Pem ? assertionKeyFromPem(pkcs8Pem, "private") : null;
    const publicSource = privateKey ?? assertionKeyFromPem(spkiPem, "public");
    return {
      kid,
      privateKey,
      publicJwk: publicJwk(publicSource, kid),
      status,
    };
  } catch (error) {
    if (error instanceof ConsoleApiError) throw error;
    throw unavailable();
  }
}

function assertionKeyFromPem(pem: string, kind: "private" | "public") {
  const key = kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw unavailable();
  }
  return key;
}

function publicJwk(key: KeyObject, kid: string): JWK {
  const exported = createPublicKey(key).export({ format: "jwk" }) as JWK;
  const published: JWK = { ...exported, alg: "ES256", kid, use: "sig" };
  for (const member of PRIVATE_JWK_MEMBERS) delete published[member];
  if (published.kty !== "EC" || published.crv !== "P-256") throw unavailable();
  return published;
}

function unavailable() {
  return new ConsoleApiError(503, { error: "viewer_assertion_unavailable" });
}
