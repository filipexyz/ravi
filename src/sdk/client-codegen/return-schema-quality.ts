import type { CommandRegistryEntry, RegistrySnapshot } from "../../cli/registry-snapshot.js";
import { getRegistry } from "../../cli/registry-snapshot.js";
import { buildReturnSchema } from "./registry-shape.js";
import type { JsonSchema } from "./json-schema-to-ts.js";

export type ReturnSchemaQualityIssueCode =
  | "UNKNOWN_SCHEMA"
  | "UNKNOWN_ARRAY_ITEMS"
  | "OPEN_OBJECT"
  | "EMPTY_OBJECT"
  | "UNKNOWN_ADDITIONAL_PROPERTIES";

export interface ReturnSchemaQualityIssue {
  code: ReturnSchemaQualityIssueCode;
  path: string;
  message: string;
}

export interface ReturnSchemaQualityReport {
  command: string;
  issues: ReturnSchemaQualityIssue[];
}

export function currentWeakPublicReturnCommands(registry: RegistrySnapshot = getRegistry()): string[] {
  return registry.commands
    .filter((cmd) => !cmd.cliOnly && !cmd.binary && Boolean(cmd.returns))
    .filter((cmd) => analyzeCommandReturnSchema(cmd).issues.length > 0)
    .map((cmd) => cmd.fullName)
    .sort((a, b) => a.localeCompare(b));
}

export function currentCliOnlyCommands(registry: RegistrySnapshot = getRegistry()): string[] {
  return registry.commands
    .filter((cmd) => cmd.cliOnly === true)
    .map((cmd) => cmd.fullName)
    .sort((a, b) => a.localeCompare(b));
}

export function analyzeCommandReturnSchema(cmd: CommandRegistryEntry): ReturnSchemaQualityReport {
  const schema = buildReturnSchema(cmd);
  return {
    command: cmd.fullName,
    issues: schema ? collectWeakSchemaIssues(schema, "$") : [],
  };
}

function collectWeakSchemaIssues(schema: JsonSchema, path: string): ReturnSchemaQualityIssue[] {
  const issues: ReturnSchemaQualityIssue[] = [];
  if (Object.keys(schema).length === 0) {
    issues.push({
      code: "UNKNOWN_SCHEMA",
      path,
      message: "Schema lowers to unknown; return contracts must expose a concrete JSON shape.",
    });
    return issues;
  }

  const anyOf = getSchemaArray(schema, "anyOf");
  const oneOf = getSchemaArray(schema, "oneOf");
  const allOf = getSchemaArray(schema, "allOf");
  for (const [keyword, branches] of [
    ["anyOf", anyOf],
    ["oneOf", oneOf],
    ["allOf", allOf],
  ] as const) {
    if (!branches) continue;
    for (let index = 0; index < branches.length; index++) {
      issues.push(...collectWeakSchemaIssues(branches[index], `${path}.${keyword}[${index}]`));
    }
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    for (const branchType of type) {
      if (typeof branchType !== "string") continue;
      issues.push(...collectWeakTypedSchemaIssues({ ...schema, type: branchType }, path));
    }
    return issues;
  }
  if (typeof type === "string") {
    issues.push(...collectWeakTypedSchemaIssues(schema as JsonSchema & { type: string }, path));
  }
  return issues;
}

function collectWeakTypedSchemaIssues(schema: JsonSchema & { type: string }, path: string): ReturnSchemaQualityIssue[] {
  switch (schema.type) {
    case "array": {
      const items = schema.items;
      if (!items || !isJsonSchema(items) || Object.keys(items).length === 0) {
        return [
          {
            code: "UNKNOWN_ARRAY_ITEMS",
            path: `${path}.items`,
            message: "Array return schema has unknown items.",
          },
        ];
      }
      return collectWeakSchemaIssues(items, `${path}.items`);
    }
    case "object":
      return collectWeakObjectIssues(schema, path);
    default:
      return [];
  }
}

function collectWeakObjectIssues(schema: JsonSchema, path: string): ReturnSchemaQualityIssue[] {
  const issues: ReturnSchemaQualityIssue[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties).sort();
  const additional = schema.additionalProperties;

  if (propertyNames.length === 0 && additional === false) {
    issues.push({
      code: "EMPTY_OBJECT",
      path,
      message: "Object return schema has no fields.",
    });
  }

  if (additional === undefined) {
    issues.push({
      code: "OPEN_OBJECT",
      path,
      message: "Object return schema allows unspecified properties.",
    });
  } else if (additional === true) {
    issues.push({
      code: "OPEN_OBJECT",
      path,
      message: "Object return schema allows arbitrary properties.",
    });
  } else if (isJsonSchema(additional)) {
    if (Object.keys(additional).length === 0) {
      issues.push({
        code: "UNKNOWN_ADDITIONAL_PROPERTIES",
        path: `${path}.additionalProperties`,
        message: "Object return schema allows arbitrary unknown values.",
      });
    } else {
      issues.push(...collectWeakSchemaIssues(additional, `${path}.additionalProperties`));
    }
  }

  for (const key of propertyNames) {
    const value = properties[key];
    if (isJsonSchema(value)) {
      issues.push(...collectWeakSchemaIssues(value, `${path}.properties.${key}`));
    }
  }
  return issues;
}

function getSchemaArray(schema: JsonSchema, key: "anyOf" | "oneOf" | "allOf"): JsonSchema[] | null {
  const value = schema[key];
  if (!Array.isArray(value)) return null;
  return value.filter(isJsonSchema);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
