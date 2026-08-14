import { createHash } from "node:crypto";
import type { AgentConfig } from "../router/index.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeCapabilities, RuntimeProviderId } from "./types.js";

export const INTELLIGENCE_PROXY_REQUIRED_SETTING = "runtime.intelligence.proxy_required";

export type RuntimeIntelligenceProtocol = "anthropic-messages" | "openai-completions" | "openai-responses";

export type RuntimeIntelligencePrincipalIsolation = "none" | "uid" | "cgroup" | "one-shot-capability";

/** Public preferences persisted on an agent. They are never proof of Hub membership. */
export interface RuntimeIntelligenceProfileSelection {
  profileId: string;
  connectionIds: string[];
}

/**
 * Public authorization result returned by identityd after it resolves the
 * profile against the Hub. The local connection list is only ordered input;
 * this grant is the authority used by the runtime.
 */
export interface RuntimeIntelligenceHubGrant {
  version: 1;
  grantId: string;
  attemptId: string;
  runtimeId: string;
  profileId: string;
  connectionId: string;
  connectionRevision: string;
  sessionCompatibilityKey: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider: string;
  model: string;
  proxyOrigin: string;
  audience: string;
  expiresAt: number;
}

/** Local, identityd-attested data-plane binding. The handle is public and is never authority by itself. */
export interface RuntimeIntelligenceLocalForwarder {
  scheme: "identityd-signing-forwarder-v1";
  verified: true;
  bindingHandle: string;
  origin: string;
}

/** Public contract handed to a provider adapter. It cannot carry an upstream secret or signing key. */
export interface RuntimeIntelligenceProxyBinding {
  version: 1;
  grantId: string;
  attemptId: string;
  grantExpiresAt: number;
  runtimeId: string;
  profileId: string;
  connectionId: string;
  connectionRevision: string;
  sessionCompatibilityKey: string;
  /** Stable digest of profile ordering and effective proxy-required policy. */
  policyCompatibilityKey: string;
  runtimeProvider: RuntimeProviderId;
  upstreamProvider: string;
  model: string;
  protocol: RuntimeIntelligenceProtocol;
  /** Provider-facing loopback URL. Providers never receive the upstream Hub URL or a bearer token. */
  localSigningForwarderBaseUrl: string;
  /** Exact provider request path registered with identityd for this binding. */
  localSigningForwarderRequestPath: string;
  /** Public lookup handle. identityd resolves and authorizes it server-side. */
  bindingHandle: string;
  audience: string;
  providerRuntimeId: string;
  providerPrincipalIsolation: Exclude<RuntimeIntelligencePrincipalIsolation, "none">;
}

export interface RuntimeIntelligenceProxyCapabilities {
  transport: {
    protocol: RuntimeIntelligenceProtocol;
    basePath: "" | `/${string}`;
    endpointPath: string;
  };
  localSigningForwarder: boolean;
  /** `none` means the adapter MUST fail closed before materialization. */
  providerPrincipalIsolation: RuntimeIntelligencePrincipalIsolation;
}

export function readRuntimeIntelligenceProfileSelection(
  agent: Pick<AgentConfig, "defaults">,
): RuntimeIntelligenceProfileSelection | undefined {
  const raw = readIntelligenceDefaults(agent);
  if (!raw) return undefined;
  const hasProfile = raw.profileId !== undefined || raw.connectionIds !== undefined;
  if (!hasProfile) return undefined;
  const profileId = readPublicId(raw.profileId, "intelligence.profileId");
  if (!Array.isArray(raw.connectionIds) || raw.connectionIds.length === 0) {
    throw new Error("Invalid intelligence profile: connectionIds must be a non-empty array.");
  }
  const connectionIds = raw.connectionIds.map((value) => readPublicId(value, "intelligence.connectionIds"));
  if (new Set(connectionIds).size !== connectionIds.length) {
    throw new Error("Invalid intelligence profile: connectionIds must not contain duplicates.");
  }
  return { profileId, connectionIds };
}

export function isRuntimeIntelligenceProxyRequired(
  agent: Pick<AgentConfig, "defaults">,
  globalSetting: string | undefined,
): boolean {
  const raw = readIntelligenceDefaults(agent);
  const agentRequired = raw?.required;
  if (agentRequired !== undefined && typeof agentRequired !== "boolean") {
    throw new Error("Invalid intelligence policy: required must be a boolean.");
  }
  return parseRequiredSetting(globalSetting) || agentRequired === true;
}

export function resolveRequiredRuntimeIntelligenceProfileSelection(
  agent: Pick<AgentConfig, "defaults">,
  globalSetting: string | undefined,
): RuntimeIntelligenceProfileSelection | undefined {
  const selection = readRuntimeIntelligenceProfileSelection(agent);
  const required = isRuntimeIntelligenceProxyRequired(agent, globalSetting);
  if (required && !selection) {
    throw new Error("The intelligence proxy is required, but this agent has no Hub intelligence profile selected.");
  }
  return required ? selection : undefined;
}

