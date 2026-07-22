#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TINY_V2_MIGRATED_ALWAYS_BATCH_OPERATIONS, TINY_V2_OFFICIAL_ALWAYS_BATCH_OPERATIONS } from "./quota.js";
import { TINY_READ_WAVE_1_OPERATIONS, getTinyReadContract, type TinyReadOperation } from "./read-contracts.js";
import {
  TINY_WRITE_OPERATIONS,
  getTinyWriteContract,
  hasVerifiedOfficialWriteSource,
  type TinyWriteOperation,
} from "./write-contracts.js";

const VERIFIED_AT = "2026-07-14";
const V2_PORTAL_URL = "https://tiny.com.br/api-docs";
const V2_TOKEN_URL = "https://tiny.com.br/api-docs/api2-gerar-token-api";
const V2_QUOTA_URL = "https://tiny.com.br/api-docs/api2-limites-api";
const V2_WEBHOOKS_URL = "https://tiny.com.br/api-docs/api2-webhooks";
const V2_WEBHOOK_EVENTS_URL = "https://tiny.com.br/api-docs/api2-webhooks-tiny";
const V3_INDEX_URL = "https://api-docs.erp.olist.com/llms.txt";
const V3_TECHNICAL_LIMITS_URL = "https://api-docs.erp.olist.com/documentacao/comecando/limites-de-consulta";
const V3_PLAN_LIMITS_URL =
  "https://ajuda.olist.com/hubs-e-plataformas-via-api/aplicativos-api-v3-configuracoes-e-utilizacao";
const V3_AUTH_URL = "https://api-docs.erp.olist.com/documentacao/comecando/autenticacao";
const DOCUMENTATION_GAP_OWNER = "ravi-dev+researcher";
const WRITE_RETRY_POLICY =
  "maxInFlight=1; minIntervalMs=3000; maxAttempts=1; retryAutomatically=false; respect Retry-After; stopOnQuotaError=true";

