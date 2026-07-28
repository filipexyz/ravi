import { z } from "zod";

export const CNPJ_TAILSCALE_BASE_URL = "http://100.77.169.127:8090";
export const DEFAULT_CNPJ_TIMEOUT_MS = 10_000;

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

export const cnpjCompanySchema = z
  .object({
    cnpj_base: z.string().regex(/^\d{8}$/),
    razao_social: z.string(),
    natureza_juridica: nullableNumber,
    qualificacao_responsavel: nullableNumber,
    capital_social: z.number(),
    porte_empresa: nullableNumber,
    ente_federativo_responsavel: nullableString,
  })
  .strict();

export const cnpjEstablishmentSchema = z
  .object({
    cnpj_completo: z.string().refine(isValidCnpj, "CNPJ check digits are invalid"),
    cnpj_base: z.string().regex(/^\d{8}$/),
    cnpj_ordem: z.string().regex(/^\d{4}$/),
    cnpj_dv: z.string().regex(/^\d{2}$/),
    matriz_filial: z.number(),
    nome_fantasia: nullableString,
    situacao_cadastral: z.number(),
    data_situacao_cadastral: nullableString,
    motivo_situacao_cadastral: nullableNumber,
    nome_cidade_exterior: nullableString,
    pais_codigo: nullableNumber,
    data_inicio_atividade: nullableString,
    cnae_principal: nullableString,
    cnae_secundarios: nullableString,
    tipo_logradouro: nullableString,
    logradouro: nullableString,
    numero: nullableString,
    complemento: nullableString,
    bairro: nullableString,
    cep: nullableString,
    uf: nullableString,
    municipio_codigo: nullableNumber,
    ddd_1: nullableString,
    telefone_1: nullableString,
    ddd_2: nullableString,
    telefone_2: nullableString,
    email: nullableString,
  })
  .strict();

export const cnpjPartnerSchema = z
  .object({
    identificador_socio: nullableNumber,
    nome_socio: z.string(),
    cpf_cnpj_socio: nullableString,
    qualificacao_socio: nullableNumber,
    data_entrada: nullableString,
  })
  .strict();

export const cnpjSimplesSchema = z
  .object({
    opcao_simples: nullableString,
    data_opcao_simples: nullableString,
    data_exclusao_simples: nullableString,
    opcao_mei: nullableString,
    data_opcao_mei: nullableString,
    data_exclusao_mei: nullableString,
  })
  .strict();

export const cnpjFullResponseSchema = z
  .object({
    empresa: cnpjCompanySchema,
    estabelecimento: cnpjEstablishmentSchema,
    simples: cnpjSimplesSchema.optional(),
    socios: z.array(cnpjPartnerSchema),
  })
  .strict();

export const cnpjSearchItemSchema = z
  .object({
    cnpj_completo: z.string().refine(isValidCnpj, "CNPJ check digits are invalid"),
    razao_social: z.string(),
    nome_fantasia: nullableString,
    uf: nullableString,
    cnae_principal: nullableString,
    situacao_cadastral: z.number(),
    data_inicio_atividade: nullableString.optional(),
  })
  .strict();

export const cnpjSearchResponseSchema = z
  .object({
    motor: z.string().optional(),
    pagina: z.number().int().min(1),
    resultados: z.number().int().min(0),
    itens: z.array(cnpjSearchItemSchema).max(100),
  })
  .strict();

export type CnpjFullResponse = z.infer<typeof cnpjFullResponseSchema>;
export type CnpjSearchResponse = z.infer<typeof cnpjSearchResponseSchema>;

export interface CnpjSearchParams {
  q?: string;
  uf?: string;
  cnae?: string;
  cidade?: string;
  capitalMin?: number;
  capitalMax?: number;
  porte?: "MICROEMPRESA" | "EPP" | "GRANDES";
  dataInicioMin?: string;
  dataInicioMax?: string;
  page?: number;
  limit?: number;
}

export type CnpjErrorCategory = "corrigir" | "retry" | "autorizar" | "parar";

export interface CnpjErrorEnvelope {
  code:
    | "INVALID_ENDPOINT"
    | "INVALID_CNPJ"
    | "INVALID_SEARCH"
    | "NOT_FOUND"
    | "UPSTREAM_REJECTED"
    | "UPSTREAM_UNAVAILABLE"
    | "TIMEOUT"
    | "TRANSPORT_ERROR"
    | "INVALID_RESPONSE"
    | "INVALID_OWNER"
    | "CNPJ_SELECTION_REQUIRED"
    | "CNPJ_SELECTION_TOO_LARGE"
    | "INVALID_CNPJ_SELECTION"
    | "INVALID_UPSTREAM_CNPJ"
    | "SELECTION_HASH_MISMATCH"
    | "APPLY_FILTERS_FORBIDDEN"
    | "APPLY_PAGINATION_FORBIDDEN"
    | "DRY_RUN_SELECTION_FORBIDDEN"
    | "PERMISSION_DENIED"
    | "CRM_EXPORT_FAILED";
  category: CnpjErrorCategory;
  retryable: boolean;
  message: string;
  nextAction: string;
}

