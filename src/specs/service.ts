import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { replaceSpecsIndex } from "./spec-db.js";
import {
  captureNativeSpecsTree,
  createNativeSpec,
  NativeSpecsSafetyError,
  type NativeSpecsEntry,
  type NativeSpecsSnapshot,
} from "./native-safe-fs.js";
import type {
  AppliedSpecCreation,
  ApplyPreparedSpecCreationOptions,
  GetSpecContextOptions,
  GetSpecOptions,
  ListSpecsOptions,
  NewSpecInput,
  NewSpecResult,
  PreparedSpecCreation,
  PreparedSpecFile,
  SpecCreationInspection,
  SpecChainEntry,
  SpecContext,
  SpecContextFile,
  SpecContextMode,
  SpecKind,
  SpecRecord,
  SpecRequirement,
  SpecStatus,
  SyncSpecsOptions,
  SyncSpecsResult,
} from "./types.js";

const SPEC_FILE = "SPEC.md";
const COMPANION_FILES = ["WHY.md", "RUNBOOK.md", "CHECKS.md"] as const;
const ALL_CONTEXT_FILES = [SPEC_FILE, ...COMPANION_FILES] as const;
const SPEC_ID_SEGMENT_PATTERN = /^[a-z][a-z0-9._-]*$/;
const VALID_SPEC_KINDS = new Set<SpecKind>(["domain", "capability", "feature"]);
const VALID_SPEC_STATUSES = new Set<SpecStatus>(["draft", "active", "deprecated", "archived"]);
const VALID_CONTEXT_MODES = new Set<SpecContextMode>(["rules", "full", "checks", "why", "runbook"]);
const REQUIREMENT_PATTERN = /\b(MUST NOT|SHOULD NOT|MUST|SHOULD|MAY)\b\s+(.+)/g;

type FrontmatterValue = string | string[] | boolean;

interface ParsedSpecFile {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
}

export interface CapturedSpecsTree {
  cwd: string;
  rootPath: string;
  workspaceIdentity: string;
  rootBinding: string;
  rootExists: boolean;
  entries: NativeSpecsEntry[];
}

export class UnsafeSpecsTreeError extends Error {
  constructor(readonly unsafePath: string) {
    super(`Unsafe symbolic link or non-regular entry in specs tree: ${unsafePath}`);
    this.name = "UnsafeSpecsTreeError";
  }
}

function translateNativeSafetyError(error: unknown): never {
  if (error instanceof NativeSpecsSafetyError) {
    throw new UnsafeSpecsTreeError(error.unsafePath || ".ravi/specs");
  }
  throw error;
}

function normalizeText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

export function getSpecsRoot(cwd = process.cwd()): string {
  return resolve(cwd, ".ravi", "specs");
}

export function normalizeSpecId(value: string): string {
  const normalized = normalizeText(value, "Spec id").toLowerCase();
  const parts = normalized.split("/");
  if (parts.length < 1 || parts.length > 3) {
    throw new Error(
      `Invalid spec id: ${value}. Use <domain>, <domain>/<capability>, or <domain>/<capability>/<feature>.`,
    );
  }
  for (const part of parts) {
    if (!SPEC_ID_SEGMENT_PATTERN.test(part)) {
      throw new Error(
        `Invalid spec id segment: ${part}. Use lowercase letters, numbers, dots, underscores, or hyphens.`,
      );
    }
  }
  return parts.join("/");
}

export function normalizeSpecKind(value: string): SpecKind {
  const normalized = value.trim().toLowerCase() as SpecKind;
  if (!VALID_SPEC_KINDS.has(normalized)) {
    throw new Error(`Invalid spec kind: ${value}. Use domain|capability|feature.`);
  }
  return normalized;
}

export function normalizeSpecContextMode(value?: string): SpecContextMode {
  const normalized = (value?.trim().toLowerCase() || "rules") as SpecContextMode;
  if (!VALID_CONTEXT_MODES.has(normalized)) {
    throw new Error(`Invalid spec context mode: ${value}. Use rules|full|checks|why|runbook.`);
  }
  return normalized;
}

function expectedKindForId(id: string): SpecKind {
  const depth = id.split("/").length;
  if (depth === 1) return "domain";
  if (depth === 2) return "capability";
  return "feature";
}

function specDir(rootPath: string, id: string): string {
  return join(rootPath, ...id.split("/"));
}

