/**
 * Emit the four GENERATED files of `@ravi-os/sdk`:
 *
 *   - `types.ts`    — TS type aliases per command (input + return).
 *   - `schemas.ts`  — JSON Schema constants per command (`as const`).
 *   - `client.ts`   — `RaviClient` class with one method per registry command.
 *   - `version.ts`  — SDK_VERSION + REGISTRY_HASH + GIT_SHA.
 *
 * Determinism: commands are walked in alphabetical `fullName` order; nested
 * client namespaces are emitted with sorted keys; JSON Schema constants are
 * stringified through `stable-json.ts`.
 */

import type { CommandRegistryEntry, RegistrySnapshot } from "../../cli/registry-snapshot.js";
import {
  inputSchemaName,
  inputTypeName,
  methodName,
  namespaceProp,
  returnSchemaName,
  returnTypeName,
  assertIdentifier,
} from "./naming.js";
import { jsonSchemaToTs } from "./json-schema-to-ts.js";
import { buildInputSchema, buildReturnSchema, buildSignature, type CommandSignature } from "./registry-shape.js";
import { stableStringify } from "./stable-json.js";

const HEADER = [
  "// GENERATED FILE — DO NOT EDIT.",
  "// Run `ravi sdk client generate` to regenerate.",
  "// Drift is detected by `ravi sdk client check` (CI).",
].join("\n");

export interface EmitVersionInput {
  sdkVersion: string;
  registryHash: string;
  gitSha: string;
}

export interface EmittedSdk {
  types: string;
  schemas: string;
  client: string;
  version: string;
}

export interface EmitOptions {
  version: EmitVersionInput;
}

export function emitAll(registry: RegistrySnapshot, options: EmitOptions): EmittedSdk {
  const sortedCommands = [...registry.commands].sort((a, b) =>
    a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0,
  );
  return {
    types: emitTypes(sortedCommands),
    schemas: emitSchemas(sortedCommands),
    client: emitClient(sortedCommands),
    version: emitVersion(options.version),
  };
}

/* -------------------------------------------------------------------------- */
/*  types.ts                                                                  */
/* -------------------------------------------------------------------------- */