const v2Quota = {
  status: "published_plan_dependent",
  apiVersion: "v2",
  scope: "account",
  unit: "requests",
  window: "minute",
  planLimitsPerMinute: {
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
  concurrency: "maximum_recommended_fraction=0.25; app_cap=1",
  headers: ["x-limit-api"],
  documentedError: null,
  retryPolicy:
    "maxInFlight=1; minIntervalMs=3000; maxAttempts=3 for idempotent reads only; retry 429/502/503/504; respect Retry-After; writes never retry",
  sourceUrls: [V2_QUOTA_URL],
  verifiedAt: VERIFIED_AT,
  owner: null,
  liveGate: "documented",
};

const v3Quota = {
  status: "published_plan_dependent",
  apiVersion: "v3",
  scope: "account_shared_across_applications",
  unit: "requests",
  window: "minute",
  planLimitsPerMinute: {
    basico_crescer: { total: 60, write: 30 },
    essencial_evoluir: { total: 120, write: 60 },
    grande_potencializar: { total: 240, write: 100 },
  },
  batch: null,
  concurrency: "app_cap=1 until live measurement",
  headers: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  documentedError: null,
  retryPolicy:
    "maxInFlight=1; minIntervalMs=3000; maxAttempts=1; retryAutomatically=false; respect Retry-After; stopOnQuotaError=true",
  sourceUrls: [V3_TECHNICAL_LIMITS_URL, V3_PLAN_LIMITS_URL],
  verifiedAt: VERIFIED_AT,
  owner: null,
  liveGate: "documented",
};

const v1DocumentationGap = {
  id: "tiny-api-v1",
  apiVersion: "v1",
  status: "unknown",
  endpoint: null,
  authentication: null,
  quota: {
    status: "unknown",
    apiVersion: "v1",
    scope: "unknown",
    unit: null,
    window: null,
    planLimitsPerMinute: null,
    batch: null,
    concurrency: null,
    headers: [],
    documentedError: null,
    retryPolicy: "no live traffic; no retry until an official v1 contract is established",
    sourceUrls: [V2_PORTAL_URL, V3_INDEX_URL],
    verifiedAt: VERIFIED_AT,
    owner: DOCUMENTATION_GAP_OWNER,
    liveGate: "no-go",
  },
  provenance: {
    officialUrls: [V2_PORTAL_URL, V3_INDEX_URL],
    verifiedAt: VERIFIED_AT,
    evidenceStatus: "gap",
    owner: DOCUMENTATION_GAP_OWNER,
  },
  complete: false,
  missing: ["officialEndpoint", "officialAuthentication", "officialQuota"],
  liveGate: "no-go",
};

const builtin = (handler: string) => ({ interface: "builtin", handler, mutating: false });
const metadataOnlyReadPermission = permissionSemantics("use app:tiny", "tiny:read");

function baseManifest() {
  return {
    schema: "ravi.app/v1",
    id: "tiny",
    name: "Tiny ERP",
    version: "0.5.0-runtime-hardening",
    description:
      "Conector Tiny neutro e tenant-aware: leituras v2 nativas, writes v2/v3 somente em preview e fundacao OAuth v3 broker-backed.",
    interfaces: {
      cli: {
        command: "ravi tiny",
        json: true,
        health: "bun run ./cli.ts config-check {args} --json",
      },
      ui: {
        routes: [{ id: "main", path: "/apps/tiny", label: "Tiny", icon: "app-window", view: "main" }],
        views: [
          {
            id: "main",
            type: "dashboard",
            title: "Tiny",
            density: "compact",
            query: { operation: "tiny.check" },
            refreshOn: ["ravi.apps.tiny.changed"],
            actions: [
              {
                id: "config-check",
                label: "Validar configuração",
                icon: "check-circle",
                operation: "tiny.config-check",
                placement: "toolbar",
              },
              {
                id: "info",
                label: "Informações da conta",
                icon: "list",
                operation: "tiny.info",
                placement: "toolbar",
              },
            ],
          },
        ],
      },
    },
    permissions: {
      required: ["tiny:read"],
      optional: [],
      mutating: ["tiny:write", "tiny:destructive"],
    },
    storage: {
      sqlite: [],
      files: [
        {
          path: "$RAVI_STATE_DIR/apps/tiny/tenants",
          kind: "tenant configuration with broker connection reference and without secret values",
          retention: "durable",
        },
      ],
    },
    artifacts: [],
    events: { emits: [], consumes: [] },
    health: {
      checks: [
        {
          id: "manifest",
          type: "builtin",
          required: true,
          sideEffectFree: true,
          handler: "apps.manifest.check",
        },
        {
          id: "config",
          type: "cli",
          required: true,
          sideEffectFree: true,
          command: "bun run ./cli.ts config-check {args} --json",
          timeoutMs: 5000,
        },
      ],
    },
    skills: ["ravi-system-tiny"],
    versioning: {
      compatibility: "semver",
      migrations: [
        "SDE Tiny remains the enabled fallback until every live seam has parity, auth, quota and explicit cutover approval.",
      ],
    },
    migration: {
      mode: "native-parallel",
      legacyCommand: "sde tiny",
      legacyStatus: "preserved",
      canonicalConnector: "src/apps/tiny",
      workflowOwner: "sde",
      operationScope: "read wave 1: info plus low-risk contacts/products/stock; later read families remain on SDE",
      credentialPolicy:
        "tenant config references provider=tiny and connection=<tenant>; the broker persists encrypted v2 tokens or v3 OAuth bundles; hosts are pinned",
      writeExecution: "disabled; every mutating operation is schema-validated dry-run only",
      cutover: "disabled; separate explicit authorization required",
      readWaves: [
        {
          id: "read-wave-1",
          status: "offline-parity",
          operations: [...TINY_READ_WAVE_1_OPERATIONS],
          implemented: TINY_READ_WAVE_1_OPERATIONS.length,
          expected: TINY_READ_WAVE_1_OPERATIONS.length,
          fallback: "sde tiny",
          liveGate: "blocked-until-f001-f002-retest",
          excludedFamilies: ["orders", "fiscal", "financial", "workflows"],
        },
      ],
      documentationGaps: [v1DocumentationGap],
    },
  };
}

function localOperation(operation: "config-check" | "v3-auth-check") {
  const auth = operation === "v3-auth-check";
  const usage = auth
    ? "ravi tiny v3-auth-check --tenant <tenant> --dry-run --json"
    : "ravi tiny config-check --tenant <tenant> --json";
  return {
    interface: "cli",
    command: `bun run ./cli.ts ${operation} {args} --json`,
    json: true,
    mutating: false,
    safety: { ...safety(false, false, auth, false), liveExecution: true, risk: "low" },
    reliability: { timeoutMs: 30_000, maxAttempts: 1, baseDelayMs: 250 },
    permission: "tiny:read",
    description: auth
      ? "Inspeciona metadados e o plano OAuth v3 sem resolver segredo, refresh ou rede."
      : "Valida a configuração isolada do tenant e a referência do broker sem resolver segredo.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        tenant: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
        ...(auth ? { dryRun: { const: true } } : {}),
      },
      required: auth ? ["tenant", "dryRun"] : ["tenant"],
      additionalProperties: false,
    },
    help: {
      summary: auth
        ? "Confere a fundação OAuth v3 de um tenant sem acessar a credencial."
        : "Valida a configuração Tiny e o estado público da conexão broker.",
      usage,
      arguments: [],
      options: [
        option("--tenant <tenant>", true, "slug", "Tenant explícito; nunca há default implícito."),
        ...(auth ? [option("--dry-run", true, "flag", "Obrigatório; impede secret resolution e rede.")] : []),
      ],
      examples: [usage],
      sections: [
        section(
          "USE",
          auth ? "Auditar readiness OAuth v3 antes de consentimento/live." : "Auditar config tenant e broker.",
        ),
        section("NAO USE", "Não materializa credencial, consentimento ou chamada Tiny."),
        section("SEGURANCA", "READ-ONLY local; secretResolved=false e networkCalled=false."),
        section(
          "ON ERROR",
          auth
            ? "Tenant deve usar apiVersion v3 e --dry-run; conexão ausente permanece gap objetivo."
            : "Corrija tenant, host ou referência broker; falha fechada.",
        ),
        section(
          "AUTENTICACAO",
          auth
            ? "OAuth2 Authorization Code; access token 4h, refresh 1d, rotação no mesmo secretRef e auditoria oauth.access/oauth.refresh."
            : "Somente metadados provider=tiny/connection=<tenant>; nenhum token é lido.",
        ),
        section("PRECONDICOES", tenantConfigPrecondition(auth ? "v3" : "v2-or-v3")),
        section("COTAS", auth ? quotaSummary("v3") : "Não aplicável: nenhuma chamada de rede."),
        section(
          "PROVENIENCIA",
          auth
            ? `${V3_AUTH_URL}; ${V3_TECHNICAL_LIMITS_URL}; ${V3_PLAN_LIMITS_URL}; consultadas em ${VERIFIED_AT}.`
            : "Contrato Ravi broker local.",
        ),
        ...(!auth
          ? [
              section(
                "GAPS DOCUMENTAIS",
                `API v1: endpoint, autenticação e quota unknown; owner=${DOCUMENTATION_GAP_OWNER}; NO-GO live. Portais v2/v3 consultados em ${VERIFIED_AT}.`,
              ),
            ]
          : []),
      ],
      permissions: ["tiny:read"],
      permissionSemantics: metadataOnlyReadPermission,
      safety: safety(false, false, auth, false),
      validationCommands: [
        auth ? "bun test src/apps/tiny/oauth.test.ts" : "bun test src/apps/tiny/client.test.ts",
        "ravi apps check tiny --json",
      ],
      sourceText: auth ? "OAuth2 Tiny v3 + Ravi credential broker." : "Contrato nativo Ravi App Tiny.",
      provenance: {
        source: "official-docs+manifest",
        contract: auth ? "tiny-v3-oauth-broker-plan" : "ravi-app-native-config",
        command: `bun run ./cli.ts ${operation} {args} --json`,
        confidence: "high",
        officialUrls: auth ? [V3_AUTH_URL, V3_TECHNICAL_LIMITS_URL, V3_PLAN_LIMITS_URL] : [],
        verifiedAt: VERIFIED_AT,
        apiVersion: auth ? "v3" : "local",
        evidenceStatus: "established",
        owner: null,
      },
      quota: auth ? v3Quota : localQuota(),
      complete: true,
      missing: [],
    },
  };
}

