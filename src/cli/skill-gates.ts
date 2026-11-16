import { parse as parseShell } from "shell-quote";

export interface SkillGateMetadata {
  skill: string;
  source: "inferred" | "config";
  ruleId?: string;
}

export interface SkillGateRuleConfig {
  id?: string;
  skill?: string | null;
  disabled?: boolean;
  remove?: boolean;
  pattern?: string;
  groupRegex?: string;
  tool?: string;
  toolPrefix?: string;
  toolRegex?: string;
  command?: string;
  commandPrefix?: string;
  commandRegex?: string;
}

export interface ResolveCommandSkillGateInput {
  groupPath: string;
  command: string;
  method?: string;
}

interface RaviGroupSkillRule {
  id: string;
  pattern: RegExp;
  skill: string;
}

export interface DefaultSkillGateRule {
  id: string;
  pattern: string;
  skill: string;
}

interface EffectiveGroupSkillRule extends RaviGroupSkillRule {
  source: SkillGateMetadata["source"];
}

type ConfiguredGateResolution = SkillGateMetadata | false | undefined;

export const DEFAULT_RAVI_GROUP_SKILL_RULES: readonly RaviGroupSkillRule[] = [
  { id: "agents", pattern: /^agents(?:[._]|$)/, skill: "ravi-system-agents-manager" },
  { id: "apps", pattern: /^apps(?:[._]|$)/, skill: "ravi-system-apps" },
  { id: "artifacts", pattern: /^artifacts(?:[._]|$)/, skill: "ravi-system-artifacts" },
  { id: "audio", pattern: /^audio(?:[._]|$)/, skill: "ravi-system-audio" },
  { id: "bases", pattern: /^bases(?:[._]|$)/, skill: "ravi-system-bases" },
  { id: "contacts", pattern: /^contacts(?:[._]|$)/, skill: "ravi-system-contacts-manager" },
  { id: "context", pattern: /^context(?:[._]|$)/, skill: "ravi-dev-context-cli" },
  { id: "commands", pattern: /^commands(?:[._]|$)/, skill: "ravi-system-commands" },
  { id: "cron", pattern: /^cron(?:[._]|$)/, skill: "ravi-system-cron-manager" },
  { id: "daemon", pattern: /^daemon(?:[._]|$)/, skill: "ravi-system-daemon-manager" },
  { id: "eval", pattern: /^eval(?:[._]|$)/, skill: "ravi-system-tasks-eval" },
  { id: "events", pattern: /^events(?:[._]|$)/, skill: "ravi-system-events" },
  { id: "heartbeat", pattern: /^heartbeat(?:[._]|$)/, skill: "ravi-system-heartbeat-manager" },
  { id: "image", pattern: /^image(?:[._]|$)/, skill: "ravi-system-image" },
  { id: "knowledge", pattern: /^knowledge(?:[._]|$)/, skill: "ravi-system-knowledge" },
  { id: "routes", pattern: /^(?:routes|instances[._]routes)(?:[._]|$)/, skill: "ravi-system-routes-manager" },
  { id: "instances", pattern: /^instances(?:[._]|$)/, skill: "ravi-system-instances-manager" },
  { id: "meetings", pattern: /^meetings(?:[._]|$)/, skill: "ravi-system-meetings" },
  { id: "observers", pattern: /^observers(?:[._]|$)/, skill: "ravi-system-observers" },
  { id: "pages", pattern: /^pages(?:[._]|$)/, skill: "ravi-system-pages" },
  { id: "permissions", pattern: /^permissions(?:[._]|$)/, skill: "ravi-system-permissions-manager" },
  { id: "prox-calls", pattern: /^prox[._]calls(?:[._]|$)/, skill: "ravi-system-prox-calls" },
  { id: "sessions", pattern: /^sessions(?:[._]|$)/, skill: "ravi-system-sessions" },
  { id: "settings", pattern: /^settings(?:[._]|$)/, skill: "ravi-system-settings-manager" },
  { id: "skill-gates", pattern: /^skill[-._]?gates(?:[-._]|$)/, skill: "ravi-system-skill-gates" },
  { id: "skills", pattern: /^skills(?:[._]|$)/, skill: "ravi-system-skill-creator" },
  { id: "slack", pattern: /^slack(?:[._]|$)/, skill: "ravi-system-slack" },
  { id: "specs", pattern: /^specs(?:[._]|$)/, skill: "ravi-system-specs" },
  { id: "stickers", pattern: /^stickers(?:[._]|$)/, skill: "ravi-system-stickers" },
  { id: "decisions", pattern: /^decisions(?:[._]|$)/, skill: "ravi-system-decisions" },
  { id: "tasks", pattern: /^tasks(?:[._]|$)/, skill: "ravi-system-tasks" },
  { id: "themes", pattern: /^themes(?:[._]|$)/, skill: "ravi-system-pages" },
  { id: "triggers", pattern: /^triggers(?:[._]|$)/, skill: "ravi-system-trigger-manager" },
  { id: "video", pattern: /^video(?:[._]|$)/, skill: "ravi-system-video" },
  { id: "widgets", pattern: /^widgets(?:[._]|$)/, skill: "ravi-system-pages" },
  { id: "whatsapp", pattern: /^whatsapp(?:[._]|$)/, skill: "ravi-system-whatsapp-manager" },
];

