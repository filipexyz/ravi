import { resolveLibrarySessionPlugins } from "../library/session-plugins.js";
import { isOperatorOwnTurn } from "../library/turn.js";
import { discoverPlugins } from "../plugins/index.js";
import type { AgentConfig, SessionEntry } from "../router/index.js";
import { createRuntimeHostServices } from "./host-services.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeModelBrokerBinding } from "./model-broker.js";
import type { SkillGatePersistedListener } from "./skill-gate.js";
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
  session?: SessionEntry;
  modelBroker?: RuntimeModelBrokerBinding;
  /** Observes skill-gate deliveries persisted in-process (Claude/Pi authorize path). */
  onSkillGatePersisted?: SkillGatePersistedListener;
}

export interface RuntimeProviderBootstrap {
  hostServices: RuntimeHostServices;
  providerBootstrap?: RuntimePrepareSessionResult;
  runtimePlugins: RuntimePlugin[];
  /**
   * Codex skill names of pinned Library skills this session must not load
   * (pinned to other agents, or not marked `externalAllowed` in a turn that
   * is not the operator's own). Spec skills/library.
   */
  hiddenSkills: string[];
}

export async function prepareRuntimeProviderBootstrap(
  options: RuntimeProviderBootstrapOptions,
): Promise<RuntimeProviderBootstrap> {
  const session = options.session;
  const hostServices = createRuntimeHostServices({
    context: options.context,
    agentId: options.agent.id,
    sessionName: options.sessionName,
    resolvedSource: options.resolvedSource,
    approvalSource: options.approvalSource,
    toolContext: options.toolContext,
    onSkillGatePersisted:
      session || options.onSkillGatePersisted
        ? (skillVisibility, info) => {
            if (session) {
              session.runtimeSessionParams = { ...(session.runtimeSessionParams ?? {}), skillVisibility };
            }
            options.onSkillGatePersisted?.(skillVisibility, info);
          }
        : undefined,
  });
  // Pinned Library skills (spec skills/library): the agent's own generated
  // plugin, or for Codex's shared skills dir the installation's, with the
  // skills that are not this session's hidden. Chosen from this first turn;
  // later turns may be someone else's, so host services check every load of
  // a pinned skill against the turn asking for it.
  const library = resolveLibrarySessionPlugins({
    agentId: options.agent.id,
    sharedSkillsDir: options.runtimeCapabilities.skillVisibility.availability === "codex-skills",
    isOperatorOwnTurn: () =>
      isOperatorOwnTurn({ turn: { runtimeContext: { present: true, record: options.context ?? null } } }),
  });
  const discoveredPlugins = [...discoverPlugins(), ...library.plugins];
  const providerBootstrap = await options.runtimeProvider.prepareSession?.({
    agentId: options.agent.id,
    cwd: options.sessionCwd,
    ...(discoveredPlugins.length > 0 ? { plugins: discoveredPlugins } : {}),
    hostServices,
    ...(options.modelBroker ? { modelBroker: options.modelBroker } : {}),
  });
  const runtimePlugins =
    options.runtimeCapabilities.supportsPlugins ||
    options.runtimeCapabilities.skillVisibility.availability === "provider"
      ? discoveredPlugins
      : [];

  return {
    hostServices,
    ...(providerBootstrap ? { providerBootstrap } : {}),
    runtimePlugins,
    hiddenSkills: library.hiddenSkills,
  };
}
