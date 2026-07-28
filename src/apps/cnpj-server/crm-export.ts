import { createHash } from "node:crypto";
import {
  createCrmAccount,
  proposeCrmFact,
  type CreateCrmAccountInput,
  type CrmAccount,
  type CrmFact,
  type ProposeCrmFactInput,
} from "../../contacts.js";
import {
  CNPJ_TAILSCALE_BASE_URL,
  CnpjServerError,
  isValidCnpj,
  normalizeCnpj,
  type CnpjErrorEnvelope,
  type CnpjFullResponse,
  type CnpjSearchParams,
  type CnpjServerClient,
} from "./client.js";

export const CNPJ_CRM_EXPORT_LIMIT = 100;

export type CnpjCrmOwnerType = "user" | "agent" | "team" | "system";

export interface CnpjCrmOwner {
  type: CnpjCrmOwnerType;
  id: string;
}

export interface CnpjCrmCandidate {
  cnpj: string;
  name: string;
  legalName: string;
  industry: string | null;
  uf: string | null;
  registrationStatus: number;
  openedAt: string | null;
}

export interface CnpjCrmAdapter {
  createAccount(input: CreateCrmAccountInput): CrmAccount;
  confirmFact(input: ProposeCrmFactInput): CrmFact;
}

export interface ApplyCnpjCrmSelectionInput {
  cnpjs: string[];
  owner: CnpjCrmOwner;
  originFilters: Record<string, unknown>;
  selectionHash: string;
}

export interface CnpjCrmApplySuccess {
  cnpj: string;
  status: "created-or-reused";
  accountId: string;
  factId: string;
}

export interface CnpjCrmApplyFailure {
  cnpj: string;
  status: "failed";
  error: CnpjErrorEnvelope;
}

export interface CnpjCrmApplyResult {
  status: "completed" | "partial" | "failed";
  requested: number;
  applied: number;
  failed: number;
  results: Array<CnpjCrmApplySuccess | CnpjCrmApplyFailure>;
}

export const defaultCnpjCrmAdapter: CnpjCrmAdapter = {
  createAccount: createCrmAccount,
  confirmFact: proposeCrmFact,
};

export function parseCnpjCrmOwner(value: string): CnpjCrmOwner {
  const match = /^(user|agent|team|system):(.+)$/.exec(value.trim());
  if (!match || !match[2]?.trim()) {
    throw exportError(
      "INVALID_OWNER",
      "owner must use type:id with type user, agent, team, or system.",
      "Correct --owner using a value such as agent:main.",
    );
  }
  return { type: match[1] as CnpjCrmOwnerType, id: match[2].trim() };
}

export function normalizePinnedCnpjs(values: string[]): string[] {
  const normalized = values
    .flatMap((value) => value.split(","))
    .map(normalizeCnpj)
    .filter(Boolean);
  const unique = [...new Set(normalized)];
  if (unique.length === 0) {
    throw exportError(
      "CNPJ_SELECTION_REQUIRED",
      "--apply requires at least one explicit CNPJ in --cnpjs.",
      "Run export-crm without --apply first, then use its pinned nextCommand.",
    );
  }
  if (unique.length > CNPJ_CRM_EXPORT_LIMIT) {
    throw exportError(
      "CNPJ_SELECTION_TOO_LARGE",
      `A CRM export may contain at most ${CNPJ_CRM_EXPORT_LIMIT} unique CNPJs.`,
      "Split the explicit selection into smaller batches without auto-pagination.",
    );
  }
  const invalid = unique.filter((cnpj) => !isValidCnpj(cnpj));
  if (invalid.length > 0) {
    throw exportError(
      "INVALID_CNPJ_SELECTION",
      `The pinned selection contains invalid CNPJ check digits: ${invalid.join(", ")}.`,
      "Correct the invalid identifiers before running --apply; no CRM write was attempted.",
    );
  }
  return unique;
}