function readOperation(operation: TinyReadOperation) {
  const contract = getTinyReadContract(operation);
  const positionalArguments = contract.positional.map((name) => ({
    name,
    required: true,
    value: "integer",
    description: "ID numérico interno do Tiny.",
  }));
  const filterOptions = Object.entries(contract.options).map(([flag, parameter]) =>
    option(
      flag === "--boleto" ? flag : `${flag} <valor>`,
      contract.requiredOptions?.includes(parameter) ?? false,
      flag === "--boleto" ? "flag" : "string",
      "Filtro oficial Tiny v2.",
    ),
  );
  const exampleArgs = contract.positional.length
    ? " 123456789"
    : contract.requiredOptions?.length
      ? ` ${flagForParameter(contract.requiredOptions[0]!)} exemplo`
      : contract.requireAny?.length
        ? ` ${flagForParameter(contract.requireAny[0]!)} exemplo`
        : operation === "contatos" || operation === "produtos" || operation === "listas-precos"
          ? " --pesquisa exemplo"
          : "";
  const usageArgs = contract.positional.map((name) => ` <${name}>`).join("");
  const usage = `ravi tiny ${operation}${usageArgs} --tenant <tenant> [filtros] [--dry-run] --json`;
  return {
    interface: "cli",
    command: `bun run ./cli.ts ${operation} {args} --json`,
    json: true,
    mutating: false,
    safety: { ...safety(false, false, true, false), liveExecution: true, risk: "low" },
    reliability: { timeoutMs: 30_000, maxAttempts: 3, baseDelayMs: 250 },
    permission: "tiny:read",
    description: `Executa ou planeja a leitura Tiny v2 ${operation} com tenant explícito e broker.`,
    inputSchema: readInputSchema(contract.positional, contract.options, contract.requiredOptions, contract.requireAny),
    outputSchema: "schemas/read-output.schema.json",
    parityContract: contract.parity,
    help: {
      summary: `Lê ${operation} pela API Tiny v2 ou mostra o plano com --dry-run.`,
      usage,
      arguments: positionalArguments,
      options: [
        option("--tenant <tenant>", true, "slug", "Tenant explícito; nunca há default implícito."),
        ...filterOptions,
        option("--dry-run", false, "flag", "Mostra endpoint e parâmetros sem segredo nem rede."),
      ],
      examples: [
        `ravi tiny ${operation}${exampleArgs} --tenant acme --dry-run --json`,
        `ravi tiny ${operation}${exampleArgs} --tenant acme --json`,
      ],
      sections: [
        section("USE", "Leitura atômica do conector Tiny; workflows continuam no SDE."),
        section("NAO USE", "Não use para mutação, consulta irrestrita ou para atravessar tenant."),
        section("SEGURANCA", "READ-ONLY e idempotente; host fixo, tenant explícito e falha fechada."),
        section("PRECONDICOES", tenantConfigPrecondition("v2")),
        section(
          "ON ERROR",
          "Corrija ID/filtro/paginação; 429 respeita Retry-After, 502/503/504 têm até 3 tentativas e 403 não repete.",
        ),
        section("ENDPOINT", `POST https://api.tiny.com.br/api2${contract.path}.`),
        section("COTAS", quotaSummary("v2")),
        section(
          "PROVENIENCIA",
          `${contract.officialDoc}; ${V2_TOKEN_URL}; ${V2_QUOTA_URL}; API v2; consultadas em ${VERIFIED_AT}.`,
        ),
        section("FALLBACK", `sde tiny ${operation} permanece baseline e fallback; nenhuma troca de binding foi feita.`),
      ],
      permissions: ["tiny:read"],
      permissionSemantics: metadataOnlyReadPermission,
      safety: safety(false, false, true, false),
      validationCommands: [
        "bun test src/apps/tiny/read-contracts.test.ts src/apps/tiny/read-wave-1.test.ts src/apps/tiny/client.test.ts",
        "ravi apps check tiny --json",
      ],
      sourceText: `Contrato Tiny v2 ${contract.path}; baseline sde tiny ${operation}.`,
      provenance: {
        source: "official-docs+legacy",
        contract: `tiny-v2-${operation}+ravi-app-native`,
        command: `bun run ./cli.ts ${operation} {args} --json`,
        confidence: "high",
        officialUrls: [contract.officialDoc, V2_TOKEN_URL, V2_QUOTA_URL],
        verifiedAt: VERIFIED_AT,
        apiVersion: "v2",
        evidenceStatus: "established",
        owner: null,
      },
      quota: v2Quota,
      complete: true,
      missing: [],
    },
  };
}

