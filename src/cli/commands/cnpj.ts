import "reflect-metadata";
import { z } from "zod";
import {
  CNPJ_TAILSCALE_BASE_URL,
  CnpjServerClient,
  CnpjServerError,
  cnpjFullResponseSchema,
  cnpjSearchItemSchema,
  type CnpjSearchParams,
  type CnpjServerClientOptions,
} from "../../apps/cnpj-server/client.js";
import {
  applyCnpjCrmSelection,
  buildCnpjCrmCandidates,
  CNPJ_CRM_EXPORT_LIMIT,
  cnpjSelectionHash,
  compactOriginFilters,
  defaultCnpjCrmAdapter,
  normalizePinnedCnpjs,
  parseCnpjCrmOwner,
  type CnpjCrmAdapter,
} from "../../apps/cnpj-server/crm-export.js";
import { canWriteContacts, getScopeContext, isScopeEnforced } from "../../permissions/scope.js";
import { fail } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option, Returns, Scope } from "../decorators.js";

const successSchema = z.literal(true);
const sourceSchema = z
  .object({
    app: z.literal("cnpj-server"),
    transport: z.literal("tailscale"),
    baseUrl: z.literal(CNPJ_TAILSCALE_BASE_URL),
    readOnly: z.literal(true),
  })
  .strict();

const healthReturnSchema = z
  .object({
    success: successSchema,
    app: z.literal("cnpj-server"),
    ready: z.literal(true),
    readOnly: z.literal(true),
    transport: z.literal("tailscale"),
    baseUrl: z.literal(CNPJ_TAILSCALE_BASE_URL),
    externalCheckPerformed: z.literal(true),
    latencyMs: z.number().int().min(0),
    engine: z.string().optional(),
    returned: z.number().int().min(0),
    totalResults: z.number().int().min(0),
  })
  .strict();

const getReturnSchema = z
  .object({
    success: successSchema,
    source: sourceSchema,
    data: cnpjFullResponseSchema,
  })
  .strict();

