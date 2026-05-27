/**
 * Catalog Gateway — Public API
 *
 * Entry point for in-process callers (tool-bridge, CLI commands).
 * Gateway HTTP routes are auto-generated from the CLI registry.
 *
 * See docs/proposals/catalog-gateway-prd.md.
 */

export type {
  CatalogProduct,
  CatalogSearchFilter,
  CatalogSearchResult,
  CatalogSyncLogEntry,
  CreateCatalogSyncLogInput,
  EnriquecimentoConf,
  FinalizeCatalogSyncLogInput,
  ProductShape,
  TipoVariacao,
  UpsertCatalogProductInput,
} from "./types.js";

export { DEFAULT_TENANT_ID, PRODUCT_SHAPES } from "./types.js";

export { ensureCatalogSchema } from "./db.js";

export {
  upsertProduct,
  getProduct,
  deleteProduct,
  listProducts,
  validateSku,
  searchProducts,
  updateFtsTextoCompleto,
  startCatalogSyncLog,
  finalizeCatalogSyncLog,
  getSyncLog,
  listSyncLog,
} from "./store.js";
