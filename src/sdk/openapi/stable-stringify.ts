/**
 * Stable JSON stringify — sorts object keys recursively so the same input
 * structure always serializes byte-identical. Arrays preserve their order
 * (semantic), only object keys get canonicalized.
 *
 * Used to make the OpenAPI emit output deterministic regardless of Zod's
 * internal property emission order or future runtime changes that could
 * shift insertion order.
 */

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object" && (value as object).constructor === Object) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}