export function emitTypes(commands: CommandRegistryEntry[]): string {
  const lines: string[] = [HEADER, ""];
  for (const cmd of commands) {
    const inputSchema = buildInputSchema(cmd);
    const returnSchema = buildReturnSchema(cmd);

    const inputName = inputTypeName(cmd.groupSegments, cmd.command);
    const returnName = returnTypeName(cmd.groupSegments, cmd.command);
    assertIdentifier(inputName, `inputTypeName(${cmd.fullName})`);
    assertIdentifier(returnName, `returnTypeName(${cmd.fullName})`);

    lines.push(`/** Input shape for \`${cmd.fullName}\`. */`);
    lines.push(`export type ${inputName} = ${jsonSchemaToTs(inputSchema, 0)};`);
    lines.push("");
    lines.push(`/** Return shape for \`${cmd.fullName}\`.${returnSchema ? "" : " (no @Returns declared)"} */`);
    if (returnSchema) {
      lines.push(`export type ${returnName} = ${jsonSchemaToTs(returnSchema, 0)};`);
    } else {
      lines.push(`export type ${returnName} = unknown;`);
    }
    lines.push("");
  }
  return ensureTrailingNewline(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  schemas.ts                                                                */
/* -------------------------------------------------------------------------- */

export function emitSchemas(commands: CommandRegistryEntry[]): string {
  const lines: string[] = [
    HEADER,
    "",
    "/**",
    " * JSON Schema constants for every registry command. Emitted as `as const`",
    " * so callers can pair them with `ajv` / `zod-from-json-schema` / etc when",
    " * client-side validation is desired.",
    " */",
    "",
    "export type SdkJsonSchema = Record<string, unknown>;",
    "",
  ];
  for (const cmd of commands) {
    const inputSchema = buildInputSchema(cmd);
    const returnSchema = buildReturnSchema(cmd);
    const inputName = inputSchemaName(cmd.groupSegments, cmd.command);
    const returnName = returnSchemaName(cmd.groupSegments, cmd.command);
    assertIdentifier(inputName, `inputSchemaName(${cmd.fullName})`);
    assertIdentifier(returnName, `returnSchemaName(${cmd.fullName})`);

    lines.push(`/** JSON Schema for the input body of \`${cmd.fullName}\`. */`);
    lines.push(`export const ${inputName} = ${stableStringify(inputSchema, 2)} as const satisfies SdkJsonSchema;`);
    lines.push("");
    if (returnSchema) {
      lines.push(`/** JSON Schema for the return shape of \`${cmd.fullName}\`. */`);
      lines.push(`export const ${returnName} = ${stableStringify(returnSchema, 2)} as const satisfies SdkJsonSchema;`);
      lines.push("");
    }
  }
  return ensureTrailingNewline(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  client.ts                                                                 */
/* -------------------------------------------------------------------------- */

interface MethodNode {
  kind: "method";
  cmd: CommandRegistryEntry;
}
interface NamespaceNode {
  kind: "namespace";
  children: Map<string, NamespaceNode | MethodNode>;
}

function buildTree(commands: CommandRegistryEntry[]): NamespaceNode {
  const root: NamespaceNode = { kind: "namespace", children: new Map() };
  for (const cmd of commands) {
    let node: NamespaceNode = root;
    for (const segment of cmd.groupSegments) {
      const key = namespaceProp(segment);
      assertIdentifier(key, `namespaceProp(${cmd.fullName})`);
      const existing = node.children.get(key);
      if (existing && existing.kind === "method") {
        throw new Error(`Codegen: namespace/method collision at ${cmd.fullName} — ${key} already used as a method`);
      }
      if (!existing) {
        const fresh: NamespaceNode = { kind: "namespace", children: new Map() };
        node.children.set(key, fresh);
        node = fresh;
      } else {
        node = existing;
      }
    }
    const method = methodName(cmd.command);
    assertIdentifier(method, `methodName(${cmd.fullName})`);
    if (node.children.has(method)) {
      throw new Error(`Codegen: duplicate method ${method} under ${cmd.groupPath}`);
    }
    node.children.set(method, { kind: "method", cmd });
  }
  return root;
}

export function emitClient(commands: CommandRegistryEntry[]): string {
  const tree = buildTree(commands);
  const typeImports = new Set<string>();

  const renderNamespaceLiteral = (node: NamespaceNode, indent: number): string => {
    const pad = "  ".repeat(indent);
    const inner = "  ".repeat(indent + 1);
    const sortedKeys = [...node.children.keys()].sort();
    const lines: string[] = ["{"];
    for (let i = 0; i < sortedKeys.length; i++) {
      const key = sortedKeys[i];
      const child = node.children.get(key)!;
      const isLast = i === sortedKeys.length - 1;
      const trailing = isLast ? "" : ",";
      if (child.kind === "namespace") {
        const sub = renderNamespaceLiteral(child, indent + 1);
        lines.push(`${inner}${key}: ${sub}${trailing}`);
      } else {
        const description = child.cmd.description;
        if (description) {
          lines.push(`${inner}/** ${escapeJsDoc(description)} */`);
        }
        const arrow = renderMethod(child.cmd, indent + 1, typeImports);
        lines.push(`${inner}${key}: ${arrow}${trailing}`);
      }
    }
    lines.push(`${pad}}`);
    return lines.join("\n");
  };

  const sortedTopKeys = [...tree.children.keys()].sort();
  const fieldLines: string[] = [];
  for (const key of sortedTopKeys) {
    const child = tree.children.get(key)!;
    if (child.kind === "namespace") {
      const literal = renderNamespaceLiteral(child, 1);
      fieldLines.push(`  readonly ${key} = ${literal};`);
      fieldLines.push("");
    } else {
      if (child.cmd.description) {
        fieldLines.push(`  /** ${escapeJsDoc(child.cmd.description)} */`);
      }
      const arrow = renderMethod(child.cmd, 1, typeImports);
      fieldLines.push(`  readonly ${key} = ${arrow};`);
      fieldLines.push("");
    }
  }
  while (fieldLines.length > 0 && fieldLines[fieldLines.length - 1] === "") fieldLines.pop();

  const importList = [...typeImports].sort();
  const importLine = importList.length > 0 ? `import type { ${importList.join(", ")} } from "./types.js";` : "";

  const headerBlock = [HEADER, "", 'import type { Transport } from "./transport/types.js";'];
  if (importLine) headerBlock.push(importLine);
  headerBlock.push("");
  headerBlock.push("/**");
  headerBlock.push(" * `RaviClient` exposes every registry command as a typed method.");
  headerBlock.push(" *");
  headerBlock.push(" * The class is generated 1:1 from `getRegistry()`. Every method calls into");
  headerBlock.push(" * the supplied `Transport`, which is responsible for validation, scope");
  headerBlock.push(" * enforcement, and audit (see `transport/http.ts` and");
  headerBlock.push(" * `transport/in-process.ts`).");
  headerBlock.push(" */");
  headerBlock.push("export class RaviClient {");
  headerBlock.push("  constructor(private readonly transport: Transport) {}");
  headerBlock.push("");

  const out = [...headerBlock, ...fieldLines, "}"];
  return ensureTrailingNewline(out.join("\n"));
}

function renderMethod(cmd: CommandRegistryEntry, indent: number, typeImports: Set<string>): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  const innerInner = "  ".repeat(indent + 2);

  const inputSchema = buildInputSchema(cmd);
  const sig = buildSignature(cmd, inputSchema);
  const returnName = returnTypeName(cmd.groupSegments, cmd.command);
  typeImports.add(returnName);

  const params: string[] = [];
  const variadicArg = sig.args.find((a) => a.variadic);
  for (const arg of sig.args) {
    const optional = arg.required ? "" : "?";
    if (arg.variadic) {
      params.push(`${arg.name}: ${arg.type}`);
    } else {
      params.push(`${arg.name}${optional}: ${arg.type}`);
    }
  }
  if (sig.options.length > 0) {
    const optBag = renderOptionsBag(sig, indent + 1);
    const optParam = sig.optionsOptional ? `options?: ${optBag}` : `options: ${optBag}`;
    params.push(optParam);
  }

  const groupSegmentsLiteral = JSON.stringify(cmd.groupSegments);
  const commandLiteral = JSON.stringify(cmd.command);

  const bodyParts: string[] = [];
  for (const arg of sig.args) {
    bodyParts.push(arg.name);
  }
  if (sig.options.length > 0) {
    bodyParts.push(`...(options ?? {})`);
  }
  const bodyLiteral = bodyParts.length > 0 ? `{ ${bodyParts.join(", ")} }` : "{}";

  void variadicArg; // signature already encodes variadic via type

  const lines: string[] = [];
  lines.push(`async (${params.join(", ")}): Promise<${returnName}> => {`);
  lines.push(`${inner}return this.transport.call({`);
  lines.push(`${innerInner}groupSegments: ${groupSegmentsLiteral},`);
  lines.push(`${innerInner}command: ${commandLiteral},`);
  lines.push(`${innerInner}body: ${bodyLiteral},`);
  lines.push(`${inner}});`);
  lines.push(`${pad}}`);
  return lines.join("\n");
}

function renderOptionsBag(sig: CommandSignature, indent: number): string {
  if (sig.options.length === 0) return "Record<string, never>";
  const pad = "  ".repeat(indent);
  const close = "  ".repeat(indent - 1);
  const lines = ["{"];
  for (const o of sig.options) {
    const optional = o.required ? "" : "?";
    lines.push(`${pad}${o.name}${optional}: ${o.type};`);
  }
  lines.push(`${close}}`);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  version.ts                                                                */
/* -------------------------------------------------------------------------- */

export function emitVersion(input: EmitVersionInput): string {
  const lines = [
    HEADER,
    "",
    "/** Semver published by `@ravi-os/sdk`. Hand-set in the package.json. */",
    `export const SDK_VERSION = ${JSON.stringify(input.sdkVersion)};`,
    "",
    "/** SHA-256 fingerprint of the registry projection at codegen time. */",
    `export const REGISTRY_HASH = ${JSON.stringify(input.registryHash)};`,
    "",
    '/** Git SHA of the source tree at codegen time. `"unknown"` outside git. */',
    `export const GIT_SHA = ${JSON.stringify(input.gitSha)};`,
  ];
  return ensureTrailingNewline(lines.join("\n"));
}

/* -------------------------------------------------------------------------- */
/*  helpers                                                                   */
/* -------------------------------------------------------------------------- */

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeJsDoc(value: string): string {
  return value.replace(/\*\//g, "*\\/");
}

void Symbol; // ensure module is treated as non-trivial in transformer caches