const RAVI_GATE_EXEMPT_COMMANDS = new Set([
  "skills.list",
  "skills.show",
  "skills.sync",
  "tools.list",
  "tools.show",
  "tools.manifest",
  "tools.schema",
  "context.codex-bash-hook",
  "context.codex-tool-hook",
  "context.visibility",
  "sessions.visibility",
]);

export function listDefaultSkillGateRules(): DefaultSkillGateRule[] {
  return DEFAULT_RAVI_GROUP_SKILL_RULES.map((rule) => ({
    id: rule.id,
    pattern: rule.pattern.source,
    skill: rule.skill,
  }));
}

export function isDefaultSkillGateRuleId(id: string): boolean {
  return DEFAULT_RAVI_GROUP_SKILL_RULES.some((rule) => rule.id === id);
}

export interface GroupSkillRuleView {
  id: string;
  pattern: RegExp;
  skill: string;
}

export function listGroupSkillRules(): readonly GroupSkillRuleView[] {
  return DEFAULT_RAVI_GROUP_SKILL_RULES.map((rule) => ({ id: rule.id, pattern: rule.pattern, skill: rule.skill }));
}

export function resolveCommandSkillGate(
  input: ResolveCommandSkillGateInput,
  options?: { rules?: readonly SkillGateRuleConfig[] },
): SkillGateMetadata | undefined {
  const fullName = `${input.groupPath}.${input.command}`;
  if (RAVI_GATE_EXEMPT_COMMANDS.has(fullName)) {
    return undefined;
  }

  const configured = resolveConfiguredGroupTargetGate(input.groupPath, options?.rules ?? []);
  if (configured !== undefined) {
    return configured === false ? undefined : configured;
  }

  return inferRaviGroupSkillGate(input.groupPath, { rules: options?.rules });
}

export function resolveRuntimeToolSkillGate(
  input: { toolName: string },
  options?: { rules?: readonly SkillGateRuleConfig[] },
): SkillGateMetadata | undefined {
  if (isExemptRaviToolName(input.toolName)) {
    return undefined;
  }

  const configured = resolveConfiguredToolGate(input.toolName, options?.rules ?? []);
  if (configured !== undefined) {
    return configured === false ? undefined : configured;
  }

  return inferRaviToolSkillGate(input.toolName, { rules: options?.rules });
}

export function inferRaviToolSkillGate(
  toolName: string,
  options?: { rules?: readonly SkillGateRuleConfig[] },
): SkillGateMetadata | undefined {
  if (isExemptRaviToolName(toolName)) {
    return undefined;
  }
  return inferRaviGroupSkillGate(toolName, { rules: options?.rules });
}

export function inferRaviCommandSkillGate(
  commandLine: string,
  options?: { executables?: readonly string[]; rules?: readonly SkillGateRuleConfig[] },
): SkillGateMetadata | undefined {
  const commands = discoverShellCommands(commandLine);
  const executables = commands.map((words) => words[0]!.split("/").at(-1)!);
  const configured = resolveConfiguredCommandGate(commandLine, {
    ...options,
    executables,
  });
  if (configured !== undefined) {
    return configured === false ? undefined : configured;
  }

  // Executable hints may omit substitutions. Discover command positions rather
  // than scanning literal arguments when a hint is incomplete.
  for (const words of commands) {
    if (words[0]?.split("/").at(-1) !== "ravi") continue;
    const first = normalizeCliSegment(words[1]);
    const second = normalizeCliSegment(words[2]);
    if (second && RAVI_GATE_EXEMPT_COMMANDS.has(`${first}.${second}`)) continue;
    const candidates = second ? [`${first}.${second}`, first] : [first];
    for (const groupPath of candidates) {
      const configuredGroup = resolveConfiguredGroupTargetGate(groupPath, options?.rules ?? []);
      if (configuredGroup === false) break;
      if (configuredGroup !== undefined) return configuredGroup;
      const inferred = inferRaviGroupSkillGate(groupPath, { rules: options?.rules });
      if (inferred) return inferred;
    }
  }

  return undefined;
}

