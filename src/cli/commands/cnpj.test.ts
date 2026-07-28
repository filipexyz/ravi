import "reflect-metadata";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  CNPJ_TAILSCALE_BASE_URL,
  type CnpjServerClient,
  type CnpjServerClientOptions,
} from "../../apps/cnpj-server/client.js";
import { cnpjSelectionHash, type CnpjCrmAdapter } from "../../apps/cnpj-server/crm-export.js";
import type { ContextRecord } from "../../router/router-db.js";
import { enforceCliCommandAuthorization } from "../command-access.js";
import { runWithContext } from "../context.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
  getScopeMetadata,
} from "../decorators.js";
import { CnpjCommands } from "./cnpj.js";

afterEach(() => mock.restore());

describe("CnpjCommands contract", () => {
  it("registers three typed reads plus the scoped CRM export with complete help", () => {
    const instance = new CnpjCommands();
    const commands = getCommandsMetadata(CnpjCommands);
    const returns = getReturnsMetadata(CnpjCommands);
    const access = getCommandAccessMetadata(CnpjCommands);
    const scopes = getScopeMetadata(CnpjCommands);

    expect(getGroupMetadata(CnpjCommands)).toMatchObject({ name: "cnpj", scope: "open" });
    expect(commands.map((command) => command.name).sort()).toEqual(["export-crm", "get", "health", "search"]);
    expect(returns.size).toBe(commands.length);
    expect(access.size).toBe(commands.length);
    expect(scopes.get("exportCrm")).toBe("writeContacts");

    for (const command of commands) {
      const options = getOptionsMetadata(instance, command.method);
      expect(options.some((option) => option.flags.includes("--json"))).toBe(true);
      expect(options.some((option) => option.flags.includes("--base-url"))).toBe(true);
      expect(command.helpAfter).toContain("USE");
      expect(command.helpAfter).toContain("NÃO USE");
      expect(command.helpAfter).toContain("REGRAS HARD");
      expect(command.helpAfter).toContain("EXAMPLES");
      expect(command.helpAfter).toContain("ON ERROR");
      expect(command.helpAfter).toContain("FONTES");
      expect(command.helpAfter).toContain(CNPJ_TAILSCALE_BASE_URL);
      expect(access.get(command.method)).toMatchObject(
        command.name === "export-crm" ? { kind: "mutate", risk: "medium" } : { kind: "read", risk: "low" },
      );
      expect(returns.has(command.method)).toBe(true);
    }
  });

  it("prints and returns the typed health envelope with explicit client configuration", async () => {
    const health = mock(async () => ({
      app: "cnpj-server" as const,
      ready: true as const,
      readOnly: true as const,
      transport: "tailscale" as const,
      baseUrl: CNPJ_TAILSCALE_BASE_URL,
      externalCheckPerformed: true as const,
      latencyMs: 12,
      engine: "unknown",
      returned: 0,
      totalResults: 0,
    }));
    let clientOptions: CnpjServerClientOptions | undefined;
    const commands = new CnpjCommands((options) => {
      clientOptions = options;
      return { health } as unknown as CnpjServerClient;
    });
    const log = spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.health(CNPJ_TAILSCALE_BASE_URL, "3000", true);

    expect(clientOptions).toEqual({ baseUrl: CNPJ_TAILSCALE_BASE_URL, timeoutMs: 3000 });
    expect(result).toMatchObject({ success: true, ready: true, latencyMs: 12 });
    expect(log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(getReturnsMetadata(CnpjCommands).get("health")?.safeParse(result).success).toBe(true);
  });

  it("returns one complete company record without changing the provider payload", async () => {
    const data = {
      empresa: {
        cnpj_base: "00000000",
        razao_social: "BANCO DO BRASIL SA",
        natureza_juridica: null,
        qualificacao_responsavel: null,
        capital_social: 1000,
        porte_empresa: null,
        ente_federativo_responsavel: null,
      },
      estabelecimento: {
        cnpj_completo: "00000000000191",
        cnpj_base: "00000000",
        cnpj_ordem: "0001",
        cnpj_dv: "91",
        matriz_filial: 1,
        nome_fantasia: null,
        situacao_cadastral: 2,
        data_situacao_cadastral: null,
        motivo_situacao_cadastral: null,
        nome_cidade_exterior: null,
        pais_codigo: null,
        data_inicio_atividade: null,
        cnae_principal: null,
        cnae_secundarios: null,
        tipo_logradouro: null,
        logradouro: null,
        numero: null,
        complemento: null,
        bairro: null,
        cep: null,
        uf: null,
        municipio_codigo: null,
        ddd_1: null,
        telefone_1: null,
        ddd_2: null,
        telefone_2: null,
        email: null,
      },
      socios: [],
    };
    const show = mock(async () => data);
    const commands = new CnpjCommands(() => ({ show }) as unknown as CnpjServerClient);
    spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.get("00.000.000/0001-91", CNPJ_TAILSCALE_BASE_URL, "10000", true);

    expect(show).toHaveBeenCalledWith("00.000.000/0001-91");
    expect(result).toEqual({
      success: true,
      source: {
        app: "cnpj-server",
        transport: "tailscale",
        baseUrl: CNPJ_TAILSCALE_BASE_URL,
        readOnly: true,
      },
      data,
    });
    expect(getReturnsMetadata(CnpjCommands).get("get")?.safeParse(result).success).toBe(true);
  });

  it("returns bounded search pagination and a complete next command", async () => {
    const item = {
      cnpj_completo: "12345678000195",
      razao_social: "EMBALAGENS TESTE LTDA",
      nome_fantasia: null,
      uf: "SP",
      cnae_principal: "1340500",
      situacao_cadastral: 2,
      data_inicio_atividade: "2026-01-10",
    };
    const search = mock(async () => ({
      motor: "FTS5",
      pagina: 2,
      resultados: 100,
      itens: [item],
    }));
    const commands = new CnpjCommands(() => ({ search }) as unknown as CnpjServerClient);
    spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.search(
      "embalagens",
      "SP",
      "1340500",
      "Sao Paulo",
      "1000",
      "5000",
      "EPP",
      "2026-01-01",
      "2026-06-30",
      "2",
      "1",
      CNPJ_TAILSCALE_BASE_URL,
      "5000",
      true,
    );

    expect(search).toHaveBeenCalledWith({
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
      limit: 1,
    });
    expect(result.pagination).toMatchObject({
      page: 2,
      limit: 1,
      returned: 1,
      hasMore: true,
      nextPage: 3,
    });
    expect(result.pagination.nextCommand).toContain("ravi cnpj search");
    expect(result.pagination.nextCommand).toContain("--page 3");
    expect(result.pagination.nextCommand).toContain(`--base-url ${CNPJ_TAILSCALE_BASE_URL}`);
    expect(result.pagination.nextCommand).toContain("--json");
    expect(getReturnsMetadata(CnpjCommands).get("search")?.safeParse(result).success).toBe(true);
  });

  it("declares safe numeric bounds in option metadata", () => {
    const options = getOptionsMetadata(new CnpjCommands(), "search");
    const limit = options.find((option) => option.flags.includes("--limit"));
    const page = options.find((option) => option.flags.includes("--page"));
    const flags = options.map((option) => option.flags);

    expect(limit?.defaultValue).toBe("20");
    expect(limit?.schema?.safeParse("100").success).toBe(true);
    expect(limit?.schema?.safeParse("101").success).toBe(false);
    expect(page?.defaultValue).toBe("1");
    expect(page?.schema?.safeParse("0").success).toBe(false);
    expect(flags.some((flag) => flag.includes("--opened-from"))).toBe(true);
    expect(flags.some((flag) => flag.includes("--opened-to"))).toBe(true);
    expect(flags.some((flag) => flag.includes("--data-start") || flag.includes("--data-end"))).toBe(false);
  });

  it("denies CRM export before the handler for a read-only runtime principal", () => {
    const access = getCommandAccessMetadata(CnpjCommands).get("exportCrm");
    const scope = getScopeMetadata(CnpjCommands).get("exportCrm");
    const context: ContextRecord = {
      contextId: "ctx_cnpj_read_only",
      contextKey: "rctx_cnpj_read_only",
      kind: "turn-runtime",
      agentId: "read-only-agent",
      capabilities: [{ permission: "read", objectType: "cnpj.registry", objectId: "*" }],
      metadata: { authorityMode: "delegated" },
      createdAt: 0,
    };

    const result = runWithContext({ agentId: "read-only-agent", context }, () =>
      enforceCliCommandAuthorization({
        group: "cnpj",
        command: "export-crm",
        access,
        scope: scope ?? "admin",
        input: { apply: true },
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("Permission denied");
    expect(result.errorMessage).toContain("mutate crm.account.export-cnpj");
  });

  it("fail-closes handler-level CRM export without write_contacts before CNPJ lookup", async () => {
    const search = mock(async () => ({ pagina: 1, resultados: 0, itens: [] }));
    const commands = new CnpjCommands(() => ({ search }) as unknown as CnpjServerClient);
    const context: ContextRecord = {
      contextId: "ctx_cnpj_handler_read_only",
      contextKey: "rctx_cnpj_handler_read_only",
      kind: "turn-runtime",
      agentId: "read-only-agent",
      capabilities: [{ permission: "read", objectType: "cnpj.registry", objectId: "*" }],
      metadata: { authorityMode: "delegated" },
      createdAt: 0,
    };

    const result = runWithContext({ agentId: context.agentId, context }, () =>
      commands.exportCrm(
        "ACME",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "1",
        "20",
        undefined,
        "agent:main",
        undefined,
        undefined,
        undefined,
        CNPJ_TAILSCALE_BASE_URL,
        undefined,
        true,
      ),
    );

    await expect(result).rejects.toThrow("PERMISSION_DENIED");
    await expect(result).rejects.toThrow("requires write_contacts");
    expect(search).not.toHaveBeenCalled();
  });

  it("allows handler-level CRM export preview with write_contacts", async () => {
    const search = mock(async () => ({ pagina: 1, resultados: 0, itens: [] }));
    const commands = new CnpjCommands(() => ({ search }) as unknown as CnpjServerClient);
    spyOn(console, "log").mockImplementation(() => {});
    const context: ContextRecord = {
      contextId: "ctx_cnpj_handler_writer",
      contextKey: "rctx_cnpj_handler_writer",
      kind: "turn-runtime",
      agentId: "crm-writer",
      capabilities: [{ permission: "write_contacts", objectType: "system", objectId: "*" }],
      metadata: { authorityMode: "delegated" },
      createdAt: 0,
    };

    const result = await runWithContext({ agentId: context.agentId, context }, () =>
      commands.exportCrm(
        "ACME",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "1",
        "20",
        undefined,
        "agent:main",
        undefined,
        undefined,
        undefined,
        CNPJ_TAILSCALE_BASE_URL,
        undefined,
        true,
      ),
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, mode: "dry-run", candidates: [], nextCommand: null });
  });

  it("round-trips adversarial free text through copy-safe POSIX next commands", async () => {
    const query = "budget $5 `printf BACKTICK` $(printf SUBSHELL) \\\\ \"double\" 'single'";
    const item = {
      cnpj_completo: "00000000000191",
      razao_social: "BANCO DO BRASIL SA",
      nome_fantasia: "BANCO DO BRASIL",
      uf: "DF",
      cnae_principal: "6422100",
      situacao_cadastral: 2,
      data_inicio_atividade: "1966-08-01",
    };
    const search = mock(async () => ({
      pagina: 1,
      resultados: 2,
      itens: [item],
    }));
    const commands = new CnpjCommands(() => ({ search }) as unknown as CnpjServerClient);
    spyOn(console, "log").mockImplementation(() => {});

    const searchResult = await commands.search(
      query,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "1",
      "1",
      CNPJ_TAILSCALE_BASE_URL,
      undefined,
      true,
    );
    const exportResult = await commands.exportCrm(
      query,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "1",
      "20",
      undefined,
      "agent:main",
      undefined,
      undefined,
      undefined,
      CNPJ_TAILSCALE_BASE_URL,
      undefined,
      true,
    );

    if (!searchResult.pagination.nextCommand || !exportResult.nextCommand) {
      throw new Error("Expected copyable search and export next commands");
    }
    const searchTokens = parsePosixCommand(searchResult.pagination.nextCommand);
    const exportTokens = parsePosixCommand(exportResult.nextCommand);
    expect(searchTokens[searchTokens.indexOf("--query") + 1]).toBe(query);
    const originFilters = exportTokens[exportTokens.indexOf("--origin-filters") + 1];
    expect(JSON.parse(originFilters)).toMatchObject({ q: query });
    expect(searchResult).not.toHaveProperty("engine");
    expect(getReturnsMetadata(CnpjCommands).get("search")?.safeParse(searchResult).success).toBe(true);
  });

  it("builds an exact deduplicated CRM apply command during dry-run", async () => {
    const item = {
      cnpj_completo: "00000000000191",
      razao_social: "BANCO DO BRASIL SA",
      nome_fantasia: "BANCO DO BRASIL",
      uf: "DF",
      cnae_principal: "6422100",
      situacao_cadastral: 2,
      data_inicio_atividade: "1966-08-01",
    };
    const search = mock(async () => ({
      motor: "FTS5",
      pagina: 1,
      resultados: 2,
      itens: [item, item],
    }));
    const commands = new CnpjCommands(() => ({ search }) as unknown as CnpjServerClient);
    spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.exportCrm(
      undefined,
      "DF",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "1",
      "20",
      undefined,
      "agent:main",
      undefined,
      undefined,
      undefined,
      CNPJ_TAILSCALE_BASE_URL,
      "5000",
      true,
    );

    expect(result).toMatchObject({
      success: true,
      mode: "dry-run",
      owner: { type: "agent", id: "main" },
      dedupe: { inputCount: 2, uniqueCount: 1, removedDuplicates: 1 },
      candidates: [{ cnpj: "00000000000191" }],
    });
    expect(result.selectionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.nextCommand).toContain("--cnpjs 00000000000191");
    expect(result.nextCommand).toContain("--owner agent:main");
    expect(result.nextCommand).toContain("--apply --json");
    expect(getReturnsMetadata(CnpjCommands).get("exportCrm")?.safeParse(result).success).toBe(true);
  });

  it("applies only a pinned selection and returns typed CRM receipts", async () => {
    const show = mock(async () => company());
    const createAccount = mock(() => ({ id: "crm_acc_1" }));
    const confirmFact = mock(() => ({ id: "crm_fact_1" }));
    const crm = { createAccount, confirmFact } as unknown as CnpjCrmAdapter;
    const commands = new CnpjCommands(() => ({ show }) as unknown as CnpjServerClient, crm);
    spyOn(console, "log").mockImplementation(() => {});
    const selectionHash = cnpjSelectionHash(["00000000000191"]);

    const result = await commands.exportCrm(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "00000000000191",
      "team:sales",
      true,
      selectionHash,
      '{"uf":"DF"}',
      CNPJ_TAILSCALE_BASE_URL,
      "5000",
      true,
    );

    expect(result).toMatchObject({
      mode: "apply",
      status: "completed",
      requested: 1,
      applied: 1,
      failed: 0,
      results: [{ cnpj: "00000000000191", accountId: "crm_acc_1", factId: "crm_fact_1" }],
    });
    expect(createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "cnpj-server:account:00000000000191",
        lifecycle: "lead",
        source: "cnpj-server",
        ownerType: "team",
        ownerId: "sales",
      }),
    );
    expect(getReturnsMetadata(CnpjCommands).get("exportCrm")?.safeParse(result).success).toBe(true);
  });
});

function parsePosixCommand(command: string): string[] {
  const result = spawnSync("bash", ["-c", 'eval "set -- $NEXT_COMMAND"; printf "%s\\0" "$@"'], {
    env: { ...process.env, NEXT_COMMAND: command },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.split("\0").filter(Boolean);
}

function company() {
  return {
    empresa: {
      cnpj_base: "00000000",
      razao_social: "BANCO DO BRASIL SA",
      natureza_juridica: null,
      qualificacao_responsavel: null,
      capital_social: 1000,
      porte_empresa: null,
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
      data_situacao_cadastral: null,
      motivo_situacao_cadastral: null,
      nome_cidade_exterior: null,
      pais_codigo: null,
      data_inicio_atividade: "1966-08-01",
      cnae_principal: "6422100",
      cnae_secundarios: null,
      tipo_logradouro: null,
      logradouro: null,
      numero: null,
      complemento: null,
      bairro: null,
      cep: null,
      uf: "DF",
      municipio_codigo: null,
      ddd_1: null,
      telefone_1: null,
      ddd_2: null,
      telefone_2: null,
      email: null,
    },
    socios: [],
  };
}
