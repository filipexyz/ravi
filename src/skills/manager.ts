import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { loadInternalPlugins } from "../plugins/internal-loader.js";

const SKILL_FILE = "SKILL.md";
const DEFAULT_USER_PLUGIN_NAME = "ravi-user-skills";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "__pycache__", "__pypackages__"]);
const SKIP_FILES = new Set([".DS_Store", "metadata.json"]);

export interface SkillSource {
  type: "local" | "git";
  input: string;
  rootPath?: string;
  gitUrl?: string;
  ref?: string;
  subpath?: string;
}

export interface ResolvedSkillSource {
  source: SkillSource;
  rootPath: string;
  cleanup?: () => void;
}

export interface RaviSkill {
  name: string;
  description?: string;
  path: string;
  skillFilePath: string;
  content: string;
  source: string;
  pluginName?: string;
  files?: RaviSkillFile[];
}

export interface InstalledRaviSkill extends RaviSkill {
  installPath: string;
  pluginName: string;
}

export interface RaviSkillFile {
  path: string;
  content: string;
}

export interface InstallSkillsOptions {
  homeDir?: string;
  pluginName?: string;
  overwrite?: boolean;
}

export interface ListInstalledSkillsOptions {
  homeDir?: string;
  includeCodex?: boolean;
}

export function slugifySkillName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 120) || "skill"
  );
}

export function userPluginsDir(homeDir = homedir()): string {
  return join(homeDir, "ravi", "plugins");
}

export function userSkillsPluginDir(homeDir = homedir(), pluginName = DEFAULT_USER_PLUGIN_NAME): string {
  return join(userPluginsDir(homeDir), slugifySkillName(pluginName));
}

export function codexSkillsDir(homeDir = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homeDir, ".codex");
  return join(codexHome, "skills");
}

export function parseSkillSource(input: string): SkillSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Missing skill source.");
  }

  if (isLocalPath(trimmed)) {
    return {
      type: "local",
      input: trimmed,
      rootPath: resolve(trimmed),
    };
  }

  const { base, ref } = splitRef(trimmed);

  const githubTree = parseGithubTreeUrl(base);
  if (githubTree) {
    return {
      type: "git",
      input: trimmed,
      gitUrl: githubTree.gitUrl,
      ref: ref ?? githubTree.ref,
      subpath: githubTree.subpath,
    };
  }

  const githubRepo = parseGithubRepoUrl(base);
  if (githubRepo) {
    return {
      type: "git",
      input: trimmed,
      gitUrl: githubRepo,
      ...(ref ? { ref } : {}),
    };
  }

  const shorthand = parseGithubShorthand(base);
  if (shorthand) {
    return {
      type: "git",
      input: trimmed,
      gitUrl: shorthand.gitUrl,
      ...(ref ? { ref } : {}),
      ...(shorthand.subpath ? { subpath: shorthand.subpath } : {}),
    };
  }

  return {
    type: "git",
    input: trimmed,
    gitUrl: base,
    ...(ref ? { ref } : {}),
  };
}

