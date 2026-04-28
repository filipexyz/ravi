/**
 * CLI Schema Inference - derive Zod schemas from @Arg / @Option metadata.
 *
 * The flag DSL (commander.js style) is parsed into a normalized shape, then
 * mapped to a default Zod schema. Explicit `schema` on `@Arg` / `@Option`
 * always wins; this module only provides defaults.
 */

import { z, type ZodTypeAny } from "zod";
import type { ArgMetadata, OptionMetadata } from "./decorators.js";
import { extractOptionName } from "./utils.js";

/**
 * Kinds of option flags inferred from the DSL.
 *
 * - boolean         — bare flag, `--json`
 * - negated-boolean — `--no-color`; semantically defaults to `true`
 * - required-value  — `--limit <n>`; commander always passes a string
 * - optional-value  — `--tag [name]`; value optional, still string when present
 * - variadic        — `--items <a...>` / `[a...]`; collected into an array
 */
export type OptionFlagKind = "boolean" | "negated-boolean" | "required-value" | "optional-value" | "variadic";

export interface ParsedOptionFlags {
  shortFlag?: string;
  longFlag: string;
  /** camelCase name as exposed to the rest of the runtime (matches `extractOptionName`). */
  name: string;
  kind: OptionFlagKind;
  raw: string;
}

const FLAG_RE = /^(?:-([a-zA-Z]),\s*)?(--[a-zA-Z][\w-]*)(?:\s+(<[^>]+>|\[[^\]]+\]))?$/;

/**
 * Parse a commander-style flags DSL into a normalized shape.
 * Throws on unrecognized DSL — registry construction must fail loudly.
 */
export function parseFlags(flags: string): ParsedOptionFlags {
  const trimmed = flags.trim();
  const match = trimmed.match(FLAG_RE);
  if (!match) {
    throw new Error(`Cannot parse option flags DSL: ${JSON.stringify(flags)}`);
  }
  const [, short, long, valuePart] = match;
  const longName = long.slice(2);
  const isNegated = longName.startsWith("no-");
  const name = extractOptionName(flags);

  if (!valuePart) {
    return {
      ...(short ? { shortFlag: `-${short}` } : {}),
      longFlag: long,
      name,
      kind: isNegated ? "negated-boolean" : "boolean",
      raw: flags,
    };
  }

  const inner = valuePart.slice(1, -1);
  const isVariadic = inner.endsWith("...");
  const isRequired = valuePart.startsWith("<");

  let kind: OptionFlagKind;
  if (isVariadic) kind = "variadic";
  else if (isRequired) kind = "required-value";
  else kind = "optional-value";

  return {
    ...(short ? { shortFlag: `-${short}` } : {}),
    longFlag: long,
    name,
    kind,
    raw: flags,
  };
}

export interface InferredOptionSchema {
  schema: ZodTypeAny;
  parsed: ParsedOptionFlags;
  source: "explicit" | "inferred";
}

/**
 * Produce a Zod schema for an option, falling back to inference when
 * no explicit schema is present. Inference rules (no spec yet — defaults
 * picked to match commander.js runtime values):
 *
 *   --json                                  -> z.boolean().optional()
 *   --no-color                              -> z.boolean().default(true)
 *   --limit <n>                             -> z.string().optional()
 *   --limit <n> defaultValue: "10"          -> z.string().default("10")
 *   --tag [name]                            -> z.string().optional()
 *   --items <a...>                          -> z.array(z.string()).optional()
 */
export function inferOptionSchema(opt: OptionMetadata): InferredOptionSchema {
  const parsed = parseFlags(opt.flags);
  if (opt.schema) {
    return { schema: opt.schema, parsed, source: "explicit" };
  }

  let schema: ZodTypeAny;
  switch (parsed.kind) {
    case "boolean": {
      const base = z.boolean();
      schema = opt.defaultValue !== undefined ? base.default(Boolean(opt.defaultValue)) : base.optional();
      break;
    }
    case "negated-boolean": {
      const base = z.boolean();
      schema = opt.defaultValue !== undefined ? base.default(Boolean(opt.defaultValue)) : base.default(true);
      break;
    }
    case "required-value":
    case "optional-value": {
      schema = opt.defaultValue !== undefined ? z.string().default(String(opt.defaultValue)) : z.string().optional();
      break;
    }
    case "variadic": {
      const arr = z.array(z.string());
      if (opt.defaultValue !== undefined && Array.isArray(opt.defaultValue)) {
        schema = z.array(z.string()).default(opt.defaultValue.map(String));
      } else {
        schema = arr.optional();
      }
      break;
    }
  }

  return { schema, parsed, source: "inferred" };
}

export interface InferredArgSchema {
  schema: ZodTypeAny;
  source: "explicit" | "inferred";
}

/**
 * Produce a Zod schema for a positional argument:
 *
 *   @Arg("name")                                 -> z.string()
 *   @Arg("name", { required: false })            -> z.string().optional()
 *   @Arg("name", { variadic: true })             -> z.array(z.string())
 *   @Arg("name", { defaultValue: "x" })          -> z.string().default("x")
 *   @Arg("name", { variadic: true, defaultValue: ["a"] }) -> z.array(z.string()).default(["a"])
 */
export function inferArgSchema(arg: ArgMetadata): InferredArgSchema {
  if (arg.schema) {
    return { schema: arg.schema, source: "explicit" };
  }

  if (arg.variadic) {
    if (arg.defaultValue !== undefined && Array.isArray(arg.defaultValue)) {
      return { schema: z.array(z.string()).default(arg.defaultValue.map(String)), source: "inferred" };
    }
    return { schema: z.array(z.string()), source: "inferred" };
  }

  if (arg.defaultValue !== undefined) {
    return { schema: z.string().default(String(arg.defaultValue)), source: "inferred" };
  }

  if (arg.required === false) {
    return { schema: z.string().optional(), source: "inferred" };
  }

  return { schema: z.string(), source: "inferred" };
}
