import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), `ravi-catalog-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import { getDb } from "../router/router-db.js";
import { ensureCatalogSchema, resetCatalogSchemaFlag } from "./db.js";
import {
  deleteProduct,
  finalizeCatalogSyncLog,
  getProduct,
  getSyncLog,
  listProducts,
  listSyncLog,
  searchProducts,
  startCatalogSyncLog,
  updateFtsTextoCompleto,
  upsertProduct,
  validateSku,
} from "./store.js";

function wipeCatalogTables(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM catalog_products;
    DELETE FROM catalog_sync_log;
    DELETE FROM catalog_products_fts;
  `);
}

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetCatalogSchemaFlag();
  ensureCatalogSchema();
  wipeCatalogTables();
});

describe("catalog_products CRUD", () => {
  it("upsertProduct inserts a new row with sane defaults", () => {
    const product = upsertProduct({
      sku: "G312",
      nome: "Embalagem para Caldo Quente 500ml",
      marca: "Galvanotek",
      capacidadeMl: 500,
      weightGramsApprox: 400,
      shape: "rectangular",
      material: "PP",
      microwaveSafe: true,
      ovenSafe: false,
      freezerSafe: true,
      lidIncluded: true,
      usos: ["caldo quente", "sopa"],
    });
    expect(product.sku).toBe("G312");
    expect(product.tenantId).toBe("default");
    expect(product.ativo).toBe(true);
    expect(product.vendavel).toBe(true);
    expect(product.mostrarChatbot).toBe(true);
    expect(product.usos).toEqual(["caldo quente", "sopa"]);
    expect(product.capacidadeMl).toBe(500);
    expect(product.weightGramsApprox).toBe(400);
    expect(product.shape).toBe("rectangular");
    expect(product.microwaveSafe).toBe(true);
    expect(product.ovenSafe).toBe(false);
    expect(product.freezerSafe).toBe(true);
    expect(product.lidIncluded).toBe(true);
    expect(product.createdAt).toBe(product.updatedAt);
  });

  it("upsertProduct updates existing row and preserves created_at", async () => {
    const first = upsertProduct({ sku: "G312", nome: "Old name" });
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertProduct({ sku: "G312", nome: "New name", preco: 1.85, shape: "round" });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(second.nome).toBe("New name");
    expect(second.preco).toBe(1.85);
    expect(second.shape).toBe("round");
  });

  it("upsertProduct rejects empty sku and empty nome", () => {
    expect(() => upsertProduct({ sku: "", nome: "x" })).toThrow();
    expect(() => upsertProduct({ sku: "x", nome: "" })).toThrow();
    expect(() => upsertProduct({ sku: "x", nome: "   " })).toThrow();
  });

  it("upsertProduct isolates rows per tenant", () => {
    upsertProduct({ tenantId: "tenant-a", sku: "G312", nome: "A" });
    upsertProduct({ tenantId: "tenant-b", sku: "G312", nome: "B" });
    expect(getProduct("tenant-a", "G312")?.nome).toBe("A");
    expect(getProduct("tenant-b", "G312")?.nome).toBe("B");
    expect(getProduct("tenant-a", "G312")?.sku).toBe("G312");
  });

  it("getProduct returns undefined for missing sku", () => {
    expect(getProduct("default", "NOPE")).toBeUndefined();
  });

  it("deleteProduct removes the row and reports change", () => {
    upsertProduct({ sku: "G312", nome: "x" });
    expect(deleteProduct("default", "G312")).toBe(true);
    expect(getProduct("default", "G312")).toBeUndefined();
    expect(deleteProduct("default", "G312")).toBe(false);
  });

  it("listProducts respects ativo filter and limit", () => {
    upsertProduct({ sku: "A", nome: "A" });
    upsertProduct({ sku: "B", nome: "B", ativo: false });
    upsertProduct({ sku: "C", nome: "C" });
    expect(listProducts({ ativo: true })).toHaveLength(2);
    expect(listProducts({ ativo: false })).toHaveLength(1);
    expect(listProducts({ limit: 1 })).toHaveLength(1);
  });

  it("validateSku is true only for active SKUs of the same tenant", () => {
    upsertProduct({ sku: "G312", nome: "x" });
    upsertProduct({ sku: "G315", nome: "x", ativo: false });
    upsertProduct({ tenantId: "tenant-b", sku: "G312", nome: "x" });
    expect(validateSku("default", "G312")).toBe(true);
    expect(validateSku("default", "G315")).toBe(false);
    expect(validateSku("default", "MISSING")).toBe(false);
    expect(validateSku("tenant-b", "G312")).toBe(true);
    expect(validateSku("tenant-c", "G312")).toBe(false);
  });

  it("preserves new empirical fields through round-trip", () => {
    upsertProduct({
      sku: "G240",
      nome: "Embalagem Forneavel 800ml",
      capacidadeMl: 800,
      weightGramsApprox: 700,
      shape: "rectangular",
      compartments: 1,
      microwaveSafe: true,
      ovenSafe: true,
      freezerSafe: true,
      airfryerSafe: true,
      leakResistant: false,
      lidIncluded: true,
      lidCompatible: true,
      customizationMinQty: 1000,
      cor: "preto",
      tinyId: "566764298",
    });
    const product = getProduct("default", "G240")!;
    expect(product.weightGramsApprox).toBe(700);
    expect(product.shape).toBe("rectangular");
    expect(product.compartments).toBe(1);
    expect(product.airfryerSafe).toBe(true);
    expect(product.leakResistant).toBe(false);
    expect(product.lidCompatible).toBe(true);
    expect(product.customizationMinQty).toBe(1000);
    expect(product.cor).toBe("preto");
    expect(product.tinyId).toBe("566764298");
  });
});

