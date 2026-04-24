import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { replaceSpecsIndex } from "./spec-db.js";
import type {
  GetSpecContextOptions,
  GetSpecOptions,
  ListSpecsOptions,
  NewSpecInput,
  NewSpecResult,
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

function recordFromSpecFile(rootPath: string, path: string): SpecRecord {
  const normalizedPath = resolve(path);
  const specDirPath = dirname(normalizedPath);
  const pathId = normalizeSpecId(
    relative(rootPath, specDirPath)
      .split(/[\\/]+/)
      .join("/"),
  );
  const stat = statSync(normalizedPath);
  const { frontmatter } = parseSpecFile(readFileSync(normalizedPath, "utf8"), normalizedPath);
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
    rootPath,
    id,
    path: normalizedPath,
    relativePath: relativeSpecPath(rootPath, normalizedPath),
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
    mtime: Math.floor(stat.mtimeMs),
    updatedAt: Date.now(),
  };
}

function findSpecFiles(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];
  const found: string[] = [];

  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
      } else if (entry.isFile() && entry.name === SPEC_FILE) {
        found.push(path);
      }
    }
  };

  visit(rootPath, 0);
  return found.sort();
}

export function listSpecs(options: ListSpecsOptions = {}): SpecRecord[] {
  const rootPath = getSpecsRoot(options.cwd);
  return findSpecFiles(rootPath)
    .map((path) => recordFromSpecFile(rootPath, path))
    .filter((spec) => {
      if (options.domain && spec.domain !== normalizeSpecId(options.domain)) return false;
      if (options.kind && spec.kind !== options.kind) return false;
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getSpec(id: string, options: GetSpecOptions = {}): SpecRecord {
  const rootPath = getSpecsRoot(options.cwd);
  const normalizedId = normalizeSpecId(id);
  const path = specFilePath(rootPath, normalizedId);
  if (!existsSync(path)) {
    throw new Error(`Spec not found: ${normalizedId}`);
  }
  return recordFromSpecFile(rootPath, path);
}

function chainEntryForId(rootPath: string, id: string): SpecChainEntry {
  const path = specFilePath(rootPath, id);
  const kind = expectedKindForId(id);
  if (!existsSync(path)) {
    return {
      id,
      kind,
      path,
      relativePath: relativeSpecPath(rootPath, path),
      exists: false,
    };
  }
  return {
    id,
    kind,
    path,
    relativePath: relativeSpecPath(rootPath, path),
    exists: true,
    spec: recordFromSpecFile(rootPath, path),
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
  rootPath: string,
  entry: SpecChainEntry,
  fileName: SpecContextFile["fileName"],
): SpecContextFile {
  const path = join(specDir(rootPath, entry.id), fileName);
  const exists = existsSync(path);
  return {
    specId: entry.id,
    kind: entry.kind,
    fileName,
    path,
    relativePath: relativeSpecPath(rootPath, path),
    exists,
    ...(exists ? { content: readFileSync(path, "utf8") } : {}),
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
  const rootPath = getSpecsRoot(options.cwd);
  const normalizedId = normalizeSpecId(id);
  const mode = options.mode ?? "rules";
  const chain = chainIdsForSpec(normalizedId).map((chainId) => chainEntryForId(rootPath, chainId));
  const target = chain.at(-1);
  if (!target?.exists) {
    throw new Error(`Spec not found: ${normalizedId}`);
  }

  const fileNames = filesForMode(mode);
  const files = chain.flatMap((entry) => fileNames.map((fileName) => readContextFile(rootPath, entry, fileName)));
  const existingFiles = files.filter((file) => file.exists);
  return {
    id: normalizedId,
    mode,
    rootPath,
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

export function createSpec(input: NewSpecInput): NewSpecResult {
  const rootPath = getSpecsRoot(input.cwd);
  const id = normalizeSpecId(input.id);
  const kind = normalizeSpecKind(input.kind);
  const expectedKind = expectedKindForId(id);
  if (kind !== expectedKind) {
    throw new Error(`Spec kind mismatch for ${id}: expected ${expectedKind}, got ${kind}.`);
  }

  const title = normalizeText(input.title, "Spec title");
  const dir = specDir(rootPath, id);
  const path = join(dir, SPEC_FILE);
  if (existsSync(path)) {
    throw new Error(`Spec already exists: ${id}`);
  }

  mkdirSync(dir, { recursive: true });
  const createdFiles: string[] = [];
  writeFileSync(path, `${buildSpecFrontmatter({ id, title, kind })}${buildSpecBody(title)}`, "utf8");
  createdFiles.push(path);

  if (input.full) {
    for (const fileName of COMPANION_FILES) {
      const companionPath = join(dir, fileName);
      writeFileSync(companionPath, companionTemplate(fileName, title), "utf8");
      createdFiles.push(companionPath);
    }
  }

  const spec = getSpec(id, { cwd: input.cwd });
  const missingAncestors = chainIdsForSpec(id)
    .slice(0, -1)
    .map((chainId) => chainEntryForId(rootPath, chainId))
    .filter((entry) => !entry.exists);

  return { spec, createdFiles, missingAncestors };
}

export function syncSpecs(options: SyncSpecsOptions = {}): SyncSpecsResult {
  const rootPath = getSpecsRoot(options.cwd);
  const specs = listSpecs(options);
  replaceSpecsIndex(rootPath, specs);
  return {
    rootPath,
    total: specs.length,
    specs,
  };
}

export function specExists(id: string, options: GetSpecOptions = {}): boolean {
  try {
    getSpec(id, options);
    return true;
  } catch {
    return false;
  }
}
