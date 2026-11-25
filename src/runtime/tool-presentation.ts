import { analyzeBashCommand } from "../bash/parser.js";
import { getCliToolDefinition } from "../cli/tool-definitions.js";
import { getRuntimeBuiltinToolDefinition } from "../cli/tool-registry.js";
import { extractOptionName } from "../cli/utils.js";
import type { ChannelToolPresentation } from "../channels/runtime-events.js";

const MAX_TITLE_BYTES = 256;
const MAX_SUMMARY_BYTES = 1_024;
const MAX_PARAMETER_NAME_BYTES = 96;
const MAX_PARAMETER_LABEL_BYTES = 256;
const MAX_PARAMETER_VALUE_BYTES = 512;
const MAX_PARAMETERS = 8;

const SENSITIVE_FIELD =
  /(?:^|[._-])(?:authorization|cookie|credential|secret|token|password|passphrase|api[_-]?key|private[_-]?key|content|body|html|prompt|message|patch|env)(?:$|[._-])/i;
const LOCAL_PATH_FIELD = /(?:^|[._-])(?:path|file|filename|cwd|home|workspace|directory|dir|root)(?:$|[._-])/i;
const MACHINE_ONLY_FIELD = /^(?:json|asJson)$/i;

/** `mcp__<server>__<tool>`: the server part never holds `__`, the tool part may. */
const MCP_EXPOSED_TOOL = /^mcp__([a-z][a-z0-9-]{0,23})__([A-Za-z0-9_-]{1,64})$/;
const MCP_SERVER_NAME = /^[a-z][a-z0-9-]{0,23}$/;
const MCP_REMOTE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The CLI pair's call as a runtime dynamic tool (`ravi mcp call`). */
const MCP_CALL_DYNAMIC_TOOL = "mcp_call";

function mcpToolTitle(server: string, tool: string): string {
  return `MCP ${server}: ${tool}`;
}

/** The server and remote tool of an MCP call, from its exposed name or the CLI pair's arguments. */
function mcpToolOf(toolName: string, input: Record<string, unknown>): { server: string; tool: string } | null {
  const exposed = MCP_EXPOSED_TOOL.exec(toolName);
  if (exposed) return { server: exposed[1]!, tool: exposed[2]! };
  if (toolName !== MCP_CALL_DYNAMIC_TOOL) return null;
  const server = typeof input.server === "string" ? input.server.trim() : "";
  let tool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (tool.startsWith(`mcp__${server}__`)) tool = tool.slice(`mcp__${server}__`.length);
  return MCP_SERVER_NAME.test(server) && MCP_REMOTE_TOOL_NAME.test(tool) ? { server, tool } : null;
}

/** The longest shell command read for an MCP call (the call's own --input is capped at 1 MB). */
const MAX_SHELL_MCP_CALL_BYTES = 1024 * 1024;
/** Characters a word may hold outside quotes: none of them means anything to the shell. */
const SHELL_PLAIN_CHARACTER = /^[A-Za-z0-9_@%+=:,./-]$/;
/** Shells a runtime wraps a command in (`/bin/zsh -lc '<command>'`). */
const SHELL_WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
]);
const SHELL_WRAPPER_FLAGS = new Set(["-c", "-lc"]);
const MCP_CALL_VALUE_FLAGS = new Set(["--input", "--wait", "--agent"]);
const MCP_CALL_SWITCHES = new Set(["--json", "--execute"]);

/**
 * The words of a command line made only of words: plain characters, single-quoted text and double-quoted text
 * without `$`, backquote, backslash or `!`, separated by spaces or tabs. Anything else (an operator, a
 * redirection, a comment, an expansion, a newline, a glob or brace character outside quotes) gives null.
 */
