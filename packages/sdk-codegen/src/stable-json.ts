/**
 * Deterministic JSON serializer for codegen artifacts.
 *
 * Same shape as `sdk/openapi/stable-stringify.ts` but kept local so the codegen
 * does not depend on the OpenAPI emitter (and vice versa). Sorts object keys
 * recursively. Pretty-printed with a configurable indent.
 */

export function stableStringify(value: unknown, indent: number): string {
  const space = indent > 0 ? " ".repeat(indent) : "";
  return stringify(value, space, "");
}

function stringify(value: unknown, space: string, currentIndent: string): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (space === "") {
      return `[${value.map((v) => stringify(v, space, "")).join(",")}]`;
    }
    const next = currentIndent + space;
    const items = value.map((v) => `${next}${stringify(v, space, next)}`);
    return `[\n${items.join(",\n")}\n${currentIndent}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) return "{}";
    if (space === "") {
      const inner = keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k], space, "")}`);
      return `{${inner.join(",")}}`;
    }
    const next = currentIndent + space;
    const inner = keys.map((k) => `${next}${JSON.stringify(k)}: ${stringify(obj[k], space, next)}`);
    return `{\n${inner.join(",\n")}\n${currentIndent}}`;
  }
  return "null";
}
