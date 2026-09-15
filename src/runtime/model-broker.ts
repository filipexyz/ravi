import { createHash } from "node:crypto";
import type { AgentConfig } from "../router/index.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeCapabilities, RuntimeProviderId } from "./types.js";

export const MODEL_BROKER_REQUIRED_SETTING = "runtime.model_broker.required";
export const MODEL_BROKER_REQUIRED_ENV = "RAVI_MODEL_BROKER_REQUIRED";
export const MODEL_BROKER_MIN_LEASE_REMAINING_MS = 30_000;
export const DEFAULT_MODEL_BROKER_ID = "hub";
export const CANONICAL_MODEL_BROKER_PROFILE_REF = "canonical";

export type RuntimeModelBrokerProtocol = "anthropic-messages" | "openai-completions" | "openai-responses";
export type RuntimeModelBrokerPrincipalIsolation = "none" | "uid" | "cgroup" | "one-shot-capability";
export type RuntimeModelBrokerAttemptOutcome = "succeeded" | "credential_failed" | "provider_failed" | "abandoned";
export type RuntimeModelBrokerEffectState = "none" | "input_mutated" | "tool_started" | "output_materialized";

/** The only model-broker configuration persisted on an agent. */
export interface RuntimeModelBrokerSelection {
  brokerId: string;
  profileRef: string;
  required?: boolean;
}

export interface RuntimeModelBrokerTransport {
  scheme: "local-http-forwarder-v1";
  protocol: RuntimeModelBrokerProtocol;
  origin: string;
  path: string;
  /** Public routing metadata only. Authorization/cookie/proxy headers are rejected. */
  publicHeaders: Record<string, string>;
}

/** Secretless, authoritative route resolved by a broker for one provider attempt. */
export interface RuntimeModelBrokerRouteLease {
  version: 1;
  brokerId: string;
  leaseId: string;
  attemptId: string;
  turnId: string;
  runtimeId: string;
  runtimeProvider: RuntimeProviderId;
  model: string;
  routeRevision: string;
  compatibilityRevision: string;
  expiresAt: number;
  transport: RuntimeModelBrokerTransport;
}

/** Immutable provider-facing binding for one physical provider session. */
export interface RuntimeModelBrokerBinding extends RuntimeModelBrokerRouteLease {
  profileRef: string;
  selectionCompatibilityKey: string;
  principalIsolation: Exclude<RuntimeModelBrokerPrincipalIsolation, "none">;
}

export interface RuntimeModelBrokerCapabilities {
  principalIsolation: RuntimeModelBrokerPrincipalIsolation;
  protocols: RuntimeModelBrokerProtocol[];
}

export interface ModelBrokerResolveRequest {
  profileRef: string;
  runtimeId: string;
  agentId: string;
  sessionKey: string;
  turnId: string;
  requestedProvider?: RuntimeProviderId;
  requestedModel?: string;
  taskProfile?: string;
}

export interface ModelBrokerAttemptFeedback {
  leaseId: string;
  attemptId: string;
  turnId: string;
  runtimeId: string;
  sessionKey: string;
  outcome: RuntimeModelBrokerAttemptOutcome;
  effectState: RuntimeModelBrokerEffectState;
  failureKind?: string;
}

export interface ModelBrokerAttemptFeedbackResult {
  recorded: true;
  nextAction: "retain" | "advance";
}

export interface ModelBroker {
  id: string;
  resolveRoute(input: ModelBrokerResolveRequest): Promise<RuntimeModelBrokerRouteLease>;
  reportAttempt(input: ModelBrokerAttemptFeedback): Promise<ModelBrokerAttemptFeedbackResult>;
}

export async function reportRuntimeModelBrokerAttempt(
  broker: ModelBroker,
  input: ModelBrokerAttemptFeedback,
): Promise<ModelBrokerAttemptFeedbackResult> {
  const result = await broker.reportAttempt(input);
  if (result?.recorded !== true || (result.nextAction !== "retain" && result.nextAction !== "advance")) {
    throw new Error("The model broker returned invalid attempt feedback.");
  }
  if (result.nextAction === "advance" && (input.outcome !== "credential_failed" || input.effectState !== "none")) {
    throw new Error("A model broker cannot advance a route after the effect-safe credential boundary.");
  }
  return result;
}

