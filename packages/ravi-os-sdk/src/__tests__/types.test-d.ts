/**
 * Type-level tests for `@ravi-os/sdk`.
 *
 * Bun runs `*.test-d.ts` like any other test file; we use compile-time `Expect`
 * assertions to pin the public type surface. Anything that breaks the typed
 * contract (parameter shape, return type, options bag) fails to compile.
 */

import { describe, expect, it } from "bun:test";
import type {
  ChannelRuntimeCommandClient,
  ChannelRuntimeEventSink,
  KnownChannelRuntimeEvent,
} from "../channel-runtime-events.js";
import type { ExternalChannelTarget } from "../channel-backend.js";
import type { RaviClient } from "../client.js";
import type {
  ArtifactsShowReturn,
  ChatsEnsureReturn,
  ChatsMessagesCreateReturn,
  ChannelsBackendIngressInput,
  ChannelsBackendIngressReturn,
  ChannelsBackendRuntimeInterruptInput,
  ChannelsBackendRuntimeInterruptReturn,
  ChannelsBackendRuntimeReadbackInput,
  ChannelsBackendRuntimeReadbackReturn,
  ContextCredentialsListReturn,
} from "../types.js";

type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type ExpectTrue<T extends true> = T;
type ExpectFalse<T extends false> = T;

declare const client: RaviClient;
type _ChannelRuntimeClientCompatible = ExpectTrue<RaviClient extends ChannelRuntimeCommandClient ? true : false>;
type _ChannelRuntimeSinkParamsCompatible = ExpectTrue<
  Eq<
    Parameters<ChannelRuntimeEventSink["emit"]>,
    [event: KnownChannelRuntimeEvent, target?: ExternalChannelTarget]
  >
>;

// `client.artifacts.show(id)` — single positional string, return Promise<ArtifactsShowReturn>.
type ArtifactsShowFn = typeof client.artifacts.show;
type ArtifactsShowParams = Parameters<ArtifactsShowFn>;
type ArtifactsShowResult = Awaited<ReturnType<ArtifactsShowFn>>;

type _ShowParamsOk = ExpectTrue<Eq<ArtifactsShowParams, [id: string]>>;
type _ShowReturnOk = ExpectTrue<Eq<ArtifactsShowResult, ArtifactsShowReturn>>;

// Canonical chat/message writes keep their idempotency keys positional and
// expose the required persisted message state in the generated return type.
type ChatsEnsureFn = typeof client.chats.ensure;
type ChatsEnsureParams = Parameters<ChatsEnsureFn>;
type ChatsEnsureResult = Awaited<ReturnType<ChatsEnsureFn>>;
type ChatsMessageCreateFn = typeof client.chats.messages.create;
type ChatsMessageCreateParams = Parameters<ChatsMessageCreateFn>;
type ChatsMessageCreateResult = Awaited<ReturnType<ChatsMessageCreateFn>>;

type _ChatsEnsureParamsOk = ExpectTrue<
  Eq<ChatsEnsureParams, [actorId: string, agentId: string, clientRequestId: string]>
>;
type _ChatsEnsureReturnOk = ExpectTrue<Eq<ChatsEnsureResult, ChatsEnsureReturn>>;
type _ChatsMessageCreateParamsOk = ExpectTrue<
  Eq<
    ChatsMessageCreateParams,
    [chatId: string, actorId: string, clientMessageId: string, content: string]
  >
>;
type _ChatsMessageCreateReturnOk = ExpectTrue<Eq<ChatsMessageCreateResult, ChatsMessagesCreateReturn>>;
type _ChatsMessageStateRequired = ExpectTrue<Eq<ChatsMessagesCreateReturn["message"]["state"], "created">>;
type _ChatsMessageRevisionRequired = ExpectTrue<Eq<ChatsMessagesCreateReturn["message"]["revision"], 1>>;

// Generic channel backends authorize against a concrete local agent while
// keeping the complete ingress request as a typed second argument.
type ChannelBackendIngressFn = typeof client.channels.backend.ingress;
type ChannelBackendIngressParams = Parameters<ChannelBackendIngressFn>;
type ChannelBackendIngressResult = Awaited<ReturnType<ChannelBackendIngressFn>>;

