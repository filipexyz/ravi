/**
 * Conservative JSON Schema -> Dart type renderer.
 *
 * Scope intentionally matches the MVP spec: generate useful primitive/object
 * shapes when safe; fall back to RaviJson for complex unions.
 */

export type JsonSchema = Record<string, unknown>;

export function jsonSchemaToDart(schema: JsonSchema | undefined | null): string {
  if (!schema || typeof schema !== "object") return "RaviJson";

  const constValue = (schema as { const?: unknown }).const;
  if (constValue !== undefined) return literalType(constValue);

  const enumValues = (schema as { enum?: unknown[] }).enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    if (enumValues.every((value) => typeof value === "string")) return "String";
    if (enumValues.every((value) => typeof value === "boolean")) return "bool";
    if (enumValues.every((value) => typeof value === "number")) {
      return enumValues.every((value) => Number.isInteger(value)) ? "int" : "double";
    }
    return "RaviJson";
  }

  if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) return "RaviJson";
  if (Array.isArray((schema as { oneOf?: unknown[] }).oneOf)) return "RaviJson";
  if (Array.isArray((schema as { allOf?: unknown[] }).allOf)) return "RaviJson";

  const type = (schema as { type?: unknown }).type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((value) => value !== "null");
    if (nonNull.length === 1) {
      return jsonSchemaToDart({ ...schema, type: nonNull[0] });
    }
    return "RaviJson";
  }
  if (typeof type !== "string") return "RaviJson";

  switch (type) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "integer":
      return "int";
    case "number":
      return "double";
    case "array": {
      const items = (schema as { items?: JsonSchema | JsonSchema[] }).items;
      if (Array.isArray(items)) return "List<RaviJson>";
      return `List<${jsonSchemaToDart(items ?? { type: "string" })}>`;
    }
    case "object": {
      const properties = (schema as { properties?: Record<string, JsonSchema> }).properties ?? {};
      if (Object.keys(properties).length > 0) return "RaviJson";
      const additional = (schema as { additionalProperties?: boolean | JsonSchema }).additionalProperties;
      if (additional && typeof additional === "object") {
        return `Map<String, ${jsonSchemaToDart(additional as JsonSchema)}>`;
      }
      return "Map<String, RaviJson>";
    }
    default:
      return "RaviJson";
  }
}

function literalType(value: unknown): string {
  switch (typeof value) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "double";
    default:
      return "RaviJson";
  }
}
