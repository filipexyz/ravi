import { randomUUID } from "node:crypto";
import type { ContextRecord } from "../../router/router-db.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeLocalAgentActionDescriptorSchema,
  NativeLocalAgentActionRequestSchema,
  NativeLocalAgentActionResultSchema,
  type NativeLocalAgentActionDescriptor,
  type NativeLocalAgentActionHandler,
  type NativeLocalAgentActionResult,
} from "./driver.js";

interface RegisteredNativeLocalAgentAction {
  readonly registrationId: string;
  readonly provider: string;
  readonly channelInstanceId: string;
  readonly descriptor: NativeLocalAgentActionDescriptor;
  readonly handler: NativeLocalAgentActionHandler;
}

export interface RegisterNativeLocalAgentActionInput {
  readonly provider: string;
  readonly channelInstanceId: string;
  readonly descriptor: NativeLocalAgentActionDescriptor;
  readonly handler: NativeLocalAgentActionHandler;
}

export interface NativeLocalAgentActionRegistrationScope {
  readonly provider: string;
  readonly channelInstanceId?: string;
  readonly accountId: string;
}

export class NativeLocalAgentActionRegistry {
  private readonly registrations = new Map<string, RegisteredNativeLocalAgentAction>();

  register(input: RegisterNativeLocalAgentActionInput): () => void {
    const descriptor = NativeLocalAgentActionDescriptorSchema.parse(input.descriptor);
    if (typeof input.handler !== "function") {
      throw new TypeError("local agent action handler must be callable");
    }
    const registrationId = randomUUID();
    this.registrations.set(registrationId, {
      registrationId,
      provider: input.provider,
      channelInstanceId: input.channelInstanceId,
      descriptor,
      handler: input.handler,
    });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.registrations.delete(registrationId);
    };
  }

  list(context: ContextRecord): NativeLocalAgentActionDescriptor[] {
    const source = context.source;
    if (source === undefined || context.agentId === undefined || context.sessionName === undefined) {
      return [];
    }
    return this.listForSource({
      provider: source.channel,
      accountId: source.accountId,
    });
  }

  listForSource(scope: NativeLocalAgentActionRegistrationScope): NativeLocalAgentActionDescriptor[] {
    const grouped = new Map<string, RegisteredNativeLocalAgentAction[]>();
    for (const registration of this.matchingSource(scope)) {
      const entries = grouped.get(registration.descriptor.toolName) ?? [];
      entries.push(registration);
      grouped.set(registration.descriptor.toolName, entries);
    }
    return [...grouped.values()]
      .filter((entries) => entries.length === 1)
      .map(([entry]) => structuredClone(entry!.descriptor))
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
  }

  async invoke(input: {
    readonly context: ContextRecord;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly requestId?: string;
    readonly now?: () => string;
  }): Promise<NativeLocalAgentActionResult | undefined> {
    const agentId = input.context.agentId;
    const sessionName = input.context.sessionName;
    const source = input.context.source;
    if (agentId === undefined || sessionName === undefined || source === undefined) {
      return undefined;
    }
    const request = NativeLocalAgentActionRequestSchema.parse({
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      requestId: input.requestId ?? `action-${randomUUID()}`,
      toolName: input.toolName,
      arguments: input.arguments,
      agentId,
      sessionName,
      source: {
        channelKind: source.channel,
        accountId: source.accountId,
        conversationId: source.chatId,
        ...(source.threadId === undefined ? {} : { threadId: source.threadId }),
      },
      requestedAt: (input.now ?? (() => new Date().toISOString()))(),
    });
    return this.invokeRequest(request);
  }

  async invokeRequest(
    input: Parameters<NativeLocalAgentActionHandler>[0],
    scope: { readonly channelInstanceId?: string } = {},
  ): Promise<NativeLocalAgentActionResult | undefined> {
    const request = NativeLocalAgentActionRequestSchema.parse(input);
    const candidates = this.matchingSource({
      provider: request.source.channelKind,
      accountId: request.source.accountId,
      ...(scope.channelInstanceId === undefined ? {} : { channelInstanceId: scope.channelInstanceId }),
    }).filter(({ descriptor }) => descriptor.toolName === request.toolName);
    if (candidates.length !== 1) return undefined;
    const result = NativeLocalAgentActionResultSchema.parse(await candidates[0]!.handler(request));
    if (result.requestId !== request.requestId) {
      throw new Error("native_local_agent_action_request_mismatch");
    }
    return result;
  }

  clearForTests(): void {
    this.registrations.clear();
  }

  private matchingSource(scope: NativeLocalAgentActionRegistrationScope): RegisteredNativeLocalAgentAction[] {
    return [...this.registrations.values()].filter(
      ({ provider, channelInstanceId, descriptor }) =>
        provider === scope.provider &&
        (scope.channelInstanceId === undefined || channelInstanceId === scope.channelInstanceId) &&
        (descriptor.sourceAccountId === undefined || descriptor.sourceAccountId === scope.accountId),
    );
  }
}

export const nativeLocalAgentActions = new NativeLocalAgentActionRegistry();