/**
 * Bounded discovery, never authorization or shell evaluation. Keep each active
 * substitution in its own quote context, and decode static words only after
 * separating command regions. A here-document body is stdin, never a command
 * line: a quoted delimiter makes it literal and an unquoted one leaves only its
 * substitutions active. When `<<` is an arithmetic shift or its delimiter cannot
 * be followed, the lines stay commands. Scripts, eval strings and dynamic command names
 * remain opaque; real Ravi calls still authorize at the gateway. Configured
 * raw-text matchers deliberately keep their separate contract above.
 */
function discoverShellCommands(input: string): string[][] {
  type Heredoc = { delimiter: string; literal: boolean; stripTabs: boolean };
  // A subshell shares the pending here-documents of the region that contains it;
  // a substitution owns its own, because its body is read inside it. An undefined
  // entry marks a redirect whose delimiter this scanner could not follow.
  type Frame = {
    source: string;
    wordStart: boolean;
    heredocs: Array<Heredoc | undefined>;
    quote?: "'" | '"' | "heredoc";
    closing?: ")" | "`";
    // `((` and `$((` open arithmetic, where `<<` is a shift and never a redirect.
    open?: number;
    arithmetic?: boolean;
  };
  const commands: string[][] = [];
  const flush = (frame: Frame) => {
    const source = frame.source;
    frame.source = "";
    frame.wordStart = true;
    // Only unquoted reserved prefixes are syntax; quoted ones are executables.
    const command = source.replace(/^(\s*(?:if|then|elif|else|do|while|until|!|time)\s+)+/, "");
    try {
      const tokens = parseShell(command, () => "__dynamic_shell_word__");
      const words: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        const next = tokens[i + 1];
        if (typeof token === "string") {
          if (/^\d+$/.test(token) && typeof next === "object" && "op" in next && /[<>]/.test(next.op)) continue;
          words.push(token);
        } else if ("comment" in token) {
          break;
        } else if ([">", ">>", "<", ">&", "<&", "<>"].includes(token.op)) {
          if (token.op === ">" && typeof next === "object" && "op" in next && next.op === "|") i++;
          i++; // Redirect destinations are operands, including a file called ravi.
        } else if (token.op === "glob") {
          words.push("__dynamic_shell_word__");
        }
      }
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
      while (["env", "sudo", "command", "builtin", "nohup"].includes(words[0]?.split("/").at(-1) ?? "")) {
        commands.push([...words]); // A wrapper can have its own configured gate.
        const wrapper = words.shift()!.split("/").at(-1);
        while (words[0]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
          const option = words.shift();
          if (
            (wrapper === "env" && ["-u", "--unset"].includes(option!)) ||
            (wrapper === "sudo" && ["-u", "-g", "-h", "-p", "-C", "-T", "-R", "-D"].includes(option!))
          )
            words.shift();
        }
      }
      if (words.length) commands.push(words);
    } catch {
      // no-cause: Incomplete shell text is expected during best-effort skill discovery; retain only its visible command prefix, never an authorization verdict.
      // Retain a visible static command prefix even if a later word is malformed.
      const prefix = /^\s*([a-z0-9_./-]+)(?:\s+([a-z0-9_-]+))?(?:\s+([a-z0-9_-]+))?/i.exec(command);
      if (prefix) commands.push(prefix.slice(1).filter((word): word is string => Boolean(word)));
    }
  };
  // `start` follows `<<`. A word this scanner cannot follow returns undefined; the
  // caller then stops attributing bodies on that line and reads them line by line.
  const readHeredocRedirect = (text: string, start: number): { end: number; heredoc?: Heredoc } | undefined => {
    if (text[start] === "<") return { end: start + 1 }; // A here-string word stays an ordinary argument.
    const stripTabs = text[start] === "-";
    let cursor = stripTabs ? start + 1 : start;
    while (text[cursor] === " " || text[cursor] === "\t") cursor++;
    let delimiter = "";
    let literal = false;
    while (cursor < text.length && !/[\s;&|()<>]/.test(text[cursor]!)) {
      const char = text[cursor]!;
      if (char === "'" || char === '"') {
        const close = text.indexOf(char, cursor + 1);
        if (close < 0) return undefined;
        delimiter += text.slice(cursor + 1, close);
        cursor = close + 1;
        literal = true;
      } else if (char === "\\") {
        delimiter += text[cursor + 1] ?? "";
        cursor += 2;
        literal = true;
      } else {
        delimiter += char;
        cursor++;
      }
    }
    // `]` and `}` close a subscript or an expansion, where `<<` was a shift.
    if (/[$`\n\]}]/.test(delimiter) || (!delimiter && !literal)) return undefined;
    return { end: cursor, heredoc: { delimiter, literal, stripTabs } };
  };
  const readHeredocBody = (
    text: string,
    start: number,
    heredoc: Heredoc,
  ): { body: string; end: number } | undefined => {
    let body = "";
    for (let cursor = start; cursor < text.length; ) {
      let end = text.indexOf("\n", cursor);
      if (end < 0) end = text.length;
      let line = text.slice(cursor, end);
      // With an unquoted delimiter Bash joins backslash-newline before comparing.
      while (!heredoc.literal && end < text.length && (/\\+$/.exec(line)?.[0].length ?? 0) % 2 === 1) {
        const from = end + 1;
        end = text.indexOf("\n", from);
        if (end < 0) end = text.length;
        line = line.slice(0, -1) + text.slice(from, end);
      }
      if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
        return { body, end: Math.min(end + 1, text.length) };
      }
      body += `${line}\n`;
      cursor = end + 1;
    }
    return undefined;
  };
  const scan = (text: string, heredocBody: boolean) => {
    // The body of an unquoted here-document is one quoted region: quotes are
    // text there, and only its substitutions open command regions.
    const frames: Frame[] = [
      { source: "", wordStart: true, heredocs: [], ...(heredocBody ? { quote: "heredoc" as const } : {}) },
    ];
    for (let i = 0; i < text.length; i++) {
      const frame = frames[frames.length - 1]!;
      const char = text[i]!;
      let nextIndex = i + 1;
      if (frame.quote !== "'" && (char === "$" || (!frame.quote && /[<>]/.test(char)))) {
        while (text[nextIndex] === "\\" && text[nextIndex + 1] === "\n") nextIndex += 2;
      }
      const next = text[nextIndex];
      const heredocAt = !frame.quote && !frame.arithmetic && char === "<" && next === "<";
      const redirect = heredocAt ? readHeredocRedirect(text, nextIndex + 1) : undefined;
      if (heredocAt && !redirect) frame.heredocs.push(undefined);
      if (char === "\\" && frame.quote !== "'" && (!frame.quote || (next && /[$`"\\\n]/.test(next)))) {
        frame.source += char + (next ?? "");
        if (next !== "\n") frame.wordStart = false;
        i++;
      } else if (char === frame.quote) {
        frame.source += char;
        frame.quote = undefined;
      } else if (!frame.quote && (char === "'" || char === '"')) {
        frame.source += char;
        frame.quote = char;
        frame.wordStart = false;
      } else if (frame.quote === "'") {
        frame.source += char;
      } else if (!frame.quote && char === frame.closing) {
        flush(frame);
        frames.pop();
      } else if (char === "`" || (next === "(" && (char === "$" || (!frame.quote && /[<>]/.test(char))))) {
        frame.source += "__dynamic_shell_word__";
        frame.wordStart = false;
        frames.push({
          source: "",
          wordStart: true,
          heredocs: [],
          closing: char === "`" ? "`" : ")",
          ...(char === "$" ? { open: nextIndex } : {}),
        });
        if (char !== "`") i = nextIndex;
      } else if (redirect) {
        // The delimiter is a redirect operand, never the executable.
        frame.source += redirect.heredoc ? "<__dynamic_shell_word__" : "<<<";
        frame.wordStart = !redirect.heredoc;
        if (redirect.heredoc) frame.heredocs.push(redirect.heredoc);
        i = redirect.end - 1;
      } else if (!frame.quote && char === "(") {
        flush(frame);
        frames.push({
          source: "",
          wordStart: true,
          heredocs: frame.heredocs,
          closing: ")",
          open: i,
          arithmetic: frame.arithmetic || frame.open === i - 1,
        });
      } else if (!frame.quote && char === "#" && frame.wordStart) {
        while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      } else if (
        !frame.quote &&
        /[;|&\n]/.test(char) &&
        !(char === "&" && (/[<>]/.test(text[i - 1] ?? "") || next === ">")) &&
        !(char === "|" && text[i - 1] === ">")
      ) {
        flush(frame);
        // Bodies follow the newline that ends the announcing line, in order.
        for (const heredoc of char === "\n" ? frame.heredocs.splice(0) : []) {
          if (!heredoc) break; // Unreadable delimiter: keep reading the lines as commands.
          const read = readHeredocBody(text, i + 1, heredoc);
          if (!read) break; // No terminator: keep reading the lines as commands.
          if (!heredoc.literal) scan(read.body, true);
          i = read.end - 1;
        }
      } else {
        // shell-quote treats mid-word # as comments; Bash only does at word start.
        frame.source += (!frame.quote && char === "#" ? "\\" : "") + char;
        frame.wordStart = !frame.quote && /[\s<>]/.test(char);
      }
    }
    for (const frame of heredocBody ? frames.slice(1) : frames) flush(frame);
  };
  scan(input, false);
  return commands;
}

