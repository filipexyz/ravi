import { createOmieHostAction } from "./adapter.js";
import { test, expect } from "bun:test";
import type { ContextRecord } from "../../router/router-db.js";
import { verifiedCaller, type IdentityStore } from "./identity.js";
import { SCOPE } from "./access.js";
import {
  currentMember,
  redactValues,
  nativeRuntime,
  runConvitOmieHost,
  scopedMessage,
  scopedPlatform,
} from "./native.js";
import { explainCredentialPolicy } from "../../credentials/broker.js";

function fixture() {
  const root: ContextRecord = {
    contextId: "root",
    contextKey: "synthetic-root",
    kind: "turn-runtime",
    agentId: SCOPE.executor,
    sessionKey: "synthetic-session",
    createdAt: 1,
    capabilities: [],
    source: { channel: "slack", accountId: SCOPE.account, chatId: SCOPE.channel, canonicalChatId: SCOPE.canonicalChat },
    metadata: {
      authorityResolver: "agent-identity-v1",
      actorResolution: "resolved",
      actorPrincipal: "contact:person",
      turnProvenance: { origin: "human" },
      actor: {
        actorType: "contact",
        contactId: "person",
        platformIdentityId: "pi-synthetic",
        sourceMessageId: "123.456",
      },
    },
  };
  const child: ContextRecord = {
    ...root,
    contextId: "child",
    contextKey: "synthetic-child",
    kind: "app-runtime",
    metadata: { parentContextId: "root", appId: SCOPE.app, source: "app-router", issuedFor: `app:${SCOPE.app}` },
  };
  const contexts = new Map([
    [root.contextId, root],
    [child.contextId, child],
  ]);
  const platform = {
    id: "pi-synthetic",
    ownerType: "contact",
    ownerId: "person",
    channel: "slack",
    instanceId: SCOPE.account as string,
    platformUserId: "USYNTHETIC1",
  };
  const store: IdentityStore = {
    canonicalInstance: (id) => id,
    current: () => child,
    live: (id) => contexts.get(id) ?? null,
    chat: (id) =>
      ({
        id,
        channel: "slack",
        instanceId: SCOPE.account,
        platformChatId: id === SCOPE.canonicalChat ? SCOPE.channel : `${SCOPE.channel}#123.400`,
        chatType: id === SCOPE.canonicalChat ? "group" : "thread",
        rawProvenance: { threadTs: id === SCOPE.canonicalChat ? null : "123.400" },
      }) as any,
    message: (chatId, messageId) =>
      ({
        actorType: "contact",
        channel: "slack",
        instanceId: SCOPE.account,
        chatId,
        providerMessageId: messageId,
        rawChatId: SCOPE.channel,
        rawProvenance: { senderKind: "user" },
        contactId: "person",
        platformIdentityId: "pi-synthetic",
        rawSenderId: "USYNTHETIC1",
      }) as any,
    platform: () => platform as any,
    contactActive: () => true,
  };
  return { root, child, contexts, store, platform };
}
test("child resolves verified human through live ancestry and persisted inbound", () => {
  const f = fixture();
  expect(verifiedCaller(f.store)).toMatchObject({
    contextId: "child",
    actor: { id: "person", slackUserId: "USYNTHETIC1" },
  });
});
test("Slack thread retains authenticated parent channel", () => {
  const f = fixture();
  f.root.source!.threadId = "123.400";
  f.root.source!.canonicalChatId = "chat-synthetic-thread";
  expect(verifiedCaller(f.store).source.rootChannel).toBe(SCOPE.channel);
});
for (const defect of [
  "relay",
  "forged-child",
  "revoked",
  "missing-message",
  "wrong-contact",
  "other-channel",
  "other-account",
  "disabled-contact",
  "cycle",
  "different-source",
  "operator",
  "untrusted-root",
  "other-app",
  "fake-thread",
] as const) {
  test(`refuses ${defect} before any provider request`, () => {
    const f = fixture();
    if (defect === "relay") f.root.metadata!.turnProvenance = { origin: "agent" };
    if (defect === "forged-child") {
      f.root.metadata!.actorPrincipal = "agent:relay";
      f.child.metadata!.actorPrincipal = "contact:person";
    }
    if (defect === "revoked") f.contexts.delete("root");
    if (defect === "missing-message") f.store.message = () => null;
    if (defect === "wrong-contact") f.platform.ownerId = "someone-else";
    if (defect === "other-channel") f.root.source!.chatId = "COTHER";
    if (defect === "other-account") f.platform.instanceId = "other";
    if (defect === "disabled-contact") f.store.contactActive = () => false;
    if (defect === "cycle") f.root.metadata!.parentContextId = "child";
    if (defect === "different-source") f.child.source = { ...f.root.source!, threadId: "forged" };
    if (defect === "operator") f.root.kind = "admin-bootstrap";
    if (defect === "other-app") f.child.metadata!.appId = "other";
    if (defect === "fake-thread")
      f.store.chat = () =>
        ({
          channel: "slack",
          instanceId: SCOPE.account,
          platformChatId: "COTHER#123.400",
          chatType: "thread",
          rawProvenance: { threadTs: "123.400" },
        }) as any;
    if (defect === "untrusted-root") f.root.metadata!.authorityResolver = "cli";
    expect(() => verifiedCaller(f.store)).toThrow();
  });
}
test("membership paginates and does not reuse a previous allow after removal", async () => {
  let member = true;
  const client = {
    conversationsMembers: async ({ cursor }: any) =>
      cursor
        ? { members: member ? ["USYNTHETIC1"] : [], response_metadata: {} }
        : { members: ["UOTHER"], response_metadata: { next_cursor: "next" } },
  };
  expect(await currentMember(client, "USYNTHETIC1")).toBe(true);
  member = false;
  expect(await currentMember(client, "USYNTHETIC1")).toBe(false);
});
test("membership malformed result, repeated cursor and Slack failure fail closed", async () => {
  expect(await currentMember({ conversationsMembers: async () => ({ members: "invalid" }) }, "USYNTHETIC1")).toBe(
    false,
  );
  expect(
    await currentMember(
      { conversationsMembers: async () => ({ members: [], response_metadata: { next_cursor: "loop" } }) },
      "USYNTHETIC1",
    ),
  ).toBe(false);
  await expect(
    currentMember(
      {
        conversationsMembers: async () => {
          throw new Error("unavailable");
        },
      },
      "USYNTHETIC1",
    ),
  ).rejects.toThrow();
});
test("credential policy recognizes only pinned provider reads", () => {
  for (const action of [
    "produtos/pedido:ListarPedidos",
    "produtos/pedido:ConsultarPedido",
    "produtos/pedido:StatusPedido",
    "produtos/etapafat:ListarEtapasFaturamento",
  ]) {
    expect(explainCredentialPolicy({ provider: "omie", connection: "fixture", action }).approval.required).toBe(false);
    expect(explainCredentialPolicy({ provider: "other", connection: "fixture", action }).approval.required).toBe(true);
  }
  expect(
    explainCredentialPolicy({ provider: "omie", connection: "fixture", action: "produtos/pedido:ExcluirPedido" })
      .approval.required,
  ).toBe(true);
});
test("provider echoes cannot expose credential values under arbitrary keys", () => {
  const out = redactValues(
    { app_key: "synthetic-key", echo: "prefix synthetic-key suffix", nested: ["synthetic-secret"] },
    ["synthetic-key", "synthetic-secret"],
  );
  expect(JSON.stringify(out)).not.toContain("synthetic-");
  expect(out).not.toHaveProperty("app_key");
});

