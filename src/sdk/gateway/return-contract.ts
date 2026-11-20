import { createHash } from "node:crypto";
import type { ZodError, ZodTypeAny } from "zod";
import { logger } from "../../utils/logger.js";
import type { JsonIssue } from "./errors.js";

const log = logger.child("gateway:return-contract");
/** Each pass applies every safe edit at once, so a handful of passes settles any realistic result. */
const MAX_PASSES = 8;
/** Most paths and field names carried in a violation or a log line; the rest is only counted. */
const MAX_LISTED = 50;
const WINDOW_MS = 60_000;
const MAX_KEYS = 256;
const occurrences = new Map<string, { at: number; suppressed: number }>();
let totalViolations = 0;

type Path = Array<string | number>;

export interface ReturnContractViolation {
  /** Schema paths that failed in the first validation, capped at 50. */
  paths: Path[];
  /** Undeclared fields the gateway removed, as dotted paths with array indexes folded to `*`. */
  removedFields: string[];
  /** Declared fields that were missing, mistyped or could not be repaired, same notation. */
  invalidFields: string[];
  /** Entries dropped from the three lists above to keep them bounded. */
  truncated: number;
  /** The pass limit ran out before the value matched its schema; the value is best effort. */
  exhausted: boolean;
  issues: JsonIssue[];
}

export interface ReturnContractResult {
  /** The value to send: the declared shape, minus whatever could not be made valid. */
  value: unknown;
  violation: ReturnContractViolation | null;
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
  path: Path;
  keys?: string[];
}

interface Edit {
  path: Path;
  key: string | number;
  undeclared: boolean;
}

/**
 * Shape a mutation's result into its declared return schema after the effect is applied.
 *
 * A handler that returns an undeclared field, or a declared field that is missing or of the
 * wrong type, is a contract bug. It is a signal for the command owner, never a failure for
 * a caller whose mutation already happened: retrying it would repeat the side effect.
 *
 * A value that already satisfies the schema is returned untouched (same reference). Repairs
 * copy only the containers they change, so values JSON cannot carry are never rewritten.
 */
export function enforceReturnContract(schema: ZodTypeAny, value: unknown): ReturnContractResult {
  const first = schema.safeParse(value);
  if (first.success) {
    const extras = collectStripped(value, first.data, []);
    if (extras.length === 0) return { value, violation: null };
    const stripped = applyEdits(
      value,
      extras.map((path) => ({ path: path.slice(0, -1), key: path[path.length - 1]!, undeclared: true })),
    );
    return {
      value: stripped.value,
      violation: buildViolation({
        paths: extras,
        removed: extras.map((p) => p.join(".")),
        invalid: [],
        exhausted: false,
        issues: extras.map((path) => ({
          path,
          code: "unrecognized_keys",
          message: "Undeclared field removed (strip mode).",
        })),
      }),
    };
  }

  const firstIssues = flattenIssues((first.error as ZodError).issues as ZodIssueLike[], []);
  const removed: string[] = [];
  const invalid: string[] = [];
  let current = value;
  let pending: FlatIssue[] = firstIssues;
  let exhausted = true;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const edits = editsFor(pending, current);
    if (edits.length === 0) {
      exhausted = false;
      break;
    }
    const applied = applyEdits(current, edits);
    current = applied.value;
    for (const edit of applied.done) (edit.undeclared ? removed : invalid).push([...edit.path, edit.key].join("."));
    const next = schema.safeParse(current);
    if (next.success) {
      // Strip-mode objects accept undeclared keys and drop them from the parsed copy only.
      const extras = collectStripped(current, next.data, []);
      if (extras.length > 0) {
        current = applyEdits(
          current,
          extras.map((path) => ({ path: path.slice(0, -1), key: path[path.length - 1]!, undeclared: true })),
        ).value;
        for (const path of extras) removed.push(path.join("."));
      }
      exhausted = false;
      pending = [];
      break;
    }
    pending = flattenIssues((next.error as ZodError).issues as ZodIssueLike[], []);
  }

  // Whatever is still failing could not be omitted (a required field the handler never set,
  // or a pass limit that ran out): it stays a violation instead of looking repaired.
  for (const issue of pending) invalid.push(issue.path.join(".") || "<root>");

  return {
    value: current,
    violation: buildViolation({
      paths: firstIssues.map((i) => i.path),
      removed,
      invalid,
      exhausted,
      issues: firstIssues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
    }),
  };
}

function buildViolation(input: {
  paths: Path[];
  removed: string[];
  invalid: string[];
  exhausted: boolean;
  issues: JsonIssue[];
}): ReturnContractViolation {
  const removedFields = unique(input.removed.map(foldIndexes));
  const invalidFields = unique(input.invalid.map(foldIndexes));
  const listed = (list: string[]) => list.slice(0, MAX_LISTED);
  const truncated =
    Math.max(0, input.paths.length - MAX_LISTED) +
    Math.max(0, removedFields.length - MAX_LISTED) +
    Math.max(0, invalidFields.length - MAX_LISTED);
  return {
    paths: input.paths.slice(0, MAX_LISTED),
    removedFields: listed(removedFields),
    invalidFields: listed(invalidFields),
    truncated,
    exhausted: input.exhausted,
    issues: input.issues.slice(0, MAX_LISTED),
  };
}

