import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compareRaviAppReadWaveToOracle, loadRaviAppReadOracle, raviAppReadOracleSchema } from "../read-oracle.js";
import {
  compareRaviAppReadOracleToSdeBaseline,
  loadRaviAppSdeReadBaseline,
  raviAppSdeReadBaselineSchema,
} from "../sde-read-baseline.js";
import { TinyClient, type TinyFetch } from "./client.js";
import { TINY_READ_ORACLE_DIMENSIONS, verifyTinyReadWaveOneOracle } from "./read-oracle.js";
import { TINY_V2_QUOTA, publicTinyQuota } from "./quota.js";
import {
  TINY_READ_PARITY_CASES,
  TINY_READ_WAVE_1_OPERATIONS,
  buildTinyReadPlan,
  getTinyReadContract,
  parseTinyReadInput,
  type TinyReadWaveOneOperation,
} from "./read-contracts.js";

describe("Tiny read wave 1 parity contract", () => {
  test("uses an independent sanitized oracle as the denominator for all six reads", async () => {
    const manifestPath = join(import.meta.dir, "ravi.app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      migration?: { readWaves?: Array<{ id?: string; operations?: string[] }> };
      operations?: unknown;
    };
    const loaded = loadRaviAppReadOracle(manifestPath, "tiny", "read-wave-1");
    const loadedSdeBaseline = loadRaviAppSdeReadBaseline(
      manifestPath,
      "tiny",
      "read-wave-1",
      loaded.oracle.legacyBaseline,
    );
    const wave = manifest.migration?.readWaves?.find(({ id }) => id === "read-wave-1");
    const declaredOperationIds = (wave?.operations ?? []).map((operation) => `tiny.${operation}`);
    const comparison = compareRaviAppReadWaveToOracle({
      manifest: manifest as never,
      manifestPath,
      declaredOperationIds,
      loaded,
    });
    const runtime = await verifyTinyReadWaveOneOracle(loaded);
    const sdeComparison = compareRaviAppReadOracleToSdeBaseline({
      manifest: manifest as never,
      oracle: loaded.oracle,
      loadedBaseline: loadedSdeBaseline,
    });

    expect(loaded.oracle.sanitized).toBe(true);
    expect(loaded.oracle.provenance.independentOf).toEqual(["sde", "ravi.app.json", "generate-manifest.ts"]);
    expect(loadedSdeBaseline.baseline.source).toMatchObject({
      commit: "bb1ba78598910b5abab51af896415cc38bf2aaa3",
      captureMethod: "static-git-object-inspection-no-execution",
    });
    expect(sdeComparison).toEqual([]);
    expect(comparison).toMatchObject({
      expectedOperations: [
        "tiny.contato",
        "tiny.contatos",
        "tiny.estoque",
        "tiny.info",
        "tiny.produto",
        "tiny.produtos",
      ],
      implementedOperations: [
        "tiny.contato",
        "tiny.contatos",
        "tiny.estoque",
        "tiny.info",
        "tiny.produto",
        "tiny.produtos",
      ],
      missingOperations: [],
      extraCliOperations: [],
      commandMismatches: [],
      contractMismatches: [],
    });
    expect(runtime.ok).toBe(true);
    expect(runtime.oracleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(runtime.operations).toHaveLength(6);
    for (const operation of runtime.operations) {
      expect(operation.mismatches, operation.operation).toEqual([]);
      expect([...operation.passed].sort(), operation.operation).toEqual([...TINY_READ_ORACLE_DIMENSIONS].sort());
    }
  });

  test("fails when the manifest changes its own denominator or certifies tampered contracts", async () => {
    const manifestPath = join(import.meta.dir, "ravi.app.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const loaded = loadRaviAppReadOracle(manifestPath, "tiny", "read-wave-1");
    const selfCertified = structuredClone(original) as {
      migration: { readWaves: Array<{ id: string; operations: string[]; expected: number; implemented: number }> };
      operations: Record<string, Record<string, unknown>>;
    };
    const wave = selfCertified.migration.readWaves.find(({ id }) => id === "read-wave-1");
    if (!wave) throw new Error("Missing Tiny read-wave-1 fixture.");
    wave.operations = ["info"];
    wave.expected = 1;
    wave.implemented = 1;

    const operation = selfCertified.operations["tiny.info"];
    if (!operation) throw new Error("Missing tiny.info fixture.");
    operation.command = "bun run ./cli.ts self-certified {args} --json";
    operation.inputSchema = { type: "object", additionalProperties: true };
    operation.outputSchema = "schemas/self-certified-output.schema.json";
    const help = operation.help as {
      arguments: unknown[];
      sections: Array<{ title: string; content: string }>;
    };
    help.arguments = [{ name: "self-certified" }];
    const endpoint = help.sections.find(({ title }) => title === "ENDPOINT");
    if (endpoint) endpoint.content = "POST https://self-certified.invalid/read.";
    operation.parityContract = {
      version: "ravi-app-read-parity/v1",
      responseKind: "collection",
      collectionKey: "self-certified",
      emptyState: "self-certified",
      pagination: "self-certified",
      tenantIsolation: "self-certified",
      errorPolicy: "self-certified",
      cases: ["nominal", "empty", "error", "pagination", "tenant"],
    };

    const comparison = compareRaviAppReadWaveToOracle({
      manifest: selfCertified as never,
      manifestPath,
      declaredOperationIds: ["tiny.info"],
      loaded,
    });
    expect(comparison.expectedOperations).toHaveLength(6);
    expect(comparison.missingOperations).toEqual([
      "tiny.contato",
      "tiny.contatos",
      "tiny.estoque",
      "tiny.produto",
      "tiny.produtos",
    ]);
    expect(comparison.commandMismatches).toContainEqual({
      operationId: "tiny.info",
      expectedCommand: "bun run ./cli.ts info {args} --json",
      actualCommand: "bun run ./cli.ts self-certified {args} --json",
    });
    expect(comparison.contractMismatches).toContainEqual({
      operationId: "tiny.info",
      fields: expect.arrayContaining([
        "oracle.args",
        "oracle.endpoint",
        "oracle.input",
        "oracle.output",
        "oracle.schema",
        "oracle.nominal",
        "oracle.empty",
        "oracle.error",
        "oracle.pagination",
        "oracle.tenant",
      ]),
    });
  });

  test("fails closed on incomplete or extensible oracle and SDE baseline artifacts", () => {
    const manifestPath = join(import.meta.dir, "ravi.app.json");
    const loaded = loadRaviAppReadOracle(manifestPath, "tiny", "read-wave-1");
    const loadedBaseline = loadRaviAppSdeReadBaseline(
      manifestPath,
      "tiny",
      "read-wave-1",
      loaded.oracle.legacyBaseline,
    );
    const incompleteOracle = structuredClone(loaded.oracle) as Record<string, unknown>;
    incompleteOracle.provenance = { kind: "reviewed-offline-snapshot" };
    expect(raviAppReadOracleSchema.safeParse(incompleteOracle).success).toBe(false);
    expect(raviAppReadOracleSchema.safeParse({ ...loaded.oracle, selfCertified: true }).success).toBe(false);
    expect(raviAppSdeReadBaselineSchema.safeParse({ ...loadedBaseline.baseline, mutableSource: true }).success).toBe(
      false,
    );
  });

  test("validates real wave envelopes against the pinned JSON Schema and rejects missing official fields", async () => {
    const schema = JSON.parse(
      await readFile(join(import.meta.dir, "schemas/read-output.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const definitions = schema.$defs as Record<string, Record<string, unknown>>;

    expect(schema.oneOf).toEqual([{ $ref: "#/$defs/dryRunEnvelope" }, { $ref: "#/$defs/liveEnvelope" }]);
    expect(definitions.dryRunEnvelope.additionalProperties).toBe(false);
    expect(definitions.liveEnvelope.additionalProperties).toBe(false);
    expect(definitions.requestPlan.additionalProperties).toBe(false);
    expect(definitions.tinyData.additionalProperties).toBe(false);
    expect(definitions.observedQuota.additionalProperties).toBe(false);
    expect(definitions.quotaPolicy.additionalProperties).toBe(false);
    expect(definitions.dryRunEnvelope.required).toEqual(["ok", "dryRun", "request"]);
    expect(definitions.liveEnvelope.required).toEqual(["ok", "dryRun", "tenant", "data", "quota"]);

    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const dryRunInput = parseTinyReadInput("info", []);
    const dryRunEnvelope = {
      ok: true,
      dryRun: true,
      request: buildTinyReadPlan(dryRunInput, "fixture-tenant", "fixture-primary", false),
    };
    expect(validate(dryRunEnvelope), JSON.stringify(validate.errors)).toBe(true);

    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const client = createReadClient(`schema-${operation}`, async () => Response.json(nominalPayload(operation)));
      const result = await client.read(parseTinyReadInput(operation, validArgs(operation)));
      const envelope = { ok: true, dryRun: false, tenant: "fixture-tenant", ...result };
      expect(validate(envelope), `${operation}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }

    const missingOfficialField = {
      ok: true,
      dryRun: false,
      tenant: "fixture-tenant",
      data: { retorno: { status: "OK" } },
      quota: {
        policy: publicTinyQuota(TINY_V2_QUOTA),
        observed: { limitPerMinute: null, retryAfterSeconds: null },
      },
    };
    expect(validate(missingOfficialField)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ instancePath: "/data/retorno", keyword: "required" })]),
    );
  });

  test("defines a normalized contract and all required cases for 100% of the wave", () => {
    expect(TINY_READ_WAVE_1_OPERATIONS).toHaveLength(6);
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const contract = getTinyReadContract(operation);
      expect(contract.parity, operation).toMatchObject({
        version: "ravi-app-read-parity/v1",
        tenantIsolation: "explicit-tenant+broker-connection",
        errorPolicy: "redacted-code-only",
        cases: [...TINY_READ_PARITY_CASES],
      });
      expect(contract.officialDoc, operation).toMatch(/^https:\/\/tiny\.com\.br\/api-docs\/api2-/);
    }
  });

  test("covers the nominal state for every operation", async () => {
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      let capturedUrl = "";
      let capturedBody = "";
      const payload = nominalPayload(operation);
      const client = createReadClient(`nominal-${operation}`, async (input, init) => {
        capturedUrl = String(input);
        capturedBody = String(init?.body);
        return Response.json(payload);
      });
      const input = parseTinyReadInput(operation, validArgs(operation));
      const result = await client.read(input);

      expect(result.data, operation).toEqual(payload);
      expect(capturedUrl.endsWith(input.path), operation).toBe(true);
      expect(capturedBody, operation).toContain("token=test-secret");
      expect(capturedBody, operation).toContain("formato=json");
    }
  });

  test("covers the explicit empty state for every operation", async () => {
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const contract = getTinyReadContract(operation).parity;
      if (!contract) throw new Error(`Missing parity contract for ${operation}.`);
      const client = createReadClient(`empty-${operation}`, async () => {
        if (contract.emptyState === "empty-success")
          return Response.json({ retorno: { status: "OK", status_processamento: "3" } });
        return Response.json({
          retorno: {
            status: "Erro",
            status_processamento: "3",
            codigo_erro: 20,
            erros: [{ erro: "fixture-sensitive-empty" }],
          },
        });
      });
      const read = client.read(parseTinyReadInput(operation, validArgs(operation)));

      if (contract.emptyState === "empty-collection") {
        const result = await read;
        expect(result.data, operation).toEqual({
          retorno: {
            status: "OK",
            status_processamento: "3",
            pagina: 1,
            numero_paginas: 0,
            [contract.collectionKey as string]: [],
          },
        });
      } else if (contract.emptyState === "not-found-error") {
        const error = await captureError(read);
        expect(error.message, operation).toContain(`Tiny recusou ${operation}`);
        expect(error.message, operation).toContain("codigo 20");
        expect(error.message, operation).not.toContain("fixture-sensitive-empty");
      } else {
        const result = await read;
        expect(result.data, operation).toEqual({ retorno: { status: "OK", status_processamento: "3" } });
      }
    }
  });

  test("covers redacted upstream errors for every operation", async () => {
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const client = createReadClient(`error-${operation}`, async () =>
        Response.json({
          retorno: {
            status: "Erro",
            status_processamento: "3",
            codigo_erro: 2,
            erros: [{ erro: "fixture-sensitive-error" }],
          },
        }),
      );
      const error = await captureError(client.read(parseTinyReadInput(operation, validArgs(operation))));

      expect(error.message, operation).toContain(`Tiny recusou ${operation}`);
      expect(error.message, operation).toContain("codigo 2");
      expect(error.message, operation).not.toContain("test-secret");
      expect(error.message, operation).not.toContain("fixture-sensitive-error");
    }
  });

  test("covers pagination or an explicit not-applicable state for every operation", async () => {
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const contract = getTinyReadContract(operation).parity;
      if (!contract) throw new Error(`Missing parity contract for ${operation}.`);
      if (contract.pagination === "not-applicable") {
        expect(() => parseTinyReadInput(operation, [...validArgs(operation), "--pagina", "2"]), operation).toThrow(
          "Opcao desconhecida",
        );
        continue;
      }

      let capturedBody = "";
      const client = createReadClient(`pagination-${operation}`, async (_input, init) => {
        capturedBody = String(init?.body);
        return Response.json({
          retorno: {
            status: "OK",
            status_processamento: "3",
            pagina: 2,
            numero_paginas: 3,
            [contract.collectionKey as string]: [],
          },
        });
      });
      const result = await client.read(parseTinyReadInput(operation, [...validArgs(operation), "--pagina", "2"]));

      expect(result.data, operation).toMatchObject({ retorno: { pagina: 2, numero_paginas: 3 } });
      expect(capturedBody, operation).toContain("pagina=2");
    }
  });

  test("covers explicit tenant and broker-connection isolation for every operation", () => {
    for (const operation of TINY_READ_WAVE_1_OPERATIONS) {
      const input = parseTinyReadInput(operation, validArgs(operation));
      const tenantA = buildTinyReadPlan(input, "tenant-a", "tenant-a-primary", false);
      const tenantB = buildTinyReadPlan(input, "tenant-b", "tenant-b-primary", false);

      expect(tenantA, operation).toMatchObject({
        tenant: "tenant-a",
        credentialConnection: "tenant-a-primary",
        networkCalled: false,
        secretResolved: false,
      });
      expect(tenantB, operation).toMatchObject({
        tenant: "tenant-b",
        credentialConnection: "tenant-b-primary",
        networkCalled: false,
        secretResolved: false,
      });
      expect(tenantA.credentialConnection, operation).not.toBe(tenantB.credentialConnection);
    }
  });
});

function validArgs(operation: TinyReadWaveOneOperation): string[] {
  switch (operation) {
    case "info":
      return [];
    case "contatos":
    case "produtos":
      return ["--pesquisa", "fixture"];
    case "contato":
      return ["101"];
    case "produto":
      return ["202"];
    case "estoque":
      return ["303"];
  }
}

function nominalPayload(operation: TinyReadWaveOneOperation): unknown {
  switch (operation) {
    case "info":
      return { retorno: { status: "OK", status_processamento: "3", conta: { id: "fixture-account" } } };
    case "contatos":
      return {
        retorno: {
          status: "OK",
          status_processamento: "3",
          pagina: 1,
          numero_paginas: 1,
          contatos: [{ contato: { id: "101" } }],
        },
      };
    case "contato":
      return { retorno: { status: "OK", status_processamento: "3", contato: { id: "101" } } };
    case "produtos":
      return {
        retorno: {
          status: "OK",
          status_processamento: "3",
          pagina: 1,
          numero_paginas: 1,
          produtos: [{ produto: { id: "202" } }],
        },
      };
    case "produto":
      return { retorno: { status: "OK", status_processamento: "3", produto: { id: "202" } } };
    case "estoque":
      return { retorno: { status: "OK", status_processamento: "3", produto: { id: "303", saldo: 1 } } };
  }
}

function createReadClient(connection: string, fetchImpl: TinyFetch): TinyClient {
  return new TinyClient({
    config: {
      tenant: "fixture-tenant",
      apiVersion: "v2",
      credentialProvider: "tiny",
      credentialConnection: connection,
      baseUrl: "https://api.tiny.com.br/api2",
    },
    credential: "test-secret",
    fetchImpl,
  });
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error("Expected an Error instance from Tiny read.");
  }
  throw new Error("Expected Tiny read to reject.");
}
