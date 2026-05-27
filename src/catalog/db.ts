/**
 * Catalog Gateway — Storage Schema
 *
 * Follows Ravi's CREATE TABLE IF NOT EXISTS + lazy migration pattern.
 * Tables live in `~/.ravi/ravi.db` (same file, dedicated `catalog_*` namespace).
 *
 * Schema atualizado 2026-05-27 com base em pesquisa empirica
 * (researcher task-f9997eef, 734 conversas WhatsApp).
 *
 * See docs/proposals/catalog-gateway-prd.md §3 (schema) e §5 (FTS5).
 */

import { getDb, getRaviDbPath } from "../router/router-db.js";

let schemaReady = false;
let schemaDbPath: string | null = null;

export function resetCatalogSchemaFlag(): void {
  schemaReady = false;
  schemaDbPath = null;
}

const CATALOG_PRODUCT_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "weight_grams_approx", ddl: "weight_grams_approx REAL" },
  { name: "shape", ddl: "shape TEXT" },
  { name: "compartments", ddl: "compartments INTEGER" },
  { name: "microwave_safe", ddl: "microwave_safe INTEGER" },
  { name: "oven_safe", ddl: "oven_safe INTEGER" },
  { name: "freezer_safe", ddl: "freezer_safe INTEGER" },
  { name: "airfryer_safe", ddl: "airfryer_safe INTEGER" },
  { name: "leak_resistant", ddl: "leak_resistant INTEGER" },
  { name: "lid_included", ddl: "lid_included INTEGER" },
  { name: "lid_compatible", ddl: "lid_compatible INTEGER" },
  { name: "customization_min_qty", ddl: "customization_min_qty INTEGER" },
  { name: "cor", ddl: "cor TEXT" },
  { name: "tiny_id", ddl: "tiny_id TEXT" },
];

function applyCatalogSchemaMigrations(): void {
  const db = getDb();
  const existing = new Set(
    (db.prepare("PRAGMA table_info(catalog_products)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const column of CATALOG_PRODUCT_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE catalog_products ADD COLUMN ${column.ddl}`);
    }
  }
}

export function ensureCatalogSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === dbPath) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_products (
      tenant_id           TEXT NOT NULL DEFAULT 'default',
      sku                 TEXT NOT NULL,
      nome                TEXT NOT NULL,
      marca               TEXT,
      categoria_path      TEXT,
      preco               REAL,
      preco_promo         REAL,
      estoque             INTEGER,
      ativo               INTEGER NOT NULL DEFAULT 1,
      gtin                TEXT,
      ncm                 TEXT,
      peso_liquido_g      REAL,
      peso_bruto_g        REAL,
      altura_mm           REAL,
      largura_mm          REAL,
      comprimento_mm      REAL,
      diametro_mm         REAL,
      capacidade_ml       REAL,
      material            TEXT,
      resistencia_termica TEXT,
      usos_json           TEXT,
      tipo_variacao       TEXT,
      sku_pai             TEXT,
      imagem_url          TEXT,
      artifact_id         TEXT,
      tiny_sync_at        INTEGER,
      enriquecimento_conf TEXT,
      enriquecimento_at   INTEGER,
      vendavel            INTEGER NOT NULL DEFAULT 1,
      mostrar_chatbot     INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, sku)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_products_categoria
      ON catalog_products(tenant_id, categoria_path);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_marca
      ON catalog_products(tenant_id, marca);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_artifact
      ON catalog_products(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_material
      ON catalog_products(tenant_id, material);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_capacidade
      ON catalog_products(tenant_id, capacidade_ml);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_updated
      ON catalog_products(tenant_id, updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_products_fts USING fts5(
      tenant_id UNINDEXED,
      sku UNINDEXED,
      nome,
      marca,
      categoria_path,
      material,
      usos,
      texto_completo,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS catalog_products_ai
    AFTER INSERT ON catalog_products BEGIN
      INSERT INTO catalog_products_fts(tenant_id, sku, nome, marca, categoria_path, material, usos, texto_completo)
      VALUES (new.tenant_id, new.sku, new.nome,
              COALESCE(new.marca, ''),
              COALESCE(new.categoria_path, ''),
              COALESCE(new.material, ''),
              COALESCE(new.usos_json, ''),
              '');
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_products_ad
    AFTER DELETE ON catalog_products BEGIN
      DELETE FROM catalog_products_fts
      WHERE tenant_id = old.tenant_id AND sku = old.sku;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_products_au
    AFTER UPDATE ON catalog_products BEGIN
      UPDATE catalog_products_fts
      SET nome = new.nome,
          marca = COALESCE(new.marca, ''),
          categoria_path = COALESCE(new.categoria_path, ''),
          material = COALESCE(new.material, ''),
          usos = COALESCE(new.usos_json, '')
      WHERE tenant_id = new.tenant_id AND sku = new.sku;
    END;

    CREATE TABLE IF NOT EXISTS catalog_sync_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       TEXT NOT NULL,
      provider        TEXT NOT NULL,
      modified_since  INTEGER,
      fetched         INTEGER NOT NULL DEFAULT 0,
      upserted        INTEGER NOT NULL DEFAULT 0,
      errors          INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER,
      payload_json    TEXT,
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_sync_log_tenant_started
      ON catalog_sync_log(tenant_id, started_at DESC);
  `);
  applyCatalogSchemaMigrations();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_catalog_products_shape
      ON catalog_products(tenant_id, shape);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_weight
      ON catalog_products(tenant_id, weight_grams_approx);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_microwave
      ON catalog_products(tenant_id, microwave_safe);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_oven
      ON catalog_products(tenant_id, oven_safe);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_freezer
      ON catalog_products(tenant_id, freezer_safe);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_lid
      ON catalog_products(tenant_id, lid_included);
    CREATE INDEX IF NOT EXISTS idx_catalog_products_tiny
      ON catalog_products(tenant_id, tiny_id);
  `);
  schemaReady = true;
  schemaDbPath = dbPath;
}