function specFilePath(rootPath: string, id: string): string {
  return join(specDir(rootPath, id), SPEC_FILE);
}

function relativeSpecPath(rootPath: string, path: string): string {
  return relative(rootPath, path);
}

function chainIdsForSpec(id: string): string[] {
  const parts = normalizeSpecId(id).split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function scalarToString(value: FrontmatterValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required in spec frontmatter.`);
  }
  return value.trim();
}

function scalarToBoolean(value: FrontmatterValue | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  throw new Error("normative must be a boolean in spec frontmatter.");
}

function valueToArray(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function parseInlineValue(rawValue: string): FrontmatterValue {
  const value = rawValue.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return value.replace(/^["']|["']$/g, "");
}

function parseFrontmatterBlock(block: string, path: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  let activeArrayKey: string | null = null;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const arrayMatch = /^\s*-\s+(.+)$/.exec(line);
    if (arrayMatch && activeArrayKey) {
      const current = result[activeArrayKey];
      if (!Array.isArray(current)) {
        throw new Error(`Invalid array state for ${activeArrayKey} in ${path}.`);
      }
      current.push(arrayMatch[1]!.trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    const fieldMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!fieldMatch) {
      throw new Error(`Invalid frontmatter line in ${path}: ${line}`);
    }

    const key = fieldMatch[1]!;
    const rawValue = fieldMatch[2] ?? "";
    if (!rawValue.trim()) {
      result[key] = [];
      activeArrayKey = key;
      continue;
    }

    result[key] = parseInlineValue(rawValue);
    activeArrayKey = null;
  }

  return result;
}

function parseSpecFile(content: string, path: string): ParsedSpecFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    throw new Error(`Spec file missing YAML frontmatter: ${path}`);
  }
  const frontmatter = parseFrontmatterBlock(match[1]!, path);
  const body = content.slice(match[0].length);
  return { frontmatter, body };
}

function absoluteEntryPath(rootPath: string, relativePath: string): string {
  return join(rootPath, ...relativePath.split("/"));
}

function entryMap(snapshot: CapturedSpecsTree): Map<string, NativeSpecsEntry> {
  return new Map(snapshot.entries.map((entry) => [entry.relativePath, entry]));
}

export function captureSpecsTree(cwd?: string, onEntry?: (relativePath: string) => void): CapturedSpecsTree {
  const canonical = canonicalWorkspace(cwd);
  try {
    const native: NativeSpecsSnapshot = captureNativeSpecsTree(canonical, onEntry);
    return {
      cwd: canonical,
      rootPath: getSpecsRoot(canonical),
      workspaceIdentity: native.workspaceIdentity,
      rootBinding: native.rootBinding,
      rootExists: native.rootExists,
      entries: native.entries,
    };
  } catch (error) {
    return translateNativeSafetyError(error);
  }
}

function recordFromSpecEntry(snapshot: CapturedSpecsTree, entry: NativeSpecsEntry): SpecRecord {
  if (entry.kind !== "file" || entry.content === undefined) {
    throw new UnsafeSpecsTreeError(absoluteEntryPath(snapshot.rootPath, entry.relativePath));
  }
  const normalizedPath = absoluteEntryPath(snapshot.rootPath, entry.relativePath);
  const specDirPath = dirname(normalizedPath);
  const pathId = normalizeSpecId(
    relative(snapshot.rootPath, specDirPath)
      .split(/[\\/]+/)
      .join("/"),
  );
  const { frontmatter } = parseSpecFile(entry.content, normalizedPath);
  const id = normalizeSpecId(scalarToString(frontmatter.id, "id"));
  if (id !== pathId) {
    throw new Error(`Spec id mismatch in ${normalizedPath}: frontmatter id ${id} must match path ${pathId}.`);
  }

  const kind = normalizeSpecKind(scalarToString(frontmatter.kind, "kind"));
  const expectedKind = expectedKindForId(id);
  if (kind !== expectedKind) {
    throw new Error(`Spec kind mismatch for ${id}: expected ${expectedKind}, got ${kind}.`);
  }

  const parts = id.split("/");
  const domain = scalarToString(frontmatter.domain, "domain");
  if (domain !== parts[0]) {
    throw new Error(`Spec domain mismatch for ${id}: expected ${parts[0]}, got ${domain}.`);
  }

  const status = (typeof frontmatter.status === "string" ? frontmatter.status : "active") as SpecStatus;
  if (!VALID_SPEC_STATUSES.has(status)) {
    throw new Error(`Invalid spec status for ${id}: ${status}. Use draft|active|deprecated|archived.`);
  }

  return {
    rootPath: snapshot.rootPath,
    id,
    path: normalizedPath,
    relativePath: relativeSpecPath(snapshot.rootPath, normalizedPath),
    kind,
    domain,
    ...(parts[1] ? { capability: parts[1] } : {}),
    ...(parts[2] ? { feature: parts[2] } : {}),
    title: scalarToString(frontmatter.title, "title"),
    capabilities: valueToArray(frontmatter.capabilities),
    tags: valueToArray(frontmatter.tags),
    appliesTo: valueToArray(frontmatter.applies_to),
    owners: valueToArray(frontmatter.owners),
    status,
    normative: scalarToBoolean(frontmatter.normative, true),
    mtime: Math.floor(entry.mtimeMs),
    updatedAt: Date.now(),
  };
}

export function assertSafeSpecsTree(rootPath: string): void {
  const normalizedRoot = resolve(rootPath);
  const cwd = dirname(dirname(normalizedRoot));
  if (getSpecsRoot(cwd) !== normalizedRoot) {
    throw new UnsafeSpecsTreeError(normalizedRoot);
  }
  captureSpecsTree(cwd);
}

export function listSpecs(options: ListSpecsOptions = {}): SpecRecord[] {
  const snapshot = captureSpecsTree(options.cwd);
  return listSpecsFromCapturedTree(snapshot, options);
}

export function listSpecsFromCapturedTree(
  snapshot: CapturedSpecsTree,
  options: Omit<ListSpecsOptions, "cwd"> = {},
): SpecRecord[] {
  return snapshot.entries
    .filter(
      (entry) =>
        entry.kind === "file" &&
        entry.relativePath.split("/").length <= 4 &&
        entry.relativePath.endsWith(`/${SPEC_FILE}`),
    )
    .map((entry) => recordFromSpecEntry(snapshot, entry))
    .filter((spec) => {
      if (options.domain && spec.domain !== normalizeSpecId(options.domain)) return false;
      if (options.kind && spec.kind !== options.kind) return false;
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getSpec(id: string, options: GetSpecOptions = {}): SpecRecord {
  const snapshot = captureSpecsTree(options.cwd);
  const normalizedId = normalizeSpecId(id);
  const entry = entryMap(snapshot).get(`${normalizedId}/${SPEC_FILE}`);
  if (!entry || entry.kind !== "file") throw new Error(`Spec not found: ${normalizedId}`);
  return recordFromSpecEntry(snapshot, entry);
}

function chainEntryForId(snapshot: CapturedSpecsTree, id: string): SpecChainEntry {
  const path = specFilePath(snapshot.rootPath, id);
  const kind = expectedKindForId(id);
  const entry = entryMap(snapshot).get(`${id}/${SPEC_FILE}`);
  if (!entry || entry.kind !== "file") {
    return {
      id,
      kind,
      path,
      relativePath: relativeSpecPath(snapshot.rootPath, path),
      exists: false,
    };
  }
  return {
    id,
    kind,
    path,
    relativePath: relativeSpecPath(snapshot.rootPath, path),
    exists: true,
    spec: recordFromSpecEntry(snapshot, entry),
  };
}

function filesForMode(mode: SpecContextMode): Array<(typeof ALL_CONTEXT_FILES)[number]> {
  switch (mode) {
    case "rules":
      return [SPEC_FILE];
    case "full":
      return [...ALL_CONTEXT_FILES];
    case "checks":
      return ["CHECKS.md"];
    case "why":
      return ["WHY.md"];
    case "runbook":
      return ["RUNBOOK.md"];
  }
}

function readContextFile(
  snapshot: CapturedSpecsTree,
  entry: SpecChainEntry,
  fileName: SpecContextFile["fileName"],
): SpecContextFile {
  const path = join(specDir(snapshot.rootPath, entry.id), fileName);
  const nativeEntry = entryMap(snapshot).get(`${entry.id}/${fileName}`);
  const exists = nativeEntry?.kind === "file";
  return {
    specId: entry.id,
    kind: entry.kind,
    fileName,
    path,
    relativePath: relativeSpecPath(snapshot.rootPath, path),
    exists,
    ...(exists ? { content: nativeEntry!.content! } : {}),
  };
}

function extractRequirements(files: SpecContextFile[]): SpecRequirement[] {
  const requirements: SpecRequirement[] = [];
  for (const file of files) {
    if (!file.content) continue;
    for (const line of file.content.split(/\r?\n/)) {
      REQUIREMENT_PATTERN.lastIndex = 0;
      const match = REQUIREMENT_PATTERN.exec(line);
      if (!match) continue;
      requirements.push({
        level: match[1] as SpecRequirement["level"],
        text: match[2]!.replace(/\s+$/, ""),
        source: file.specId,
        fileName: file.fileName,
      });
    }
  }
  return requirements;
}

function renderSpecContext(files: SpecContextFile[]): string {
  const readableFiles = files.filter((file) => file.exists && file.content);
  if (readableFiles.length === 0) return "";
  return readableFiles
    .map((file) =>
      [`<!-- ${file.relativePath} -->`, `# ${file.specId} / ${file.fileName}`, "", file.content!.trim()].join("\n"),
    )
    .join("\n\n---\n\n");
}