test("source root with reply thread and source thread with root reply are both authenticated by their actual chat", () => {
  const rootReply = fixture();
  rootReply.root.source!.threadId = "999.111";
  expect(verifiedCaller(rootReply.store).actor.id).toBe("person");
  const threadReply = fixture();
  threadReply.root.source!.canonicalChatId = "chat-synthetic-thread";
  expect(verifiedCaller(threadReply.store).actor.id).toBe("person");
});
for (const change of [
  "none",
  "removed",
  "root-revoked",
  "permission-revoked",
  "connection-disabled",
  "late-credential-revoked",
  "late-provider-revoked",
] as const) {
  test(`native adapter revalidates all boundaries: ${change}`, async () => {
    const f = fixture();
    let resolving = false,
      permitted = true,
      secrets = 0,
      requests = 0;
    const record: any = {
      provider: "omie",
      connection: "convit-pedidos",
      status: "active",
      secretRef: "synthetic-ref",
      updatedAt: 1,
    };
    const runtime = nativeRuntime("produtos/pedido:ListarPedidos", {
      identities: f.store,
      allowed: (_permission, type, id) => {
        if (secrets && !permitted) {
          if (change === "late-credential-revoked") return !(type === "credential" && id === "omie:convit-pedidos");
          if (change === "late-provider-revoked") return type !== "omie";
        }
        return permitted;
      },
      slack: async () => ({
        conversationsMembers: async () => {
          if (resolving && change === "root-revoked") f.contexts.delete("root");
          if (resolving && change === "permission-revoked") permitted = false;
          if (secrets && change.startsWith("late-")) permitted = false;
          return { members: resolving && change === "removed" ? [] : ["USYNTHETIC1"] };
        },
      }),
      resolve: async (input) => {
        resolving = true;
        await input.beforeResolve?.();
        secrets++;
        if (change === "connection-disabled") record.status = "disabled";
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
        return Response.json({ pagina: 1, total_de_paginas: 1, echo: "synthetic-secret" });
      }) as unknown as typeof fetch,
    });
    const action = createOmieHostAction(runtime, {
      once: async () => {
        throw new Error("Reads must not open/use ledger");
      },
    });
    if (change === "none") {
      const result = await action("produtos/pedido:ListarPedidos", { params: {} });
      expect(result.success).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect(requests).toBe(1);
      expect(secrets).toBe(1);
    } else {
      const rejected = action("produtos/pedido:ListarPedidos", { params: {} });
      if (change.startsWith("late-") || change === "permission-revoked")
        await expect(rejected).rejects.toMatchObject({ code: "OMIE_OPERATION_DENIED" });
      else if (change === "connection-disabled")
        await expect(rejected).rejects.toMatchObject({ code: "OMIE_CONNECTION_CHANGED" });
      else await expect(rejected).rejects.toThrow();
      expect(requests).toBe(0);
      expect(secrets).toBe(change === "connection-disabled" || change.startsWith("late-") ? 1 : 0);
    }
  });
}
test("native entrypoint rejects writes and cross-app calls before opening any authority or store", async () => {
  await expect(runConvitOmieHost(SCOPE.app, "write", [])).rejects.toMatchObject({ code: "OMIE_READ_ONLY_HOST" });
  await expect(runConvitOmieHost("other", "read", [])).rejects.toMatchObject({ code: "OMIE_HOST_INPUT_INVALID" });
  expect(() => nativeRuntime("produtos/pedido:ExcluirPedido")).toThrow("apenas consultas");
});

