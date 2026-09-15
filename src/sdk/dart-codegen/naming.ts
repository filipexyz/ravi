/**
 * Dart naming helpers for registry-driven SDK codegen.
 *
 * Keeps language-specific identifier escaping out of the emitters.
 */

const DART_RESERVED = new Set([
  "assert",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extends",
  "false",
  "final",
  "finally",
  "for",
  "if",
  "in",
  "is",
  "new",
  "null",
  "rethrow",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "var",
  "void",
  "while",
  "with",
]);

const DART_BUILT_IN = new Set([
  "abstract",
  "as",
  "covariant",
  "deferred",
  "dynamic",
  "export",
  "extension",
  "external",
  "factory",
  "Function",
  "get",
  "implements",
  "import",
  "interface",
  "late",
  "library",
  "mixin",
  "operator",
  "part",
  "required",
  "set",
  "static",
  "typedef",
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

export function decodeFunctionName(groupSegments: readonly string[], command: string): string {
  return `${camelCase(returnTypeName(groupSegments, command))}FromJson`;
}

export function inputSchemaName(groupSegments: readonly string[], command: string): string {
  return `${camelCase(commandBaseName(groupSegments, command))}InputSchema`;
}

export function returnSchemaName(groupSegments: readonly string[], command: string): string {
  return `${camelCase(commandBaseName(groupSegments, command))}ReturnSchema`;
}

export function methodName(command: string): string {
  return dartIdentifier(camelCase(command));
}

export function propertyName(name: string): string {
  return dartIdentifier(camelCase(name));
}

/**
 * Resolve wire-property names to unique Dart identifiers.
 *
 * Different JSON keys can collapse to the same lower-camel Dart spelling
 * (`artifactId` and `artifact_id`, for example). Keep the canonical
 * lower-camel wire key on the preferred spelling, then fall back to the raw
 * key's Dart-safe spelling and, only when necessary, a stable numeric suffix.
 */
export function uniquePropertyNames(
  rawNames: readonly string[],
  reservedDartNames: readonly string[] = [],
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
  const used = new Set(reservedDartNames);
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => compareStrings(a, b));

  for (const [baseName, group] of orderedGroups) {
    const canonical = [...group].sort(compareCanonicalWireNames)[0];
    const dartName = nextAvailableIdentifier(baseName, used);
    resolved.set(canonical, dartName);
    used.add(dartName);
  }

  for (const [, group] of orderedGroups) {
    const remaining = group.filter((rawName) => !resolved.has(rawName)).sort(compareFallbackWireNames);
    for (const rawName of remaining) {
      const dartName = nextAvailableIdentifier(dartIdentifier(rawName), used);
      resolved.set(rawName, dartName);
      used.add(dartName);
    }
  }

  return resolved;
}

export function dartIdentifier(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_$&");
  const normalized = safe || "value";
  if (DART_RESERVED.has(normalized) || DART_BUILT_IN.has(normalized)) {
    return `${normalized}_`;
  }
  return normalized;
}

export function dartTypeName(raw: string): string {
  const safe = pascalCase(raw).replace(/[^A-Za-z0-9_]/g, "");
  const normalized = /^[0-9]/.test(safe) ? `_${safe}` : safe || "Value";
  if (DART_RESERVED.has(normalized) || DART_BUILT_IN.has(normalized)) {
    return `${normalized}Value`;
  }
  return normalized;
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
  const aIsAlreadySafe = a === dartIdentifier(a);
  const bIsAlreadySafe = b === dartIdentifier(b);
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
