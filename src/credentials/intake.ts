import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../router/router-db.js";
import { parseSlackSecretPayload } from "../channels/slack/credentials.js";
import {
  addRaviEnvKey,
  assertRaviEnvKey,
  getRaviEnvKey,
  isRaviEnvSecretKey,
  RaviEnvFileError,
} from "../runtime/ravi-env-file.js";
import { deleteSecret, writeSecret } from "./backends.js";
import { createCredentialConnectionIfAbsent, getCredentialConnection, normalizeCredentialIdentifier } from "./store.js";
import { remoteIntakeSnapshotSchema, storeRemoteIntake, inspectRemoteIntake } from "./remote-intake.js";
import { RemoteCredentialError } from "./remote/ssh.js";

export const INTAKE_TTL_MS = 10 * 60 * 1_000;
export const INTAKE_REQUEST_RESOURCE = "credentials.requests";
export const INTAKE_SECRET_RESOURCE = "credentials.secrets";

export type IntakeErrorCode =
  | "INTAKE_METADATA_INVALID"
  | "INTAKE_TARGET_INVALID"
  | "INTAKE_TARGET_EXISTS"
  | "INTAKE_NOT_AVAILABLE"
  | "INTAKE_BINDING_MISMATCH"
  | "INTAKE_EXPIRED"
  | "INTAKE_ALREADY_USED"
  | "INTAKE_TARGET_BUSY"
  | "INTAKE_SECRET_INVALID"
  | "INTAKE_REMOTE_CONFLICT"
  | "INTAKE_STORE_FAILED"
  | "INTAKE_RECONCILIATION_REQUIRED";

/** Never retain a cause: backend/parser errors may contain the secret. */
export class IntakeError extends Error {
  constructor(readonly code: IntakeErrorCode) {
    super(code);
    this.name = "IntakeError";
  }
}

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:@./-]+$/);
export const intakeMetadataSchema = z
  .object({
    target: z.string().min(1).max(250),
    accountId: identifier,
    teamId: z.string().regex(/^T[A-Z0-9]+$/),
    userId: z.string().regex(/^[UW][A-Z0-9]+$/),
    channelId: z.string().regex(/^[CDG][A-Z0-9]+$/),
    threadTs: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
    issuerContextId: identifier.optional(),
    issuerAgentId: identifier.optional(),
    issuerSessionKey: z.string().min(1).max(512).optional(),
    reason: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(100).optional(),
    remote: remoteIntakeSnapshotSchema.optional(),
    backend: z.enum(["file", "keychain", "vault"]).optional(),
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_:./-]+$/),
      )
      .max(30)
      .optional(),
  })
  .strict();

export type IntakeMetadata = z.infer<typeof intakeMetadataSchema>;
export type IntakeStatus = "open" | "pending" | "stored" | "failed" | "cancelled";
export type IntakeRequest = IntakeMetadata & {
  id: string;
  status: IntakeStatus;
  createdAt: number;
  expiresAt: number;
  viewId?: string;
  actorContactId?: string;
  fingerprint?: string;
  errorCode?: IntakeErrorCode;
};

export interface IntakeBinding {
  accountId: string;
  teamId: string;
  userId: string;
  actorContactId: string;
  viewId?: string;
}

export type IntakeTarget =
  | { kind: "env"; target: string; key: string; scope: "host" }
  | { kind: "remote"; target: string; destinationId: string; key: string; scope: "remote-file" }
  | { kind: "connection"; target: string; provider: string; connection: string; scope: "provider" };

export function normalizeIntakeTarget(value: string): IntakeTarget {
  try {
    const parts = value.split(":");
    if (parts.length === 3 && parts[0] === "remote") {
      const destinationId = normalizeCredentialIdentifier(parts[1]!, "destination");
      const key = parts[2]!;
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) throw new IntakeError("INTAKE_TARGET_INVALID");
      return { kind: "remote", target: `remote:${destinationId}:${key}`, destinationId, key, scope: "remote-file" };
    }
    if (parts.length === 2 && parts[0] === "env") {
      const key = assertRaviEnvKey(parts[1]!);
      if (!isRaviEnvSecretKey(key) || key === "CLAUDE_CODE_OAUTH_TOKEN") throw new IntakeError("INTAKE_TARGET_INVALID");
      return { kind: "env", target: `env:${key}`, key, scope: "host" };
    }
    if (parts.length === 3 && parts[0] === "connection") {
      const provider = normalizeCredentialIdentifier(parts[1]!, "provider");
      const connection = normalizeCredentialIdentifier(parts[2]!, "connection");
      return {
        kind: "connection",
        target: `connection:${provider}:${connection}`,
        provider,
        connection,
        scope: "provider",
      };
    }
  } catch {
    // no-cause: Target validation errors can echo caller input; expose only the fixed intake code.
    throw new IntakeError("INTAKE_TARGET_INVALID");
  }
  throw new IntakeError("INTAKE_TARGET_INVALID");
}

