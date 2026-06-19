import type {
  WorkObject,
  WorkObjectActionInput,
  WorkObjectActionResult,
  WorkObjectAdapter,
  WorkObjectAdapterResult,
  WorkObjectExternalRef,
  WorkObjectRequestContext,
  WorkObjectResolveInput,
  WorkObjectSuggestionInput,
  WorkObjectSuggestionOption,
  WorkObjectUpdatePatch,
  WorkObjectUpdateResult,
} from "./types.js";

export class WorkObjectAdapterRegistry {
  private readonly adapters: WorkObjectAdapter[];

  constructor(adapters: WorkObjectAdapter[] = []) {
    this.adapters = [...adapters];
  }

  add(adapter: WorkObjectAdapter): void {
    this.adapters.push(adapter);
  }

  list(): readonly WorkObjectAdapter[] {
    return this.adapters;
  }

  async resolveWorkObject(
    input: WorkObjectResolveInput,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectAdapterResult<WorkObject> | undefined> {
    for (const adapter of this.selectAdapters(input, context)) {
      const object = await adapter.resolveWorkObject(input, context);
      if (object) return { providerId: adapter.id, result: object };
    }
    return undefined;
  }

  async updateWorkObject(
    ref: WorkObjectExternalRef,
    patch: WorkObjectUpdatePatch,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectAdapterResult<WorkObjectUpdateResult> | undefined> {
    for (const adapter of this.selectAdapters({ externalRef: ref }, context)) {
      if (!adapter.updateWorkObject) continue;
      const result = await adapter.updateWorkObject(ref, patch, context);
      if (result) return { providerId: adapter.id, result };
    }
    return undefined;
  }

  async executeWorkObjectAction(
    ref: WorkObjectExternalRef,
    action: WorkObjectActionInput,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectAdapterResult<WorkObjectActionResult> | undefined> {
    for (const adapter of this.selectAdapters({ externalRef: ref }, context)) {
      if (!adapter.executeWorkObjectAction) continue;
      const result = await adapter.executeWorkObjectAction(ref, action, context);
      if (result) return { providerId: adapter.id, result };
    }
    return undefined;
  }

  async suggestWorkObjectOptions(
    ref: WorkObjectExternalRef,
    suggestion: WorkObjectSuggestionInput,
    context: WorkObjectRequestContext,
  ): Promise<WorkObjectAdapterResult<WorkObjectSuggestionOption[]> | undefined> {
    for (const adapter of this.selectAdapters({ externalRef: ref }, context)) {
      if (!adapter.suggestWorkObjectOptions) continue;
      const result = await adapter.suggestWorkObjectOptions(ref, suggestion, context);
      if (result) return { providerId: adapter.id, result };
    }
    return undefined;
  }

  private selectAdapters(input: WorkObjectResolveInput, context: WorkObjectRequestContext): WorkObjectAdapter[] {
    return this.adapters.filter((adapter) => adapter.canResolve?.(input, context) ?? true);
  }
}
