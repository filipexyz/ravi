import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import { createPiRuntimeProvider } from "./pi-provider.js";
import type {
  RuntimeCompatibilityIssue,
  RuntimeCompatibilityRequest,
  RuntimeProvider,
  RuntimeProviderId,
  SessionRuntimeProvider,
} from "./types.js";

type RuntimeProviderFactory = () => SessionRuntimeProvider;

export const DEFAULT_RUNTIME_PROVIDER_ID: RuntimeProviderId = "claude";

const runtimeProviderFactories = new Map<RuntimeProviderId, RuntimeProviderFactory>([
  [DEFAULT_RUNTIME_PROVIDER_ID, createClaudeRuntimeProvider],
  ["codex", createCodexRuntimeProvider],
  ["pi", createPiRuntimeProvider],
]);

const builtInRuntimeProviderIds = new Set<RuntimeProviderId>([DEFAULT_RUNTIME_PROVIDER_ID, "codex", "pi"]);

export function registerRuntimeProvider(providerId: RuntimeProviderId, factory: RuntimeProviderFactory): void {
  runtimeProviderFactories.set(providerId, factory);
}

export function unregisterRuntimeProvider(providerId: RuntimeProviderId): void {
  if (builtInRuntimeProviderIds.has(providerId)) {
    throw new Error(`Cannot unregister built-in runtime provider '${providerId}'`);
  }
  runtimeProviderFactories.delete(providerId);
}

export function listRegisteredRuntimeProviderIds(): RuntimeProviderId[] {
  return [...runtimeProviderFactories.keys()];
}

export function createRuntimeProvider(
  providerId: RuntimeProviderId = DEFAULT_RUNTIME_PROVIDER_ID,
): SessionRuntimeProvider {
  const factory = runtimeProviderFactories.get(providerId);
  if (!factory) {
    throw new Error(`Unknown runtime provider '${providerId}'`);
  }
  return factory();
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