export class CnpjServerError extends Error {
  constructor(readonly details: CnpjErrorEnvelope) {
    super(details.message);
    this.name = "CnpjServerError";
  }

  toJSON(): CnpjErrorEnvelope {
    return this.details;
  }
}

export interface CnpjServerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CnpjHealth {
  app: "cnpj-server";
  ready: true;
  readOnly: true;
  transport: "tailscale";
  baseUrl: typeof CNPJ_TAILSCALE_BASE_URL;
  externalCheckPerformed: true;
  latencyMs: number;
  engine?: string;
  returned: number;
  totalResults: number;
}

export class CnpjServerClient {
  readonly baseUrl: typeof CNPJ_TAILSCALE_BASE_URL;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: CnpjServerClientOptions) {
    this.baseUrl = validateCnpjBaseUrl(options.baseUrl);
    this.timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_CNPJ_TIMEOUT_MS);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async health(): Promise<CnpjHealth> {
    const startedAt = this.now();
    const response = await this.search({ page: 1, limit: 1 });
    return {
      app: "cnpj-server",
      ready: true,
      readOnly: true,
      transport: "tailscale",
      baseUrl: this.baseUrl,
      externalCheckPerformed: true,
      latencyMs: Math.max(0, this.now() - startedAt),
      ...(response.motor ? { engine: response.motor } : {}),
      returned: response.itens.length,
      totalResults: response.resultados,
    };
  }

  async show(cnpj: string): Promise<CnpjFullResponse> {
    const normalized = normalizeCnpj(cnpj);
    if (!isValidCnpj(normalized)) {
      throw appError({
        code: "INVALID_CNPJ",
        category: "corrigir",
        retryable: false,
        message: "CNPJ must contain 14 digits with valid Receita Federal check digits.",
        nextAction: "Correct the CNPJ and run the same read-only command again.",
      });
    }

    const response = await this.request(`/api/v1/cnpj/${normalized}`, cnpjFullResponseSchema, normalized);
    const returned = response.estabelecimento.cnpj_completo;
    const reconstructed =
      response.estabelecimento.cnpj_base + response.estabelecimento.cnpj_ordem + response.estabelecimento.cnpj_dv;
    if (
      returned !== normalized ||
      reconstructed !== returned ||
      response.empresa.cnpj_base !== response.estabelecimento.cnpj_base
    ) {
      throw invalidResponse("CNPJ Server returned company identity fields that do not match the requested CNPJ.");
    }
    return response;
  }

  async search(params: CnpjSearchParams = {}): Promise<CnpjSearchResponse> {
    const validated = validateSearchParams(params);
    const search = new URLSearchParams();
    append(search, "q", validated.q);
    append(search, "uf", validated.uf);
    append(search, "cnae", validated.cnae);
    append(search, "cidade", validated.cidade);
    append(search, "capital_min", validated.capitalMin);
    append(search, "capital_max", validated.capitalMax);
    append(search, "porte", validated.porte);
    append(search, "data_inicio_min", validated.dataInicioMin);
    append(search, "data_inicio_max", validated.dataInicioMax);
    append(search, "page", validated.page);
    append(search, "limit", validated.limit);

    const response = await this.request(`/api/v1/busca?${search.toString()}`, cnpjSearchResponseSchema);
    if (response.pagina !== validated.page) {
      throw invalidResponse("CNPJ Server returned a page that does not match the requested page.");
    }
    if (response.itens.length > validated.limit) {
      throw invalidResponse("CNPJ Server returned more items than the requested limit.");
    }
    return response;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, notFoundValue?: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "ravi/cnpj-server-app/0.1.0",
        },
      });

      if (!response.ok) {
        throw responseError(response.status, notFoundValue);
      }

      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw invalidResponse("CNPJ Server returned a non-JSON response.");
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw invalidResponse(`CNPJ Server response failed schema validation at ${firstIssuePath(parsed.error)}.`);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof CnpjServerError) throw error;
      if (isAbortError(error)) {
        throw appError({
          code: "TIMEOUT",
          category: "retry",
          retryable: true,
          message: `CNPJ Server did not respond within ${this.timeoutMs}ms.`,
          nextAction: "Confirm Tailscale connectivity, then retry the same read-only command.",
        });
      }
      throw appError({
        code: "TRANSPORT_ERROR",
        category: "retry",
        retryable: true,
        message: "Could not reach the validated private CNPJ Server endpoint.",
        nextAction: "Confirm this host is connected to the tailnet, then retry without changing the endpoint.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function validateCnpjBaseUrl(input: string): typeof CNPJ_TAILSCALE_BASE_URL {
  const value = input?.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidEndpoint();
  }

  const valid =
    url.protocol === "http:" &&
    url.hostname === "100.77.169.127" &&
    url.port === "8090" &&
    (url.pathname === "" || url.pathname === "/") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;

  if (!valid || url.origin !== CNPJ_TAILSCALE_BASE_URL) {
    throw invalidEndpoint();
  }
  return CNPJ_TAILSCALE_BASE_URL;
}

