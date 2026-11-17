/**
 * Add an inclusive option-presence constraint to a flat command input schema.
 * Each branch keeps the entire object shape so type renderers cannot lose the
 * common fields when projecting the union. Multiple supplied options are valid.
 */
export function withRequiredAnyOfOptions(
  schema: Record<string, unknown>,
  optionNames: readonly string[] | undefined,
): Record<string, unknown> {
  if (!optionNames?.length) return schema;
  const required = (schema.required as string[] | undefined) ?? [];
  return {
    ...schema,
    anyOf: optionNames.map((name) => ({
      ...schema,
      required: [...new Set([...required, name])].sort(),
    })),
  };
}
