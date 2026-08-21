/**
 * Emit generated files for the Swift RaviSDK package.
 */

import type { CommandRegistryEntry, RegistrySnapshot } from "../../cli/registry-snapshot.js";
import {
  buildInputSchema,
  buildReturnSchema,
  buildSignature,
  type CommandSignature,
} from "../client-codegen/registry-shape.js";
import { stableStringify } from "../client-codegen/stable-json.js";
import {
  inputSchemaName,
  methodName,
  namespaceName,
  optionsTypeName,
  propertyName,
  returnSchemaName,
  returnTypeName,
  swiftTypeName,
  uniquePropertyNames,
} from "./naming.js";
import { jsonSchemaToSwift, type JsonSchema } from "./json-schema-to-swift.js";
import { defaultStreamChannels } from "../gateway/streaming/channels.js";
import { emitStreamingSwift } from "./streaming-codegen.js";

const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Run `ravi sdk swift generate` to regenerate.",
  "// Drift is detected by `ravi sdk swift check`.",
].join("\n");

export interface EmitSwiftVersionInput {
  sdkVersion: string;
  registryHash: string;
  gitSha: string;
}

export interface EmitSwiftOptions {
  version: EmitSwiftVersionInput;
}

export interface EmittedSwiftSdk {
  client: string;
  types: string;
  schemas: string;
  version: string;
  streaming: string;
}

export function emitAllSwift(registry: RegistrySnapshot, options: EmitSwiftOptions): EmittedSwiftSdk {
  const sortedCommands = [...registry.commands]
    .filter((cmd) => !cmd.cliOnly)
    .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
  return {
    client: emitSwiftClient(sortedCommands),
    types: emitSwiftTypes(sortedCommands),
    schemas: emitSwiftSchemas(sortedCommands),
    version: emitSwiftVersion(options.version),
    streaming: emitStreamingSwift(defaultStreamChannels),
  };
}

/* -------------------------------------------------------------------------- */
/*  RaviTypes.generated.swift                                                 */
/* -------------------------------------------------------------------------- */

export function emitSwiftTypes(commands: CommandRegistryEntry[]): string {
  const lines: string[] = [HEADER, "", "import Foundation", ""];
  const namedReturnSchemas = collectNamedReturnSchemas(commands);
  if (namedReturnSchemas.size > 0) {
    lines.push(renderGeneratedCodingKey(), "");
    for (const [title, schema] of [...namedReturnSchemas.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(renderNamedReturnStruct(swiftTypeName(title), schema), "");
    }
  }
  for (const cmd of commands) {
    const optionsDecl = renderOptionsStruct(cmd);
    if (optionsDecl) {
      lines.push(optionsDecl, "");
    }
    lines.push(renderReturnDeclaration(cmd), "");
  }
  return ensureTrailingNewline(lines.join("\n"));
}

function collectNamedReturnSchemas(commands: CommandRegistryEntry[]): Map<string, JsonSchema> {
  const schemas = new Map<string, JsonSchema>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      if (Array.isArray(value)) value.forEach(visit);
      return;
    }
    const schema = value as JsonSchema;
    const title = (schema as { title?: unknown }).title;
    if (typeof title === "string" && title.trim() && isNamedObjectSchema(schema) && !schemas.has(title)) {
      schemas.set(title, schema);
    }
    for (const nested of Object.values(schema)) visit(nested);
  };

  for (const command of commands) visit(buildReturnSchema(command));
  return schemas;
}

function isNamedObjectSchema(schema: JsonSchema): boolean {
  if (findNamedObjectShape(schema)) return true;
  const alternatives = (schema as { anyOf?: JsonSchema[] }).anyOf;
  return Array.isArray(alternatives) && alternatives.length > 0 && alternatives.every(isObjectWithProperties);
}

function findNamedObjectShape(schema: JsonSchema): JsonSchema | null {
  if (isObjectWithProperties(schema)) return schema;
  const intersections = (schema as { allOf?: JsonSchema[] }).allOf;
  if (!Array.isArray(intersections)) return null;
  return intersections.find(isObjectWithProperties) ?? null;
}

