import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TinyTenantConfig } from "./config.js";
import { runTinyCli } from "./cli.js";
import { buildTinyWritePlan } from "./write-contracts.js";

const AUDITED_TINY_WRITE_OPERATIONS = [
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

type AuditedTinyWriteOperation = (typeof AUDITED_TINY_WRITE_OPERATIONS)[number];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Tiny write contracts", () => {
  test("covers representative v2 and v3 write families without network or secret resolution", () => {
    for (const operation of AUDITED_TINY_WRITE_OPERATIONS) {
      const apiVersion = operation === "oc-criar" ? "v3" : "v2";
      const plan = buildTinyWritePlan(config(apiVersion), operation, validInput(operation));
      expect(plan).toMatchObject({
        ok: true,
        dryRun: true,
        executionEnabled: false,
        networkCalled: false,
        operation,
        apiVersion,
        hitlRequired: true,
        confirmationRequired: true,
        idempotent: false,
        authentication: { provider: "tiny", connection: "acme", secretResolved: false },
        input: { validated: true, valuesExposed: false },
        quota: {
          policy: {
            apiVersion,
            publishedLimitPerMinute: null,
            conservativePolicy: { maxInFlight: 1, minIntervalMs: 3000, retryAutomatically: false },
            verifiedAt: "2026-07-14",
          },
        },
        provenance: { apiVersion, verifiedAt: "2026-07-14" },
      });
      expect(plan.input.sha256).toHaveLength(64);
      expect(JSON.stringify(plan)).not.toContain("example-secret");
    }
  });

  test("uses official plan quotas and keeps the undocumented webhook quota unknown", () => {
    const v2 = buildTinyWritePlan(config("v2"), "pedido-incluir", validInput("pedido-incluir"));
    expect(v2.quota.policy).toMatchObject({
      status: "published_plan_dependent",
      scope: "account",
      unit: "requests",
      window: "minute",
      observeHeaders: ["x-limit-api"],
      documentedQuotaError: null,
      publishedPlanLimitsPerMinute: {
        comecar: { total: 0, write: null },
        crescer: { total: 30, write: null },
        evoluir: { total: 60, write: null },
        potencializar: { total: 120, write: null },
        discontinued: { total: 20, write: null },
      },
      batch: {
        callsPerMinute: 5,
        maxRecordsPerRequest: 20,
        maxRecordsPerResponse: 100,
        officialAlwaysBatchOperations: [
          "contato-incluir",
          "contato-alterar",
          "produto-incluir",
          "produto-alterar",
          "grupo-tag-incluir",
          "grupo-tag-alterar",
          "tag-incluir",
          "tag-alterar",
        ],
        migratedAlwaysBatchOperations: ["contato-incluir", "contato-alterar", "produto-incluir", "produto-alterar"],
      },
    });

    const webhook = buildTinyWritePlan(config("v2"), "webhook-incluir", validInput("webhook-incluir"));
    expect(webhook.quota.policy).toMatchObject({
      status: "unknown",
      publishedPlanLimitsPerMinute: null,
      observeHeaders: [],
      evidenceStatus: "gap",
      closureOwner: "ravi-dev+researcher",
      liveGate: "no-go",
    });
    expect(webhook.provenance).toMatchObject({ officialDoc: null, endpointEvidenceStatus: "gap" });

    for (const operation of ["conta-receber-estornar", "conta-pagar-estornar"] as const) {
      const reversal = buildTinyWritePlan(config("v2"), operation, validInput(operation));
      expect(reversal.provenance).toMatchObject({
        officialDoc: null,
        endpointEvidenceStatus: "gap",
        confidence: "low",
        owner: "ravi-dev+researcher",
        liveGate: "no-go",
      });
      expect(reversal.quota.policy).toMatchObject({
        status: "unknown",
        evidenceStatus: "gap",
        closureOwner: "ravi-dev+researcher",
        liveGate: "no-go",
      });
    }

    const v3 = buildTinyWritePlan(config("v3"), "oc-criar", validInput("oc-criar"));
    expect(v3.quota.policy).toMatchObject({
      status: "published_plan_dependent",
      scope: "account_shared_across_applications",
      publishedPlanLimitsPerMinute: {
        basico_crescer: { total: 60, write: 30 },
        essencial_evoluir: { total: 120, write: 60 },
        grande_potencializar: { total: 240, write: 100 },
      },
      observeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    });
  });

  test("requires an explicit stock movement type instead of inheriting legacy balance default", () => {
    expect(() =>
      buildTinyWritePlan(config("v2"), "estoque-atualizar", {
        idProduto: "123456789",
        quantidade: "5.25",
      }),
    ).toThrow("tipo");
  });

  test("keeps live write execution disabled even when --yes is supplied", async () => {
    const fixture = await createFixture("v2", "pedido-incluir", validInput("pedido-incluir"));
    await expect(
      runTinyCli(
        ["pedido-incluir", "--tenant", "acme", "--input-file", fixture.inputPath, "--yes", "--json"],
        fixture.env,
      ),
    ).rejects.toThrow("--yes nao e aceito");
  });

  test("CLI validates a file payload and returns only a redacted dry-run plan", async () => {
    const fixture = await createFixture("v2", "webhook-incluir", {
      url: "https://hooks.example.test/tiny",
      evento: "pedido.alterado",
    });
    const result = await runTinyCli(
      ["webhook-incluir", "--tenant", "acme", "--input-file", fixture.inputPath, "--dry-run", "--json"],
      fixture.env,
    );
    expect(result).toMatchObject({
      operation: "webhook-incluir",
      executionEnabled: false,
      networkCalled: false,
      input: { topLevelFields: ["evento", "url"], valuesExposed: false },
    });
    expect(JSON.stringify(result)).not.toContain("hooks.example.test");
  });
});

