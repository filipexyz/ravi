import { createHash } from "node:crypto";
import { z } from "zod";
import type { TinyTenantConfig } from "./config.js";
import { TINY_V2_QUOTA, TINY_V3_QUOTA, publicTinyQuota, type TinyQuotaPolicy } from "./quota.js";

export const TINY_WRITE_OPERATIONS = [
  "contato-incluir",
  "contato-alterar",
  "produto-incluir",
  "produto-alterar",
  "pedido-incluir",
  "pedido-alterar",
  "pedido-situacao",
  "estoque-atualizar",
  "nota-emitir",
  "conta-receber-incluir",
  "conta-receber-baixar",
  "conta-receber-estornar",
  "conta-pagar-incluir",
  "conta-pagar-baixar",
  "conta-pagar-estornar",
  "webhook-incluir",
  "oc-criar",
] as const;

export type TinyWriteOperation = (typeof TINY_WRITE_OPERATIONS)[number];

export interface TinyWriteContract {
  apiVersion: "v2" | "v3";
  method: "POST";
  path: string;
  permission: "tiny:write" | "tiny:destructive";
  risk: "medium" | "high" | "destructive";
  schemaRef: string;
  officialDoc: string | null;
  officialDocEvidence: "verified" | "gap";
  legacyCommand: string;
  validator: z.ZodType<Record<string, unknown>>;
  legacyGap: string | null;
}

const decimalString = z.string().regex(/^\d+(?:\.\d+)?$/, "use decimal com ponto, por exemplo 5.25");
const idString = z.string().regex(/^\d+$/, "use o ID numerico interno do Tiny");
const dateBr = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, "use data DD/MM/YYYY");
const situationPedido = z.enum([
  "aberto",
  "aprovado",
  "preparando_envio",
  "faturado",
  "pronto_envio",
  "enviado",
  "entregue",
  "nao_entregue",
  "cancelado",
]);