export function readRuntimeModelBrokerSelection(
  agent: Pick<AgentConfig, "defaults">,
): RuntimeModelBrokerSelection | undefined {
  const raw = readModelBrokerDefaults(agent);
  if (!raw) return undefined;
  if (raw.required !== undefined && typeof raw.required !== "boolean") {
    throw new Error("Invalid model broker selection: required must be a boolean.");
  }
  const hasBroker = raw.brokerId !== undefined;
  const hasProfile = raw.profileRef !== undefined;
  if (!hasBroker && !hasProfile) return undefined;
  if (hasBroker !== hasProfile) {
    throw new Error("Invalid model broker selection: brokerId and profileRef must be configured together.");
  }
  const brokerId = readPublicId(raw.brokerId, "modelBroker.brokerId");
  const profileRef = readPublicId(raw.profileRef, "modelBroker.profileRef");
  return {
    brokerId,
    profileRef,
    ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
  };
}

export function isRuntimeModelBrokerRequired(
  agent: Pick<AgentConfig, "defaults">,
  globalSetting: string | undefined,
  environmentSetting = process.env[MODEL_BROKER_REQUIRED_ENV],
): boolean {
  const raw = readModelBrokerDefaults(agent);
  if (raw?.required !== undefined && typeof raw.required !== "boolean") {
    throw new Error("Invalid model broker selection: required must be a boolean.");
  }
  const environmentRequired = parseRequiredSetting(environmentSetting, MODEL_BROKER_REQUIRED_ENV);
  const globallyRequired = parseRequiredSetting(globalSetting, MODEL_BROKER_REQUIRED_SETTING);
  return environmentRequired || globallyRequired || raw?.required === true;
}

export function resolveRequiredRuntimeModelBrokerSelection(
  agent: Pick<AgentConfig, "defaults">,
  globalSetting: string | undefined,
  environmentSetting = process.env[MODEL_BROKER_REQUIRED_ENV],
): RuntimeModelBrokerSelection | undefined {
  const selection = readRuntimeModelBrokerSelection(agent);
  const required = isRuntimeModelBrokerRequired(agent, globalSetting, environmentSetting);
  if (!required) return undefined;
  return (
    selection ?? {
      brokerId: DEFAULT_MODEL_BROKER_ID,
      profileRef: CANONICAL_MODEL_BROKER_PROFILE_REF,
      required: true,
    }
  );
}

export function buildRuntimeModelBrokerSelectionCompatibilityKey(selection: RuntimeModelBrokerSelection): string {
  return `sha256:${stablePublicDigest(
    JSON.stringify({ brokerId: selection.brokerId, profileRef: selection.profileRef, required: true }),
  )}`;
}

export function assertRuntimeModelBrokerCapability(
  runtimeCapabilities: RuntimeCapabilities,
  runtimeProvider: RuntimeProviderId,
  protocol?: RuntimeModelBrokerProtocol,
): RuntimeModelBrokerCapabilities {
  const capability = runtimeCapabilities.modelBroker;
  if (!capability) throw new Error(`Runtime provider ${runtimeProvider} does not support a model broker.`);
  if (capability.principalIsolation === "none") {
    throw new Error(`Runtime provider ${runtimeProvider} cannot use a model broker without an isolated principal.`);
  }
  if (protocol && !capability.protocols.includes(protocol)) {
    throw new Error(`Runtime provider ${runtimeProvider} does not support broker protocol ${protocol}.`);
  }
  return capability;
}

