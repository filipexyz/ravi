import { constants } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import type { PromptContextSection } from "../prompt-builder.js";

const RAVI_RULES_SEGMENTS = [".ravi", "rules"] as const;
const RAVI_RULES_SECTION_PRIORITY = 30;
const SUPPORTED_RULE_EXTENSIONS = new Set(["", ".md", ".markdown", ".txt"]);
const IMPORTED_RULES_SEGMENT = "imported";

export interface RaviRuleFile {
  path: string;
  relativePath: string;
  content: string;
}

export type RaviRulesImportProvider = "claude" | "agents";
export type RaviRulesImportScope = "project" | "user";
export type RaviRulesImportProviderFilter = RaviRulesImportProvider | "all";

export interface RaviRulesImportSource {
  provider: RaviRulesImportProvider;
  scope: RaviRulesImportScope;
  path: string;
  exists: boolean;
}

export interface RaviRulesImportCandidate {
  provider: RaviRulesImportProvider;
  scope: RaviRulesImportScope;
  sourcePath: string;
  sourceRelativePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  content: string;
  action: "create" | "overwrite" | "skip_exists";
}

export interface RaviRulesImportOptions {
  cwd: string;
  provider?: RaviRulesImportProviderFilter;
  includeUser?: boolean;
  write?: boolean;
  force?: boolean;
  /**
   * Called for every file about to be written, all of them before the first
   * write; throwing refuses the whole import. The CLI checks the caller's
   * file-write boundary here (rules are loaded as authoritative instructions).
   */
  authorizeWrite?: (path: string) => void;
}

export interface RaviRulesImportResult {
  cwd: string;
  rulesDir: string;
  write: boolean;
  force: boolean;
  includeUser: boolean;
  sources: RaviRulesImportSource[];
  candidates: RaviRulesImportCandidate[];
  counts: {
    sources: number;
    existingSources: number;
    candidates: number;
    created: number;
    overwritten: number;
    skippedExisting: number;
    missingSources: number;
  };
}

export function getRaviRulesDir(cwd: string): string {
  return join(cwd, ...RAVI_RULES_SEGMENTS);
}

export async function loadRaviRuleFiles(cwd: string): Promise<RaviRuleFile[]> {
  const rulesDir = getRaviRulesDir(cwd);
  // The workspace belongs to the agent: a `.ravi` or `.ravi/rules` symlink must
  // not make the daemon read files from outside it into the prompt.
  if (!(await isRealPathInside(rulesDir, cwd))) return [];
  return loadRaviRuleFilesFromDir(rulesDir);
}

/**
 * True when `path` exists and its real path (all symlinks resolved) stays
 * inside the real path of `root`. A missing path is not inside.
 */
