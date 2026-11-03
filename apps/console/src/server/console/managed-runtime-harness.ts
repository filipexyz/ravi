import { createHash } from "node:crypto";
import { z } from "zod";

import type { JsonRecord } from "@/server/db/schema";

const RAVI_APP_SCHEMA = "ravi.app/v1";
const MANAGED_HARNESS_SCHEMA = "ravi.managed-harness/v1";

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const HARNESS_SLUG_PATTERN = /^[a-z][a-z0-9-]*(?:-[a-z0-9]+)*$/;

const nonEmptyStringSchema = z.string().trim().min(1);
const jsonRecordSchema = z.record(z.string(), z.unknown()).default({});

const appPermissionsSchema = z
  .object({
    mutating: z.array(nonEmptyStringSchema).optional(),
    optional: z.array(nonEmptyStringSchema).optional(),
    provider: z.unknown().nullable().optional(),
    required: z.array(nonEmptyStringSchema).optional(),
  })
  .passthrough()
  .default({});

const appOperationSchema = z
  .object({
    aliases: z.array(nonEmptyStringSchema).optional(),
    authorization: z.unknown().optional(),
    channel: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    handler: z.string().trim().min(1).optional(),
    inputSchema: z.unknown().optional(),
    interface: z.enum(["builtin", "cli", "sdk", "tool", "stream"]),
    json: z.boolean().optional(),
    method: z.string().trim().min(1).optional(),
    mutating: z.boolean().optional(),
    name: z.string().trim().min(1).optional(),
    namespace: z.string().trim().min(1).optional(),
    outputSchema: z.unknown().optional(),
    permission: z.string().trim().min(1).optional(),
    permissions: z.array(nonEmptyStringSchema).optional(),
  })
  .passthrough();

const raviAppManifestSchema = z
  .object({
    artifacts: z.unknown().optional(),
    description: z.string().trim().min(1),
    events: z.unknown().optional(),
    health: z.unknown().optional(),
    id: z.string().trim().regex(APP_ID_PATTERN),
    interfaces: z.record(z.string(), z.unknown()).default({}),
    name: z.string().trim().min(1),
    operations: z.record(z.string(), appOperationSchema).default({}),
    permissions: appPermissionsSchema,
    schema: z.literal(RAVI_APP_SCHEMA),
    skills: z.unknown().optional(),
    storage: z.unknown().optional(),
    version: z.string().trim().min(1),
    versioning: z.unknown().optional(),
  })
  .passthrough();

const compileAppInputSchema = z.object({
  manifest: raviAppManifestSchema,
  manifestPath: z.string().trim().min(1).optional(),
  manifestSource: z.string().trim().min(1).optional(),
  required: z.boolean().default(true),
  selectedOperations: z.array(nonEmptyStringSchema).optional(),
  selectedSkills: z.array(nonEmptyStringSchema).optional(),
});

const compileInputSchema = z.object({
  apps: z.array(compileAppInputSchema).min(1),
  baseAgentId: z.string().trim().min(1).nullable().optional(),
  baseProfileId: z.string().trim().min(1).nullable().optional(),
  displayName: z.string().trim().min(1).max(160),
  runtimePolicy: jsonRecordSchema.optional(),
  safeMetadata: jsonRecordSchema.optional(),
  slug: z.string().trim().regex(HARNESS_SLUG_PATTERN),
});

type RaviAppManifest = z.infer<typeof raviAppManifestSchema>;
type RaviAppOperation = z.infer<typeof appOperationSchema>;
type CompileInput = z.input<typeof compileInputSchema>;
type ParsedCompileInput = z.infer<typeof compileInputSchema>;

export type ManagedExecutionHarnessCompileInput = CompileInput;

export type ManagedExecutionHarnessCompileResult = {
  harness: {
    baseAgentId: string | null;
    baseProfileId: string | null;
    compiledBundleJson: JsonRecord;
    displayName: string;
    harnessHash: string;
    runtimePolicyJson: JsonRecord;
    safeMetadataJson: JsonRecord;
    slug: string;
  };
  apps: ManagedExecutionHarnessAppProjection[];
  toolProjections: ManagedExecutionToolProjection[];
};