/** Union failures carry their branch issues, with paths relative to the union: keep the closest branch. */
function flattenIssues(list: ZodIssueLike[], prefix: Path): FlatIssue[] {
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

/** Every edit that removes one offending piece. Required fields the handler never set have nothing to omit. */
function editsFor(issues: FlatIssue[], root: unknown): Edit[] {
  const edits: Edit[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && issue.keys) {
      for (const key of issue.keys) edits.push({ path: issue.path, key, undeclared: true });
    } else if (issue.path.length > 0) {
      const path = issue.path.slice(0, -1);
      const key = issue.path[issue.path.length - 1]!;
      const parent = walk(root, path);
      if (parent === null || typeof parent !== "object") continue;
      if (Array.isArray(parent) ? typeof key === "number" && key < parent.length : String(key) in parent) {
        edits.push({ path, key, undeclared: false });
      }
    }
  }
  return edits;
}

/**
 * Apply edits without mutating the input: only containers on an edited path are copied.
 * Object keys go first; array elements are then removed from the highest index down, so no
 * edit sees a path shifted by another.
 */
function applyEdits(root: unknown, edits: Edit[]): { value: unknown; done: Edit[] } {
  const copied = new Set<object>();
  let top = root;
  const own = (path: Path): unknown => {
    if (top === null || typeof top !== "object") return undefined;
    if (!copied.has(top as object)) {
      top = shallowCopy(top as object);
      copied.add(top as object);
    }
    let node = top as Record<string | number, unknown>;
    for (const key of path) {
      const child = node[key];
      if (child === null || typeof child !== "object") return undefined;
      if (!copied.has(child as object)) {
        const clone = shallowCopy(child as object);
        copied.add(clone);
        node[key] = clone;
      }
      node = node[key] as Record<string | number, unknown>;
    }
    return node;
  };

  const done: Edit[] = [];
  const objectEdits = edits.filter((e) => typeof e.key === "string");
  const arrayEdits = edits
    .filter((e) => typeof e.key === "number")
    .sort((a, b) => comparePaths(b.path, a.path) || (b.key as number) - (a.key as number));
  for (const edit of [...objectEdits, ...arrayEdits]) {
    const container = own(edit.path) as Record<string | number, unknown> | unknown[] | undefined;
    if (!container) continue;
    if (Array.isArray(container)) {
      if (typeof edit.key !== "number" || edit.key >= container.length) continue;
      container.splice(edit.key, 1);
    } else {
      if (!(String(edit.key) in container)) continue;
      delete container[String(edit.key)];
    }
    done.push(edit);
  }
  return { value: top, done };
}

/**
 * Keys present in the original that the parsed copy dropped (strip-mode objects). A subtree whose
 * parsed form gained keys or changed type (transform, default) is left alone: it is not a strip.
 */
function collectStripped(original: unknown, parsed: unknown, path: Path): Path[] {
  const out: Path[] = [];
  if (original === null || typeof original !== "object" || parsed === null || typeof parsed !== "object") return out;
  if (Array.isArray(original)) {
    if (!Array.isArray(parsed) || parsed.length !== original.length) return out;
    for (let i = 0; i < original.length; i++) out.push(...collectStripped(original[i], parsed[i], [...path, i]));
    return out;
  }
  if (Array.isArray(parsed) || !isPlainObject(original) || !isPlainObject(parsed)) return out;
  const o = original as Record<string, unknown>;
  const p = parsed as Record<string, unknown>;
  if (Object.keys(p).some((key) => !(key in o))) return out;
  for (const key of Object.keys(o)) {
    if (!(key in p)) out.push([...path, key]);
    else out.push(...collectStripped(o[key], p[key], [...path, key]));
  }
  return out;
}

/** Every violation is counted; log lines follow the gateway diagnostics: first one now, repeats counted. */
export function reportReturnContractViolation(
  op: string,
  requestId: string,
  violation: ReturnContractViolation,
  now = Date.now(),
): void {
  totalViolations++;
  const key = createHash("sha256")
    .update(JSON.stringify([op, violation.removedFields, violation.invalidFields, violation.exhausted]))
    .digest("hex")
    .slice(0, 16);
  const previous = occurrences.get(key);
  if (previous && now - previous.at < WINDOW_MS) {
    previous.suppressed++;
    return;
  }
  if (!previous && occurrences.size >= MAX_KEYS) occurrences.delete(occurrences.keys().next().value!);
  occurrences.set(key, { at: now, suppressed: 0 });
  log.warn("Gateway return contract violation", {
    event: "return_contract_violation",
    command: op,
    requestId,
    schemaPaths: violation.paths,
    removedFields: violation.removedFields,
    invalidFields: violation.invalidFields,
    truncated: violation.truncated,
    exhausted: violation.exhausted,
    suppressed: previous?.suppressed ?? 0,
  });
}

/** Total violations counted since boot, including the ones whose log line was suppressed. */
export function returnContractViolationCount(): number {
  return totalViolations;
}

export function resetReturnContractViolationsForTest(): void {
  occurrences.clear();
  totalViolations = 0;
}

function foldIndexes(dotted: string): string {
  return dotted.replace(/(^|\.)\d+(?=\.|$)/g, "$1*");
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

function comparePaths(a: Path, b: Path): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] === b[i]) continue;
    return String(a[i]) < String(b[i]) ? -1 : 1;
  }
  return a.length - b.length;
}

function walk(root: unknown, path: Path): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

function shallowCopy(value: object): object {
  return Array.isArray(value) ? [...value] : { ...value };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function coerce(value: PropertyKey): string | number {
  return typeof value === "number" ? value : String(value);
}
