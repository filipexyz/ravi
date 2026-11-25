import { createRemoteSpawn } from "../remote-spawn.js";
import { createNatsRemoteSpawn } from "../remote-spawn-nats.js";
import type { AgentConfig } from "../router/index.js";
import { createSpecServer, SPEC_MCP_SERVER_NAME } from "../spec/server.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createRuntimeHostHooks } from "./host-hooks.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeCapabilities, RuntimeHookMatcher } from "./types.js";

export interface RuntimeHostAttachmentsOptions {
  runtimeCapabilities: RuntimeCapabilities;
  agent: AgentConfig;
  sessionName: string;
  sessionCwd: string;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
  streamingSession: Pick<RuntimeHostStreamingSession, "currentCrashRecoveryAttemptId" | "currentTurnToolStarted">;
  crashRecovery: Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety">;
}

export interface RuntimeHostAttachments {
  /**
   * The in-process MCP servers of this session, keyed by the name the provider
   * registers them under. The tool gate exempts exactly these keys, so the
   * provider must register this record as it is.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  hooks?: Record<string, RuntimeHookMatcher[]>;
  remoteSpawn?: unknown;
}

export function buildRuntimeHostAttachments(options: RuntimeHostAttachmentsOptions): RuntimeHostAttachments {
  const attachSpec = options.runtimeCapabilities.supportsMcpServers && options.agent.specMode;
  const mcpServers: Record<string, Record<string, unknown>> = attachSpec
    ? { [SPEC_MCP_SERVER_NAME]: createSpecServer(options.sessionName, options.sessionCwd) }
    : {};
  const remoteSpawn =
    options.runtimeCapabilities.supportsRemoteSpawn && options.agent.remote
      ? options.agent.remote.startsWith("worker:")
        ? createNatsRemoteSpawn(options.agent.remote.slice("worker:".length))
        : createRemoteSpawn(options.agent.remote, options.agent.remoteUser)
      : undefined;
  const hooks = createRuntimeHostHooks({
    runtimeCapabilities: options.runtimeCapabilities,
    agent: options.agent,
    sessionName: options.sessionName,
    sessionCwd: options.sessionCwd,
    resolvedSource: options.resolvedSource,
    approvalSource: options.approvalSource,
    streamingSession: options.streamingSession,
    crashRecovery: options.crashRecovery,
    hostMcpServers: Object.keys(mcpServers),
  });

  return {
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(remoteSpawn ? { remoteSpawn } : {}),
  };
}
