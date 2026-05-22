import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { PromptContextSection } from "../prompt-builder.js";

const RAVI_RULES_SEGMENTS = [".ravi", "rules"] as const;
const RAVI_RULES_SECTION_PRIORITY = 30;
const SUPPORTED_RULE_EXTENSIONS = new Set(["", ".md", ".markdown", ".txt"]);

export interface RaviRuleFile {
  path: string;
  relativePath: string;
  content: string;
}

export function getRaviRulesDir(cwd: string): string {
  return join(cwd, ...RAVI_RULES_SEGMENTS);
}

export async function loadRaviRuleFiles(cwd: string): Promise<RaviRuleFile[]> {
  const rulesDir = getRaviRulesDir(cwd);
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

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