export function normalizeCnpj(value: string): string {
  return value.replace(/\D/g, "");
}

export function isValidCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const first = checkDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (digits[12] !== first) return false;
  const second = checkDigit([...digits.slice(0, 12), first], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return digits[13] === second;
}

function checkDigit(digits: number[], weights: number[]): number {
  const remainder = digits.reduce((sum, digit, index) => sum + digit * (weights[index] ?? 0), 0) % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

function validateSearchParams(
  params: CnpjSearchParams,
): Required<Pick<CnpjSearchParams, "page" | "limit">> & Omit<CnpjSearchParams, "page" | "limit"> {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  if (!Number.isInteger(page) || page < 1) {
    throw invalidSearch("page must be an integer greater than or equal to 1.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalidSearch("limit must be an integer from 1 to 100.");
  }
  if (params.uf !== undefined && !/^[A-Z]{2}$/.test(params.uf)) {
    throw invalidSearch("uf must be a two-letter uppercase Brazilian state code.");
  }
  if (params.capitalMin !== undefined && (!Number.isFinite(params.capitalMin) || params.capitalMin < 0)) {
    throw invalidSearch("capitalMin must be a non-negative number.");
  }
  if (params.capitalMax !== undefined && (!Number.isFinite(params.capitalMax) || params.capitalMax < 0)) {
    throw invalidSearch("capitalMax must be a non-negative number.");
  }
  if (params.capitalMin !== undefined && params.capitalMax !== undefined && params.capitalMin > params.capitalMax) {
    throw invalidSearch("capitalMin cannot be greater than capitalMax.");
  }
  for (const [field, value] of [
    ["dataInicioMin", params.dataInicioMin],
    ["dataInicioMax", params.dataInicioMax],
  ] as const) {
    if (value !== undefined && !isIsoDate(value)) {
      throw invalidSearch(`${field} must use a valid YYYY-MM-DD date.`);
    }
  }
  if (
    params.dataInicioMin !== undefined &&
    params.dataInicioMax !== undefined &&
    params.dataInicioMin > params.dataInicioMax
  ) {
    throw invalidSearch("dataInicioMin cannot be later than dataInicioMax.");
  }
  return { ...params, page, limit };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 30_000) {
    throw invalidSearch("timeoutMs must be an integer from 100 to 30000.");
  }
  return value;
}

function append(search: URLSearchParams, key: string, value: string | number | undefined): void {
  if (value !== undefined && value !== "") search.set(key, String(value));
}

function responseError(status: number, notFoundValue?: string): CnpjServerError {
  if (status === 404) {
    return appError({
      code: "NOT_FOUND",
      category: "parar",
      retryable: false,
      message: notFoundValue ? `CNPJ ${notFoundValue} was not found.` : "CNPJ Server resource was not found.",
      nextAction: "Verify the identifier or search filters; retrying the same input will not change the result.",
    });
  }
  if (status === 429 || status >= 500) {
    return appError({
      code: "UPSTREAM_UNAVAILABLE",
      category: "retry",
      retryable: true,
      message: `CNPJ Server returned HTTP ${status}.`,
      nextAction: "Wait before retrying the same read-only command; the app does not retry automatically.",
    });
  }
  return appError({
    code: "UPSTREAM_REJECTED",
    category: "parar",
    retryable: false,
    message: `CNPJ Server rejected the read request with HTTP ${status}.`,
    nextAction: "Review the input contract before trying a corrected request.",
  });
}

function invalidEndpoint(): CnpjServerError {
  return appError({
    code: "INVALID_ENDPOINT",
    category: "autorizar",
    retryable: false,
    message: `baseUrl must be the validated Tailscale endpoint ${CNPJ_TAILSCALE_BASE_URL}.`,
    nextAction: `Use --base-url ${CNPJ_TAILSCALE_BASE_URL}; do not bypass TLS or substitute another host.`,
  });
}

function invalidSearch(message: string): CnpjServerError {
  return appError({
    code: "INVALID_SEARCH",
    category: "corrigir",
    retryable: false,
    message,
    nextAction: "Correct the search arguments using `ravi cnpj search --help`.",
  });
}

function invalidResponse(message: string): CnpjServerError {
  return appError({
    code: "INVALID_RESPONSE",
    category: "parar",
    retryable: false,
    message,
    nextAction: "Stop and inspect the upstream contract before relying on this response.",
  });
}

function appError(details: CnpjErrorEnvelope): CnpjServerError {
  return new CnpjServerError(details);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function firstIssuePath(error: z.ZodError): string {
  const path = error.issues[0]?.path;
  return path && path.length > 0 ? path.join(".") : "response";
}
