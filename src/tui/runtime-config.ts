import { publish } from "../nats.js";
import { updateAgent } from "../router/config.js";
import { updateSessionModelOverride } from "../router/sessions.js";
import type { RuntimeProviderId } from "../runtime/types.js";

export interface ApplyAgentRuntimeSelectionArgs {
  agentId: string;
  sessionKey: string;
  provider: RuntimeProviderId;
  model: string;
}

export interface RuntimeConfigDependencies {
  updateAgent: typeof updateAgent;
  updateSessionModelOverride: typeof updateSessionModelOverride;
  publish: typeof publish;
}

const defaultDependencies: RuntimeConfigDependencies = {
  updateAgent,
  updateSessionModelOverride,
  publish,
};

export async function applyAgentRuntimeSelection(
  args: ApplyAgentRuntimeSelectionArgs,
  deps: RuntimeConfigDependencies = defaultDependencies,
): Promise<void> {
  deps.updateAgent(args.agentId, { provider: args.provider, model: args.model });
  deps.updateSessionModelOverride(args.sessionKey, args.model);
  await deps.publish("ravi.config.changed", {});
}
