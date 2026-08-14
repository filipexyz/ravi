import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname, isAbsolute } from "node:path";
import type {
  RuntimeIntelligenceHubGrant,
  RuntimeIntelligenceLocalForwarder,
  RuntimeIntelligenceProfileSelection,
} from "./intelligence-proxy.js";
import type { RuntimeProviderId } from "./types.js";

const DEFAULT_IDENTITY_SOCKET = "/run/ravi/identityd.sock";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface RuntimeIntelligenceGrantAuthority {
  scheme: "identityd-hub-grant-v1";
  verified: true;
  attemptId: string;
  runtimeId: string;
  profileId: string;
  connectionId: string;
}

export interface RuntimeIntelligenceGrantRequest {
  selection: RuntimeIntelligenceProfileSelection;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider: string;
  model: string;
  runtimeId: string;
  agentId: string;
  sessionKey: string;
  taskProfile?: string;
}

export interface RuntimeIntelligenceGrantResolution {
  grant: RuntimeIntelligenceHubGrant;
  forwarder: RuntimeIntelligenceLocalForwarder;
}

export type RuntimeIntelligenceAttemptOutcome = "succeeded" | "credential_failed" | "provider_failed" | "abandoned";

export type RuntimeIntelligenceEffectState = "none" | "input_mutated" | "tool_started" | "output_materialized";

export interface RuntimeIntelligenceAttemptFeedback {
  attemptId: string;
  grantId: string;
  runtimeId: string;
  connectionId: string;
  sessionKey: string;
  outcome: RuntimeIntelligenceAttemptOutcome;
  effectState: RuntimeIntelligenceEffectState;
  failureKind?: string;
}

export interface RuntimeIntelligenceAttemptFeedbackResult {
  recorded: true;
  nextAction: "retain" | "advance";
  nextConnectionId?: string;
}

/**
 * Resolve ordered preferences through identityd and the Hub. The local list is
 * preference only; Hub grant authority and the local forwarder attestation are
 * both mandatory. identityd owns the attempt lifecycle and may move its cursor
 * only after explicit pre-effect credential-failure feedback.
 */
export async function requestRuntimeIntelligenceGrant(
  input: RuntimeIntelligenceGrantRequest,
  options: IdentityRequestOptions = {},
): Promise<RuntimeIntelligenceGrantResolution> {
  const parsed = await requestIdentityJson(
    "/v1/intelligence/grant",
    {
      version: 1,
      purpose: "intelligence_proxy_grant",
      profileId: input.selection.profileId,
      connectionIds: input.selection.connectionIds,
      provider: input.runtimeProvider,
      upstreamProvider: input.upstreamProvider,
      model: input.model,
      runtimeId: input.runtimeId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      ...(input.taskProfile ? { taskProfile: input.taskProfile } : {}),
    },
    options,
  );
  if (!isRecord(parsed)) throw new Error("identityd returned an invalid intelligence grant response.");
  const grant = readHubGrant(parsed.grant);
  const authority = readGrantAuthority(parsed.authority);
  const forwarder = readLocalForwarder(parsed.forwarder);
  if (
    !grant ||
    !authority ||
    !forwarder ||
    authority.attemptId !== grant.attemptId ||
    authority.runtimeId !== grant.runtimeId ||
    authority.profileId !== grant.profileId ||
    authority.connectionId !== grant.connectionId ||
    grant.runtimeId !== input.runtimeId ||
    grant.profileId !== input.selection.profileId ||
    !input.selection.connectionIds.includes(grant.connectionId) ||
    grant.runtimeProvider !== input.runtimeProvider ||
    grant.upstreamProvider !== input.upstreamProvider ||
    grant.model !== input.model
  ) {
    throw new Error("identityd returned an invalid intelligence grant response.");
  }
  return { grant, forwarder };
}

/**
 * Report an authoritative attempt transition. `advance` is valid only for a
 * credential failure before any durable input mutation, tool, or output. The
 * OSS host enforces this invariant independently of identityd.
 */
export async function reportRuntimeIntelligenceAttemptFeedback(
  input: RuntimeIntelligenceAttemptFeedback,
  options: IdentityRequestOptions = {},
): Promise<RuntimeIntelligenceAttemptFeedbackResult> {
  const parsed = await requestIdentityJson(
    `/v1/intelligence/attempts/${encodeURIComponent(readPublicId(input.attemptId, "attemptId"))}/feedback`,
    {
      version: 1,
      purpose: "intelligence_proxy_attempt_feedback",
      grantId: input.grantId,
      runtimeId: input.runtimeId,
      connectionId: input.connectionId,
      sessionKey: input.sessionKey,
      outcome: input.outcome,
      effectState: input.effectState,
      ...(input.failureKind ? { failureKind: input.failureKind } : {}),
    },
    options,
  );
  if (
    !isRecord(parsed) ||
    parsed.recorded !== true ||
    (parsed.nextAction !== "retain" && parsed.nextAction !== "advance")
  ) {
    throw new Error("identityd returned an invalid intelligence attempt feedback response.");
  }
  const mayAdvance = input.outcome === "credential_failed" && input.effectState === "none";
  if (parsed.nextAction === "advance" && !mayAdvance) {
    throw new Error("identityd attempted to advance an intelligence connection after a side-effect boundary.");
  }
  if (parsed.nextConnectionId !== undefined && typeof parsed.nextConnectionId !== "string") {
    throw new Error("identityd returned an invalid intelligence attempt feedback response.");
  }
  return {
    recorded: true,
    nextAction: parsed.nextAction,
    ...(typeof parsed.nextConnectionId === "string" ? { nextConnectionId: parsed.nextConnectionId } : {}),
  };
}