export type ManagedExecutionHarnessAppProjection = {
  appId: string;
  appVersion: string;
  manifestHash: string;
  manifestPath: string | null;
  manifestSource: string | null;
  manifestSummaryJson: JsonRecord;
  permissionProjectionJson: JsonRecord;
  position: number;
  required: boolean;
  selectedOperationsJson: string[];
  selectedSkillsJson: string[];
  toolProjectionJson: JsonRecord[];
};

export type ManagedExecutionToolProjection = {
  appId: string;
  inputSchemaJson: unknown | null;
  interfaceName: string;
  mutating: boolean;
  operationId: string;
  outputSchemaJson: unknown | null;
  permissionRequirementJson: JsonRecord;
  safeMetadataJson: JsonRecord;
  toolId: string;
  toolName: string;
};

export class ManagedExecutionHarnessCompileError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "ManagedExecutionHarnessCompileError";
  }
}

export function compileManagedExecutionHarness(
  input: ManagedExecutionHarnessCompileInput,
): ManagedExecutionHarnessCompileResult {
  const parsed = parseCompileInput(input);
  const issues: string[] = [];
  const appIds = new Set<string>();
  const toolIds = new Set<string>();
  const toolNames = new Set<string>();
  const appProjections: ManagedExecutionHarnessAppProjection[] = [];
  const toolProjections: ManagedExecutionToolProjection[] = [];

  parsed.apps.forEach((appInput, position) => {
    const manifest = appInput.manifest;
    if (appIds.has(manifest.id)) {
      issues.push(`apps[${position}] duplicates app id "${manifest.id}".`);
      return;
    }
    appIds.add(manifest.id);

    const operationMap = manifest.operations;
    const operationIds = Object.keys(operationMap).sort();
    validateOperationIds(manifest, operationIds, position, issues);

    const selectedOperations = selectedOperationIds({
      appId: manifest.id,
      appIndex: position,
      availableOperationIds: operationIds,
      issues,
      selectedOperations: appInput.selectedOperations,
    });
    const selectedSkills = selectedSkillIds(manifest.skills, appInput.selectedSkills);
    const manifestHash = prefixedSha256(manifest);
    const appToolProjections: ManagedExecutionToolProjection[] = [];

    for (const operationId of selectedOperations) {
      const operation = operationMap[operationId];
      if (!operation) continue;

      const projection = projectOperationTool({
        appId: manifest.id,
        appIndex: position,
        manifest,
        operation,
        operationId,
        issues,
      });

      if (toolIds.has(projection.toolId)) {
        issues.push(`apps[${position}].operations.${operationId} projects duplicate tool id "${projection.toolId}".`);
      }
      if (toolNames.has(projection.toolName)) {
        issues.push(`apps[${position}].operations.${operationId} projects duplicate tool name "${projection.toolName}".`);
      }
      toolIds.add(projection.toolId);
      toolNames.add(projection.toolName);
      appToolProjections.push(projection);
      toolProjections.push(projection);
    }

    appProjections.push({
      appId: manifest.id,
      appVersion: manifest.version,
      manifestHash,
      manifestPath: appInput.manifestPath ?? null,
      manifestSource: appInput.manifestSource ?? null,
      manifestSummaryJson: manifestSummary(manifest, selectedOperations, selectedSkills),
      permissionProjectionJson: permissionProjection(manifest, selectedOperations),
      position,
      required: appInput.required,
      selectedOperationsJson: selectedOperations,
      selectedSkillsJson: selectedSkills,
      toolProjectionJson: appToolProjections.map((projection) => toolProjectionRecord(projection)),
    });
  });

  if (issues.length > 0) {
    throw new ManagedExecutionHarnessCompileError(issues);
  }

  const runtimePolicy = toJsonRecord(parsed.runtimePolicy);
  const compiledBundle = buildCompiledBundle({
    input: parsed,
    apps: appProjections,
    runtimePolicy,
    toolProjections,
  });

  return {
    apps: appProjections,
    harness: {
      baseAgentId: parsed.baseAgentId ?? null,
      baseProfileId: parsed.baseProfileId ?? null,
      compiledBundleJson: compiledBundle,
      displayName: parsed.displayName,
      harnessHash: prefixedSha256(compiledBundle),
      runtimePolicyJson: runtimePolicy,
      safeMetadataJson: toJsonRecord(parsed.safeMetadata),
      slug: parsed.slug,
    },
    toolProjections,
  };
}