type _ChannelBackendIngressParamsOk = ExpectTrue<
  Eq<
    ChannelBackendIngressParams,
    [agentId: string, request: ChannelsBackendIngressInput["request"]]
  >
>;
type _ChannelBackendIngressReturnOk = ExpectTrue<
  Eq<ChannelBackendIngressResult, ChannelsBackendIngressReturn>
>;

type ChannelBackendRuntimeInterruptFn = typeof client.channels.backend.runtime.interrupt;
type ChannelBackendRuntimeInterruptParams = Parameters<ChannelBackendRuntimeInterruptFn>;
type ChannelBackendRuntimeInterruptResult = Awaited<ReturnType<ChannelBackendRuntimeInterruptFn>>;
type ChannelBackendRuntimeReadbackFn = typeof client.channels.backend.runtime.readback;
type ChannelBackendRuntimeReadbackParams = Parameters<ChannelBackendRuntimeReadbackFn>;
type ChannelBackendRuntimeReadbackResult = Awaited<ReturnType<ChannelBackendRuntimeReadbackFn>>;

type _ChannelBackendRuntimeInterruptParamsOk = ExpectTrue<
  Eq<
    ChannelBackendRuntimeInterruptParams,
    [agentId: string, request: ChannelsBackendRuntimeInterruptInput["request"]]
  >
>;
type _ChannelBackendRuntimeInterruptReturnOk = ExpectTrue<
  Eq<ChannelBackendRuntimeInterruptResult, ChannelsBackendRuntimeInterruptReturn>
>;
type _ChannelBackendRuntimeReadbackParamsOk = ExpectTrue<
  Eq<
    ChannelBackendRuntimeReadbackParams,
    [agentId: string, request: ChannelsBackendRuntimeReadbackInput["request"]]
  >
>;
type _ChannelBackendRuntimeReadbackReturnOk = ExpectTrue<
  Eq<ChannelBackendRuntimeReadbackResult, ChannelsBackendRuntimeReadbackReturn>
>;

// `client.context.credentials.list()` — no required args; return is `unknown`
// because the underlying command does not declare `@Returns`.
type ListFn = typeof client.context.credentials.list;
type ListParams = Parameters<ListFn>;
type ListResult = Awaited<ReturnType<ListFn>>;

type _ListReturnOk = ExpectTrue<Eq<ListResult, ContextCredentialsListReturn>>;
type _ListReturnIsUnknown = ExpectTrue<Eq<ContextCredentialsListReturn, unknown>>;
type _ListParamsOk = ExpectFalse<Eq<ListParams, [string]>>;

describe("types.test-d", () => {
  it("compiles the typed surface", () => {
    // The Expect* aliases above run at compile time — this test only ensures
    // the file is loaded by bun (no runtime assertions needed).
    expect(true).toBe(true);
  });
});

// Mark unused type aliases as referenced so `noUnusedLocals` doesn't bark.
// The aliases assert at compile time; the runtime body just touches the names.
const _typeRef: { kind: "type-only" } = { kind: "type-only" };
void _typeRef;
type _Touched =
  | _ShowParamsOk
  | _ShowReturnOk
  | _ChatsEnsureParamsOk
  | _ChatsEnsureReturnOk
  | _ChatsMessageCreateParamsOk
  | _ChatsMessageCreateReturnOk
  | _ChatsMessageStateRequired
  | _ChatsMessageRevisionRequired
  | _ChannelBackendIngressParamsOk
  | _ChannelBackendIngressReturnOk
  | _ChannelRuntimeClientCompatible
  | _ChannelRuntimeSinkParamsCompatible
  | _ChannelBackendRuntimeInterruptParamsOk
  | _ChannelBackendRuntimeInterruptReturnOk
  | _ChannelBackendRuntimeReadbackParamsOk
  | _ChannelBackendRuntimeReadbackReturnOk
  | _ListReturnOk
  | _ListReturnIsUnknown
  | _ListParamsOk;
export type { _Touched };
