import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { RaviAppManifest } from "./types.js";

export const RAVI_APP_READ_ORACLE_SCHEMA = "ravi.app.read-oracle/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmptyStringSchema = z.string().min(1);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const errorCodeSchema = z.union([z.string(), z.number()]);
const responseFixtureSchema = z
  .object({
    upstream: z.json(),
    expected: z.json(),
  })
  .strict();
const emptyFixtureSchema = z.discriminatedUnion("mode", [
  responseFixtureSchema.extend({ mode: z.literal("success") }).strict(),
  responseFixtureSchema.extend({ mode: z.literal("collection") }).strict(),
  z
    .object({
      mode: z.literal("error"),
      upstream: z.json(),
      expectedCode: errorCodeSchema,
    })
    .strict(),
]);
const paginationFixtureSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("not-applicable") }).strict(),
  responseFixtureSchema
    .extend({
      mode: z.literal("pagina+numero_paginas"),
      args: z.array(nonEmptyStringSchema),
    })
    .strict(),
]);

export const raviAppReadOracleOperationSchema = z
  .object({
    command: nonEmptyStringSchema,
    arguments: z.array(nonEmptyStringSchema),
    options: z.array(nonEmptyStringSchema),
    endpoint: z
      .object({
        method: z.literal("POST"),
        baseUrl: z.string().url(),
        path: z.string().regex(/^\/[a-z0-9.-]+$/),
      })
      .strict(),
    inputSchema: z.json(),
    outputSchema: z
      .object({
        path: z.string().regex(/^schemas\/[a-z0-9.-]+\.json$/),
        sha256: sha256Schema,
      })
      .strict(),
    parity: z
      .object({
        version: z.literal("ravi-app-read-parity/v1"),
        responseKind: z.enum(["single", "collection"]),
        collectionKey: z.string().min(1).nullable(),
        emptyState: z.enum(["empty-success", "empty-collection", "not-found-error"]),
        pagination: z.enum(["not-applicable", "pagina+numero_paginas"]),
        tenantIsolation: z.literal("explicit-tenant+broker-connection"),
        errorPolicy: z.literal("redacted-code-only"),
        cases: z.tuple([
          z.literal("nominal"),
          z.literal("empty"),
          z.literal("error"),
          z.literal("pagination"),
          z.literal("tenant"),
        ]),
      })
      .strict(),
    fixtures: z
      .object({
        args: z.array(nonEmptyStringSchema),
        input: z
          .object({
            path: z.string().regex(/^\/[a-z0-9.-]+$/),
            params: z.record(z.string(), z.string()),
          })
          .strict(),
        nominal: responseFixtureSchema,
        empty: emptyFixtureSchema,
        error: z
          .object({
            upstream: z.json(),
            expectedCode: errorCodeSchema,
          })
          .strict(),
        pagination: paginationFixtureSchema,
        tenant: z
          .object({
            first: z.tuple([nonEmptyStringSchema, nonEmptyStringSchema]),
            second: z.tuple([nonEmptyStringSchema, nonEmptyStringSchema]),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const raviAppReadOracleSchema = z
  .object({
    schema: z.literal(RAVI_APP_READ_ORACLE_SCHEMA),
    appId: z.string().regex(/^[a-z0-9][a-z0-9/-]*$/),
    waveId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    sanitized: z.literal(true),
    provenance: z
      .object({
        kind: z.literal("reviewed-offline-snapshot"),
        source: nonEmptyStringSchema,
        independentOf: z.array(nonEmptyStringSchema),
        reviewedAt: dateSchema,
      })
      .strict(),
    legacyBaseline: z
      .object({
        schema: z.literal("ravi.app.sde-read-baseline/v1"),
        path: z.string().regex(/^[a-z0-9][a-z0-9.-]+\.json$/),
        sha256: sha256Schema,
      })
      .strict(),
    operations: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), raviAppReadOracleOperationSchema),
  })
  .strict()
  .superRefine((value, context) => {
    for (const required of ["sde", "ravi.app.json", "generate-manifest.ts"]) {
      if (!value.provenance.independentOf.includes(required)) {
        context.addIssue({
          code: "custom",
          path: ["provenance", "independentOf"],
          message: `must include ${required}`,
        });
      }
    }
    if (Object.keys(value.operations).length === 0) {
      context.addIssue({ code: "custom", path: ["operations"], message: "must contain at least one operation" });
    }
  });

export type RaviAppReadOracleOperation = z.infer<typeof raviAppReadOracleOperationSchema>;
export type RaviAppReadOracle = z.infer<typeof raviAppReadOracleSchema>;

export interface LoadedRaviAppReadOracle {
  path: string;
  sha256: string;
  oracle: RaviAppReadOracle;
}

export interface RaviAppReadOracleComparison {
  expectedOperations: string[];
  implementedOperations: string[];
  missingOperations: string[];
  extraCliOperations: string[];
  commandMismatches: Array<{
    operationId: string;
    expectedCommand: string;
    actualCommand: string | null;
  }>;
  contractMismatches: Array<{
    operationId: string;
    fields: string[];
  }>;
}

export function loadRaviAppReadOracle(manifestPath: string, appId: string, waveId: string): LoadedRaviAppReadOracle {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(waveId)) {
    throw new Error(`Invalid read oracle wave id '${waveId}'. Use a lowercase slug.`);
  }
  const path = join(dirname(manifestPath), "oracles", `${waveId}.oracle.json`);
  if (!existsSync(path)) {
    throw new Error(
      `Migration wave '${waveId}' for app ${appId} requires independent oracle ${path}; manifest-declared parity cannot certify itself.`,
    );
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid read oracle JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const oracle = parseReadOracle(parsed, path);
  if (oracle.appId !== appId) {
    throw new Error(`Read oracle ${path} belongs to app ${oracle.appId}, expected ${appId}.`);
  }
  if (oracle.waveId !== waveId) {
    throw new Error(`Read oracle ${path} belongs to wave ${oracle.waveId}, expected ${waveId}.`);
  }
  return {
    path,
    sha256: createHash("sha256").update(raw).digest("hex"),
    oracle,
  };
}

export function compareRaviAppReadWaveToOracle(input: {
  manifest: RaviAppManifest | null;
  manifestPath: string;
  declaredOperationIds: string[];
  loaded: LoadedRaviAppReadOracle;
}): RaviAppReadOracleComparison {
  const { manifest, manifestPath, declaredOperationIds, loaded } = input;
  const operationPrefix = loaded.oracle.appId.replace(/\//g, ".");
  const operations = isRecord(manifest?.operations) ? manifest.operations : {};
  const oracleOperations = new Map(
    Object.entries(loaded.oracle.operations).map(([localId, operation]) => [
      localId.startsWith(`${operationPrefix}.`) ? localId : `${operationPrefix}.${localId}`,
      operation,
    ]),
  );
  const expectedOperations = Array.from(oracleOperations.keys()).sort();
  const declaredSet = new Set(declaredOperationIds);
  const implementedOperations = expectedOperations.filter((operationId) => isCliOperation(operations[operationId]));
  const missingOperations = expectedOperations.filter(
    (operationId) => !declaredSet.has(operationId) || !isCliOperation(operations[operationId]),
  );
  const extraCliOperations = declaredOperationIds.filter((operationId) => !oracleOperations.has(operationId)).sort();
  const commandMismatches = expectedOperations
    .filter((operationId) => isCliOperation(operations[operationId]))
    .map((operationId) => {
      const expected = oracleOperations.get(operationId)!;
      const operation = operations[operationId];
      const actualCommand = isRecord(operation) && typeof operation.command === "string" ? operation.command : null;
      return { operationId, expectedCommand: expected.command, actualCommand };
    })
    .filter(({ expectedCommand, actualCommand }) => expectedCommand !== actualCommand);

  const appDir = dirname(manifestPath);
  const contractMismatches = expectedOperations
    .filter((operationId) => isCliOperation(operations[operationId]))
    .map((operationId) => ({
      operationId,
      fields: compareOperationToOracle(operations[operationId], oracleOperations.get(operationId)!, appDir),
    }))
    .filter(({ fields }) => fields.length > 0);

  return {
    expectedOperations,
    implementedOperations,
    missingOperations,
    extraCliOperations,
    commandMismatches,
    contractMismatches,
  };
}

function compareOperationToOracle(actual: unknown, expected: RaviAppReadOracleOperation, appDir: string): string[] {
  if (!isRecord(actual)) return ["oracle.operation"];
  const fields: string[] = [];
  const help = isRecord(actual.help) ? actual.help : {};
  const actualArguments = Array.isArray(help.arguments)
    ? help.arguments
        .filter(isRecord)
        .map((argument) => argument.name)
        .filter((name): name is string => typeof name === "string")
    : [];
  const actualOptions = Array.isArray(help.options)
    ? help.options
        .filter(isRecord)
        .map((option) => option.flags)
        .filter((flags): flags is string => typeof flags === "string")
    : [];
  if (!sameJsonValue(actualArguments, expected.arguments) || !sameJsonValue(actualOptions, expected.options)) {
    fields.push("oracle.args");
  }

  const endpointSection = Array.isArray(help.sections)
    ? help.sections.find((section) => isRecord(section) && section.title === "ENDPOINT")
    : null;
  const actualEndpoint =
    isRecord(endpointSection) && typeof endpointSection.content === "string" ? endpointSection.content : null;
  const expectedEndpoint = `${expected.endpoint.method} ${expected.endpoint.baseUrl}${expected.endpoint.path}.`;
  if (actualEndpoint !== expectedEndpoint) fields.push("oracle.endpoint");

  if (!sameJsonValue(actual.inputSchema, expected.inputSchema)) fields.push("oracle.input");
  if (actual.outputSchema !== expected.outputSchema.path) fields.push("oracle.output");
  if (
    !outputSchemaMatches(
      appDir,
      typeof actual.outputSchema === "string" ? actual.outputSchema : null,
      expected.outputSchema,
    )
  ) {
    fields.push("oracle.schema");
  }

  const parity = isRecord(actual.parityContract) ? actual.parityContract : {};
  if (
    parity.version !== expected.parity.version ||
    parity.responseKind !== expected.parity.responseKind ||
    parity.collectionKey !== expected.parity.collectionKey ||
    !hasCase(parity, "nominal")
  ) {
    fields.push("oracle.nominal");
  }
  if (parity.emptyState !== expected.parity.emptyState || !hasCase(parity, "empty")) {
    fields.push("oracle.empty");
  }
  if (parity.errorPolicy !== expected.parity.errorPolicy || !hasCase(parity, "error")) {
    fields.push("oracle.error");
  }
  if (parity.pagination !== expected.parity.pagination || !hasCase(parity, "pagination")) {
    fields.push("oracle.pagination");
  }
  if (parity.tenantIsolation !== expected.parity.tenantIsolation || !hasCase(parity, "tenant")) {
    fields.push("oracle.tenant");
  }
  return fields;
}

function outputSchemaMatches(
  appDir: string,
  actualPath: string | null,
  expected: RaviAppReadOracleOperation["outputSchema"],
): boolean {
  if (actualPath !== expected.path) return false;
  const schemaPath = resolve(appDir, actualPath);
  const appRoot = `${resolve(appDir)}${sep}`;
  if (!schemaPath.startsWith(appRoot) || !existsSync(schemaPath)) return false;
  const hash = createHash("sha256").update(readFileSync(schemaPath)).digest("hex");
  return hash === expected.sha256;
}

function hasCase(parity: Record<string, unknown>, name: string): boolean {
  return Array.isArray(parity.cases) && parity.cases.includes(name);
}

function parseReadOracle(value: unknown, path: string): RaviAppReadOracle {
  const result = raviAppReadOracleSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid read oracle ${path}: ${z.prettifyError(result.error)}`);
  return result.data;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCliOperation(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.interface === "cli";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