function parseCompileInput(input: ManagedExecutionHarnessCompileInput): ParsedCompileInput {
  const parsed = compileInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "input";
    return `${path}: ${issue.message}`;
  });
  throw new ManagedExecutionHarnessCompileError(issues);
}

function validateOperationIds(
  manifest: RaviAppManifest,
  operationIds: string[],
  appIndex: number,
  issues: string[],
) {
  for (const operationId of operationIds) {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      issues.push(`apps[${appIndex}].operations.${operationId} must be a dotted lowercase Ravi App operation id.`);
    }

    const operation = manifest.operations[operationId];
    if (!operation) continue;

    if (operation.mutating === true && !operation.permission && !operation.permissions?.length) {
      issues.push(`apps[${appIndex}].operations.${operationId} is mutating and must declare permission or permissions.`);
    }
  }
}

function selectedOperationIds(input: {
  appId: string;
  appIndex: number;
  availableOperationIds: string[];
  issues: string[];
  selectedOperations?: string[];
}) {
  const selected = input.selectedOperations?.length
    ? sortedUnique(input.selectedOperations)
    : input.availableOperationIds;
  const available = new Set(input.availableOperationIds);

  for (const operationId of selected) {
    if (!available.has(operationId)) {
      input.issues.push(`apps[${input.appIndex}] selected operation "${operationId}" is not declared by ${input.appId}.`);
    }
  }

  return selected;
}

function selectedSkillIds(manifestSkills: unknown, selectedSkills?: string[]) {
  if (selectedSkills?.length) return sortedUnique(selectedSkills);
  if (!Array.isArray(manifestSkills)) return [];
  return sortedUnique(manifestSkills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0));
}

function projectOperationTool(input: {
  appId: string;
  appIndex: number;
  manifest: RaviAppManifest;
  operation: RaviAppOperation;
  operationId: string;
  issues: string[];
}): ManagedExecutionToolProjection {
  const permissions = sortedUnique([
    ...(input.operation.permission ? [input.operation.permission] : []),
    ...(input.operation.permissions ?? []),
  ]);
  const mutating = input.operation.mutating === true;

  if (mutating && permissions.length === 0) {
    input.issues.push(`apps[${input.appIndex}].operations.${input.operationId} cannot be projected as mutating without permissions.`);
  }

  return {
    appId: input.appId,
    inputSchemaJson: input.operation.inputSchema ?? null,
    interfaceName: input.operation.interface,
    mutating,
    operationId: input.operationId,
    outputSchemaJson: input.operation.outputSchema ?? null,
    permissionRequirementJson: {
      appId: input.appId,
      appPermissions: {
        mutating: sortedUnique(input.manifest.permissions.mutating ?? []),
        optional: sortedUnique(input.manifest.permissions.optional ?? []),
        required: sortedUnique(input.manifest.permissions.required ?? []),
      },
      mutating,
      operationId: input.operationId,
      permissions,
      provider: permissionProviderSummary(input.manifest.permissions.provider),
    },
    safeMetadataJson: {
      appId: input.appId,
      appName: input.manifest.name,
      appVersion: input.manifest.version,
      interface: input.operation.interface,
      mutating,
      operationId: input.operationId,
    },
    toolId: `ravi.app://${input.appId}/operations/${input.operationId}`,
    toolName: providerToolName(input.appId, input.operationId),
  };
}