interface IntakeRow {
  id: string;
  metadata_json: string;
  target: string;
  status: IntakeStatus;
  created_at: number;
  expires_at: number;
  view_id: string | null;
  actor_contact_id: string | null;
  fingerprint: string | null;
  error_code: IntakeErrorCode | null;
}

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS credential_intake_requests (
      id TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      target TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','pending','stored','failed','cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      view_id TEXT,
      actor_contact_id TEXT,
      fingerprint TEXT,
      error_code TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS credential_intake_pending_target
      ON credential_intake_requests(target) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS credential_intake_audit (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      actor_contact_id TEXT,
      account_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      target TEXT NOT NULL,
      scope TEXT NOT NULL,
      issuer_context_id TEXT,
      issuer_agent_id TEXT,
      issuer_session_key TEXT,
      outcome TEXT NOT NULL,
      fingerprint TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

function hydrate(row: IntakeRow): IntakeRequest {
  return {
    ...(JSON.parse(row.metadata_json) as IntakeMetadata),
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.view_id ? { viewId: row.view_id } : {}),
    ...(row.actor_contact_id ? { actorContactId: row.actor_contact_id } : {}),
    ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

export function createIntakeRequest(input: IntakeMetadata, options: { now?: number } = {}): IntakeRequest {
  const parsed = intakeMetadataSchema.safeParse(input);
  if (!parsed.success) throw new IntakeError("INTAKE_METADATA_INVALID");
  const target = normalizeIntakeTarget(parsed.data.target);
  if (target.kind !== "connection" && (parsed.data.backend || parsed.data.scopes?.length)) {
    throw new IntakeError("INTAKE_METADATA_INVALID");
  }
  if (target.kind === "connection" && !parsed.data.backend) throw new IntakeError("INTAKE_METADATA_INVALID");
  if ((target.kind === "remote") !== Boolean(parsed.data.remote)) throw new IntakeError("INTAKE_METADATA_INVALID");
  const metadata: IntakeMetadata = { ...parsed.data, target: target.target };
  const now = options.now ?? Date.now();
  const request: IntakeRequest = {
    ...metadata,
    id: randomUUID(),
    status: "open",
    createdAt: now,
    expiresAt: now + INTAKE_TTL_MS,
  };
  ensureTables();
  getDb().transaction(() => {
    getDb()
      .prepare(
        "INSERT INTO credential_intake_requests (id,metadata_json,target,status,created_at,expires_at) VALUES (?,?,?,?,?,?)",
      )
      .run(request.id, JSON.stringify(metadata), target.target, "open", now, request.expiresAt);
    audit(request, "requested", now);
  })();
  return request;
}

export function getIntakeRequest(id: string): IntakeRequest | null {
  ensureTables();
  const row = getDb().prepare("SELECT * FROM credential_intake_requests WHERE id = ?").get(id) as IntakeRow | null;
  return row ? hydrate(row) : null;
}

function assertBinding(request: IntakeRequest, binding: IntakeBinding): void {
  if (
    !binding.actorContactId ||
    request.accountId !== binding.accountId ||
    request.teamId !== binding.teamId ||
    request.userId !== binding.userId ||
    (request.actorContactId && request.actorContactId !== binding.actorContactId)
  ) {
    throw new IntakeError("INTAKE_BINDING_MISMATCH");
  }
}

function assertOpen(
  request: IntakeRequest | null,
  binding: IntakeBinding,
  now: number,
): asserts request is IntakeRequest {
  if (!request) throw new IntakeError("INTAKE_NOT_AVAILABLE");
  assertBinding(request, binding);
  if (request.status !== "open") throw new IntakeError("INTAKE_ALREADY_USED");
  if (request.expiresAt <= now) throw new IntakeError("INTAKE_EXPIRED");
}

export function bindIntakeView(
  id: string,
  binding: IntakeBinding,
  viewId: string,
  options: { now?: number } = {},
): IntakeRequest {
  if (!/^V[A-Z0-9]+$/.test(viewId)) throw new IntakeError("INTAKE_BINDING_MISMATCH");
  const now = options.now ?? Date.now();
  return getDb().transaction(() => {
    const request = getIntakeRequest(id);
    assertOpen(request, binding, now);
    if (request.viewId) throw new IntakeError("INTAKE_ALREADY_USED");
    getDb()
      .prepare("UPDATE credential_intake_requests SET view_id = ?, actor_contact_id = ? WHERE id = ?")
      .run(viewId, binding.actorContactId, id);
    return { ...request, viewId, actorContactId: binding.actorContactId };
  })();
}

/** Caller must reauthorize the linked human before calling this internal API. */
export function claimIntakeRequest(id: string, binding: IntakeBinding, options: { now?: number } = {}): IntakeRequest {
  const now = options.now ?? Date.now();
  return getDb().transaction(() => {
    const request = getIntakeRequest(id);
    assertOpen(request, binding, now);
    if (!request.viewId || request.viewId !== binding.viewId) throw new IntakeError("INTAKE_BINDING_MISMATCH");
    if (
      getDb()
        .prepare("SELECT id FROM credential_intake_requests WHERE target = ? AND status = 'pending'")
        .get(request.target)
    ) {
      throw new IntakeError("INTAKE_TARGET_BUSY");
    }
    getDb()
      .prepare(
        "UPDATE credential_intake_requests SET status = 'pending', actor_contact_id = ? WHERE id = ? AND status = 'open'",
      )
      .run(binding.actorContactId, id);
    const claimed: IntakeRequest = { ...request, status: "pending", actorContactId: binding.actorContactId };
    audit(claimed, "accepted", now);
    return claimed;
  })();
}

export function completeIntakeRequest(
  id: string,
  result: { status: "stored"; fingerprint: string } | { status: "failed"; errorCode: IntakeErrorCode },
  options: { now?: number } = {},
): IntakeRequest {
  if (result.status === "stored" && !/^[a-f0-9]{64}$/.test(result.fingerprint))
    throw new IntakeError("INTAKE_STORE_FAILED");
  const now = options.now ?? Date.now();
  return getDb().transaction(() => {
    const request = getIntakeRequest(id);
    if (!request || request.status !== "pending") throw new IntakeError("INTAKE_ALREADY_USED");
    getDb()
      .prepare("UPDATE credential_intake_requests SET status = ?, fingerprint = ?, error_code = ? WHERE id = ?")
      .run(
        result.status,
        result.status === "stored" ? result.fingerprint : null,
        result.status === "failed" ? result.errorCode : null,
        id,
      );
    const completed = { ...request, ...result };
    audit(completed, result.status, now);
    return completed;
  })();
}

export function cancelIntakeRequest(id: string, binding: IntakeBinding, options: { now?: number } = {}): void {
  getDb().transaction(() => {
    const request = getIntakeRequest(id);
    if (!request) return;
    assertBinding(request, binding);
    if (request.viewId && request.viewId !== binding.viewId) throw new IntakeError("INTAKE_BINDING_MISMATCH");
    if (request.status !== "open") return;
    getDb()
      .prepare("UPDATE credential_intake_requests SET status = 'cancelled', actor_contact_id = ? WHERE id = ?")
      .run(binding.actorContactId, id);
    audit({ ...request, actorContactId: binding.actorContactId }, "cancelled", options.now ?? Date.now());
  })();
}

function audit(request: IntakeRequest, outcome: string, now: number): void {
  const target = normalizeIntakeTarget(request.target);
  getDb()
    .prepare(`INSERT INTO credential_intake_audit (
    id, request_id, actor_contact_id, account_id, team_id, user_id, target, scope,
    issuer_context_id, issuer_agent_id, issuer_session_key, outcome, fingerprint, error_code, created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      randomUUID(),
      request.id,
      request.actorContactId ?? null,
      request.accountId,
      request.teamId,
      request.userId,
      request.target,
      target.scope,
      request.issuerContextId ?? null,
      request.issuerAgentId ?? null,
      request.issuerSessionKey ?? null,
      outcome,
      request.fingerprint ?? null,
      request.errorCode ?? null,
      now,
    );
}

export interface IntakeSecretDeps {
  getEnvKey?: typeof getRaviEnvKey;
  addEnvKey?: typeof addRaviEnvKey;
  getConnection?: typeof getCredentialConnection;
  writeSecret?: typeof writeSecret;
  deleteSecret?: typeof deleteSecret;
  saveConnection?: typeof createCredentialConnectionIfAbsent;
  complete?: typeof completeIntakeRequest;
  remoteStore?: typeof storeRemoteIntake;
}

export interface IntakeReceipt {
  fingerprint: string;
  daemonReloadRequired: boolean;
  receiptKind?: "opaque";
  activationRequired?: boolean;
}

/** Secret exists only in memory and the destination store; never in request/audit. */
export async function storeIntakeSecret(
  request: IntakeRequest,
  secret: string,
  deps: IntakeSecretDeps = {},
): Promise<IntakeReceipt> {
  const current = getIntakeRequest(request.id);
  if (!current || current.status !== "pending") throw new IntakeError("INTAKE_ALREADY_USED");
  // Trust only the persisted request, not copies supplied by a caller.
  const target = normalizeIntakeTarget(current.target);
  const complete = deps.complete ?? completeIntakeRequest;
  const getConnection = deps.getConnection ?? getCredentialConnection;
  let secretWritten = false;
  let envWriteAttempted = false;
  let unreferencedSecretRef: string | undefined;
  try {
    if (
      typeof secret !== "string" ||
      secret.trim().length < 16 ||
      Buffer.byteLength(secret, "utf8") > 8192 ||
      secret.includes("\u0000")
    ) {
      throw new IntakeError("INTAKE_SECRET_INVALID");
    }
    if (/sk-ant-oat\d*(?:-|$)/i.test(secret)) throw new IntakeError("INTAKE_SECRET_INVALID");
    if (target.kind === "remote") {
      const receipt = await (deps.remoteStore ?? storeRemoteIntake)(current, secret);
      secretWritten = true;
      complete(current.id, { status: "stored", fingerprint: receipt.receipt });
      return {
        fingerprint: receipt.receipt,
        daemonReloadRequired: false,
        receiptKind: "opaque",
        activationRequired: true,
      };
    }
    if (target.kind === "env") {
      const existing = (deps.getEnvKey ?? getRaviEnvKey)(target.key);
      if (existing.present || existing.processPresent) throw new IntakeError("INTAKE_TARGET_EXISTS");
      envWriteAttempted = true;
      (deps.addEnvKey ?? addRaviEnvKey)(target.key, secret);
      secretWritten = true;
    } else {
      if (target.provider === "slack") parseSlackSecretPayload(secret);
      else if (/\s/.test(secret)) throw new IntakeError("INTAKE_SECRET_INVALID");
      if (getConnection(target.provider, target.connection)) throw new IntakeError("INTAKE_TARGET_EXISTS");
      // A unique backend coordinate prevents a race with an out-of-band CLI
      // writer from replacing a credential before the metadata check below.
      const secretRef = await (deps.writeSecret ?? writeSecret)({
        backend: current.backend!,
        provider: target.provider,
        connection: `${target.connection}-${current.id}`,
        secret,
      });
      unreferencedSecretRef = secretRef;
      if (getConnection(target.provider, target.connection)) throw new IntakeError("INTAKE_TARGET_EXISTS");
      const saved = (deps.saveConnection ?? createCredentialConnectionIfAbsent)({
        provider: target.provider,
        connection: target.connection,
        label: current.label,
        backend: current.backend!,
        secretRef,
        scopes: current.scopes,
        status: "active",
      });
      if (!saved) throw new IntakeError("INTAKE_TARGET_EXISTS");
      secretWritten = true;
      unreferencedSecretRef = undefined;
    }
    const fingerprint = createHash("sha256").update(secret).digest("hex");
    complete(current.id, { status: "stored", fingerprint });
    return { fingerprint, daemonReloadRequired: target.kind === "env" };
  } catch (error) {
    // no-cause: Parser and backend diagnostics may contain the secret; retain only safe intake codes.
    // A metadata commit or env write can fail after its durable side effect.
    // Never delete a referenced secret or tell the user an uncertain write did
    // not happen. The pending request keeps the target blocked for inspection.
    // Typed writer rejections before rename are known to have made no write.
    // An existing key may belong to a competing request, not this submission.
    if (
      target.kind === "remote" &&
      (secretWritten ||
        !(error instanceof IntakeError || error instanceof RemoteCredentialError) ||
        (error instanceof RemoteCredentialError && ["REMOTE_UNCERTAIN", "UNCERTAIN"].includes(error.code)))
    ) {
      throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
    }
    if (error instanceof RaviEnvFileError && error.code === "ENV_WRITE_UNCERTAIN") {
      throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
    }
    if (error instanceof RaviEnvFileError) envWriteAttempted = false;
    if (!secretWritten && envWriteAttempted && target.kind === "env") {
      try {
        secretWritten = (deps.getEnvKey ?? getRaviEnvKey)(target.key).present;
      } catch {
        // no-cause: Env inspection diagnostics must not escape; keep the uncertain write blocked for reconciliation.
        throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
      }
    }
    if (unreferencedSecretRef && target.kind === "connection") {
      try {
        secretWritten = getConnection(target.provider, target.connection)?.secretRef === unreferencedSecretRef;
      } catch {
        // no-cause: Failed reference lookup cannot prove ownership; preserve the secret and require reconciliation.
        throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
      }
      if (!secretWritten) {
        try {
          await (deps.deleteSecret ?? deleteSecret)(unreferencedSecretRef);
        } catch {
          // no-cause: Request-owned secret cleanup is best effort; backend diagnostics must not enter audit or responses.
        }
      }
    }
    if (secretWritten) throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
    const code =
      error instanceof IntakeError
        ? error.code
        : error instanceof RemoteCredentialError && ["VERSION_CONFLICT", "REQUEST_CONFLICT"].includes(error.code)
          ? "INTAKE_REMOTE_CONFLICT"
          : error instanceof RemoteCredentialError && error.code === "KEY_EXISTS"
            ? "INTAKE_TARGET_EXISTS"
            : error instanceof RaviEnvFileError && error.code === "ENV_KEY_EXISTS"
              ? "INTAKE_TARGET_EXISTS"
              : error instanceof RaviEnvFileError && error.code === "ENV_FILE_BUSY"
                ? "INTAKE_TARGET_BUSY"
                : "INTAKE_STORE_FAILED";
    try {
      complete(current.id, { status: "failed", errorCode: code });
    } catch {
      // no-cause: Failed completion leaves a non-replayable request; expose reconciliation without raw persistence diagnostics.
      throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
    }
    throw new IntakeError(code);
  }
}

/** Reconcile only a pending remote request; a network failure never declares it unwritten. */
export async function reconcileRemoteIntakeRequest(
  id: string,
  dependencies: { inspect?: typeof inspectRemoteIntake } = {},
): Promise<IntakeRequest> {
  const request = getIntakeRequest(id);
  if (!request || normalizeIntakeTarget(request.target).kind !== "remote")
    throw new IntakeError("INTAKE_NOT_AVAILABLE");
  // A status request must not fence an open invitation before its first submit.
  if (request.status !== "pending" && request.status !== "stored") throw new IntakeError("INTAKE_NOT_AVAILABLE");
  const status = await (dependencies.inspect ?? inspectRemoteIntake)(request);
  // The status operation itself reauthorizes even for completed/expired requests.
  const current = getIntakeRequest(id);
  if (!current) throw new IntakeError("INTAKE_NOT_AVAILABLE");
  if (current.status !== "pending") return current;
  if (status.status === "stored") return completeIntakeRequest(id, { status: "stored", fingerprint: status.receipt });
  // Receiver returns not_found only after durably fencing this request ID,
  // including when our coordinator has not sent PREPARE yet. Late writers
  // therefore cannot race this terminal failure or a new invitation.
  if (status.status === "not_found")
    return completeIntakeRequest(id, { status: "failed", errorCode: "INTAKE_STORE_FAILED" });
  return current;
}