export function resolveSkillSource(input: string): ResolvedSkillSource {
  const source = parseSkillSource(input);

  if (source.type === "local") {
    const rootPath = source.rootPath;
    if (!rootPath || !existsSync(rootPath)) {
      throw new Error(`Local skill source not found: ${rootPath ?? input}`);
    }
    return { source, rootPath };
  }

  if (!source.gitUrl) {
    throw new Error(`Invalid git skill source: ${input}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "ravi-skills-"));
  const cloneArgs = ["clone", "--depth", "1"];
  if (source.ref) {
    cloneArgs.push("--branch", source.ref);
  }
  cloneArgs.push(source.gitUrl, tempDir);

  const result = spawnSync("git", cloneArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    rmSync(tempDir, { recursive: true, force: true });
    const details = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Failed to clone skill source ${source.gitUrl}: ${details}`);
  }

  return {
    source,
    rootPath: tempDir,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function withResolvedSkillSource<T>(input: string, fn: (resolved: ResolvedSkillSource) => T): T {
  const resolved = resolveSkillSource(input);
  try {
    return fn(resolved);
  } finally {
    resolved.cleanup?.();
  }
}

export function discoverSkills(resolved: ResolvedSkillSource): RaviSkill[] {
  const subpath = resolved.source.subpath;
  if (subpath && !isSubpathSafe(resolved.rootPath, subpath)) {
    throw new Error(`Invalid skill subpath: ${subpath}`);
  }

  const searchPath = subpath ? join(resolved.rootPath, subpath) : resolved.rootPath;
  if (!existsSync(searchPath)) {
    throw new Error(`Skill source path not found: ${searchPath}`);
  }

  const discovered: RaviSkill[] = [];
  const seen = new Set<string>();

  const addSkillDir = (skillDir: string, sourceLabel: string): void => {
    const skill = parseSkillDirectory(skillDir, sourceLabel);
    if (!skill) return;
    const dedupeKey = skill.name.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    discovered.push(skill);
  };

  if (hasSkillFile(searchPath)) {
    addSkillDir(searchPath, resolved.source.input);
    return discovered;
  }

  for (const dir of prioritySkillDirs(searchPath)) {
    for (const skillDir of childSkillDirs(dir)) {
      addSkillDir(skillDir, resolved.source.input);
    }
  }

  if (discovered.length === 0) {
    for (const skillDir of findSkillDirs(searchPath)) {
      addSkillDir(skillDir, resolved.source.input);
    }
  }

  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

export function selectSkills(skills: RaviSkill[], options: { skill?: string; all?: boolean } = {}): RaviSkill[] {
  if (skills.length === 0) {
    throw new Error("No skills found in source.");
  }

  if (options.skill?.trim()) {
    const match = findSkillByName(skills, options.skill);
    if (!match) {
      throw new Error(`Skill not found: ${options.skill}. Available: ${skills.map((skill) => skill.name).join(", ")}`);
    }
    return [match];
  }

  if (options.all) {
    return skills;
  }

  if (skills.length === 1) {
    return skills;
  }

  throw new Error(
    `Source has ${skills.length} skills. Pass --skill <name> or --all. Available: ${skills
      .map((skill) => skill.name)
      .join(", ")}`,
  );
}

export function installSkills(skills: RaviSkill[], options: InstallSkillsOptions = {}): InstalledRaviSkill[] {
  const pluginName = slugifySkillName(options.pluginName ?? DEFAULT_USER_PLUGIN_NAME);
  const pluginDir = userSkillsPluginDir(options.homeDir, pluginName);
  ensureUserSkillPlugin(pluginDir, pluginName);

  return skills.map((skill) => {
    const installName = slugifySkillName(skill.name);
    const installPath = join(pluginDir, "skills", installName);
    const skillsRoot = join(pluginDir, "skills");

    if (!isPathSafe(skillsRoot, installPath)) {
      throw new Error(`Unsafe skill name: ${skill.name}`);
    }

    if (existsSync(installPath) && !options.overwrite) {
      throw new Error(`Skill already installed: ${skill.name}. Pass --overwrite to replace it.`);
    }

    if (skill.files) {
      copySkillFiles(skill.files, installPath, skill.name);
    } else {
      copySkillDirectory(skill.path, installPath, skill.name);
    }

    return {
      ...parseSkillDirectory(installPath, "installed")!,
      installPath,
      pluginName,
    };
  });
}

export function listInstalledSkills(options: ListInstalledSkillsOptions = {}): RaviSkill[] {
  const skills: RaviSkill[] = [];

  for (const skill of listUserPluginSkills(options.homeDir)) {
    skills.push(skill);
  }

  if (options.includeCodex) {
    for (const skill of listCodexSkills(options.homeDir)) {
      skills.push(skill);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

export function findInstalledSkill(name: string, options: ListInstalledSkillsOptions = {}): RaviSkill | null {
  return findSkillByName(listInstalledSkills({ includeCodex: true, ...options }), name);
}

export function findSkillByName(skills: RaviSkill[], name: string): RaviSkill | null {
  const wanted = name.trim().toLowerCase();
  const wantedSlug = slugifySkillName(name);
  return (
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) => slugifySkillName(skill.name) === wantedSlug) ??
    skills.find((skill) => managedSkillAlias(skill)?.toLowerCase() === wanted) ??
    skills.find((skill) => slugifySkillName(managedSkillAlias(skill) ?? "") === wantedSlug) ??
    skills.find((skill) => basename(skill.path).toLowerCase() === wanted) ??
    null
  );
}

function managedSkillAlias(skill: Pick<RaviSkill, "name" | "pluginName">): string | null {
  if (!skill.pluginName) {
    return null;
  }
  const pluginSlug = codexManagedSlug(skill.pluginName);
  const skillSlug = codexManagedSlug(skill.name);
  return pluginSlug && skillSlug ? `${pluginSlug}-${skillSlug}` : null;
}

function codexManagedSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureUserSkillPlugin(pluginDir: string, pluginName: string): void {
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          name: pluginName,
          version: "1.0.0",
          description: "User-installed Ravi skills",
        },
        null,
        2,
      ),
    );
  }
  mkdirSync(join(pluginDir, "skills"), { recursive: true });
}

