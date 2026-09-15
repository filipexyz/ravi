/**
 * Orchestrates Hub-facing provider auth: write allowlisted env, then attach
 * a runtime credential pool entry (and optionally `agents.set provider`).
 */

import { getAgent, updateAgent } from "../router/config.js";
import { createRuntimeCredential, listRuntimeCredentials, serializeRuntimeCredential } from "./credential-store.js";
import type { RuntimeCredentialInput, RuntimeCredentialRecord } from "./credential-types.js";
import {
  type DeviceLoginDeps,
  type DeviceLoginProvider,
  type DeviceLoginSession,
  publicDeviceLogin,
  requireAuthorizedLogin,
} from "./provider-device-login.js";
import { setRaviEnvKey, type RaviEnvMutation } from "./ravi-env-file.js";

export type ProviderAuthAgentResult = {
  id: string;
  provider: string;
  changed: boolean;
};

type SerializedRuntimeCredential = ReturnType<typeof serializeRuntimeCredential>;

export type ClaudeConfigureResult = {
  env: RaviEnvMutation;
  credential: SerializedRuntimeCredential;
  credentialCreated: boolean;
  agents: ProviderAuthAgentResult[];
};

export type ProviderLoginCompleteResult = {
  login: DeviceLoginSession;
  credential: SerializedRuntimeCredential;
  credentialCreated: boolean;
  agents: ProviderAuthAgentResult[];
};

export function configureClaudeOAuth(input: {
  token: string;
  agents?: string[];
  setProvider?: boolean;
  label?: string;
  env?: NodeJS.ProcessEnv;
}): ClaudeConfigureResult {
  const token = input.token.trim();
  if (!token) throw new Error("Claude OAuth token must not be empty.");
  const env = setRaviEnvKey("CLAUDE_CODE_OAUTH_TOKEN", token, input.env ?? process.env);
  const agentIds = normalizeAgentIds(input.agents);
  const credential = upsertRuntimeCredential({
    label: input.label?.trim() || "claude-oauth",
    runtimeProvider: "claude",
    upstreamProvider: "anthropic",
    authMethod: "claude-oauth",
    sourceKind: "env",
    agentAllowlist: agentIds,
    bindings: [
      {
        sourceKind: "env",
        targetKind: "env",
        targetName: "CLAUDE_CODE_OAUTH_TOKEN",
        secretRef: "env:CLAUDE_CODE_OAUTH_TOKEN",
        sourceHint: "CLAUDE_CODE_OAUTH_TOKEN",
        sensitive: true,
        remoteForward: false,
      },
    ],
  });
  return {
    env,
    credential: serializeRuntimeCredential(credential.record, { includeBindings: true }),
    credentialCreated: credential.created,
    agents: maybeSetAgentProviders("claude", agentIds, input.setProvider === true),
  };
}

export function completeProviderLogin(
  provider: DeviceLoginProvider,
  loginId: string,
  input: {
    agents?: string[];
    setProvider?: boolean;
    label?: string;
  } = {},
  deps: DeviceLoginDeps = {},
): ProviderLoginCompleteResult {
  const login = requireAuthorizedLogin(loginId, deps);
  if (login.provider !== provider) {
    throw new Error(`Login ${loginId} belongs to ${login.provider}, not ${provider}.`);
  }
  const agentIds = normalizeAgentIds(input.agents);
  const credential =
    provider === "codex"
      ? upsertRuntimeCredential({
          label: input.label?.trim() || "codex-home",
          runtimeProvider: "codex",
          authMethod: "codex-profile",
          sourceKind: "provider-profile",
          authProfileRef: login.home,
          agentAllowlist: agentIds,
          notes: "provider-native profile imported after device login",
          bindings: [
            {
              sourceKind: "provider-profile",
              targetKind: "auth-profile",
              targetName: "profile",
              secretRef: `file:${login.home}`,
              sourceHint: login.home,
              sensitive: true,
              remoteForward: false,
            },
          ],
        })
      : upsertRuntimeCredential({
          label: input.label?.trim() || "grok-auth-profile",
          runtimeProvider: "grok",
          authMethod: "provider-profile",
          sourceKind: "provider-profile",
          authProfileRef: login.home,
          agentAllowlist: agentIds,
          notes: "provider-native profile imported after device login",
          bindings: [
            {
              sourceKind: "provider-profile",
              targetKind: "auth-profile",
              targetName: "profile",
              secretRef: `file:${login.home}`,
              sourceHint: login.home,
              sensitive: true,
              remoteForward: false,
            },
          ],
        });
  return {
    login: publicDeviceLogin(login),
    credential: serializeRuntimeCredential(credential.record, { includeBindings: true }),
    credentialCreated: credential.created,
    agents: maybeSetAgentProviders(provider, agentIds, input.setProvider === true),
  };
}

function upsertRuntimeCredential(input: RuntimeCredentialInput): {
  record: RuntimeCredentialRecord;
  created: boolean;
} {
  const existing = listRuntimeCredentials({
    runtimeProvider: input.runtimeProvider,
    includeDisabled: true,
    limit: 500,
  }).items.find(
    (credential) =>
      credential.label === input.label &&
      credential.authMethod === input.authMethod &&
      (input.authProfileRef
        ? credential.authProfileRef === input.authProfileRef
        : credential.sourceKind === input.sourceKind),
  );
  if (existing) return { record: existing, created: false };
  return { record: createRuntimeCredential(input), created: true };
}

function maybeSetAgentProviders(provider: string, agentIds: string[], enabled: boolean): ProviderAuthAgentResult[] {
  if (!enabled) return [];
  return agentIds.map((id) => {
    const agent = getAgent(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }
    const changed = agent.provider !== provider;
    if (changed) updateAgent(id, { provider });
    return { id, provider, changed };
  });
}

function normalizeAgentIds(agents: string[] | undefined): string[] {
  const ids = (agents ?? ["main"]).map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)] : ["main"];
}