function renderGeneratedCodingKey(): string {
  return [
    "private struct RaviGeneratedCodingKey: CodingKey {",
    "  let stringValue: String",
    "  let intValue: Int?",
    "",
    "  init?(stringValue: String) {",
    "    self.stringValue = stringValue",
    "    self.intValue = nil",
    "  }",
    "",
    "  init?(intValue: Int) {",
    "    self.stringValue = String(intValue)",
    "    self.intValue = intValue",
    "  }",
    "}",
  ].join("\n");
}

interface SwiftReturnField {
  rawName: string;
  swiftName: string;
  isRequired: boolean;
  isOptional: boolean;
  preservesNullPresence?: boolean;
  requiresNonNullWhenPresent?: boolean;
}

function appendReturnFieldEncoding(lines: string[], field: SwiftReturnField, presentKeysProperty?: string): void {
  if (field.isRequired) {
    if (!field.isOptional) {
      lines.push(`    try container.encode(self.${field.swiftName}, forKey: .${field.swiftName})`);
      return;
    }
    lines.push(
      `    if let value = self.${field.swiftName} {`,
      `      try container.encode(value, forKey: .${field.swiftName})`,
      "    } else {",
      `      try container.encodeNil(forKey: .${field.swiftName})`,
      "    }",
    );
    return;
  }
  if (field.preservesNullPresence && presentKeysProperty) {
    lines.push(
      `    if let value = self.${field.swiftName} {`,
      `      try container.encode(value, forKey: .${field.swiftName})`,
      `    } else if self.${presentKeysProperty}.contains(${JSON.stringify(field.rawName)}) {`,
      `      try container.encodeNil(forKey: .${field.swiftName})`,
      "    }",
    );
    return;
  }
  lines.push(`    try container.encodeIfPresent(self.${field.swiftName}, forKey: .${field.swiftName})`);
}

function uniqueInternalPropertyName(preferred: string, fields: SwiftReturnField[]): string {
  const used = new Set(fields.map((field) => field.swiftName));
  let candidate = preferred;
  while (used.has(candidate)) candidate += "_";
  return candidate;
}

function renderNamedReturnStruct(name: string, schema: JsonSchema): string {
  const normalized = normalizeNamedObjectSchema(schema);
  const props = normalized.properties;
  const required = normalized.required;
  const rawNames = Object.keys(props).sort();
  const swiftNames = uniquePropertyNames(rawNames);
  const fields = rawNames.map((rawName) => {
    const swiftName = swiftNames.get(rawName)!;
    const { schema: valueSchema, nullable } = unwrapNullableSchema(props[rawName]);
    const isRequired = required.has(rawName);
    const isOptional = nullable || !isRequired;
    return {
      rawName,
      swiftName,
      swiftType: jsonSchemaToSwift(valueSchema),
      isRequired,
      isOptional,
      preservesNullPresence: nullable && !isRequired && normalized.requiredInSomeAlternative.has(rawName),
      requiresNonNullWhenPresent: !nullable && !isRequired && normalized.requiredInSomeAlternative.has(rawName),
    };
  });
  const tracksPresentKeys = fields.some((field) => field.preservesNullPresence);
  const presentKeysProperty = tracksPresentKeys ? uniqueInternalPropertyName("_raviPresentKeys", fields) : undefined;
  const lines = [
    `public struct ${name}: Codable, Sendable {`,
    ...fields.map((field) => `  public var ${field.swiftName}: ${field.swiftType}${field.isOptional ? "?" : ""}`),
    ...(presentKeysProperty ? ["", `  private var ${presentKeysProperty}: Set<String> = []`] : []),
    "",
    "  enum CodingKeys: String, CodingKey, CaseIterable {",
    ...fields.map((field) => `    case ${field.swiftName} = ${JSON.stringify(field.rawName)}`),
    "  }",
    "",
    "  public init(from decoder: Decoder) throws {",
    "    let rawContainer = try decoder.container(keyedBy: RaviGeneratedCodingKey.self)",
    "    let allowedKeys = Set(CodingKeys.allCases.map(\\.rawValue))",
    "    guard rawContainer.allKeys.allSatisfy({ allowedKeys.contains($0.stringValue) }) else {",
    `      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "${name} contains an unknown field."))`,
    "    }",
  ];
  if (normalized.requiresAtLeastOne) {
    lines.push(
      "    guard !rawContainer.allKeys.isEmpty else {",
      `      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "${name} requires at least one field."))`,
      "    }",
    );
  }
  if (presentKeysProperty) {
    lines.push(`    self.${presentKeysProperty} = Set(rawContainer.allKeys.map(\\.stringValue))`);
  }
  lines.push("    let container = try decoder.container(keyedBy: CodingKeys.self)");
  for (const field of fields) {
    if (field.isRequired && field.isOptional) {
      lines.push(
        `    guard container.contains(.${field.swiftName}) else {`,
        `      throw DecodingError.keyNotFound(CodingKeys.${field.swiftName}, .init(codingPath: decoder.codingPath, debugDescription: "Missing required field ${field.rawName}."))`,
        "    }",
      );
    }
    if (field.requiresNonNullWhenPresent) {
      lines.push(
        `    if container.contains(.${field.swiftName}) {`,
        `      self.${field.swiftName} = try container.decode(${field.swiftType}.self, forKey: .${field.swiftName})`,
        "    } else {",
        `      self.${field.swiftName} = nil`,
        "    }",
      );
      continue;
    }
    const decodeMethod = field.isOptional ? "decodeIfPresent" : "decode";
    lines.push(
      `    self.${field.swiftName} = try container.${decodeMethod}(${field.swiftType}.self, forKey: .${field.swiftName})`,
    );
  }
  lines.push(
    "  }",
    "",
    "  public func encode(to encoder: Encoder) throws {",
    "    var container = encoder.container(keyedBy: CodingKeys.self)",
  );
  for (const field of fields) {
    appendReturnFieldEncoding(lines, field, presentKeysProperty);
  }
  lines.push("  }", "}");
  return lines.join("\n");
}

