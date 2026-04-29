/**
 * CLI Registry Snapshot - exhaustive walk of decorated command classes.
 *
 * Produces a serializable-friendly view of the registry: groups, commands,
 * positional args, options (with parsed flags), inferred or explicit Zod
 * schemas for each input, and `@Returns` schema when declared.
 *
 * Consumers (SDK codegen, gateway, docs) read from `getRegistry()`. The
 * registry walks classes lazily on first call to avoid circular imports
 * during command class initialization.
 */

import "reflect-metadata";
import type { ZodTypeAny } from "zod";
import {
  getArgsMetadata,
  getCliOnlyMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsBinaryMetadata,
  getReturnsMetadata,
  getScopeMetadata,
  type ScopeType,
} from "./decorators.js";
import { inferArgSchema, inferOptionSchema, type ParsedOptionFlags } from "./schema-inference.js";

export type CommandClass = new () => object;

/**
 * Option names that belong to the CLI rendering layer, not the command contract.
 * The registry strips these before exposing the snapshot so SDK consumers
 * (gateway, OpenAPI, codegen) never see invocation-only knobs.
 *
 * Ground truth: these flags affect how the CLI prints output (`--json`,
 * `--pretty`, `--no-color`, `--quiet`, `--verbose`). The contract a remote
 * caller speaks is structured JSON; the rendering choice is the consumer's
 * problem.
 */
const RENDERING_FLAG_NAMES = new Set(["json", "asJson", "pretty", "noColor", "quiet", "verbose"]);

function isRenderingFlag(opt: { name: string }): boolean {
  return RENDERING_FLAG_NAMES.has(opt.name);
}

export interface ArgRegistryEntry {
  name: string;
  index: number;
  required: boolean;
  variadic: boolean;
  description?: string;
  defaultValue?: unknown;
  schema: ZodTypeAny;
  schemaSource: "explicit" | "inferred";
}

export interface OptionRegistryEntry {
  /** Property key on the decorating class (parameter binding name). */
  propertyKey: string;
  /** Parameter index on the method signature. */
  index: number;
  /** Raw DSL string from the decorator (`"--limit <n>"`). */
  flags: string;
  /** Camel-cased option name as exposed at runtime by `extractOptionName`. */
  name: string;
  description?: string;
  defaultValue?: unknown;
  parsed: ParsedOptionFlags;
  schema: ZodTypeAny;
  schemaSource: "explicit" | "inferred";
}

export interface GroupRegistryEntry {
  /** Dot-separated path; e.g. `"whatsapp.group"`. */
  name: string;
  /** Path split into segments. */
  segments: string[];
  description: string;
  scope?: ScopeType;
}

export interface CommandRegistryEntry {
  /** Dot-separated group path. */
  groupPath: string;
  groupSegments: string[];
  command: string;
  /** `groupPath + "." + command`; unique within the registry. */
  fullName: string;
  description: string;
  aliases?: string[];
  scope: ScopeType;
  /** Class method name backing this command. */
  method: string;
  /** Source class for runtime introspection. */
  cls: CommandClass;
  args: ArgRegistryEntry[];
  options: OptionRegistryEntry[];
  returns?: ZodTypeAny;
  /**
   * When true, the command returns a raw `Response` and bypasses JSON
   * serialization in the gateway dispatcher. SDK codegen emits
   * `Promise<Response>` for these methods. See `@Returns.binary()`.
   */
  binary?: boolean;
  /**
   * When true, the command is CLI-exclusive: the SDK gateway, OpenAPI emit,
   * and client codegen skip it. Use for streaming/interactive/process-level
   * handlers that have no remote-call semantics. See `@CliOnly()`.
   */
  cliOnly?: boolean;
}

export interface RegistrySnapshot {
  groups: GroupRegistryEntry[];
  commands: CommandRegistryEntry[];
}

/**
 * Build a registry snapshot from an explicit list of decorated classes.
 * Throws when two classes claim the same `(groupPath, command)` pair.
 */
