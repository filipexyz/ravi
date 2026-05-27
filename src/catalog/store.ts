/**
 * Catalog Gateway — Storage CRUD
 *
 * Public API for catalog_products + catalog_sync_log.
 * Tool-bridge callers (chatbot) should use `searchProducts` + `validateSku`
 * in-process for <50ms latency (see PRD §6).
 *
 * Schema atualizado 2026-05-27 com base em pesquisa empirica
 * (researcher task-f9997eef, 734 conversas WhatsApp).
 */

import { getDb } from "../router/router-db.js";
import { ensureCatalogSchema } from "./db.js";
import {
  DEFAULT_TENANT_ID,
  type CatalogProduct,
  type CatalogSearchFilter,
  type CatalogSearchResult,
  type CatalogSyncLogEntry,
  type CreateCatalogSyncLogInput,
  type EnriquecimentoConf,
  type FinalizeCatalogSyncLogInput,
  type ProductShape,
  type TipoVariacao,
  type UpsertCatalogProductInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row types (raw SQLite rows)
// ---------------------------------------------------------------------------

interface CatalogProductRow {
  tenant_id: string;
  sku: string;
  nome: string;
  marca: string | null;
  categoria_path: string | null;
  preco: number | null;
  preco_promo: number | null;
  estoque: number | null;
  ativo: number;
  gtin: string | null;
  ncm: string | null;
  peso_liquido_g: number | null;
  peso_bruto_g: number | null;
  altura_mm: number | null;
  largura_mm: number | null;
  comprimento_mm: number | null;
  diametro_mm: number | null;
  capacidade_ml: number | null;
  weight_grams_approx: number | null;
  shape: string | null;
  compartments: number | null;
  material: string | null;
  microwave_safe: number | null;
  oven_safe: number | null;
  freezer_safe: number | null;
  airfryer_safe: number | null;
  leak_resistant: number | null;
  lid_included: number | null;
  lid_compatible: number | null;
  customization_min_qty: number | null;
  cor: string | null;
  usos_json: string | null;
  tipo_variacao: string | null;
  sku_pai: string | null;
  imagem_url: string | null;
  artifact_id: string | null;
  tiny_id: string | null;
  tiny_sync_at: number | null;
  enriquecimento_conf: string | null;
  enriquecimento_at: number | null;
  vendavel: number;
  mostrar_chatbot: number;
  created_at: number;
  updated_at: number;
}

interface CatalogSearchRow extends Partial<CatalogProductRow> {
  sku: string;
  nome: string;
  rank?: number;
}

interface CatalogSyncLogRow {
  id: number;
  tenant_id: string;
  provider: string;
  modified_since: number | null;
  fetched: number;
  upserted: number;
  errors: number;
  duration_ms: number | null;
  payload_json: string | null;
  started_at: number;
  finished_at: number | null;
}

// ---------------------------------------------------------------------------
// Row → Domain conversion
// ---------------------------------------------------------------------------

function boolFromInt(value: number | null): boolean | undefined {
  if (value === null) return undefined;
  return value === 1;
}

function rowToProduct(row: CatalogProductRow): CatalogProduct {
  const product: CatalogProduct = {
    tenantId: row.tenant_id,
    sku: row.sku,
    nome: row.nome,
    ativo: row.ativo === 1,
    vendavel: row.vendavel === 1,
    mostrarChatbot: row.mostrar_chatbot === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.marca !== null) product.marca = row.marca;
  if (row.categoria_path !== null) product.categoriaPath = row.categoria_path;
  if (row.preco !== null) product.preco = row.preco;
  if (row.preco_promo !== null) product.precoPromo = row.preco_promo;
  if (row.estoque !== null) product.estoque = row.estoque;
  if (row.gtin !== null) product.gtin = row.gtin;
  if (row.ncm !== null) product.ncm = row.ncm;
  if (row.peso_liquido_g !== null) product.pesoLiquidoG = row.peso_liquido_g;
  if (row.peso_bruto_g !== null) product.pesoBrutoG = row.peso_bruto_g;
  if (row.altura_mm !== null) product.alturaMm = row.altura_mm;
  if (row.largura_mm !== null) product.larguraMm = row.largura_mm;
  if (row.comprimento_mm !== null) product.comprimentoMm = row.comprimento_mm;
  if (row.diametro_mm !== null) product.diametroMm = row.diametro_mm;
  if (row.capacidade_ml !== null) product.capacidadeMl = row.capacidade_ml;
  if (row.weight_grams_approx !== null) product.weightGramsApprox = row.weight_grams_approx;
  if (row.shape !== null) product.shape = row.shape as ProductShape;
  if (row.compartments !== null) product.compartments = row.compartments;
  if (row.material !== null) product.material = row.material;
  const microwave = boolFromInt(row.microwave_safe);
  if (microwave !== undefined) product.microwaveSafe = microwave;
  const oven = boolFromInt(row.oven_safe);
  if (oven !== undefined) product.ovenSafe = oven;
  const freezer = boolFromInt(row.freezer_safe);
  if (freezer !== undefined) product.freezerSafe = freezer;
  const airfryer = boolFromInt(row.airfryer_safe);
  if (airfryer !== undefined) product.airfryerSafe = airfryer;
  const leak = boolFromInt(row.leak_resistant);
  if (leak !== undefined) product.leakResistant = leak;
  const lid = boolFromInt(row.lid_included);
  if (lid !== undefined) product.lidIncluded = lid;
  const lidCompat = boolFromInt(row.lid_compatible);
  if (lidCompat !== undefined) product.lidCompatible = lidCompat;
  if (row.customization_min_qty !== null) product.customizationMinQty = row.customization_min_qty;
  if (row.cor !== null) product.cor = row.cor;
  if (row.usos_json !== null) {
    try {
      const parsed = JSON.parse(row.usos_json);
      if (Array.isArray(parsed)) product.usos = parsed.filter((u) => typeof u === "string");
    } catch {
      // ignore malformed JSON; the field stays undefined
    }
  }
  if (row.tipo_variacao !== null) product.tipoVariacao = row.tipo_variacao as TipoVariacao;
  if (row.sku_pai !== null) product.skuPai = row.sku_pai;
  if (row.imagem_url !== null) product.imagemUrl = row.imagem_url;
  if (row.artifact_id !== null) product.artifactId = row.artifact_id;
  if (row.tiny_id !== null) product.tinyId = row.tiny_id;
  if (row.tiny_sync_at !== null) product.tinySyncAt = row.tiny_sync_at;
  if (row.enriquecimento_conf !== null) {
    product.enriquecimentoConf = row.enriquecimento_conf as EnriquecimentoConf;
  }
  if (row.enriquecimento_at !== null) product.enriquecimentoAt = row.enriquecimento_at;
  return product;
}

function rowToSyncLog(row: CatalogSyncLogRow): CatalogSyncLogEntry {
  const entry: CatalogSyncLogEntry = {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    fetched: row.fetched,
    upserted: row.upserted,
    errors: row.errors,
    startedAt: row.started_at,
  };
  if (row.modified_since !== null) entry.modifiedSince = row.modified_since;
  if (row.duration_ms !== null) entry.durationMs = row.duration_ms;
  if (row.payload_json !== null) entry.payloadJson = row.payload_json;
  if (row.finished_at !== null) entry.finishedAt = row.finished_at;
  return entry;
}

function boolToInt(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

// ---------------------------------------------------------------------------
// catalog_products CRUD
// ---------------------------------------------------------------------------

export function upsertProduct(input: UpsertCatalogProductInput): CatalogProduct {
  ensureCatalogSchema();
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const sku = input.sku.trim();
  if (!sku) throw new Error("upsertProduct: sku is required");
  if (!input.nome || !input.nome.trim()) throw new Error("upsertProduct: nome is required");

  const now = Date.now();
  const db = getDb();

  const existing = db
    .prepare("SELECT created_at FROM catalog_products WHERE tenant_id = ? AND sku = ?")
    .get(tenantId, sku) as { created_at: number } | undefined;

  const createdAt = existing?.created_at ?? now;
  const usosJson = input.usos !== undefined ? JSON.stringify(input.usos) : null;
  const ativo = input.ativo === false ? 0 : 1;
  const vendavel = input.vendavel === false ? 0 : 1;
  const mostrarChatbot = input.mostrarChatbot === false ? 0 : 1;

  db.prepare(
    `INSERT INTO catalog_products (
      tenant_id, sku, nome, marca, categoria_path, preco, preco_promo, estoque, ativo,
      gtin, ncm, peso_liquido_g, peso_bruto_g, altura_mm, largura_mm, comprimento_mm,
      diametro_mm, capacidade_ml, weight_grams_approx, shape, compartments, material,
      microwave_safe, oven_safe, freezer_safe, airfryer_safe, leak_resistant,
      lid_included, lid_compatible, customization_min_qty, cor,
      usos_json, tipo_variacao, sku_pai, imagem_url, artifact_id, tiny_id,
      tiny_sync_at, enriquecimento_conf, enriquecimento_at,
      vendavel, mostrar_chatbot, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, sku) DO UPDATE SET
      nome = excluded.nome,
      marca = excluded.marca,
      categoria_path = excluded.categoria_path,
      preco = excluded.preco,
      preco_promo = excluded.preco_promo,
      estoque = excluded.estoque,
      ativo = excluded.ativo,
      gtin = excluded.gtin,
      ncm = excluded.ncm,
      peso_liquido_g = excluded.peso_liquido_g,
      peso_bruto_g = excluded.peso_bruto_g,
      altura_mm = excluded.altura_mm,
      largura_mm = excluded.largura_mm,
      comprimento_mm = excluded.comprimento_mm,
      diametro_mm = excluded.diametro_mm,
      capacidade_ml = excluded.capacidade_ml,
      weight_grams_approx = excluded.weight_grams_approx,
      shape = excluded.shape,
      compartments = excluded.compartments,
      material = excluded.material,
      microwave_safe = excluded.microwave_safe,
      oven_safe = excluded.oven_safe,
      freezer_safe = excluded.freezer_safe,
      airfryer_safe = excluded.airfryer_safe,
      leak_resistant = excluded.leak_resistant,
      lid_included = excluded.lid_included,
      lid_compatible = excluded.lid_compatible,
      customization_min_qty = excluded.customization_min_qty,
      cor = excluded.cor,
      usos_json = excluded.usos_json,
      tipo_variacao = excluded.tipo_variacao,
      sku_pai = excluded.sku_pai,
      imagem_url = excluded.imagem_url,
      artifact_id = excluded.artifact_id,
      tiny_id = excluded.tiny_id,
      tiny_sync_at = excluded.tiny_sync_at,
      enriquecimento_conf = excluded.enriquecimento_conf,
      enriquecimento_at = excluded.enriquecimento_at,
      vendavel = excluded.vendavel,
      mostrar_chatbot = excluded.mostrar_chatbot,
      updated_at = excluded.updated_at`,
  ).run(
    tenantId,
    sku,
    input.nome.trim(),
    input.marca ?? null,
    input.categoriaPath ?? null,
    input.preco ?? null,
    input.precoPromo ?? null,
    input.estoque ?? null,
    ativo,
    input.gtin ?? null,
    input.ncm ?? null,
    input.pesoLiquidoG ?? null,
    input.pesoBrutoG ?? null,
    input.alturaMm ?? null,
    input.larguraMm ?? null,
    input.comprimentoMm ?? null,
    input.diametroMm ?? null,
    input.capacidadeMl ?? null,
    input.weightGramsApprox ?? null,
    input.shape ?? null,
    input.compartments ?? null,
    input.material ?? null,
    boolToInt(input.microwaveSafe),
    boolToInt(input.ovenSafe),
    boolToInt(input.freezerSafe),
    boolToInt(input.airfryerSafe),
    boolToInt(input.leakResistant),
    boolToInt(input.lidIncluded),
    boolToInt(input.lidCompatible),
    input.customizationMinQty ?? null,
    input.cor ?? null,
    usosJson,
    input.tipoVariacao ?? null,
    input.skuPai ?? null,
    input.imagemUrl ?? null,
    input.artifactId ?? null,
    input.tinyId ?? null,
    input.tinySyncAt ?? null,
    input.enriquecimentoConf ?? null,
    input.enriquecimentoAt ?? null,
    vendavel,
    mostrarChatbot,
    createdAt,
    now,
  );

  const product = getProduct(tenantId, sku);
  if (!product) throw new Error("upsertProduct: insert succeeded but row not found");
  return product;
}

export function getProduct(tenantId: string, sku: string): CatalogProduct | undefined {
  ensureCatalogSchema();
  const row = getDb()
    .prepare("SELECT * FROM catalog_products WHERE tenant_id = ? AND sku = ?")
    .get(tenantId, sku) as CatalogProductRow | null;
  return row ? rowToProduct(row) : undefined;
}

export function deleteProduct(tenantId: string, sku: string): boolean {
  ensureCatalogSchema();
  const result = getDb().prepare("DELETE FROM catalog_products WHERE tenant_id = ? AND sku = ?").run(tenantId, sku);
  return result.changes > 0;
}

export function listProducts(
  opts: { tenantId?: string; ativo?: boolean; limit?: number; offset?: number } = {},
): CatalogProduct[] {
  ensureCatalogSchema();
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const limit = clampLimit(opts.limit, 100, 1000);
  const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  const clauses: string[] = ["tenant_id = ?"];
  const params: Array<string | number> = [tenantId];
  if (opts.ativo !== undefined) {
    clauses.push("ativo = ?");
    params.push(opts.ativo ? 1 : 0);
  }
  const sql = `SELECT * FROM catalog_products WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = getDb()
    .prepare(sql)
    .all(...params) as CatalogProductRow[];
  return rows.map(rowToProduct);
}

export function validateSku(tenantId: string, sku: string): boolean {
  ensureCatalogSchema();
  const row = getDb()
    .prepare("SELECT 1 AS hit FROM catalog_products WHERE tenant_id = ? AND sku = ? AND ativo = 1")
    .get(tenantId, sku) as { hit: number } | null;
  return !!row;
}

// ---------------------------------------------------------------------------
// Search (structured + FTS5 hybrid)
// ---------------------------------------------------------------------------

export function searchProducts(filter: CatalogSearchFilter): CatalogSearchResult[] {
  ensureCatalogSchema();
  const tenantId = filter.tenantId ?? DEFAULT_TENANT_ID;
  const limit = clampLimit(filter.limit, 10, 100);
  const trimmedQuery = filter.query?.trim();
  const useFts = !!trimmedQuery;

  const where: string[] = ["p.tenant_id = ?"];
  const params: Array<string | number> = [tenantId];

  if (filter.ativo !== undefined) {
    where.push("p.ativo = ?");
    params.push(filter.ativo ? 1 : 0);
  } else {
    where.push("p.ativo = 1");
  }
  if (filter.vendavel !== undefined) {
    where.push("p.vendavel = ?");
    params.push(filter.vendavel ? 1 : 0);
  }
  if (filter.mostrarChatbot !== undefined) {
    where.push("p.mostrar_chatbot = ?");
    params.push(filter.mostrarChatbot ? 1 : 0);
  }
  if (filter.capacidadeMinMl !== undefined) {
    where.push("p.capacidade_ml >= ?");
    params.push(filter.capacidadeMinMl);
  }
  if (filter.capacidadeMaxMl !== undefined) {
    where.push("p.capacidade_ml <= ?");
    params.push(filter.capacidadeMaxMl);
  }
  if (filter.weightGramsMin !== undefined) {
    where.push("p.weight_grams_approx >= ?");
    params.push(filter.weightGramsMin);
  }
  if (filter.weightGramsMax !== undefined) {
    where.push("p.weight_grams_approx <= ?");
    params.push(filter.weightGramsMax);
  }
  if (filter.shape) {
    where.push("p.shape = ?");
    params.push(filter.shape);
  }
  if (filter.compartmentsMin !== undefined) {
    where.push("p.compartments >= ?");
    params.push(filter.compartmentsMin);
  }
  if (filter.microwaveSafe !== undefined) {
    where.push("p.microwave_safe = ?");
    params.push(filter.microwaveSafe ? 1 : 0);
  }
  if (filter.ovenSafe !== undefined) {
    where.push("p.oven_safe = ?");
    params.push(filter.ovenSafe ? 1 : 0);
  }
  if (filter.freezerSafe !== undefined) {
    where.push("p.freezer_safe = ?");
    params.push(filter.freezerSafe ? 1 : 0);
  }
  if (filter.airfryerSafe !== undefined) {
    where.push("p.airfryer_safe = ?");
    params.push(filter.airfryerSafe ? 1 : 0);
  }
  if (filter.leakResistant !== undefined) {
    where.push("p.leak_resistant = ?");
    params.push(filter.leakResistant ? 1 : 0);
  }
  if (filter.lidIncluded !== undefined) {
    where.push("p.lid_included = ?");
    params.push(filter.lidIncluded ? 1 : 0);
  }
  if (filter.material) {
    where.push("p.material = ?");
    params.push(filter.material);
  }
  if (filter.categoriaPath) {
    where.push("p.categoria_path LIKE ?");
    params.push(`${filter.categoriaPath}%`);
  }
  if (filter.marca) {
    where.push("p.marca = ?");
    params.push(filter.marca);
  }
  if (filter.cor) {
    where.push("p.cor = ?");
    params.push(filter.cor);
  }

  const selectColumns = `p.sku, p.nome, p.marca, p.categoria_path, p.preco,
             p.capacidade_ml, p.weight_grams_approx, p.shape, p.compartments,
             p.microwave_safe, p.oven_safe, p.freezer_safe, p.lid_included,
             p.material, p.estoque`;

  let sql: string;
  if (useFts) {
    sql = `
      SELECT ${selectColumns}, bm25(catalog_products_fts) AS rank
      FROM catalog_products_fts
      JOIN catalog_products p
        ON p.tenant_id = catalog_products_fts.tenant_id
       AND p.sku = catalog_products_fts.sku
      WHERE catalog_products_fts MATCH ?
        AND ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    params.unshift(escapeFtsQuery(trimmedQuery!));
    params.push(limit);
  } else {
    sql = `
      SELECT ${selectColumns}
      FROM catalog_products p
      WHERE ${where.join(" AND ")}
      ORDER BY p.estoque DESC NULLS LAST, p.updated_at DESC
      LIMIT ?
    `;
    params.push(limit);
  }

  const rows = getDb()
    .prepare(sql)
    .all(...params) as CatalogSearchRow[];
  return rows.map((row) => {
    const result: CatalogSearchResult = {
      sku: row.sku,
      nome: row.nome,
    };
    if (row.marca !== null && row.marca !== undefined) result.marca = row.marca;
    if (row.categoria_path !== null && row.categoria_path !== undefined) {
      result.categoriaPath = row.categoria_path;
    }
    if (row.preco !== null && row.preco !== undefined) result.preco = row.preco;
    if (row.capacidade_ml !== null && row.capacidade_ml !== undefined) {
      result.capacidadeMl = row.capacidade_ml;
    }
    if (row.weight_grams_approx !== null && row.weight_grams_approx !== undefined) {
      result.weightGramsApprox = row.weight_grams_approx;
    }
    if (row.shape !== null && row.shape !== undefined) result.shape = row.shape as ProductShape;
    if (row.compartments !== null && row.compartments !== undefined) result.compartments = row.compartments;
    const microwave = boolFromInt(row.microwave_safe ?? null);
    if (microwave !== undefined) result.microwaveSafe = microwave;
    const oven = boolFromInt(row.oven_safe ?? null);
    if (oven !== undefined) result.ovenSafe = oven;
    const freezer = boolFromInt(row.freezer_safe ?? null);
    if (freezer !== undefined) result.freezerSafe = freezer;
    const lid = boolFromInt(row.lid_included ?? null);
    if (lid !== undefined) result.lidIncluded = lid;
    if (row.material !== null && row.material !== undefined) result.material = row.material;
    if (row.estoque !== null && row.estoque !== undefined) result.estoque = row.estoque;
    if (row.rank !== undefined) result.rank = row.rank;
    return result;
  });
}

function escapeFtsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return tokens.length > 0 ? tokens.join(" ") : '""';
}

