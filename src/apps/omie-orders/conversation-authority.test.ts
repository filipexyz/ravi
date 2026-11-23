import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextRecord } from "../../router/router-db.js";
import { createOmieHostAction } from "./adapter.js";
import {
  parseOmieCapability,
  registerOmieConversationAuthority,
  resolveOmieConversationAuthority,
  unregisterOmieConversationAuthority,
  type ConversationAuthority,
} from "./conversation-authority.js";
import { omieDelegation } from "./delegation.js";
import { verifiedCaller, type IdentityStore } from "./identity.js";
import { nativeRuntime } from "./native.js";
import { parseOmieScope, type OmieScope } from "./scope.js";
import { SCOPE as SLACK_SCOPE } from "./test-scope.js";

/** A second, made-up channel: if the executor worked only with Slack, these tests could not pass. */
const OTHER: OmieScope = Object.freeze({
  ...SLACK_SCOPE,
  channelType: "examplechat",
  account: "example-account",
  channel: "room-1",
  channelConnection: "example-room-connection",
});

function fakeAuthority(state: { channelOk: boolean; identityOk: boolean; member: boolean; calls: string[] }) {
  const authority: ConversationAuthority = {
    channelType: "examplechat",
    isValidConversation: (conversation) => /^room-\d+$/.test(conversation),
    verifyTurn: ({ scope, source, actor }) => {
      state.calls.push(`verify:${source.chatId}:${actor.sourceMessageId}`);
      if (!state.channelOk || source.chatId !== scope.channel) return { ok: false, reason: "channel" };
      if (!state.identityOk) return { ok: false, reason: "identity" };
      return { ok: true, platformUserId: "member-7" };
    },
    isCurrentMember: async ({ platformUserId }) => {
      state.calls.push(`member:${platformUserId}`);
      return state.member && platformUserId === "member-7";
    },
    capabilities: (scope) => [`use:credential:examplechat:${scope.channelConnection}`, "execute:examplechat:members"],
  };
  return authority;
}

function turn(
  scope: OmieScope,
  authority: ConversationAuthority,
): { store: IdentityStore; contexts: Map<string, ContextRecord> } {
  const source = { channel: scope.channelType, accountId: scope.account, chatId: scope.channel, canonicalChatId: "c1" };
  const root: ContextRecord = {
    contextId: "root",
    contextKey: "k-root",
    kind: "turn-runtime",
    agentId: scope.executor,
    sessionKey: "s",
    createdAt: 1,
    capabilities: [],
    source,
    metadata: {
      authorityResolver: "agent-identity-v1",
      actorResolution: "resolved",
      actorPrincipal: "contact:person",
      turnProvenance: { origin: "human" },
      actor: { actorType: "contact", contactId: "person", platformIdentityId: "pi-1", sourceMessageId: "m-1" },
    },
  };
  const child: ContextRecord = {
    ...root,
    contextId: "child",
    contextKey: "k-child",
    kind: "app-runtime",
    metadata: { parentContextId: "root", appId: scope.app, source: "app-router", issuedFor: `app:${scope.app}` },
  };
  const contexts = new Map([
    ["root", root],
    ["child", child],
  ]);
  return {
    contexts,
    store: {
      scope,
      authority,
      current: () => child,
      live: (id) => contexts.get(id) ?? null,
      contactActive: () => true,
    },
  };
}

afterEach(() => unregisterOmieConversationAuthority("examplechat"));

test("a turn from another registered channel type is verified by that channel's adapter", () => {
  const state = { channelOk: true, identityOk: true, member: true, calls: [] as string[] };
  const { store } = turn(OTHER, fakeAuthority(state));
  expect(verifiedCaller(store)).toMatchObject({
    source: { channel: "examplechat", account: OTHER.account, rootChannel: OTHER.channel },
    actor: { kind: "human", id: "person", platformUserId: "member-7" },
  });
  expect(state.calls).toEqual(["verify:room-1:m-1"]);
});

test("the adapter's channel and identity refusals keep their own codes", () => {
  const state = { channelOk: false, identityOk: true, member: true, calls: [] as string[] };
  expect(() => verifiedCaller(turn(OTHER, fakeAuthority(state)).store)).toThrow(
    expect.objectContaining({ code: "OMIE_CHANNEL_DENIED" }),
  );
  state.channelOk = true;
  state.identityOk = false;
  expect(() => verifiedCaller(turn(OTHER, fakeAuthority(state)).store)).toThrow(
    expect.objectContaining({ code: "OMIE_IDENTITY_REQUIRED" }),
  );
});

