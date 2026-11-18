import operations from "./operations.json" with { type: "json" };
import { AppError, revision } from "./domain.js";

export type Classification = "read" | "write" | "destructive" | "managed-auth";
export interface Operation {
  id: string;
  module: string;
  path: string;
  http: string;
  method: string;
  classification: Classification;
  permission: string;
  inputSchema: any;
  documentedExample?: any;
  description: string;
}
export const catalogue: Operation[] = operations as Operation[];
export const catalogueDigest = revision(
  catalogue.map(({ id, path, http, method, classification }) => ({ id, path, http, method, classification })),
);
export function findOperation(id: string): Operation {
  const found = catalogue.find((op) => op.id === id);
  if (!found)
    throw new AppError(
      "OMIE_OPERATION_NOT_FOUND",
      "Operação não encontrada. Use catalogue --search para descobrir o ID.",
      2,
    );
  return found;
}
export function listOperations(module?: string, search?: string, limit = 50, offset = 0) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
    throw new AppError("INVALID_INPUT", "limit: 1–100; offset: inteiro >=0.", 2);
  const selected = catalogue.filter(
    (op) =>
      (!module || op.module.toLowerCase() === module.toLowerCase()) &&
      (!search || `${op.id} ${op.module} ${op.description}`.toLowerCase().includes(search.toLowerCase())),
  );
  const items = selected
    .slice(offset, offset + limit)
    .map(({ inputSchema, documentedExample, description, ...op }) => op);
  return {
    success: true,
    total: selected.length,
    items,
    pagination: { limit, offset, nextOffset: offset + items.length < selected.length ? offset + items.length : null },
    catalogueDigest,
    productionReady: false,
  };
}

export function rejectCredentials(value: any, depth = 0): void {
  if (depth > 32) throw new AppError("INVALID_INPUT", "JSON excede profundidade permitida.", 2);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(app_?key|app_?secret|access_?token|refresh_?token|token|authorization|password|senha|__proto__|constructor|prototype)$/i.test(
        key,
      )
    )
      throw new AppError(
        "OMIE_CREDENTIAL_INPUT_REJECTED",
        "Credenciais são resolvidas pelo host; não são aceitas no input.",
        2,
      );
    rejectCredentials(child, depth + 1);
  }
}

/** The generated Omie schema has contradictory required-fields vs examples.
 * Enforce supplied-field types and bounds; report missing required as warnings,
 * not invented business rules. The provider remains authoritative for business validation.
 */
export function validateInput(value: any, schema: any, path = "$", warnings: string[] = [], depth = 0): string[] {
  if (depth > 32) throw new AppError("INVALID_INPUT", "JSON excede profundidade permitida.", 2);
  if (!schema || typeof schema !== "object") return warnings;
  const type = schema.type;
  const valid =
    type === "object"
      ? value && typeof value === "object" && !Array.isArray(value)
      : type === "array"
        ? Array.isArray(value)
        : type === "integer"
          ? Number.isSafeInteger(value)
          : type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : type
              ? typeof value === type
              : true;
  if (!valid) throw new AppError("OMIE_SCHEMA_TYPE_ERROR", `Tipo inválido em ${path}.`, 2);
  if (schema.enum && !schema.enum.includes(value))
    throw new AppError("OMIE_SCHEMA_ENUM_ERROR", `Valor fora das opções documentadas em ${path}.`, 2);
  if (typeof value === "string" && schema.maxLength && value.length > schema.maxLength)
    throw new AppError("OMIE_SCHEMA_LENGTH_ERROR", `Texto excede limite em ${path}.`, 2);
  if (Array.isArray(value)) {
    if (
      value.length > 1000 ||
      (schema.maxItems && value.length > schema.maxItems) ||
      (schema.minItems && value.length < schema.minItems)
    )
      throw new AppError("OMIE_SCHEMA_ARRAY_ERROR", `Quantidade inválida em ${path}.`, 2);
    value.forEach((v, i) => {
      validateInput(v, schema.items, `${path}[${i}]`, warnings, depth + 1);
    });
  } else if (value && typeof value === "object") {
    for (const name of schema.required ?? []) if (!(name in value)) warnings.push(`${path}.${name}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validateInput(child, schema.properties[key], `${path}.${key}`, warnings, depth + 1);
      else if (schema.additionalProperties === false)
        throw new AppError("OMIE_SCHEMA_UNKNOWN_FIELD", `Campo não documentado em ${path}.`, 2);
    }
  }
  return warnings;
}
export function publicResult(value: any, depth = 0): any {
  if (depth > 40) throw new AppError("OMIE_RESPONSE_INVALID", "Resposta excede limite de profundidade.");
  if (Array.isArray(value)) return value.map((x) => publicResult(x, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !/token|secret|password|senha|app_?key|authorization/i.test(k))
        .map(([k, v]) => [k, publicResult(v, depth + 1)]),
    );
  return value;
}