export function buildRuntimeModelBrokerBinding(options: {
  selection: RuntimeModelBrokerSelection;
  lease: RuntimeModelBrokerRouteLease;
  runtimeCapabilities: RuntimeCapabilities;
  expectedRuntimeProvider: RuntimeProviderId;
  now?: number;
}): RuntimeModelBrokerBinding {
  const { selection, expectedRuntimeProvider } = options;
  const lease = validateRuntimeModelBrokerRouteLease(options.lease, options.now ?? Date.now());
  if (lease.brokerId !== selection.brokerId) throw new Error("The model broker returned a lease for another broker.");
  // Route planning precedes provider selection. A mismatch here means the planned
  // authority changed before binding materialization, so never start the wrong adapter.
  if (lease.runtimeProvider !== expectedRuntimeProvider) {
    throw new Error(
      `Model-broker provider changed after preflight (${expectedRuntimeProvider} -> ${lease.runtimeProvider}).`,
    );
  }
  const capability = assertRuntimeModelBrokerCapability(
    options.runtimeCapabilities,
    expectedRuntimeProvider,
    lease.transport.protocol,
  );
  return {
    ...lease,
    transport: lease.transport,
    profileRef: selection.profileRef,
    selectionCompatibilityKey: buildRuntimeModelBrokerSelectionCompatibilityKey(selection),
    principalIsolation: capability.principalIsolation as Exclude<RuntimeModelBrokerPrincipalIsolation, "none">,
  };
}

export function buildRuntimeModelBrokerAttemptBinding(
  binding: RuntimeModelBrokerBinding,
  sessionKey: string,
): RuntimeCredentialAttemptBinding {
  return {
    attemptId: binding.attemptId,
    credentialId: `model-broker:${binding.brokerId}:${binding.profileRef}`,
    modelBrokerId: binding.brokerId,
    modelBrokerProfileRef: binding.profileRef,
    modelBrokerLeaseId: binding.leaseId,
    modelBrokerRuntimeId: binding.runtimeId,
    modelBrokerSessionKey: sessionKey,
    modelBrokerTurnId: binding.turnId,
    modelBrokerRouteRevision: binding.routeRevision,
    modelBrokerCompatibilityRevision: binding.compatibilityRevision,
    modelBrokerSelectionCompatibilityKey: binding.selectionCompatibilityKey,
    modelBrokerLeaseExpiresAt: binding.expiresAt,
    modelBrokerAttemptTerminal: false,
    label: `Model broker ${binding.brokerId}/${binding.profileRef}`,
    fingerprint: buildRuntimeModelBrokerPhysicalFingerprint(
      { brokerId: binding.brokerId, profileRef: binding.profileRef, required: true },
      binding,
    ),
    runtimeProvider: binding.runtimeProvider,
    authMethod: "model-broker",
    sessionCompatibilityKey: binding.compatibilityRevision,
    resolvedEnv: {},
    sensitiveEnvKeys: [],
    remoteForwardEnvKeys: [],
    bindings: [],
  };
}

/** Public identity of the stable physical route, excluding per-attempt binding headers. */
export function buildRuntimeModelBrokerPhysicalFingerprint(
  selection: RuntimeModelBrokerSelection,
  lease: RuntimeModelBrokerRouteLease,
): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        brokerId: lease.brokerId,
        profileRef: selection.profileRef,
        runtimeId: lease.runtimeId,
        routeRevision: lease.routeRevision,
        compatibilityRevision: lease.compatibilityRevision,
        selectionCompatibilityKey: buildRuntimeModelBrokerSelectionCompatibilityKey(selection),
        runtimeProvider: lease.runtimeProvider,
        model: lease.model,
        transport: {
          scheme: lease.transport.scheme,
          protocol: lease.transport.protocol,
          origin: lease.transport.origin,
          path: lease.transport.path,
        },
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `sha256:${fingerprint}`;
}

export function serializeRuntimeModelBrokerBinding(binding: RuntimeModelBrokerBinding) {
  return { ...binding, transport: { ...binding.transport, publicHeaders: { ...binding.transport.publicHeaders } } };
}

export function isRuntimeModelBrokerPhysicalBindingCompatible(
  current: RuntimeModelBrokerBinding,
  next: RuntimeModelBrokerBinding,
): boolean {
  return (
    current.brokerId === next.brokerId &&
    current.profileRef === next.profileRef &&
    current.runtimeId === next.runtimeId &&
    current.runtimeProvider === next.runtimeProvider &&
    current.model === next.model &&
    current.routeRevision === next.routeRevision &&
    current.compatibilityRevision === next.compatibilityRevision &&
    current.selectionCompatibilityKey === next.selectionCompatibilityKey &&
    current.principalIsolation === next.principalIsolation &&
    current.transport.scheme === next.transport.scheme &&
    current.transport.protocol === next.transport.protocol &&
    current.transport.origin === next.transport.origin &&
    current.transport.path === next.transport.path
  );
}