const searchQuerySchema = z
  .object({
    q: z.string().optional(),
    uf: z.string().optional(),
    cnae: z.string().optional(),
    cidade: z.string().optional(),
    capitalMin: z.number().optional(),
    capitalMax: z.number().optional(),
    porte: z.enum(["MICROEMPRESA", "EPP", "GRANDES"]).optional(),
    dataInicioMin: z.string().optional(),
    dataInicioMax: z.string().optional(),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

const searchReturnSchema = z
  .object({
    success: successSchema,
    source: sourceSchema,
    query: searchQuerySchema,
    engine: z.string().optional(),
    items: z.array(cnpjSearchItemSchema),
    totalResults: z.number().int().min(0),
    pagination: z
      .object({
        page: z.number().int().min(1),
        limit: z.number().int().min(1).max(100),
        returned: z.number().int().min(0),
        hasMore: z.boolean(),
        nextPage: z.number().int().min(2).optional(),
        nextCommand: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const ownerSchema = z
  .object({
    type: z.enum(["user", "agent", "team", "system"]),
    id: z.string().min(1),
  })
  .strict();

const exportSourceSchema = sourceSchema
  .extend({
    crmMutation: z.boolean(),
  })
  .strict();

const crmCandidateSchema = z
  .object({
    cnpj: z.string().length(14),
    name: z.string(),
    legalName: z.string(),
    industry: z.string().nullable(),
    uf: z.string().nullable(),
    registrationStatus: z.number(),
    openedAt: z.string().nullable(),
  })
  .strict();

const exportCrmResultSchema = z.union([
  z
    .object({
      cnpj: z.string().length(14),
      status: z.literal("created-or-reused"),
      accountId: z.string(),
      factId: z.string(),
    })
    .strict(),
  z
    .object({
      cnpj: z.string().length(14),
      status: z.literal("failed"),
      error: z
        .object({
          code: z.string(),
          category: z.enum(["corrigir", "retry", "autorizar", "parar"]),
          retryable: z.boolean(),
          message: z.string(),
          nextAction: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

const exportCrmReturnSchema = z.discriminatedUnion("mode", [
  z
    .object({
      success: successSchema,
      mode: z.literal("dry-run"),
      source: exportSourceSchema,
      owner: ownerSchema,
      filters: searchQuerySchema,
      candidates: z.array(crmCandidateSchema).max(CNPJ_CRM_EXPORT_LIMIT),
      dedupe: z
        .object({
          inputCount: z.number().int().min(0),
          uniqueCount: z.number().int().min(0),
          removedDuplicates: z.number().int().min(0),
        })
        .strict(),
      selectionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      nextCommand: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      success: successSchema,
      mode: z.literal("apply"),
      source: exportSourceSchema,
      owner: ownerSchema,
      selectionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      originFilters: z.record(z.string(), z.unknown()),
      status: z.enum(["completed", "partial", "failed"]),
      requested: z.number().int().min(1).max(CNPJ_CRM_EXPORT_LIMIT),
      applied: z.number().int().min(0),
      failed: z.number().int().min(0),
      results: z.array(exportCrmResultSchema).max(CNPJ_CRM_EXPORT_LIMIT),
    })
    .strict(),
]);

const baseUrlOption = {
  flags: "--base-url <url>",
  description: `Required exact private endpoint: ${CNPJ_TAILSCALE_BASE_URL}`,
  schema: z.string().url(),
} as const;
const timeoutOption = {
  flags: "--timeout-ms <n>",
  description: "Total request timeout, 100-30000ms",
  defaultValue: "10000",
  schema: integerString(100, 30_000),
} as const;
const jsonOption = {
  flags: "--json",
  description: "Print the stable JSON response",
} as const;

type CnpjClientFactory = (options: CnpjServerClientOptions) => CnpjServerClient;

@Group({
  name: "cnpj",
  description: "Read Brazilian company data through Tailscale and export explicit selections to Ravi CRM",
  scope: "open",
})
export class CnpjCommands {
  constructor(
    private readonly clientFactory: CnpjClientFactory = (options) => new CnpjServerClient(options),
    private readonly crm: CnpjCrmAdapter = defaultCnpjCrmAdapter,
  ) {}

  @Command({
    name: "health",
    description: "Probe the private CNPJ Server with one bounded read-only search",
    helpAfter: readHelp(
      "Confirm the validated Tailscale route is reachable before relying on company data.",
      "Do not use as a public internet health check or with another host.",
      [
        `ravi cnpj health --base-url ${CNPJ_TAILSCALE_BASE_URL} --json`,
        `ravi cnpj health --base-url ${CNPJ_TAILSCALE_BASE_URL} --timeout-ms 3000 --json`,
      ],
      "INVALID_ENDPOINT → use the exact private URL. TIMEOUT/TRANSPORT_ERROR → verify Tailscale, then retry.",
      "CNPJ Server /api/v1/busca; @sdebot/cnpj-sdk 0.9.1-beta contract received 2026-07-28.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "cnpj.registry", action: "health", risk: "low" })
  @Returns(healthReturnSchema)
  async health(
    @Option(baseUrlOption) baseUrl: string,
    @Option(timeoutOption) timeoutMs?: string,
    @Option(jsonOption) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(baseUrl, timeoutMs).health()),
    }));
  }

  @Command({
    name: "get",
    description: "Return the complete registered record for one valid CNPJ",
    helpAfter: readHelp(
      "Retrieve one known company's cadastral, establishment, Simples and partner records.",
      "For discovery by name, geography or activity, use `ravi cnpj search`.",
      [
        `ravi cnpj get 00.000.000/0001-91 --base-url ${CNPJ_TAILSCALE_BASE_URL} --json`,
        `ravi cnpj get 00000000000191 --base-url ${CNPJ_TAILSCALE_BASE_URL} --timeout-ms 5000 --json`,
      ],
      "INVALID_CNPJ → correct the digits. NOT_FOUND → stop or search; retrying the same identifier is not useful.",
      "CNPJ Server /api/v1/cnpj/:cnpj; @sdebot/cnpj-sdk 0.9.1-beta contract received 2026-07-28.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "cnpj.registry", action: "get", risk: "low" })
  @Returns(getReturnSchema)
  async get(
    @Arg("cnpj", {
      description: "Brazilian CNPJ, formatted or 14 digits",
      schema: z.string().min(1),
    })
    cnpj: string,
    @Option(baseUrlOption) baseUrl: string,
    @Option(timeoutOption) timeoutMs?: string,
    @Option(jsonOption) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      source: source(),
      data: await this.client(baseUrl, timeoutMs).show(cnpj),
    }));
  }

  @Command({
    name: "search",
    description: "Search active companies with bounded business and opening-date filters",
    helpAfter: readHelp(
      "Find companies when the CNPJ is unknown, one page at a time with bounded output.",
      "Do not use without a discovery filter, for auto-pagination, lookalike scoring or CRM writes; use export-crm for CRM.",
      [
        `ravi cnpj search --uf SP --limit 10 --base-url ${CNPJ_TAILSCALE_BASE_URL} --json`,
        `ravi cnpj search --cnae 1340500 --opened-from 2026-01-01 --limit 25 --base-url ${CNPJ_TAILSCALE_BASE_URL} --json`,
      ],
      "INVALID_SEARCH → correct ranges/formats. UPSTREAM_UNAVAILABLE → wait and retry this read; no hidden retry occurs.",
      "CNPJ Server /api/v1/busca; @sdebot/cnpj-sdk 0.9.1-beta contract received 2026-07-28.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "cnpj.registry", action: "search", risk: "low" })
  @Returns(searchReturnSchema)
  async search(
    @Option({ flags: "-q, --query <text>", description: "Company name or free-text query" }) q?: string,
    @Option({
      flags: "--uf <code>",
      description: "Two-letter uppercase Brazilian state code",
      schema: z.string().regex(/^[A-Z]{2}$/),
    })
    uf?: string,
    @Option({ flags: "--cnae <code>", description: "CNAE activity code or prefix" }) cnae?: string,
    @Option({ flags: "--city <name>", description: "Municipality/city name" }) cidade?: string,
    @Option({
      flags: "--capital-min <value>",
      description: "Minimum share capital, non-negative",
      schema: nonNegativeNumberString(),
    })
    capitalMin?: string,
    @Option({
      flags: "--capital-max <value>",
      description: "Maximum share capital, non-negative",
      schema: nonNegativeNumberString(),
    })
    capitalMax?: string,
    @Option({
      flags: "--size <value>",
      description: "Company size: MICROEMPRESA|EPP|GRANDES",
      schema: z.enum(["MICROEMPRESA", "EPP", "GRANDES"]),
    })
    porte?: "MICROEMPRESA" | "EPP" | "GRANDES",
    @Option({
      flags: "--opened-from <date>",
      description: "Opening date lower bound, YYYY-MM-DD",
      schema: isoDateString(),
    })
    dataInicioMin?: string,
    @Option({
      flags: "--opened-to <date>",
      description: "Opening date upper bound, YYYY-MM-DD",
      schema: isoDateString(),
    })
    dataInicioMax?: string,
    @Option({
      flags: "--page <n>",
      description: "Provider page number, >=1",
      defaultValue: "1",
      schema: integerString(1, 1_000_000),
    })
    page?: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-100",
      defaultValue: "20",
      schema: integerString(1, 100),
    })
    limit?: string,
    @Option(baseUrlOption) baseUrl?: string,
    @Option(timeoutOption) timeoutMs?: string,
    @Option(jsonOption) asJson?: boolean,
  ) {
    const query: CnpjSearchParams & { page: number; limit: number } = {
      ...(q ? { q } : {}),
      ...(uf ? { uf } : {}),
      ...(cnae ? { cnae } : {}),
      ...(cidade ? { cidade } : {}),
      ...(capitalMin ? { capitalMin: Number(capitalMin) } : {}),
      ...(capitalMax ? { capitalMax: Number(capitalMax) } : {}),
      ...(porte ? { porte } : {}),
      ...(dataInicioMin ? { dataInicioMin } : {}),
      ...(dataInicioMax ? { dataInicioMax } : {}),
      page: integer(page, 1),
      limit: integer(limit, 20),
    };

    return this.execute(asJson, async () => {
      requireDiscoveryFilter(query);
      const response = await this.client(baseUrl, timeoutMs).search(query);
      const returned = response.itens.length;
      const hasMore = returned === query.limit;
      return {
        success: true as const,
        source: source(),
        query,
        ...(response.motor ? { engine: response.motor } : {}),
        items: response.itens,
        totalResults: response.resultados,
        pagination: {
          page: response.pagina,
          limit: query.limit,
          returned,
          hasMore,
          ...(hasMore
            ? {
                nextPage: response.pagina + 1,
                nextCommand: buildNextCommand(query, response.pagina + 1, baseUrl, timeoutMs),
              }
            : {}),
        },
      };
    });
  }

  @Scope("writeContacts")
  @Command({
    name: "export-crm",
    description: "Preview or apply an explicit CNPJ selection as idempotent CRM lead accounts",
    helpAfter: exportCrmHelp(),
  })
  @CommandAccess({ kind: "mutate", resource: "crm.account", action: "export-cnpj", risk: "medium" })
  @Returns(exportCrmReturnSchema)
  async exportCrm(
    @Option({ flags: "-q, --query <text>", description: "Preview filter: company name or free text" }) q?: string,
    @Option({
      flags: "--uf <code>",
      description: "Preview filter: two-letter uppercase Brazilian state",
      schema: z.string().regex(/^[A-Z]{2}$/),
    })
    uf?: string,
    @Option({ flags: "--cnae <code>", description: "Preview filter: CNAE activity code or prefix" }) cnae?: string,
    @Option({ flags: "--city <name>", description: "Preview filter: municipality/city" }) cidade?: string,
    @Option({
      flags: "--capital-min <value>",
      description: "Preview filter: minimum non-negative share capital",
      schema: nonNegativeNumberString(),
    })
    capitalMin?: string,
    @Option({
      flags: "--capital-max <value>",
      description: "Preview filter: maximum non-negative share capital",
      schema: nonNegativeNumberString(),
    })
    capitalMax?: string,
    @Option({
      flags: "--size <value>",
      description: "Preview filter: MICROEMPRESA|EPP|GRANDES",
      schema: z.enum(["MICROEMPRESA", "EPP", "GRANDES"]),
    })
    porte?: "MICROEMPRESA" | "EPP" | "GRANDES",
    @Option({
      flags: "--opened-from <date>",
      description: "Preview filter: opening-date lower bound, YYYY-MM-DD",
      schema: isoDateString(),
    })
    dataInicioMin?: string,
    @Option({
      flags: "--opened-to <date>",
      description: "Preview filter: opening-date upper bound, YYYY-MM-DD",
      schema: isoDateString(),
    })
    dataInicioMax?: string,
    @Option({
      flags: "--page <n>",
      description: "Preview provider page, >=1",
      schema: integerString(1, 1_000_000),
    })
    page?: string,
    @Option({
      flags: "-l, --limit <n>",
      description: `Preview size, 1-${CNPJ_CRM_EXPORT_LIMIT} (default: 20)`,
      schema: integerString(1, CNPJ_CRM_EXPORT_LIMIT),
    })
    limit?: string,
    @Option({
      flags: "--cnpjs <list>",
      description: "Apply-only comma-separated explicit CNPJ selection, maximum 100",
    })
    cnpjs?: string,
    @Option({ flags: "--owner <type:id>", description: "Required CRM owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--apply", description: "Write the pinned selection to CRM; default is dry-run" }) apply?: boolean,
    @Option({
      flags: "--selection-hash <sha256>",
      description: "Apply-only hash emitted by the dry-run preview",
    })
    selectionHash?: string,
    @Option({
      flags: "--origin-filters <json>",
      description: "Apply-only provenance JSON emitted inside the dry-run nextCommand",
    })
    originFilters?: string,
    @Option(baseUrlOption) baseUrl?: string,
    @Option(timeoutOption) timeoutMs?: string,
    @Option(jsonOption) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => {
      assertCanExportToCrm();
      const resolvedOwner = parseCnpjCrmOwner(owner ?? "");
      if (apply) {
        if (
          hasRawDiscoveryFilter({ q, uf, cnae, cidade, capitalMin, capitalMax, porte, dataInicioMin, dataInicioMax })
        ) {
          throw cliError(
            "APPLY_FILTERS_FORBIDDEN",
            "--apply cannot select accounts from discovery filters.",
            "Use --cnpjs with the exact dry-run selection; preserve filters only in --origin-filters.",
          );
        }
        if (page !== undefined || limit !== undefined) {
          throw cliError(
            "APPLY_PAGINATION_FORBIDDEN",
            "--apply does not accept --page or --limit.",
            "Apply the explicit --cnpjs selection emitted by the preview.",
          );
        }
        const selection = normalizePinnedCnpjs([cnpjs ?? ""]);
        const expectedHash = cnpjSelectionHash(selection);
        if (selectionHash !== expectedHash) {
          throw cliError(
            "SELECTION_HASH_MISMATCH",
            "The explicit CNPJ selection does not match --selection-hash.",
            "Run a new dry-run and copy its complete nextCommand without editing the pinned list.",
          );
        }
        const provenance = parseOriginFilters(originFilters);
        const result = await applyCnpjCrmSelection(this.client(baseUrl, timeoutMs), this.crm, {
          cnpjs: selection,
          owner: resolvedOwner,
          originFilters: provenance,
          selectionHash: expectedHash,
        });
        return {
          success: true as const,
          mode: "apply" as const,
          source: exportSource(true),
          owner: resolvedOwner,
          selectionHash: expectedHash,
          originFilters: provenance,
          ...result,
        };
      }

      if (cnpjs !== undefined || selectionHash !== undefined || originFilters !== undefined) {
        throw cliError(
          "DRY_RUN_SELECTION_FORBIDDEN",
          "--cnpjs, --selection-hash and --origin-filters are apply-only.",
          "Use discovery filters for preview, or add --apply with the complete pinned nextCommand.",
        );
      }
      const filters: CnpjSearchParams & { page: number; limit: number } = {
        ...(q ? { q } : {}),
        ...(uf ? { uf } : {}),
        ...(cnae ? { cnae } : {}),
        ...(cidade ? { cidade } : {}),
        ...(capitalMin ? { capitalMin: Number(capitalMin) } : {}),
        ...(capitalMax ? { capitalMax: Number(capitalMax) } : {}),
        ...(porte ? { porte } : {}),
        ...(dataInicioMin ? { dataInicioMin } : {}),
        ...(dataInicioMax ? { dataInicioMax } : {}),
        page: integer(page, 1),
        limit: integer(limit, 20),
      };
      requireDiscoveryFilter(filters);
      const response = await this.client(baseUrl, timeoutMs).search(filters);
      const dedupe = buildCnpjCrmCandidates(response.itens);
      const pinnedCnpjs = dedupe.candidates.map((candidate) => candidate.cnpj);
      const hash = cnpjSelectionHash(pinnedCnpjs);
      const provenance = compactOriginFilters(filters);
      return {
        success: true as const,
        mode: "dry-run" as const,
        source: exportSource(false),
        owner: resolvedOwner,
        filters,
        candidates: dedupe.candidates,
        dedupe: {
          inputCount: dedupe.inputCount,
          uniqueCount: dedupe.candidates.length,
          removedDuplicates: dedupe.removedDuplicates,
        },
        selectionHash: hash,
        nextCommand:
          pinnedCnpjs.length === 0
            ? null
            : buildExportApplyCommand({
                cnpjs: pinnedCnpjs,
                owner: `${resolvedOwner.type}:${resolvedOwner.id}`,
                selectionHash: hash,
                originFilters: provenance,
                baseUrl,
                timeoutMs,
              }),
      };
    });
  }

  private client(baseUrl: string | undefined, timeoutMs?: string): CnpjServerClient {
    return this.clientFactory({
      baseUrl: baseUrl ?? "",
      timeoutMs: integer(timeoutMs, 10_000),
    });
  }

  private async execute<T>(asJson: boolean | undefined, operation: () => Promise<T>): Promise<T> {
    try {
      const payload = await operation();
      void asJson;
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      return fail(cnpjError(error));
    }
  }
}

function source() {
  return {
    app: "cnpj-server" as const,
    transport: "tailscale" as const,
    baseUrl: CNPJ_TAILSCALE_BASE_URL,
    readOnly: true as const,
  };
}

function exportSource(crmMutation: boolean) {
  return {
    ...source(),
    crmMutation,
  };
}

function assertCanExportToCrm(): void {
  const scopeContext = getScopeContext();
  if (!isScopeEnforced(scopeContext) || canWriteContacts(scopeContext)) return;
  throw new CnpjServerError({
    code: "PERMISSION_DENIED",
    category: "autorizar",
    retryable: false,
    message: `Permission denied: agent:${scopeContext.agentId ?? "unknown"} requires write_contacts`,
    nextAction: "Obtain write_contacts for system:* or run only CNPJ read commands.",
  });
}

function requireDiscoveryFilter(filters: CnpjSearchParams): void {
  if (
    hasRawDiscoveryFilter({
      q: filters.q,
      uf: filters.uf,
      cnae: filters.cnae,
      cidade: filters.cidade,
      capitalMin: filters.capitalMin,
      capitalMax: filters.capitalMax,
      porte: filters.porte,
      dataInicioMin: filters.dataInicioMin,
      dataInicioMax: filters.dataInicioMax,
    })
  ) {
    return;
  }
  throw cliError(
    "INVALID_SEARCH",
    "At least one discovery filter is required.",
    "Add --query, --uf, --cnae, --city, a capital range, --size, or an opening-date bound.",
  );
}

function hasRawDiscoveryFilter(filters: {
  q?: string;
  uf?: string;
  cnae?: string;
  cidade?: string;
  capitalMin?: string | number;
  capitalMax?: string | number;
  porte?: string;
  dataInicioMin?: string;
  dataInicioMax?: string;
}): boolean {
  return Object.values(filters).some((value) => value !== undefined && String(value).trim() !== "");
}

function parseOriginFilters(value: string | undefined): Record<string, unknown> {
  if (!value) {
    throw cliError(
      "INVALID_SEARCH",
      "--apply requires --origin-filters from the dry-run preview.",
      "Copy the complete nextCommand emitted by a new dry-run.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw cliError(
      "INVALID_SEARCH",
      "--origin-filters must be a JSON object.",
      "Copy the complete --origin-filters value from the dry-run nextCommand.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliError(
      "INVALID_SEARCH",
      "--origin-filters must be a JSON object.",
      "Copy the complete --origin-filters value from the dry-run nextCommand.",
    );
  }
  return parsed as Record<string, unknown>;
}

function cliError(code: ConstructorParameters<typeof CnpjServerError>[0]["code"], message: string, nextAction: string) {
  return new CnpjServerError({
    code,
    category: "corrigir",
    retryable: false,
    message,
    nextAction,
  });
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) fail("Expected an integer value.");
  return parsed;
}

function integerString(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/)
    .refine((value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= min && parsed <= max;
    }, `Expected an integer from ${min} to ${max}.`);
}

function nonNegativeNumberString() {
  return z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Expected a non-negative decimal number.");
}

function isoDateString() {
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");
}

function cnpjError(error: unknown): string {
  if (error instanceof CnpjServerError) return JSON.stringify(error.toJSON());
  return JSON.stringify({
    code: "UNEXPECTED_ERROR",
    category: "parar",
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
    nextAction: "Stop and inspect the command contract before retrying.",
  });
}

function buildNextCommand(
  query: CnpjSearchParams & { page: number; limit: number },
  nextPage: number,
  baseUrl: string | undefined,
  timeoutMs: string | undefined,
): string {
  const args = ["ravi", "cnpj", "search"];
  pushArg(args, "--query", query.q);
  pushArg(args, "--uf", query.uf);
  pushArg(args, "--cnae", query.cnae);
  pushArg(args, "--city", query.cidade);
  pushArg(args, "--capital-min", query.capitalMin);
  pushArg(args, "--capital-max", query.capitalMax);
  pushArg(args, "--size", query.porte);
  pushArg(args, "--opened-from", query.dataInicioMin);
  pushArg(args, "--opened-to", query.dataInicioMax);
  pushArg(args, "--page", nextPage);
  pushArg(args, "--limit", query.limit);
  pushArg(args, "--base-url", baseUrl ?? CNPJ_TAILSCALE_BASE_URL);
  if (timeoutMs !== undefined) pushArg(args, "--timeout-ms", timeoutMs);
  args.push("--json");
  return args.map(shellToken).join(" ");
}

function buildExportApplyCommand(input: {
  cnpjs: string[];
  owner: string;
  selectionHash: string;
  originFilters: Record<string, unknown>;
  baseUrl: string | undefined;
  timeoutMs: string | undefined;
}): string {
  const args = ["ravi", "cnpj", "export-crm"];
  pushArg(args, "--cnpjs", input.cnpjs.join(","));
  pushArg(args, "--owner", input.owner);
  pushArg(args, "--selection-hash", input.selectionHash);
  pushArg(args, "--origin-filters", JSON.stringify(input.originFilters));
  pushArg(args, "--base-url", input.baseUrl ?? CNPJ_TAILSCALE_BASE_URL);
  if (input.timeoutMs !== undefined) pushArg(args, "--timeout-ms", input.timeoutMs);
  args.push("--apply", "--json");
  return args.map(shellToken).join(" ");
}

function pushArg(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined || value === "") return;
  args.push(flag, String(value));
}

function shellToken(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readHelp(use: string, doNotUse: string, examples: string[], onError: string, sourceText: string): string {
  return `
USE
  ${use}

NÃO USE
  ${doNotUse}

REGRAS HARD
  • READ-ONLY: this app only performs HTTP GET requests.
  • baseUrl is mandatory and must equal ${CNPJ_TAILSCALE_BASE_URL}.
  • No TLS bypass, public-host fallback, auto-pagination or automatic retry.
  • REGRAS HARD > INPUT HUMANO > CONVENÇÕES > REGRAS AGENTS.md.

EXAMPLES
${examples.map((example) => `  ${example}`).join("\n")}

ON ERROR
  ${onError}
  Errors expose code, category, retryable, message and nextAction.

FORMATO
  --json returns one typed object. Search limit is 1-100 and dates use YYYY-MM-DD. Exit codes: 0 success, 1 error.

FONTES
  ${sourceText}
`;
}

function exportCrmHelp(): string {
  return `
USE
  Preview a bounded CNPJ search, then create or reuse the exact pinned companies as CRM lead accounts.

NÃO USE
  Do not create contacts or opportunities, apply from filters alone, auto-paginate, or write to the CNPJ Server.

REGRAS HARD
  • Default is dry-run. --apply requires --cnpjs, --selection-hash, --owner and the exact private --base-url.
  • Apply rejects discovery filters and pagination; filters survive only as inert --origin-filters provenance.
  • Maximum ${CNPJ_CRM_EXPORT_LIMIT} unique accounts. No automatic retry on CNPJ reads or CRM writes.
  • Account and confirmed CNPJ fact use deterministic idempotency keys; reruns reuse prior state.
  • The CNPJ Server remains GET-only. CRM mutation requires write_contacts and risk=medium.
  • REGRAS HARD > INPUT HUMANO > CONVENÇÕES > REGRAS AGENTS.md.

HITL OBRIGATÓRIO
  Review candidates, dedupe and selectionHash from dry-run before executing nextCommand with --apply.

LIFECYCLE
  dry-run filters → pinned CNPJ list + hash → explicit apply → CRM lead accounts + confirmed CNPJ facts.

EXAMPLES
  ravi cnpj export-crm --uf SP --cnae 1340500 --owner agent:main --limit 20 --base-url ${CNPJ_TAILSCALE_BASE_URL} --json
  ravi cnpj export-crm --cnpjs 00000000000191 --owner agent:main --selection-hash sha256:<hash> --origin-filters '{}' --base-url ${CNPJ_TAILSCALE_BASE_URL} --apply --json

ON ERROR
  INVALID_OWNER|INVALID_CNPJ_SELECTION → correct input; no write was attempted.
  SELECTION_HASH_MISMATCH → run a new preview and copy its complete nextCommand.
  TIMEOUT|UPSTREAM_UNAVAILABLE → inspect the failed item; do not retry the full batch automatically.
  CRM_EXPORT_FAILED → reconcile the account/fact idempotency keys before retrying that explicit CNPJ.

PIPELINE
  CNPJ Server bounded read → pinned preview → Ravi CRM account + confirmed cnpj fact → ravi crm accounts.

SEE ALSO
  ravi cnpj search --help
  ravi crm accounts --help

FORMATO
  Dry-run returns candidates, dedupe, selectionHash and nextCommand. Apply returns completed|partial|failed per-item results.

FONTES
  Owner expansion recorded 2026-07-28; contacts/crm and contacts/crm/authorization specs; CNPJ Server 0.9.1-beta contract.
`;
}