export function buildRegistry(classes: CommandClass[]): RegistrySnapshot {
  const groups = new Map<string, GroupRegistryEntry>();
  const commandsByFullName = new Map<string, CommandRegistryEntry>();
  const ordered: CommandRegistryEntry[] = [];

  for (const cls of classes) {
    const groupMeta = getGroupMetadata(cls);
    if (!groupMeta) continue;

    const commandsMeta = getCommandsMetadata(cls);
    if (commandsMeta.length === 0) continue;

    const segments = groupMeta.name.split(".");
    if (!groups.has(groupMeta.name)) {
      groups.set(groupMeta.name, {
        name: groupMeta.name,
        segments,
        description: groupMeta.description,
        ...(groupMeta.scope ? { scope: groupMeta.scope } : {}),
      });
    }

    const instance = new cls();
    const scopeMap = getScopeMetadata(cls);
    const returnsMap = getReturnsMetadata(cls);
    const binaryReturnsSet = getReturnsBinaryMetadata(cls);
    const cliOnlySet = getCliOnlyMetadata(cls);

    for (const cmdMeta of commandsMeta) {
      const argsMeta = getArgsMetadata(instance, cmdMeta.method);
      const optionsMeta = getOptionsMetadata(instance, cmdMeta.method);

      const args: ArgRegistryEntry[] = argsMeta.map((arg) => {
        const inferred = inferArgSchema(arg);
        return {
          name: arg.name,
          index: arg.index,
          required: arg.required ?? true,
          variadic: arg.variadic === true,
          ...(arg.description !== undefined ? { description: arg.description } : {}),
          ...(arg.defaultValue !== undefined ? { defaultValue: arg.defaultValue } : {}),
          schema: inferred.schema,
          schemaSource: inferred.source,
        };
      });

      const options: OptionRegistryEntry[] = optionsMeta
        .map((opt) => {
          const inferred = inferOptionSchema(opt);
          return {
            propertyKey: opt.propertyKey,
            index: opt.index,
            flags: opt.flags,
            name: inferred.parsed.name,
            ...(opt.description !== undefined ? { description: opt.description } : {}),
            ...(opt.defaultValue !== undefined ? { defaultValue: opt.defaultValue } : {}),
            parsed: inferred.parsed,
            schema: inferred.schema,
            schemaSource: inferred.source,
          };
        })
        .filter((opt) => !isRenderingFlag(opt));

      const effectiveScope: ScopeType = scopeMap.get(cmdMeta.method) ?? groupMeta.scope ?? "admin";
      const fullName = `${groupMeta.name}.${cmdMeta.name}`;

      const entry: CommandRegistryEntry = {
        groupPath: groupMeta.name,
        groupSegments: segments,
        command: cmdMeta.name,
        fullName,
        description: cmdMeta.description,
        ...(cmdMeta.aliases ? { aliases: cmdMeta.aliases } : {}),
        scope: effectiveScope,
        method: cmdMeta.method,
        cls,
        args,
        options,
        ...(returnsMap.get(cmdMeta.method) ? { returns: returnsMap.get(cmdMeta.method)! } : {}),
        ...(binaryReturnsSet.has(cmdMeta.method) ? { binary: true } : {}),
        ...(cliOnlySet.has(cmdMeta.method) ? { cliOnly: true } : {}),
      };

      const existing = commandsByFullName.get(fullName);
      if (existing) {
        throw new Error(
          `CLI registry collision: command "${fullName}" is registered by both ` +
            `${existing.cls.name} (method ${existing.method}) and ${cls.name} (method ${cmdMeta.method}). ` +
            `Each (group, command) pair must be unique.`,
        );
      }
      commandsByFullName.set(fullName, entry);
      ordered.push(entry);
    }
  }

  return {
    groups: Array.from(groups.values()),
    commands: ordered,
  };
}

let _cached: RegistrySnapshot | null = null;
let _cachedKey: CommandClass[] | null = null;

/**
 * Lazy registry over the project's decorated command classes.
 * Pass an explicit `classes` array for tests; omit to use the auto-discovered
 * commands barrel (`./commands/index.js`).
 */
export function getRegistry(classes?: CommandClass[]): RegistrySnapshot {
  if (classes) {
    return buildRegistry(classes);
  }
  if (_cached && _cachedKey) {
    return _cached;
  }
  // Lazy require to avoid circular imports at module-load time.
  const allCommands = require("./commands/index.js") as Record<string, unknown>;
  const list = Object.values(allCommands).filter((v): v is CommandClass => typeof v === "function");
  _cachedKey = list;
  _cached = buildRegistry(list);
  return _cached;
}

/** Reset the cached registry (test-only helper). */
export function _resetRegistryCache(): void {
  _cached = null;
  _cachedKey = null;
}