export function buildCnpjCrmCandidates(
  items: Array<{
    cnpj_completo: string;
    razao_social: string;
    nome_fantasia: string | null;
    uf: string | null;
    cnae_principal: string | null;
    situacao_cadastral: number;
    data_inicio_atividade?: string | null;
  }>,
): { candidates: CnpjCrmCandidate[]; inputCount: number; removedDuplicates: number } {
  const candidates = new Map<string, CnpjCrmCandidate>();
  for (const item of items) {
    const cnpj = normalizeCnpj(item.cnpj_completo);
    if (!isValidCnpj(cnpj)) {
      throw exportError(
        "INVALID_UPSTREAM_CNPJ",
        "CNPJ Server returned an item with invalid CNPJ check digits.",
        "Stop the export and reconcile the upstream response before creating CRM accounts.",
      );
    }
    if (candidates.has(cnpj)) continue;
    candidates.set(cnpj, {
      cnpj,
      name: item.nome_fantasia?.trim() || item.razao_social,
      legalName: item.razao_social,
      industry: item.cnae_principal,
      uf: item.uf,
      registrationStatus: item.situacao_cadastral,
      openedAt: item.data_inicio_atividade ?? null,
    });
  }
  return {
    candidates: [...candidates.values()],
    inputCount: items.length,
    removedDuplicates: items.length - candidates.size,
  };
}

export function cnpjSelectionHash(cnpjs: string[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(cnpjs)).digest("hex")}`;
}

export async function applyCnpjCrmSelection(
  client: Pick<CnpjServerClient, "show">,
  crm: CnpjCrmAdapter,
  input: ApplyCnpjCrmSelectionInput,
): Promise<CnpjCrmApplyResult> {
  const results: Array<CnpjCrmApplySuccess | CnpjCrmApplyFailure> = [];
  for (const cnpj of input.cnpjs) {
    try {
      const data = await client.show(cnpj);
      const evidence = buildEvidence(cnpj, data, input.originFilters, input.selectionHash);
      const account = crm.createAccount({
        name: data.estabelecimento.nome_fantasia?.trim() || data.empresa.razao_social,
        legalName: data.empresa.razao_social,
        industry: data.estabelecimento.cnae_principal,
        lifecycle: "lead",
        ownerType: input.owner.type,
        ownerId: input.owner.id,
        source: "cnpj-server",
        actorType: "system",
        idempotencyKey: `cnpj-server:account:${cnpj}`,
        evidence,
        metadata: evidence,
      });
      const fact = crm.confirmFact({
        entityType: "account",
        entityId: account.id,
        accountId: account.id,
        key: "cnpj",
        value: cnpj,
        status: "confirmed",
        source: "cnpj-server",
        actorType: "system",
        idempotencyKey: `cnpj-server:fact:cnpj:${cnpj}`,
        confidence: 1,
        evidence,
        metadata: {
          provider: "cnpj-server",
          selectionHash: input.selectionHash,
        },
      });
      results.push({
        cnpj,
        status: "created-or-reused",
        accountId: account.id,
        factId: fact.id,
      });
    } catch (error) {
      results.push({
        cnpj,
        status: "failed",
        error: exportFailure(error),
      });
    }
  }
  const applied = results.filter((result) => result.status === "created-or-reused").length;
  const failed = results.length - applied;
  return {
    status: failed === 0 ? "completed" : applied === 0 ? "failed" : "partial",
    requested: input.cnpjs.length,
    applied,
    failed,
    results,
  };
}

function buildEvidence(
  cnpj: string,
  data: CnpjFullResponse,
  originFilters: Record<string, unknown>,
  selectionHash: string,
): Record<string, unknown> {
  return {
    provider: "cnpj-server",
    endpoint: CNPJ_TAILSCALE_BASE_URL,
    cnpj,
    uf: data.estabelecimento.uf,
    registrationStatus: data.estabelecimento.situacao_cadastral,
    openedAt: data.estabelecimento.data_inicio_atividade,
    originFilters,
    selectionHash,
    observedAt: new Date().toISOString(),
  };
}

function exportFailure(error: unknown): CnpjErrorEnvelope {
  if (error instanceof CnpjServerError) return error.toJSON();
  return {
    code: "CRM_EXPORT_FAILED",
    category: "parar",
    retryable: false,
    message: "CRM account or confirmed-fact mutation failed for the explicit CNPJ.",
    nextAction: "Inspect the failed CNPJ result and reconcile CRM state before retrying that explicit identifier.",
  };
}

function exportError(code: CnpjErrorEnvelope["code"], message: string, nextAction: string): CnpjServerError {
  return new CnpjServerError({
    code,
    category: "corrigir",
    retryable: false,
    message,
    nextAction,
  });
}

export function compactOriginFilters(filters: CnpjSearchParams): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}
