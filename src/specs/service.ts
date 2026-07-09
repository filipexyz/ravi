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
  SpecVerifyIssue,
  SpecVerifyResult,
  SyncSpecsOptions,
  SyncSpecsResult,
  VerifySpecOptions,
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

function buildSpecFrontmatter(input: { id: string; title: string; kind: SpecKind; canonical?: boolean }): string {
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
  ];
  if (input.canonical) {
    // Canonical lifecycle + traceability frontmatter — resolves F-5/F-7 from
    // audit-ravispec-format. See .ravi/specs/README.md for field semantics.
    lines.push(
      "lifecycle: proposed",
      "implementation_status: none",
      "implemented_by:",
      "implemented_at:",
      "implementation_notes:",
      "open_items:",
      "decision_makers:",
      "consulted:",
      "informed:",
    );
  }
  lines.push("---", "");
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

// Canonical SPEC.md body from audit-ravispec-format (F-1/F-2/F-3/F-6/F-7).
// Section order and the mandatory Acceptance Criteria table mirror
// .ravi/specs/README.md so a freshly created `--full` spec passes
// `ravi specs verify` out of the box (R1 -> CHECKS.md#C1).
function buildCanonicalSpecBody(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Intent",
    "",
    "Why this spec exists and what problem it solves.",
    "",
    "## Context / Decision Drivers",
    "",
    "Forces that pushed toward this decision (optional if covered by WHY.md).",
    "",
    "## Invariants",
    "",
    "- **R1** — This spec MUST define at least one concrete, testable invariant.",
    "",
    "## Boundaries",
    "",
    "Explicitly in-scope vs out-of-scope.",
    "",
    "## Acceptance Criteria",
    "",
    "Every invariant MUST have a row. Without this table the spec MUST NOT be `normative: true`.",
    "",
    "| Invariant | Verification Method | Check Ref | Pass Condition |",
    "|-----------|---------------------|-----------|----------------|",
    "| R1 | Inspection | CHECKS.md#C1 | Replace with an objective, observable pass condition. |",
    "",
    "Verification Method is one of: `Test` | `Demonstration` | `Inspection` | `Analysis`.",
    "",
    "## Adaptation",
    "",
    "No open adaptation decisions. Any decision this spec cannot resolve up-front MUST take",
    "one of these paths (never a bare TBD):",
    "",
    "- (a) become a spike sub-task with its own acceptance criteria before implementation dispatch; or",
    "- (b) declare `resolution_deadline: <date>` + `blocking_for: [Rk, ...]`; or",
    "- (c) be reported back as an explicit update to this spec before `done`.",
    "",
    "## Known Failure Modes",
    "",
    "- Add incidents, regressions, or edge cases this spec should prevent.",
    "",
    "## Governance",
    "",
    "- `decision_makers`: who approves changes to this spec.",
    "- `consulted`: who must be heard before changing it.",
    "- `informed`: who only needs to know after.",
    "",
    "## Changelog",
    "",
    "- Add dated entries for scope/semantic changes (this is not the git log).",
    "",
  ].join("\n");
}

// Canonical WHY.md / CHECKS.md / RUNBOOK.md companions. CHECKS.md defines C1 so the
// canonical SPEC.md Acceptance Criteria row (R1 -> CHECKS.md#C1) has a live target.
function canonicalCompanionTemplate(fileName: (typeof COMPANION_FILES)[number], title: string): string {
  const heading = fileName.replace(".md", "");
  switch (fileName) {
    case "WHY.md":
      return [
        `# ${title} / ${heading}`,
        "",
        "## Rationale",
        "",
        "Why this approach.",
        "",
        "## Alternatives Considered",
        "",
        "Rejected options and why.",
        "",
        "## Consequences",
        "",
        "Trade-offs accepted.",
        "",
      ].join("\n");
    case "RUNBOOK.md":
      return `# ${title} / ${heading}\n\n## Debug Flow\n\nDocument operational steps for diagnosing this area.\n`;
    case "CHECKS.md":
      return [
        `# ${title} / ${heading}`,
        "",
        "## Checks",
        "",
        "### C1 — R1",
        "",
        "- Replace with the validation command, query, or regression scenario for R1.",
        "",
      ].join("\n");
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
  const canonical = input.full === true;
  const frontmatter = buildSpecFrontmatter({ id, title, kind, canonical });
  const body = canonical ? buildCanonicalSpecBody(title) : buildSpecBody(title);
  writeFileSync(path, `${frontmatter}${body}`, "utf8");
  createdFiles.push(path);

  if (input.full) {
    for (const fileName of COMPANION_FILES) {
      const companionPath = join(dir, fileName);
      writeFileSync(companionPath, canonicalCompanionTemplate(fileName, title), "utf8");
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

const VERIFY_METHOD_KEYWORDS = ["test", "demonstration", "inspection", "analysis"] as const;

interface AcRow {
  invariant: string;
  method: string;
  checkRef: string;
}

// Slice a `## Heading` section body out of a Markdown document (until the next
// same-or-higher-level heading). Returns "" when the heading is absent.
function extractSection(body: string, headingPattern: RegExp): string {
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i]!)) break;
    collected.push(lines[i]!);
  }
  return collected.join("\n");
}

