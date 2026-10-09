// Local parsing of `ravi bases` flags. Structural checks only: property keys,
// operators, and types are validated by the Console against the base schema.

import { readFileSync } from "node:fs";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { resolveCallerPath } from "../cli/caller-cwd.js";

export const BASES_QUERY_LIMIT_MAX = 500;
export const BASES_SORT_KEYS_MAX = 3;
export const BASES_GROUP_BY_MAX = 2;
export const BASES_BATCH_ROWS_MAX = 500;
export const BASES_ROWS_PER_BASE_MAX = 100_000;

const TIME_UNITS = new Set(["day", "week", "month", "quarter", "year"]);
const AGGREGATE_OPS = new Set(["count", "count_values", "sum", "avg", "min", "max"]);
const AGGREGATE_ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const STATUS_GROUPS = new Set(["todo", "in_progress", "done"]);

export function invalidInput(message: string): CloudAuthError {
  return new CloudAuthError("PAYLOAD_INVALID", message);
}

/** Read inline text, or the file named after `@`. Paths resolve against the caller cwd. */
export function readTextOrFile(value: string, label: string): string {
  if (!value.startsWith("@")) return value;
  const path = value.slice(1).trim();
  if (!path) throw invalidInput(`${label} expects a file path after '@'.`);
  try {
    return readFileSync(resolveCallerPath(path), "utf8");
  } catch {
    throw invalidInput(`${label} file could not be read: ${path}`);
  }
}

export function readJsonInput(value: string, label: string): unknown {
  const source = readTextOrFile(value, label);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw invalidInput(`${label} must be valid JSON (inline or @file).`);
  }
}

export function readJsonObjectInput(value: string, label: string): Record<string, unknown> {
  const parsed = readJsonInput(value, label);
  if (!isPlainObject(parsed)) throw invalidInput(`${label} must be a JSON object.`);
  return parsed;
}

/**
 * `--set key=value` assigns a string; `--set key:=<json>` assigns parsed JSON
 * (numbers, booleans, null, arrays, objects).
 */
export function parseSetAssignments(values: readonly string[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const raw of values ?? []) {
    const jsonIndex = raw.indexOf(":=");
    const textIndex = raw.indexOf("=");
    if (jsonIndex > 0 && jsonIndex < textIndex) {
      const key = raw.slice(0, jsonIndex).trim();
      const source = raw.slice(jsonIndex + 2);
      try {
        result[requireKey(key, raw)] = JSON.parse(source) as unknown;
      } catch {
        throw invalidInput(`--set ${key}:= expects JSON after ':='.`);
      }
      continue;
    }
    if (textIndex <= 0) throw invalidInput(`--set expects key=value or key:=<json>, got "${raw}".`);
    result[requireKey(raw.slice(0, textIndex).trim(), raw)] = raw.slice(textIndex + 1);
  }
  return result;
}

/** Merge `--values` (JSON object) with `--set` overrides. */
export function buildRowValues(valuesInput: string | undefined, setInput: readonly string[] | undefined) {
  const base = valuesInput ? readJsonObjectInput(valuesInput, "--values") : {};
  return { ...base, ...parseSetAssignments(setInput) };
}

export function readBodyInput(body: string | undefined, bodyFile: string | undefined): string | undefined {
  if (body !== undefined && bodyFile !== undefined) throw invalidInput("Use either --body or --body-file, not both.");
  if (bodyFile !== undefined) return readTextOrFile(`@${bodyFile}`, "--body-file");
  return body;
}

/**
 * `--sort amount:desc,created_time` → `[{prop, dir}]`. The CLI passes one string;
 * an array (from in-process callers) is joined the same way.
 */
export function parseSortOption(
  value: string | readonly string[] | undefined,
): Array<{ prop: string; dir: "asc" | "desc" }> | undefined {
  const parts = splitList(value);
  if (parts.length === 0) return undefined;
  if (parts.length > BASES_SORT_KEYS_MAX) throw invalidInput(`--sort accepts at most ${BASES_SORT_KEYS_MAX} keys.`);
  return parts.map((part) => {
    const [prop, dirRaw, extra] = part.split(":").map((piece) => piece.trim());
    const dir = (dirRaw || "asc").toLowerCase();
    if (!prop || extra !== undefined || (dir !== "asc" && dir !== "desc")) {
      throw invalidInput(`--sort expects key[:asc|desc] items, got "${part}".`);
    }
    return { prop, dir: dir as "asc" | "desc" };
  });
}

/**
 * `--group-by created_time:month,status` → `[{prop, timeUnit?}]`. One comma-separated
 * string from the CLI; an array is joined the same way.
 */
