import { discoverPlugins } from "../plugins/index.js";
import type { AgentConfig } from "../router/index.js";
import { createRuntimeHostServices } from "./host-services.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type {
  RuntimeCapabilities,
  RuntimeHostServices,
  RuntimePlugin,
  RuntimePrepareSessionResult,
  SessionRuntimeProvider,
} from "./types.js";

export interface RuntimeProviderBootstrapOptions {
  runtimeProvider: SessionRuntimeProvider;
  runtimeCapabilities: RuntimeCapabilities;
  agent: AgentConfig;
  sessionName: string;
  sessionCwd: string;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
  toolContext: Record<string, unknown>;
  context: Parameters<typeof createRuntimeHostServices>[0]["context"];
}

export interface RuntimeProviderBootstrap {
  hostServices: RuntimeHostServices;
  providerBootstrap?: RuntimePrepareSessionResult;
  runtimePlugins: RuntimePlugin[];
}

export async function prepareRuntimeProviderBootstrap(
  options: RuntimeProviderBootstrapOptions,
): Promise<RuntimeProviderBootstrap> {
  const hostServices = createRuntimeHostServices({
    context: options.context,
    agentId: options.agent.id,
    sessionName: options.sessionName,
    resolvedSource: options.resolvedSource,
    approvalSource: options.approvalSource,
    toolContext: options.toolContext,
  });
  const discoveredPlugins = discoverPlugins();
  const providerBootstrap = await options.runtimeProvider.prepareSession?.({
    agentId: options.agent.id,
    cwd: options.sessionCwd,
    ...(discoveredPlugins.length > 0 ? { plugins: discoveredPlugins } : {}),
    hostServices,
  });
  const runtimePlugins = options.runtimeCapabilities.supportsPlugins ? discoveredPlugins : [];

  return {
    hostServices,
    ...(providerBootstrap ? { providerBootstrap } : {}),
    runtimePlugins,
  };
}
