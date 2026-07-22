import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { RaviAppReadOracle, RaviAppReadOracleOperation } from "./read-oracle.js";
import type { RaviAppManifest } from "./types.js";

export const RAVI_APP_SDE_READ_BASELINE_SCHEMA = "ravi.app.sde-read-baseline/v1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonEmptyStringSchema = z.string().min(1);
const normalizedSuccessSchema = z
  .object({
    kind: z.literal("success"),
    data: z.json(),
    normalization: z.enum(["identity", "tiny-code-20-to-empty-collection"]),
  })
  .strict();
const normalizedErrorSchema = z
  .object({
    kind: z.literal("error"),
    code: z.union([z.string(), z.number()]),
    redaction: z.literal("code-only"),
    normalization: z.literal("identity"),
  })
  .strict();
const normalizedPaginationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("not-applicable") }).strict(),
  z
    .object({
      mode: z.literal("pagina+numero_paginas"),
      data: z.json(),
      normalization: z.literal("identity"),
    })
    .strict(),
]);

const sdeReadBaselineOperationSchema = z
  .object({
    legacyCommand: z.string().regex(/^sde tiny [a-z0-9-]+$/),
    arguments: z.array(nonEmptyStringSchema),
    options: z.array(nonEmptyStringSchema),
    sourceRefs: z
      .array(
        z
          .object({
            path: z.enum(["index.ts", "services/tiny.service.ts"]),
            symbol: nonEmptyStringSchema,
            gitBlob: gitObjectSchema,
          })
          .strict(),
      )
      .min(2),
    appOperation: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    argumentMapping: z
      .object({
        relationship: z.enum(["equivalent", "app-stricter"]),
        appArguments: z.array(nonEmptyStringSchema),
        appOptions: z.array(nonEmptyStringSchema),
        appOnlyOptions: z.array(nonEmptyStringSchema),
        legacyOnlyOptions: z.array(nonEmptyStringSchema),
        renamedOptions: z.array(z.object({ legacy: nonEmptyStringSchema, app: nonEmptyStringSchema }).strict()),
      })
      .strict(),
    normalized: z
      .object({
        nominal: normalizedSuccessSchema,
        empty: z.union([normalizedSuccessSchema, normalizedErrorSchema]),
        error: normalizedErrorSchema,
        pagination: normalizedPaginationSchema,
        tenant: z
          .object({
            legacyIsolation: z.literal("implicit-single-account"),
            appIsolation: z.literal("explicit-tenant+broker-connection"),
            relationship: z.literal("app-stricter"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const raviAppSdeReadBaselineSchema = z
  .object({
    schema: z.literal(RAVI_APP_SDE_READ_BASELINE_SCHEMA),
    appId: z.string().regex(/^[a-z0-9][a-z0-9/-]*$/),
    waveId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    sanitized: z.literal(true),
    source: z
      .object({
        kind: z.literal("immutable-sde-git-snapshot"),
        repository: nonEmptyStringSchema,
        version: nonEmptyStringSchema,
        commit: gitObjectSchema,
        tree: gitObjectSchema,
        capturedAt: dateSchema,
        captureMethod: z.literal("static-git-object-inspection-no-execution"),
        files: z
          .array(
            z
              .object({
                path: z.enum(["index.ts", "services/tiny.service.ts"]),
                gitBlob: gitObjectSchema,
                sha256: sha256Schema,
              })
              .strict(),
          )
          .length(2),
      })
      .strict(),
    review: z
      .object({
        producer: z.object({ kind: z.literal("deterministic-tool"), id: nonEmptyStringSchema }).strict(),
        reviewer: z.object({ kind: z.literal("agent"), id: nonEmptyStringSchema, reviewedAt: dateSchema }).strict(),
        classification: z.literal("sanitized-metadata-and-synthetic-normalized-fixtures"),
        basis: nonEmptyStringSchema,
      })
      .strict(),
    operations: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), sdeReadBaselineOperationSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.operations).length === 0) {
      context.addIssue({ code: "custom", path: ["operations"], message: "must contain at least one operation" });
    }
    const filePaths = value.source.files.map(({ path }) => path);
    if (new Set(filePaths).size !== filePaths.length) {
      context.addIssue({ code: "custom", path: ["source", "files"], message: "must not contain duplicate paths" });
    }
    const filesByPath = new Map(value.source.files.map((file) => [file.path, file]));
    for (const [operationId, operation] of Object.entries(value.operations)) {
      if (operation.appOperation !== operationId) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationId, "appOperation"],
          message: "must equal its operation key",
        });
      }
      const referencedPaths = new Set(operation.sourceRefs.map(({ path }) => path));
      for (const requiredPath of ["index.ts", "services/tiny.service.ts"] as const) {
        if (!referencedPaths.has(requiredPath)) {
          context.addIssue({
            code: "custom",
            path: ["operations", operationId, "sourceRefs"],
            message: `must include ${requiredPath}`,
          });
        }
      }
      for (const [referenceIndex, reference] of operation.sourceRefs.entries()) {
        if (filesByPath.get(reference.path)?.gitBlob !== reference.gitBlob) {
          context.addIssue({
            code: "custom",
            path: ["operations", operationId, "sourceRefs", referenceIndex, "gitBlob"],
            message: "must match the source file pin",
          });
        }
      }
    }
  });