function listUserPluginSkills(homeDir = homedir()): RaviSkill[] {
  const pluginsDir = userPluginsDir(homeDir);
  if (!existsSync(pluginsDir)) return [];

  const skills: RaviSkill[] = [];
  for (const pluginEntry of safeReadDirs(pluginsDir)) {
    const pluginDir = join(pluginsDir, pluginEntry.name);
    const skillsDir = join(pluginDir, "skills");
    if (!existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) continue;
    for (const skillDir of childSkillDirs(skillsDir)) {
      const skill = parseSkillDirectory(skillDir, `plugin:${pluginEntry.name}`);
      if (skill) {
        skill.pluginName = pluginEntry.name;
        skills.push(skill);
      }
    }
  }
  return skills;
}

function listCodexSkills(homeDir = homedir()): RaviSkill[] {
  const dir = codexSkillsDir(homeDir);
  if (!existsSync(dir)) return [];
  return childSkillDirs(dir)
    .map((skillDir) => parseSkillDirectory(skillDir, "codex"))
    .filter((skill): skill is RaviSkill => Boolean(skill));
}

export function listCatalogSkills(): RaviSkill[] {
  const skills: RaviSkill[] = [];
  for (const plugin of loadInternalPlugins()) {
    for (const file of plugin.files) {
      const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
      if (!match) continue;
      const skillRoot = `skills/${match[1]}/`;
      const skill = parseSkillContent(file.content, `catalog:${plugin.name}/${match[1]}`, file.path);
      if (skill) {
        skill.pluginName = plugin.name;
        skill.files = plugin.files
          .filter((pluginFile) => pluginFile.path.startsWith(skillRoot))
          .map((pluginFile) => ({
            path: pluginFile.path.slice(skillRoot.length),
            content: pluginFile.content,
          }));
        skills.push(skill);
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

function parseSkillDirectory(skillDir: string, source: string): RaviSkill | null {
  const skillFilePath = join(skillDir, SKILL_FILE);
  if (!existsSync(skillFilePath)) return null;
  const content = readFileSync(skillFilePath, "utf8");
  return parseSkillContent(content, source, skillFilePath, skillDir);
}

function parseSkillContent(
  content: string,
  source: string,
  skillFilePath: string,
  skillDir = dirname(skillFilePath),
): RaviSkill {
  const frontmatter = extractFrontmatter(content);
  const name = frontmatterValue(frontmatter, "name") ?? basename(skillDir);
  const description = frontmatterDescription(frontmatter);
  return {
    name: name.trim(),
    ...(description ? { description } : {}),
    path: skillDir,
    skillFilePath,
    content,
    source,
  };
}

function extractFrontmatter(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  return match?.[1] ?? null;
}

function frontmatterValue(frontmatter: string | null, key: string): string | null {
  if (!frontmatter) return null;
  const match = new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m").exec(frontmatter);
  return match?.[1]?.trim() ?? null;
}

function frontmatterDescription(frontmatter: string | null): string | undefined {
  if (!frontmatter) return undefined;
  const simple = frontmatterValue(frontmatter, "description");
  if (simple && simple !== "|" && simple !== ">") return simple;

  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => /^description:\s*[>|]\s*$/.test(line));
  if (start === -1) return undefined;

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+/.test(line)) break;
    collected.push(line.replace(/^\s{2,}/, ""));
  }
  const value = collected.join("\n").trim();
  return value || undefined;
}

function copySkillDirectory(sourceDir: string, targetDir: string, skillName: string): void {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (isExcludedEntry(entry.name, entry.isDirectory())) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copySkillDirectory(sourcePath, targetPath, skillName);
      continue;
    }

    if (!entry.isFile()) continue;
    mkdirSync(dirname(targetPath), { recursive: true });

    if (entry.name === SKILL_FILE) {
      writeFileSync(targetPath, ensureSkillFrontmatterName(readFileSync(sourcePath, "utf8"), skillName));
    } else {
      copyFileSync(sourcePath, targetPath);
      chmodSync(targetPath, statSync(sourcePath).mode);
    }
  }
}

