/**
 * Catalog Gateway — Domain Types
 *
 * Product catalog mirrored from external ERPs (Tiny initially).
 * See docs/proposals/catalog-gateway-prd.md
 */

export type ResistenciaTermica = "alta" | "media" | "baixa";
export type EnriquecimentoConf = "high" | "med" | "low";
export type TipoVariacao = "P" | "V" | "N";

export interface CatalogProduct {
  tenantId: string;
  sku: string;
  nome: string;
  marca?: string;
  categoriaPath?: string;
  preco?: number;
  precoPromo?: number;
  estoque?: number;
  ativo: boolean;
  gtin?: string;
  ncm?: string;
  pesoLiquidoG?: number;
  pesoBrutoG?: number;
  alturaMm?: number;
  larguraMm?: number;
  comprimentoMm?: number;
  diametroMm?: number;
  capacidadeMl?: number;
  material?: string;
  resistenciaTermica?: ResistenciaTermica;
  usos?: string[];
  tipoVariacao?: TipoVariacao;
  skuPai?: string;
  imagemUrl?: string;
  artifactId?: string;
  tinySyncAt?: number;
  enriquecimentoConf?: EnriquecimentoConf;
  enriquecimentoAt?: number;
  vendavel: boolean;
  mostrarChatbot: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertCatalogProductInput {
  tenantId?: string;
  sku: string;
  nome: string;
  marca?: string;
  categoriaPath?: string;
  preco?: number;
  precoPromo?: number;
  estoque?: number;
  ativo?: boolean;
  gtin?: string;
  ncm?: string;
  pesoLiquidoG?: number;
  pesoBrutoG?: number;
  alturaMm?: number;
  larguraMm?: number;
  comprimentoMm?: number;
  diametroMm?: number;
  capacidadeMl?: number;
  material?: string;
  resistenciaTermica?: ResistenciaTermica;
  usos?: string[];
  tipoVariacao?: TipoVariacao;
  skuPai?: string;
  imagemUrl?: string;
  artifactId?: string;
  tinySyncAt?: number;
  enriquecimentoConf?: EnriquecimentoConf;
  enriquecimentoAt?: number;
  vendavel?: boolean;
  mostrarChatbot?: boolean;
}

export interface CatalogSearchFilter {
  tenantId?: string;
  capacidadeMinMl?: number;
  capacidadeMaxMl?: number;
  material?: string;
  resistenciaTermica?: ResistenciaTermica;
  categoriaPath?: string;
  marca?: string;
  ativo?: boolean;
  vendavel?: boolean;
  mostrarChatbot?: boolean;
  query?: string;
  limit?: number;
}

export interface CatalogSearchResult {
  sku: string;
  nome: string;
  marca?: string;
  categoriaPath?: string;
  preco?: number;
  capacidadeMl?: number;
  material?: string;
  resistenciaTermica?: ResistenciaTermica;
  estoque?: number;
  rank?: number;
}

export interface CatalogSyncLogEntry {
  id: number;
  tenantId: string;
  provider: string;
  modifiedSince?: number;
  fetched: number;
  upserted: number;
  errors: number;
  durationMs?: number;
  payloadJson?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface CreateCatalogSyncLogInput {
  tenantId?: string;
  provider: string;
  modifiedSince?: number;
}

export interface FinalizeCatalogSyncLogInput {
  id: number;
  fetched: number;
  upserted: number;
  errors: number;
  durationMs: number;
  payloadJson?: string;
}

export const DEFAULT_TENANT_ID = "default";
