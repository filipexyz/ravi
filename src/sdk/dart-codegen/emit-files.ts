/**
 * Emit generated files for the Dart ravi_sdk package.
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
  decodeFunctionName,
  inputSchemaName,
  methodName,
  namespaceName,
  optionsTypeName,
  propertyName,
  returnSchemaName,
  returnTypeName,
  uniquePropertyNames,
} from "./naming.js";
import { jsonSchemaToDart, type JsonSchema } from "./json-schema-to-dart.js";
import { defaultStreamChannels } from "../gateway/streaming/channels.js";
import { emitStreamingDart } from "./streaming-codegen.js";

const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Run `ravi sdk dart generate` to regenerate.",
  "// Drift is detected by `ravi sdk dart check`.",
].join("\n");

export interface EmitDartVersionInput {
  sdkVersion: string;
  registryHash: string;
  gitSha: string;
}

export interface EmitDartOptions {
  version: EmitDartVersionInput;
}

export interface EmittedDartSdk {
  client: string;
  types: string;
  schemas: string;
  version: string;
  streaming: string;
}

export function emitAllDart(registry: RegistrySnapshot, options: EmitDartOptions): EmittedDartSdk {
  const sortedCommands = [...registry.commands]
    .filter((cmd) => !cmd.cliOnly)
    .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
  return {
    client: emitDartClient(sortedCommands),
    types: emitDartTypes(sortedCommands),
    schemas: emitDartSchemas(sortedCommands),
    version: emitDartVersion(options.version),
    streaming: emitStreamingDart(defaultStreamChannels),
  };
}

/* -------------------------------------------------------------------------- */
/*  ravi_types.generated.dart                                                 */
/* -------------------------------------------------------------------------- */

export function emitDartTypes(commands: CommandRegistryEntry[]): string {
  const lines: string[] = [HEADER, "", "import 'ravi_json.dart';", "import 'ravi_transport.dart';", ""];
  for (const cmd of commands) {
    const optionsDecl = renderOptionsClass(cmd);
    if (optionsDecl) {
      lines.push(optionsDecl, "");
    }
    lines.push(renderReturnDeclaration(cmd), "");
  }
  return ensureTrailingNewline(lines.join("\n"));
}