test("an adapter of another channel type cannot vouch for the configured one", () => {
  const state = { channelOk: true, identityOk: true, member: true, calls: [] as string[] };
  const { store } = turn(OTHER, fakeAuthority(state));
  expect(() => verifiedCaller({ ...store, scope: { ...OTHER, channelType: "slack" } })).toThrow(
    expect.objectContaining({ code: "OMIE_IDENTITY_REQUIRED" }),
  );
  expect(state.calls).toEqual([]);
});

test("a turn whose source is another channel type is refused before the adapter runs", () => {
  const state = { channelOk: true, identityOk: true, member: true, calls: [] as string[] };
  const { store, contexts } = turn(OTHER, fakeAuthority(state));
  for (const id of ["root", "child"]) contexts.get(id)!.source = { ...contexts.get(id)!.source!, channel: "slack" };
  expect(() => verifiedCaller(store)).toThrow(expect.objectContaining({ code: "OMIE_CHANNEL_DENIED" }));
  expect(state.calls).toEqual([]);
});

test("a configured channel type with no registered adapter fails closed everywhere", () => {
  expect(() => resolveOmieConversationAuthority("examplechat")).toThrow(
    expect.objectContaining({ code: "OMIE_CHANNEL_UNAVAILABLE" }),
  );
  expect(() => nativeRuntime("produtos/pedido:ListarPedidos", { scope: OTHER })).toThrow(
    expect.objectContaining({ code: "OMIE_CHANNEL_UNAVAILABLE" }),
  );
  expect(() => omieDelegation("omie-orders.list", undefined, [], [], OTHER)).toThrow(
    expect.objectContaining({ code: "OMIE_CHANNEL_UNAVAILABLE" }),
  );
});

test("a conversation id the adapter does not recognize is a configuration error", () => {
  registerOmieConversationAuthority(fakeAuthority({ channelOk: true, identityOk: true, member: true, calls: [] }));
  expect(() => nativeRuntime("produtos/pedido:ListarPedidos", { scope: { ...OTHER, channel: "CSLACKLIKE" } })).toThrow(
    expect.objectContaining({ code: "OMIE_HOST_CONFIG_REQUIRED" }),
  );
});

test("delegation and per-call requirements come from the configured channel's adapter", () => {
  registerOmieConversationAuthority(fakeAuthority({ channelOk: true, identityOk: true, member: true, calls: [] }));
  const read = [
    "execute:group:apps",
    "use:app:omie-orders",
    "read:omie:produtos.pedido.ListarPedidos",
    "use:credential:omie:example-orders",
    "execute:omie:produtos/pedido:ListarPedidos",
    "use:credential:examplechat:example-room-connection",
    "execute:examplechat:members",
  ];
  expect(
    omieDelegation("omie-orders.list", undefined, [], [...read, "execute:omie:produtos/pedido:ExcluirPedido"], OTHER),
  ).toEqual(read);
  expect(() => omieDelegation("omie-orders.list", undefined, [], read.slice(0, -1), OTHER)).toThrow("Manifesto");
  expect(parseOmieCapability("use:credential:examplechat:a:b")).toEqual(["use", "credential", "examplechat:a:b"]);
  expect(() => parseOmieCapability("use:credential")).toThrow();
});

test("a full read through another channel asks that channel for membership and its own capabilities", async () => {
  const state = { channelOk: true, identityOk: true, member: true, calls: [] as string[] };
  const authority = fakeAuthority(state);
  const { store } = turn(OTHER, authority);
  const asked: string[] = [];
  let requests = 0;
  const record: any = {
    provider: "omie",
    connection: OTHER.connection,
    status: "active",
    secretRef: "r",
    updatedAt: 1,
  };
  const run = (member: boolean) => {
    state.member = member;
    const runtime = nativeRuntime("produtos/pedido:ListarPedidos", {
      scope: OTHER,
      identities: store,
      contactOverlay: () => ({ active: false }) as any,
      allowed: (permission, type, id) => {
        asked.push(`${permission}:${type}:${id}`);
        return true;
      },
      resolve: async (input) => {
        await input.beforeResolve?.();
        return {
          connection: record,
          policy: {} as any,
          secret: JSON.stringify({
            app_key: "synthetic-key",
            app_secret: "synthetic-secret",
            app_hash: "synthetic-app",
          }),
        };
      },
      connection: () => record,
      fetch: (async () => {
        requests++;
        return Response.json({ pagina: 1, total_de_paginas: 1 });
      }) as unknown as typeof fetch,
    });
    return createOmieHostAction(runtime, {
      once: async () => {
        throw new Error("reads do not open the ledger");
      },
    })("produtos/pedido:ListarPedidos", { params: {} });
  };
  const ok = await run(true);
  expect(ok).toMatchObject({ success: true });
  expect(requests).toBe(1);
  expect(state.calls).toContain("member:member-7");
  expect(asked).toContain("use:credential:examplechat:example-room-connection");
  expect(asked).toContain("execute:examplechat:members");
  expect(asked.some((cap) => cap.includes("slack"))).toBe(false);
  await expect(run(false)).rejects.toMatchObject({ code: "OMIE_MEMBERSHIP_REQUIRED" });
  expect(requests).toBe(1);
});