function normalizeNamedObjectSchema(schema: JsonSchema): {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
  requiredInSomeAlternative: Set<string>;
  requiresAtLeastOne: boolean;
} {
  if (isObjectWithProperties(schema)) {
    return {
      properties: (schema as { properties: Record<string, JsonSchema> }).properties,
      required: new Set((schema as { required?: string[] }).required ?? []),
      requiredInSomeAlternative: new Set(),
      requiresAtLeastOne: false,
    };
  }

  const objectShape = findNamedObjectShape(schema);
  if (objectShape) {
    const intersections = (schema as { allOf?: JsonSchema[] }).allOf ?? [];
    const requiredInSomeAlternative = new Set<string>();
    for (const part of intersections) {
      const alternatives = (part as { anyOf?: JsonSchema[] }).anyOf ?? [];
      for (const alternative of alternatives) {
        for (const key of (alternative as { required?: string[] }).required ?? []) {
          requiredInSomeAlternative.add(key);
        }
      }
    }
    return {
      properties: (objectShape as { properties: Record<string, JsonSchema> }).properties,
      required: new Set((objectShape as { required?: string[] }).required ?? []),
      requiredInSomeAlternative,
      requiresAtLeastOne: intersections.some((part) => Array.isArray((part as { anyOf?: unknown[] }).anyOf)),
    };
  }

  const alternatives = (schema as { anyOf: JsonSchema[] }).anyOf;
  const properties = (alternatives[0] as { properties: Record<string, JsonSchema> }).properties;
  const requiredSets = alternatives.map(
    (alternative) => new Set((alternative as { required?: string[] }).required ?? []),
  );
  const required = new Set(
    Object.keys(properties).filter((key) => requiredSets.every((requiredSet) => requiredSet.has(key))),
  );
  const requiredInSomeAlternative = new Set(requiredSets.flatMap((requiredSet) => [...requiredSet]));
  return { properties, required, requiredInSomeAlternative, requiresAtLeastOne: true };
}

function unwrapNullableSchema(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const alternatives = (schema as { anyOf?: JsonSchema[] }).anyOf;
  if (Array.isArray(alternatives)) {
    const nonNull = alternatives.filter((alternative) => (alternative as { type?: unknown }).type !== "null");
    if (nonNull.length === 1 && nonNull.length !== alternatives.length) {
      return { schema: nonNull[0], nullable: true };
    }
  }
  const type = (schema as { type?: unknown }).type;
  if (Array.isArray(type) && type.includes("null")) {
    const nonNull = type.filter((value) => value !== "null");
    if (nonNull.length === 1) return { schema: { ...schema, type: nonNull[0] }, nullable: true };
  }
  return { schema, nullable: false };
}