export function inferRaviGroupSkillGate(
  groupOrToolName: string,
  options?: { rules?: readonly SkillGateRuleConfig[] },
): SkillGateMetadata | undefined {
  const normalized = normalizeGateTarget(groupOrToolName);
  const matched = getEffectiveDefaultRules(options?.rules ?? []).find((rule) => rule.pattern.test(normalized));
  if (!matched) {
    return undefined;
  }

  return {
    skill: matched.skill,
    source: matched.source,
    ruleId: matched.id,
  };
}

function resolveConfiguredToolGate(toolName: string, rules: readonly SkillGateRuleConfig[]): ConfiguredGateResolution {
  const normalized = normalizeGateTarget(toolName);
  for (const rule of rules) {
    if (!ruleHasDirectToolMatcher(rule) && !ruleHasGroupMatcher(rule)) {
      continue;
    }
    if (!configuredToolRuleMatches(rule, normalized, toolName)) {
      continue;
    }
    const resolution = configuredRuleResolution(rule);
    if (resolution !== undefined) {
      return resolution;
    }
  }
  return undefined;
}

function resolveConfiguredCommandGate(
  commandLine: string,
  options?: { executables?: readonly string[]; rules?: readonly SkillGateRuleConfig[] },
): ConfiguredGateResolution {
  const normalizedCommand = normalizeShell(commandLine);
  const rules = options?.rules ?? [];
  for (const rule of rules) {
    if (!ruleHasDirectCommandMatcher(rule)) {
      continue;
    }
    if (!configuredCommandRuleMatches(rule, commandLine, normalizedCommand, options?.executables)) {
      continue;
    }
    const resolution = configuredRuleResolution(rule);
    if (resolution !== undefined) {
      return resolution;
    }
  }
  return undefined;
}