const contracts: Record<TinyWriteOperation, TinyWriteContract> = {
  "contato-incluir": {
    apiVersion: "v2",
    method: "POST",
    path: "/contato.incluir.php",
    permission: "tiny:write",
    risk: "high",
    schemaRef: "schemas/contato-incluir.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-contatos-incluir",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny contato-incluir",
    validator: z
      .object({
        contato: z
          .object({
            nome: z.string().min(1).max(50),
            situacao: z.enum(["A", "I", "S"]),
            tipo_pessoa: z.enum(["F", "J", "E"]).optional(),
            cpf_cnpj: z.string().min(1).max(18).optional(),
          })
          .passthrough(),
      })
      .strict(),
    legacyGap:
      "O help legado trata tipo_pessoa/cpf_cnpj como minimos, enquanto a doc oficial exige nome/situacao/sequencia; o App injeta sequencia somente na futura camada de transporte.",
  },
  "contato-alterar": {
    apiVersion: "v2",
    method: "POST",
    path: "/contato.alterar.php",
    permission: "tiny:write",
    risk: "high",
    schemaRef: "schemas/contato-alterar.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-contatos-alterar",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny contato-alterar",
    validator: z.object({ contato: z.object({ id: idString }).passthrough() }).strict(),
    legacyGap: "O preview exige ID explicito e nunca aplica PATCH live nesta fase.",
  },
  "produto-incluir": {
    apiVersion: "v2",
    method: "POST",
    path: "/produto.incluir.php",
    permission: "tiny:write",
    risk: "high",
    schemaRef: "schemas/produto-incluir.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-produtos-incluir",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny produto-incluir",
    validator: z
      .object({
        produto: z
          .object({
            nome: z.string().min(1).max(120),
            unidade: z.string().min(1).max(3),
            preco: decimalString,
            origem: z.string().min(1).max(1),
            situacao: z.enum(["A", "I"]),
            tipo: z.enum(["P", "S"]),
          })
          .passthrough(),
      })
      .strict(),
    legacyGap: null,
  },
  "produto-alterar": {
    apiVersion: "v2",
    method: "POST",
    path: "/produto.alterar.php",
    permission: "tiny:write",
    risk: "high",
    schemaRef: "schemas/produto-alterar.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-produtos-alterar",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny produto-alterar",
    validator: z.object({ produto: z.object({ id: idString }).passthrough() }).strict(),
    legacyGap: "O preview exige ID explicito; reconciliacao por SKU e obrigatoria antes de live.",
  },
  "pedido-incluir": {
    apiVersion: "v2",
    method: "POST",
    path: "/pedido.incluir.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/pedido-incluir.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-pedidos-incluir",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny pedido-incluir",
    validator: z
      .object({
        pedido: z
          .object({
            cliente: z.record(z.string(), z.unknown()),
            itens: z.array(z.record(z.string(), z.unknown())).min(1),
            situacao: situationPedido.optional(),
          })
          .passthrough(),
      })
      .strict(),
    legacyGap: "O adapter futuro deve manter atualizar_cliente=N; nenhuma execucao foi habilitada nesta fase.",
  },
  "pedido-alterar": {
    apiVersion: "v2",
    method: "POST",
    path: "/pedido.alterar.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/pedido-alterar.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-pedidos-alterar",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny pedido-alterar",
    validator: z.object({ idPedido: idString, dadosPedido: z.record(z.string(), z.unknown()) }).strict(),
    legacyGap: "A futura execucao deve obter o pedido antes e reconciliar o shape completo apos alteracao.",
  },
  "pedido-situacao": {
    apiVersion: "v2",
    method: "POST",
    path: "/pedido.alterar.situacao.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/pedido-situacao.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-pedidos-alterar-situacao",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny pedido-situacao",
    validator: z.object({ idPedido: idString, situacao: situationPedido }).strict(),
    legacyGap: "Transicao de situacao depende do estado atual e nao pode ter retry automatico.",
  },
  "estoque-atualizar": {
    apiVersion: "v2",
    method: "POST",
    path: "/produto.atualizar.estoque.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/estoque-atualizar.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-produtos-atualizar-estoque",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny estoque-atualizar",
    validator: z
      .object({
        idProduto: idString,
        quantidade: decimalString,
        tipo: z.enum(["B", "E", "S"]),
        observacoes: z.string().max(100).optional(),
      })
      .strict(),
    legacyGap: "O App exige tipo explicito; nao reproduz o default perigoso B do legado.",
  },
  "nota-emitir": {
    apiVersion: "v2",
    method: "POST",
    path: "/nota.fiscal.emitir.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/nota-emitir.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-notas-fiscais-emitir",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny nota-emitir",
    validator: z.object({ idNota: idString }).strict(),
    legacyGap: null,
  },
  "conta-receber-incluir": {
    apiVersion: "v2",
    method: "POST",
    path: "/conta.receber.incluir.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/conta-receber-incluir.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-contas-receber-incluir",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny conta-receber-incluir",
    validator: z
      .object({
        conta: z
          .object({ idContato: idString, dataEmissao: dateBr, dataVencimento: dateBr, valor: decimalString })
          .passthrough(),
      })
      .strict(),
    legacyGap: "Inclusao financeira nao e idempotente; reconciliar numeroDocumento/idContato antes de live.",
  },
  "conta-receber-baixar": {
    apiVersion: "v2",
    method: "POST",
    path: "/conta.receber.baixar.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/conta-receber-baixar.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-contas-receber-baixar",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny conta-receber-baixar",
    validator: z
      .object({
        idConta: idString,
        data: dateBr,
        valorPago: decimalString,
        historico: z.string().max(300).optional(),
      })
      .strict(),
    legacyGap:
      "A doc oficial usa conta.data/valorPago; o SDE envia data_pagamento/valor e relata validacao empirica. Cutover depende de shadow controlado, sem write nesta task.",
  },
  "conta-receber-estornar": {
    apiVersion: "v2",
    method: "POST",
    path: "/conta.receber.estornar.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/conta-receber-estornar.schema.json",
    officialDoc: null,
    officialDocEvidence: "gap",
    legacyCommand: "sde tiny conta-receber-estornar",
    validator: z.object({ idConta: idString }).strict(),
    legacyGap:
      "Sem evidencia oficial imutavel do endpoint; o comando legado nao promove o contrato. Estorno exige precondicao pago/parcial, before/after e aprovacao humana individual.",
  },
  "conta-pagar-incluir": {
    apiVersion: "v2",
    method: "POST",
    path: "/conta.pagar.incluir.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/conta-pagar-incluir.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-contas-pagar-incluir",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny conta-pagar-incluir",
    validator: z
      .object({ conta: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0) })
      .strict(),
    legacyGap: "Inclusao financeira nao e idempotente; reconciliar o documento antes de live.",
  },
  "conta-pagar-baixar": {
    apiVersion: "v2",
    method: "POST",
    path: "/conta.pagar.baixar.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/conta-pagar-baixar.schema.json",
    officialDoc: "https://tiny.com.br/api-docs/api2-contas-pagar-baixar",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny conta-pagar-baixar",
    validator: z
      .object({ idConta: idString, data: dateBr, valorPago: decimalString, historico: z.string().max(300).optional() })
      .strict(),
    legacyGap: "Baixa exige precondicao aberto/parcial e reconciliacao financeira antes de qualquer retry.",
  },
  "conta-pagar-estornar": {
    apiVersion: "v2",
    method: "POST",
    path: "/conta.pagar.estornar.php",
    permission: "tiny:destructive",
    risk: "destructive",
    schemaRef: "schemas/conta-pagar-estornar.schema.json",
    officialDoc: null,
    officialDocEvidence: "gap",
    legacyCommand: "sde tiny conta-pagar-estornar",
    validator: z.object({ idConta: idString }).strict(),
    legacyGap:
      "Sem evidencia oficial imutavel do endpoint; o comando legado e a falha F-09 nao promovem o contrato. Operacao permanece NO-GO live ate prova oficial controlada.",
  },
  "webhook-incluir": {
    apiVersion: "v2",
    method: "POST",
    path: "/webhook.incluir.php",
    permission: "tiny:destructive",
    risk: "high",
    schemaRef: "schemas/webhook-incluir.schema.json",
    officialDoc: null,
    officialDocEvidence: "gap",
    legacyCommand: "sde tiny webhook-incluir",
    validator: z
      .object({
        url: z
          .string()
          .url()
          .refine((value) => value.startsWith("https://"), "use URL HTTPS"),
        evento: z.string().min(1),
      })
      .strict(),
    legacyGap:
      "A busca oficial nao localizou pagina publica v2 para webhook.incluir.php; contrato permanece NO-GO para execucao.",
  },
  "oc-criar": {
    apiVersion: "v3",
    method: "POST",
    path: "/ordem-compra",
    permission: "tiny:destructive",
    risk: "high",
    schemaRef: "schemas/oc-criar.schema.json",
    officialDoc: "https://api-docs.erp.olist.com/api-reference/ordem-de-compra/criar-ordem-de-compra",
    officialDocEvidence: "verified",
    legacyCommand: "sde tiny oc-criar",
    validator: z
      .object({
        contato: z.object({ id: z.number().int().positive() }).strict(),
        data: z.string().min(1),
        itens: z.array(z.record(z.string(), z.unknown())).min(1),
      })
      .passthrough(),
    legacyGap:
      "O lifecycle OAuth/refresh esta implementado e testado no broker, mas consentimento, segredo e conexao live nao foram materializados; somente contrato/preview esta habilitado.",
  },
};