function extractInvariantIds(section: string): string[] {
  const ids = new Set<string>();
  for (const match of section.matchAll(/\bR\d+[a-z]?\b/g)) {
    ids.add(match[0]);
  }
  return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function extractCheckIds(checksContent: string): Set<string> {
  const ids = new Set<string>();
  for (const match of checksContent.matchAll(/\bC\d+[a-z]?\b/g)) {
    ids.add(match[0].toUpperCase());
  }
  return ids;
}

function parseAcTable(section: string): AcRow[] {
  const rows: AcRow[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    // Skip the header row and the |---|---| separator.
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    // Split on unescaped pipes only, so a menu cell like
    // "Test \| Demonstration \| Inspection \| Analysis" stays a single cell.
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replace(/\\\|/g, "|").trim());
    const invariantMatch = /\bR\d+[a-z]?\b/.exec(cells[0] ?? "");
    if (!invariantMatch) continue; // header row ("Invariant") or noise
    rows.push({
      invariant: invariantMatch[0],
      method: cells[1] ?? "",
      checkRef: cells[2] ?? "",
    });
  }
  return rows;
}

function methodIsValid(method: string): boolean {
  const lower = method.toLowerCase();
  const hits = VERIFY_METHOD_KEYWORDS.filter((keyword) => lower.includes(keyword));
  return hits.length === 1;
}

function checkRefToken(checkRef: string): string | null {
  const match = /\bC\d+[a-z]?\b/.exec(checkRef);
  return match ? match[0].toUpperCase() : null;
}

// Split the Adaptation section into bullet-item blocks and flag open decisions
// (bare "TBD") that lack a resolution path (deadline+blocking_for or spike).
function findUnresolvedAdaptations(section: string): string[] {
  if (!section.trim()) return [];
  const lines = section.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));

  const unresolved: string[] = [];
  for (const block of blocks) {
    if (!/\bTBD\b/i.test(block)) continue;
    const lower = block.toLowerCase();
    const hasDeadlineContract = lower.includes("resolution_deadline") && lower.includes("blocking_for");
    const hasSpike = lower.includes("spike");
    if (!hasDeadlineContract && !hasSpike) {
      unresolved.push(block.trim().split(/\r?\n/)[0]!.trim());
    }
  }
  return unresolved;
}

export function verifySpec(id: string, options: VerifySpecOptions = {}): SpecVerifyResult {
  const rootPath = getSpecsRoot(options.cwd);
  const spec = getSpec(id, { ...(options.cwd ? { cwd: options.cwd } : {}) });
  const dir = specDir(rootPath, spec.id);

  const specBody = parseSpecFile(readFileSync(spec.path, "utf8"), spec.path).body;
  const checksPath = join(dir, "CHECKS.md");
  const hasChecksFile = existsSync(checksPath);
  const checksContent = hasChecksFile ? readFileSync(checksPath, "utf8") : "";

  const invariants = extractInvariantIds(extractSection(specBody, /^##\s+Invariants\b/i));
  const acRows = parseAcTable(extractSection(specBody, /^##\s+Acceptance Criteria\b/i));
  const checkIds = extractCheckIds(checksContent);
  const unresolvedAdaptations = findUnresolvedAdaptations(extractSection(specBody, /^##\s+Adaptation\b/i));

  const issues: SpecVerifyIssue[] = [];

  // Non-normative specs are exempt from the Acceptance Criteria contract (F-1/F-4).
  if (spec.normative) {
    if (invariants.length > 0 && !hasChecksFile) {
      issues.push({
        code: "missing-checks-file",
        severity: "error",
        message: `Normative spec ${spec.id} declares invariants but has no CHECKS.md.`,
      });
    }

    const acByInvariant = new Map<string, AcRow>();
    for (const row of acRows) acByInvariant.set(row.invariant, row);

    // F-1/F-4: forall Rk in SPEC.Invariants: exists AC row -> exists Ck in CHECKS.
    for (const invariant of invariants) {
      const row = acByInvariant.get(invariant);
      if (!row) {
        issues.push({
          code: "invariant-without-ac",
          severity: "error",
          invariant,
          message: `Invariant ${invariant} has no Acceptance Criteria row (verification method + check ref).`,
        });
      }
    }

    for (const row of acRows) {
      if (!methodIsValid(row.method)) {
        issues.push({
          code: "ac-missing-method",
          severity: "error",
          invariant: row.invariant,
          message: `Invariant ${row.invariant} has no single valid Verification Method (Test|Demonstration|Inspection|Analysis).`,
        });
      }
      const token = checkRefToken(row.checkRef);
      if (!token) {
        issues.push({
          code: "dangling-check-ref",
          severity: "error",
          invariant: row.invariant,
          message: `Invariant ${row.invariant} has no CHECKS.md#Ck reference in its Acceptance Criteria row.`,
        });
      } else if (!checkIds.has(token)) {
        issues.push({
          code: "dangling-check-ref",
          severity: "error",
          invariant: row.invariant,
          message: `Invariant ${row.invariant} references ${token}, which does not exist in CHECKS.md.`,
        });
      }
    }
  }

  // F-2: Adaptation/TBD items must carry a resolution contract (any spec kind).
  for (const item of unresolvedAdaptations) {
    issues.push({
      code: "adaptation-unresolved",
      severity: "error",
      message: `Adaptation item is a bare TBD without resolution_deadline+blocking_for or a spike sub-task: "${item}".`,
    });
  }

  const ok = issues.every((issue) => issue.severity !== "error");
  return {
    id: spec.id,
    normative: spec.normative,
    ok,
    issues,
    summary: {
      invariants: invariants.length,
      acRows: acRows.length,
      checks: checkIds.size,
      adaptationItems: unresolvedAdaptations.length,
    },
  };
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
