/**
 * Pure functions for projecting the registry into the codegen-friendly shapes
 * (input JSON Schema, return JSON Schema, signature args). Kept separate from
 * the file emitters so tests can pin behaviour for individual commands without
 * touching the surrounding TypeScript output.
 */

import { z, type ZodTypeAny } from "zod";
import type { ArgRegistryEntry, CommandRegistryEntry, OptionRegistryEntry } from "../../cli/registry-snapshot.js";
import { jsonSchemaToTs, type JsonSchema } from "./json-schema-to-ts.js";

const ZOD_OPTIONS = { unrepresentable: "any" } as const;

/** Convert a single Zod schema to JSON Schema, dropping the `$schema` draft marker. */
export function zodToJson(schema: ZodTypeAny, description?: string): JsonSchema {
  const json = z.toJSONSchema(schema, ZOD_OPTIONS) as JsonSchema;
  delete (json as { $schema?: unknown }).$schema;
  if (description !== undefined && typeof (json as { description?: unknown }).description !== "string") {
    (json as { description?: string }).description = description;
  }
  return json;
}

/**
 * Build the flat input JSON Schema for a command (args + options merged).
 *
 * Mirrors `sdk/openapi/emit.ts` — we do NOT depend on it here because the
 * codegen only needs the raw schema, not a full OpenAPI operation. Keeping
 * the projection local also lets the codegen evolve independently.
 */
export function buildInputSchema(cmd: CommandRegistryEntry): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const sortedArgs = sortByIndex(cmd.args);
  for (const arg of sortedArgs) {
    properties[arg.name] = zodToJson(arg.schema, arg.description);
    if (arg.required && arg.defaultValue === undefined) {
      required.push(arg.name);
    }
  }
  for (const opt of cmd.options) {
    if (properties[opt.name] !== undefined) continue; // arg wins on collision
    properties[opt.name] = zodToJson(opt.schema, opt.description);
  }

  const sortedKeys = Object.keys(properties).sort();
  const sortedProps: Record<string, JsonSchema> = {};
  for (const key of sortedKeys) sortedProps[key] = properties[key];

  const schema: JsonSchema = {
    type: "object",
    properties: sortedProps,
    additionalProperties: false,
  };
  if (required.length > 0) (schema as { required: string[] }).required = [...required].sort();
  return schema;
}

/** Return the JSON Schema for a command's `@Returns(...)` declaration, if any. */
export function buildReturnSchema(cmd: CommandRegistryEntry): JsonSchema | null {
  if (!cmd.returns) return null;
  return zodToJson(cmd.returns);
}

export interface SignatureArg {
  name: string;
  /** TS type expression for this position. */
  type: string;
  /** Whether the value is required; `false` adds `?` to the param. */
  required: boolean;
  /** True only when this is the last positional and the registry marks it variadic. */
  variadic: boolean;
}

export interface SignatureOption {
  name: string;
  type: string;
  required: boolean;
}

export interface CommandSignature {
  /** Positional args in registry index order. */
  args: SignatureArg[];
  /** Trailing options bag (optional bag if every option is optional). */
  options: SignatureOption[];
  /** Whether the trailing options bag should be optional (`options?:`). */
  optionsOptional: boolean;
}

/**
 * Shape the signature of a generated method. Pure data — the emitter handles
 * stringification.
 *
 * Args are emitted as positional parameters (variadic last); options collapse
 * into a single trailing object whose keys come from the input JSON Schema.
 * That object is the optional bag in `(id, options?)`.
 */
export function buildSignature(cmd: CommandRegistryEntry, inputSchema: JsonSchema): CommandSignature {
  const props = (inputSchema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const required = new Set((inputSchema as { required?: string[] }).required ?? []);

  const args: SignatureArg[] = sortByIndex(cmd.args).map((arg) => {
    const schema = props[arg.name] ?? {};
    return {
      name: arg.name,
      type: typeForArg(arg, schema),
      required: required.has(arg.name),
      variadic: arg.variadic === true,
    };
  });

  const argNames = new Set(args.map((a) => a.name));
  const options: SignatureOption[] = [];
  for (const opt of cmd.options) {
    if (argNames.has(opt.name)) continue;
    const schema = props[opt.name] ?? {};
    options.push({
      name: opt.name,
      type: typeForOption(schema),
      required: required.has(opt.name),
    });
  }
  options.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const optionsOptional = options.every((o) => !o.required);
  return { args, options, optionsOptional };
}

function sortByIndex(args: ArgRegistryEntry[]): ArgRegistryEntry[] {
  return [...args].sort((a, b) => a.index - b.index);
}

function typeForArg(arg: ArgRegistryEntry, schema: JsonSchema): string {
  if (arg.variadic) {
    const items = (schema as { items?: JsonSchema | JsonSchema[] }).items;
    const itemSchema = Array.isArray(items) ? items[0] : items;
    return arrayTypeFromItems(itemSchema);
  }
  return jsonSchemaToTs(schema, 0);
}

function typeForOption(schema: JsonSchema): string {
  return jsonSchemaToTs(schema, 0);
}

function arrayTypeFromItems(itemSchema: JsonSchema | undefined): string {
  const inner = jsonSchemaToTs(itemSchema ?? { type: "string" }, 0);
  return /[ |&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
}

/** Force-shadow OptionRegistryEntry usage for clarity in IDEs. */
export type _OptionRegistryShape = OptionRegistryEntry;