export function resolveRuntimeModelBrokerProviderModel(binding: RuntimeModelBrokerBinding): string {
  return binding.model;
}

function readModelBrokerDefaults(agent: Pick<AgentConfig, "defaults">): Record<string, unknown> | undefined {
  const raw = agent.defaults?.modelBroker;
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error("Invalid model broker selection: expected an object.");
  return raw;
}

export function validateRuntimeModelBrokerRouteLease(
  lease: RuntimeModelBrokerRouteLease,
  now = Date.now(),
): RuntimeModelBrokerRouteLease {
  if (lease.version !== 1) throw new Error("The model broker returned an unsupported route lease.");
  for (const [label, value] of [
    ["brokerId", lease.brokerId],
    ["leaseId", lease.leaseId],
    ["attemptId", lease.attemptId],
    ["turnId", lease.turnId],
    ["runtimeId", lease.runtimeId],
    ["runtimeProvider", lease.runtimeProvider],
    ["routeRevision", lease.routeRevision],
    ["compatibilityRevision", lease.compatibilityRevision],
  ] as const) {
    readPublicId(value, `model broker lease ${label}`);
  }
  readPublicModel(lease.model);
  if (
    !Number.isFinite(lease.expiresAt) ||
    lease.expiresAt < now + MODEL_BROKER_MIN_LEASE_REMAINING_MS ||
    lease.expiresAt > now + 24 * 60 * 60_000
  ) {
    throw new Error("The model broker returned an expired or unbounded route lease.");
  }
  return { ...lease, transport: validateTransport(lease.transport) };
}

function validateTransport(transport: RuntimeModelBrokerTransport): RuntimeModelBrokerTransport {
  if (transport.scheme !== "local-http-forwarder-v1") {
    throw new Error("The model broker returned an unsupported transport scheme.");
  }
  let url: URL;
  try {
    url = new URL(transport.origin);
  } catch {
    throw new Error("The model broker returned an invalid local forwarder origin.");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("A model broker transport must use an explicit 127.0.0.1 HTTP origin.");
  }
  validateEndpointPath(transport.path);
  const publicHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(transport.publicHeaders)) {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(normalizedName)) {
      throw new Error("The model broker returned an invalid public header name.");
    }
    if (isForbiddenTransportHeader(normalizedName)) {
      throw new Error(`The model broker cannot materialize forbidden header ${normalizedName}.`);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\r\n]/.test(value)) {
      throw new Error(`The model broker returned an invalid public value for header ${normalizedName}.`);
    }
    publicHeaders[normalizedName] = value;
  }
  return { ...transport, origin: url.origin, publicHeaders };
}

function isForbiddenTransportHeader(name: string): boolean {
  return (
    name === "authorization" ||
    name === "proxy-authorization" ||
    name === "cookie" ||
    name === "set-cookie" ||
    name === "host" ||
    name === "connection" ||
    name === "keep-alive" ||
    name === "proxy-authenticate" ||
    name === "te" ||
    name === "trailer" ||
    name === "transfer-encoding" ||
    name === "upgrade" ||
    name === "content-length" ||
    name.startsWith("proxy-") ||
    /(^|[-_])(api[-_]?key|access[-_]?token|auth[-_]?token|credential|secret)([-_]|$)/.test(name)
  );
}

function validateEndpointPath(value: string): void {
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(value) || value.includes("//")) {
    throw new Error("A model broker transport path must be absolute without a query or fragment.");
  }
}

function parseRequiredSetting(value: string | undefined, source: string): boolean {
  if (value === undefined || value.trim() === "" || value.trim() === "false") return false;
  if (value.trim() === "true") return true;
  throw new Error(`${source} must be true or false.`);
}

export function readModelBrokerPublicId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be a non-secret public identifier.`);
  }
  return normalized;
}

function readPublicId(value: unknown, label: string): string {
  return readModelBrokerPublicId(value, label);
}

function readPublicModel(value: unknown): string {
  if (typeof value !== "string") throw new Error("model broker lease model must be a string.");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(normalized)) {
    throw new Error("model broker lease model must be a public model selector.");
  }
  return normalized;
}

function stablePublicDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