export function buildRuntimeIntelligencePolicyCompatibilityKey(
  selection: RuntimeIntelligenceProfileSelection,
  required: boolean,
): string {
  return `sha256:${stablePublicDigest(
    JSON.stringify({ profileId: selection.profileId, connectionIds: selection.connectionIds, required }),
  )}`;
}

export function assertRuntimeIntelligenceProxyCapability(
  runtimeCapabilities: RuntimeCapabilities,
  runtimeProvider: RuntimeProviderId,
): RuntimeIntelligenceProxyCapabilities {
  const capability = runtimeCapabilities.intelligenceProxy;
  if (!capability?.localSigningForwarder) {
    throw new Error(`Runtime provider ${runtimeProvider} does not support the required intelligence proxy.`);
  }
  if (capability.providerPrincipalIsolation === "none") {
    throw new Error(
      `Runtime provider ${runtimeProvider} cannot enable the intelligence proxy without an isolated provider principal.`,
    );
  }
  validateEndpointPath(capability.transport.endpointPath);
  validateBasePath(capability.transport.basePath);
  return capability;
}

export function buildRuntimeIntelligenceProxyBinding(options: {
  selection: RuntimeIntelligenceProfileSelection;
  grant: RuntimeIntelligenceHubGrant;
  forwarder: RuntimeIntelligenceLocalForwarder;
  runtimeCapabilities: RuntimeCapabilities;
  runtimeProvider: RuntimeProviderId;
  model: string;
  proxyRequired?: boolean;
  now?: number;
}): RuntimeIntelligenceProxyBinding {
  const { grant, runtimeProvider, selection } = options;
  const capability = assertRuntimeIntelligenceProxyCapability(options.runtimeCapabilities, runtimeProvider);
  validateGrant(grant, options.now ?? Date.now());
  if (grant.runtimeProvider !== runtimeProvider) {
    throw new Error("identityd returned an intelligence grant for a different runtime provider.");
  }
  if (grant.profileId !== selection.profileId || !selection.connectionIds.includes(grant.connectionId)) {
    throw new Error("identityd returned an intelligence grant outside the requested profile preferences.");
  }
  if (grant.model !== options.model) {
    throw new Error("identityd returned an intelligence grant for a different model.");
  }
  const proxyOrigin = parseProxyOrigin(grant.proxyOrigin);
  const localForwarderOrigin = parseLocalForwarderOrigin(options.forwarder);
  const localSigningForwarderBaseUrl = `${localForwarderOrigin}${capability.transport.basePath}`;
  return {
    version: 1,
    grantId: grant.grantId,
    attemptId: grant.attemptId,
    grantExpiresAt: grant.expiresAt,
    runtimeId: grant.runtimeId,
    profileId: grant.profileId,
    connectionId: grant.connectionId,
    connectionRevision: grant.connectionRevision,
    sessionCompatibilityKey: grant.sessionCompatibilityKey,
    policyCompatibilityKey: buildRuntimeIntelligencePolicyCompatibilityKey(selection, options.proxyRequired ?? true),
    runtimeProvider,
    upstreamProvider: grant.upstreamProvider,
    model: grant.model,
    protocol: capability.transport.protocol,
    localSigningForwarderBaseUrl,
    localSigningForwarderRequestPath: capability.transport.endpointPath,
    bindingHandle: readPublicId(options.forwarder.bindingHandle, "intelligence forwarder bindingHandle"),
    audience: grant.audience,
    providerRuntimeId: `ravi-hub-${stablePublicDigest(
      [grant.runtimeId, grant.connectionId, runtimeProvider, grant.model, proxyOrigin].join("\u0000"),
    )}`,
    providerPrincipalIsolation: capability.providerPrincipalIsolation as Exclude<
      RuntimeIntelligencePrincipalIsolation,
      "none"
    >,
  };
}

export function buildRuntimeIntelligenceAttemptBinding(
  binding: RuntimeIntelligenceProxyBinding,
  sessionKey: string,
): RuntimeCredentialAttemptBinding {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        runtimeId: binding.runtimeId,
        connectionId: binding.connectionId,
        connectionRevision: binding.connectionRevision,
        sessionCompatibilityKey: binding.sessionCompatibilityKey,
        policyCompatibilityKey: binding.policyCompatibilityKey,
        runtimeProvider: binding.runtimeProvider,
        model: binding.model,
        forwarderIdentity: binding.bindingHandle,
        audience: binding.audience,
        protocol: binding.protocol,
        requestPath: binding.localSigningForwarderRequestPath,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    attemptId: binding.attemptId,
    credentialId: binding.connectionId,
    connectionId: binding.connectionId,
    profileId: binding.profileId,
    intelligenceGrantId: binding.grantId,
    intelligenceRuntimeId: binding.runtimeId,
    intelligenceSessionKey: sessionKey,
    intelligenceConnectionRevision: binding.connectionRevision,
    intelligencePolicyCompatibilityKey: binding.policyCompatibilityKey,
    intelligenceGrantExpiresAt: binding.grantExpiresAt,
    intelligenceAttemptTerminal: false,
    label: `Hub connection ${binding.connectionId}`,
    fingerprint: `sha256:${fingerprint}`,
    runtimeProvider: binding.runtimeProvider,
    upstreamProvider: binding.upstreamProvider,
    authMethod: "hub-proxy",
    sessionCompatibilityKey: binding.sessionCompatibilityKey,
    resolvedEnv: {},
    sensitiveEnvKeys: [],
    remoteForwardEnvKeys: [],
    bindings: [],
  };
}