export function parseGroupByOption(
  value: string | readonly string[] | undefined,
): Array<{ prop: string; timeUnit?: string }> | undefined {
  const parts = splitList(value);
  if (parts.length === 0) return undefined;
  if (parts.length > BASES_GROUP_BY_MAX) {
    throw invalidInput(`--group-by accepts at most ${BASES_GROUP_BY_MAX} dimensions.`);
  }
  return parts.map((part) => {
    const [prop, unit, extra] = part.split(":").map((piece) => piece.trim());
    if (!prop || extra !== undefined || (unit !== undefined && !TIME_UNITS.has(unit))) {
      throw invalidInput(`--group-by expects key[:day|week|month|quarter|year], got "${part}".`);
    }
    return unit ? { prop, timeUnit: unit } : { prop };
  });
}

/**
 * `--agg count`, `--agg count::rows`, `--agg sum:amount`, `--agg sum:amount:total`.
 * The alias defaults to `count` or `<op>_<key>`.
 */
export function parseAggregateOption(
  values: readonly string[] | undefined,
): Array<{ op: string; prop?: string; as: string }> {
  const parts = splitList(values);
  if (parts.length === 0) return [{ op: "count", as: "count" }];
  const seen = new Set<string>();
  return parts.map((part) => {
    const pieces = part.split(":").map((piece) => piece.trim());
    if (pieces.length > 3) throw invalidInput(`--agg expects op[:key[:as]], got "${part}".`);
    const [op = "", second, third] = pieces;
    if (!AGGREGATE_OPS.has(op)) {
      throw invalidInput(`--agg operator must be one of ${[...AGGREGATE_OPS].join(", ")}, got "${op}".`);
    }
    let prop: string | undefined;
    let as: string | undefined;
    if (op === "count") {
      if (pieces.length === 3 && second) throw invalidInput("--agg count takes no key; use count or count::alias.");
      as = (pieces.length === 3 ? third : second) || "count";
    } else {
      prop = second;
      if (!prop) throw invalidInput(`--agg ${op} needs a key, e.g. ${op}:amount.`);
      as = third || `${op}_${prop}`;
    }
    if (!AGGREGATE_ALIAS_PATTERN.test(as)) throw invalidInput(`--agg alias "${as}" must match [A-Za-z_][A-Za-z0-9_]*.`);
    if (seen.has(as)) throw invalidInput(`--agg alias "${as}" is used twice.`);
    seen.add(as);
    return prop ? { op, prop, as } : { op, as };
  });
}

/** `Todo:todo,Doing:in_progress,Done:done` → select/status options (names, optional status group). */
export function parseOptionsShorthand(value: string | undefined): Array<{ name: string; group?: string }> | undefined {
  if (value === undefined) return undefined;
  const options = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.lastIndexOf(":");
      const group = separator > 0 ? part.slice(separator + 1).trim() : "";
      if (group && STATUS_GROUPS.has(group)) return { name: part.slice(0, separator).trim(), group };
      return { name: part };
    });
  if (options.length === 0) throw invalidInput("--options needs at least one option name.");
  return options;
}

export function parseIntegerOption(
  value: string | number | undefined,
  label: string,
  bounds: { min: number; max?: number },
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed)) throw invalidInput(`${label} must be an integer.`);
  if (parsed < bounds.min) throw invalidInput(`${label} must be at least ${bounds.min}.`);
  if (bounds.max !== undefined && parsed > bounds.max) throw invalidInput(`${label} must be at most ${bounds.max}.`);
  return parsed;
}

export function parseBooleanOption(value: string | boolean | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  throw invalidInput(`${label} must be true or false.`);
}

/** Update and archive need an explicit concurrency choice. */
export function requireConcurrencyChoice(
  expectedVersion: string | undefined,
  lastWriteWins: boolean | undefined,
): { expectedVersion?: number; lastWriteWins?: true } {
  const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
  if (version !== undefined && lastWriteWins) {
    throw invalidInput("Use either --expected-version or --last-write-wins, not both.");
  }
  if (version !== undefined) return { expectedVersion: version };
  if (lastWriteWins) return { lastWriteWins: true };
  throw invalidInput(
    "Pass --expected-version <n> (the row version you read) or --last-write-wins to overwrite concurrent changes.",
  );
}

export function splitList(values: readonly string[] | string | undefined): string[] {
  const list = values === undefined ? [] : Array.isArray(values) ? values : [values];
  return list
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKey(key: string, raw: string): string {
  if (!key) throw invalidInput(`--set expects key=value or key:=<json>, got "${raw}".`);
  return key;
}