function renderOptionsStruct(cmd: CommandRegistryEntry): string | null {
  if (cmd.options.length === 0) return null;
  const inputSchema = buildInputSchema(cmd);
  const props = (inputSchema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const required = new Set((inputSchema as { required?: string[] }).required ?? []);
  const argNames = new Set(cmd.args.map((arg) => arg.name));
  const options = cmd.options.filter((opt) => !argNames.has(opt.name));
  const swiftNames = uniquePropertyNames(options.map((opt) => opt.name));
  const fields = options
    .map((opt) => {
      const swiftName = swiftNames.get(opt.name)!;
      const swiftType = jsonSchemaToSwift(props[opt.name]);
      const isRequired = required.has(opt.name);
      return { rawName: opt.name, swiftName, swiftType, isRequired };
    })
    .sort((a, b) => (a.swiftName < b.swiftName ? -1 : a.swiftName > b.swiftName ? 1 : 0));
  if (fields.length === 0) return null;

  const name = optionsTypeName(cmd.groupSegments, cmd.command);
  const lines: string[] = [
    `public struct ${name}: Codable, Sendable {`,
    ...fields.map((field) => `  public var ${field.swiftName}: ${field.swiftType}${field.isRequired ? "" : "?"}`),
    "",
  ];

  const initParams = fields.map((field) => {
    const type = `${field.swiftType}${field.isRequired ? "" : "?"}`;
    const suffix = field.isRequired ? "" : " = nil";
    return `${field.swiftName}: ${type}${suffix}`;
  });
  lines.push(`  public init(${initParams.join(", ")}) {`);
  for (const field of fields) {
    lines.push(`    self.${field.swiftName} = ${field.swiftName}`);
  }
  lines.push("  }");
  lines.push("");
  lines.push("  enum CodingKeys: String, CodingKey {");
  for (const field of fields) {
    lines.push(`    case ${field.swiftName} = ${JSON.stringify(field.rawName)}`);
  }
  lines.push("  }");
  lines.push("");
  lines.push("  func encodeBody(into body: inout [String: RaviJSON]) throws {");
  for (const field of fields) {
    if (field.isRequired) {
      lines.push(`    body[${JSON.stringify(field.rawName)}] = try RaviJSON.fromEncodable(self.${field.swiftName})`);
    } else {
      lines.push(`    if let value = self.${field.swiftName} {`);
      lines.push(`      body[${JSON.stringify(field.rawName)}] = try RaviJSON.fromEncodable(value)`);
      lines.push("    }");
    }
  }
  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

function renderReturnDeclaration(cmd: CommandRegistryEntry): string {
  const name = returnTypeName(cmd.groupSegments, cmd.command);
  if (cmd.binary) {
    return `public typealias ${name} = RaviBinaryResponse`;
  }

  const schema = buildReturnSchema(cmd);
  if (!schema) {
    return `public typealias ${name} = RaviJSON`;
  }

  if (isObjectWithProperties(schema)) {
    return renderReturnStruct(name, schema);
  }
  return `public typealias ${name} = ${jsonSchemaToSwift(schema)}`;
}

function renderReturnStruct(name: string, schema: JsonSchema): string {
  const props = (schema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const required = new Set((schema as { required?: string[] }).required ?? []);
  const rawNames = Object.keys(props).sort();
  const swiftNames = uniquePropertyNames(rawNames);
  const fields = rawNames.map((rawName) => {
    const swiftName = swiftNames.get(rawName)!;
    const { schema: valueSchema, nullable } = unwrapNullableSchema(props[rawName]);
    const swiftType = jsonSchemaToSwift(valueSchema);
    const isRequired = required.has(rawName);
    const isOptional = nullable || !isRequired;
    return { rawName, swiftName, swiftType, isRequired, isOptional };
  });

  const lines: string[] = [
    `public struct ${name}: Codable, Sendable {`,
    ...fields.map((field) => `  public var ${field.swiftName}: ${field.swiftType}${field.isOptional ? "?" : ""}`),
    "",
  ];
  const initParams = fields.map((field) => {
    const type = `${field.swiftType}${field.isOptional ? "?" : ""}`;
    const suffix = field.isRequired ? "" : " = nil";
    return `${field.swiftName}: ${type}${suffix}`;
  });
  lines.push(`  public init(${initParams.join(", ")}) {`);
  for (const field of fields) {
    lines.push(`    self.${field.swiftName} = ${field.swiftName}`);
  }
  lines.push("  }");
  lines.push("");
  lines.push("  enum CodingKeys: String, CodingKey {");
  for (const field of fields) {
    lines.push(`    case ${field.swiftName} = ${JSON.stringify(field.rawName)}`);
  }
  lines.push("  }");
  if (!fields.some((field) => field.isRequired && field.isOptional)) {
    lines.push("}");
    return lines.join("\n");
  }
  lines.push("", "  public init(from decoder: Decoder) throws {");
  lines.push("    let container = try decoder.container(keyedBy: CodingKeys.self)");
  for (const field of fields) {
    if (field.isRequired && field.isOptional) {
      lines.push(
        `    guard container.contains(.${field.swiftName}) else {`,
        `      throw DecodingError.keyNotFound(CodingKeys.${field.swiftName}, .init(codingPath: decoder.codingPath, debugDescription: "Missing required field ${field.rawName}."))`,
        "    }",
      );
    }
    const decodeMethod = field.isOptional ? "decodeIfPresent" : "decode";
    lines.push(
      `    self.${field.swiftName} = try container.${decodeMethod}(${field.swiftType}.self, forKey: .${field.swiftName})`,
    );
  }
  lines.push(
    "  }",
    "",
    "  public func encode(to encoder: Encoder) throws {",
    "    var container = encoder.container(keyedBy: CodingKeys.self)",
  );
  for (const field of fields) {
    appendReturnFieldEncoding(lines, field);
  }
  lines.push("  }", "}");
  return lines.join("\n");
}

function isObjectWithProperties(schema: JsonSchema): boolean {
  return (
    (schema as { type?: unknown }).type === "object" &&
    Object.keys((schema as { properties?: Record<string, JsonSchema> }).properties ?? {}).length > 0
  );
}

/* -------------------------------------------------------------------------- */
/*  RaviSchemas.generated.swift                                               */
/* -------------------------------------------------------------------------- */

export function emitSwiftSchemas(commands: CommandRegistryEntry[]): string {
  const lines: string[] = [HEADER, "", "import Foundation", "", "public enum RaviSchemas {"];
  for (const cmd of commands) {
    const inputSchema = buildInputSchema(cmd);
    const returnSchema = buildReturnSchema(cmd);
    lines.push(`  public static let ${inputSchemaName(cmd.groupSegments, cmd.command)} = #"""`);
    lines.push(indentSwiftMultilineString(stableStringify(inputSchema, 2), "  "));
    lines.push(`  """#`);
    if (returnSchema) {
      lines.push("");
      lines.push(`  public static let ${returnSchemaName(cmd.groupSegments, cmd.command)} = #"""`);
      lines.push(indentSwiftMultilineString(stableStringify(returnSchema, 2), "  "));
      lines.push(`  """#`);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push("}");
  return ensureTrailingNewline(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  RaviClient.generated.swift                                                */
/* -------------------------------------------------------------------------- */

interface MethodNode {
  kind: "method";
  cmd: CommandRegistryEntry;
}

interface NamespaceNode {
  kind: "namespace";
  path: string[];
  children: Map<string, NamespaceNode | MethodNode>;
}

function buildTree(commands: CommandRegistryEntry[]): NamespaceNode {
  const root: NamespaceNode = { kind: "namespace", path: [], children: new Map() };
  const namespaceKeys = buildNamespaceChildKeys(commands);
  for (const cmd of commands) {
    let node = root;
    for (const segment of cmd.groupSegments) {
      const key = propertyName(segment);
      const existing = node.children.get(key);
      if (existing && existing.kind === "method") {
        throw new Error(`Swift codegen: namespace/method collision at ${cmd.fullName}`);
      }
      if (!existing) {
        const fresh: NamespaceNode = { kind: "namespace", path: [...node.path, segment], children: new Map() };
        node.children.set(key, fresh);
        node = fresh;
      } else {
        node = existing;
      }
    }
    const baseMethod = methodName(cmd.command);
    const reservedAtNode = namespaceKeys.get(namespacePathKey(node.path)) ?? new Set<string>();
    const method = reservedAtNode.has(baseMethod)
      ? disambiguatedIntermediateCommandName(baseMethod, reservedAtNode, node.children)
      : baseMethod;
    if (node.children.has(method)) {
      throw new Error(`Swift codegen: duplicate method ${method} under ${cmd.groupPath}`);
    }
    node.children.set(method, { kind: "method", cmd });
  }
  return root;
}

function buildNamespaceChildKeys(commands: CommandRegistryEntry[]): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  for (const cmd of commands) {
    for (let index = 0; index < cmd.groupSegments.length; index++) {
      const parentPath = cmd.groupSegments.slice(0, index);
      const childKey = propertyName(cmd.groupSegments[index]);
      const pathKey = namespacePathKey(parentPath);
      const set = byPath.get(pathKey) ?? new Set<string>();
      set.add(childKey);
      byPath.set(pathKey, set);
    }
  }
  return byPath;
}

function namespacePathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function disambiguatedIntermediateCommandName(
  baseMethod: string,
  reservedNamespaceKeys: Set<string>,
  siblings: Map<string, NamespaceNode | MethodNode>,
): string {
  let candidate = `${baseMethod}Command`;
  let suffix = 2;
  while (reservedNamespaceKeys.has(candidate) || siblings.has(candidate)) {
    candidate = `${baseMethod}Command${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function emitSwiftClient(commands: CommandRegistryEntry[]): string {
  const tree = buildTree(commands);
  const namespaceDecls: string[] = [];
  renderNamespaceDeclarations(tree, namespaceDecls);

  const lines: string[] = [
    HEADER,
    "",
    "import Foundation",
    "",
    "public final class RaviClient {",
    "  private let transport: any RaviTransport",
    "",
    "  public init(transport: any RaviTransport) {",
    "    self.transport = transport",
    "  }",
    "",
  ];

  for (const [key, child] of sortedChildren(tree)) {
    if (child.kind !== "namespace") continue;
    lines.push(`  public var ${key}: ${namespaceName(child.path)} {`);
    lines.push(`    ${namespaceName(child.path)}(transport: transport)`);
    lines.push("  }");
    lines.push("");
  }
  lines.push("}");
  lines.push("");
  lines.push(...namespaceDecls);
  return ensureTrailingNewline(lines.join("\n"));
}

function renderNamespaceDeclarations(root: NamespaceNode, out: string[]): void {
  for (const [, child] of sortedChildren(root)) {
    if (child.kind === "namespace") {
      renderNamespaceDeclaration(child, out);
      renderNamespaceDeclarations(child, out);
    }
  }
}

function renderNamespaceDeclaration(node: NamespaceNode, out: string[]): void {
  const name = namespaceName(node.path);
  out.push(`public struct ${name}: Sendable {`);
  out.push("  private let transport: any RaviTransport");
  out.push("");
  out.push("  init(transport: any RaviTransport) {");
  out.push("    self.transport = transport");
  out.push("  }");
  out.push("");

  for (const [key, child] of sortedChildren(node)) {
    if (child.kind !== "namespace") continue;
    out.push(`  public var ${key}: ${namespaceName(child.path)} {`);
    out.push(`    ${namespaceName(child.path)}(transport: transport)`);
    out.push("  }");
    out.push("");
  }

  for (const [key, child] of sortedChildren(node)) {
    if (child.kind !== "method") continue;
    const rendered = renderMethod(key, child.cmd);
    out.push(rendered);
    out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  out.push("}");
  out.push("");
}

function renderMethod(swiftName: string, cmd: CommandRegistryEntry): string {
  const inputSchema = buildInputSchema(cmd);
  const sig = buildSignature(cmd, inputSchema);
  const returnName = returnTypeName(cmd.groupSegments, cmd.command);
  const argNames = uniquePropertyNames(
    sig.args.map((arg) => arg.name),
    sig.options.length > 0 ? ["options"] : [],
  );
  const params = renderMethodParams(cmd, sig, argNames);
  const mutatesBody = sig.args.length > 0 || sig.options.length > 0;
  const lines: string[] = [];
  lines.push(`  public func ${swiftName}(${params}) async throws -> ${returnName} {`);
  lines.push(`    ${mutatesBody ? "var" : "let"} requestBody: [String: RaviJSON] = [:]`);
  for (const arg of sig.args) {
    const swiftArg = argNames.get(arg.name)!;
    if (arg.required) {
      lines.push(`    requestBody[${JSON.stringify(arg.name)}] = try RaviJSON.fromEncodable(${swiftArg})`);
    } else {
      lines.push(`    if let ${swiftArg} {`);
      lines.push(`      requestBody[${JSON.stringify(arg.name)}] = try RaviJSON.fromEncodable(${swiftArg})`);
      lines.push("    }");
    }
  }
  if (sig.options.length > 0) {
    lines.push("    try options.encodeBody(into: &requestBody)");
  }
  const groupSegments = JSON.stringify(cmd.groupSegments);
  const command = JSON.stringify(cmd.command);
  if (cmd.binary) {
    lines.push(
      `    return try await transport.callBinary(groupSegments: ${groupSegments}, command: ${command}, body: requestBody)`,
    );
  } else {
    lines.push(
      `    return try await transport.call(groupSegments: ${groupSegments}, command: ${command}, body: requestBody, as: ${returnName}.self)`,
    );
  }
  lines.push("  }");
  return lines.join("\n");
}

function renderMethodParams(
  cmd: CommandRegistryEntry,
  sig: CommandSignature,
  argNames: ReadonlyMap<string, string>,
): string {
  const inputSchema = buildInputSchema(cmd);
  const props = (inputSchema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const params: string[] = sig.args.map((arg) => {
    const swiftArg = argNames.get(arg.name)!;
    const type = jsonSchemaToSwift(props[arg.name]);
    return `_ ${swiftArg}: ${type}${arg.required ? "" : "? = nil"}`;
  });
  if (sig.options.length > 0) {
    const type = optionsTypeName(cmd.groupSegments, cmd.command);
    const suffix = sig.optionsOptional ? " = .init()" : "";
    params.push(`_ options: ${type}${suffix}`);
  }
  return params.join(", ");
}

function sortedChildren(node: NamespaceNode): [string, NamespaceNode | MethodNode][] {
  return [...node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/* -------------------------------------------------------------------------- */
/*  RaviVersion.generated.swift                                               */
/* -------------------------------------------------------------------------- */

export function emitSwiftVersion(input: EmitSwiftVersionInput): string {
  const lines = [
    HEADER,
    "",
    `public let RAVI_SDK_VERSION = ${swiftString(input.sdkVersion)}`,
    `public let RAVI_REGISTRY_HASH = ${swiftString(input.registryHash)}`,
    `public let RAVI_GIT_SHA = ${swiftString(input.gitSha)}`,
  ];
  return ensureTrailingNewline(lines.join("\n"));
}

function swiftString(value: string): string {
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/*  Drift comparator                                                          */
/* -------------------------------------------------------------------------- */

export type GeneratedSwiftSdkFile =
  | "RaviClient.generated.swift"
  | "RaviTypes.generated.swift"
  | "RaviSchemas.generated.swift"
  | "RaviVersion.generated.swift";

export interface SwiftSdkSourceComparison {
  equal: boolean;
  reason?: string;
}

const GIT_SHA_LINE_RE = /^public let RAVI_GIT_SHA = .*$/m;
const GIT_SHA_MASK = 'public let RAVI_GIT_SHA = "<masked-for-drift-check>"';

export function compareSwiftSdkSource(
  file: GeneratedSwiftSdkFile,
  stored: string,
  generated: string,
): SwiftSdkSourceComparison {
  if (file === "RaviVersion.generated.swift") {
    const a = maskGitSha(stored);
    const b = maskGitSha(generated);
    if (a === b) return { equal: true };
    return {
      equal: false,
      reason: `byte mismatch ignoring RAVI_GIT_SHA (stored=${stored.length}, live=${generated.length})`,
    };
  }
  if (stored === generated) return { equal: true };
  return {
    equal: false,
    reason: `byte mismatch (stored=${stored.length}, live=${generated.length})`,
  };
}

function maskGitSha(source: string): string {
  return source.replace(GIT_SHA_LINE_RE, GIT_SHA_MASK);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function indentSwiftMultilineString(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}