function plainShellWords(text: string): string[] | null {
  const words: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === " " || text[index] === "\t") {
      index += 1;
      continue;
    }
    let word = "";
    while (index < text.length && text[index] !== " " && text[index] !== "\t") {
      const char = text[index]!;
      if (char === "'") {
        const end = text.indexOf("'", index + 1);
        if (end < 0) return null;
        const quoted = text.slice(index + 1, end);
        if (quoted.includes("\n") || quoted.includes("\r")) return null;
        word += quoted;
        index = end + 1;
      } else if (char === '"') {
        const end = text.indexOf('"', index + 1);
        if (end < 0) return null;
        const quoted = text.slice(index + 1, end);
        if (/[$`\\!\n\r]/.test(quoted)) return null;
        word += quoted;
        index = end + 1;
      } else if (SHELL_PLAIN_CHARACTER.test(char)) {
        word += char;
        index += 1;
      } else {
        return null;
      }
    }
    words.push(word);
  }
  return words;
}

/**
 * The words of a command line when the repository's shell analyzer (the one the permission hook uses) sees
 * exactly one simple command, run directly, with no assignment, pipe, list, here-document or substitution,
 * and every word literal; and a strict reading of the same line finds only words (no redirection, comment,
 * background `&`, grouping or expansion, which the analyzer does not report). Both must agree word for word.
 */
function simpleShellCommandWords(command: string, options: { launches?: boolean } = {}): string[] | null {
  const words = plainShellWords(command);
  if (!words || words.length === 0) return null;
  let analysis: ReturnType<typeof analyzeBashCommand>;
  try {
    analysis = analyzeBashCommand(command);
  } catch {
    // no-cause: a line the analyzer cannot model is shown as a shell command, as before.
    return null;
  }
  if (analysis.commands.length === 0 || analysis.assignments.length > 0) return null;
  const [only, ...launched] = analysis.commands;
  // A shell wrapper's own script shows up as commands the wrapper launches; that script is checked on its own.
  if (launched.length > 0 && !(options.launches && launched.every((item) => item.origin === "launcher"))) return null;
  if (only!.origin !== "segment" || only!.pipedStdin || only!.codeInputs || only!.launcher) return null;
  const analyzed = [only!.word, ...only!.argv];
  if (analyzed.length !== words.length || analyzed.some((word, index) => word !== words[index])) return null;
  return words;
}

/**
 * A shell command that is exactly one `ravi mcp call <server> <tool>` with that command's own flags
 * (`--input`, `--wait`, `--agent`, `--json`, `--execute`, each at most once), run as `ravi` from PATH, either
 * directly or as the whole script of one `<shell> -c|-lc '<command>'` wrapper. It is then shown like the
 * native call: server, tool and the argument names of an `--input` that is literal JSON, never a value. What
 * the native call does not have is shown too, as names only: a line without `--execute` is a dry run, and
 * `--agent` and `--wait` are named (their values are not). Anything else returns null and keeps the shell
 * presentation.
 */
export function mcpCallOfShellCommand(command: unknown): {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  /** The line carries `--execute`; without it the CLI only prints its plan. */
  execute: boolean;
  /** `--agent` and `--wait` when present, in that order; never their values. */
  flags: string[];
} | null {
  if (typeof command !== "string" || command.length > MAX_SHELL_MCP_CALL_BYTES) return null;
  let words = simpleShellCommandWords(command.trim(), { launches: true });
  if (words && words.length === 3 && SHELL_WRAPPERS.has(words[0]!) && SHELL_WRAPPER_FLAGS.has(words[1]!)) {
    words = simpleShellCommandWords(words[2]!.trim());
  } else if (words && words[0] !== "ravi") {
    return null;
  }
  if (!words || words.length < 5) return null;
  const [program, group, action, serverWord, toolWord, ...rest] = words;
  if (program !== "ravi" || group !== "mcp" || action !== "call") return null;
  const server = serverWord!;
  let tool = toolWord!;
  if (!MCP_SERVER_NAME.test(server)) return null;
  if (tool.startsWith(`mcp__${server}__`)) tool = tool.slice(`mcp__${server}__`.length);
  if (!MCP_REMOTE_TOOL_NAME.test(tool)) return null;
  const seen = new Set<string>();
  let inputText: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    const separator = word.indexOf("=");
    const flag = separator > 0 ? word.slice(0, separator) : word;
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (MCP_CALL_SWITCHES.has(flag) && separator < 0) continue;
    if (!MCP_CALL_VALUE_FLAGS.has(flag)) return null;
    let value: string;
    if (separator > 0) value = word.slice(separator + 1);
    else {
      if (index + 1 >= rest.length) return null;
      index += 1;
      value = rest[index]!;
    }
    if (flag === "--input") inputText = value;
  }
  let input: Record<string, unknown> = {};
  if (inputText !== undefined) {
    try {
      input = asRecord(JSON.parse(inputText)) ?? {};
    } catch {
      // no-cause: an --input that is not literal JSON shows no argument names.
      input = {};
    }
  }
  const flags = ["--agent", "--wait"].filter((flag) => seen.has(flag));
  return { server, tool, input, execute: seen.has("--execute"), flags };
}

/**
 * A tool of a registered MCP server, shown as server and tool. Its arguments
 * are whatever the server's schema asks for, so only their names are shown
 * (redacted), never a value: the same rule as `ravi mcp call --input`.
 */
function buildMcpToolPresentation(
  server: string,
  tool: string,
  input: Record<string, unknown>,
  shell?: { execute: boolean; flags: string[] },
): ChannelToolPresentation {
  const parameters: NonNullable<ChannelToolPresentation["parameters"]> = [];
  for (const key of Object.keys(input).sort((left, right) => left.localeCompare(right))) {
    if (parameters.length >= MAX_PARAMETERS) break;
    const name = portableParameterName(key);
    const label = name === key ? undefined : truncateUtf8(sanitizeStaticText(key), MAX_PARAMETER_LABEL_BYTES);
    parameters.push({ name, ...(label ? { label } : {}), redacted: true });
  }
  // A shell line's own flags come first, so a long argument list never cuts them off.
  const summary = truncateUtf8(
    [...(shell?.flags ?? []), ...parameters.map((parameter) => `${parameter.label ?? parameter.name}=[redacted]`)].join(
      " · ",
    ),
    MAX_SUMMARY_BYTES,
  );
  const title = `${mcpToolTitle(server, tool)}${shell && !shell.execute ? " (dry run)" : ""}`;
  return {
    title: truncateUtf8(title, MAX_TITLE_BYTES),
    ...(summary ? { summary } : {}),
    category: "mcp",
    ...(parameters.length > 0 ? { parameters } : {}),
  };
}

export function buildRuntimeToolPresentation(toolName: string, input: unknown): ChannelToolPresentation {
  if (MCP_EXPOSED_TOOL.test(toolName)) {
    const mcp = mcpToolOf(toolName, {});
    if (mcp) return buildMcpToolPresentation(mcp.server, mcp.tool, asRecord(input) ?? {});
  }
  const builtin = getRuntimeBuiltinToolDefinition(toolName);
  if (builtin?.capability === "exec.shell") {
    // Codex and Grok call MCP tools with `ravi mcp call` in their shell: shown like the native call, but only
    // for a line that is provably that one command (mcpCallOfShellCommand).
    const call = mcpCallOfShellCommand(asRecord(input)?.command);
    if (call) return buildMcpToolPresentation(call.server, call.tool, call.input, call);
  }
  const cliTool = builtin ? undefined : getCliToolDefinition(toolName);
  const access = cliTool?.metadata.access;
  const effectiveInput = unwrapDynamicToolInput(toolName, input);
  const parameterOrder = cliTool
    ? [
        ...cliTool.metadata.args.map((argument) => argument.name),
        ...cliTool.metadata.options.map((option) => extractOptionName(option.flags)),
      ]
    : builtin
      ? Object.keys(effectiveInput)
      : [];
  const redactions = new Set(access?.redactions ?? []);
  const parameters = buildParameters({
    input: effectiveInput,
    order: parameterOrder,
    redactions,
    includeUnregisteredKeys: builtin !== undefined,
  });
  const summary = truncateUtf8(
    parameters
      .map((parameter) =>
        parameter.redacted
          ? `${parameter.label ?? parameter.name}=[redacted]`
          : `${parameter.label ?? parameter.name}=${parameter.value ?? ""}`,
      )
      .join(" · "),
    MAX_SUMMARY_BYTES,
  );
  const category = normalizeWireKind(builtin?.capability ?? access?.resource);
  const operation = builtin?.operation ?? access?.kind;
  const risk = builtin?.risk ?? access?.risk;

  const mcpCall = toolName === MCP_CALL_DYNAMIC_TOOL ? mcpToolOf(toolName, effectiveInput) : null;
  return {
    title: truncateUtf8(
      mcpCall
        ? mcpToolTitle(mcpCall.server, mcpCall.tool)
        : sanitizeStaticText(builtin?.description ?? cliTool?.description ?? normalizeWireKind(toolName) ?? "tool") ||
            "tool",
      MAX_TITLE_BYTES,
    ),
    ...(summary ? { summary } : {}),
    ...(category ? { category } : {}),
    ...(operation ? { operation } : {}),
    ...(risk ? { risk } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
  };
}

function unwrapDynamicToolInput(toolName: string, input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  if (!record) return {};
  if (record.name === toolName && asRecord(record.args) !== undefined) {
    return asRecord(record.args) ?? {};
  }
  return record;
}

function buildParameters(input: {
  input: Record<string, unknown>;
  order: readonly string[];
  redactions: ReadonlySet<string>;
  includeUnregisteredKeys: boolean;
}): NonNullable<ChannelToolPresentation["parameters"]> {
  const keys = input.includeUnregisteredKeys
    ? [...new Set([...input.order, ...Object.keys(input.input).sort((left, right) => left.localeCompare(right))])]
    : [...new Set(input.order)];
  const parameters: NonNullable<ChannelToolPresentation["parameters"]> = [];

  for (const originalName of keys) {
    if (parameters.length >= MAX_PARAMETERS) break;
    if (MACHINE_ONLY_FIELD.test(originalName) || !(originalName in input.input)) {
      continue;
    }
    const value = input.input[originalName];
    if (value === undefined) continue;
    const name = portableParameterName(originalName);
    const canonicalFieldName = normalizeFieldName(originalName);
    const label =
      name === originalName ? undefined : truncateUtf8(sanitizeStaticText(originalName), MAX_PARAMETER_LABEL_BYTES);
    if (
      input.redactions.has(originalName) ||
      SENSITIVE_FIELD.test(canonicalFieldName) ||
      (typeof value === "string" && LOCAL_PATH_FIELD.test(canonicalFieldName))
    ) {
      parameters.push({
        name,
        ...(label ? { label } : {}),
        redacted: true,
      });
      continue;
    }
    const safeValue = safeParameterValue(value);
    if (safeValue === undefined) continue;
    parameters.push({
      name,
      ...(label ? { label } : {}),
      ...(safeValue.redacted ? { redacted: true } : { value: safeValue.value }),
    });
  }

  return parameters;
}

function safeParameterValue(value: unknown): { value: string; redacted?: false } | { redacted: true } | undefined {
  if (value === null) return { value: "null" };
  if (typeof value === "boolean" || typeof value === "number") {
    return { value: String(value) };
  }
  if (typeof value === "string") {
    const sanitized = sanitizeDynamicText(value);
    if (!sanitized) return undefined;
    if (sanitized === "[redacted]") return { redacted: true };
    return {
      value: truncateUtf8(sanitized, MAX_PARAMETER_VALUE_BYTES),
    };
  }
  if (Array.isArray(value)) {
    return { value: `${value.length} items` };
  }
  const record = asRecord(value);
  if (record) {
    return { value: `${Object.keys(record).length} fields` };
  }
  return undefined;
}

function sanitizeStaticText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeDynamicText(value: string): string {
  let next = sanitizeStaticText(value);
  next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  next = next.replace(/\b(?:sk|ghp|gho|github_pat|xox[aboprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]");
  next = next.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
  next = next.replace(
    /\b(authorization|credential|secret|token|password|passphrase|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1=[redacted]",
  );
  next = next.replace(/(?:file:\/\/)?(?:\/Users|\/home|\/private|\/tmp|\/var\/folders)\/[^\s"'`]+/g, "[local path]");
  next = next.replace(/(?:^|[\s"'=])~\/[^\s"'`]+/g, (match) => `${match.slice(0, 1)}[local path]`);
  next = next.replace(/\b[A-Za-z]:\\Users\\[^\s"'`]+/g, "[local path]");
  return next.trim();
}

function portableParameterName(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, MAX_PARAMETER_NAME_BYTES);
  return normalized || "parameter";
}

function normalizeFieldName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeWireKind(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/[._-]+$/g, "")
    .slice(0, 96);
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) ? normalized : undefined;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let result = "";
  for (const character of value) {
    const candidate = `${result}${character}`;
    if (encoder.encode(candidate).byteLength > maximumBytes - 3) break;
    result = candidate;
  }
  return `${result}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
