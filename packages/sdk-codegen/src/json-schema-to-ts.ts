/**
 * Translate a JSON Schema (Draft 2020-12 subset emitted by `z.toJSONSchema`)
 * into TypeScript source.
 *
 * Scope: handles every shape produced by the registry's inferred schemas plus
 * the common explicit zod patterns (object, array, string, number, boolean,
 * enum, union/intersection, literal, nullable). Anything outside that is
 * lowered to `unknown` rather than guessed — better to surface a missing case
 * during codegen tests than to emit a wrong type.
 *
 * The output is single-line by default. Object types fan out to multi-line
 * once they have at least one property so generated code stays readable in
 * `client.ts`.
 */

export type JsonSchema = Record<string, unknown>;

/**
 * Render a JSON Schema as a TypeScript type expression. Returns a string that
 * can appear anywhere a type position is valid (alias rhs, function return,
 * generic argument, etc).
 */
export function jsonSchemaToTs(schema: JsonSchema | undefined | null, indent = 0): string {
  if (!schema || typeof schema !== "object") return "unknown";
  return render(schema, indent);
}

function render(schema: JsonSchema, indent: number): string {
  if (Object.keys(schema).length === 0) return "unknown";

  const constValue = (schema as { const?: unknown }).const;
  if (constValue !== undefined) {
    return literal(constValue);
  }

  if (Array.isArray((schema as { enum?: unknown[] }).enum)) {
    const values = (schema as { enum: unknown[] }).enum;
    if (values.length === 0) return "never";
    return values.map(literal).join(" | ");
  }

  if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) {
    const branches = (schema as { anyOf: JsonSchema[] }).anyOf.map((s) => render(s, indent));
    return uniqueUnion(branches);
  }
  if (Array.isArray((schema as { oneOf?: unknown[] }).oneOf)) {
    const branches = (schema as { oneOf: JsonSchema[] }).oneOf.map((s) => render(s, indent));
    return uniqueUnion(branches);
  }
  if (Array.isArray((schema as { allOf?: unknown[] }).allOf)) {
    const parts = (schema as { allOf: JsonSchema[] }).allOf.map((s) => render(s, indent));
    if (parts.length === 0) return "unknown";
    if (parts.length === 1) return parts[0];
    return parts.map(parenthesize).join(" & ");
  }

  const type = (schema as { type?: unknown }).type;
  if (Array.isArray(type)) {
    const branches = type.map((t) => renderTyped({ ...schema, type: t as string }, indent));
    return uniqueUnion(branches);
  }
  if (typeof type === "string") {
    return renderTyped(schema as JsonSchema & { type: string }, indent);
  }

  return "unknown";
}

function renderTyped(schema: JsonSchema & { type: string }, indent: number): string {
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = (schema as { items?: JsonSchema | JsonSchema[] }).items;
      if (Array.isArray(items)) {
        const inner = items.map((s) => render(s, indent));
        return `[${inner.join(", ")}]`;
      }
      const inner = render(items ?? {}, indent);
      return needsArrayParens(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object":
      return renderObject(schema, indent);
    default:
      return "unknown";
  }
}

function renderObject(schema: JsonSchema, indent: number): string {
  const props = (schema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const required = new Set((schema as { required?: string[] }).required ?? []);
  const additional = (schema as { additionalProperties?: boolean | JsonSchema }).additionalProperties;
  const keys = Object.keys(props).sort();

  if (keys.length === 0) {
    if (additional === false) return "Record<string, never>";
    if (additional && typeof additional === "object") {
      return `Record<string, ${render(additional as JsonSchema, indent)}>`;
    }
    return "Record<string, unknown>";
  }

  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  const lines: string[] = ["{"];
  for (const key of keys) {
    const valueType = render(props[key], indent + 1);
    const optional = required.has(key) ? "" : "?";
    lines.push(`${pad}${formatKey(key)}${optional}: ${valueType};`);
  }
  if (additional && typeof additional === "object") {
    lines.push(`${pad}[k: string]: ${render(additional as JsonSchema, indent + 1)};`);
  }
  lines.push(`${close}}`);
  return lines.join("\n");
}

function needsArrayParens(inner: string): boolean {
  return /[ |&]/.test(inner) || inner.startsWith("{") || inner.endsWith("}");
}

function parenthesize(value: string): string {
  if (/[ |&]/.test(value)) return `(${value})`;
  return value;
}

function uniqueUnion(parts: string[]): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    ordered.push(p);
  }
  if (ordered.length === 0) return "never";
  if (ordered.length === 1) return ordered[0];
  return ordered.map(parenthesize).join(" | ");
}

function literal(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    default:
      return JSON.stringify(value);
  }
}

const VALID_PROP_NAME_RE = /^[A-Za-z_$][\w$]*$/;
function formatKey(name: string): string {
  if (VALID_PROP_NAME_RE.test(name)) return name;
  return JSON.stringify(name);
}
