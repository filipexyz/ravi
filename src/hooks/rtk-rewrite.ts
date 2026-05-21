import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HookCallbackMatcher } from "../bash/hook.js";
import { publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RTK_RULES } from "./rtk-rewrite.defaults.js";
import type { RtkRule, RtkRewriteConfig } from "./rtk-rewrite.types.js";

const log = logger.child("hooks:rtk-rewrite");

function findRtkBinary(): string | null {
  try {
    const result = execSync("which rtk", { encoding: "utf-8", timeout: 3000 }).trim();
    return result || null;
  } catch {
    try {
      const result = execSync("command -v rtk", { encoding: "utf-8", timeout: 3000 }).trim();
      return result || null;
    } catch {
      return null;
    }
  }
}

interface TomlRuleRaw {
  id?: string;
  match?: string;
  rewrite?: string;
}

interface TomlConfig {
  disabled?: string[];
  rule?: TomlRuleRaw[];
}

function parseTomlConfig(content: string): TomlConfig {
  const result: TomlConfig = {};
  const lines = content.split("\n");

  let currentRule: TomlRuleRaw | null = null;
  const rules: TomlRuleRaw[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[[rule]]") {
      if (currentRule) rules.push(currentRule);
      currentRule = {};
      continue;
    }

    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch;
    const value = rawValue.trim();

    if (key === "disabled") {
      const arrMatch = value.match(/^\[(.*)]\s*$/);
      if (arrMatch) {
        result.disabled = arrMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
      continue;
    }

    if (currentRule) {
      const strValue = value.replace(/^["']|["']$/g, "");
      if (key === "id") currentRule.id = strValue;
      else if (key === "match") currentRule.match = strValue;
      else if (key === "rewrite") currentRule.rewrite = strValue;
    }
  }

  if (currentRule) rules.push(currentRule);
  if (rules.length > 0) result.rule = rules;

  return result;
}

export function loadRtkRewriteConfig(): RtkRewriteConfig {
  const rtkBinaryPath = findRtkBinary();

  if (!rtkBinaryPath) {
    log.info("rtk binary not found in PATH, hook will be a no-op");
    return { rules: [], rtkBinaryPath: null };
  }

  let disabledIds: Set<string> = new Set();
  const userRules: RtkRule[] = [];

  try {
    const configPath = join(homedir(), ".ravi", "rtk-rewrite.toml");
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseTomlConfig(content);

    if (parsed.disabled) {
      disabledIds = new Set(parsed.disabled);
    }

    if (parsed.rule) {
      for (const raw of parsed.rule) {
        if (!raw.id || !raw.match || !raw.rewrite) {
          log.warn("Skipping incomplete TOML rule", { rule: raw });
          continue;
        }
        try {
          userRules.push({
            id: raw.id,
            match: new RegExp(raw.match),
            rewrite: raw.rewrite,
          });
        } catch (err) {
          log.warn("Invalid regex in user TOML rule, skipping", { id: raw.id, match: raw.match, err });
        }
      }
    }
  } catch {
    // No config file or read error — use defaults only
  }

  const defaultRules = DEFAULT_RTK_RULES.filter((r) => !disabledIds.has(r.id));
  const rules = [...defaultRules, ...userRules];

  log.info("RTK rewrite config loaded", {
    rtkBinaryPath,
    defaultRules: defaultRules.length,
    userRules: userRules.length,
    disabled: [...disabledIds],
  });

  return { rules, rtkBinaryPath };
}

export function createRtkRewriteHook(): HookCallbackMatcher {
  const config = loadRtkRewriteConfig();

  return {
    matcher: "Bash",
    hooks: [
      async (input, _toolUseId, _context) => {
        if (!config.rtkBinaryPath || config.rules.length === 0) return {};

        const command = (input.tool_input as { command?: string })?.command;
        if (!command) return {};

        if (command.startsWith("rtk ") || command.startsWith("rtk:")) return {};

        for (const rule of config.rules) {
          if (rule.match.test(command)) {
            const rewritten = command.replace(rule.match, rule.rewrite);

            publish("ravi.rtk.rewrite", {
              agentId: ((input as unknown as Record<string, unknown>).agentId as string | undefined) ?? "unknown",
              original: command,
              rewritten,
              ruleId: rule.id,
            }).catch(() => {});

            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                updatedInput: {
                  ...(input.tool_input as Record<string, unknown>),
                  command: rewritten,
                },
              },
            };
          }
        }

        return {};
      },
    ],
  };
}
