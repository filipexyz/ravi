import { createRemoteSpawn } from "../remote-spawn.js";
import { createNatsRemoteSpawn } from "../remote-spawn-nats.js";
import type { AgentConfig } from "../router/index.js";
import { createClaudeGatewayFacades } from "../mcp/claude-facade.js";
import type { ContextRecord } from "../router/router-db.js";
import { createSpecServer, SPEC_MCP_SERVER_NAME } from "../spec/server.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createRuntimeHostHooks } from "./host-hooks.js";
import type { RuntimeHostStreamingSession, RuntimeMessageTarget } from "./host-session.js";
import type {
  RuntimeCapabilities,
  RuntimeGatewayMcpServers,
  RuntimeHookMatcher,
  RuntimeReportedMcpServers,
} from "./types.js";

export { HOST_MCP_SERVER_NAMES } from "./host-mcp-server-names.js";

export interface RuntimeHostAttachmentsOptions {
  runtimeCapabilities: RuntimeCapabilities;
  agent: AgentConfig;
  sessionName: string;
  sessionCwd: string;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
  streamingSession: Pick<
    RuntimeHostStreamingSession,
    "currentCrashRecoveryAttemptId" | "currentTurnToolStarted" | "externalApprovalWait"
  >;
  crashRecovery: Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety">;
  /**
   * The context record of the current turn, which the host refreshes in place
   * before each turn. With it, a runtime that supports MCP servers gets the
   * gateway facades of the registered servers attached to the agent.
   */
  getTurnContext?: () => ContextRecord | null | undefined;
  /** Called with the MCP servers the runtime reported loading. */
  onRuntimeReportedMcpServers?: (report: RuntimeReportedMcpServers) => void;
  /** Called with the gateway servers a turn left out because a host server holds their names. */
  onMcpNameOverlap?: (names: string[]) => void;
}

export interface RuntimeHostAttachments {
  /**
   * The in-process MCP servers of this session, keyed by the name the provider
   * registers them under. The tool gate exempts exactly these keys, so the
   * provider must register this record as it is.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  /**
   * The gateway facades (spec mcp, Claude Facade): forwarding servers rebuilt
   * per turn, never host servers. Their names go to the tool hook's gateway
   * list only, and never overlap the keys of `mcpServers`.
   */
  gatewayMcpServers?: RuntimeGatewayMcpServers;
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
  const hostMcpServers = Object.keys(mcpServers);
  const getTurnContext = options.getTurnContext;
  const gatewayMcpServers =
    options.runtimeCapabilities.supportsMcpServers && getTurnContext
      ? createClaudeGatewayFacades({
          agentId: options.agent.id,
          getContext: getTurnContext,
          hostMcpServers,
          onRuntimeReported: options.onRuntimeReportedMcpServers,
          ...(options.onMcpNameOverlap ? { onNameOverlap: options.onMcpNameOverlap } : {}),
          // A person answering a server's question holds the tool watchdog (spec mcp, Elicitation).
          getApprovalWait: () => options.streamingSession.externalApprovalWait,
        })
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
    hostMcpServers,
    // The facades of the current turn (spec mcp, Claude Facade). A name listed
    // here is checked by name, never exempt.
    gatewayMcpServers: gatewayMcpServers ? () => gatewayMcpServers.names() : [],
  });

  return {
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(gatewayMcpServers ? { gatewayMcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(remoteSpawn ? { remoteSpawn } : {}),
  };
}