function writeOperation(operation: TinyWriteOperation) {
  const contract = getTinyWriteContract(operation);
  const v3 = contract.apiVersion === "v3";
  const documented = hasVerifiedOfficialWriteSource(contract);
  const destructive = contract.permission === "tiny:destructive";
  const gapSourceUrls =
    operation === "webhook-incluir" ? [V2_WEBHOOKS_URL, V2_WEBHOOK_EVENTS_URL] : [V2_PORTAL_URL, V2_QUOTA_URL];
  const quota = !documented
    ? {
        ...v2Quota,
        status: "unknown",
        planLimitsPerMinute: null,
        batch: null,
        concurrency: "official=unknown; conservative app cap=1 with minIntervalMs=3000",
        headers: [],
        sourceUrls: gapSourceUrls,
        owner: DOCUMENTATION_GAP_OWNER,
        liveGate: "no-go",
        retryPolicy: WRITE_RETRY_POLICY,
      }
    : {
        ...(v3 ? v3Quota : v2Quota),
        retryPolicy: WRITE_RETRY_POLICY,
      };
  const usage = `ravi tiny ${operation} --tenant <tenant> --input-file <json> --dry-run --json`;
  return {
    interface: "cli",
    command: `bun run ./cli.ts ${operation} {args} --json`,
    json: true,
    mutating: true,
    destructive,
    safety: {
      ...safety(true, destructive, true, true, contract.permission),
      liveExecution: false,
      risk: destructive ? "destructive" : "high",
    },
    reliability: { timeoutMs: 30_000, maxAttempts: 1, baseDelayMs: 250 },
    permission: contract.permission,
    description: `Valida e planeja ${operation} Tiny ${contract.apiVersion}; execução live desabilitada.`,
    inputSchema: {
      type: "object",
      properties: {
        tenant: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
        inputFile: { type: "string", minLength: 1 },
        dryRun: { const: true },
      },
      required: ["tenant", "inputFile", "dryRun"],
      additionalProperties: false,
    },
    payloadSchema: contract.schemaRef,
    outputSchema: "schemas/write-plan-output.schema.json",
    help: {
      summary: `Valida payload e produz plano redigido para ${operation}, sem rede.`,
      usage,
      arguments: [],
      options: [
        option("--tenant <tenant>", true, "slug", "Tenant explícito; nunca há default implícito."),
        option(
          "--input-file <json>",
          true,
          "path",
          `Payload conforme ${contract.schemaRef}; valores não aparecem no output.`,
        ),
        option("--dry-run", true, "flag", "Obrigatório; não resolve segredo nem chama a API."),
      ],
      examples: [usage, usage.replace("<tenant>", "filial-sp").replace("<json>", `./${operation}.json`)],
      sections: [
        section("USE", `Validar o contrato atômico ${operation} antes de qualquer aprovação futura.`),
        section("NAO USE", "Não executa mutação, workflow composto, retry ou compensação."),
        section(
          "REGRAS HARD",
          "dry-run obrigatório; secretResolved=false, networkCalled=false e executionEnabled=false.",
        ),
        section("PRECONDICOES", tenantConfigPrecondition(contract.apiVersion)),
        section(
          "HITL OBRIGATORIO",
          `Futuro live exige confirmação individual e execute app:tiny; ${contract.permission} é requirement de auditoria/metadata até um permission provider nomeado impor allow/deny.`,
        ),
        section("ON ERROR", "Corrija o campo de schema citado; --yes e execução live são rejeitados."),
        section(
          "ENDPOINT",
          documented
            ? `Planeja POST ${contract.path}; não chama rede.`
            : `Endpoint ${contract.path} não foi provado em fonte pública; NO-GO live.`,
        ),
        section("COTAS", !documented ? documentationGapQuotaSummary(operation) : quotaSummary(v3 ? "v3" : "v2")),
        section(
          "PROVENIENCIA",
          documented
            ? `${contract.officialDoc}; ${quota.sourceUrls.join("; ")}; API ${contract.apiVersion}; consultadas em ${VERIFIED_AT}.`
            : `${quota.sourceUrls.join("; ")}; endpoint REST e quota específicos unknown; owner=${DOCUMENTATION_GAP_OWNER}; NO-GO live; consultadas em ${VERIFIED_AT}.`,
        ),
        section(
          "RECONCILIACAO",
          contract.legacyGap ?? "Before/after e chave semântica são obrigatórios antes de habilitar live.",
        ),
      ],
      permissions: [contract.permission],
      permissionSemantics: permissionSemantics("execute app:tiny", contract.permission),
      safety: safety(true, destructive, true, true, contract.permission),
      validationCommands: ["bun test src/apps/tiny/write-contracts.test.ts", "ravi apps check tiny --json"],
      sourceText: `${contract.officialDoc ?? "gap oficial"} + ${contract.legacyCommand}; transporte live desabilitado.`,
      provenance: {
        source: "official-docs+legacy",
        contract: `tiny-${contract.apiVersion}-${operation}+write-preview`,
        command: `bun run ./cli.ts ${operation} {args} --json`,
        confidence: documented ? "high" : "low",
        officialUrls: documented
          ? [
              contract.officialDoc,
              ...(v3 ? [V3_AUTH_URL, V3_TECHNICAL_LIMITS_URL, V3_PLAN_LIMITS_URL] : [V2_TOKEN_URL, V2_QUOTA_URL]),
            ]
          : quota.sourceUrls,
        verifiedAt: VERIFIED_AT,
        apiVersion: contract.apiVersion,
        evidenceStatus: documented ? "established" : "gap",
        owner: documented ? null : DOCUMENTATION_GAP_OWNER,
      },
      quota,
      complete: documented,
      missing: documented ? [] : ["officialEndpoint", "immutableOfficialEvidence", "officialQuota"],
    },
  };
}

