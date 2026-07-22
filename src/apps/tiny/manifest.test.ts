import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TINY_READ_OPERATIONS, TINY_READ_WAVE_1_OPERATIONS } from "./read-contracts.js";
import { TINY_WRITE_OPERATIONS, hasVerifiedOfficialWriteSource } from "./write-contracts.js";

const TENANT_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$";
const WRITE_DOCUMENTATION_GAPS = ["conta-receber-estornar", "conta-pagar-estornar", "webhook-incluir"] as const;

interface ManifestOperation {
  interface?: string;
  mutating?: boolean;
  destructive?: boolean;
  permission?: string;
  safety?: {
    idempotent?: boolean;
    dryRunSupported?: boolean;
    confirmationRequired?: boolean;
    hitlRequired?: boolean;
    liveExecution?: boolean;
    risk?: string;
  };
  reliability?: {
    timeoutMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
  };
  inputSchema?: {
    required?: string[];
    properties?: { tenant?: { pattern?: string } };
  };
  payloadSchema?: string;
  outputSchema?: string;
  help?: {
    sections?: Array<{ title: string; content?: string }>;
    options?: Array<{ flags: string; required?: boolean }>;
    examples?: string[];
    permissionSemantics?: {
      mode?: string;
      coreBoundary?: string;
      declaredRequirements?: string[];
      enforcementSource?: string;
      providerId?: string | null;
    };
    safety?: {
      readOnly?: boolean;
      mutating?: boolean;
      destructive?: boolean;
      hitlRequired?: boolean;
      confirmationRequired?: boolean;
      dryRunSupported?: boolean;
      gates?: string[];
    };
    validationCommands?: string[];
    complete?: boolean;
    missing?: string[];
    provenance?: {
      officialUrls?: string[];
      verifiedAt?: string;
      apiVersion?: string;
      evidenceStatus?: string;
      owner?: string | null;
    };
    quota?: {
      status?: string;
      apiVersion?: string | null;
      scope?: string;
      unit?: string | null;
      window?: string | null;
      planLimitsPerMinute?: Record<string, { total: number; write: number | null }> | null;
      batch?: Record<string, unknown> | null;
      concurrency?: string | null;
      headers?: string[];
      documentedError?: string | null;
      retryPolicy?: string;
      sourceUrls?: string[];
      verifiedAt?: string;
      owner?: string | null;
      liveGate?: string;
    };
  };
}

interface TinyManifest {
  operations: Record<string, ManifestOperation>;
  health?: {
    checks?: Array<{
      id?: string;
      type?: string;
      required?: boolean;
      sideEffectFree?: boolean;
      handler?: string;
      command?: string;
      timeoutMs?: number;
    }>;
  };
  migration?: {
    legacyCommand?: string;
    operationScope?: string;
    readWaves?: Array<{
      id?: string;
      status?: string;
      operations?: string[];
      implemented?: number;
      expected?: number;
      fallback?: string;
      liveGate?: string;
    }>;
    documentationGaps?: Array<{
      id?: string;
      apiVersion?: string;
      status?: string;
      quota?: {
        status?: string;
        apiVersion?: string;
        planLimitsPerMinute?: unknown;
        batch?: unknown;
        concurrency?: unknown;
        headers?: string[];
        owner?: string | null;
        liveGate?: string;
      };
      provenance?: {
        evidenceStatus?: string;
        verifiedAt?: string;
        owner?: string | null;
      };
      complete?: boolean;
      missing?: string[];
      liveGate?: string;
    }>;
  };
}

interface JsonSchemaNode {
  const?: unknown;
  additionalProperties?: boolean | JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
}

const requiredHelpSections = [
  "USE",
  "NAO USE",
  "REGRAS HARD",
  "PRECONDICOES",
  "HITL OBRIGATORIO",
  "ON ERROR",
  "ENDPOINT",
  "COTAS",
  "PROVENIENCIA",
];

