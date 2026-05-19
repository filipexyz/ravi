import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { TagRuleSchema, type TagRule } from "./types.js";

export interface LoadedTagRule {
  rule: TagRule;
  source: string;
}

export interface LoadTagRulesResult {
  rules: LoadedTagRule[];
  errors: Array<{ source: string; error: string }>;
}

const RULE_FILE_PATTERN = /\.(json)$/i;

function resolveRulesDir(directory?: string): string {
  if (directory) return resolve(directory);
  const stateDir = getRaviStateDir();
  return join(stateDir, "tag-rules");
}

export function listTagRuleFiles(directory?: string): string[] {
  const dir = resolveRulesDir(directory);
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((entry) => RULE_FILE_PATTERN.test(entry))
    .map((entry) => join(dir, entry))
    .sort();
}

export function loadTagRulesFromDirectory(directory?: string): LoadTagRulesResult {
  const files = listTagRuleFiles(directory);
  const rules: LoadedTagRule[] = [];
  const errors: Array<{ source: string; error: string }> = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({ source: file, error: `Invalid JSON: ${(error as Error).message}` });
      continue;
    }
    const validation = TagRuleSchema.safeParse(parsed);
    if (!validation.success) {
      errors.push({ source: file, error: validation.error.issues.map((issue) => issue.message).join("; ") });
      continue;
    }
    const rule = validation.data;
    if (seenIds.has(rule.id)) {
      errors.push({ source: file, error: `Duplicate rule id: ${rule.id}` });
      continue;
    }
    seenIds.add(rule.id);
    rules.push({ rule, source: file });
  }
  rules.sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;
    return a.rule.id.localeCompare(b.rule.id);
  });
  return { rules, errors };
}

export function parseTagRuleFromString(content: string, source = "<inline>"): TagRule {
  const parsed = JSON.parse(content);
  return TagRuleSchema.parse(parsed);
}
