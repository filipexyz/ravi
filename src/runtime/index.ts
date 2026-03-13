export * from "./types.js";
export * from "./claude-provider.js";
export * from "./codex-provider.js";

import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import type {
  RuntimeCompatibilityIssue,
  RuntimeCompatibilityRequest,
  RuntimeProvider,
  RuntimeProviderId,
  SessionRuntimeProvider,
} from "./types.js";

export function createRuntimeProvider(providerId: RuntimeProviderId = "claude"): SessionRuntimeProvider {
  switch (providerId) {
    case "claude":
      return createClaudeRuntimeProvider();
    case "codex":
      return createCodexRuntimeProvider();
    default:
      throw new Error(`Unknown runtime provider '${providerId}'`);
  }
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

  if (request.toolAccessMode === "restricted" && !capabilities.supportsToolHooks) {
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
