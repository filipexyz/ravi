import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCrmAccountCards, listCrmFacts } from "../../contacts.js";
import { CnpjServerError, type CnpjFullResponse, type CnpjServerClient } from "./client.js";
import { applyCnpjCrmSelection, cnpjSelectionHash, defaultCnpjCrmAdapter, normalizePinnedCnpjs } from "./crm-export.js";

const previousStateDir = process.env.RAVI_STATE_DIR;
let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-cnpj-crm-"));
  process.env.RAVI_STATE_DIR = stateDir;
});

afterEach(() => {
  mock.restore();
  if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("CNPJ Server CRM export", () => {
  it("creates one account and one confirmed fact, then reuses both on rerun", async () => {
    const cnpjs = normalizePinnedCnpjs(["00.000.000/0001-91"]);
    const show = mock(async (cnpj: string) => company(cnpj));
    const client = { show } as Pick<CnpjServerClient, "show">;
    const input = {
      cnpjs,
      owner: { type: "agent" as const, id: "main" },
      originFilters: { uf: "DF", limit: 20 },
      selectionHash: cnpjSelectionHash(cnpjs),
    };

    const first = await applyCnpjCrmSelection(client, defaultCnpjCrmAdapter, input);
    const second = await applyCnpjCrmSelection(client, defaultCnpjCrmAdapter, input);
    const accounts = listCrmAccountCards({ source: "cnpj-server", lifecycle: "lead" });
    const facts = listCrmFacts({
      accountId: first.results[0]?.status === "created-or-reused" ? first.results[0].accountId : "",
    });

    expect(first).toMatchObject({ status: "completed", requested: 1, applied: 1, failed: 0 });
    expect(second).toMatchObject({ status: "completed", requested: 1, applied: 1, failed: 0 });
    expect(first.results[0]).toMatchObject(second.results[0] ?? {});
    expect(accounts.total).toBe(1);
    expect(accounts.items[0]).toMatchObject({
      name: "BANCO DO BRASIL",
      lifecycle: "lead",
      source: "cnpj-server",
      ownerType: "agent",
      ownerId: "main",
    });
    expect(facts.total).toBe(1);
    expect(facts.items[0]).toMatchObject({
      key: "cnpj",
      value: "00000000000191",
      status: "confirmed",
      source: "cnpj-server",
    });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("returns a partial receipt without retrying a failed CNPJ", async () => {
    const cnpjs = normalizePinnedCnpjs(["00000000000191", "33000167000101"]);
    const show = mock(async (cnpj: string) => {
      if (cnpj === "33000167000101") {
        throw new CnpjServerError({
          code: "UPSTREAM_UNAVAILABLE",
          category: "retry",
          retryable: true,
          message: "CNPJ Server returned HTTP 503.",
          nextAction: "Retry only this explicit identifier after reconciling the partial receipt.",
        });
      }
      return company(cnpj);
    });

    const result = await applyCnpjCrmSelection({ show } as Pick<CnpjServerClient, "show">, defaultCnpjCrmAdapter, {
      cnpjs,
      owner: { type: "team", id: "sales" },
      originFilters: { cnae: "6422100" },
      selectionHash: cnpjSelectionHash(cnpjs),
    });

    expect(result).toMatchObject({ status: "partial", requested: 2, applied: 1, failed: 1 });
    expect(result.results[1]).toMatchObject({
      cnpj: "33000167000101",
      status: "failed",
      error: { code: "UPSTREAM_UNAVAILABLE", retryable: true },
    });
    expect(show).toHaveBeenCalledTimes(2);
    expect(listCrmAccountCards({ source: "cnpj-server" }).total).toBe(1);
  });

  it("rejects an invalid or oversized selection before any lookup", () => {
    expect(() => normalizePinnedCnpjs(["00.000.000/0001-00"])).toThrow("invalid CNPJ check digits");
    expect(() => normalizePinnedCnpjs(Array.from({ length: 101 }, (_, index) => `${index}`.padStart(14, "0")))).toThrow(
      "at most 100",
    );
  });
});

function company(cnpj: string): CnpjFullResponse {
  return {
    empresa: {
      cnpj_base: cnpj.slice(0, 8),
      razao_social: "BANCO DO BRASIL SA",
      natureza_juridica: 2038,
      qualificacao_responsavel: 10,
      capital_social: 1_000,
      porte_empresa: 5,
      ente_federativo_responsavel: null,
    },
    estabelecimento: {
      cnpj_completo: cnpj,
      cnpj_base: cnpj.slice(0, 8),
      cnpj_ordem: cnpj.slice(8, 12),
      cnpj_dv: cnpj.slice(12),
      matriz_filial: 1,
      nome_fantasia: "BANCO DO BRASIL",
      situacao_cadastral: 2,
      data_situacao_cadastral: "2005-11-03",
      motivo_situacao_cadastral: 0,
      nome_cidade_exterior: null,
      pais_codigo: null,
      data_inicio_atividade: "1966-08-01",
      cnae_principal: "6422100",
      cnae_secundarios: null,
      tipo_logradouro: "SETOR",
      logradouro: "SAUN",
      numero: "5",
      complemento: null,
      bairro: "ASA NORTE",
      cep: "70040912",
      uf: "DF",
      municipio_codigo: 9701,
      ddd_1: "61",
      telefone_1: "00000000",
      ddd_2: null,
      telefone_2: null,
      email: null,
    },
    simples: {
      opcao_simples: "N",
      data_opcao_simples: null,
      data_exclusao_simples: null,
      opcao_mei: "N",
      data_opcao_mei: null,
      data_exclusao_mei: null,
    },
    socios: [],
  };
}
