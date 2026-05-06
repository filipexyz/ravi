/**
 * Swift naming helpers for registry-driven SDK codegen.
 *
 * Keeps language-specific identifier escaping out of the emitters.
 */

const SWIFT_KEYWORDS = new Set([
  "Any",
  "Self",
  "Type",
  "actor",
  "as",
  "associatedtype",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "continue",
  "default",
  "defer",
  "deinit",
  "do",
  "else",
  "enum",
  "extension",
  "fallthrough",
  "false",
  "fileprivate",
  "for",
  "func",
  "guard",
  "if",
  "import",
  "in",
  "init",
  "inout",
  "internal",
  "is",
  "let",
  "nil",
  "open",
  "operator",
  "private",
  "protocol",
  "public",
  "repeat",
  "rethrows",
  "return",
  "self",
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throw",
  "throws",
  "true",
  "try",
  "typealias",
  "var",
  "where",
  "while",
]);

export function camelCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) return "value";
  const [head, ...tail] = words;
  return [head.toLowerCase(), ...tail.map(capitalize)].join("");
}

export function pascalCase(input: string): string {
  return splitWords(input).map(capitalize).join("") || "Value";
}

export function namespaceName(groupSegments: readonly string[]): string {
  return `${groupSegments.map(pascalCase).join("")}Namespace`;
}

export function commandBaseName(groupSegments: readonly string[], command: string): string {
  return [...groupSegments, command].map(pascalCase).join("");
}

export function optionsTypeName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}Options`;
}

export function returnTypeName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}Return`;
}

export function inputSchemaName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}InputSchema`;
}

export function returnSchemaName(groupSegments: readonly string[], command: string): string {
  return `${commandBaseName(groupSegments, command)}ReturnSchema`;
}

export function methodName(command: string): string {
  return swiftIdentifier(camelCase(command));
}

export function propertyName(name: string): string {
  return swiftIdentifier(camelCase(name));
}

export function swiftIdentifier(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
  const normalized = safe || "value";
  return SWIFT_KEYWORDS.has(normalized) ? `${normalized}_` : normalized;
}

export function swiftTypeName(raw: string): string {
  const safe = pascalCase(raw).replace(/[^A-Za-z0-9_]/g, "");
  const normalized = /^[0-9]/.test(safe) ? `_${safe}` : safe || "Value";
  return SWIFT_KEYWORDS.has(normalized) ? `${normalized}Value` : normalized;
}

function splitWords(input: string): string[] {
  return String(input || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function capitalize(input: string): string {
  if (!input) return input;
  return input[0].toUpperCase() + input.slice(1).toLowerCase();
}
