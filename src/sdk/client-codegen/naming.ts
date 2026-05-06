/**
 * Naming helpers for SDK codegen.
 *
 * Pure, deterministic conversions: kebab-case → camelCase / PascalCase, plus
 * the conventions for type and schema constants emitted by the codegen. All
 * branches on `cmd.command`, `cmd.groupSegments`, and arg/option names go
 * through this module so the generated artifacts never drift on naming.
 */

/** Convert kebab-case (or snake_case) to camelCase. Idempotent on camelCase input. */
export function camelCase(input: string): string {
  if (input.length === 0) return input;
  return input.replace(/[_-](\w)/g, (_, c: string) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/** Convert kebab-case / snake_case / camelCase to PascalCase. */
export function pascalCase(input: string): string {
  const camel = camelCase(input);
  if (camel.length === 0) return camel;
  return camel[0].toUpperCase() + camel.slice(1);
}

/** Stable identifier for nested namespace property names (camelCased segment). */
export function namespaceProp(segment: string): string {
  return camelCase(segment);
}

/** Stable identifier for command method names (camelCased command). */
export function methodName(command: string): string {
  return camelCase(command);
}

/** PascalCase concat of group segments + command, used as the type/schema base name. */
export function commandBaseName(groupSegments: readonly string[], command: string): string {
  return [...groupSegments, command].map(pascalCase).join("");
}

/** TS type name for a command's input shape. */
export function inputTypeName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}Input`;
}

/** TS type name for a command's return shape. */
export function returnTypeName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}Return`;
}

/** Constant name for a command's input JSON Schema. */
export function inputSchemaName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}InputSchema`;
}

/** Constant name for a command's return JSON Schema (only when `@Returns` is declared). */
export function returnSchemaName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}ReturnSchema`;
}

/**
 * Validate that a string is a safe TypeScript identifier (begins with letter
 * or `_`/`$`, no spaces / punctuation). The codegen treats invalid identifiers
 * as a hard error so a misnamed command surfaces during generation, not at
 * compile time.
 */
export function assertIdentifier(value: string, location: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) {
    throw new Error(`Codegen: ${location} produced invalid TS identifier ${JSON.stringify(value)}`);
  }
}