function config(apiVersion: "v2" | "v3"): TinyTenantConfig {
  return {
    tenant: "acme",
    apiVersion,
    credentialProvider: "tiny",
    credentialConnection: "acme",
    baseUrl: apiVersion === "v2" ? "https://api.tiny.com.br/api2" : "https://api.tiny.com.br/public-api/v3",
  };
}

function validInput(operation: AuditedTinyWriteOperation): Record<string, unknown> {
  switch (operation) {
    case "contato-incluir":
      return { contato: { nome: "Example", situacao: "A", tipo_pessoa: "J", cpf_cnpj: "00000000000000" } };
    case "contato-alterar":
      return { contato: { id: "123456789", nome: "Example" } };
    case "produto-incluir":
      return {
        produto: { nome: "Example", unidade: "UN", preco: "5.25", origem: "0", situacao: "A", tipo: "P" },
      };
    case "produto-alterar":
      return { produto: { id: "123456789", nome: "Example" } };
    case "pedido-incluir":
      return { pedido: { cliente: { id: "1" }, itens: [{ item: { id_produto: "2", quantidade: "1" } }] } };
    case "pedido-alterar":
      return { idPedido: "123456789", dadosPedido: { observacoes: "preview" } };
    case "pedido-situacao":
      return { idPedido: "123456789", situacao: "aprovado" };
    case "estoque-atualizar":
      return { idProduto: "123456789", quantidade: "5.25", tipo: "E", observacoes: "preview" };
    case "nota-emitir":
      return { idNota: "123456789" };
    case "conta-receber-baixar":
      return { idConta: "123456789", data: "14/07/2026", valorPago: "5.25", historico: "preview" };
    case "conta-receber-incluir":
      return {
        conta: {
          idContato: "123456789",
          dataEmissao: "14/07/2026",
          dataVencimento: "15/07/2026",
          valor: "5.25",
        },
      };
    case "conta-receber-estornar":
      return { idConta: "123456789" };
    case "conta-pagar-incluir":
      return { conta: { descricao: "preview", valor: "5.25" } };
    case "conta-pagar-baixar":
      return { idConta: "123456789", data: "14/07/2026", valorPago: "5.25", historico: "preview" };
    case "conta-pagar-estornar":
      return { idConta: "123456789" };
    case "webhook-incluir":
      return { url: "https://hooks.example.test/tiny", evento: "pedido.alterado" };
    case "oc-criar":
      return { contato: { id: 123 }, data: "2026-07-14", itens: [{ produto: { id: 456 }, quantidade: 1 }] };
  }
}

async function createFixture(
  apiVersion: "v2" | "v3",
  operation: AuditedTinyWriteOperation,
  input: Record<string, unknown>,
) {
  const directory = await mkdtemp(join(tmpdir(), "ravi-tiny-write-"));
  temporaryDirectories.push(directory);
  const configDirectory = join(directory, "tenants");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "acme.json"),
    JSON.stringify({ tenant: "acme", apiVersion, credentialConnection: "acme" }),
  );
  const inputPath = join(directory, `${operation}.json`);
  await writeFile(inputPath, JSON.stringify(input));
  return {
    inputPath,
    env: {
      RAVI_TINY_CONFIG_DIR: configDirectory,
      RAVI_CREDENTIALS_DB_PATH: join(directory, "credentials.db"),
    },
  };
}