function resolveConfiguredGroupTargetGate(
  groupOrToolName: string,
  rules: readonly SkillGateRuleConfig[],
): ConfiguredGateResolution {
  const normalized = normalizeGateTarget(groupOrToolName);
  for (const rule of rules) {
    if (!ruleHasGroupMatcher(rule)) {
      continue;
    }
    if (!configuredGroupRuleMatches(rule, normalized)) {
      continue;
    }
    const resolution = configuredRuleResolution(rule);
    if (resolution !== undefined) {
      return resolution;
    }
  }
  return undefined;
}

function getEffectiveDefaultRules(rules: readonly SkillGateRuleConfig[]): EffectiveGroupSkillRule[] {
  const effective: EffectiveGroupSkillRule[] = DEFAULT_RAVI_GROUP_SKILL_RULES.map((rule) => ({
    ...rule,
    source: "inferred",
  }));

  for (const config of rules) {
    if (!config.id) {
      continue;
    }
    const index = effective.findIndex((rule) => rule.id === config.id);
    if (index === -1) {
      continue;
    }
    if (isRuleDisabled(config)) {
      effective.splice(index, 1);
      continue;
    }

    const skill = normalizeConfiguredSkill(config.skill);
    const pattern = compileRulePattern(config.pattern ?? config.groupRegex);
    if (!skill && !pattern) {
      continue;
    }

    effective[index] = {
      ...effective[index]!,
      ...(skill ? { skill } : {}),
      ...(pattern ? { pattern } : {}),
      source: "config",
    };
  }

  return effective;
}