interface IdentityRequestOptions {
  socketPath?: string;
  timeoutMs?: number;
  skipSocketSecurityCheck?: boolean;
}

async function requestIdentityJson(
  path: string,
  input: Record<string, unknown>,
  options: IdentityRequestOptions,
): Promise<unknown> {
  const socketPath = options.socketPath ?? process.env.RAVI_IDENTITYD_SOCKET?.trim() ?? DEFAULT_IDENTITY_SOCKET;
  if (!isAbsolute(socketPath)) throw new Error("RAVI_IDENTITYD_SOCKET must be an absolute Unix socket path.");
  if (!options.skipSocketSecurityCheck) await assertSecureIdentitySocket(socketPath);
  const body = JSON.stringify(input);
  const payload = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("identityd response exceeded the size limit."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`identityd rejected the request (${response.statusCode ?? "unknown"}).`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error("identityd request timed out."));
    });
    req.on("error", () => reject(new Error("Could not complete the intelligence request through local identityd.")));
    req.end(body);
  });
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("identityd returned invalid JSON.");
  }
}

function readHubGrant(value: unknown): RuntimeIntelligenceHubGrant | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.grantId !== "string" ||
    typeof value.attemptId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.profileId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.connectionRevision !== "string" ||
    typeof value.sessionCompatibilityKey !== "string" ||
    !isRuntimeProviderId(value.runtimeProvider) ||
    typeof value.upstreamProvider !== "string" ||
    typeof value.model !== "string" ||
    typeof value.proxyOrigin !== "string" ||
    typeof value.audience !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    version: 1,
    grantId: value.grantId,
    attemptId: value.attemptId,
    runtimeId: value.runtimeId,
    profileId: value.profileId,
    connectionId: value.connectionId,
    connectionRevision: value.connectionRevision,
    sessionCompatibilityKey: value.sessionCompatibilityKey,
    runtimeProvider: value.runtimeProvider,
    upstreamProvider: value.upstreamProvider,
    model: value.model,
    proxyOrigin: value.proxyOrigin,
    audience: value.audience,
    expiresAt: value.expiresAt,
  };
}

function readGrantAuthority(value: unknown): RuntimeIntelligenceGrantAuthority | null {
  if (
    !isRecord(value) ||
    value.scheme !== "identityd-hub-grant-v1" ||
    value.verified !== true ||
    typeof value.attemptId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.profileId !== "string" ||
    typeof value.connectionId !== "string"
  ) {
    return null;
  }
  return {
    scheme: "identityd-hub-grant-v1",
    verified: true,
    attemptId: value.attemptId,
    runtimeId: value.runtimeId,
    profileId: value.profileId,
    connectionId: value.connectionId,
  };
}

function readLocalForwarder(value: unknown): RuntimeIntelligenceLocalForwarder | null {
  if (
    !isRecord(value) ||
    value.scheme !== "identityd-signing-forwarder-v1" ||
    value.verified !== true ||
    typeof value.bindingHandle !== "string" ||
    typeof value.origin !== "string"
  ) {
    return null;
  }
  return {
    scheme: "identityd-signing-forwarder-v1",
    verified: true,
    bindingHandle: value.bindingHandle,
    origin: value.origin,
  };
}

async function assertSecureIdentitySocket(socketPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(socketPath);
  } catch {
    throw new Error("Local identityd socket is unavailable.");
  }
  if (!stats.isSocket() || stats.isSymbolicLink()) {
    throw new Error("RAVI_IDENTITYD_SOCKET must point to a Unix socket.");
  }
  if (stats.uid !== 0) throw new Error("Local identityd socket must be owned by root.");
  if ((stats.mode & 0o022) !== 0) throw new Error("Local identityd socket must not be group/world writable.");
  let current = dirname(socketPath);
  while (current !== dirname(current)) {
    const parent = await lstat(current);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
      throw new Error("Local identityd socket ancestry is not root-controlled.");
    }
    current = dirname(current);
  }
}

function isRuntimeProviderId(value: unknown): value is RuntimeProviderId {
  return value === "claude" || value === "codex" || value === "pi";
}

function readPublicId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be a non-secret public identifier.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
