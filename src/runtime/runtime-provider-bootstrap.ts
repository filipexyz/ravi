import { join } from "node:path";
import { discoverSkillSourcePlugins } from "../plugins/index.js";
import { dbUpdateContextRuntimeState } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";
import type { AgentConfig, SessionEntry } from "../router/index.js";
import { createRuntimeHostServices } from "./host-services.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeModelBrokerBinding } from "./model-broker.js";
import {
  assertPreparedSkillExposure,
  assertSkillExposureContract,
  SkillPolicyChangedError,
} from "./skill-exposure-contract.js";
import { prepareSnapshotForProvider } from "./skill-exposure-preparation.js";
import { materializeSkillSnapshot } from "./skill-materialization.js";
import { skillPolicyHash, type SkillPolicySnapshot } from "./skill-policy.js";
import {
  buildSkillPolicyContextBinding,
  normalizeRuntimeSkillToolSurface,
  resolveManagedSkillPolicyForContext,
  resolveRuntimeSkillPolicy,
} from "./skill-policy-runtime.js";
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
  executionId?: string;
  sourcePlugins?: readonly RuntimePlugin[];
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
  toolContext: Record<string, unknown>;
  context: Parameters<typeof createRuntimeHostServices>[0]["context"];
  session?: SessionEntry;
  modelBroker?: RuntimeModelBrokerBinding;
}

export interface RuntimeProviderBootstrap {
  hostServices: RuntimeHostServices;
  providerBootstrap?: RuntimePrepareSessionResult;
  runtimePlugins: RuntimePlugin[];
  skillPolicy: SkillPolicySnapshot;
  skillNativeNames: Readonly<Record<string, string>>;
  verifySkillPolicy: () => Promise<void>;
  verifySkillPolicyAtDispatch: () => void;
  refreshSkillPolicy: () => Promise<void>;
}

export async function prepareRuntimeProviderBootstrap(
  options: RuntimeProviderBootstrapOptions,
): Promise<RuntimeProviderBootstrap> {
  assertSkillExposureContract(options.runtimeProvider);
  const initialToolSurface = skillPolicyHash(normalizeRuntimeSkillToolSurface(options.runtimeCapabilities));
  const sourcePlugins = options.sourcePlugins ?? discoverSkillSourcePlugins();
  const skillPolicy = bindCurrentSkillPolicyContext(options, sourcePlugins);
  const session = options.session;
  const hostServices = createRuntimeHostServices({
    context: options.context,
    agentId: options.agent.id,
    sessionName: options.sessionName,
    resolvedSource: options.resolvedSource,
    approvalSource: options.approvalSource,
    toolContext: options.toolContext,
    onSkillGatePersisted: session
      ? (skillVisibility) => {
          session.runtimeSessionParams = { ...(session.runtimeSessionParams ?? {}), skillVisibility };
        }
      : undefined,
  });
  const materializationRoot = join(getRaviStateDir(), "runtime", "skill-snapshots");
  const prepared = await prepareSnapshotForProvider({
    provider: options.runtimeProvider,
    snapshot: skillPolicy,
    cwd: options.sessionCwd,
    materializationRoot,
    hostServices,
    ...(options.modelBroker ? { modelBroker: options.modelBroker } : {}),
  });
  const verifySkillPolicyAtDispatch = () => {
    const currentContract = assertSkillExposureContract(options.runtimeProvider);
    assertPreparedSkillExposure(skillPolicy, currentContract, prepared.providerBootstrap.skillExposure);
    const currentToolSurface = normalizeRuntimeSkillToolSurface(options.runtimeProvider.getCapabilities());
    if (skillPolicyHash(currentToolSurface) !== initialToolSurface) throw new SkillPolicyChangedError();
    const current = resolveManagedSkillPolicyForContext(options.context);
    if (current.id !== skillPolicy.id) throw new SkillPolicyChangedError();
    materializeSkillSnapshot(current, materializationRoot);
  };
  const verifySkillPolicy = async () => {
    verifySkillPolicyAtDispatch();
  };
  const refreshSkillPolicy = async () => {
    const current = bindCurrentSkillPolicyContext(options, sourcePlugins);
    if (current.id !== skillPolicy.id) throw new SkillPolicyChangedError();
    await verifySkillPolicy();
  };

  return {
    hostServices,
    providerBootstrap: prepared.providerBootstrap,
    runtimePlugins: prepared.materialization.plugins,
    skillPolicy,
    skillNativeNames: prepared.materialization.nativeNames,
    verifySkillPolicy,
    verifySkillPolicyAtDispatch,
    refreshSkillPolicy,
  };
}

function bindCurrentSkillPolicyContext(
  options: RuntimeProviderBootstrapOptions,
  sourcePlugins: readonly RuntimePlugin[],
): SkillPolicySnapshot {
  const scope = {
    agentId: options.agent.id,
    executionId: options.executionId ?? options.sessionName,
    contextKey: options.context.contextKey,
  };
  const binding = buildSkillPolicyContextBinding({
    scope,
    cwd: options.sessionCwd,
    runtimeCapabilities: options.runtimeCapabilities,
    plugins: sourcePlugins,
  });
  const boundContext = dbUpdateContextRuntimeState(options.context.contextId, {
    sessionName: options.context.sessionName,
    source: options.context.source,
    metadata: { ...options.context.metadata, skillPolicyBinding: binding },
  });
  Object.assign(options.context, boundContext);
  return resolveRuntimeSkillPolicy({
    ...scope,
    cwd: options.sessionCwd,
    context: options.context,
    plugins: sourcePlugins,
    runtimeCapabilities: options.runtimeCapabilities,
  });
}