describe("Tiny App manifest write boundary", () => {
  test("declares 100% of read wave 1 while preserving SDE and the live dependency gate", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;
    const wave = manifest.migration?.readWaves?.find(({ id }) => id === "read-wave-1");

    expect(wave).toMatchObject({
      status: "offline-parity",
      operations: [...TINY_READ_WAVE_1_OPERATIONS],
      implemented: TINY_READ_WAVE_1_OPERATIONS.length,
      expected: TINY_READ_WAVE_1_OPERATIONS.length,
      fallback: "sde tiny",
      liveGate: "blocked-until-f001-f002-retest",
    });
    expect(manifest.migration?.legacyCommand).toBe("sde tiny");

    for (const operationName of TINY_READ_WAVE_1_OPERATIONS) {
      const operation = manifest.operations[`tiny.${operationName}`];
      expect(operation).toBeDefined();
      expect(operation.mutating).toBe(false);
      expect(operation.permission).toBe("tiny:read");
      expect(operation.safety).toMatchObject({
        idempotent: true,
        dryRunSupported: true,
        confirmationRequired: false,
        liveExecution: true,
        risk: "low",
      });
      expect(operation.reliability).toEqual({ timeoutMs: 30000, maxAttempts: 3, baseDelayMs: 250 });
      expect(operation.help?.complete).toBe(true);
      expect(operation.help?.safety).toMatchObject({
        readOnly: true,
        mutating: false,
        destructive: false,
        dryRunSupported: true,
      });
      expect(operation.help?.sections?.map(({ title }) => title)).toContain("FALLBACK");
    }

    const promotedReads = new Set<string>(TINY_READ_WAVE_1_OPERATIONS);
    for (const operationName of TINY_READ_OPERATIONS) {
      if (promotedReads.has(operationName)) continue;
      expect(manifest.operations[`tiny.${operationName}`]).toBeUndefined();
    }
    expect(manifest.migration?.operationScope).toContain("read wave 1");

    for (const operationName of ["contatos", "produtos"]) {
      const operation = manifest.operations[`tiny.${operationName}`];
      expect(operation.inputSchema?.required).toContain("pesquisa");
      expect(operation.help?.options?.find(({ flags }) => flags.startsWith("--pesquisa"))?.required).toBe(true);
    }
  });

  test("declares every migrated write preview with schemas and hard gates", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;

    for (const operationName of TINY_WRITE_OPERATIONS) {
      const operation = manifest.operations[`tiny.${operationName}`];
      expect(operation).toBeDefined();
      expect(operation.mutating).toBe(true);
      expect(operation.permission).toMatch(/^tiny:(write|destructive)$/);
      if ((WRITE_DOCUMENTATION_GAPS as readonly string[]).includes(operationName)) {
        expect(operation.help?.complete).toBe(false);
        expect(operation.help?.missing).toEqual(["officialEndpoint", "immutableOfficialEvidence", "officialQuota"]);
      } else {
        expect(operation.help?.complete).toBe(true);
        expect(operation.help?.missing).toEqual([]);
      }
      expect(operation.help?.safety).toMatchObject({
        hitlRequired: true,
        confirmationRequired: true,
        dryRunSupported: true,
      });
      expect(operation.help?.safety?.gates).toEqual(
        expect.arrayContaining([
          "dry-run-only",
          "hitl-before-live",
          "app-boundary:execute:app:tiny",
          `requirement-metadata:${operation.permission}`,
          "hitl:required",
          "confirmation:required",
          "preview:dry-run",
        ]),
      );
      expect(operation.help?.sections?.map(({ title }) => title)).toEqual(expect.arrayContaining(requiredHelpSections));
      expect(operation.help?.examples?.join(" ")).toContain("--dry-run");
      expect(operation.help?.validationCommands?.join(" ")).toContain("write-contracts.test.ts");
      expect(operation.help?.provenance).toMatchObject({ verifiedAt: "2026-07-14" });
      expect(operation.help?.provenance?.officialUrls?.length).toBeGreaterThan(0);
      expect(operation.help?.quota).toMatchObject({ verifiedAt: "2026-07-14" });
      expect(operation.help?.quota?.retryPolicy).toContain("retryAutomatically=false");
      expect(operation.help?.quota?.documentedError).toBeNull();
      expect(operation.inputSchema?.required).toEqual(expect.arrayContaining(["tenant", "inputFile", "dryRun"]));
      expect(operation.safety).toMatchObject({
        idempotent: false,
        dryRunSupported: true,
        confirmationRequired: true,
        hitlRequired: true,
        liveExecution: false,
      });
      expect(operation.reliability).toEqual({ timeoutMs: 30000, maxAttempts: 1, baseDelayMs: 250 });

      for (const schemaRef of [operation.payloadSchema, operation.outputSchema]) {
        expect(schemaRef).toBeString();
        const schemaText = await readFile(join(import.meta.dir, schemaRef as string), "utf8");
        expect(() => JSON.parse(schemaText)).not.toThrow();
      }
    }
  });

  test("declares side-effect-free manifest checks and an explicit executable readiness probe", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;

    expect(manifest.health?.checks).toEqual([
      {
        id: "manifest",
        type: "builtin",
        required: true,
        sideEffectFree: true,
        handler: "apps.manifest.check",
      },
      {
        id: "config",
        type: "cli",
        required: true,
        sideEffectFree: true,
        command: "bun run ./cli.ts config-check {args} --json",
        timeoutMs: 5000,
      },
    ]);
  });

  test("models official v2/v3 quotas and keeps the undocumented webhook fail-closed", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;
    const info = manifest.operations["tiny.info"]?.help;
    expect(info?.quota).toMatchObject({
      status: "published_plan_dependent",
      apiVersion: "v2",
      scope: "account",
      unit: "requests",
      window: "minute",
      headers: ["x-limit-api"],
      liveGate: "documented",
    });
    expect(info?.quota?.planLimitsPerMinute).toEqual({
      comecar: { total: 0, write: null },
      crescer: { total: 30, write: null },
      evoluir: { total: 60, write: null },
      potencializar: { total: 120, write: null },
      discontinued: { total: 20, write: null },
    });
    expect(info?.quota?.batch).toEqual({
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
    });
    expect(info?.quota?.concurrency).toContain("maximum_recommended_fraction=0.25");

    const webhook = manifest.operations["tiny.webhook-incluir"]?.help;
    expect(webhook?.quota).toMatchObject({
      status: "unknown",
      planLimitsPerMinute: null,
      batch: null,
      headers: [],
      owner: "ravi-dev+researcher",
      liveGate: "no-go",
    });
    expect(webhook?.quota?.concurrency).toContain("official=unknown");
    expect(webhook?.provenance).toMatchObject({ evidenceStatus: "gap", owner: "ravi-dev+researcher" });
    const webhookQuotaText = webhook?.sections?.find(({ title }) => title === "COTAS")?.content ?? "";
    expect(webhookQuotaText).toContain("unknown");
    expect(webhookQuotaText).toContain("NO-GO");
    expect(webhookQuotaText).not.toContain("0/30/60/120");

    const order = manifest.operations["tiny.oc-criar"]?.help;
    expect(order?.quota).toMatchObject({
      status: "published_plan_dependent",
      apiVersion: "v3",
      scope: "account_shared_across_applications",
      headers: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    });
    expect(order?.quota?.planLimitsPerMinute).toEqual({
      basico_crescer: { total: 60, write: 30 },
      essencial_evoluir: { total: 120, write: 60 },
      grande_potencializar: { total: 240, write: 100 },
    });
    expect(order?.quota?.sourceUrls).toEqual([
      "https://api-docs.erp.olist.com/documentacao/comecando/limites-de-consulta",
      "https://ajuda.olist.com/hubs-e-plataformas-via-api/aplicativos-api-v3-configuracoes-e-utilizacao",
    ]);
  });

  test("keeps both financial reversals low-confidence and cannot promote an unverified URL", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;
    for (const operationName of ["conta-receber-estornar", "conta-pagar-estornar"]) {
      const help = manifest.operations[`tiny.${operationName}`]?.help;
      expect(help).toMatchObject({
        complete: false,
        missing: ["officialEndpoint", "immutableOfficialEvidence", "officialQuota"],
        provenance: { evidenceStatus: "gap", owner: "ravi-dev+researcher" },
        quota: { status: "unknown", owner: "ravi-dev+researcher", liveGate: "no-go" },
      });
      expect(help?.provenance?.officialUrls).not.toContain(
        `https://tiny.com.br/api-docs/api2-${operationName.replaceAll("-", "-")}`,
      );
    }

    expect(
      hasVerifiedOfficialWriteSource({
        officialDoc: "https://tiny.com.br/api-docs/unverified-string-only",
        officialDocEvidence: "gap",
      }),
    ).toBe(false);
  });

  test("keeps the undocumented v1 contract explicit, owned and NO-GO", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;
    const v1 = manifest.migration?.documentationGaps?.find(({ id }) => id === "tiny-api-v1");

    expect(v1).toMatchObject({
      apiVersion: "v1",
      status: "unknown",
      complete: false,
      missing: ["officialEndpoint", "officialAuthentication", "officialQuota"],
      liveGate: "no-go",
      provenance: {
        evidenceStatus: "gap",
        verifiedAt: "2026-07-14",
        owner: "ravi-dev+researcher",
      },
      quota: {
        status: "unknown",
        apiVersion: "v1",
        planLimitsPerMinute: null,
        batch: null,
        concurrency: null,
        headers: [],
        owner: "ravi-dev+researcher",
        liveGate: "no-go",
      },
    });
  });

  test("exposes dated provenance and structured quota status for every CLI help", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;
    for (const [operationId, operation] of Object.entries(manifest.operations)) {
      if (operation.interface !== "cli") continue;
      expect(operation.help?.provenance?.verifiedAt, operationId).toBe("2026-07-14");
      expect(operation.help?.provenance?.evidenceStatus, operationId).toMatch(/^(established|gap)$/);
      expect(operation.help?.quota?.status, operationId).toMatch(/^(published_plan_dependent|unknown|not_applicable)$/);
      expect(operation.help?.quota?.verifiedAt, operationId).toBe("2026-07-14");
      expect(operation.help?.quota?.retryPolicy, operationId).toBeString();
      expect(operation.inputSchema?.required, operationId).toContain("tenant");
      expect(operation.inputSchema?.properties?.tenant?.pattern, operationId).toBe(TENANT_PATTERN);
      const preconditions = operation.help?.sections?.find(({ title }) => title === "PRECONDICOES")?.content ?? "";
      expect(preconditions, operationId).toContain("tenants/<tenant>.json");
      expect(operation.permission, operationId).toBeString();
      expect(operation.help?.permissionSemantics, operationId).toEqual({
        mode: "metadata-only",
        coreBoundary: operation.mutating === true ? "execute app:tiny" : "use app:tiny",
        declaredRequirements: [operation.permission as string],
        enforcementSource: "core-app-boundary-only",
        providerId: null,
      });
      expect(operation.help?.safety?.gates ?? [], operationId).not.toContain(`permission:${operation.permission}`);

      if (operation.help?.complete === true) {
        expect(operation.help?.missing, operationId).toEqual([]);
        expect(operation.help?.provenance?.evidenceStatus, operationId).toBe("established");
        expect(operation.help?.quota?.status, operationId).not.toBe("unknown");
      } else {
        expect(operation.help?.missing?.length, operationId).toBeGreaterThan(0);
      }
    }
  });

  test("classifies the highest-impact families as destructive", async () => {
    const manifest = JSON.parse(await readFile(join(import.meta.dir, "ravi.app.json"), "utf8")) as TinyManifest;
    const destructive = [
      "pedido-incluir",
      "estoque-atualizar",
      "nota-emitir",
      "conta-receber-baixar",
      "webhook-incluir",
      "oc-criar",
    ];
    for (const operationName of destructive) {
      expect(manifest.operations[`tiny.${operationName}`]).toMatchObject({
        destructive: true,
        permission: "tiny:destructive",
      });
    }
  });

  test("pins redaction and fail-closed fields in the shared write output schema", async () => {
    const schema = JSON.parse(
      await readFile(join(import.meta.dir, "schemas/write-plan-output.schema.json"), "utf8"),
    ) as JsonSchemaNode;

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.input?.additionalProperties).toBe(false);
    expect(schema.properties?.input?.properties?.valuesExposed?.const).toBe(false);
    expect(schema.properties?.authentication?.properties?.secretResolved?.const).toBe(false);
    expect(schema.properties?.quota?.properties?.policy?.properties?.conservativePolicy).toMatchObject({
      additionalProperties: false,
      properties: {
        maxInFlight: { const: 1 },
        minIntervalMs: { const: 3000 },
        retryAutomatically: { const: false },
      },
    });
  });
});
