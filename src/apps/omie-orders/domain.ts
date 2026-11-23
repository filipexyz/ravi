import { createHash } from "node:crypto";

export type Action = "list" | "get" | "stages" | "create" | "update" | "move" | "delete";
export const ACTIONS: Action[] = ["list", "get", "stages", "create", "update", "move", "delete"];
export const WRITES = new Set<Action>(["create", "update", "move", "delete"]);
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 1,
  ) {
    super(message);
  }
}
export function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new AppError("INVALID_INPUT", message, 2);
}
export function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  requireValue(
    value !== undefined && value !== "" && Number.isSafeInteger(n) && n >= min && n <= max,
    `${label}: inteiro entre ${min} e ${max}.`,
  );
  return n;
}
export function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function rejectSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    requireValue(
      !/secret|password|token|app_key|credential|__proto__|constructor|prototype/i.test(key),
      "Campo reservado ou de credencial não permitido.",
    );
    rejectSecrets(child);
  }
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (object(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function revision(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export interface Input {
  page?: number;
  limit?: number;
  id?: number;
  stage?: string;
  order?: Record<string, any>;
  ifMatch?: string;
  idempotencyKey?: string;
  confirmed?: boolean;
}
export interface RequestPlan {
  action: Action;
  method: string;
  endpoint: "pedido" | "etapafat";
  param: Record<string, any>;
  input: Input;
  mutating: boolean;
}

export function plan(action: Action, input: Input): RequestPlan {
  requireValue(ACTIONS.includes(action), "Operação desconhecida. Use help.");
  rejectSecrets(input);
  const mutating = WRITES.has(action);
  if (mutating) {
    requireValue(
      typeof input.idempotencyKey === "string" && /^[A-Za-z0-9._:-]{8,60}$/.test(input.idempotencyKey),
      "Informe idempotency-key de 8 a 60 caracteres.",
    );
    if (action !== "create")
      requireValue(
        typeof input.ifMatch === "string" && /^[a-f0-9]{64}$/.test(input.ifMatch),
        "Informe if-match obtido em get.",
      );
  }
  let method = "",
    endpoint: "pedido" | "etapafat" = "pedido",
    param: Record<string, any> = {};
  if (action === "list" || action === "stages") {
    param = {
      pagina: integer(input.page ?? 1, "page"),
      registros_por_pagina: integer(input.limit ?? 50, "limit", 1, 100),
    };
    if (action === "list") {
      method = "ListarPedidos";
      param.apenas_importado_api = "N";
    } else {
      method = "ListarEtapasFaturamento";
      endpoint = "etapafat";
    }
  } else if (action === "get") {
    method = "ConsultarPedido";
    param.codigo_pedido = integer(input.id, "id interno Omie (não número visível)");
  } else if (action === "move") {
    // Stage 50 can enter invoicing; fiscal operations are deliberately outside v1.
    requireValue(
      ["10", "20", "30", "40"].includes(input.stage ?? ""),
      "stage: 10, 20, 30 ou 40. Faturamento não faz parte desta versão.",
    );
    method = "TrocarEtapaPedido";
    param = { codigo_pedido: integer(input.id, "id"), etapa: input.stage };
  } else if (action === "delete") {
    method = "ExcluirPedido";
    param.codigo_pedido = integer(input.id, "id");
  } else {
    requireValue(object(input.order) && object(input.order.cabecalho), "order exige cabecalho.");
    requireValue(
      Array.isArray(input.order.det) && input.order.det.length > 0 && input.order.det.length <= 500,
      "order.det: de 1 a 500 itens.",
    );
    const allowed = new Set([
      "cabecalho",
      "det",
      "frete",
      "informacoes_adicionais",
      "lista_parcelas",
      "observacoes",
      "departamentos",
    ]);
    requireValue(
      Object.keys(input.order).every((k) => allowed.has(k)),
      "Campo raiz não permitido em order.",
    );
    const header = input.order.cabecalho;
    requireValue(
      ["10", "20", "30", "40"].includes(header.etapa),
      "cabecalho.etapa: 10 a 40; operação fiscal não suportada.",
    );
    integer(header.codigo_cliente, "codigo_cliente");
    requireValue(/^\d{2}\/\d{2}\/\d{4}$/.test(header.data_previsao ?? ""), "data_previsao: DD/MM/AAAA.");
    const [day, month, year] = header.data_previsao.split("/").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    requireValue(
      year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day,
      "data_previsao deve ser uma data válida.",
    );
    for (const item of input.order.det) {
      requireValue(object(item) && object(item.produto), "Item exige produto.");
      integer(item.produto.codigo_produto, "codigo_produto");
      requireValue(
        typeof item.produto.quantidade === "number" &&
          Number.isFinite(item.produto.quantidade) &&
          item.produto.quantidade > 0,
        "quantidade deve ser positiva.",
      );
      requireValue(
        typeof item.produto.valor_unitario === "number" &&
          Number.isFinite(item.produto.valor_unitario) &&
          item.produto.valor_unitario >= 0,
        "valor_unitario inválido.",
      );
    }
    param = structuredClone(input.order);
    if (action === "create") {
      requireValue(!header.codigo_pedido, "create não aceita codigo_pedido.");
      requireValue(
        !header.codigo_pedido_integracao || header.codigo_pedido_integracao === input.idempotencyKey,
        "codigo_pedido_integracao deve coincidir com idempotency-key.",
      );
      param.cabecalho.codigo_pedido_integracao = input.idempotencyKey;
      method = "IncluirPedido";
    } else {
      const id = integer(input.id, "id");
      requireValue(!header.codigo_pedido || header.codigo_pedido === id, "ID do payload difere de id.");
      param.cabecalho.codigo_pedido = id;
      method = "AlterarPedidoVenda";
    }
    param.cabecalho.quantidade_itens = param.det.length;
    requireValue(
      !param.informacoes_adicionais?.enviar_email || param.informacoes_adicionais.enviar_email === "N",
      "Envio de e-mail não autorizado nesta operação.",
    );
    param.informacoes_adicionais = { ...param.informacoes_adicionais, enviar_email: "N" };
  }
  return { action, method, endpoint, param, input, mutating };
}

export function summary(order: any) {
  requireValue(object(order) && object(order.cabecalho), "Resposta Omie sem cabeçalho.");
  const h = order.cabecalho,
    i = order.infoCadastro ?? {},
    t = order.total_pedido ?? {};
  return {
    id: h.codigo_pedido,
    number: h.numero_pedido,
    stage: h.etapa,
    amount: t.valor_total_pedido ?? null,
    includedDate: i.dInc ?? null,
    includedTime: i.hInc ?? null,
    cancelled: i.cancelado === "S",
    invoiced: i.faturado === "S",
    revision: revision(order),
  };
}
