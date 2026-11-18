import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { revision } from "./domain.js";
import { findOperation } from "./catalogue.js";
import { prepare } from "./provider.js";
import { authorizeChannel, SCOPE, type VerifiedIdentity } from "./access.js";
import { DurableLedger } from "./ledger.js";
import { createOmieHostAction, type ProtectedRuntime } from "./adapter.js";

import { parseProtectedOmieConnection } from "./connection.js";

const directories: string[] = [],
  stores: DurableLedger[] = [];
afterEach(() => {
  for (const s of stores.splice(0))
    try {
      s.close();
    } catch {}
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "convit-host-"));
  directories.push(dir);
  const path = join(dir, "ledger.sqlite");
  const store = new DurableLedger(path);
  stores.push(store);
  return { store, path };
}
function runtime() {
  const calls: any[] = [],
    saved: any[] = [];
  let member = true,
    intent = true;
  let identity: VerifiedIdentity = {
    verified: true,
    contextId: "synthetic-context",
    source: { channel: "slack", account: SCOPE.account, rootChannel: SCOPE.channel },
    actor: { kind: "human", id: "synthetic-human", slackUserId: "USYNTHETIC1" },
  };
  const host: ProtectedRuntime = {
    identity: async () => structuredClone(identity),
    isMember: async () => member,
    canInvokeApp: async () => true,
    hasSpecificWriteIntent: async () => intent,
    approvedServiceRead: async () => false,
    withActiveOmieConnection: async (_req, use) => use({ bearer: "synthetic-bearer" }),
    withPortalSession: async (_identity, use) => use({ Authorization: "Bearer synthetic-session" }),
    withRefreshPair: async (_identity, _app, use) =>
      use({ token: "synthetic-old", refresh_token: "synthetic-refresh" }),
    saveTokens: async (_identity, app, pair) => {
      saved.push({ app, pair });
    },
    applicationHash: async () => "synthetic-app",
    checkRevision: async () => {},
    fetch: (async (url: string, init: any) => {
      calls.push({ url, init });
      return Response.json(
        url.includes("/api/portal/")
          ? { token: "synthetic-new", refresh_token: "synthetic-new-refresh" }
          : { codigo_status: "0", pagina: 1, total_de_paginas: 1 },
      );
    }) as typeof fetch,
  };
  return {
    host,
    calls,
    saved,
    setIdentity: (i: VerifiedIdentity) => {
      identity = i;
    },
    getIdentity: () => structuredClone(identity),
    setMember: (x: boolean) => {
      member = x;
    },
    setIntent: (x: boolean) => {
      intent = x;
    },
  };
}
const read = findOperation("produtos/pedido:ListarPedidos");

test("verified channel member can read after native app authorization", async () => {
  const r = runtime(),
    l = ledger();
  const action = createOmieHostAction(r.host, l.store);
  expect((await action(read.id, { params: {} })).success).toBe(true);
  expect(r.calls).toHaveLength(1);
});
for (const bad of ["channel", "account", "unverified", "context", "member", "invocation"] as const)
  test(`access denied before credential/network: ${bad}`, async () => {
    const r = runtime(),
      l = ledger();
    const i = r.getIdentity();
    if (bad === "channel") i.source.rootChannel = "OTHER";
    if (bad === "account") i.source.account = "OTHER";
    if (bad === "unverified") (i as any).verified = false;
    if (bad === "context") i.contextId = "";
    if (bad === "member") r.setMember(false);
    if (bad === "invocation") r.host.canInvokeApp = async () => false;
    r.setIdentity(i);
    let credentials = 0;
    r.host.withActiveOmieConnection = async () => {
      credentials++;
      throw new Error();
    };
    await expect(createOmieHostAction(r.host, l.store)(read.id, { params: {} })).rejects.toThrow();
    expect(credentials).toBe(0);
    expect(r.calls).toHaveLength(0);
  });
