import { createHash } from "node:crypto";
import type { ZodError, ZodTypeAny } from "zod";
import { logger } from "../../utils/logger.js";
import type { JsonIssue } from "./errors.js";

const log = logger.child("gateway:return-contract");
const MAX_PASSES = 200;
const violationCounts = new Map<string, number>();

export interface ReturnContractViolation {
  /** Schema paths that failed, one entry per issue. */
  paths: Array<Array<string | number>>;
  /** Undeclared fields the handler returned and the gateway removed, as dotted paths. */
  removedFields: string[];
  /** Declared fields that were missing or of the wrong type; omitted when possible. */
  invalidFields: string[];
  issues: JsonIssue[];
}

export interface ReturnContractResult {
  /** The value to send: exactly the declared shape, minus whatever could not be made valid. */
  value: unknown;
  violation: ReturnContractViolation | null;
}

/**
 * Shape a mutation's result into its declared return schema after the effect is applied.
 *
 * A handler that returns an undeclared field, or a declared field that is missing or of the
 * wrong type, is a contract bug. It is a signal for the command owner, never a failure for
 * a caller whose mutation already happened: retrying it would repeat the side effect.
 */
export function enforceReturnContract(schema: ZodTypeAny, value: unknown): ReturnContractResult {
  const working = structuredCloneJson(value);
  const allPaths: Array<Array<string | number>> = [];
  const removed = new Set<string>();
  const invalid = new Set<string>();
  const issues: JsonIssue[] = [];
  const current: unknown = working;
  let seen = false;

  // One edit per pass, validated again each time: removing an array element shifts every later
  // path, so edits computed from a single validation would hit the wrong sibling.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = schema.safeParse(current);
    if (result.success) {
      // Strip-mode objects accept undeclared keys and drop them from the parsed copy only.
      const extras = collectStripped(current, result.data, []);
      for (const path of extras) {
        const parent = walk(current, path.slice(0, -1));
        if (parent && typeof parent === "object" && !Array.isArray(parent)) {
          delete (parent as Record<string, unknown>)[String(path[path.length - 1])];
        }
        removed.add(path.join("."));
        allPaths.push(path);
        issues.push({ path, code: "unrecognized_keys", message: "Undeclared field removed (strip mode)." });
        seen = true;
      }
      break;
    }
    seen = true;
    const flat = flattenIssues((result.error as ZodError).issues as ZodIssueLike[], []);
    for (const issue of flat) {
      issues.push({ path: issue.path, code: issue.code, message: issue.message });
      allPaths.push(issue.path);
    }
    // Deepest issue first: it removes the smallest piece that makes the value invalid.
    const ranked = [...flat].sort((x, y) => y.path.length - x.path.length);
    let applied = false;
    for (const issue of ranked) {
      const edit = editFor(issue);
      if (!edit) continue;
      const dotted = [...edit.path, edit.key].join(".");
      const parent = walk(current, edit.path);
      if (parent === null || typeof parent !== "object") continue;
      if (Array.isArray(parent)) {
        if (typeof edit.key !== "number" || edit.key >= parent.length) continue;
        parent.splice(edit.key, 1);
      } else {
        const record = parent as Record<string, unknown>;
        // A required field the handler never set has nothing to omit: still a violation.
        if (!(String(edit.key) in record)) continue;
        delete record[String(edit.key)];
      }
      (edit.undeclared ? removed : invalid).add(dotted);
      applied = true;
      break;
    }
    if (!applied) {
      for (const issue of flat) invalid.add(issue.path.join(".") || "<root>");
      break;
    }
  }

  if (!seen) return { value, violation: null };
  return {
    value: current,
    violation: { paths: allPaths, removedFields: [...removed], invalidFields: [...invalid], issues },
  };
}

interface ZodIssueLike {
  code: string;
  message: string;
  path: PropertyKey[];
  keys?: string[];
  errors?: ZodIssueLike[][];
}

interface FlatIssue {
  code: string;
  message: string;
  path: Array<string | number>;
  keys?: string[];
}

/** Union failures carry their branch issues, with paths relative to the union: keep the closest branch. */
function flattenIssues(list: ZodIssueLike[], prefix: Array<string | number>): FlatIssue[] {
  const out: FlatIssue[] = [];
  for (const issue of list) {
    const path = [...prefix, ...issue.path.map(coerce)];
    if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length > 0) {
      const closest = issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best));
      out.push(...flattenIssues(closest, path));
    } else {
      out.push({ code: issue.code, message: issue.message, path, ...(issue.keys ? { keys: issue.keys } : {}) });
    }
  }
  return out;
}

function editFor(issue: FlatIssue): { path: Array<string | number>; key: string | number; undeclared: boolean } | null {
  if (issue.code === "unrecognized_keys" && issue.keys && issue.keys.length > 0) {
    return { path: issue.path, key: issue.keys[0]!, undeclared: true };
  }
  if (issue.path.length === 0) return null;
  return { path: issue.path.slice(0, -1), key: issue.path[issue.path.length - 1]!, undeclared: false };
}

/** Keys present in the original value that the parsed copy dropped (strip-mode objects). */
function collectStripped(
  original: unknown,
  parsed: unknown,
  path: Array<string | number>,
): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [];
  if (original === null || typeof original !== "object" || parsed === null || typeof parsed !== "object") return out;
  if (Array.isArray(original)) {
    if (!Array.isArray(parsed) || parsed.length !== original.length) return out;
    for (let i = 0; i < original.length; i++) out.push(...collectStripped(original[i], parsed[i], [...path, i]));
    return out;
  }
  if (Array.isArray(parsed)) return out;
  const o = original as Record<string, unknown>;
  const p = parsed as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(key in p)) out.push([...path, key]);
    else out.push(...collectStripped(o[key], p[key], [...path, key]));
  }
  return out;
}

/** First occurrence per command and field set is logged; every occurrence is counted. */
export function reportReturnContractViolation(op: string, requestId: string, violation: ReturnContractViolation): void {
  const key = createHash("sha256")
    .update(JSON.stringify([op, violation.removedFields, violation.invalidFields]))
    .digest("hex")
    .slice(0, 16);
  const count = (violationCounts.get(key) ?? 0) + 1;
  violationCounts.set(key, count);
  log.warn("Gateway return contract violation", {
    event: "return_contract_violation",
    command: op,
    requestId,
    schemaPaths: violation.paths,
    removedFields: violation.removedFields,
    invalidFields: violation.invalidFields,
    occurrences: count,
  });
}

/** Total violations counted since boot, for tests and diagnostics. */
export function returnContractViolationCount(): number {
  let total = 0;
  for (const n of violationCounts.values()) total += n;
  return total;
}

export function resetReturnContractViolationsForTest(): void {
  violationCounts.clear();
}

function walk(root: unknown, path: Array<string | number>): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

function coerce(value: PropertyKey): string | number {
  return typeof value === "number" ? value : String(value);
}

function structuredCloneJson(value: unknown): unknown {
  // The result is sent as JSON, so the JSON projection is what the caller would have seen.
  return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}
