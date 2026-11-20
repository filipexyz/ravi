import { createHash } from "node:crypto";
import type { ZodError, ZodTypeAny } from "zod";
import { logger } from "../../utils/logger.js";
import type { JsonIssue } from "./errors.js";

const log = logger.child("gateway:return-contract");
const MAX_PASSES = 8;
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
  const first = schema.safeParse(value);
  if (first.success) return { value, violation: null };

  const working = structuredCloneJson(value);
  const allPaths: Array<Array<string | number>> = [];
  const removed = new Set<string>();
  const invalid = new Set<string>();
  const issues: JsonIssue[] = [];
  let pending: ZodError = first.error;
  const current: unknown = working;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const edits: Array<{ path: Array<string | number>; key: string | number; undeclared: boolean }> = [];
    for (const issue of pending.issues) {
      const base = issue.path.map(coerce);
      issues.push({ path: base, code: issue.code, message: issue.message });
      allPaths.push(base);
      if (issue.code === "unrecognized_keys") {
        for (const key of (issue as { keys: string[] }).keys) edits.push({ path: base, key, undeclared: true });
      } else if (base.length > 0) {
        edits.push({ path: base.slice(0, -1), key: base[base.length - 1]!, undeclared: false });
      } else {
        invalid.add("<root>");
      }
    }
    // Higher array indexes first, so removing one element does not shift the next edit.
    edits.sort((a, b) => (typeof b.key === "number" && typeof a.key === "number" ? b.key - a.key : 0));
    let changed = false;
    for (const edit of edits) {
      const parent = walk(current, edit.path);
      if (parent === undefined || parent === null || typeof parent !== "object") continue;
      const dotted = [...edit.path, edit.key].join(".");
      if (Array.isArray(parent)) {
        if (typeof edit.key !== "number" || edit.key >= parent.length) continue;
        parent.splice(edit.key, 1);
      } else {
        const record = parent as Record<string, unknown>;
        if (!(String(edit.key) in record)) {
          // Required field the handler never set: nothing to omit, still a violation.
          if (!edit.undeclared) invalid.add(dotted);
          continue;
        }
        delete record[String(edit.key)];
      }
      (edit.undeclared ? removed : invalid).add(dotted);
      changed = true;
    }
    const next = schema.safeParse(current);
    if (next.success || !changed) break;
    pending = next.error;
  }

  return {
    value: current,
    violation: {
      paths: allPaths,
      removedFields: [...removed],
      invalidFields: [...invalid],
      issues,
    },
  };
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
