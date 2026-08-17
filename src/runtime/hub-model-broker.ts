import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname, isAbsolute } from "node:path";
import type {
  ModelBroker,
  ModelBrokerAttemptFeedback,
  ModelBrokerAttemptFeedbackResult,
  ModelBrokerResolveRequest,
  RuntimeModelBrokerProtocol,
  RuntimeModelBrokerRouteLease,
} from "./model-broker.js";
import { readModelBrokerPublicId, validateRuntimeModelBrokerRouteLease } from "./model-broker.js";
import type { RuntimeProviderId } from "./types.js";

const DEFAULT_IDENTITY_SOCKET = "/run/ravi/identityd.sock";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

interface HubGrantWire {
  version: 1;
  grantId: string;
  attemptId: string;
  turnId: string;
  runtimeId: string;
  profileRef: string;
  /** Hub-private routing detail. Never returned by this adapter. */
  connectionId: string;
  routeRevision: string;
  compatibilityRevision: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider: string;
  model: string;
  proxyOrigin: string;
  audience: string;
  expiresAt: number;
}

interface HubGrantAuthorityWire {
  scheme: "identityd-hub-model-broker-v1";
  verified: true;
  attemptId: string;
  turnId: string;
  runtimeId: string;
  profileRef: string;
}

interface HubForwarderWire {
  scheme: "identityd-signing-forwarder-v1";
  verified: true;
  bindingHandle: string;
  origin: string;
  protocol: RuntimeModelBrokerProtocol;
  requestPath: string;
}

interface HubModelBrokerOptions {
  socketPath?: string;
  timeoutMs?: number;
  skipSocketSecurityCheck?: boolean;
  expectedStatus?: number;
}

export class HubModelBroker implements ModelBroker {
  readonly id = "hub";

  constructor(private readonly options: HubModelBrokerOptions = {}) {}

  async resolveRoute(input: ModelBrokerResolveRequest): Promise<RuntimeModelBrokerRouteLease> {
    const profileRef = requireHubUuid(input.profileRef, "profileRef");
    const runtimeId = requireHubUuid(input.runtimeId, "runtimeId");
    const agentId = requireWireText(input.agentId, "agentId");
    const sessionKey = requireWireText(input.sessionKey, "sessionKey");
    const turnId = requireWireText(input.turnId, "turnId");
    const parsed = await requestIdentityJson(
      "/v1/model-broker/leases",
      {
        version: 1,
        purpose: "model_broker_route_lease",
        profileRef,
        runtimeId,
        agentId,
        sessionKey,
        turnId,
      },
      { ...this.options, expectedStatus: 201 },
    );
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["grant", "authority", "forwarder"])) {
      throw new Error("identityd returned an invalid Hub model-broker lease response.");
    }
    const grant = readHubGrant(parsed.grant);
    const authority = readHubAuthority(parsed.authority);
    const forwarder = readHubForwarder(parsed.forwarder);
    if (
      !grant ||
      !authority ||
      !forwarder ||
      authority.attemptId !== grant.attemptId ||
      authority.turnId !== grant.turnId ||
      authority.runtimeId !== grant.runtimeId ||
      authority.profileRef !== grant.profileRef ||
      grant.runtimeId !== runtimeId ||
      grant.profileRef !== profileRef ||
      grant.turnId !== turnId
    ) {
      throw new Error("identityd returned an invalid Hub model-broker lease response.");
    }
    return validateRuntimeModelBrokerRouteLease({
      version: 1,
      brokerId: this.id,
      leaseId: grant.grantId,
      attemptId: grant.attemptId,
      turnId: grant.turnId,
      runtimeId: grant.runtimeId,
      runtimeProvider: grant.runtimeProvider,
      model: grant.model,
      routeRevision: grant.routeRevision,
      compatibilityRevision: grant.compatibilityRevision,
      expiresAt: grant.expiresAt,
      transport: {
        scheme: "local-http-forwarder-v1",
        protocol: forwarder.protocol,
        origin: forwarder.origin,
        path: forwarder.requestPath,
        publicHeaders: { "x-ravi-binding": forwarder.bindingHandle },
      },
    });
  }

  async reportAttempt(input: ModelBrokerAttemptFeedback): Promise<ModelBrokerAttemptFeedbackResult> {
    const attemptId = requireHubUuid(input.attemptId, "attemptId");
    const leaseId = requireHubUuid(input.leaseId, "leaseId");
    const runtimeId = requireHubUuid(input.runtimeId, "runtimeId");
    const sessionKey = requireWireText(input.sessionKey, "sessionKey");
    requireWireText(input.turnId, "turnId");
    const errorClass = input.failureKind
      ? readModelBrokerPublicId(input.failureKind, "model-broker feedback errorClass")
      : undefined;
    const parsed = await requestIdentityJson(
      `/v1/model-broker/attempts/${encodeURIComponent(attemptId)}/feedback`,
      {
        version: 1,
        purpose: "model_broker_attempt_feedback",
        leaseId,
        runtimeId,
        sessionKey,
        outcome: input.outcome,
        effectState: input.effectState,
        ...(errorClass ? { errorClass } : {}),
      },
      this.options,
    );
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ["version", "attemptId", "turnId", "status", "retryable", "replayed"]) ||
      parsed.version !== 1 ||
      parsed.attemptId !== input.attemptId ||
      parsed.turnId !== input.turnId
    ) {
      throw new Error("identityd returned an invalid Hub model-broker feedback response.");
    }
    const statuses = new Set(["succeeded", "retry_ready", "exhausted", "blocked"]);
    if (
      !statuses.has(String(parsed.status)) ||
      typeof parsed.retryable !== "boolean" ||
      typeof parsed.replayed !== "boolean"
    ) {
      throw new Error("identityd returned an invalid Hub model-broker feedback response.");
    }
    if ((parsed.status === "retry_ready") !== parsed.retryable) {
      throw new Error("identityd returned contradictory Hub model-broker retry state.");
    }
    const nextAction = parsed.status === "retry_ready" ? "advance" : "retain";
    const mayAdvance = input.outcome === "credential_failed" && input.effectState === "none";
    if (nextAction === "advance" && !mayAdvance) {
      throw new Error("The Hub model broker attempted to advance a route after a side-effect boundary.");
    }
    return { recorded: true, nextAction };
  }
}

