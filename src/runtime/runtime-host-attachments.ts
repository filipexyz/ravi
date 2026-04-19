import { createRemoteSpawn } from "../remote-spawn.js";
import { createNatsRemoteSpawn } from "../remote-spawn-nats.js";
import type { AgentConfig } from "../router/index.js";
import { createSpecServer } from "../spec/server.js";
import { createRuntimeHostHooks } from "./host-hooks.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeCapabilities, RuntimeHookMatcher } from "./types.js";

export interface RuntimeHostAttachmentsOptions {
  runtimeCapabilities: RuntimeCapabilities;
  agent: AgentConfig;
  sessionName: string;
  sessionCwd: string;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
}

export interface RuntimeHostAttachments {
  specServer?: Record<string, unknown>;
  hooks?: Record<string, RuntimeHookMatcher[]>;
  remoteSpawn?: unknown;
}

export function buildRuntimeHostAttachments(options: RuntimeHostAttachmentsOptions): RuntimeHostAttachments {
  const specServer =
    options.runtimeCapabilities.supportsMcpServers && options.agent.specMode
      ? createSpecServer(options.sessionName, options.sessionCwd)
      : undefined;
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
  });

  return {
    ...(specServer ? { specServer } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(remoteSpawn ? { remoteSpawn } : {}),
  };
}