function safety(
  mutating: boolean,
  destructive: boolean,
  dryRunSupported: boolean,
  hitlRequired: boolean,
  permission?: string,
) {
  return {
    readOnly: !mutating,
    mutating,
    destructive,
    idempotent: !mutating,
    hitlRequired,
    confirmationRequired: hitlRequired,
    dryRunSupported,
    gates: mutating
      ? [
          "dry-run-only",
          "schema-valid",
          "broker-active-before-live",
          "hitl-before-live",
          "quota-observed-before-live",
          "app-boundary:execute:app:tiny",
          `requirement-metadata:${permission}`,
          "hitl:required",
          "confirmation:required",
          "preview:dry-run",
        ]
      : dryRunSupported
        ? ["preview:dry-run"]
        : [],
  };
}

function permissionSemantics(coreBoundary: "use app:tiny" | "execute app:tiny", requirement: string) {
  return {
    mode: "metadata-only",
    coreBoundary,
    declaredRequirements: [requirement],
    enforcementSource: "core-app-boundary-only",
    providerId: null,
  } as const;
}

function option(flags: string, required: boolean, value: string, description: string) {
  return { flags, required, value, defaultValue: null, values: [], description };
}

function section(title: string, content: string) {
  return { title, content };
}

function localQuota() {
  return {
    status: "not_applicable",
    apiVersion: null,
    scope: "local_no_network",
    unit: null,
    window: null,
    planLimitsPerMinute: null,
    batch: null,
    concurrency: null,
    headers: [],
    documentedError: null,
    retryPolicy: "not_applicable; no network",
    sourceUrls: [],
    verifiedAt: VERIFIED_AT,
    owner: null,
    liveGate: "documented",
  };
}