function copySkillFiles(files: RaviSkillFile[], targetDir: string, skillName: string): void {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  for (const file of files) {
    const targetPath = join(targetDir, file.path);
    if (!isPathSafe(targetDir, targetPath) || isExcludedRelativePath(file.path)) {
      throw new Error(`Unsafe skill file path: ${file.path}`);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    if (file.path === SKILL_FILE) {
      writeFileSync(targetPath, ensureSkillFrontmatterName(file.content, skillName));
    } else {
      writeFileSync(targetPath, file.content);
    }
  }
}

function ensureSkillFrontmatterName(content: string, skillName: string): string {
  const cleanName = skillName.trim() || "skill";
  const frontmatterMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(content);
  if (!frontmatterMatch) {
    return `---\nname: ${cleanName}\n---\n\n${content}`;
  }

  const [, start, frontmatter, end] = frontmatterMatch;
  const updatedFrontmatter = /^name:\s*.*$/m.test(frontmatter) ? frontmatter : `name: ${cleanName}\n${frontmatter}`;
  return `${start}${updatedFrontmatter}${end}${content.slice(frontmatterMatch[0].length)}`;
}

function prioritySkillDirs(searchPath: string): string[] {
  return [
    searchPath,
    join(searchPath, "skills"),
    join(searchPath, "skills/.curated"),
    join(searchPath, "skills/.experimental"),
    join(searchPath, "skills/.system"),
    join(searchPath, ".agents/skills"),
    join(searchPath, ".codex/skills"),
  ];
}

function childSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return safeReadDirs(dir)
    .map((entry) => join(dir, entry.name))
    .filter(hasSkillFile);
}

function findSkillDirs(dir: string, depth = 0, maxDepth = 5): string[] {
  if (depth > maxDepth || !existsSync(dir)) return [];
  const current = hasSkillFile(dir) ? [dir] : [];
  const children = safeReadDirs(dir)
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .flatMap((entry) => findSkillDirs(join(dir, entry.name), depth + 1, maxDepth));
  return [...current, ...children];
}

function safeReadDirs(dir: string): Array<{ name: string; isDirectory(): boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );
  } catch {
    return [];
  }
}

function hasSkillFile(dir: string): boolean {
  return existsSync(join(dir, SKILL_FILE));
}

function isExcludedEntry(name: string, isDirectory: boolean): boolean {
  if (SKIP_FILES.has(name)) return true;
  if (isDirectory && SKIP_DIRS.has(name)) return true;
  return false;
}

function isExcludedRelativePath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((segment, index, all) =>
      index === all.length - 1 ? SKIP_FILES.has(segment) : SKIP_DIRS.has(segment) || segment === "..",
    );
}

function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input) ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input === "." ||
    input === ".." ||
    /^[a-zA-Z]:[/\\]/.test(input)
  );
}

function splitRef(input: string): { base: string; ref?: string } {
  const hashIndex = input.indexOf("#");
  if (hashIndex === -1) return { base: input };
  const base = input.slice(0, hashIndex);
  const ref = input.slice(hashIndex + 1).trim();
  return {
    base,
    ...(ref ? { ref: decodeURIComponent(ref) } : {}),
  };
}

function parseGithubTreeUrl(input: string): { gitUrl: string; ref?: string; subpath?: string } | null {
  try {
    const url = new URL(input);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "tree") return null;
    const [owner, repo, , ref, ...subpathParts] = parts;
    return {
      gitUrl: `https://github.com/${owner}/${repo?.replace(/\.git$/, "")}.git`,
      ...(ref ? { ref } : {}),
      ...(subpathParts.length > 0 ? { subpath: sanitizeSubpath(subpathParts.join("/")) } : {}),
    };
  } catch {
    return null;
  }
}

function parseGithubRepoUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`;
  } catch {
    return null;
  }
}

function parseGithubShorthand(input: string): { gitUrl: string; subpath?: string } | null {
  if (input.includes(":") || input.startsWith(".") || input.startsWith("/")) return null;
  const match = /^([^/]+)\/([^/]+)(?:\/(.+))?$/.exec(input);
  if (!match) return null;
  const [, owner, repo, subpath] = match;
  return {
    gitUrl: `https://github.com/${owner}/${repo}.git`,
    ...(subpath ? { subpath: sanitizeSubpath(subpath) } : {}),
  };
}

function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new Error(`Unsafe skill subpath: ${subpath}`);
    }
  }
  return normalized;
}

function isSubpathSafe(basePath: string, subpath: string): boolean {
  return isPathSafe(basePath, join(basePath, subpath));
}

function isPathSafe(basePath: string, targetPath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(targetPath));
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + sep);
}