async function isRealPathInside(path: string, root: string): Promise<boolean> {
  let realPath: string;
  let realRoot: string;
  try {
    [realPath, realRoot] = await Promise.all([realpath(path), realpath(root)]);
  } catch (error) {
    // no-cause: a path that cannot be resolved (missing, dangling link, no access) is treated as outside; nothing is reported.
    void error;
    return false;
  }
  const rel = relative(realRoot, realPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function loadRaviRuleFilesFromDir(rulesDir: string): Promise<RaviRuleFile[]> {
  const rulesDirStat = await statIfExists(rulesDir);
  if (!rulesDirStat?.isDirectory()) {
    return [];
  }

  const paths = await collectRuleFilePaths(rulesDir, rulesDir);
  const files: RaviRuleFile[] = [];
  for (const path of paths) {
    const rawContent = await readFile(path);
    if (isBinaryContent(rawContent)) {
      continue;
    }

    const content = normalizeRuleContent(rawContent.toString("utf8"));
    if (!content) {
      continue;
    }

    files.push({
      path,
      relativePath: relative(rulesDir, path),
      content,
    });
  }

  return files;
}

export async function listRaviRulesImportSources(options: {
  cwd: string;
  provider?: RaviRulesImportProviderFilter;
  includeUser?: boolean;
}): Promise<RaviRulesImportSource[]> {
  const providers = resolveImportProviders(options.provider ?? "all");
  const sources: RaviRulesImportSource[] = [];

  for (const provider of providers) {
    sources.push(await buildImportSource(provider, "project", getProjectImportSourcePath(options.cwd, provider)));
    if (options.includeUser) {
      sources.push(await buildImportSource(provider, "user", getUserImportSourcePath(provider)));
    }
  }

  return sources;
}

export async function importRaviRules(options: RaviRulesImportOptions): Promise<RaviRulesImportResult> {
  const write = options.write === true;
  const force = options.force === true;
  const includeUser = options.includeUser === true;
  const rulesDir = getRaviRulesDir(options.cwd);
  const sources = await listRaviRulesImportSources({
    cwd: options.cwd,
    provider: options.provider,
    includeUser,
  });
  const candidates: RaviRulesImportCandidate[] = [];

  for (const source of sources) {
    if (!source.exists) continue;

    const files = await loadRaviRuleFilesFromDir(source.path);
    for (const file of files) {
      const destinationRelativePath = join(IMPORTED_RULES_SEGMENT, source.provider, source.scope, file.relativePath);
      const destinationPath = join(rulesDir, destinationRelativePath);
      const destinationExists = Boolean(await statIfExists(destinationPath));
      const action = destinationExists ? (force ? "overwrite" : "skip_exists") : "create";

      candidates.push({
        provider: source.provider,
        scope: source.scope,
        sourcePath: file.path,
        sourceRelativePath: file.relativePath,
        destinationPath,
        destinationRelativePath,
        content: file.content,
        action,
      });
    }
  }

  if (write) {
    const toWrite = candidates.filter((candidate) => candidate.action !== "skip_exists");
    for (const candidate of toWrite) options.authorizeWrite?.(candidate.destinationPath);
    for (const candidate of toWrite) {
      // A symlinked directory under the rules dir must not redirect the write
      // (or the directories created for it) outside the workspace.
      const destinationDir = dirname(candidate.destinationPath);
      if (!(await isRealPathInside(await nearestExistingPath(destinationDir), options.cwd))) {
        throw new Error(`Refusing to write ${candidate.destinationRelativePath}: it resolves outside the workspace`);
      }
      await mkdir(destinationDir, { recursive: true });
      await writeFile(candidate.destinationPath, `${candidate.content}\n`, {
        encoding: "utf8",
        flag: noFollowWriteFlag(),
      });
    }
  }

  return {
    cwd: options.cwd,
    rulesDir,
    write,
    force,
    includeUser,
    sources,
    candidates,
    counts: {
      sources: sources.length,
      existingSources: sources.filter((source) => source.exists).length,
      candidates: candidates.length,
      created: candidates.filter((candidate) => candidate.action === "create").length,
      overwritten: candidates.filter((candidate) => candidate.action === "overwrite").length,
      skippedExisting: candidates.filter((candidate) => candidate.action === "skip_exists").length,
      missingSources: sources.filter((source) => !source.exists).length,
    },
  };
}

export async function buildRaviRulesPromptSection(cwd: string): Promise<PromptContextSection | null> {
  const rulesDir = getRaviRulesDir(cwd);
  const files = await loadRaviRuleFiles(cwd);
  if (files.length === 0) {
    return null;
  }

  return {
    id: "ravi.rules",
    title: "Ravi Rules",
    priority: RAVI_RULES_SECTION_PRIORITY,
    source: rulesDir,
    content: formatRaviRulesPromptContent(cwd, rulesDir, files),
  };
}

function formatRaviRulesPromptContent(cwd: string, rulesDir: string, files: RaviRuleFile[]): string {
  const lines = [
    `Ravi rules loaded from ${rulesDir}. Treat them as authoritative runtime rules for this session.`,
    `Resolve relative file references from ${cwd}/.`,
  ];

  for (const file of files) {
    lines.push("", `### ${file.relativePath}`, "", file.content);
  }

  return lines.join("\n");
}

async function collectRuleFilePaths(dir: string, root: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries.sort((left, right) => comparePathText(left.name, right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectRuleFilePaths(path, root)));
      continue;
    }

    if (entry.isFile() && isSupportedRuleFile(path)) {
      paths.push(path);
    }
  }

  return paths.sort((left, right) => comparePathText(relative(root, left), relative(root, right)));
}

function isSupportedRuleFile(path: string): boolean {
  return SUPPORTED_RULE_EXTENSIONS.has(extname(path).toLowerCase());
}

function normalizeRuleContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function isBinaryContent(content: Buffer): boolean {
  return content.includes(0);
}

function comparePathText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resolveImportProviders(provider: RaviRulesImportProviderFilter): RaviRulesImportProvider[] {
  if (provider === "all") return ["agents", "claude"];
  return [provider];
}

async function buildImportSource(
  provider: RaviRulesImportProvider,
  scope: RaviRulesImportScope,
  path: string,
): Promise<RaviRulesImportSource> {
  const sourceStat = await statIfExists(path);
  return {
    provider,
    scope,
    path,
    exists: Boolean(sourceStat?.isDirectory()),
  };
}

function getProjectImportSourcePath(cwd: string, provider: RaviRulesImportProvider): string {
  return join(cwd, `.${provider}`, "rules");
}

function getUserImportSourcePath(provider: RaviRulesImportProvider): string {
  return join(getRulesUserHome(), `.${provider}`, "rules");
}

function getRulesUserHome(): string {
  return process.env.RAVI_RULES_USER_HOME?.trim() || homedir();
}

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** The path itself, or its closest ancestor that exists. */
async function nearestExistingPath(path: string): Promise<string> {
  let current = path;
  while (!(await statIfExists(current))) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** `w` without following a symlink at the final path component. */
function noFollowWriteFlag(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
}
