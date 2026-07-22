import type { TinyTenantConfig } from "./config.js";
import { isTinyReadWaveOneOperation, type TinyReadInput } from "./read-contracts.js";
import { TINY_V2_QUOTA, publicTinyQuota } from "./quota.js";

export interface TinyRequestPlan {
  tenant: string;
  apiVersion: "v2";
  method: "POST";
  endpoint: string;
  credentialSource: "broker";
  credentialProvider: "tiny";
  credentialConnection: string;
  credentialConfigured: boolean;
  mutating: false;
}

export interface TinyClientOptions {
  config: TinyTenantConfig;
  credential: string | null;
  fetchImpl?: TinyFetch;
  timeoutMs?: number;
}

export type TinyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class TinyApiError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly vendorCode?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    details: {
      code: string;
      httpStatus?: number;
      vendorCode?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      requestId?: string;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = "TinyApiError";
    this.code = details.code;
    this.httpStatus = details.httpStatus;
    this.vendorCode = details.vendorCode;
    this.retryable = details.retryable === true;
    this.retryAfterMs = details.retryAfterMs;
    this.requestId = details.requestId;
    this.details = details.details;
  }
}

export class TinyClient {
  private readonly config: TinyTenantConfig;
  private readonly credential: string | null;
  private readonly fetchImpl: TinyFetch;
  private readonly timeoutMs: number;

  constructor(options: TinyClientOptions) {
    this.config = options.config;
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  accountInfoPlan(): TinyRequestPlan {
    if (this.config.apiVersion !== "v2") {
      throw new Error("tiny.info suporta somente API v2; use um tenant v2 para plano ou leitura live.");
    }
    return {
      tenant: this.config.tenant,
      apiVersion: "v2",
      method: "POST",
      endpoint: `${this.config.baseUrl}/info.php`,
      credentialSource: "broker",
      credentialProvider: this.config.credentialProvider,
      credentialConnection: this.config.credentialConnection,
      credentialConfigured: this.credential !== null,
      mutating: false,
    };
  }

  async accountInfo(): Promise<unknown> {
    const result = await this.read({
      operation: "info",
      path: "/info.php",
      params: {},
      officialDoc: "https://tiny.com.br/api-docs/api2-info",
      textResponse: null,
    });
    return result.data;
  }

  async read(input: TinyReadInput): Promise<{
    data: unknown;
    quota: {
      policy: ReturnType<typeof publicTinyQuota>;
      observed: { limitPerMinute: number | null; retryAfterSeconds: number | null };
    };
  }> {
    if (this.config.apiVersion !== "v2") {
      throw new TinyApiError(
        `tiny.${input.operation} suporta leitura live apenas em v2; v3 exige lifecycle OAuth no broker.`,
        { code: "TINY_UNSUPPORTED_API", retryable: false },
      );
    }
    if (!this.credential) {
      throw new TinyApiError(`Credencial Tiny ausente para o tenant ${this.config.tenant}.`, {
        code: "TINY_CREDENTIAL_MISSING",
        retryable: false,
      });
    }

    const releaseQuotaSlot = await acquireTinyV2QuotaSlot(this.config.credentialConnection);
    try {
      const body = new URLSearchParams({ token: this.credential, formato: "json", ...input.params });
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.baseUrl}${input.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
          throw new TinyApiError(`Tiny excedeu timeout em ${input.operation}.`, {
            code: "TINY_TIMEOUT",
            retryable: true,
          });
        }
        throw error;
      }
      const retryAfterSeconds = parseHeaderNumber(response.headers.get("retry-after"));
      if (response.status === 429 || response.status === 403) {
        openTinyV2Circuit(this.config.credentialConnection, retryAfterSeconds);
        throw new TinyApiError(`Tiny bloqueou ${input.operation} por quota/autorizacao (HTTP ${response.status}).`, {
          code: response.status === 429 ? "TINY_RATE_LIMIT" : "TINY_FORBIDDEN",
          httpStatus: response.status,
          retryable: response.status === 429,
          ...(retryAfterSeconds !== null ? { retryAfterMs: retryAfterSeconds * 1000 } : {}),
          ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}),
        });
      }
      if (!response.ok) {
        throw new TinyApiError(`Tiny respondeu HTTP ${response.status} em ${input.operation}.`, {
          code:
            response.status === 400
              ? "TINY_BAD_REQUEST"
              : response.status === 401
                ? "TINY_UNAUTHORIZED"
                : response.status === 404
                  ? "TINY_NOT_FOUND"
                  : "TINY_HTTP_ERROR",
          httpStatus: response.status,
          retryable: response.status >= 500,
          ...(retryAfterSeconds !== null ? { retryAfterMs: retryAfterSeconds * 1000 } : {}),
          ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}),
        });
      }

      let data: unknown;
      try {
        data = await parseTinyResponse(response, input);
      } catch (error) {
        if (error instanceof TinyApiError) throw error;
        throw new TinyApiError(`Tiny retornou resposta invalida em ${input.operation}.`, {
          code: "TINY_INVALID_RESPONSE",
          retryable: false,
        });
      }
      let retorno = isRecord(data) && isRecord(data.retorno) ? data.retorno : null;
      if (
        isTinyReadWaveOneOperation(input.operation) &&
        (!retorno || typeof retorno.status_processamento !== "string" || !retorno.status_processamento.trim())
      ) {
        throw new TinyApiError(
          `Tiny retornou envelope invalido em ${input.operation}: status_processamento oficial ausente.`,
          { code: "TINY_INVALID_RESPONSE", retryable: false },
        );
      }
      if (retorno?.status === "Erro" && String(retorno.codigo_erro) === "20") {
        const emptyCollection = emptyCollectionFor(input.operation);
        if (emptyCollection) {
          data = {
            retorno: {
              status: "OK",
              status_processamento: retorno.status_processamento,
              pagina: Number(input.params.pagina ?? "1"),
              numero_paginas: 0,
              [emptyCollection]: [],
            },
          };
          retorno = (data as { retorno: Record<string, unknown> }).retorno;
        }
      }
      if (!retorno || retorno.status !== "OK") {
        const code = retorno && retorno.codigo_erro !== undefined ? ` codigo ${String(retorno.codigo_erro)}` : "";
        throw new TinyApiError(`Tiny recusou ${input.operation} para o tenant ${this.config.tenant}.${code}`, {
          code: "TINY_VENDOR_ERROR",
          ...(retorno?.codigo_erro !== undefined ? { vendorCode: String(retorno.codigo_erro) } : {}),
          retryable: false,
        });
      }
      return {
        data,
        quota: {
          policy: publicTinyQuota(TINY_V2_QUOTA),
          observed: {
            limitPerMinute: parseHeaderNumber(response.headers.get("x-limit-api")),
            retryAfterSeconds,
          },
        },
      };
    } finally {
      releaseQuotaSlot();
    }
  }
}