export interface TinyWritePlan {
  ok: true;
  dryRun: true;
  executionEnabled: false;
  networkCalled: false;
  tenant: string;
  operation: TinyWriteOperation;
  apiVersion: "v2" | "v3";
  method: "POST";
  endpoint: string;
  authentication: {
    provider: "tiny";
    connection: string;
    mode: "legacy-token-form" | "oauth2-bearer";
    secretResolved: false;
  };
  permission: "tiny:write" | "tiny:destructive";
  risk: "medium" | "high" | "destructive";
  hitlRequired: true;
  confirmationRequired: true;
  idempotent: false;
  input: {
    schemaRef: string;
    validated: true;
    topLevelFields: string[];
    sha256: string;
    valuesExposed: false;
  };
  quota: {
    policy: TinyQuotaPolicy;
  };
  provenance: {
    officialDoc: string | null;
    supportingOfficialDocs: string[];
    apiVersion: "v2" | "v3";
    endpointEvidenceStatus: "established" | "gap";
    confidence: "high" | "low";
    owner: string | null;
    liveGate: "documented" | "no-go";
    legacyCommand: string;
    legacyGap: string | null;
    verifiedAt: "2026-07-14";
  };
}

export function isTinyWriteOperation(value: string): value is TinyWriteOperation {
  return (TINY_WRITE_OPERATIONS as readonly string[]).includes(value);
}

