import { isPermissionCatalog, acceptCatalogDelegation } from "./console-catalog-authority.js";
import { createHash } from "node:crypto";
import { decodeJwt, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { BridgeError } from "../../bridge/protocol.js";
import type { runtimeIdentity } from "../../bridge/auth.js";
import type { BridgeService } from "../../bridge/service.js";
import { CONSOLE_PROTOCOL, consoleGrantSchema, consoleRequestMaterial, type ConsoleGrant } from "./console-contract.js";
import type { ConsoleInvocation } from "./console-context.js";

export function consoleRequestDigest(
  method: string,
  target: string,
  body: string,
  operationId: string,
  createdAt: number,
) {
  return createHash("sha256")
    .update(consoleRequestMaterial(method, target, body, operationId, createdAt))
    .digest("hex");
}
export async function consoleRuntimeProof(
  identity: ReturnType<typeof runtimeIdentity>,
  connectionId: string,
  registryDigest: string,
) {
  const proof = await new SignJWT({ protocol: CONSOLE_PROTOCOL, connectionId, registryDigest })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(identity.runtimeId)
    .setAudience(CONSOLE_PROTOCOL)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(await importPKCS8(identity.privateKey, "EdDSA"));
  return { protocol: CONSOLE_PROTOCOL, runtimeId: identity.runtimeId, connectionId, proof };
}
export async function verifyConsoleRequest(
  service: BridgeService,
  request: Request,
  body: string,
  connectionId: string,
): Promise<ConsoleInvocation> {
  try {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token || token.startsWith("rctx_")) throw new Error();
    const decoded = decodeJwt(token);
    if (typeof decoded.enrollmentId !== "string") throw new Error();
    const enrollment = service.store.enrollment(decoded.enrollmentId);
    if (!enrollment?.active || enrollment.runtimeId !== service.runtimeId) throw new Error();
    const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(enrollment.issuerPublicKey, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: enrollment.issuer,
      audience: `ravi:${service.runtimeId}:gateway:v1`,
      maxTokenAge: "30s",
      clockTolerance: 0,
    });
    const grant = consoleGrantSchema.parse(
      Object.fromEntries(Object.keys(consoleGrantSchema.shape).map((key) => [key, payload[key]])),
    );
    const url = new URL(request.url);
    if (
      protectedHeader.kid !== enrollment.issuerKeyId ||
      !z.string().uuid().safeParse(payload.sub).success ||
      !z.string().uuid().safeParse(payload.jti).success ||
      !payload.exp ||
      !payload.iat ||
      payload.iat > Math.floor(Date.now() / 1000) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 30 ||
      grant.orgId !== enrollment.orgId ||
      grant.installationId !== enrollment.installationId ||
      grant.epoch !== enrollment.epoch ||
      grant.connectionId !== connectionId ||
      grant.requestDigest !==
        consoleRequestDigest(request.method, url.pathname + url.search, body, grant.operationId, grant.createdAt)
    )
      throw new Error();
    const verified: ConsoleGrant = {
      ...grant,
      sub: payload.sub!,
      iss: payload.iss!,
      jti: payload.jti!,
      exp: payload.exp,
    };
    service.store.atomic(() => {
      const live = service.store.enrollment(enrollment.id);
      if (!live?.active || live.epoch !== verified.epoch) throw new BridgeError("ACCESS_REVOKED");
      service.store.db.query("DELETE FROM replays WHERE expires_at < ?").run(Date.now());
      try {
        service.store.db
          .query("INSERT INTO replays VALUES (?,?)")
          .run(`${enrollment.id}:${verified.jti}`, verified.exp * 1000);
      } catch {
        throw new BridgeError("ASSERTION_REPLAY");
      }
    });
    // A newer decision must survive a denied command and any later rollback.
    if (isPermissionCatalog(verified)) acceptCatalogDelegation(service, verified);
    else service.acceptDelegation(verified);
    return { grant: verified, enrollment, service };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("INVALID_DELEGATION");
  }
}
