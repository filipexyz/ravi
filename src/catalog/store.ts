/**
 * Catalog Gateway — Storage CRUD
 *
 * Public API for catalog_products + catalog_sync_log.
 * Tool-bridge callers (chatbot) should use `searchProducts` + `validateSku`
 * in-process for <50ms latency (see PRD §6).
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
  type ResistenciaTermica,
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
  material: string | null;
  resistencia_termica: string | null;
  usos_json: string | null;
  tipo_variacao: string | null;
  sku_pai: string | null;
  imagem_url: string | null;
  artifact_id: string | null;
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
  if (row.material !== null) product.material = row.material;
  if (row.resistencia_termica !== null) {
    product.resistenciaTermica = row.resistencia_termica as ResistenciaTermica;
  }
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
      diametro_mm, capacidade_ml, material, resistencia_termica, usos_json, tipo_variacao,
      sku_pai, imagem_url, artifact_id, tiny_sync_at, enriquecimento_conf, enriquecimento_at,
      vendavel, mostrar_chatbot, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      material = excluded.material,
      resistencia_termica = excluded.resistencia_termica,
      usos_json = excluded.usos_json,
      tipo_variacao = excluded.tipo_variacao,
      sku_pai = excluded.sku_pai,
      imagem_url = excluded.imagem_url,
      artifact_id = excluded.artifact_id,
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
    input.material ?? null,
    input.resistenciaTermica ?? null,
    usosJson,
    input.tipoVariacao ?? null,
    input.skuPai ?? null,
    input.imagemUrl ?? null,
    input.artifactId ?? null,
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
  const row = getDb().prepare("SELECT * FROM catalog_products WHERE tenant_id = ? AND sku = ?").get(tenantId, sku) as
    | CatalogProductRow
    | undefined;
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
    .get(tenantId, sku) as { hit: number } | undefined;
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
  if (filter.material) {
    where.push("p.material = ?");
    params.push(filter.material);
  }
  if (filter.resistenciaTermica) {
    where.push("p.resistencia_termica = ?");
    params.push(filter.resistenciaTermica);
  }
  if (filter.categoriaPath) {
    where.push("p.categoria_path LIKE ?");
    params.push(`${filter.categoriaPath}%`);
  }
  if (filter.marca) {
    where.push("p.marca = ?");
    params.push(filter.marca);
  }

  let sql: string;
  if (useFts) {
    sql = `
      SELECT p.sku, p.nome, p.marca, p.categoria_path, p.preco,
             p.capacidade_ml, p.material, p.resistencia_termica, p.estoque,
             bm25(catalog_products_fts) AS rank
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
      SELECT p.sku, p.nome, p.marca, p.categoria_path, p.preco,
             p.capacidade_ml, p.material, p.resistencia_termica, p.estoque
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
    if (row.material !== null && row.material !== undefined) result.material = row.material;
    if (row.resistencia_termica !== null && row.resistencia_termica !== undefined) {
      result.resistenciaTermica = row.resistencia_termica as ResistenciaTermica;
    }
    if (row.estoque !== null && row.estoque !== undefined) result.estoque = row.estoque;
    if (row.rank !== undefined) result.rank = row.rank;
    return result;
  });
}

/**
 * FTS5 has a small DSL (AND/OR/NOT/quotes/etc). For agent-facing search we
 * treat the query as plain words and escape anything that could break the
 * parser. Each word becomes a prefix-match token so partial words still hit.
 */
function escapeFtsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return tokens.length > 0 ? tokens.join(" ") : '""';
}

/**
 * Update only the editorial-text field of the FTS5 row. Called by
 * the artifact sync path when `artifact_versions` for a SKU change.
 */
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
  const row = getDb().prepare("SELECT * FROM catalog_sync_log WHERE id = ?").get(id) as CatalogSyncLogRow | undefined;
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
