import { compilePredicate, type CompiledPredicate } from "../policy/predicate.js";
import { logger } from "../utils/logger.js";

const log = logger.child("triggers:filter");
const FILTER_CACHE_MAX = 500;
const filterCache = new Map<string, CompiledFilter>();

export interface CompiledFilter {
  expression?: string;
  valid: boolean;
  error?: string;
  evaluate(data: unknown): boolean;
}

function buildFilter(filter: string | undefined): CompiledFilter {
  const expression = filter?.trim();
  const compiled = compilePredicate(expression, {
    allowedRoots: ["data"],
    pathLabel: "data.<path>",
  });
  if (!compiled.ok) {
    return {
      expression,
      valid: false,
      error: compiled.error,
      // Historical trigger behavior is deliberately fail-open at runtime.
      evaluate: () => true,
    };
  }
  const predicate: CompiledPredicate = compiled.predicate;
  return {
    expression,
    valid: true,
    evaluate: (data) => predicate.evaluate({ data }),
  };
}

/** Compile once when loading trigger configuration. */
export function compileFilter(filter: string | undefined): CompiledFilter {
  const key = filter?.trim() ?? "";
  const cached = filterCache.get(key);
  if (cached) return cached;
  const compiled = buildFilter(filter);
  filterCache.set(key, compiled);
  if (filterCache.size > FILTER_CACHE_MAX) filterCache.delete(filterCache.keys().next().value ?? "");
  return compiled;
}

export type FilterValidationResult = { ok: true } | { ok: false; error: string };

export function validateFilter(filter: string | undefined): FilterValidationResult {
  const compiled = compileFilter(filter);
  return compiled.valid ? { ok: true } : { ok: false, error: compiled.error ?? "Invalid filter" };
}

export function evaluateFilter(filter: string | undefined, data: unknown): boolean {
  const compiled = compileFilter(filter);
  if (!compiled.valid) {
    log.warn("Trigger filter: invalid syntax, failing open", { filter, error: compiled.error });
  }
  return compiled.evaluate(data);
}
