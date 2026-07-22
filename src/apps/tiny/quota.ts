export interface TinyQuotaPolicy {
  apiVersion: "v2" | "v3";
  status: "published_plan_dependent" | "unknown";
  scope: "account" | "account_shared_across_applications";
  unit: "requests";
  window: "minute";
  publishedLimitPerMinute: number | null;
  publishedPlanLimitsPerMinute: Record<string, { total: number; write: number | null }> | null;
  batch: {
    callsPerMinute: number;
    maxRecordsPerRequest: number;
    maxRecordsPerResponse: number;
    officialAlwaysBatchOperations: string[];
    migratedAlwaysBatchOperations: string[];
  } | null;
  recommendedMaxConcurrencyFraction: number | null;
  observeHeaders: string[];
  documentedQuotaError: string | null;
  conservativePolicy: {
    maxInFlight: 1;
    minIntervalMs: 3000;
    maxAttempts: 1;
    retryAutomatically: false;
    respectRetryAfter: true;
    stopOnQuotaError: true;
  };
  officialDocs: string[];
  verifiedAt: "2026-07-14";
  evidenceStatus: "established" | "gap";
  unknownReason: string | null;
  closureOwner: string | null;
  liveGate: "documented" | "no-go";
}

export const TINY_V2_OFFICIAL_ALWAYS_BATCH_OPERATIONS = [
  "contato-incluir",
  "contato-alterar",
  "produto-incluir",
  "produto-alterar",
  "grupo-tag-incluir",
  "grupo-tag-alterar",
  "tag-incluir",
  "tag-alterar",
] as const;

export const TINY_V2_MIGRATED_ALWAYS_BATCH_OPERATIONS = [
  "contato-incluir",
  "contato-alterar",
  "produto-incluir",
  "produto-alterar",
] as const;

export const TINY_V2_QUOTA: TinyQuotaPolicy = {
  apiVersion: "v2",
  status: "published_plan_dependent",
  scope: "account",
  unit: "requests",
  window: "minute",
  publishedLimitPerMinute: null,
  publishedPlanLimitsPerMinute: {
    comecar: { total: 0, write: null },
    crescer: { total: 30, write: null },
    evoluir: { total: 60, write: null },
    potencializar: { total: 120, write: null },
    discontinued: { total: 20, write: null },
  },
  batch: {
    callsPerMinute: 5,
    maxRecordsPerRequest: 20,
    maxRecordsPerResponse: 100,
    officialAlwaysBatchOperations: [...TINY_V2_OFFICIAL_ALWAYS_BATCH_OPERATIONS],
    migratedAlwaysBatchOperations: [...TINY_V2_MIGRATED_ALWAYS_BATCH_OPERATIONS],
  },
  recommendedMaxConcurrencyFraction: 0.25,
  observeHeaders: ["x-limit-api"],
  documentedQuotaError: null,
  conservativePolicy: {
    maxInFlight: 1,
    minIntervalMs: 3000,
    maxAttempts: 1,
    retryAutomatically: false,
    respectRetryAfter: true,
    stopOnQuotaError: true,
  },
  officialDocs: ["https://tiny.com.br/api-docs/api2-limites-api"],
  verifiedAt: "2026-07-14",
  evidenceStatus: "established",
  unknownReason: null,
  closureOwner: null,
  liveGate: "documented",
};

export const TINY_V3_QUOTA: TinyQuotaPolicy = {
  apiVersion: "v3",
  status: "published_plan_dependent",
  scope: "account_shared_across_applications",
  unit: "requests",
  window: "minute",
  publishedLimitPerMinute: null,
  publishedPlanLimitsPerMinute: {
    basico_crescer: { total: 60, write: 30 },
    essencial_evoluir: { total: 120, write: 60 },
    grande_potencializar: { total: 240, write: 100 },
  },
  batch: null,
  recommendedMaxConcurrencyFraction: null,
  observeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  documentedQuotaError: null,
  conservativePolicy: {
    maxInFlight: 1,
    minIntervalMs: 3000,
    maxAttempts: 1,
    retryAutomatically: false,
    respectRetryAfter: true,
    stopOnQuotaError: true,
  },
  officialDocs: [
    "https://api-docs.erp.olist.com/documentacao/comecando/limites-de-consulta",
    "https://ajuda.olist.com/hubs-e-plataformas-via-api/aplicativos-api-v3-configuracoes-e-utilizacao",
  ],
  verifiedAt: "2026-07-14",
  evidenceStatus: "established",
  unknownReason: null,
  closureOwner: null,
  liveGate: "documented",
};

export function publicTinyQuota(policy: TinyQuotaPolicy): TinyQuotaPolicy {
  return {
    ...policy,
    publishedPlanLimitsPerMinute: policy.publishedPlanLimitsPerMinute
      ? Object.fromEntries(
          Object.entries(policy.publishedPlanLimitsPerMinute).map(([plan, limits]) => [plan, { ...limits }]),
        )
      : null,
    batch: policy.batch
      ? {
          ...policy.batch,
          officialAlwaysBatchOperations: [...policy.batch.officialAlwaysBatchOperations],
          migratedAlwaysBatchOperations: [...policy.batch.migratedAlwaysBatchOperations],
        }
      : null,
    observeHeaders: [...policy.observeHeaders],
    officialDocs: [...policy.officialDocs],
    conservativePolicy: { ...policy.conservativePolicy },
  };
}