export function updateFtsTextoCompleto(tenantId: string, sku: string, texto: string): void {
  ensureCatalogSchema();
  getDb()
    .prepare("UPDATE catalog_products_fts SET texto_completo = ? WHERE tenant_id = ? AND sku = ?")
    .run(texto, tenantId, sku);
}

// ---------------------------------------------------------------------------
// catalog_sync_log
// ---------------------------------------------------------------------------

export function startCatalogSyncLog(input: CreateCatalogSyncLogInput): CatalogSyncLogEntry {
  ensureCatalogSchema();
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO catalog_sync_log (tenant_id, provider, modified_since, started_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(tenantId, input.provider, input.modifiedSince ?? null, now);
  const id = Number(result.lastInsertRowid);
  const entry = getSyncLog(id);
  if (!entry) throw new Error("startCatalogSyncLog: insert succeeded but row not found");
  return entry;
}

export function finalizeCatalogSyncLog(input: FinalizeCatalogSyncLogInput): CatalogSyncLogEntry {
  ensureCatalogSchema();
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE catalog_sync_log
       SET fetched = ?, upserted = ?, errors = ?,
           duration_ms = ?, payload_json = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(input.fetched, input.upserted, input.errors, input.durationMs, input.payloadJson ?? null, now, input.id);
  const entry = getSyncLog(input.id);
  if (!entry) throw new Error(`finalizeCatalogSyncLog: id ${input.id} not found`);
  return entry;
}

export function getSyncLog(id: number): CatalogSyncLogEntry | undefined {
  ensureCatalogSchema();
  const row = getDb().prepare("SELECT * FROM catalog_sync_log WHERE id = ?").get(id) as CatalogSyncLogRow | null;
  return row ? rowToSyncLog(row) : undefined;
}

export function listSyncLog(
  opts: { tenantId?: string; provider?: string; limit?: number } = {},
): CatalogSyncLogEntry[] {
  ensureCatalogSchema();
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const limit = clampLimit(opts.limit, 20, 200);
  const clauses: string[] = ["tenant_id = ?"];
  const params: Array<string | number> = [tenantId];
  if (opts.provider) {
    clauses.push("provider = ?");
    params.push(opts.provider);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM catalog_sync_log WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as CatalogSyncLogRow[];
  return rows.map(rowToSyncLog);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(value: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return defaultLimit;
  return Math.min(Math.floor(value), maxLimit);
}
