/**
 * Catalog Gateway — Domain Types
 *
 * Product catalog mirrored from external ERPs (Tiny initially).
 * Campos alinhados com pesquisa empirica (researcher task-f9997eef,
 * 734 conversas WhatsApp reais analisadas em 2026-05-27).
 *
 * See docs/proposals/catalog-gateway-prd.md.
 */

export type EnriquecimentoConf = "high" | "med" | "low";
export type TipoVariacao = "P" | "V" | "N";
export type ProductShape = "round" | "square" | "rectangular" | "bottle" | "bowl" | "bag" | "tray" | "other";

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
  // ADDED 2026-05-27 (researcher task-f9997eef): ml ≠ gramas é confusão
  // presente em 33% das conversas. Equipe SEMPRE clarifica.
  weightGramsApprox?: number;
  // ADDED 2026-05-27: equipe pergunta forma em 20% das conversas
  // (use-case-first arquetipo)
  shape?: ProductShape;
  // ADDED 2026-05-27: equipe SEMPRE pergunta divisória em conversas
  // use-case-first (33% qualitativo)
  compartments?: number;
  material?: string;
  // ADDED 2026-05-27 (researcher): substitui resistencia_termica enum
  // por booleans separados — equipe pergunta cada um especificamente
  microwaveSafe?: boolean;
  ovenSafe?: boolean;
  freezerSafe?: boolean;
  airfryerSafe?: boolean;
  // ADDED 2026-05-27: substitui seal_type. "Não vaza?" é a pergunta real.
  leakResistant?: boolean;
  // ADDED 2026-05-27: tampa é decisor binário (21.5% das conversas)
  lidIncluded?: boolean;
  lidCompatible?: boolean;
  // ADDED 2026-05-27: nicho mas relevante (use_case_tags 13.6%)
  customizationMinQty?: number;
  usos?: string[];
  cor?: string;
  tipoVariacao?: TipoVariacao;
  skuPai?: string;
  imagemUrl?: string;
  artifactId?: string;
  tinyId?: string;
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
  weightGramsApprox?: number;
  shape?: ProductShape;
  compartments?: number;
  material?: string;
  microwaveSafe?: boolean;
  ovenSafe?: boolean;
  freezerSafe?: boolean;
  airfryerSafe?: boolean;
  leakResistant?: boolean;
  lidIncluded?: boolean;
  lidCompatible?: boolean;
  customizationMinQty?: number;
  usos?: string[];
  cor?: string;
  tipoVariacao?: TipoVariacao;
  skuPai?: string;
  imagemUrl?: string;
  artifactId?: string;
  tinyId?: string;
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
  weightGramsMin?: number;
  weightGramsMax?: number;
  shape?: ProductShape;
  compartmentsMin?: number;
  microwaveSafe?: boolean;
  ovenSafe?: boolean;
  freezerSafe?: boolean;
  airfryerSafe?: boolean;
  leakResistant?: boolean;
  lidIncluded?: boolean;
  material?: string;
  categoriaPath?: string;
  marca?: string;
  cor?: string;
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
  weightGramsApprox?: number;
  shape?: ProductShape;
  compartments?: number;
  microwaveSafe?: boolean;
  ovenSafe?: boolean;
  freezerSafe?: boolean;
  lidIncluded?: boolean;
  material?: string;
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

export const PRODUCT_SHAPES: readonly ProductShape[] = [
  "round",
  "square",
  "rectangular",
  "bottle",
  "bowl",
  "bag",
  "tray",
  "other",
] as const;