export function serializeRuntimeIntelligenceProxyBinding(binding: RuntimeIntelligenceProxyBinding) {
  return { ...binding };
}

/** Fields that must remain stable for the lifetime of one physical provider process/session. */
export function isRuntimeIntelligencePhysicalBindingCompatible(
  current: RuntimeIntelligenceProxyBinding,
  next: RuntimeIntelligenceProxyBinding,
): boolean {
  return (
    current.runtimeId === next.runtimeId &&
    current.profileId === next.profileId &&
    current.connectionId === next.connectionId &&
    current.connectionRevision === next.connectionRevision &&
    current.sessionCompatibilityKey === next.sessionCompatibilityKey &&
    current.policyCompatibilityKey === next.policyCompatibilityKey &&
    current.runtimeProvider === next.runtimeProvider &&
    current.upstreamProvider === next.upstreamProvider &&
    current.model === next.model &&
    current.protocol === next.protocol &&
    current.localSigningForwarderBaseUrl === next.localSigningForwarderBaseUrl &&
    current.localSigningForwarderRequestPath === next.localSigningForwarderRequestPath &&
    current.bindingHandle === next.bindingHandle &&
    current.audience === next.audience &&
    current.providerRuntimeId === next.providerRuntimeId &&
    current.providerPrincipalIsolation === next.providerPrincipalIsolation
  );
}

export function resolveRuntimeIntelligenceProviderModel(binding: RuntimeIntelligenceProxyBinding): string {
  const prefix = `${binding.upstreamProvider}/`;
  return binding.model.startsWith(prefix) ? binding.model.slice(prefix.length) : binding.model;
}

function readIntelligenceDefaults(agent: Pick<AgentConfig, "defaults">): Record<string, unknown> | undefined {
  const raw = agent.defaults?.intelligence;
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error("Invalid intelligence profile: expected an object.");
  return raw;
}

function validateGrant(grant: RuntimeIntelligenceHubGrant, now: number): void {
  if (grant.version !== 1) throw new Error("identityd returned an unsupported intelligence grant.");
  for (const [label, value] of [
    ["grantId", grant.grantId],
    ["attemptId", grant.attemptId],
    ["runtimeId", grant.runtimeId],
    ["profileId", grant.profileId],
    ["connectionId", grant.connectionId],
    ["connectionRevision", grant.connectionRevision],
    ["sessionCompatibilityKey", grant.sessionCompatibilityKey],
    ["upstreamProvider", grant.upstreamProvider],
    ["audience", grant.audience],
  ] as const) {
    readPublicId(value, `intelligence grant ${label}`);
  }
  if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now + 5_000 || grant.expiresAt > now + 24 * 60 * 60_000) {
    throw new Error("identityd returned an expired or unbounded intelligence grant.");
  }
}

function validateEndpointPath(value: string): void {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(value) || value.includes("//")) {
    throw new Error("Runtime intelligence proxy endpointPath must be an absolute path without a query or fragment.");
  }
}

function validateBasePath(value: string): void {
  if (value === "") return;
  validateEndpointPath(value);
  if (value.endsWith("/")) throw new Error("Runtime intelligence proxy basePath must not end with a slash.");
}

function parseProxyOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("identityd returned an invalid intelligence proxy origin.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("identityd returned an invalid intelligence proxy origin.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("The intelligence proxy origin must use HTTPS (HTTP is allowed only for loopback).");
  }
  return url.origin;
}

function parseLocalForwarderOrigin(forwarder: RuntimeIntelligenceLocalForwarder): string {
  if (forwarder.scheme !== "identityd-signing-forwarder-v1" || forwarder.verified !== true) {
    throw new Error("identityd returned an unattested intelligence signing forwarder.");
  }
  let url: URL;
  try {
    url = new URL(forwarder.origin);
  } catch {
    throw new Error("identityd returned an invalid intelligence signing forwarder origin.");
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
    throw new Error("The intelligence signing forwarder must be an explicit 127.0.0.1 HTTP origin.");
  }
  return url.origin;
}

function parseRequiredSetting(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "" || value.trim() === "false") return false;
  if (value.trim() === "true") return true;
  throw new Error(`${INTELLIGENCE_PROXY_REQUIRED_SETTING} must be true or false.`);
}

function readPublicId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be a non-secret public identifier.`);
  }
  return normalized;
}

function stablePublicDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