function configuredRuleResolution(rule: SkillGateRuleConfig): ConfiguredGateResolution {
  if (isRuleDisabled(rule)) {
    return false;
  }

  const skill = normalizeConfiguredSkill(rule.skill);
  if (!skill) {
    return undefined;
  }

  return {
    skill,
    source: "config",
    ...(rule.id ? { ruleId: rule.id } : {}),
  };
}

function isRuleDisabled(rule: SkillGateRuleConfig): boolean {
  return rule.disabled === true || rule.remove === true || rule.skill === null;
}

function normalizeConfiguredSkill(skill: SkillGateRuleConfig["skill"]): string | undefined {
  return typeof skill === "string" && skill.trim().length > 0 ? skill.trim() : undefined;
}

function configuredToolRuleMatches(
  rule: SkillGateRuleConfig,
  normalizedToolName: string,
  rawToolName: string,
): boolean {
  if (typeof rule.tool === "string" && normalizeGateTarget(rule.tool) === normalizedToolName) {
    return true;
  }
  if (typeof rule.toolPrefix === "string" && normalizedToolName.startsWith(normalizeGateTarget(rule.toolPrefix))) {
    return true;
  }
  if (regexMatches(rule.toolRegex, rawToolName)) {
    return true;
  }
  return configuredGroupRuleMatches(rule, normalizedToolName);
}

function configuredCommandRuleMatches(
  rule: SkillGateRuleConfig,
  rawCommandLine: string,
  normalizedCommandLine: string,
  executables: readonly string[] | undefined,
): boolean {
  if (typeof rule.command === "string" && normalizeShell(rule.command) === normalizedCommandLine) {
    return configuredMatcherExecutableAllowed(rule.command, executables);
  }
  if (
    typeof rule.commandPrefix === "string" &&
    commandStartsWith(normalizedCommandLine, normalizeShell(rule.commandPrefix))
  ) {
    return configuredMatcherExecutableAllowed(rule.commandPrefix, executables);
  }
  return regexMatches(rule.commandRegex, rawCommandLine);
}

function configuredGroupRuleMatches(rule: SkillGateRuleConfig, normalizedTarget: string): boolean {
  return regexMatches(rule.pattern ?? rule.groupRegex, normalizedTarget);
}

function ruleHasDirectToolMatcher(rule: SkillGateRuleConfig): boolean {
  return typeof rule.tool === "string" || typeof rule.toolPrefix === "string" || typeof rule.toolRegex === "string";
}

function ruleHasDirectCommandMatcher(rule: SkillGateRuleConfig): boolean {
  return (
    typeof rule.command === "string" || typeof rule.commandPrefix === "string" || typeof rule.commandRegex === "string"
  );
}

function ruleHasGroupMatcher(rule: SkillGateRuleConfig): boolean {
  return typeof rule.pattern === "string" || typeof rule.groupRegex === "string";
}

function compileRulePattern(pattern: string | undefined): RegExp | undefined {
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function regexMatches(pattern: string | undefined, value: string): boolean {
  const regex = compileRulePattern(pattern);
  return regex ? regex.test(value) : false;
}

function configuredMatcherExecutableAllowed(matcher: string, executables: readonly string[] | undefined): boolean {
  if (!executables) {
    return true;
  }
  const firstToken = normalizeShell(matcher).split(" ")[0];
  if (!firstToken) {
    return true;
  }
  const executable = firstToken.split("/").filter(Boolean).at(-1) ?? firstToken;
  return executables.includes(executable);
}

function normalizeCliSegment(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeGateTarget(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeShell(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function commandStartsWith(command: string, prefix: string): boolean {
  if (!prefix) return false;
  return command === prefix || command.startsWith(`${prefix} `) || command.includes(` ${prefix} `);
}

function isExemptRaviToolName(toolName: string): boolean {
  const normalized = normalizeGateTarget(toolName);
  for (const fullName of RAVI_GATE_EXEMPT_COMMANDS) {
    if (normalized === fullName.replace(/\./g, "_")) {
      return true;
    }
  }
  return false;
}