test("legacy private configuration (no channelType, slackConnection) still loads as the Slack channel", () => {
  const { channelType: _type, channelConnection, ...rest } = SLACK_SCOPE;
  expect(parseOmieScope({ ...rest, slackConnection: channelConnection })).toEqual(SLACK_SCOPE);
  // Only the exact legacy shape is upgraded; mixing old and new keys is refused.
  expect(() => parseOmieScope({ ...SLACK_SCOPE, slackConnection: channelConnection })).toThrow();
  expect(() => parseOmieScope({ ...rest, slackConnection: channelConnection, extra: "x" })).toThrow();
  expect(() => parseOmieScope({ ...rest })).toThrow();
  expect(parseOmieScope(OTHER)).toEqual(OTHER);
});

test("the executor's own source never names a channel or imports a channel package", () => {
  const dir = import.meta.dir;
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.startsWith("test-")) continue;
    // The one file allowed to name the first channel is the scheduled legacy upgrade (see its header).
    if (name === "legacy-scope.ts") continue;
    const text = readFileSync(join(dir, name), "utf8");
    // Every module specifier: static and multi-line `from`, side-effect imports and dynamic import().
    const specifiers = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    if (specifiers.some((spec) => /(^|\/)channels\//.test(spec))) offenders.push(`${name}: imports a channel package`);
    if (/\bslack\b|\bwhatsapp\b|\btelegram\b|\bdiscord\b/i.test(text)) offenders.push(`${name}: names a channel`);
  }
  expect(offenders).toEqual([]);
});

test("access to apps run follows the caller's form: the run-specific capability is delegated and accepted", async () => {
  registerOmieConversationAuthority(fakeAuthority({ channelOk: true, identityOk: true, member: true, calls: [] }));
  const runOnly = [
    "mutate:apps:run",
    "use:app:omie-orders",
    "read:omie:produtos.pedido.ListarPedidos",
    "use:credential:omie:example-orders",
    "execute:omie:produtos/pedido:ListarPedidos",
    "use:credential:examplechat:example-room-connection",
    "execute:examplechat:members",
  ];
  expect(omieDelegation("omie-orders.list", undefined, [], runOnly, OTHER)).toEqual(runOnly);
  // Without any form of access to apps run, the delegation is missing an entry and fails closed.
  expect(() => omieDelegation("omie-orders.list", undefined, [], runOnly.slice(1), OTHER)).toThrow("Manifesto");
  const state = { channelOk: true, identityOk: true, member: true, calls: [] as string[] };
  const { store } = turn(OTHER, fakeAuthority(state));
  const runtime = (held: string) =>
    nativeRuntime("produtos/pedido:ListarPedidos", {
      scope: OTHER,
      identities: store,
      contactOverlay: () => ({ active: false }) as any,
      allowed: (permission, type, id) => {
        const cap = `${permission}:${type}:${id}`;
        return cap === held || !/^(mutate:apps|execute:group)/.test(cap);
      },
    });
  const identity = verifiedCaller(store);
  expect(await runtime("mutate:apps:run").canInvokeApp(identity, false)).toBe(true);
  expect(await runtime("execute:group:apps").canInvokeApp(identity, false)).toBe(true);
  expect(await runtime("none").canInvokeApp(identity, false)).toBe(false);
});

test("the executor's reads are declared to the broker without loading the executor", async () => {
  const { explainCredentialPolicy, registerProviderReadOnlyActions } = await import("../../credentials/broker.js");
  const { registerOmieProviderReads } = await import("./provider-reads.js");
  registerProviderReadOnlyActions("omie", []);
  const policy = (action: string) =>
    explainCredentialPolicy({ provider: "omie", connection: "x", action }).approval.required;
  expect(policy("geral/clientes:ListarClientes")).toBe(true);
  registerOmieProviderReads();
  for (const action of [
    "produtos/pedido:ListarPedidos",
    "produtos/pedido:ConsultarPedido",
    "produtos/pedido:StatusPedido",
    "produtos/etapafat:ListarEtapasFaturamento",
    "geral/clientes:ListarClientes",
    "geral/clientes:ConsultarCliente",
    "geral/produtos:ListarProdutos",
    "geral/produtos:ConsultarProduto",
  ])
    expect(policy(action)).toBe(false);
  expect(policy("produtos/pedido:ExcluirPedido")).toBe(true);
  expect(
    explainCredentialPolicy({ provider: "other", connection: "x", action: "geral/clientes:ListarClientes" }).approval
      .required,
  ).toBe(true);
});