function renderOptionsClass(cmd: CommandRegistryEntry): string | null {
  if (cmd.options.length === 0) return null;
  const inputSchema = buildInputSchema(cmd);
  const props = (inputSchema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const required = new Set((inputSchema as { required?: string[] }).required ?? []);
  const argNames = new Set(cmd.args.map((arg) => arg.name));
  const options = cmd.options.filter((opt) => !argNames.has(opt.name));
  const dartNames = uniquePropertyNames(
    options.map((opt) => opt.name),
    ["into"],
  );
  const fields = options
    .map((opt) => {
      const dartName = dartNames.get(opt.name)!;
      const dartType = jsonSchemaToDart(props[opt.name]);
      const isRequired = required.has(opt.name);
      return { rawName: opt.name, dartName, dartType, isRequired };
    })
    .sort((a, b) => (a.dartName < b.dartName ? -1 : a.dartName > b.dartName ? 1 : 0));
  if (fields.length === 0) return null;

  const name = optionsTypeName(cmd.groupSegments, cmd.command);
  const lines: string[] = [`class ${name} {`];

  const initParams = fields.map((field) => {
    if (field.isRequired) {
      return `required this.${field.dartName}`;
    }
    return `this.${field.dartName}`;
  });
  lines.push(`  const ${name}({${initParams.join(", ")}});`);
  lines.push("");
  for (const field of fields) {
    lines.push(`  final ${field.dartType}${field.isRequired ? "" : "?"} ${field.dartName};`);
  }
  lines.push("");
  lines.push("  void encodeBody(Map<String, RaviJson> into) {");
  for (const field of fields) {
    if (field.isRequired) {
      lines.push(`    into[${JSON.stringify(field.rawName)}] = RaviJson.from(${field.dartName});`);
    } else {
      lines.push(`    if (${field.dartName} != null) {`);
      lines.push(`      into[${JSON.stringify(field.rawName)}] = RaviJson.from(${field.dartName});`);
      lines.push("    }");
    }
  }
  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

function renderReturnDeclaration(cmd: CommandRegistryEntry): string {
  const name = returnTypeName(cmd.groupSegments, cmd.command);
  const decodeName = decodeFunctionName(cmd.groupSegments, cmd.command);
  if (cmd.binary) {
    return [
      `typedef ${name} = RaviBinaryResponse;`,
      "",
      `${name} ${decodeName}(Object? json) {`,
      `  throw FormatException('${name} is a binary response and cannot be decoded from JSON');`,
      "}",
    ].join("\n");
  }

  const schema = buildReturnSchema(cmd);
  if (!schema) {
    return [`typedef ${name} = RaviJson;`, "", `${name} ${decodeName}(Object? json) => RaviJson.from(json);`].join(
      "\n",
    );
  }

  if (isObjectWithProperties(schema)) {
    return renderReturnClass(name, decodeName, schema);
  }

  const dartType = jsonSchemaToDart(schema);
  return [
    `typedef ${name} = ${dartType};`,
    "",
    `${name} ${decodeName}(Object? json) => ${decodeHelperCall(dartType, "json")};`,
  ].join("\n");
}

function renderReturnClass(name: string, decodeName: string, schema: JsonSchema): string {
  const props = (schema as { properties?: Record<string, JsonSchema> }).properties ?? {};
  const required = new Set((schema as { required?: string[] }).required ?? []);
  const rawNames = Object.keys(props).sort();
  const dartNames = uniquePropertyNames(rawNames);
  const fields = rawNames.map((rawName) => {
    const dartName = dartNames.get(rawName)!;
    const dartType = jsonSchemaToDart(props[rawName]);
    const isRequired = required.has(rawName);
    return { rawName, dartName, dartType, isRequired };
  });

  const lines: string[] = [`class ${name} {`];
  const initParams = fields.map((field) => {
    if (field.isRequired) return `required this.${field.dartName}`;
    return `this.${field.dartName}`;
  });
  lines.push(`  const ${name}({${initParams.join(", ")}});`);
  lines.push("");
  for (const field of fields) {
    lines.push(`  final ${field.dartType}${field.isRequired ? "" : "?"} ${field.dartName};`);
  }
  lines.push("");
  lines.push(`  factory ${name}.fromJson(Map<String, Object?> json) {`);
  lines.push(`    return ${name}(`);
  for (const field of fields) {
    const lookup = `json[${JSON.stringify(field.rawName)}]`;
    if (field.isRequired) {
      lines.push(`      ${field.dartName}: ${decodeHelperCall(field.dartType, lookup)},`);
    } else {
      lines.push(`      ${field.dartName}: ${lookup} == null ? null : ${decodeHelperCall(field.dartType, lookup)},`);
    }
  }
  lines.push("    );");
  lines.push("  }");
  lines.push("");
  lines.push(`  static ${name} fromJsonValue(Object? json) {`);
  lines.push(`    return ${name}.fromJson(raviJsonObject(json, ${JSON.stringify(name)}));`);
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push(`${name} ${decodeName}(Object? json) => ${name}.fromJsonValue(json);`);
  return lines.join("\n");
}

function decodeHelperCall(dartType: string, expr: string): string {
  switch (dartType) {
    case "String":
      return `raviJsonAsString(${expr})`;
    case "bool":
      return `raviJsonAsBool(${expr})`;
    case "int":
      return `raviJsonAsInt(${expr})`;
    case "double":
      return `raviJsonAsDouble(${expr})`;
    case "RaviJson":
      return `RaviJson.from(${expr})`;
    case "Map<String, RaviJson>":
      return `raviJsonAsRaviJsonMap(${expr})`;
    default:
      break;
  }

  if (dartType.startsWith("List<") && dartType.endsWith(">")) {
    return `raviJsonAsList(${expr}, ${decodeFunctionRef(dartType.slice(5, -1))})`;
  }
  if (dartType.startsWith("Map<String, ") && dartType.endsWith(">")) {
    return `raviJsonAsMap(${expr}, ${decodeFunctionRef(dartType.slice("Map<String, ".length, -1))})`;
  }
  return `RaviJson.from(${expr})`;
}

function decodeFunctionRef(dartType: string): string {
  switch (dartType) {
    case "String":
      return "raviJsonAsString";
    case "bool":
      return "raviJsonAsBool";
    case "int":
      return "raviJsonAsInt";
    case "double":
      return "raviJsonAsDouble";
    case "RaviJson":
      return "RaviJson.from";
    case "Map<String, RaviJson>":
      return "raviJsonAsRaviJsonMap";
    default:
      return `(value) => ${decodeHelperCall(dartType, "value")}`;
  }
}

function isObjectWithProperties(schema: JsonSchema): boolean {
  return (
    (schema as { type?: unknown }).type === "object" &&
    Object.keys((schema as { properties?: Record<string, JsonSchema> }).properties ?? {}).length > 0
  );
}

/* -------------------------------------------------------------------------- */
/*  ravi_schemas.generated.dart                                               */
/* -------------------------------------------------------------------------- */

export function emitDartSchemas(commands: CommandRegistryEntry[]): string {
  const lines: string[] = [HEADER, "", "class RaviSchemas {", "  const RaviSchemas._();", ""];
  for (const cmd of commands) {
    const inputSchema = buildInputSchema(cmd);
    const returnSchema = buildReturnSchema(cmd);
    lines.push(`  static const ${inputSchemaName(cmd.groupSegments, cmd.command)} = r'''`);
    lines.push(stableStringify(inputSchema, 2));
    lines.push(`''';`);
    if (returnSchema) {
      lines.push("");
      lines.push(`  static const ${returnSchemaName(cmd.groupSegments, cmd.command)} = r'''`);
      lines.push(stableStringify(returnSchema, 2));
      lines.push(`''';`);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push("}");
  return ensureTrailingNewline(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  ravi_client.generated.dart                                                */
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
        throw new Error(`Dart codegen: namespace/method collision at ${cmd.fullName}`);
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
      throw new Error(`Dart codegen: duplicate method ${method} under ${cmd.groupPath}`);
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

export function emitDartClient(commands: CommandRegistryEntry[]): string {
  const tree = buildTree(commands);
  const namespaceDecls: string[] = [];
  renderNamespaceDeclarations(tree, namespaceDecls);

  const lines: string[] = [
    HEADER,
    "",
    "import 'ravi_json.dart';",
    "import 'ravi_transport.dart';",
    "import 'ravi_types.generated.dart';",
    "",
    "class RaviClient {",
    "  RaviClient(this._transport);",
    "",
    "  final RaviTransport _transport;",
    "",
  ];

  for (const [key, child] of sortedChildren(tree)) {
    if (child.kind !== "namespace") continue;
    lines.push(`  ${namespaceName(child.path)} get ${key} => ${namespaceName(child.path)}(_transport);`);
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
  out.push(`class ${name} {`);
  out.push(`  const ${name}(this._transport);`);
  out.push("");
  out.push("  final RaviTransport _transport;");
  out.push("");

  for (const [key, child] of sortedChildren(node)) {
    if (child.kind !== "namespace") continue;
    out.push(`  ${namespaceName(child.path)} get ${key} => ${namespaceName(child.path)}(_transport);`);
    out.push("");
  }

  for (const [key, child] of sortedChildren(node)) {
    if (child.kind !== "method") continue;
    out.push(renderMethod(key, child.cmd));
    out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  out.push("}");
  out.push("");
}

function renderMethod(dartName: string, cmd: CommandRegistryEntry): string {
  const inputSchema = buildInputSchema(cmd);
  const sig = buildSignature(cmd, inputSchema);
  const returnName = returnTypeName(cmd.groupSegments, cmd.command);
  const decodeName = decodeFunctionName(cmd.groupSegments, cmd.command);
  const argNames = uniquePropertyNames(
    sig.args.map((arg) => arg.name),
    sig.options.length > 0 ? ["options"] : [],
  );
  const params = renderMethodParams(cmd, sig, argNames);
  const lines: string[] = [];
  lines.push(`  Future<${returnName}> ${dartName}(${params}) async {`);
  lines.push("    final requestBody = <String, RaviJson>{};");
  for (const arg of sig.args) {
    const dartArg = argNames.get(arg.name)!;
    if (arg.required) {
      lines.push(`    requestBody[${JSON.stringify(arg.name)}] = RaviJson.from(${dartArg});`);
    } else {
      lines.push(`    if (${dartArg} != null) {`);
      lines.push(`      requestBody[${JSON.stringify(arg.name)}] = RaviJson.from(${dartArg});`);
      lines.push("    }");
    }
  }
  if (sig.options.length > 0) {
    lines.push("    options.encodeBody(requestBody);");
  }
  const groupSegments = dartStringList(cmd.groupSegments);
  const command = JSON.stringify(cmd.command);
  if (cmd.binary) {
    lines.push("    return _transport.callBinary(");
    lines.push(`      groupSegments: const ${groupSegments},`);
    lines.push(`      command: ${command},`);
    lines.push("      body: requestBody,");
    lines.push("    );");
  } else {
    lines.push("    return _transport.callJson(");
    lines.push(`      groupSegments: const ${groupSegments},`);
    lines.push(`      command: ${command},`);
    lines.push("      body: requestBody,");
    lines.push(`      decode: ${decodeName},`);
    lines.push("    );");
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
  const requiredParams: string[] = [];
  const optionalParams: string[] = [];

  for (const arg of sig.args) {
    const dartArg = argNames.get(arg.name)!;
    const type = jsonSchemaToDart(props[arg.name]);
    if (arg.required) {
      requiredParams.push(`${type} ${dartArg}`);
    } else {
      optionalParams.push(`${type}? ${dartArg}`);
    }
  }
  if (sig.options.length > 0) {
    const type = optionsTypeName(cmd.groupSegments, cmd.command);
    if (sig.optionsOptional) {
      optionalParams.push(`${type} options = const ${type}()`);
    } else {
      requiredParams.push(`${type} options`);
    }
  }

  if (optionalParams.length === 0) return requiredParams.join(", ");
  if (requiredParams.length === 0) return `[${optionalParams.join(", ")}]`;
  return `${requiredParams.join(", ")}, [${optionalParams.join(", ")}]`;
}

function dartStringList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function sortedChildren(node: NamespaceNode): [string, NamespaceNode | MethodNode][] {
  return [...node.children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/* -------------------------------------------------------------------------- */
/*  ravi_version.generated.dart                                               */
/* -------------------------------------------------------------------------- */

export function emitDartVersion(input: EmitDartVersionInput): string {
  const lines = [
    HEADER,
    "",
    `const raviSdkVersion = ${JSON.stringify(input.sdkVersion)};`,
    `const raviRegistryHash = ${JSON.stringify(input.registryHash)};`,
    `const raviGitSha = ${JSON.stringify(input.gitSha)};`,
  ];
  return ensureTrailingNewline(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  Drift comparator                                                          */
/* -------------------------------------------------------------------------- */

export type GeneratedDartSdkFile =
  | "ravi_client.generated.dart"
  | "ravi_types.generated.dart"
  | "ravi_schemas.generated.dart"
  | "ravi_version.generated.dart"
  | "ravi_streaming.generated.dart";

export interface DartSdkSourceComparison {
  equal: boolean;
  reason?: string;
}

const GIT_SHA_LINE_RE = /^const raviGitSha = .*$/m;
const GIT_SHA_MASK = 'const raviGitSha = "<masked-for-drift-check>";';

export function compareDartSdkSource(
  file: GeneratedDartSdkFile,
  stored: string,
  generated: string,
): DartSdkSourceComparison {
  if (file === "ravi_version.generated.dart") {
    const a = maskGitSha(stored);
    const b = maskGitSha(generated);
    if (a === b) return { equal: true };
    return {
      equal: false,
      reason: `byte mismatch ignoring raviGitSha (stored=${stored.length}, live=${generated.length})`,
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