export type RaviAppSdeReadBaseline = z.infer<typeof raviAppSdeReadBaselineSchema>;
export type RaviAppSdeReadBaselineOperation = z.infer<typeof sdeReadBaselineOperationSchema>;

export interface LoadedRaviAppSdeReadBaseline {
  path: string;
  sha256: string;
  baseline: RaviAppSdeReadBaseline;
}

export function loadRaviAppSdeReadBaseline(
  manifestPath: string,
  appId: string,
  waveId: string,
  pin: RaviAppReadOracle["legacyBaseline"],
): LoadedRaviAppSdeReadBaseline {
  const appDirectory = resolve(dirname(manifestPath));
  const path = resolve(appDirectory, "oracles", pin.path);
  const oracleDirectory = `${resolve(appDirectory, "oracles")}${sep}`;
  if (!path.startsWith(oracleDirectory) || !existsSync(path)) {
    throw new Error(`Migration wave '${waveId}' for app ${appId} requires pinned SDE baseline ${path}.`);
  }
  const raw = readFileSync(path, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== pin.sha256) {
    throw new Error(`SDE baseline ${path} sha256 mismatch: expected ${pin.sha256}, observed ${sha256}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid SDE baseline JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = raviAppSdeReadBaselineSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid SDE baseline ${path}: ${z.prettifyError(result.error)}`);
  }
  if (result.data.appId !== appId || result.data.waveId !== waveId) {
    throw new Error(
      `SDE baseline ${path} belongs to ${result.data.appId}/${result.data.waveId}, expected ${appId}/${waveId}.`,
    );
  }
  return { path, sha256, baseline: result.data };
}

export function compareRaviAppReadOracleToSdeBaseline(input: {
  manifest: RaviAppManifest | null;
  oracle: RaviAppReadOracle;
  loadedBaseline: LoadedRaviAppSdeReadBaseline;
}): Array<{ operationId: string; fields: string[] }> {
  const { manifest, oracle, loadedBaseline } = input;
  const prefix = oracle.appId.replace(/\//g, ".");
  const actualOperations = isRecord(manifest?.operations) ? manifest.operations : {};
  const localOperationIds = Array.from(
    new Set([...Object.keys(oracle.operations), ...Object.keys(loadedBaseline.baseline.operations)]),
  ).sort();
  return localOperationIds
    .map((localOperationId) => {
      const operationId = `${prefix}.${localOperationId}`;
      const expected = oracle.operations[localOperationId];
      const baseline = loadedBaseline.baseline.operations[localOperationId];
      const fields: string[] = [];
      if (!expected || !baseline) return { operationId, fields: ["sde.operation"] };
      if (baseline.appOperation !== localOperationId) fields.push("sde.app-operation");
      if (!sameJsonValue(baseline.argumentMapping.appArguments, expected.arguments)) fields.push("sde.args");
      if (!sameJsonValue(baseline.argumentMapping.appOptions, expected.options)) fields.push("sde.options");
      if (!fallbackContains(actualOperations[operationId], baseline.legacyCommand)) fields.push("sde.command");
      compareNormalizedCases(expected, baseline, fields);
      return { operationId, fields };
    })
    .filter(({ fields }) => fields.length > 0);
}

function compareNormalizedCases(
  oracle: RaviAppReadOracleOperation,
  baseline: RaviAppSdeReadBaselineOperation,
  fields: string[],
): void {
  if (!sameJsonValue(baseline.normalized.nominal.data, oracle.fixtures.nominal.expected)) {
    fields.push("sde.nominal");
  }
  const oracleEmpty = oracle.fixtures.empty;
  if (baseline.normalized.empty.kind === "success") {
    if (!("expected" in oracleEmpty) || !sameJsonValue(baseline.normalized.empty.data, oracleEmpty.expected)) {
      fields.push("sde.empty");
    }
  } else if (
    !("expectedCode" in oracleEmpty) ||
    String(baseline.normalized.empty.code) !== String(oracleEmpty.expectedCode)
  ) {
    fields.push("sde.empty");
  }
  if (String(baseline.normalized.error.code) !== String(oracle.fixtures.error.expectedCode)) {
    fields.push("sde.error");
  }
  const oraclePagination = oracle.fixtures.pagination;
  if (baseline.normalized.pagination.mode === "not-applicable") {
    if (oraclePagination.mode !== "not-applicable") fields.push("sde.pagination");
  } else if (
    oraclePagination.mode !== "pagina+numero_paginas" ||
    !sameJsonValue(baseline.normalized.pagination.data, oraclePagination.expected)
  ) {
    fields.push("sde.pagination");
  }
  if (baseline.normalized.tenant.appIsolation !== oracle.parity.tenantIsolation) fields.push("sde.tenant");
}

function fallbackContains(operation: unknown, legacyCommand: string): boolean {
  if (!isRecord(operation) || !isRecord(operation.help) || !Array.isArray(operation.help.sections)) return false;
  return operation.help.sections.some(
    (section) =>
      isRecord(section) &&
      section.title === "FALLBACK" &&
      typeof section.content === "string" &&
      section.content.includes(legacyCommand),
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
