import { SCOPE } from "./test-scope.js";
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogue, findOperation, publicResult } from "./catalogue.js";
import { omieDelegation } from "./delegation.js";
import { DurableLedger } from "./ledger.js";
import { createOmieHostAction, type ProtectedRuntime } from "./adapter.js";
import { nativeRuntime } from "./native.js";
import type { VerifiedIdentity } from "./access.js";

const CUSTOMER_AND_PRODUCT_READS = [
  "geral/clientes:ConsultarCliente",
  "geral/clientes:ListarClientes",
  "geral/produtos:ConsultarProduto",
  "geral/produtos:ListarProdutos",
];
const READS = [
  ...CUSTOMER_AND_PRODUCT_READS,
  "produtos/etapafat:ListarEtapasFaturamento",
  "produtos/pedido:ConsultarPedido",
  "produtos/pedido:ListarPedidos",
  "produtos/pedido:StatusPedido",
];

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
  const dir = mkdtempSync(join(tmpdir(), "omie-read-queries-"));
  directories.push(dir);
  const store = new DurableLedger(join(dir, "ledger.sqlite"));
  stores.push(store);
  return store;
}
function runtime(response: unknown = { pagina: 1, total_de_paginas: 1 }) {
  const calls: Array<{ url: string; body: any }> = [];
  let member = true;
  const identity: VerifiedIdentity = {
    verified: true,
    contextId: "synthetic-context",
    source: { channel: "slack", account: SCOPE.account, rootChannel: SCOPE.channel },
    actor: { kind: "human", id: "synthetic-human", platformUserId: "USYNTHETIC1" },
  };
  const host: ProtectedRuntime = {
    scope: SCOPE,
    identity: async () => structuredClone(identity),
    isMember: async () => member,
    canInvokeApp: async () => true,
    hasSpecificWriteIntent: async () => false,
    withActiveOmieConnection: async (_request, use) => use({ bearer: "synthetic-bearer" }),
    withPortalSession: async () => {
      throw new Error("unused");
    },
    withRefreshPair: async () => {
      throw new Error("unused");
    },
    saveTokens: async () => {},
    applicationHash: async () => "synthetic-app",
    checkRevision: async () => {},
    fetch: (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return Response.json(response);
    }) as typeof fetch,
  };
  return {
    host,
    calls,
    setMember: (x: boolean) => {
      member = x;
    },
  };
}
function delegated(id: string): string[] {
  const op = findOperation(id);
  return [
    "execute:group:apps",
    "use:app:omie-orders",
    op.permission,
    `use:credential:omie:${SCOPE.connection}`,
    `execute:omie:${op.id}`,
    `use:credential:slack:${SCOPE.channelConnection}`,
    "execute:slack:conversations.members",
  ];
}

test("the host reads exactly eight queries: orders, stages, customers and products", () => {
  const reads = catalogue
    .filter((op) => op.classification === "read")
    .map((op) => op.id)
    .sort();
  expect(reads).toEqual(READS);
  // Nothing of the customers/products modules can be written: those operations are not even catalogued.
  expect(catalogue.filter((op) => op.id.startsWith("geral/") && op.classification !== "read")).toEqual([]);
});

test("customer and product queries are reads with exact permission strings and a fixed endpoint", () => {
  for (const id of CUSTOMER_AND_PRODUCT_READS) {
    const op = findOperation(id);
    const [resource, method] = id.split(":");
    expect(op.classification).toBe("read");
    expect(op.http).toBe("POST");
    expect(op.method).toBe(method);
    expect(op.permission).toBe(`read:omie:${resource.replaceAll("/", ".")}.${method}`);
    expect(op.path).toMatch(/^\/api\/v1\/geral\/(clientes|produtos)\/$/);
  }
});

test("customer and product queries delegate only their own read capabilities", () => {
  const ceiling = [...READS.flatMap(delegated), "execute:omie:geral/clientes:IncluirCliente"];
  for (const id of CUSTOMER_AND_PRODUCT_READS) {
    expect(omieDelegation("omie-orders.api-read", undefined, ["--operation", id], ceiling, SCOPE)).toEqual(
      delegated(id),
    );
    // A curated entrypoint has no --operation flag: it resolves the same operation by its permission.
    expect(omieDelegation("omie-orders.clientes.listar", findOperation(id).permission, [], ceiling, SCOPE)).toEqual(
      delegated(id),
    );
    // A manifest that does not declare the exact capabilities cannot delegate them.
    expect(() =>
      omieDelegation("omie-orders.api-read", undefined, ["--operation", id], delegated(id).slice(1), SCOPE),
    ).toThrow("Manifesto");
  }
});

