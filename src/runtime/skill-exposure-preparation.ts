import type { SkillMaterialization } from "./skill-materialization.js";
import { materializeSkillSnapshot } from "./skill-materialization.js";
import { assertPreparedSkillExposure, assertSkillExposureContract } from "./skill-exposure-contract.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimeHostServices, RuntimePrepareSessionResult, SessionRuntimeProvider } from "./types.js";
import type { RuntimeModelBrokerBinding } from "./model-broker.js";

export type SkillExposurePreparationOptions = {
  readonly provider: SessionRuntimeProvider;
  readonly snapshot: SkillPolicySnapshot;
  readonly cwd: string;
  readonly materializationRoot: string;
  readonly hostServices?: RuntimeHostServices;
  readonly modelBroker?: RuntimeModelBrokerBinding;
};

export type SkillExposurePreparation = {
  readonly materialization: SkillMaterialization;
  readonly providerBootstrap: RuntimePrepareSessionResult;
};

export async function prepareSnapshotForProvider(
  options: SkillExposurePreparationOptions,
): Promise<SkillExposurePreparation> {
  const capabilities = assertSkillExposureContract(options.provider);
  const mode = capabilities.modes[0];
  if (!mode || !options.provider.prepareSession) {
    throw new Error("Provider has no compatible skill exposure contract.");
  }
  const materialization = materializeSkillSnapshot(options.snapshot, options.materializationRoot);
  const providerBootstrap = await options.provider.prepareSession({
    agentId: options.snapshot.scope.agentId,
    cwd: options.cwd,
    skillPolicy: options.snapshot,
    skillExposureMode: mode,
    skillNativeNames: materialization.nativeNames,
    plugins: materialization.plugins,
    ...(options.hostServices ? { hostServices: options.hostServices } : {}),
    ...(options.modelBroker ? { modelBroker: options.modelBroker } : {}),
  });
  assertPreparedSkillExposure(options.snapshot, capabilities, providerBootstrap.skillExposure);
  return { materialization, providerBootstrap };
}
