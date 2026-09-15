import { createHubModelBroker } from "./hub-model-broker.js";
import type { ModelBroker } from "./model-broker.js";

type ModelBrokerFactory = () => ModelBroker;

const modelBrokerFactories = new Map<string, ModelBrokerFactory>([["hub", createHubModelBroker]]);
const builtInModelBrokerIds = new Set(["hub"]);

export function registerModelBroker(brokerId: string, factory: ModelBrokerFactory): void {
  modelBrokerFactories.set(brokerId, factory);
}

export function unregisterModelBroker(brokerId: string): void {
  if (builtInModelBrokerIds.has(brokerId)) throw new Error(`Cannot unregister built-in model broker '${brokerId}'`);
  modelBrokerFactories.delete(brokerId);
}

export function listRegisteredModelBrokerIds(): string[] {
  return [...modelBrokerFactories.keys()];
}

export function createModelBroker(brokerId: string): ModelBroker {
  const factory = modelBrokerFactories.get(brokerId);
  if (!factory) throw new Error(`Unknown model broker '${brokerId}'`);
  return factory();
}