test("user-provided source fields cannot override authenticated channel", async () => {
  const r = runtime(),
    l = ledger(),
    i = r.getIdentity();
  i.source.rootChannel = "OTHER";
  r.setIdentity(i);
  await expect(
    createOmieHostAction(r.host, l.store)(read.id, { params: { channel: SCOPE.channel, account: SCOPE.account } }),
  ).rejects.toMatchObject({ code: "OMIE_CHANNEL_DENIED" });
  expect(r.calls).toHaveLength(0);
});
test("full app access does not create a commercial write intent", async () => {
  const r = runtime(),
    l = ledger(),
    id = "produtos/pedido:AlterarPedidoVenda",
    params = { nCodPed: 123 };
  r.setIntent(false);
  const input = {
    params,
    confirmed: true,
    idempotencyKey: "synthetic:invoice:1",
    reviewDigest: prepare(id, { params }).digest,
  };
  await expect(createOmieHostAction(r.host, l.store)(id, input)).rejects.toMatchObject({
    code: "OMIE_SPECIFIC_WRITE_REQUIRED",
  });
  expect(r.calls).toHaveLength(0);
  expect(l.store.summary()).toEqual([]);
});
test("approved write is durably deduplicated and membership is rechecked on replay", async () => {
  const r = runtime(),
    l = ledger(),
    id = "produtos/pedido:AlterarPedidoVenda",
    params = { nCodPed: 123 };
  const action = createOmieHostAction(r.host, l.store);
  const input = {
    params,
    confirmed: true,
    idempotencyKey: "synthetic:invoice:1",
    reviewDigest: prepare(id, { params }).digest,
  };
  await action(id, input);
  await action(id, input);
  expect(r.calls).toHaveLength(1);
  r.setMember(false);
  await expect(action(id, input)).rejects.toMatchObject({ code: "OMIE_MEMBERSHIP_REQUIRED" });
  expect(r.calls).toHaveLength(1);
});
test("service identities require explicit read approval and cannot write", async () => {
  const r = runtime(),
    i = r.getIdentity();
  i.actor = { kind: "service", id: "synthetic-service" };
  r.setIdentity(i);
  await expect(authorizeChannel(r.host, read, "x")).rejects.toMatchObject({ code: "OMIE_SERVICE_ACTION_DENIED" });
  r.host.approvedServiceRead = async () => true;
  expect((await authorizeChannel(r.host, read, "x")).actor.kind).toBe("service");
  await expect(
    authorizeChannel(r.host, findOperation("produtos/pedido:AlterarPedidoVenda"), "x"),
  ).rejects.toMatchObject({ code: "OMIE_SERVICE_ACTION_DENIED" });
});
test("ledger persists completed results and strips secrets across restarts", async () => {
  const l = ledger(),
    key = "synthetic:key:1",
    digest = revision({ example: true });
  let n = 0;
  expect(
    await l.store.once<unknown>(key, digest, async () => {
      n++;
      return { success: true, token: "do-not-store", nested: { app_secret: "do-not-store" } };
    }),
  ).toEqual({ success: true, nested: {} });
  l.store.close();
  const reopened = new DurableLedger(l.path);
  stores.push(reopened);
  expect(
    await reopened.once(key, digest, async () => {
      n++;
      return {};
    }),
  ).toEqual({ success: true, nested: {} });
  expect(n).toBe(1);
  const db = new Database(l.path, { readonly: true });
  const row = db.query("SELECT result_json FROM omie_operations").get() as any;
  db.close();
  expect(row.result_json).not.toContain("do-not-store");
});
test("ledger rejects same key/different digest and never repeats unknown outcome", async () => {
  const l = ledger();
  let n = 0;
  const digest = revision({ amount: 1 });
  await expect(
    l.store.once("synthetic:key:1", digest, async () => {
      n++;
      throw new Error("sensitive-detail");
    }),
  ).rejects.toMatchObject({ code: "OMIE_OUTCOME_UNKNOWN" });
  await expect(
    l.store.once("synthetic:key:1", digest, async () => {
      n++;
      return {};
    }),
  ).rejects.toMatchObject({ code: "OMIE_OUTCOME_UNKNOWN" });
  await expect(
    l.store.once("synthetic:key:1", revision({ amount: 2 }), async () => {
      n++;
      return {};
    }),
  ).rejects.toMatchObject({ code: "OMIE_IDEMPOTENCY_CONFLICT" });
  expect(n).toBe(1);
});
test("in-flight duplicate cannot execute concurrently", async () => {
  const l = ledger();
  let release!: () => void,
    calls = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = l.store.once("synthetic:key:1", revision({ a: 1 }), async () => {
    calls++;
    await pending;
    return { ok: true };
  });
  await expect(
    l.store.once("synthetic:key:1", revision({ a: 1 }), async () => {
      calls++;
      return {};
    }),
  ).rejects.toMatchObject({ code: "OMIE_OUTCOME_UNKNOWN" });
  release();
  await first;
  expect(calls).toBe(1);
});

test("internal host failures are sanitized", async () => {
  const r = runtime(),
    l = ledger();
  r.host.identity = async () => {
    throw new Error("never-expose-secret-backend");
  };
  await expect(createOmieHostAction(r.host, l.store)(read.id, { params: {} })).rejects.toMatchObject({
    code: "OMIE_HOST_BOUNDARY_UNAVAILABLE",
  });
});
test("broker connection parser extracts only supported auth and trusted app scope", () => {
  const parsed = parseProtectedOmieConnection(
    JSON.stringify({
      app_key: "synthetic-key",
      app_secret: "synthetic-secret",
      app_hash: "synthetic-app",
      url: "https://not-allowed.invalid",
      action: "injected",
    }),
  );
  expect(parsed.applicationHash).toBe("synthetic-app");
  expect(Object.keys(parsed.auth)).toEqual(["app_key", "app_secret"]);
  expect(JSON.stringify(parsed)).not.toContain("not-allowed");
});
test("malformed protected connection never echoes the original secret", () => {
  try {
    parseProtectedOmieConnection("sensitive-non-json");
    throw new Error();
  } catch (e: any) {
    expect(e.code).toBe("OMIE_CONNECTION_FORMAT_INVALID");
    expect(e.message).not.toContain("sensitive-non-json");
  }
});
