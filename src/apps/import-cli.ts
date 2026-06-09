import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { getRegistry, type CommandRegistryEntry } from "../cli/registry-snapshot.js";
import { normalizeAppId, RAVI_APP_MANIFEST_SCHEMA } from "./service.js";
import { scaffoldApp } from "./scaffold.js";
import type {
  RaviAppImportCliConfidence,
  RaviAppImportCliOperationCandidate,
  RaviAppImportCliOptions,
  RaviAppImportCliResolvedSource,
  RaviAppImportCliResult,
  RaviAppManifest,
  RaviAppOperationDeclaration,
} from "./types.js";

type CliManifestCommand = Record<string, unknown>;

interface CliManifestMetadata {
  name?: string;
  version?: string;
  description?: string;
  command?: string;
  commands?: CliManifestCommand[];
  operations?: CliManifestCommand[];
}

interface ImportedCliMetadata {
  source: RaviAppImportCliResolvedSource;
  confidence: RaviAppImportCliConfidence;
  name?: string;
  description?: string;
  command: string;
  candidates: RaviAppImportCliOperationCandidate[];
  debugCandidates: RaviAppImportCliOperationCandidate[];
  warnings: string[];
  reviewRequired: string[];
}

const MUTATING_VERBS = new Set([
  "add",
  "approve",
  "archive",
  "assign",
  "attach",
  "block",
  "cancel",
  "clear",
  "comment",
  "create",
  "delete",
  "deny",
  "detach",
  "disable",
  "dispatch",
  "done",
  "enable",
  "fail",
  "grant",
  "import",
  "init",
  "link",
  "merge",
  "push",
  "recompute",
  "remove",
  "rename",
  "restart",
  "revoke",
  "run",
  "scaffold",
  "send",
  "set",
  "start",
  "stop",
  "sync",
  "tag",
  "unlink",
  "unarchive",
  "untag",
  "update",
  "upsert",
  "write",
]);

const DESTRUCTIVE_VERBS = new Set(["cancel", "clear", "delete", "deny", "remove", "revoke", "stop"]);
const RESERVED_ROUTER_OPERATION_NAMES = new Set(["help", "show", "check"]);