function buildCompiledBundle(input: {
  apps: ManagedExecutionHarnessAppProjection[];
  input: ParsedCompileInput;
  runtimePolicy: JsonRecord;
  toolProjections: ManagedExecutionToolProjection[];
}): JsonRecord {
  return {
    apps: input.apps.map((app) => ({
      appId: app.appId,
      appVersion: app.appVersion,
      manifestHash: app.manifestHash,
      manifestSource: app.manifestSource,
      position: app.position,
      required: app.required,
      selectedOperations: app.selectedOperationsJson,
      selectedSkills: app.selectedSkillsJson,
    })),
    base: {
      agentId: input.input.baseAgentId ?? null,
      profileId: input.input.baseProfileId ?? null,
    },
    displayName: input.input.displayName,
    permissions: aggregatePermissions(input.apps),
    runtimePolicy: input.runtimePolicy,
    schema: MANAGED_HARNESS_SCHEMA,
    slug: input.input.slug,
    tools: input.toolProjections.map((projection) => toolProjectionRecord(projection)),
  };
}

function manifestSummary(
  manifest: RaviAppManifest,
  selectedOperations: string[],
  selectedSkills: string[],
): JsonRecord {
  const interfaceNames = Object.keys(manifest.interfaces).sort();
  const operationIds = Object.keys(manifest.operations).sort();

  return {
    description: manifest.description,
    id: manifest.id,
    interfaceNames,
    name: manifest.name,
    operationCount: operationIds.length,
    schema: manifest.schema,
    selectedOperationCount: selectedOperations.length,
    selectedSkillCount: selectedSkills.length,
    version: manifest.version,
  };
}

function permissionProjection(
  manifest: RaviAppManifest,
  selectedOperations: string[],
): JsonRecord {
  const operationPermissions = selectedOperations.flatMap((operationId) => {
    const operation = manifest.operations[operationId];
    if (!operation) return [];
    return [
      ...(operation.permission ? [operation.permission] : []),
      ...(operation.permissions ?? []),
    ];
  });

  return {
    mutating: sortedUnique(manifest.permissions.mutating ?? []),
    operationPermissions: sortedUnique(operationPermissions),
    optional: sortedUnique(manifest.permissions.optional ?? []),
    provider: permissionProviderSummary(manifest.permissions.provider),
    required: sortedUnique(manifest.permissions.required ?? []),
  };
}

function aggregatePermissions(apps: ManagedExecutionHarnessAppProjection[]): JsonRecord {
  return {
    mutating: sortedUnique(apps.flatMap((app) => stringArrayFromRecord(app.permissionProjectionJson, "mutating"))),
    operationPermissions: sortedUnique(apps.flatMap((app) => stringArrayFromRecord(app.permissionProjectionJson, "operationPermissions"))),
    optional: sortedUnique(apps.flatMap((app) => stringArrayFromRecord(app.permissionProjectionJson, "optional"))),
    required: sortedUnique(apps.flatMap((app) => stringArrayFromRecord(app.permissionProjectionJson, "required"))),
  };
}

function permissionProviderSummary(provider: unknown): JsonRecord | null {
  if (!isRecord(provider)) return null;
  return {
    failClosed: provider.failClosed === true,
    id: stringOrNull(provider.id),
    interface: stringOrNull(provider.interface),
    operation: stringOrNull(provider.operation),
    version: stringOrNull(provider.version),
  };
}

function providerToolName(appId: string, operationId: string) {
  const base = `app__${slugForToolName(appId)}__${slugForToolName(operationId)}`;
  if (base.length <= 96) return base;
  return `${base.slice(0, 83)}__${sha256Hex(base).slice(0, 12)}`;
}

function slugForToolName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function toolProjectionRecord(projection: ManagedExecutionToolProjection): JsonRecord {
  return {
    appId: projection.appId,
    interfaceName: projection.interfaceName,
    mutating: projection.mutating,
    operationId: projection.operationId,
    permissionRequirement: projection.permissionRequirementJson,
    toolId: projection.toolId,
    toolName: projection.toolName,
  };
}

function prefixedSha256(value: unknown) {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function toJsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? (stableValue(value) as JsonRecord) : {};
}

function sortedUnique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function stringArrayFromRecord(record: JsonRecord, key: string) {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