export function getTinyWriteContract(operation: TinyWriteOperation): Omit<TinyWriteContract, "validator"> {
  const { validator: _validator, ...contract } = contracts[operation];
  return { ...contract };
}

export function hasVerifiedOfficialWriteSource(
  contract: Pick<TinyWriteContract, "officialDoc" | "officialDocEvidence">,
): contract is Pick<TinyWriteContract, "officialDoc" | "officialDocEvidence"> & { officialDoc: string } {
  return (
    contract.officialDocEvidence === "verified" &&
    typeof contract.officialDoc === "string" &&
    contract.officialDoc.length > 0
  );
}

export function buildTinyWritePlan(
  config: TinyTenantConfig,
  operation: TinyWriteOperation,
  input: unknown,
): TinyWritePlan {
  const contract = contracts[operation];
  const documented = hasVerifiedOfficialWriteSource(contract);
  if (config.apiVersion !== contract.apiVersion) {
    throw new Error(`${operation} exige tenant apiVersion ${contract.apiVersion}; recebido ${config.apiVersion}.`);
  }
  const parsed = contract.validator.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "input";
    throw new Error(`Input Tiny invalido para ${operation} em ${path}: ${issue?.message ?? "schema invalido"}.`);
  }

  const payload = parsed.data;
  const quotaPolicy = quotaPolicyFor(operation, contract.apiVersion);
  return {
    ok: true,
    dryRun: true,
    executionEnabled: false,
    networkCalled: false,
    tenant: config.tenant,
    operation,
    apiVersion: contract.apiVersion,
    method: contract.method,
    endpoint: `${config.baseUrl}${contract.path}`,
    authentication: {
      provider: config.credentialProvider,
      connection: config.credentialConnection,
      mode: contract.apiVersion === "v2" ? "legacy-token-form" : "oauth2-bearer",
      secretResolved: false,
    },
    permission: contract.permission,
    risk: contract.risk,
    hitlRequired: true,
    confirmationRequired: true,
    idempotent: false,
    input: {
      schemaRef: contract.schemaRef,
      validated: true,
      topLevelFields: Object.keys(payload).sort(),
      sha256: createHash("sha256")
        .update(JSON.stringify(sortValue(payload)))
        .digest("hex"),
      valuesExposed: false,
    },
    quota: {
      policy: quotaPolicy,
    },
    provenance: {
      officialDoc: contract.officialDoc,
      supportingOfficialDocs:
        operation === "webhook-incluir"
          ? ["https://tiny.com.br/api-docs/api2-webhooks", "https://tiny.com.br/api-docs/api2-webhooks-tiny"]
          : quotaPolicy.officialDocs,
      apiVersion: contract.apiVersion,
      endpointEvidenceStatus: documented ? "established" : "gap",
      confidence: documented ? "high" : "low",
      owner: documented ? null : "ravi-dev+researcher",
      liveGate: documented ? "documented" : "no-go",
      legacyCommand: contract.legacyCommand,
      legacyGap: contract.legacyGap,
      verifiedAt: "2026-07-14",
    },
  };
}

function quotaPolicyFor(operation: TinyWriteOperation, apiVersion: "v2" | "v3"): TinyQuotaPolicy {
  const policy = publicTinyQuota(apiVersion === "v2" ? TINY_V2_QUOTA : TINY_V3_QUOTA);
  const contract = contracts[operation];
  if (hasVerifiedOfficialWriteSource(contract)) return policy;
  return {
    ...policy,
    status: "unknown",
    publishedPlanLimitsPerMinute: null,
    batch: null,
    recommendedMaxConcurrencyFraction: null,
    observeHeaders: [],
    officialDocs:
      operation === "webhook-incluir"
        ? ["https://tiny.com.br/api-docs/api2-webhooks", "https://tiny.com.br/api-docs/api2-webhooks-tiny"]
        : policy.officialDocs,
    evidenceStatus: "gap",
    unknownReason:
      operation === "webhook-incluir"
        ? "A documentacao oficial localizada descreve configuracao em UI e eventos, nao registro REST."
        : `Nao ha evidencia oficial imutavel do contrato e da quota especifica de ${operation}.`,
    closureOwner: "ravi-dev+researcher",
    liveGate: "no-go",
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
