import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";

export const EXECUTOR_TTL_SECONDS = 60;
export const EXECUTOR_BODY_LIMIT = 1024 * 1024;
export const pageOperationSchema = z.object({
  host: z.string().min(1).max(253),
  id: z.string().min(1).max(128),
  input: z.unknown(),
  origin: z.string().max(1024).nullable(),
  pagesSession: z.string().min(1).max(8192),
  requestId: z.string().min(1).max(128),
}).strict();
export type PageOperation = z.infer<typeof pageOperationSchema>;
export const delegationScopeSchema = z.object({
  actorId: z.string().uuid(),
  organizationId: z.string().uuid(),
  siteId: z.string().uuid(),
  projectId: z.string().uuid(),
  releaseId: z.string().uuid(),
}).strict();
export type DelegationScope = z.infer<typeof delegationScopeSchema>;

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
export function requiredSetting(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8").trim() : process.env[name]?.trim();
  if (!value) throw new ConsoleApiError(503, { error: "executor_unconfigured" });
  return value;
}
export function pinnedOrigin(name: string): string {
  const value = requiredSetting(name);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.hostname.includes("*")) {
    throw new ConsoleApiError(503, { error: "executor_unconfigured" });
  }
  return url.origin;
}
export function executorOrigins() {
  return { console: pinnedOrigin("NEXT_PUBLIC_CONSOLE_URL"), executor: pinnedOrigin("RAVI_EXECUTOR_URL") };
}

export async function signDelegation(operation: PageOperation, scope: DelegationScope): Promise<string> {
  const origins = executorOrigins();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    kind: "page-operation", actor: "human_viewer", ...scope,
    bodyHash: hash(stableJson(operation)), sessionHash: hash(operation.pagesSession),
  }).setProtectedHeader({ alg: "ES256", typ: "executor-delegation+jwt" })
    .setSubject(scope.actorId).setIssuer(origins.console).setAudience(origins.executor)
    .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + EXECUTOR_TTL_SECONDS)
    .sign(await importPKCS8(requiredSetting("RAVI_EXECUTOR_PRIVATE_KEY_PEM"), "ES256"));
}

export async function verifyExecutorProof(token: string, kind: string) {
  const origins = executorOrigins();
  try {
    const { payload, protectedHeader } = await jwtVerify(token,
      await importSPKI(requiredSetting("RAVI_EXECUTOR_PUBLIC_KEY_PEM"), "ES256"), {
        algorithms: ["ES256"], issuer: origins.executor, audience: origins.console,
        requiredClaims: ["iat", "exp", "jti"], maxTokenAge: "60s",
      });
    if (protectedHeader.typ !== "executor-callback+jwt" || payload.kind !== kind ||
        !Number.isInteger(payload.iat) || payload.exp! - payload.iat! !== EXECUTOR_TTL_SECONDS ||
        payload.iat! > Math.floor(Date.now() / 1000)) throw new Error("invalid proof");
    return payload;
  } catch { throw new ConsoleApiError(401, { error: "executor_unauthorized" }); }
}

export async function verifyDelegation(token: string, operation: PageOperation) {
  const origins = executorOrigins();
  try {
    // Derive only the public key from the local signing key; jose verifies the
    // token rather than accepting its unverified claims from the callback.
    const { createPublicKey } = await import("node:crypto");
    const pem = createPublicKey(requiredSetting("RAVI_EXECUTOR_PRIVATE_KEY_PEM")).export({ type: "spki", format: "pem" }).toString();
    const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(pem, "ES256"), {
      algorithms: ["ES256"], issuer: origins.console, audience: origins.executor,
      requiredClaims: ["sub", "iat", "exp", "jti"], maxTokenAge: "60s",
    });
    const scope = delegationScopeSchema.parse({ actorId: payload.actorId, organizationId: payload.organizationId,
      siteId: payload.siteId, projectId: payload.projectId, releaseId: payload.releaseId });
    if (protectedHeader.typ !== "executor-delegation+jwt" || payload.kind !== "page-operation" ||
        payload.actor !== "human_viewer" || payload.sub !== scope.actorId ||
        payload.bodyHash !== hash(stableJson(operation)) || payload.sessionHash !== hash(operation.pagesSession) ||
        !Number.isInteger(payload.iat) || payload.exp! - payload.iat! !== EXECUTOR_TTL_SECONDS ||
        payload.iat! > Math.floor(Date.now() / 1000)) throw new Error("invalid delegation");
    return scope;
  } catch { throw new ConsoleApiError(401, { error: "executor_unauthorized" }); }
}

export async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ConsoleApiError(400, { error: "payload_invalid" });
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > EXECUTOR_BODY_LIMIT) { await reader.cancel(); throw new ConsoleApiError(413, { error: "payload_too_large" }); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ConsoleApiError(400, { error: "payload_invalid" }); }
}