function quotaSummary(apiVersion: "v2" | "v3") {
  return apiVersion === "v2"
    ? `v2 por conta/minuto: 0/30/60/120 por plano (legados=20); batch=5/min e 20/request para os 8 serviços upstream (${TINY_V2_OFFICIAL_ALWAYS_BATCH_OPERATIONS.join("/")}); subset migrado=${TINY_V2_MIGRATED_ALWAYS_BATCH_OPERATIONS.join("/")}; máximo 100/response; concorrência recomendada=1/4, App cap=1; header x-limit-api; até 3 tentativas somente em reads idempotentes para 429/502/503/504, respeitando Retry-After; writes nunca repetem. ${V2_QUOTA_URL}`
    : `v3 por conta compartilhada entre apps: 60/30, 120/60 ou 240/100 total/write por plano; App cap=1; headers X-RateLimit-Limit/Remaining/Reset; 3s, 1 tentativa, sem retry automático e respeitar Retry-After. ${V3_TECHNICAL_LIMITS_URL}; ${V3_PLAN_LIMITS_URL}`;
}

function documentationGapQuotaSummary(operation: TinyWriteOperation) {
  return `v2 ${operation}: contrato/quota oficiais imutaveis, batch, concorrencia e headers especificos unknown; App usa cap=1/3s/1 tentativa sem atribuir esses valores a Tiny; owner=${DOCUMENTATION_GAP_OWNER}; NO-GO live.`;
}

