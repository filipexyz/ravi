import { basename, resolve } from "node:path";
import type { ContextCapability } from "../router/router-db.js";

export interface RaviAppCommandTemplate {
  executable: string;
  argv: string[];
  argsPlaceholderIndex: number | null;
}

export interface RaviAppCommandInvocation {
  executable: string;
  argv: string[];
  displayCommand: string;
}

export interface RaviAppCommandRuntime {
  execPath?: string;
  entrypoint?: string;
}

const SAFE_APP_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "BUN_INSTALL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "RAVI_HOME",
  "RAVI_STATE_DIR",
] as const;

export function parseRaviAppCommand(command: string): RaviAppCommandTemplate {
  const tokens = tokenizeRaviAppCommand(command);
  const executable = tokens[0];
  if (!executable) throw new Error("CLI command must declare an executable.");

  let argsPlaceholderIndex: number | null = null;
  const argv = tokens.slice(1);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "{args}") {
      if (argsPlaceholderIndex !== null) {
        throw new Error("CLI command may contain a dynamic argv placeholder at most once.");
      }
      argsPlaceholderIndex = index;
      continue;
    }
    if (token.includes("{") || token.includes("}")) {
      throw new Error(
        `Unsupported CLI command placeholder in token "${token}"; only a complete {args} token is allowed in new manifests.`,
      );
    }
  }
  if (executable.includes("{") || executable.includes("}")) {
    throw new Error("CLI command executable must be static; placeholders are not allowed.");
  }

  return { executable, argv, argsPlaceholderIndex };
}

export function tokenizeRaviAppCommand(command: string): string[] {
  if (!command.trim()) throw new Error("CLI command must be a non-empty string.");
  if (/[\r\n\0]/.test(command)) throw new Error("CLI command must be a single line.");
  if (command.includes("`") || command.includes("$(")) {
    throw new Error("CLI command must not contain command substitution.");
  }

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      token += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    if ("|&;<>".includes(char)) {
      throw new Error(`CLI command must not contain shell operator "${char}".`);
    }
    token += char;
    tokenStarted = true;
  }

  if (escaped) throw new Error("CLI command must not end with a dangling escape.");
  if (quote) throw new Error("CLI command contains an unterminated quote.");
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0) throw new Error("CLI command must declare an executable.");
  return tokens;
}

export function resolveRaviAppCommand(
  command: string,
  args: string[] = [],
  runtime: RaviAppCommandRuntime = {},
): RaviAppCommandInvocation {
  const parsed = parseRaviAppCommand(command);
  const argv = [...parsed.argv];
  if (parsed.argsPlaceholderIndex === null) {
    argv.push(...args);
  } else {
    argv.splice(parsed.argsPlaceholderIndex, 1, ...args);
  }

  let executable = parsed.executable;
  if (isRaviExecutable(executable)) {
    const execPath = runtime.execPath ?? process.execPath;
    const entrypoint = runtime.entrypoint ?? process.argv[1];
    if (!execPath?.trim() || !entrypoint?.trim()) {
      throw new Error("Cannot resolve the current Ravi CLI entrypoint for an app command.");
    }
    executable = execPath;
    argv.unshift(resolve(entrypoint));
  }

  return {
    executable,
    argv,
    displayCommand: [parsed.executable, ...renderTemplateArgs(parsed, args)].map(quoteDisplayArg).join(" "),
  };
}

export function buildRaviAppProcessEnv(
  source: NodeJS.ProcessEnv,
  input: {
    appId?: string;
    operationId?: string;
    appRoot?: string;
    contextKey?: string;
  } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_APP_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  if (input.appId) env.RAVI_APP_ID = input.appId;
  if (input.operationId) env.RAVI_APP_OPERATION_ID = input.operationId;
  if (input.appRoot) env.RAVI_APP_ROOT = input.appRoot;
  if (input.contextKey) env.RAVI_CONTEXT_KEY = input.contextKey;
  return env;
}

export function parseRaviAppCapability(value: string): ContextCapability {
  const match = /^([^:\s]+):([^:\s]+):(.+)$/.exec(value.trim());
  if (!match || !match[3]?.trim()) {
    throw new Error(`Invalid context capability "${value}"; expected permission:objectType:objectId.`);
  }
  return {
    permission: match[1]!,
    objectType: match[2]!,
    objectId: match[3]!.trim(),
    source: "app-manifest",
  };
}

function renderTemplateArgs(parsed: RaviAppCommandTemplate, args: string[]): string[] {
  const argv = [...parsed.argv];
  if (parsed.argsPlaceholderIndex === null) {
    argv.push(...args);
  } else {
    argv.splice(parsed.argsPlaceholderIndex, 1, ...args);
  }
  return argv;
}

function isRaviExecutable(value: string): boolean {
  return value === "ravi" || basename(value) === "ravi";
}

function quoteDisplayArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