interface TinyQuotaState {
  lastStartedAt: number;
  blockedUntil: number;
  tail: Promise<void>;
}

const tinyQuotaStates = new Map<string, TinyQuotaState>();

async function acquireTinyV2QuotaSlot(connection: string): Promise<() => void> {
  const state = tinyQuotaStates.get(connection) ?? { lastStartedAt: 0, blockedUntil: 0, tail: Promise.resolve() };
  const previous = state.tail;
  let release = () => {};
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  tinyQuotaStates.set(connection, state);
  await previous;
  try {
    const now = Date.now();
    if (state.blockedUntil > now) {
      throw new TinyApiError(
        `Circuito Tiny aberto para ${connection} apos erro de quota; tente depois do Retry-After.`,
        {
          code: "TINY_CIRCUIT_OPEN",
          retryable: true,
          retryAfterMs: state.blockedUntil - now,
        },
      );
    }
    const waitMs = Math.max(0, state.lastStartedAt + TINY_V2_QUOTA.conservativePolicy.minIntervalMs - now);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    state.lastStartedAt = Date.now();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function openTinyV2Circuit(connection: string, retryAfterSeconds: number | null): void {
  const state = tinyQuotaStates.get(connection) ?? { lastStartedAt: 0, blockedUntil: 0, tail: Promise.resolve() };
  state.blockedUntil = Date.now() + (retryAfterSeconds ?? 60) * 1000;
  tinyQuotaStates.set(connection, state);
}

async function parseTinyResponse(response: Response, input: TinyReadInput): Promise<unknown> {
  if (input.textResponse === "xml_nfe") {
    const text = await response.text();
    const xml = text.match(/<xml_nfe>([\s\S]*?)<\/xml_nfe>/)?.[1];
    if (xml !== undefined) return { retorno: { status: "OK", xml } };
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Tiny retornou resposta invalida em nota-xml; nenhum payload foi registrado.");
    }
  }
  return (await response.json()) as unknown;
}

function parseHeaderNumber(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyCollectionFor(operation: TinyReadInput["operation"]): string | null {
  switch (operation) {
    case "pedidos":
      return "pedidos";
    case "contatos":
      return "contatos";
    case "produtos":
      return "produtos";
    case "notas":
      return "notas_fiscais";
    case "contas-receber":
    case "contas-pagar":
      return "contas";
    case "listas-precos":
      return "listas_precos";
    default:
      return null;
  }
}
