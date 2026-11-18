import { AppError, revision } from "./domain.js";
import { findOperation, rejectCredentials, validateInput, publicResult, type Operation } from "./catalogue.js";

export interface ApiInput {
  params: Record<string, any>;
  idempotencyKey?: string;
  reviewDigest?: string;
  confirmed?: boolean;
  expectedRevision?: string;
}
export interface FullHost {
  // Must check actor, compartment, app and exact operation.permission. App-use
  // or channel membership alone never grants financial/fiscal operations.
  authorize(op: Operation): Promise<{ allowed: boolean; principal: string }>;
  withApplication<T>(
    op: Operation,
    use: (auth: { bearer?: string; app_key?: string; app_secret?: string }) => Promise<T>,
  ): Promise<T>;
  once<T>(key: string, digest: string, effect: () => Promise<T>): Promise<T>;
  guardRevision?(op: Operation, params: Record<string, any>, expected: string): Promise<void>;
  // Only the trusted credential service can obtain/refresh/store tokens. This
  // function returns non-secret lifecycle metadata, never token material.
  manageAuthentication(op: Operation, params: Record<string, any>): Promise<Record<string, unknown>>;
  fetch: typeof fetch;
}
export function prepare(id: string, input: ApiInput) {
  const op = findOperation(id);
  if (!input.params || typeof input.params !== "object" || Array.isArray(input.params))
    throw new AppError("INVALID_INPUT", "params deve ser um objeto JSON.", 2);
  rejectCredentials(input.params);
  const params = structuredClone(input.params);
  if (op.classification === "read") {
    for (const [field, fallback, max] of [
      ["pagina", 1, Number.MAX_SAFE_INTEGER],
      ["nPagina", 1, Number.MAX_SAFE_INTEGER],
      ["registros_por_pagina", 50, 100],
      ["nRegPorPagina", 50, 100],
    ] as const) {
      if (!op.inputSchema.properties?.[field]) continue;
      params[field] ??= fallback;
      if (!Number.isSafeInteger(params[field]) || params[field] < 1 || params[field] > max)
        throw new AppError("OMIE_PAGINATION_INVALID", "Página deve ser positiva e limite de registros de 1 a 100.", 2);
    }
  }
  const missingDocumentedFields = validateInput(params, op.inputSchema);
  const digest = revision({ id: op.id, params, expectedRevision: input.expectedRevision ?? null });
  if (op.classification !== "read" && input.confirmed) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey ?? ""))
      throw new AppError("OMIE_IDEMPOTENCY_REQUIRED", "Escrita exige chave de idempotência estável.", 2);
    if (input.reviewDigest !== digest)
      throw new AppError("OMIE_REVIEW_REQUIRED", "Escrita exige digest da prévia do mesmo conteúdo.", 2);
  }
  return { op, params, digest, missingDocumentedFields };
}
export async function executeApi(host: FullHost, id: string, input: ApiInput): Promise<any> {
  const prepared = prepare(id, input),
    { op, digest, params } = prepared;
  try {
    const authz = await host.authorize(op);
    if (!authz.allowed || !authz.principal)
      throw new AppError("OMIE_OPERATION_DENIED", "Sem permissão para esta operação e módulo.");
    if (op.classification !== "read" && !input.confirmed)
      return {
        success: true,
        dryRun: true,
        operation: op.id,
        classification: op.classification,
        reviewDigest: digest,
        missingDocumentedFields: prepared.missingDocumentedFields,
      };
    const effect = async () => {
      if (input.expectedRevision) {
        if (!host.guardRevision)
          throw new AppError("OMIE_REVISION_GUARD_UNAVAILABLE", "O recurso exige verificação de revisão no host.");
        await host.guardRevision(op, params, input.expectedRevision);
      }
      if (op.classification === "managed-auth")
        return { success: true, operation: op.id, data: publicResult(await host.manageAuthentication(op, params)) };
      return host.withApplication(op, async (credentials) => {
        if (!credentials || (!credentials.bearer && !(credentials.app_key && credentials.app_secret)))
          throw new AppError("OMIE_AUTH_UNAVAILABLE", "Conexão ausente ou desabilitada.");
        if (!/^\/api\/v1\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(op.path))
          throw new AppError("OMIE_ENDPOINT_REJECTED", "Endpoint não permitido.");
        const bearer = credentials.bearer;
        const url = `https://app.omie.com.br${op.path}`;
        const body: any = { call: op.method, param: [params] };
        if (!bearer) {
          body.app_key = credentials.app_key;
          body.app_secret = credentials.app_secret;
        }
        let response: Response;
        try {
          response = await host.fetch(url, {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("OMIE_OUTCOME_UNKNOWN", "Falha de rede. Não repetir escrita sem conferir o resultado.");
        }
        if (response.status === 403 || response.status === 401)
          throw new AppError("OMIE_AUTH_REJECTED", "A autenticação ou a permissão foi recusada.");
        if ([425, 429].includes(response.status))
          throw new AppError("OMIE_RATE_LIMITED", "Limite Omie atingido; não há retry automático.");
        let data: any;
        try {
          const raw = await response.text();
          if (raw.length > 10_000_000) throw new Error();
          data = JSON.parse(raw);
        } catch {
          throw new AppError(
            "OMIE_RESPONSE_INVALID",
            "Resposta do provider inválida. Em escrita, conferir resultado antes de repetir.",
          );
        }
        // StatusPedido and other queries return business-state codes here;
        // a nonzero codigo_status is not a universal API failure indicator.
        const status = data?.codigo_status ?? data?.cCodStatus;
        if (!response.ok || data?.faultstring || data?.faultcode)
          throw new AppError(
            "OMIE_PROVIDER_ERROR",
            "O provider recusou a operação; detalhes sensíveis foram omitidos.",
          );
        return {
          success: true,
          operation: op.id,
          data: publicResult(data),
          revision: revision(data),
          providerStatus: status ?? null,
          businessOutcome:
            op.classification === "read" || status === undefined || /^0+$/.test(String(status))
              ? "response-received"
              : "requires-review",
          pagination: pagination(data),
          missingDocumentedFields: prepared.missingDocumentedFields,
        };
      });
    };
    return await (op.classification === "read"
      ? effect()
      : host.once(`omie:api:${input.idempotencyKey}`, digest, effect));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "OMIE_HOST_ERROR",
      "A fronteira de autorização, credenciais ou idempotência recusou a operação.",
    );
  }
}
function pagination(data: any) {
  const page = data?.pagina ?? data?.nPagina,
    pages = data?.total_de_paginas ?? data?.nTotPaginas;
  return Number.isInteger(page) && Number.isInteger(pages)
    ? { page, totalPages: pages, nextPage: page < pages ? page + 1 : null }
    : null;
}
