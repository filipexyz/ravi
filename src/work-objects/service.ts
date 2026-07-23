import { randomUUID } from "node:crypto";
import { WorkObjectAdapterRegistry } from "./registry.js";
import { createTaskWorkObjectAdapter } from "./adapters/tasks.js";
import type {
  WorkObject,
  WorkObjectActionInput,
  WorkObjectActionResult,
  WorkObjectAdapterResult,
  WorkObjectExternalRef,
  WorkObjectRequestContext,
  WorkObjectResolveInput,
  WorkObjectSuggestionInput,
  WorkObjectSuggestionOption,
  WorkObjectUpdatePatch,
  WorkObjectUpdateResult,
} from "./types.js";

let defaultRegistry: WorkObjectAdapterRegistry | null = null;

export function createDefaultWorkObjectRegistry(): WorkObjectAdapterRegistry {
  return new WorkObjectAdapterRegistry([createTaskWorkObjectAdapter()]);
}

export function getDefaultWorkObjectRegistry(): WorkObjectAdapterRegistry {
  if (!defaultRegistry) defaultRegistry = createDefaultWorkObjectRegistry();
  return defaultRegistry;
}

export function setDefaultWorkObjectRegistryForTests(registry: WorkObjectAdapterRegistry | null): void {
  defaultRegistry = registry;
}

export function createWorkObjectRequestContext(
  input: Partial<WorkObjectRequestContext> = {},
): WorkObjectRequestContext {
  const instanceId = input.instanceId ?? input.channel?.instanceId ?? "local";
  return {
    requestId: input.requestId ?? `wo_${randomUUID()}`,
    instanceId,
    channel: {
      channel: input.channel?.channel ?? "local",
      instanceId,
      ...(input.channel?.teamId ? { teamId: input.channel.teamId } : {}),
      ...(input.channel?.channelId ? { channelId: input.channel.channelId } : {}),
      ...(input.channel?.messageTs ? { messageTs: input.channel.messageTs } : {}),
      ...(input.channel?.threadTs ? { threadTs: input.channel.threadTs } : {}),
      ...(input.channel?.triggerId ? { triggerId: input.channel.triggerId } : {}),
      ...(input.channel?.raw ? { raw: input.channel.raw } : {}),
    },
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export async function resolveWorkObject(
  input: WorkObjectResolveInput,
  context: WorkObjectRequestContext = createWorkObjectRequestContext(),
): Promise<WorkObjectAdapterResult<WorkObject> | undefined> {
  return getDefaultWorkObjectRegistry().resolveWorkObject(input, context);
}

export async function updateWorkObject(
  ref: WorkObjectExternalRef,
  patch: WorkObjectUpdatePatch,
  context: WorkObjectRequestContext = createWorkObjectRequestContext(),
): Promise<WorkObjectAdapterResult<WorkObjectUpdateResult> | undefined> {
  return getDefaultWorkObjectRegistry().updateWorkObject(ref, patch, context);
}

export async function executeWorkObjectAction(
  ref: WorkObjectExternalRef,
  action: WorkObjectActionInput,
  context: WorkObjectRequestContext = createWorkObjectRequestContext(),
): Promise<WorkObjectAdapterResult<WorkObjectActionResult> | undefined> {
  return getDefaultWorkObjectRegistry().executeWorkObjectAction(ref, action, context);
}

export async function suggestWorkObjectOptions(
  ref: WorkObjectExternalRef,
  suggestion: WorkObjectSuggestionInput,
  context: WorkObjectRequestContext = createWorkObjectRequestContext(),
): Promise<WorkObjectAdapterResult<WorkObjectSuggestionOption[]> | undefined> {
  return getDefaultWorkObjectRegistry().suggestWorkObjectOptions(ref, suggestion, context);
}
