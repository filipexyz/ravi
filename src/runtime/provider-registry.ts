import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import { createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import { kimiCodeRuntimeExtensions } from "./kimi-code-runtime-extension.js";
import { createPiRuntimeProvider } from "./pi-provider.js";
import type {
  RuntimeCompatibilityIssue,
  RuntimeCompatibilityRequest,
  RuntimeProvider,
  RuntimeProviderId,
  RuntimeSessionState,
  SessionRuntimeProvider,
} from "./types.js";

type RuntimeProviderFactory = () => SessionRuntimeProvider;

export type RuntimeProviderAvailability = { available: true } | { available: false; reason: string };

export interface RuntimeProviderSessionLifecycleStrategy {
  createDeleteStateCleanup(session: RuntimeSessionState): {
    operation: "delete_state";
    locator: unknown;
  } | null;
  shouldRetirePersistedState?(previousSession: RuntimeSessionState, nextSession: RuntimeSessionState): boolean;
  retirePersistedState?(
    previousSession: RuntimeSessionState,
    nextSession: RuntimeSessionState,
    env?: NodeJS.ProcessEnv,
  ): Promise<void>;
}

export interface RuntimeProviderRegistrationOptions {
  availability?(env: Readonly<Record<string, string | undefined>>): RuntimeProviderAvailability;
  sessionLifecycle?: RuntimeProviderSessionLifecycleStrategy;
}

interface RuntimeProviderRegistration extends RuntimeProviderRegistrationOptions {
  factory: RuntimeProviderFactory;
}

export const DEFAULT_RUNTIME_PROVIDER_ID: RuntimeProviderId = "codex";

const runtimeProviderRegistrations = new Map<RuntimeProviderId, RuntimeProviderRegistration>([
  ["claude", { factory: createClaudeRuntimeProvider }],
  ["codex", { factory: createCodexRuntimeProvider }],
  ["kimi-code", { factory: createKimiCodeRuntimeProvider, ...kimiCodeRuntimeExtensions }],
  ["pi", { factory: createPiRuntimeProvider }],
]);

const builtInRuntimeProviderIds = new Set<RuntimeProviderId>(["claude", "codex", "kimi-code", "pi"]);

export function registerRuntimeProvider(
  providerId: RuntimeProviderId,
  factory: RuntimeProviderFactory,
  options: RuntimeProviderRegistrationOptions = {},
): void {
  runtimeProviderRegistrations.set(providerId, { factory, ...options });
}

export function unregisterRuntimeProvider(providerId: RuntimeProviderId): void {
  if (builtInRuntimeProviderIds.has(providerId)) {
    throw new Error(`Cannot unregister built-in runtime provider '${providerId}'`);
  }
  runtimeProviderRegistrations.delete(providerId);
}

export function listRegisteredRuntimeProviderIds(): RuntimeProviderId[] {
  return [...runtimeProviderRegistrations.keys()];
}

export function createRuntimeProvider(
  providerId: RuntimeProviderId = DEFAULT_RUNTIME_PROVIDER_ID,
): SessionRuntimeProvider {
  const registration = runtimeProviderRegistrations.get(providerId);
  if (!registration) {
    throw new Error(`Unknown runtime provider '${providerId}'`);
  }
  return registration.factory();
}

export function resolveRuntimeProviderAvailability(
  providerId: RuntimeProviderId,
  env: Readonly<Record<string, string | undefined>>,
): RuntimeProviderAvailability {
  return runtimeProviderRegistrations.get(providerId)?.availability?.(env) ?? { available: true };
}

export function resolveRuntimeProviderSessionLifecycle(
  session: RuntimeSessionState | null | undefined,
): RuntimeProviderSessionLifecycleStrategy | undefined {
  const providerId = session?.params?.provider;
  if (typeof providerId !== "string") return undefined;
  return resolveRuntimeProviderSessionLifecycleById(providerId);
}

export function resolveRuntimeProviderSessionLifecycleById(
  providerId: RuntimeProviderId | null | undefined,
): RuntimeProviderSessionLifecycleStrategy | undefined {
  return providerId ? runtimeProviderRegistrations.get(providerId)?.sessionLifecycle : undefined;
}

export function getRuntimeCompatibilityIssues(
  provider: RuntimeProvider | RuntimeProviderId,
  request: RuntimeCompatibilityRequest,
): RuntimeCompatibilityIssue[] {
  const runtimeProvider = typeof provider === "string" ? createRuntimeProvider(provider) : provider;
  const capabilities = runtimeProvider.getCapabilities();
  const issues: RuntimeCompatibilityIssue[] = [];

  if (request.requiresMcpServers && !capabilities.supportsMcpServers) {
    issues.push({
      code: "mcp_servers_unsupported",
      message: `Runtime provider '${runtimeProvider.id}' does not support spec mode sessions`,
    });
  }

  if (request.requiresRemoteSpawn && !capabilities.supportsRemoteSpawn) {
    issues.push({
      code: "remote_spawn_unsupported",
      message: `Runtime provider '${runtimeProvider.id}' does not support remote execution`,
    });
  }

  const toolPermissionMode =
    capabilities.tools?.permissionMode ?? (capabilities.supportsToolHooks ? "ravi-host" : "provider-native");
  if (request.toolAccessMode === "restricted" && toolPermissionMode !== "ravi-host") {
    issues.push({
      code: "restricted_tool_access_unsupported",
      message:
        `Runtime provider '${runtimeProvider.id}' requires full tool and executable access ` +
        "because Ravi permission hooks are unsupported",
    });
  }

  return issues;
}

export function assertRuntimeCompatibility(
  provider: RuntimeProvider | RuntimeProviderId,
  request: RuntimeCompatibilityRequest,
): void {
  const issues = getRuntimeCompatibilityIssues(provider, request);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join("; "));
  }
}