export function createHubModelBroker(options?: HubModelBrokerOptions): HubModelBroker {
  return new HubModelBroker(options);
}

async function requestIdentityJson(
  path: string,
  input: Record<string, unknown>,
  options: HubModelBrokerOptions,
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
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
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
          if (response.statusCode !== (options.expectedStatus ?? 200)) {
            reject(new Error(`identityd rejected the request (${response.statusCode ?? "unknown"}).`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    req.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () =>
      req.destroy(new Error("identityd request timed out.")),
    );
    req.on("error", () => reject(new Error("Could not complete the Hub model-broker request through identityd.")));
    req.end(body);
  });
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("identityd returned invalid JSON.");
  }
}

function readHubGrant(value: unknown): HubGrantWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "grantId",
      "attemptId",
      "turnId",
      "runtimeId",
      "profileRef",
      "connectionId",
      "routeRevision",
      "compatibilityRevision",
      "runtimeProvider",
      "upstreamProvider",
      "model",
      "proxyOrigin",
      "audience",
      "expiresAt",
    ]) ||
    value.version !== 1
  ) {
    return null;
  }
  if (
    !isHubUuid(value.grantId) ||
    !isHubUuid(value.attemptId) ||
    !isNonEmptyWireText(value.turnId) ||
    !isHubUuid(value.runtimeId) ||
    !isHubUuid(value.profileRef) ||
    !isHubUuid(value.connectionId) ||
    !isOpaqueRevision(value.routeRevision) ||
    !isOpaqueRevision(value.compatibilityRevision) ||
    (value.runtimeProvider !== "codex" && value.runtimeProvider !== "claude" && value.runtimeProvider !== "pi") ||
    !isNonEmptyWireText(value.upstreamProvider) ||
    !isNonEmptyWireText(value.model) ||
    !isNonEmptyWireText(value.proxyOrigin) ||
    !isNonEmptyWireText(value.audience) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return null;
  }
  return value as unknown as HubGrantWire;
}

function readHubAuthority(value: unknown): HubGrantAuthorityWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["scheme", "verified", "attemptId", "turnId", "runtimeId", "profileRef"]) ||
    value.scheme !== "identityd-hub-model-broker-v1" ||
    value.verified !== true ||
    !isHubUuid(value.attemptId) ||
    !isNonEmptyWireText(value.turnId) ||
    !isHubUuid(value.runtimeId) ||
    !isHubUuid(value.profileRef)
  ) {
    return null;
  }
  return value as unknown as HubGrantAuthorityWire;
}

function readHubForwarder(value: unknown): HubForwarderWire | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["scheme", "verified", "bindingHandle", "origin", "protocol", "requestPath"]) ||
    value.scheme !== "identityd-signing-forwarder-v1" ||
    value.verified !== true ||
    !isNonEmptyWireText(value.bindingHandle) ||
    !isNonEmptyWireText(value.origin) ||
    (value.protocol !== "anthropic-messages" &&
      value.protocol !== "openai-completions" &&
      value.protocol !== "openai-responses") ||
    !isNonEmptyWireText(value.requestPath)
  ) {
    return null;
  }
  return value as unknown as HubForwarderWire;
}

async function assertSecureIdentitySocket(socketPath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(socketPath);
  } catch {
    throw new Error("Local identityd socket is unavailable.");
  }
  if (!stats.isSocket() || stats.isSymbolicLink())
    throw new Error("RAVI_IDENTITYD_SOCKET must point to a Unix socket.");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireHubUuid(value: unknown, label: string): string {
  if (!isHubUuid(value)) throw new Error(`Hub model-broker ${label} must be a canonical UUID.`);
  return value;
}

function requireWireText(value: unknown, label: string): string {
  if (!isNonEmptyWireText(value)) throw new Error(`Hub model-broker ${label} must be bounded public text.`);
  return value;
}

function isHubUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isOpaqueRevision(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function isNonEmptyWireText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
