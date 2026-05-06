/**
 * Conservative JSON Schema -> Swift type renderer.
 *
 * Scope intentionally matches the MVP spec: generate useful primitive/object
 * shapes when safe; fall back to RaviJSON for complex unions.
 */

export type JsonSchema = Record<string, unknown>;

export function jsonSchemaToSwift(schema: JsonSchema | undefined | null): string {
  if (!schema || typeof schema !== "object") return "RaviJSON";

  const constValue = (schema as { const?: unknown }).const;
  if (constValue !== undefined) return literalType(constValue);

  const enumValues = (schema as { enum?: unknown[] }).enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    if (enumValues.every((value) => typeof value === "string")) return "String";
    if (enumValues.every((value) => typeof value === "boolean")) return "Bool";
    if (enumValues.every((value) => typeof value === "number")) {
      return enumValues.every((value) => Number.isInteger(value)) ? "Int" : "Double";
    }
    return "RaviJSON";
  }

  if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) return "RaviJSON";
  if (Array.isArray((schema as { oneOf?: unknown[] }).oneOf)) return "RaviJSON";
  if (Array.isArray((schema as { allOf?: unknown[] }).allOf)) return "RaviJSON";

  const type = (schema as { type?: unknown }).type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((value) => value !== "null");
    if (nonNull.length === 1) {
      return jsonSchemaToSwift({ ...schema, type: nonNull[0] });
    }
    return "RaviJSON";
  }
  if (typeof type !== "string") return "RaviJSON";

  switch (type) {
    case "string":
      return "String";
    case "boolean":
      return "Bool";
    case "integer":
      return "Int";
    case "number":
      return "Double";
    case "array": {
      const items = (schema as { items?: JsonSchema | JsonSchema[] }).items;
      if (Array.isArray(items)) return "[RaviJSON]";
      return `[${jsonSchemaToSwift(items ?? { type: "string" })}]`;
    }
    case "object": {
      const properties = (schema as { properties?: Record<string, JsonSchema> }).properties ?? {};
      if (Object.keys(properties).length > 0) return "RaviJSON";
      const additional = (schema as { additionalProperties?: boolean | JsonSchema }).additionalProperties;
      if (additional && typeof additional === "object") {
        return `[String: ${jsonSchemaToSwift(additional as JsonSchema)}]`;
      }
      return "[String: RaviJSON]";
    }
    default:
      return "RaviJSON";
  }
}

function literalType(value: unknown): string {
  switch (typeof value) {
    case "string":
      return "String";
    case "boolean":
      return "Bool";
    case "number":
      return Number.isInteger(value) ? "Int" : "Double";
    default:
      return "RaviJSON";
  }
}