test("native store looks up messages in the persisted chat instance, not the account slug", () => {
  let lookedUp: any;
  scopedMessage(
    "chat-thread",
    "123.456",
    (() => ({ instanceId: "synthetic-uuid" })) as any,
    ((query: any) => {
      lookedUp = query;
      return null;
    }) as any,
  );
  expect(lookedUp).toEqual({
    channel: "slack",
    instanceId: "synthetic-uuid",
    chatId: "chat-thread",
    providerMessageId: "123.456",
  });
});
test("native identity lookup supports only configured aliases and rejects conflicting owners", () => {
  const config: any = {
    instances: { [SCOPE.account]: { instanceId: "synthetic-uuid" } },
    instanceToAccount: { "synthetic-uuid": SCOPE.account },
  };
  const scopes: string[] = [];
  const identity = scopedPlatform("USYNTHETIC1", config, (({ instanceId }: any) => {
    scopes.push(instanceId);
    return instanceId === "synthetic-uuid" ? { ownerType: "contact", ownerId: "person", instanceId } : null;
  }) as any);
  expect(identity?.instanceId).toBe("synthetic-uuid");
  expect(scopes).not.toContain("");
  expect(
    scopedPlatform("USYNTHETIC1", config, (({ instanceId }: any) => ({
      ownerType: "contact",
      ownerId: instanceId,
    })) as any),
  ).toBeNull();
});
