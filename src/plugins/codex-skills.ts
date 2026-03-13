import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RuntimePlugin } from "../runtime/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("plugins:codex-skills");

const DEFAULT_CODEX_SKILLS_DIR = join(homedir(), ".codex", "skills");
const DEFAULT_MANIFEST_PATH = join(homedir(), ".cache", "ravi", "codex-skills", "manifest.json");

interface CodexSkillsManifest {
  managedSkillDirs: string[];
}

interface SyncCodexSkillsOptions {
  codexSkillsDir?: string;
  manifestPath?: string;
}

export function syncCodexSkills(plugins: RuntimePlugin[], options: SyncCodexSkillsOptions = {}): string[] {
  const codexSkillsDir = options.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;

  mkdirSync(codexSkillsDir, { recursive: true });
  mkdirSync(dirname(manifestPath), { recursive: true });

  const managedSkillDirs = new Set<string>();

  for (const plugin of plugins) {
    if (plugin.type !== "local") {
      continue;
    }

    const pluginPath = plugin.path;
    const skillsDir = join(pluginPath, "skills");
    if (!existsSync(skillsDir)) {
      continue;
    }

    const pluginName = getPluginName(pluginPath);
    const skillEntries = readdirSync(skillsDir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    );

    for (const entry of skillEntries) {
      const sourceDir = join(skillsDir, entry.name);
      const skillFilePath = join(sourceDir, "SKILL.md");
      if (!existsSync(skillFilePath)) {
        continue;
      }

      const sourceSkill = readFileSync(skillFilePath, "utf8");
      const originalSkillName = extractSkillName(sourceSkill) ?? entry.name;
      const managedSkillDirName = buildManagedSkillDirName(pluginName, originalSkillName);
      const targetDir = join(codexSkillsDir, managedSkillDirName);

      copySkillDirectory(sourceDir, targetDir, managedSkillDirName);
      managedSkillDirs.add(managedSkillDirName);
    }
  }

  const previousManifest = readManifest(manifestPath);
  for (const staleSkillDir of previousManifest.managedSkillDirs) {
    if (managedSkillDirs.has(staleSkillDir)) {
      continue;
    }
    rmSync(join(codexSkillsDir, staleSkillDir), { recursive: true, force: true });
  }

  const manifest: CodexSkillsManifest = {
    managedSkillDirs: [...managedSkillDirs].sort(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (manifest.managedSkillDirs.length > 0 && !sameManagedSkillDirs(previousManifest, manifest)) {
    log.info("Codex skills synchronized", {
      count: manifest.managedSkillDirs.length,
      dir: codexSkillsDir,
      names: manifest.managedSkillDirs,
    });
  }

  return manifest.managedSkillDirs;
}

function sameManagedSkillDirs(left: CodexSkillsManifest, right: CodexSkillsManifest): boolean {
  if (left.managedSkillDirs.length !== right.managedSkillDirs.length) {
    return false;
  }

  return left.managedSkillDirs.every((value, index) => value === right.managedSkillDirs[index]);
}

function copySkillDirectory(sourceDir: string, targetDir: string, managedSkillDirName: string): void {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  copyTree(sourceDir, targetDir, managedSkillDirName);
}

function copyTree(sourceDir: string, targetDir: string, managedSkillDirName: string): void {
  const entries = readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyTree(sourcePath, targetPath, managedSkillDirName);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (entry.name === "SKILL.md") {
      const content = readFileSync(sourcePath, "utf8");
      writeFileSync(targetPath, rewriteSkillName(content, managedSkillDirName));
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, statSync(sourcePath).mode);
  }
}

function readManifest(manifestPath: string): CodexSkillsManifest {
  if (!existsSync(manifestPath)) {
    return { managedSkillDirs: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<CodexSkillsManifest>;
    if (Array.isArray(parsed.managedSkillDirs)) {
      return {
        managedSkillDirs: parsed.managedSkillDirs.filter((value): value is string => typeof value === "string"),
      };
    }
  } catch (error) {
    log.warn("Failed to read Codex skills manifest", { manifestPath, error });
  }

  return { managedSkillDirs: [] };
}

function getPluginName(pluginPath: string): string {
  const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    return basename(pluginPath);
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim()) {
      return parsed.name.trim();
    }
  } catch (error) {
    log.warn("Failed to parse plugin manifest while syncing Codex skills", {
      manifestPath,
      error,
    });
  }

  return basename(pluginPath);
}

function buildManagedSkillDirName(pluginName: string, skillName: string): string {
  const pluginSlug = slugify(pluginName);
  const skillSlug = slugify(skillName);
  return `${pluginSlug}-${skillSlug}`;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "skill";
}

function extractSkillName(content: string): string | null {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    return null;
  }

  const match = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(frontmatter);
  return match?.[1]?.trim() || null;
}

function rewriteSkillName(content: string, managedSkillDirName: string): string {
  const frontmatterMatch = /^(---\n)([\s\S]*?)(\n---\n?)/.exec(content);
  if (!frontmatterMatch) {
    return `---\nname: ${managedSkillDirName}\n---\n\n${content}`;
  }

  const [, start, frontmatter, end] = frontmatterMatch;
  const updatedFrontmatter = /^name:\s*.*$/m.test(frontmatter)
    ? frontmatter.replace(/^name:\s*.*$/m, `name: ${managedSkillDirName}`)
    : `name: ${managedSkillDirName}\n${frontmatter}`;

  return `${start}${updatedFrontmatter}${end}${content.slice(frontmatterMatch[0].length)}`;
}

function extractFrontmatter(content: string): string | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  return match?.[1] ?? null;
}

export function listCodexSkillDirs(options: Pick<SyncCodexSkillsOptions, "codexSkillsDir"> = {}): string[] {
  const codexSkillsDir = options.codexSkillsDir ?? DEFAULT_CODEX_SKILLS_DIR;
  if (!existsSync(codexSkillsDir)) {
    return [];
  }

  return readdirSync(codexSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}