export function getSpecContext(id: string, options: GetSpecContextOptions = {}): SpecContext {
  const snapshot = captureSpecsTree(options.cwd);
  const normalizedId = normalizeSpecId(id);
  const mode = options.mode ?? "rules";
  const chain = chainIdsForSpec(normalizedId).map((chainId) => chainEntryForId(snapshot, chainId));
  const target = chain.at(-1);
  if (!target?.exists) {
    throw new Error(`Spec not found: ${normalizedId}`);
  }

  const fileNames = filesForMode(mode);
  const files = chain.flatMap((entry) => fileNames.map((fileName) => readContextFile(snapshot, entry, fileName)));
  const existingFiles = files.filter((file) => file.exists);
  return {
    id: normalizedId,
    mode,
    rootPath: snapshot.rootPath,
    chain,
    files,
    requirements: extractRequirements(existingFiles),
    content: renderSpecContext(existingFiles),
  };
}

function yamlScalar(value: string | boolean): string {
  if (typeof value === "boolean") return String(value);
  if (/^[a-z0-9._/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string[] {
  if (values.length === 0) return [];
  return values.map((value) => `  - ${yamlScalar(value)}`);
}

function buildSpecFrontmatter(input: { id: string; title: string; kind: SpecKind }): string {
  const parts = input.id.split("/");
  const capabilities = parts[1] ? [parts[1]] : [];
  const lines = [
    "---",
    `id: ${yamlScalar(input.id)}`,
    `title: ${yamlScalar(input.title)}`,
    `kind: ${input.kind}`,
    `domain: ${parts[0]}`,
    "capabilities:",
    ...yamlArray(capabilities),
    "tags:",
    "applies_to:",
    "owners:",
    "status: active",
    "normative: true",
    "---",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function buildSpecBody(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Intent",
    "",
    "Describe what this spec protects and why it matters.",
    "",
    "## Invariants",
    "",
    "- This spec MUST define at least one concrete invariant.",
    "",
    "## Validation",
    "",
    "- Add commands or checks that validate this behavior.",
    "",
    "## Known Failure Modes",
    "",
    "- Add incidents, regressions, or edge cases this spec should prevent.",
    "",
  ].join("\n");
}

function companionTemplate(fileName: (typeof COMPANION_FILES)[number], title: string): string {
  const heading = fileName.replace(".md", "");
  switch (fileName) {
    case "WHY.md":
      return `# ${title} / ${heading}\n\n## Rationale\n\nDocument decisions, tradeoffs, and rejected alternatives.\n`;
    case "RUNBOOK.md":
      return `# ${title} / ${heading}\n\n## Debug Flow\n\nDocument operational steps for diagnosing this area.\n`;
    case "CHECKS.md":
      return `# ${title} / ${heading}\n\n## Checks\n\n- Add validation commands, queries, or regression scenarios.\n`;
  }
}

function canonicalWorkspace(cwd?: string): string {
  const absolute = resolve(cwd ?? process.cwd());
  if (!existsSync(absolute)) {
    throw new Error(`Workspace not found: ${absolute}`);
  }
  return realpathSync(absolute);
}

function relativeInside(rootPath: string, targetPath: string): string {
  const candidate = relative(rootPath, targetPath);
  if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
    return candidate;
  }
  throw new Error(`Unsafe spec path outside workspace: ${targetPath}`);
}

export function prepareSpecCreation(input: NewSpecInput): PreparedSpecCreation {
  const snapshot = captureSpecsTree(input.cwd);
  const cwd = snapshot.cwd;
  const rootPath = snapshot.rootPath;
  const id = normalizeSpecId(input.id);
  const kind = normalizeSpecKind(input.kind);
  const expectedKind = expectedKindForId(id);
  if (kind !== expectedKind) {
    throw new Error(`Spec kind mismatch for ${id}: expected ${expectedKind}, got ${kind}.`);
  }

  const title = normalizeText(input.title, "Spec title");
  const directoryPath = specDir(rootPath, id);

  const requestedFiles: PreparedSpecFile["fileName"][] =
    input.full === true ? [SPEC_FILE, ...COMPANION_FILES] : [SPEC_FILE];
  const files = requestedFiles.map((fileName) => {
    const path = join(directoryPath, fileName);
    const content =
      fileName === SPEC_FILE
        ? `${buildSpecFrontmatter({ id, title, kind })}${buildSpecBody(title)}`
        : companionTemplate(fileName, title);
    return {
      fileName,
      path,
      relativePath: relativeSpecPath(rootPath, path),
      content,
    };
  });
  const ancestors = chainIdsForSpec(id)
    .slice(0, -1)
    .map((chainId) => chainEntryForId(snapshot, chainId));

  return {
    cwd,
    rootPath,
    id,
    title,
    kind,
    full: input.full === true,
    directoryPath,
    files,
    ancestors,
    missingAncestors: ancestors.filter((entry) => !entry.exists),
    securityBinding: {
      workspaceIdentity: snapshot.workspaceIdentity,
      rootBinding: snapshot.rootBinding,
    },
  };
}

export function inspectPreparedSpecCreation(prepared: PreparedSpecCreation): SpecCreationInspection {
  const snapshot = captureSpecsTree(prepared.cwd);
  if (
    snapshot.workspaceIdentity !== prepared.securityBinding.workspaceIdentity ||
    snapshot.rootBinding !== prepared.securityBinding.rootBinding
  ) {
    throw new UnsafeSpecsTreeError(prepared.rootPath);
  }
  const entries = entryMap(snapshot);
  const targetNode = entries.get(prepared.id);
  const targetDirectoryExists = targetNode !== undefined;
  const targetSpec = entries.get(`${prepared.id}/${SPEC_FILE}`);
  const targetSpecExists = targetSpec?.kind === "file";
  const matchingFiles: string[] = [];
  const missingFiles: string[] = [];
  const divergentFiles: string[] = [];

  for (const file of prepared.files) {
    const entry = entries.get(`${prepared.id}/${file.fileName}`);
    if (!entry) {
      missingFiles.push(file.path);
      continue;
    }
    if (entry.kind !== "file" || entry.content !== file.content) {
      divergentFiles.push(file.path);
      continue;
    }
    matchingFiles.push(file.path);
  }

  const expectedNames = new Set(prepared.files.map((file) => file.fileName));
  const targetPrefix = `${prepared.id}/`;
  const unexpectedFiles = targetDirectoryExists
    ? snapshot.entries
        .filter((entry) => {
          if (!entry.relativePath.startsWith(targetPrefix)) return false;
          const remainder = entry.relativePath.slice(targetPrefix.length);
          return !remainder.includes("/") && !expectedNames.has(remainder as (typeof ALL_CONTEXT_FILES)[number]);
        })
        .map((entry) => absoluteEntryPath(snapshot.rootPath, entry.relativePath))
    : [];

  return {
    targetDirectoryExists,
    targetSpecExists,
    exactMatch:
      targetSpecExists && missingFiles.length === 0 && divergentFiles.length === 0 && unexpectedFiles.length === 0,
    matchingFiles,
    missingFiles,
    divergentFiles,
    unexpectedFiles,
  };
}

function assertCurrentPreparedAncestors(prepared: PreparedSpecCreation): void {
  const snapshot = captureSpecsTree(prepared.cwd);
  const missing = prepared.ancestors
    .map((entry) => chainEntryForId(snapshot, entry.id))
    .filter((entry) => !entry.exists);
  if (missing.length > 0) {
    throw new Error(`Missing ancestor specs for ${prepared.id}: ${missing.map((entry) => entry.id).join(", ")}`);
  }
}

export function applyPreparedSpecCreation(
  prepared: PreparedSpecCreation,
  options: ApplyPreparedSpecCreationOptions,
): AppliedSpecCreation {
  if (options.requireAncestors) {
    assertCurrentPreparedAncestors(prepared);
  }
  const stagingName = `.${basename(prepared.directoryPath)}.ravi-stage-${randomUUID()}`;
  const stagingPath = join(dirname(prepared.directoryPath), stagingName);
  const originalRecoveryPath = `${stagingPath}.original`;
  let result: ReturnType<typeof createNativeSpec>;
  let callbackError: unknown;
  try {
    result = createNativeSpec({
      workspacePath: prepared.cwd,
      expectedWorkspaceIdentity: prepared.securityBinding.workspaceIdentity,
      expectedRootBinding: prepared.securityBinding.rootBinding,
      targetSegments: prepared.id.split("/"),
      files: prepared.files.map((file) => ({ name: file.fileName, content: file.content })),
      requireAncestors: options.requireAncestors,
      existing: options.existing,
      existingDirectory: options.existingDirectory ?? "error",
      stagingName,
      stagingPath,
      originalRecoveryPath,
      ...(options.beforePromote
        ? {
            beforePromote: (path: string) => {
              try {
                options.beforePromote!(path);
                return true;
              } catch (error) {
                callbackError = error;
                return false;
              }
            },
          }
        : {}),
      ...(options.beforeNativePromote
        ? {
            beforeNativePromote: (path: string, recoveryPath: string) => {
              try {
                options.beforeNativePromote!(path, recoveryPath);
                return true;
              } catch (error) {
                callbackError = error;
                return false;
              }
            },
          }
        : {}),
    });
  } catch (error) {
    if (callbackError !== undefined) throw callbackError;
    if (error instanceof NativeSpecsSafetyError) {
      if (error.code === "SPEC_ALREADY_EXISTS") throw new Error(`Spec already exists: ${prepared.id}`);
      if (error.code === "SPEC_ANCESTORS_MISSING") {
        throw new Error(`Missing ancestor specs for ${prepared.id}`);
      }
      throw new UnsafeSpecsTreeError(error.unsafePath || prepared.rootPath);
    }
    throw error;
  }

  const targetSnapshot: CapturedSpecsTree = {
    cwd: prepared.cwd,
    rootPath: prepared.rootPath,
    workspaceIdentity: prepared.securityBinding.workspaceIdentity,
    rootBinding: prepared.securityBinding.rootBinding,
    rootExists: true,
    entries: result.entries.map((entry) => ({ ...entry, relativePath: `${prepared.id}/${entry.relativePath}` })),
  };
  const specEntry = entryMap(targetSnapshot).get(`${prepared.id}/${SPEC_FILE}`);
  if (!specEntry) throw new UnsafeSpecsTreeError(prepared.directoryPath);

  return {
    spec: recordFromSpecEntry(targetSnapshot, specEntry),
    createdFiles: result.status === "created" ? prepared.files.map((file) => file.path) : [],
    missingAncestors: prepared.missingAncestors,
    changed: result.status === "created",
    status: result.status,
  };
}

export function createSpec(input: NewSpecInput): NewSpecResult {
  const result = applyPreparedSpecCreation(prepareSpecCreation(input), {
    requireAncestors: false,
    existing: "error",
    existingDirectory: "populate",
  });
  return {
    spec: result.spec,
    createdFiles: result.createdFiles,
    missingAncestors: result.missingAncestors,
  };
}

export function syncSpecsSnapshot(specs: SpecRecord[], options: SyncSpecsOptions = {}): SyncSpecsResult {
  const rootPath = getSpecsRoot(options.cwd);
  assertSafeSpecsTree(rootPath);
  for (const spec of specs) {
    if (spec.rootPath !== rootPath || relativeInside(rootPath, spec.path).startsWith("..")) {
      throw new Error(`Spec snapshot is not bound to root: ${spec.id}`);
    }
  }
  const changed = replaceSpecsIndex(rootPath, specs);
  return {
    rootPath,
    total: specs.length,
    specs,
    changed,
  };
}

export function syncSpecs(options: SyncSpecsOptions = {}): SyncSpecsResult {
  return syncSpecsSnapshot(listSpecs(options), options);
}

export function specExists(id: string, options: GetSpecOptions = {}): boolean {
  try {
    getSpec(id, options);
    return true;
  } catch {
    return false;
  }
}