export function importCliApp(options: RaviAppImportCliOptions): RaviAppImportCliResult {
  const id = normalizeAppId(options.id);
  const sourceCommand = options.command.trim();
  if (!sourceCommand) throw new Error("CLI import requires a non-empty command.");

  const metadata = resolveCliMetadata({
    command: sourceCommand,
    source: options.source ?? "auto",
    cwd: options.cwd,
    env: process.env,
  });
  const appSlug = id.replace(/\//g, "-");
  const operationPrefix = id.replace(/\//g, ".");
  const name = options.name?.trim() || metadata.name || titleFromAppId(id);
  const description = options.description?.trim() || metadata.description || `Operate ${sourceCommand} as a Ravi App.`;
  const skill = options.includeSkill === false ? null : `ravi-system-${appSlug}`;
  const manifest = buildImportedManifest({
    id,
    appSlug,
    operationPrefix,
    name,
    description,
    command: metadata.command,
    candidates: metadata.candidates,
    skill,
    includeUi: options.includeUi !== false,
  });

  const scaffold = scaffoldApp({
    ...options,
    id,
    name,
    description,
    command: metadata.command,
    manifest,
  });

  return {
    ...scaffold,
    sourceCommand,
    source: metadata.source,
    confidence: metadata.confidence,
    operationCandidates: metadata.candidates,
    debugCandidates: metadata.debugCandidates,
    warnings: metadata.warnings,
    reviewRequired: metadata.reviewRequired,
  };
}

function resolveCliMetadata(input: {
  command: string;
  source: "auto" | "manifest" | "registry" | "help";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ImportedCliMetadata {
  if (input.source === "registry") return metadataFromRegistry(input.command);
  if (input.source === "manifest") return metadataFromSelfDescription(input.command, input);
  if (input.source === "help") return metadataFromHelp(input.command);

  const registry = tryResolve(() => metadataFromRegistry(input.command));
  if (registry) return registry;

  const manifest = tryResolve(() => metadataFromSelfDescription(input.command, input));
  if (manifest) return manifest;

  return metadataFromHelp(input.command);
}

function metadataFromRegistry(command: string): ImportedCliMetadata {
  const tokens = splitShellWords(command);
  if (!isRaviExecutable(tokens[0])) {
    throw new Error(`Registry import only supports Ravi CLI commands, got: ${command}`);
  }
  const selectedSegments = tokens.slice(1);
  if (selectedSegments.length === 0) {
    throw new Error("Registry import needs a Ravi command group, e.g. ravi apps.");
  }

  const selectedGroup = selectedSegments.join(".");
  const registry = getRegistry();
  const commands = registry.commands
    .filter((entry) => !entry.cliOnly)
    .filter((entry) => entry.groupPath === selectedGroup || entry.groupPath.startsWith(`${selectedGroup}.`))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));

  if (commands.length === 0) {
    throw new Error(`No registry commands found for ${command}.`);
  }

  const candidates = commands.map((entry) => candidateFromRegistryCommand(selectedSegments, entry));
  const warnings = [
    "Registry import assumes generated operations should use --json; verify each CLI command supports JSON output before agents rely on it.",
  ];
  const reviewRequired = uniqueFlat(candidates.map((candidate) => candidate.reviewRequired));
  return {
    source: "registry",
    confidence: "medium",
    name: titleFromAppId(selectedGroup.replace(/\./g, "-")),
    description: `Imported Ravi CLI group ${selectedGroup}.`,
    command,
    candidates: candidates.filter((candidate) => candidate.json && !candidate.streaming && !candidate.interactive),
    debugCandidates: candidates.filter((candidate) => !candidate.json || candidate.streaming || candidate.interactive),
    warnings,
    reviewRequired,
  };
}

function metadataFromSelfDescription(
  command: string,
  input: { cwd?: string; env?: NodeJS.ProcessEnv },
): ImportedCliMetadata {
  const probe = `${command} manifest --json`;
  const run = spawnSync(probe, {
    cwd: input.cwd ?? process.cwd(),
    env: { ...process.env, ...(input.env ?? {}) },
    shell: true,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (run.status !== 0) {
    const stderr = typeof run.stderr === "string" ? run.stderr.trim() : "";
    throw new Error(`CLI self-description failed for ${probe}${stderr ? `: ${stderr}` : ""}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(run.stdout || "").trim());
  } catch (error) {
    throw new Error(`CLI self-description did not print valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isObject(parsed)) {
    throw new Error("CLI self-description must be a JSON object.");
  }

  const manifest = parsed as CliManifestMetadata;
  const baseCommand = stringField(manifest.command) || command;
  const rawCommands =
    arrayField(manifest.operations).length > 0 ? arrayField(manifest.operations) : arrayField(manifest.commands);
  const candidates = rawCommands.map((item, index) => candidateFromSelfDescription(item, index, baseCommand));
  const debugCandidates = candidates.filter(
    (candidate) => !candidate.json || candidate.streaming || candidate.interactive,
  );
  const appCandidates = candidates.filter(
    (candidate) => candidate.json && !candidate.streaming && !candidate.interactive,
  );
  const warnings: string[] = [];
  if (rawCommands.length === 0) warnings.push("CLI self-description returned no commands or operations.");
  if (debugCandidates.length > 0)
    warnings.push(`${debugCandidates.length} command(s) are not agent/UI-ready and were kept as debug candidates.`);

  return {
    source: "manifest",
    confidence: "high",
    ...(stringField(manifest.name) ? { name: stringField(manifest.name) } : {}),
    ...(stringField(manifest.description) ? { description: stringField(manifest.description) } : {}),
    command: baseCommand,
    candidates: appCandidates,
    debugCandidates,
    warnings,
    reviewRequired: uniqueFlat(candidates.map((candidate) => candidate.reviewRequired)),
  };
}

function metadataFromHelp(command: string): ImportedCliMetadata {
  return {
    source: "help",
    confidence: "low",
    command,
    candidates: [],
    debugCandidates: [],
    warnings: [
      "Help parsing is not implemented in this MVP. Add a safe self-description command such as `manifest --json`.",
    ],
    reviewRequired: ["Add CLI self-description before generating agent/UI-ready operations."],
  };
}

function candidateFromRegistryCommand(
  selectedSegments: string[],
  entry: CommandRegistryEntry,
): RaviAppImportCliOperationCandidate {
  const localSegments = entry.groupSegments.slice(selectedSegments.length);
  localSegments.push(entry.command);
  const localName = avoidReservedOperationName(localSegments.map(slugSegment).join("."));
  const mutating = isLikelyMutating(localName);
  const destructive = isLikelyDestructive(localName);
  const base = ["ravi", ...entry.groupSegments, entry.command].join(" ");
  const command = `${base} {args} --json`;
  const reviewRequired: string[] = [];
  if (mutating) reviewRequired.push("Confirm mutation risk and permission before enabling as an app operation.");
  if (!entry.returns && !entry.binary) reviewRequired.push("Add @Returns or verify JSON output shape for SDK/UI use.");
  if (entry.binary) reviewRequired.push("Binary command needs explicit app/UI handling.");
  return {
    id: localName,
    name: localName,
    command,
    description: entry.description || null,
    json: !entry.binary,
    mutating,
    destructive,
    streaming: false,
    interactive: false,
    confidence: "medium",
    reviewRequired,
  };
}

function candidateFromSelfDescription(
  item: CliManifestCommand,
  index: number,
  baseCommand: string,
): RaviAppImportCliOperationCandidate {
  const declaredName = stringField(item.name) || stringField(item.id) || `operation-${index + 1}`;
  const name = avoidReservedOperationName(slugOperationName(declaredName));
  const command = stringField(item.command) || `${baseCommand} ${declaredName} {args}`;
  const json = boolField(item.json) ?? command.includes("--json");
  const mutating = boolField(item.mutating) ?? boolField(item.write) ?? isLikelyMutating(name);
  const destructive = boolField(item.destructive) ?? isLikelyDestructive(name);
  const streaming = boolField(item.streaming) ?? false;
  const interactive = boolField(item.interactive) ?? false;
  const reviewRequired: string[] = [];
  if (!json) reviewRequired.push("Command does not declare JSON output.");
  if (mutating) reviewRequired.push("Confirm mutation risk and permission before enabling as an app operation.");
  if (destructive) reviewRequired.push("Confirm destructive behavior and require strong permission.");
  if (streaming || interactive)
    reviewRequired.push("Streaming or interactive operations need a stream/tool surface, not CLI single-shot.");
  return {
    id: name,
    name,
    command: json && !command.includes("--json") ? `${command} --json` : command,
    description: stringField(item.description) || null,
    json,
    mutating,
    destructive,
    streaming,
    interactive,
    confidence: "high",
    reviewRequired,
  };
}

function buildImportedManifest(input: {
  id: string;
  appSlug: string;
  operationPrefix: string;
  name: string;
  description: string;
  command: string;
  candidates: RaviAppImportCliOperationCandidate[];
  skill: string | null;
  includeUi: boolean;
}): RaviAppManifest {
  const changeTopic = `ravi.apps.${input.operationPrefix}.changed`;
  const operations: Record<string, RaviAppOperationDeclaration> = {
    [`${input.operationPrefix}.help`]: {
      interface: "builtin",
      handler: "apps.help",
      mutating: false,
    },
    [`${input.operationPrefix}.show`]: {
      interface: "builtin",
      handler: "apps.manifest.show",
      mutating: false,
    },
    [`${input.operationPrefix}.check`]: {
      interface: "builtin",
      handler: "apps.manifest.check",
      mutating: false,
      outputSchema: `schemas/${input.appSlug}-check.v1.json`,
    },
  };
  const mutatingPermissions = new Set<string>();
  for (const candidate of input.candidates) {
    const operationId = `${input.operationPrefix}.${candidate.id}`;
    const operation: RaviAppOperationDeclaration = {
      interface: "cli",
      command: candidate.command,
      mutating: candidate.mutating,
      json: candidate.json,
    };
    if (candidate.description) operation.description = candidate.description;
    if (candidate.mutating) {
      const permission = `${input.appSlug}:write`;
      operation.permission = permission;
      mutatingPermissions.add(permission);
    }
    operations[operationId] = operation;
  }

  const interfaces: Record<string, unknown> = {
    cli: {
      command: input.command,
      json: input.candidates.some((candidate) => candidate.json),
      health: `ravi apps run ${input.id} check --json`,
    },
  };
  if (input.includeUi) {
    interfaces.ui = {
      routes: [
        {
          id: "main",
          path: `/apps/${input.id}`,
          label: input.name,
          icon: "app-window",
          view: "main",
        },
      ],
      views: [
        {
          id: "main",
          type: "dashboard",
          title: input.name,
          density: "compact",
          query: {
            operation: `${input.operationPrefix}.check`,
          },
          refreshOn: [changeTopic],
          actions: input.candidates.slice(0, 6).map((candidate) => ({
            id: candidate.id.replace(/\./g, "-"),
            label: titleFromAppId(candidate.id.replace(/\./g, "-")),
            icon: candidate.mutating ? "play" : "list",
            operation: `${input.operationPrefix}.${candidate.id}`,
            placement: candidate.mutating ? "menu" : "toolbar",
          })),
        },
      ],
    };
  }

  return {
    schema: RAVI_APP_MANIFEST_SCHEMA,
    id: input.id,
    name: input.name,
    version: "0.1.0",
    description: input.description,
    interfaces,
    operations,
    permissions: {
      required: [],
      optional: [],
      mutating: Array.from(mutatingPermissions).sort(),
    },
    storage: { sqlite: [], files: [] },
    artifacts: [],
    events: {
      emits: [
        {
          topic: changeTopic,
          when: "imported CLI app state changes",
          durability: "logged",
          schema: `events/${input.appSlug}-changed.v1.json`,
        },
      ],
      consumes: [],
    },
    skills: input.skill ? [input.skill] : [],
    health: {
      checks: [{ type: "builtin", handler: "apps.manifest.check" }],
    },
    versioning: {
      compatibility: "semver",
      migrations: [],
    },
  };
}

function tryResolve<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function splitShellWords(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function isRaviExecutable(token?: string): boolean {
  if (!token) return false;
  return token === "ravi" || basename(token) === "ravi";
}

function slugOperationName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[.\s:/_]+/)
    .filter(Boolean)
    .map(slugSegment)
    .join(".");
}

function avoidReservedOperationName(name: string): string {
  return RESERVED_ROUTER_OPERATION_NAMES.has(name) ? `cli.${name}` : name;
}

function slugSegment(value: string): string {
  const slug = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return /^[a-z]/.test(slug) ? slug : `op-${slug || "operation"}`;
}

function titleFromAppId(id: string): string {
  return id
    .split(/[./_-]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function isLikelyMutating(name: string): boolean {
  return name.split(/[.\s-]+/).some((part) => MUTATING_VERBS.has(part));
}

function isLikelyDestructive(name: string): boolean {
  return name.split(/[.\s-]+/).some((part) => DESTRUCTIVE_VERBS.has(part));
}

function uniqueFlat(values: string[][]): string[] {
  return Array.from(new Set(values.flat().filter(Boolean))).sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayField(value: unknown): CliManifestCommand[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}