test("writes in the customers and products modules stay unavailable at every layer", async () => {
  const ceiling = READS.flatMap(delegated);
  for (const id of [
    "geral/clientes:IncluirCliente",
    "geral/clientes:ExcluirCliente",
    "geral/produtos:AlterarProduto",
  ]) {
    expect(() => omieDelegation("omie-orders.api-read", undefined, ["--operation", id], ceiling, SCOPE)).toThrow(
      "Operação não encontrada",
    );
    expect(() => nativeRuntime(id, { scope: SCOPE })).toThrow("Operação não encontrada");
    const r = runtime();
    await expect(createOmieHostAction(r.host, ledger())(id, { params: {} })).rejects.toMatchObject({
      code: "OMIE_OPERATION_NOT_FOUND",
    });
    expect(r.calls).toHaveLength(0);
  }
  for (const id of CUSTOMER_AND_PRODUCT_READS) expect(() => nativeRuntime(id, { scope: SCOPE })).not.toThrow();
});

test("a customer listing reaches only the fixed endpoint, with bounded paging and no bank details", async () => {
  const r = runtime({
    pagina: 1,
    total_de_paginas: 1,
    clientes_cadastro: [
      {
        codigo_cliente_omie: 11,
        razao_social: "EMPRESA SINTETICA",
        dadosBancarios: { agencia: "0001", conta_corrente: "98765", doc_titular: "00000000000" },
        app_key: "must-not-appear",
      },
    ],
  });
  const result = await createOmieHostAction(r.host, ledger())("geral/clientes:ListarClientes", {
    params: { clientesFiltro: { razao_social: "EMPRESA" } },
  });
  expect(result.success).toBe(true);
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0].url).toBe("https://app.omie.com.br/api/v1/geral/clientes/");
  expect(r.calls[0].body.call).toBe("ListarClientes");
  expect(r.calls[0].body.param[0]).toMatchObject({
    pagina: 1,
    registros_por_pagina: 50,
    clientesFiltro: { razao_social: "EMPRESA" },
  });
  expect(result.data.clientes_cadastro[0]).toEqual({ codigo_cliente_omie: 11, razao_social: "EMPRESA SINTETICA" });
  for (const secret of ["dadosBancarios", "98765", "0001", "must-not-appear"])
    expect(JSON.stringify(result)).not.toContain(secret);
});

test("customer and product detail queries call exactly their own method", async () => {
  for (const [id, params] of [
    ["geral/clientes:ConsultarCliente", { codigo_cliente_omie: 11 }],
    ["geral/produtos:ConsultarProduto", { codigo_produto: 22 }],
    ["geral/produtos:ListarProdutos", { filtrar_apenas_omiepdv: "N" }],
  ] as const) {
    const r = runtime();
    expect((await createOmieHostAction(r.host, ledger())(id, { params })).success).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].body.call).toBe(findOperation(id).method);
    expect(r.calls[0].url).toBe(`https://app.omie.com.br${findOperation(id).path}`);
  }
});

test("paging limits and channel membership are enforced before any network call", async () => {
  for (const params of [{ registros_por_pagina: 101 }, { registros_por_pagina: 0 }, { pagina: 0 }]) {
    const r = runtime();
    await expect(
      createOmieHostAction(r.host, ledger())("geral/clientes:ListarClientes", { params }),
    ).rejects.toMatchObject({ code: "OMIE_PAGINATION_INVALID" });
    expect(r.calls).toHaveLength(0);
  }
  for (const id of CUSTOMER_AND_PRODUCT_READS) {
    const r = runtime();
    r.setMember(false);
    await expect(createOmieHostAction(r.host, ledger())(id, { params: {} })).rejects.toMatchObject({
      code: "OMIE_MEMBERSHIP_REQUIRED",
    });
    expect(r.calls).toHaveLength(0);
  }
});

test("provider responses never carry bank details, credentials or tokens at any depth", () => {
  expect(
    publicResult({
      clientes_cadastro: [
        { codigo_cliente_omie: 1, dadosBancarios: { agencia: "0001" }, nested: { app_key: "k", token: "t", keep: 1 } },
      ],
    }),
  ).toEqual({ clientes_cadastro: [{ codigo_cliente_omie: 1, nested: { keep: 1 } }] });
});
