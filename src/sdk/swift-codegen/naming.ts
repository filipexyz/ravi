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

/**
 * Resolve wire-property names to unique Swift identifiers.
 *
 * Different JSON keys can collapse to the same lower-camel Swift spelling
 * (`artifactId` and `artifact_id`, for example). Keep the canonical
 * lower-camel wire key on the preferred spelling, then fall back to the raw
 * key's Swift-safe spelling and, only when necessary, a stable numeric suffix.
 */
export function uniquePropertyNames(
  rawNames: readonly string[],
  reservedSwiftNames: readonly string[] = [],
): ReadonlyMap<string, string> {
  const uniqueRawNames = [...new Set(rawNames)].sort(compareStrings);
  const groups = new Map<string, string[]>();

  for (const rawName of uniqueRawNames) {
    const baseName = propertyName(rawName);
    const group = groups.get(baseName) ?? [];
    group.push(rawName);
    groups.set(baseName, group);
  }

  const resolved = new Map<string, string>();
  const used = new Set(reservedSwiftNames);
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => compareStrings(a, b));

  // Claim every canonical lower-camel spelling first. This prevents a
  // fallback from taking the preferred name of another property group.
  for (const [baseName, group] of orderedGroups) {
    const canonical = [...group].sort(compareCanonicalWireNames)[0];
    const swiftName = nextAvailableIdentifier(baseName, used);
    resolved.set(canonical, swiftName);
    used.add(swiftName);
  }

  for (const [, group] of orderedGroups) {
    const remaining = group.filter((rawName) => !resolved.has(rawName)).sort(compareFallbackWireNames);
    for (const rawName of remaining) {
      const swiftName = nextAvailableIdentifier(swiftIdentifier(rawName), used);
      resolved.set(rawName, swiftName);
      used.add(swiftName);
    }
  }

  return resolved;
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

function compareCanonicalWireNames(a: string, b: string): number {
  const aIsCanonical = a === camelCase(a);
  const bIsCanonical = b === camelCase(b);
  if (aIsCanonical !== bIsCanonical) return aIsCanonical ? -1 : 1;
  return compareStrings(a, b);
}

function compareFallbackWireNames(a: string, b: string): number {
  const aIsAlreadySafe = a === swiftIdentifier(a);
  const bIsAlreadySafe = b === swiftIdentifier(b);
  if (aIsAlreadySafe !== bIsAlreadySafe) return aIsAlreadySafe ? -1 : 1;
  return compareStrings(a, b);
}

function nextAvailableIdentifier(baseName: string, used: ReadonlySet<string>): string {
  if (!used.has(baseName)) return baseName;
  const separator = baseName.endsWith("_") ? "" : "_";
  let suffix = 2;
  while (used.has(`${baseName}${separator}${suffix}`)) suffix += 1;
  return `${baseName}${separator}${suffix}`;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