describe("searchProducts", () => {
  beforeEach(() => {
    upsertProduct({
      sku: "G312",
      nome: "Embalagem para Caldo Quente 500ml com Tampa",
      marca: "Galvanotek",
      categoriaPath: "EMBALAGEM/Marmita/Caldo",
      preco: 1.85,
      estoque: 1200,
      capacidadeMl: 500,
      weightGramsApprox: 400,
      shape: "round",
      material: "PP",
      microwaveSafe: true,
      ovenSafe: false,
      freezerSafe: true,
      lidIncluded: true,
      usos: ["caldo quente", "sopa"],
    });
    upsertProduct({
      sku: "G315",
      nome: "Embalagem para Caldo Frio 500ml",
      marca: "Galvanotek",
      categoriaPath: "EMBALAGEM/Marmita/Caldo",
      preco: 1.45,
      estoque: 950,
      capacidadeMl: 500,
      weightGramsApprox: 400,
      shape: "round",
      material: "PET",
      microwaveSafe: false,
      ovenSafe: false,
      freezerSafe: true,
      lidIncluded: false,
      usos: ["caldo frio"],
    });
    upsertProduct({
      sku: "PT100",
      nome: "Pote 100ml para Molho",
      marca: "Strawplast",
      categoriaPath: "EMBALAGEM/Pote/Molho",
      preco: 0.35,
      estoque: 5000,
      capacidadeMl: 100,
      weightGramsApprox: 80,
      shape: "round",
      material: "PP",
      microwaveSafe: true,
      leakResistant: true,
      lidIncluded: true,
      cor: "transparente",
      usos: ["molho"],
    });
    upsertProduct({
      sku: "M250",
      nome: "Marmita 750ml com Divisória",
      marca: "Prafesta",
      categoriaPath: "EMBALAGEM/Marmita/Divisoria",
      preco: 2.95,
      estoque: 480,
      capacidadeMl: 750,
      weightGramsApprox: 600,
      shape: "rectangular",
      compartments: 3,
      material: "PP",
      microwaveSafe: true,
      usos: ["marmita executiva"],
    });
    upsertProduct({
      sku: "DROP",
      nome: "Produto descontinuado",
      ativo: false,
      material: "PP",
      capacidadeMl: 500,
    });
  });

  it("structured filter narrows by capacidade and microwave_safe", () => {
    const results = searchProducts({
      capacidadeMinMl: 450,
      capacidadeMaxMl: 550,
      microwaveSafe: true,
    });
    expect(results.map((r) => r.sku)).toEqual(["G312"]);
  });

  it("filter by shape returns rectangular only", () => {
    const results = searchProducts({ shape: "rectangular" });
    expect(results.map((r) => r.sku)).toEqual(["M250"]);
  });

  it("filter by compartments minimum returns marmitas with divisória", () => {
    const results = searchProducts({ compartmentsMin: 2 });
    expect(results.map((r) => r.sku)).toEqual(["M250"]);
  });

  it("filter by lid_included narrows correctly", () => {
    const results = searchProducts({ lidIncluded: true, material: "PP" });
    expect(results.map((r) => r.sku).sort()).toEqual(["G312", "PT100"]);
  });

  it("filter by leak_resistant returns only PT100", () => {
    const results = searchProducts({ leakResistant: true });
    expect(results.map((r) => r.sku)).toEqual(["PT100"]);
  });

  it("filter by cor returns transparente only", () => {
    const results = searchProducts({ cor: "transparente" });
    expect(results.map((r) => r.sku)).toEqual(["PT100"]);
  });

  it("weight range filter narrows by approximate grams", () => {
    const results = searchProducts({ weightGramsMin: 500, weightGramsMax: 700 });
    expect(results.map((r) => r.sku)).toEqual(["M250"]);
  });

  it("excludes ativo=0 by default", () => {
    const results = searchProducts({ material: "PP" });
    expect(results.map((r) => r.sku).sort()).toEqual(["G312", "M250", "PT100"]);
  });

  it("can opt-in to inactive rows", () => {
    const results = searchProducts({ material: "PP", ativo: false });
    expect(results.map((r) => r.sku)).toEqual(["DROP"]);
  });

  it("FTS5 query ranks the right SKU on top", () => {
    const results = searchProducts({ query: "caldo quente" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.sku).toBe("G312");
    expect(typeof results[0]?.rank).toBe("number");
  });

  it("FTS5 + structured filter compose", () => {
    const results = searchProducts({ query: "molho", material: "PP" });
    expect(results.map((r) => r.sku)).toEqual(["PT100"]);
  });

  it("FTS5 picks up editorial text via updateFtsTextoCompleto", () => {
    updateFtsTextoCompleto(
      "default",
      "G312",
      "Pote translúcido em polipropileno, resistente a 110 graus, ideal para sopas e caldos",
    );
    const results = searchProducts({ query: "polipropileno" });
    expect(results.map((r) => r.sku)).toEqual(["G312"]);
  });

  it("escapes punctuation in the query", () => {
    expect(() => searchProducts({ query: `caldo "quente` })).not.toThrow();
  });

  it("isolates results per tenant", () => {
    upsertProduct({
      tenantId: "tenant-b",
      sku: "G312",
      nome: "Outra coisa",
      material: "PET",
      capacidadeMl: 500,
    });
    const a = searchProducts({ tenantId: "default", query: "caldo quente" });
    const b = searchProducts({ tenantId: "tenant-b", query: "caldo quente" });
    expect(a.map((r) => r.sku)).toEqual(["G312"]);
    expect(b.map((r) => r.sku)).toEqual([]);
  });

  it("limit caps result count", () => {
    const results = searchProducts({ material: "PP", limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("search result exposes shape, compartments and *_safe booleans", () => {
    const results = searchProducts({ material: "PP", microwaveSafe: true });
    expect(results.length).toBeGreaterThan(0);
    const m250 = results.find((r) => r.sku === "M250")!;
    expect(m250.shape).toBe("rectangular");
    expect(m250.compartments).toBe(3);
    expect(m250.microwaveSafe).toBe(true);
  });
});

describe("catalog_sync_log", () => {
  it("start + finalize records the full sync lifecycle", () => {
    const started = startCatalogSyncLog({ provider: "tiny", modifiedSince: 1000 });
    expect(started.id).toBeGreaterThan(0);
    expect(started.fetched).toBe(0);
    expect(started.finishedAt).toBeUndefined();

    const finalized = finalizeCatalogSyncLog({
      id: started.id,
      fetched: 12,
      upserted: 11,
      errors: 1,
      durationMs: 4321,
      payloadJson: JSON.stringify({ note: "fast" }),
    });
    expect(finalized.fetched).toBe(12);
    expect(finalized.upserted).toBe(11);
    expect(finalized.errors).toBe(1);
    expect(finalized.durationMs).toBe(4321);
    expect(finalized.finishedAt).toBeGreaterThanOrEqual(finalized.startedAt);
  });

  it("listSyncLog returns rows newest-first per tenant", () => {
    startCatalogSyncLog({ provider: "tiny" });
    startCatalogSyncLog({ provider: "tiny" });
    startCatalogSyncLog({ tenantId: "tenant-b", provider: "tiny" });
    expect(listSyncLog()).toHaveLength(2);
    expect(listSyncLog({ tenantId: "tenant-b" })).toHaveLength(1);
  });

  it("getSyncLog returns undefined for missing id", () => {
    expect(getSyncLog(99999)).toBeUndefined();
  });
});
