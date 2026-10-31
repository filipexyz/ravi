import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
  BRIDGE_PROTOCOL,
  BridgeError,
  bridgeGrantSchema,
  canonicalBridgeJson,
  type BridgeGrant,
  type BridgeRequest,
} from "./protocol.js";
import { type BridgeStore, type Enrollment } from "./store.js";

export const enrollmentSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    installationId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    issuer: z.string().min(1).max(200),
    issuerPublicKey: z.string().max(2000),
    issuerKeyId: z.string().min(1).max(100),
    epoch: z.number().int().positive(),
    active: z.boolean(),
  })
  .strict();
export function requestDigest(request: unknown) {
  return createHash("sha256").update(canonicalBridgeJson(request)).digest("hex");
}
export function runtimeIdentity(dir: string) {
  const path = join(dir, "identity.json");
  if (existsSync(path))
    return JSON.parse(readFileSync(path, "utf8")) as { runtimeId: string; publicKey: string; privateKey: string };
  const pair = generateKeyPairSync("ed25519");
  const identity = {
    runtimeId: randomUUID(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  writeFileSync(path, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
  return identity;
}
export async function signedHello(identity: ReturnType<typeof runtimeIdentity>, connectionId: string) {
  const proof = await new SignJWT({ protocol: BRIDGE_PROTOCOL, connectionId })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(identity.runtimeId)
    .setAudience("fleet-human-bridge")
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(await importPKCS8(identity.privateKey, "EdDSA"));
  return { type: "hello", protocol: BRIDGE_PROTOCOL, runtimeId: identity.runtimeId, connectionId, proof };
}
export async function verifyBridgeGrant(
  store: BridgeStore,
  request: BridgeRequest,
  token: string,
  connectionId: string,
  runtimeId: string,
): Promise<{ grant: BridgeGrant; enrollment: Enrollment }> {
  try {
    const decoded = decodeJwt(token);
    if (typeof decoded.enrollmentId !== "string") throw new Error();
    const enrollment = store.enrollment(decoded.enrollmentId);
    if (!enrollment || !enrollment.active || enrollment.runtimeId !== runtimeId) throw new Error();
    const result = await jwtVerify(token, await importSPKI(enrollment.issuerPublicKey, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: enrollment.issuer,
      audience: `ravi:${runtimeId}:bridge:v2`,
      maxTokenAge: "30s",
      clockTolerance: 0,
    });
    const payload = result.payload;
    const parsed = bridgeGrantSchema.parse(
      Object.fromEntries(Object.keys(bridgeGrantSchema.shape).map((key) => [key, payload[key]])),
    );
    if (
      result.protectedHeader.kid !== enrollment.issuerKeyId ||
      !payload.sub ||
      !payload.jti ||
      !payload.exp ||
      !payload.iat ||
      payload.exp - payload.iat > 30 ||
      !z.string().uuid().safeParse(payload.sub).success ||
      parsed.orgId !== enrollment.orgId ||
      parsed.installationId !== enrollment.installationId ||
      parsed.epoch !== enrollment.epoch ||
      parsed.connectionId !== connectionId ||
      parsed.projectId !== request.projectId ||
      parsed.requestDigest !== requestDigest(request)
    )
      throw new Error();
    store.atomic(() => {
      store.db.query("DELETE FROM replays WHERE expires_at < ?").run(Date.now());
      try {
        store.db.query("INSERT INTO replays VALUES (?,?)").run(`${enrollment.id}:${payload.jti}`, payload.exp! * 1000);
      } catch {
        throw new BridgeError("ASSERTION_REPLAY");
      }
    });
    return {
      enrollment,
      grant: { ...parsed, sub: payload.sub, iss: payload.iss!, jti: payload.jti, exp: payload.exp },
    };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("INVALID_DELEGATION");
  }
}
