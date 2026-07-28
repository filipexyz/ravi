import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CNPJ_TAILSCALE_BASE_URL,
  CnpjServerClient,
  CnpjServerError,
  isValidCnpj,
  validateCnpjBaseUrl,
} from "./client.js";

type RequestRecord = { url: URL; init: RequestInit };

afterEach(() => mock.restore());

function fakeFetch(handler: (request: RequestRecord) => Response | Promise<Response>): typeof fetch {
  return mock(async (input: string | URL | Request, init: RequestInit = {}) =>
    handler({ url: new URL(String(input)), init }),
  ) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fullCompanyResponse() {
  return {
    empresa: {
      cnpj_base: "00000000",
      razao_social: "BANCO DO BRASIL SA",
      natureza_juridica: 2038,
      qualificacao_responsavel: 10,
      capital_social: 1000,
      porte_empresa: 5,
      ente_federativo_responsavel: null,
    },
    estabelecimento: {
      cnpj_completo: "00000000000191",
      cnpj_base: "00000000",
      cnpj_ordem: "0001",
      cnpj_dv: "91",
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

describe("CnpjServerClient", () => {
  it("accepts only the exact validated Tailscale endpoint", () => {
    expect(validateCnpjBaseUrl(CNPJ_TAILSCALE_BASE_URL)).toBe(CNPJ_TAILSCALE_BASE_URL);
    expect(validateCnpjBaseUrl(`${CNPJ_TAILSCALE_BASE_URL}/`)).toBe(CNPJ_TAILSCALE_BASE_URL);

    for (const rejected of [
      "",
      "https://cnpj.sdebot.top",
      "http://oneplus:8090",
      "http://127.0.0.1:8090",
      "https://100.77.169.127:8090",
      "http://user:pass@100.77.169.127:8090",
      "http://100.77.169.127:8090/api",
      "http://100.77.169.127:8090?unsafe=true",
    ]) {
      expect(() => validateCnpjBaseUrl(rejected)).toThrow(CnpjServerError);
    }
  });

  it("normalizes and validates a CNPJ before one GET request", async () => {
    const requests: RequestRecord[] = [];
    const fetch = fakeFetch((request) => {
      requests.push(request);
      return json(fullCompanyResponse());
    });
    const client = new CnpjServerClient({ baseUrl: CNPJ_TAILSCALE_BASE_URL, fetch });

    const result = await client.show("00.000.000/0001-91");

    expect(isValidCnpj("00000000000191")).toBe(true);
    expect(result.empresa.razao_social).toBe("BANCO DO BRASIL SA");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe(`${CNPJ_TAILSCALE_BASE_URL}/api/v1/cnpj/00000000000191`);
    expect(requests[0]?.init.method).toBe("GET");
  });

  it("rejects an invalid CNPJ before fetch", async () => {
    const fetch = fakeFetch(() => {
      throw new Error("invalid CNPJ must fail before fetch");
    });
    const client = new CnpjServerClient({ baseUrl: CNPJ_TAILSCALE_BASE_URL, fetch });

    await expect(client.show("00.000.000/0001-00")).rejects.toMatchObject({
      details: { code: "INVALID_CNPJ", category: "corrigir", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the sanitized raw live empty-search envelope with an absent optional engine", async () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, "__fixtures__", "search-empty.real.json"), "utf8"),
    ) as unknown;
    const fetch = fakeFetch(() => json(fixture));
    const client = new CnpjServerClient({ baseUrl: CNPJ_TAILSCALE_BASE_URL, fetch });

    const result = await client.search({ page: 1, limit: 1 });

    expect(result).toEqual({
      itens: [],
      pagina: 1,
      resultados: 0,
    });
  });

  it("maps every supported 0.9.1-beta filter to one bounded request", async () => {
    let request: RequestRecord | undefined;
    const fetch = fakeFetch((record) => {
      request = record;
      return json({ motor: "FTS5", itens: [], pagina: 2, resultados: 0 });
    });
    const client = new CnpjServerClient({ baseUrl: CNPJ_TAILSCALE_BASE_URL, fetch });

    await client.search({
      q: "embalagens",
      uf: "SP",
      cnae: "1340500",
      cidade: "Sao Paulo",
      capitalMin: 1000,
      capitalMax: 5000,
      porte: "EPP",
      dataInicioMin: "2026-01-01",
      dataInicioMax: "2026-06-30",
      page: 2,
      limit: 25,
    });

    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      q: "embalagens",
      uf: "SP",
      cnae: "1340500",
      cidade: "Sao Paulo",
      capital_min: "1000",
      capital_max: "5000",
      porte: "EPP",
      data_inicio_min: "2026-01-01",
      data_inicio_max: "2026-06-30",
      page: "2",
      limit: "25",
    });
  });

  it("blocks invalid ranges before fetch", async () => {
    const fetch = fakeFetch(() => {
      throw new Error("invalid search must fail before fetch");
    });
    const client = new CnpjServerClient({ baseUrl: CNPJ_TAILSCALE_BASE_URL, fetch });

    await expect(client.search({ limit: 101 })).rejects.toMatchObject({
      details: { code: "INVALID_SEARCH", retryable: false },
    });
    await expect(client.search({ capitalMin: 10, capitalMax: 5 })).rejects.toMatchObject({
      details: { code: "INVALID_SEARCH", retryable: false },
    });
    await expect(client.search({ dataInicioMin: "2026-02-30" })).rejects.toMatchObject({
      details: { code: "INVALID_SEARCH", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("performs a bounded live-style health probe and reports deterministic latency", async () => {
    const fetch = fakeFetch((request) => {
      expect(request.url.searchParams.get("page")).toBe("1");
      expect(request.url.searchParams.get("limit")).toBe("1");
      return json({ itens: [], pagina: 1, resultados: 0 });
    });
    const times = [100, 137];
    const client = new CnpjServerClient({
      baseUrl: CNPJ_TAILSCALE_BASE_URL,
      fetch,
      now: () => times.shift() ?? 137,
    });

    expect(await client.health()).toEqual({
      app: "cnpj-server",
      ready: true,
      readOnly: true,
      transport: "tailscale",
      baseUrl: CNPJ_TAILSCALE_BASE_URL,
      externalCheckPerformed: true,
      latencyMs: 37,
      returned: 0,
      totalResults: 0,
    });
  });

  it("does not automatically retry 404, 429 or 5xx responses", async () => {
    for (const [status, code, retryable] of [
      [404, "NOT_FOUND", false],
      [429, "UPSTREAM_UNAVAILABLE", true],
      [503, "UPSTREAM_UNAVAILABLE", true],
    ] as const) {
      const fetch = fakeFetch(() => new Response("", { status }));
      const client = new CnpjServerClient({ baseUrl: CNPJ_TAILSCALE_BASE_URL, fetch });

      await expect(client.show("00.000.000/0001-91")).rejects.toMatchObject({
        details: { code, retryable },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      mock.restore();
    }
  });

  it("returns typed timeout and invalid-response errors", async () => {
    const timeoutFetch = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const timeoutClient = new CnpjServerClient({
      baseUrl: CNPJ_TAILSCALE_BASE_URL,
      timeoutMs: 100,
      fetch: timeoutFetch,
    });
    await expect(timeoutClient.search()).rejects.toMatchObject({
      details: { code: "TIMEOUT", retryable: true },
    });

    const malformedClient = new CnpjServerClient({
      baseUrl: CNPJ_TAILSCALE_BASE_URL,
      fetch: fakeFetch(() => json({ pagina: 1, resultados: 1 })),
    });
    await expect(malformedClient.search()).rejects.toMatchObject({
      details: { code: "INVALID_RESPONSE", retryable: false },
    });
  });
});