function tenantConfigPrecondition(apiVersion: "v2" | "v3" | "v2-or-v3") {
  const version = apiVersion === "v2-or-v3" ? "apiVersion=v2 ou v3" : `apiVersion=${apiVersion}`;
  return `Antes do plano/dry-run, deve existir $RAVI_STATE_DIR/apps/tiny/tenants/<tenant>.json com tenant correspondente, ${version} e credentialConnection; não há tenant default.`;
}

function readInputSchema(
  positional: string[],
  options: Record<string, string>,
  requiredOptions?: string[],
  requireAny?: string[],
) {
  const properties: Record<string, unknown> = {
    tenant: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
    dryRun: { type: "boolean", default: false },
  };
  for (const name of positional) properties[name] = { type: "string", pattern: "^\\d+$" };
  for (const [flag, name] of Object.entries(options)) {
    properties[toSchemaKey(flag, name)] = flag === "--boleto" ? { type: "boolean" } : { type: "string" };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required: [
      "tenant",
      ...positional,
      ...(requiredOptions ?? []).map((name) => toSchemaKey(flagForParameter(name), name)),
    ],
    ...(requireAny?.length
      ? { anyOf: requireAny.map((name) => ({ required: [toSchemaKey(flagForParameter(name), name)] })) }
      : {}),
    additionalProperties: false,
  };
}

function flagForParameter(parameter: string): string {
  return `--${parameter.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replaceAll("_", "-")}`;
}

function toSchemaKey(flag: string, fallback: string): string {
  return flag.startsWith("--")
    ? flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    : fallback;
}

export function generateTinyManifest() {
  const operations: Record<string, unknown> = {
    "tiny.help": builtin("apps.help"),
    "tiny.show": builtin("apps.manifest.show"),
    "tiny.check": builtin("apps.manifest.check"),
    "tiny.config-check": localOperation("config-check"),
    "tiny.v3-auth-check": localOperation("v3-auth-check"),
  };
  for (const operation of TINY_READ_WAVE_1_OPERATIONS) operations[`tiny.${operation}`] = readOperation(operation);
  for (const operation of TINY_WRITE_OPERATIONS) operations[`tiny.${operation}`] = writeOperation(operation);
  return { ...baseManifest(), operations };
}

if (import.meta.main) {
  const path = join(import.meta.dir, "ravi.app.json");
  await writeFile(path, `${JSON.stringify(generateTinyManifest(), null, 2)}\n`);
  const format = spawnSync("bunx", ["biome", "format", "--write", path], { stdio: "inherit" });
  if (format.status !== 0)
    throw new Error(`Biome failed to format generated Tiny manifest (exit ${format.status ?? "unknown"}).`);
}
