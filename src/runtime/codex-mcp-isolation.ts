/**
 * Codex MCP isolation (spec `runtime/providers/codex`, "MCP Isolation").
 *
 * Codex must not load MCP servers of its own: registered servers reach a Codex
 * agent only through `ravi mcp tools` / `ravi mcp call` in its shell tool. The
 * provider therefore
 *
 * 1. reads the `[mcp_servers]` keys of every configuration layer Codex loads
 *    for the session (system, managed, `$CODEX_HOME/config.toml`, and the
 *    trusted project layers from the project root down to the cwd) and turns
 *    each one off with `-c mcp_servers.<key>.enabled=false`, plus the apps
 *    (connectors) feature with `-c features.apps=false`;
 * 2. after the thread is started, resumed or forked, asks the app-server for
 *    `mcpServerStatus/list` on that thread and fails the session closed when a
 *    server is reported as anything but disabled;
 * 3. fails a turn closed when an MCP tool call item or event shows up anyway.
 *
 * Facts checked on Codex 0.172.0 that shape this module:
 * - `-c mcp_servers={}` merges and does not clear the table.
 * - The `-c` key path is split on every dot and quotes are not understood, so a
 *   server key that is not a bare key (`my.server`) cannot be turned off. Such a
 *   key fails the start closed here, before Codex runs.
 * - An override for a key that no loaded layer defines makes Codex refuse to
 *   start ("invalid transport"). Keys of an untrusted project layer, which Codex
 *   does not load, are therefore left out.
 * - A disabled server is still listed by `mcpServerStatus/list`, with
 *   `runtimeStatus: "disabled"` and no tools.
 * - Without a `threadId` the status call reloads the configuration without the
 *   project layers and errors on their overrides, so it always names the thread.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TOML } from "bun";

/** Codex's own feature switch for apps (connectors); verified with `codex features list`. */
export const CODEX_APPS_FEATURE_OVERRIDE = "features.apps=false";

export const CODEX_SYSTEM_CONFIG_PATH = "/etc/codex/config.toml";
export const CODEX_MANAGED_CONFIG_PATH = "/etc/codex/managed_config.toml";

/** A key Codex's `-c` parser can address: it splits the path on dots and takes no quotes. */
const CODEX_OVERRIDABLE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Whether a launch override (`-c mcp_servers.<key>.enabled=false`) can address
 * this `[mcp_servers]` key. A key that is not a bare key (`my.server`, or one
 * that needs quotes) cannot be turned off, so every Codex session that loads
 * the file is refused until the entry is removed from it.
 */
export function isCodexOverridableMcpKey(key: string): boolean {
  return CODEX_OVERRIDABLE_KEY.test(key);
}

/** Bounded wait for the status answer: a server that never answers fails the start closed. */
export const CODEX_MCP_STATUS_TIMEOUT_MS = 15_000;
const CODEX_MCP_STATUS_MAX_PAGES = 50;
const CODEX_MCP_ERROR_NAME_LIMIT = 10;

export type CodexMcpConfigLayer = "system" | "managed" | "user" | "project";

export interface CodexMcpConfigSource {
  layer: CodexMcpConfigLayer;
  path: string;
  /** Server keys under `[mcp_servers]`, in file order. */
  keys: string[];
}

export interface CodexMcpIsolationPlan {
  /** Launch arguments, placed before `app-server`. */
  args: string[];
  /** Every server key turned off, sorted and unique. */
  keys: string[];
  /** The files that contributed keys. */
  sources: CodexMcpConfigSource[];
  /** Changes whenever the arguments change; part of the app-server respawn decision. */
  signature: string;
}

export type CodexMcpIsolationErrorCode =
  | "config_unreadable"
  | "key_not_overridable"
  | "server_active"
  | "status_failed"
  | "mcp_tool_call";

/** The lowest Codex this per-thread status check was verified on. */
export const CODEX_MCP_STATUS_VERIFIED_VERSION = "0.172.0";
const CODEX_STATUS_VERSION_HINT = `This check was verified on Codex ${CODEX_MCP_STATUS_VERIFIED_VERSION}; an older Codex may not answer it. Update Codex to ${CODEX_MCP_STATUS_VERIFIED_VERSION} or later (codex --version shows the installed one) and start the session again.`;

const IMPORT_HINT =
  "Codex reaches MCP servers only through Ravi: register the server with `ravi mcp import` (or `ravi mcp add`) and remove it from the Codex configuration.";

export class CodexMcpIsolationError extends Error {
  readonly code: CodexMcpIsolationErrorCode;
  readonly servers: string[];

  constructor(code: CodexMcpIsolationErrorCode, message: string, servers: string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexMcpIsolationError";
    this.code = code;
    this.servers = servers;
  }
}

export interface ResolveCodexMcpIsolationInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams; default to the real paths. */
  systemConfigPath?: string;
  managedConfigPath?: string;
  homeDir?: string;
  /** The TOML parser; default Bun's. */
  parseToml?: CodexTomlParse;
}

/** `$CODEX_HOME`, else `<HOME>/.codex`, the way Codex resolves its own home from the env it is given. */
export function resolveCodexHomeDir(env: NodeJS.ProcessEnv | undefined, homeDir?: string): string {
  const configured = env?.CODEX_HOME?.trim();
  if (configured) return resolve(configured);
  return join(homeDir ?? env?.HOME ?? process.env.HOME ?? homedir(), ".codex");
}

/**
 * The configuration layers Codex loads for a session in `cwd` and the
 * `[mcp_servers]` keys of each: system, managed, `$CODEX_HOME/config.toml`,
 * and the trusted project layers from the project root down to the cwd.
 * The launch and `ravi doctor` read the same list. Throws
 * CodexMcpIsolationError (`config_unreadable`) when a file exists but cannot
 * be used.
 */
export function collectCodexMcpConfigSources(input: ResolveCodexMcpIsolationInput): CodexMcpConfigSource[] {
  const codexHome = resolveCodexHomeDir(input.env, input.homeDir);
  const sources: CodexMcpConfigSource[] = [];

  const parse = input.parseToml ?? TOML.parse;
  const system = readCodexConfigFile(input.systemConfigPath ?? CODEX_SYSTEM_CONFIG_PATH, parse);
  const managed = readCodexConfigFile(input.managedConfigPath ?? CODEX_MANAGED_CONFIG_PATH, parse);
  const userPath = join(codexHome, "config.toml");
  const user = readCodexConfigFile(userPath, parse);

  if (system) sources.push(sourceFrom("system", input.systemConfigPath ?? CODEX_SYSTEM_CONFIG_PATH, system));
  if (managed) sources.push(sourceFrom("managed", input.managedConfigPath ?? CODEX_MANAGED_CONFIG_PATH, managed));
  if (user) sources.push(sourceFrom("user", userPath, user));

  const trust = collectProjectTrust([system, user]);
  for (const dir of codexProjectLayerDirs(input.cwd)) {
    if (!isCodexProjectDirTrusted(dir.path, dir.gitRoot, trust)) continue;
    const path = join(dir.path, ".codex", "config.toml");
    const parsed = readCodexConfigFile(path, parse);
    if (parsed) sources.push(sourceFrom("project", path, parsed));
  }
  return sources;
}

/**
 * Builds the launch overrides for one app-server start. Throws
 * CodexMcpIsolationError when a configuration file exists but cannot be read
 * or parsed, or when a server key cannot be addressed by `-c`.
 */
export function resolveCodexMcpIsolation(input: ResolveCodexMcpIsolationInput): CodexMcpIsolationPlan {
  const sources = collectCodexMcpConfigSources(input);
  const keys = [...new Set(sources.flatMap((source) => source.keys))].sort();
  const unaddressable = keys.filter((key) => !isCodexOverridableMcpKey(key));
  if (unaddressable.length > 0) {
    const where = sources
      .filter((source) => source.keys.some((key) => unaddressable.includes(key)))
      .map((source) => source.path);
    throw new CodexMcpIsolationError(
      "key_not_overridable",
      `Codex MCP server ${formatNames(unaddressable)} in ${where.join(", ")} cannot be turned off at launch (Codex overrides take bare keys only), so the session was not started. ${IMPORT_HINT}`,
      unaddressable,
    );
  }

  const args: string[] = [];
  for (const key of keys) {
    args.push("-c", `mcp_servers.${key}.enabled=false`);
  }
  args.push("-c", CODEX_APPS_FEATURE_OVERRIDE);
  return { args, keys, sources, signature: JSON.stringify(args) };
}

function sourceFrom(layer: CodexMcpConfigLayer, path: string, parsed: ParsedCodexConfig): CodexMcpConfigSource {
  return { layer, path, keys: parsed.mcpServerKeys };
}

interface ParsedCodexConfig {
  mcpServerKeys: string[];
  projects: Record<string, unknown> | null;
}

/** Null when the file does not exist; throws when it exists but cannot be used. */
function readCodexConfigFile(path: string, parse: CodexTomlParse): ParsedCodexConfig | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    if (!statSync(path).isFile()) {
      throw new Error("not a regular file");
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CodexMcpIsolationError(
      "config_unreadable",
      `Codex configuration ${path} could not be read, so its MCP servers cannot be turned off; the session was not started.`,
      [],
      { cause: error },
    );
  }
  const read = readCodexConfigText(text, parse);
  if (read.kind === "unreadable") {
    throw new CodexMcpIsolationError(
      "config_unreadable",
      `Ravi could not read Codex configuration ${path}: its TOML reader rejected the file, and a line scan could not tell which MCP servers it declares. Its MCP servers cannot be turned off, so the session was not started.`,
    );
  }
  if (read.kind === "scanned") {
    const projects: Record<string, unknown> = {};
    for (const [project, level] of read.projectTrust) projects[project] = { trust_level: level };
    return { mcpServerKeys: read.mcpServerKeys, projects };
  }
  const record = read.document;
  const servers = record.mcp_servers;
  if (servers !== undefined && !asRecord(servers)) {
    throw new CodexMcpIsolationError(
      "config_unreadable",
      `Codex configuration ${path} has an mcp_servers entry that is not a table; the session was not started.`,
    );
  }
  return {
    mcpServerKeys: Object.keys(asRecord(servers) ?? {}),
    projects: asRecord(record.projects),
  };
}

// ============================================================================
// Reading a Codex configuration file
// ============================================================================

/** A TOML parser that throws on a text it rejects. */
export type CodexTomlParse = (text: string) => unknown;

/** What Ravi could learn from one Codex configuration file. */
export type CodexConfigRead =
  /** The TOML reader parsed the file. */
  | { kind: "parsed"; document: Record<string, unknown> }
  /**
   * The TOML reader rejected the file (Bun 1.3's parser refuses valid TOML such as
   * offset and local date-times, local dates and local times), and the strict
   * line scan found every MCP server key and every project trust level.
   */
  | { kind: "scanned"; mcpServerKeys: string[]; projectTrust: Array<[string, string]> }
  /** Neither could decide which MCP servers the file holds. */
  | { kind: "unreadable" };

/**
 * Reads one Codex configuration text. A leading UTF-8 byte order mark is
 * dropped first (Bun's parser reads such a file as an empty table). When the
 * parser throws, a strict scan of the text looks for every `[mcp_servers...]`
 * table header, every dotted `mcp_servers.<key>` assignment and the keys of a
 * top-level `mcp_servers = { ... }` inline table, and for the
 * `[projects."<path>"] trust_level` lines. The scan accepts nothing it does
 * not understand: any line it cannot place makes the file unreadable, so a
 * server it might have missed never goes untouched. `parse` defaults to Bun's
 * parser; tests pass one that throws to reach the scan on any Bun version.
 */
export function readCodexConfigText(raw: string, parse: CodexTomlParse = TOML.parse): CodexConfigRead {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    // no-cause: the parser's error quotes the file, which may hold a secret; the scan decides instead.
    const scanned = scanCodexConfigText(text);
    return scanned
      ? { kind: "scanned", mcpServerKeys: scanned.keys, projectTrust: [...scanned.trust] }
      : { kind: "unreadable" };
  }
  const document = asRecord(parsed);
  return document ? { kind: "parsed", document } : { kind: "unreadable" };
}

class CodexScanError extends Error {}

/** One value in the scan: an inline table reports the first segment of each of its keys. */
interface ScannedValue {
  end: number;
  inlineKeys: string[] | null;
  string: string | null;
}

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
/** A bare scalar (number, boolean, date-time) and the whitespace (space or tab) after it. */
const BARE_SCALAR_CHAR = /[A-Za-z0-9_+\-.: \t]/;

/**
 * The strict scan behind `readCodexConfigText`. Returns null when it cannot
 * decide. It reads table headers, key paths and the shape of values (strings
 * of all four kinds, arrays and inline tables over several lines, comments,
 * and bare scalars such as numbers, booleans and date-times); it never needs
 * a value's meaning except a `trust_level` string.
 */
export function scanCodexConfigText(text: string): { keys: string[]; trust: Map<string, string> } | null {
  const keys: string[] = [];
  const trust = new Map<string, string>();
  const addKey = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };
  const fail = (): never => {
    throw new CodexScanError();
  };
  const n = text.length;

  const skipSpaces = (at: number): number => {
    let i = at;
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    return i;
  };
  /** Spaces, newlines and comments (inside arrays and inline tables). */
  const skipBlank = (at: number): number => {
    let i = at;
    for (;;) {
      i = skipSpaces(i);
      if (text[i] === "#") {
        while (i < n && text[i] !== "\n") i++;
      } else if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] === "\n")) {
        i += text[i] === "\r" ? 2 : 1;
      } else {
        return i;
      }
    }
  };
  /** The end of a line: spaces, an optional comment, then a newline or the end of the text. */
  const endOfLine = (at: number): number => {
    let i = skipSpaces(at);
    if (text[i] === "#") while (i < n && text[i] !== "\n") i++;
    if (i >= n) return n;
    if (text[i] === "\r" && text[i + 1] === "\n") return i + 2;
    if (text[i] === "\n") return i + 1;
    return fail();
  };

  const readBasic = (at: number): { value: string; end: number } => {
    let i = at + 1;
    let value = "";
    for (;;) {
      if (i >= n || text[i] === "\n") return fail();
      const ch = text[i]!;
      if (ch === '"') return { value, end: i + 1 };
      if (ch === "\\") {
        const escaped = readEscape(i);
        value += escaped.value;
        i = escaped.end;
        continue;
      }
      value += ch;
      i++;
    }
  };
  const readEscape = (at: number): { value: string; end: number } => {
    const code = text[at + 1];
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      e: "\u001b",
      '"': '"',
      "\\": "\\",
    };
    if (code !== undefined && code in simple) return { value: simple[code]!, end: at + 2 };
    const width = code === "u" ? 4 : code === "U" ? 8 : code === "x" ? 2 : 0;
    const hex = width ? text.slice(at + 2, at + 2 + width) : "";
    if (!width || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) return fail();
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff) return fail();
    return { value: String.fromCodePoint(point), end: at + 2 + width };
  };
  const readLiteral = (at: number): { value: string; end: number } => {
    const close = text.indexOf("'", at + 1);
    const newline = text.indexOf("\n", at + 1);
    if (close < 0 || (newline >= 0 && newline < close)) return fail();
    return { value: text.slice(at + 1, close), end: close + 1 };
  };
  /** A multi-line string: up to two more quotes may close it. */
  const skipMultiline = (at: number, quote: '"' | "'"): number => {
    const fence = quote.repeat(3);
    let i = at + 3;
    for (;;) {
      if (i >= n) return fail();
      if (quote === '"' && text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text.startsWith(fence, i)) {
        let end = i + 3;
        while (end < n && text[end] === quote && end - i < 5) end++;
        return end;
      }
      i++;
    }
  };

  const readKeyPath = (at: number): { path: string[]; end: number } => {
    const path: string[] = [];
    let i = skipSpaces(at);
    for (;;) {
      const ch = text[i];
      if (ch === '"') {
        const read = readBasic(i);
        path.push(read.value);
        i = read.end;
      } else if (ch === "'") {
        const read = readLiteral(i);
        path.push(read.value);
        i = read.end;
      } else {
        const start = i;
        while (i < n && BARE_KEY_CHAR.test(text[i]!)) i++;
        if (i === start) return fail();
        path.push(text.slice(start, i));
      }
      i = skipSpaces(i);
      if (text[i] !== ".") return { path, end: i };
      i = skipSpaces(i + 1);
    }
  };

  /** One value; `stops` end a bare scalar inside an array or inline table. */
  const readValue = (at: number, nested: boolean): ScannedValue => {
    const i = at;
    const ch = text[i];
    if (text.startsWith('"""', i)) return { end: skipMultiline(i, '"'), inlineKeys: null, string: null };
    if (text.startsWith("'''", i)) return { end: skipMultiline(i, "'"), inlineKeys: null, string: null };
    if (ch === '"') {
      const read = readBasic(i);
      return { end: read.end, inlineKeys: null, string: read.value };
    }
    if (ch === "'") {
      const read = readLiteral(i);
      return { end: read.end, inlineKeys: null, string: read.value };
    }
    if (ch === "[") {
      let j = skipBlank(i + 1);
      while (text[j] !== "]") {
        j = skipBlank(readValue(j, true).end);
        if (text[j] === ",") j = skipBlank(j + 1);
        else if (text[j] !== "]") return fail();
      }
      return { end: j + 1, inlineKeys: null, string: null };
    }
    if (ch === "{") {
      const inlineKeys: string[] = [];
      let j = skipBlank(i + 1);
      while (text[j] !== "}") {
        const key = readKeyPath(j);
        if (text[key.end] !== "=") return fail();
        if (!inlineKeys.includes(key.path[0]!)) inlineKeys.push(key.path[0]!);
        j = skipBlank(readValue(skipSpaces(key.end + 1), true).end);
        if (text[j] === ",") j = skipBlank(j + 1);
        else if (text[j] !== "}") return fail();
      }
      return { end: j + 1, inlineKeys, string: null };
    }
    let j = i;
    while (j < n && text[j] !== "\n" && text[j] !== "#" && !(nested && /[,\]}]/.test(text[j]!))) {
      if (!BARE_SCALAR_CHAR.test(text[j]!) && text[j] !== "\r") return fail();
      j++;
    }
    if (text.slice(i, j).trim() === "") return fail();
    return { end: j, inlineKeys: null, string: null };
  };

  try {
    let table: string[] = [];
    let i = 0;
    while (i < n) {
      i = skipSpaces(i);
      if (i >= n) break;
      if (text[i] === "#" || text[i] === "\n" || text[i] === "\r") {
        i = endOfLine(i);
        continue;
      }
      if (text[i] === "[") {
        const array = text[i + 1] === "[";
        const key = readKeyPath(i + (array ? 2 : 1));
        let j = key.end;
        if (text[j] !== "]" || (array && text[j + 1] !== "]")) fail();
        j += array ? 2 : 1;
        table = key.path;
        if (table[0] === "mcp_servers") {
          if (table.length >= 2) addKey(table[1]!);
          else if (array) fail();
        }
        if (table[0] === "projects" && array) fail();
        i = endOfLine(j);
        continue;
      }
      const key = readKeyPath(i);
      if (text[key.end] !== "=") fail();
      const value = readValue(skipSpaces(key.end + 1), false);
      const full = [...table, ...key.path];
      if (full[0] === "mcp_servers") {
        if (full.length >= 2) addKey(full[1]!);
        else if (value.inlineKeys) for (const inline of value.inlineKeys) addKey(inline);
        else fail();
      }
      if (full[0] === "projects") {
        if (full.length === 3 && full[2] === "trust_level") {
          if (value.string === null) fail();
          trust.set(full[1]!, value.string!);
        } else if (full.length <= 2) {
          // `projects = {...}` or `projects."<path>" = {...}`: trust the scan cannot read.
          fail();
        }
      }
      i = endOfLine(value.end);
    }
  } catch (error) {
    if (error instanceof CodexScanError) return null;
    throw error;
  }
  return { keys, trust };
}

type ProjectTrust = Map<string, string>;

/** `[projects."<path>"] trust_level`, later layers winning (user over system). */
function collectProjectTrust(layers: Array<ParsedCodexConfig | null>): ProjectTrust {
  const trust: ProjectTrust = new Map();
  for (const layer of layers) {
    for (const [path, value] of Object.entries(layer?.projects ?? {})) {
      const level = asRecord(value)?.trust_level;
      if (typeof level === "string") trust.set(normalizeDir(path), level);
    }
  }
  return trust;
}

interface ProjectLayerDir {
  path: string;
  gitRoot: string | null;
}

/**
 * The directories whose `.codex/config.toml` Codex layers for a cwd: from the
 * project root (the nearest ancestor holding `.git`, else the cwd itself)
 * down to the cwd.
 */
export function codexProjectLayerDirs(cwd: string): ProjectLayerDir[] {
  const start = normalizeDir(cwd);
  let gitRoot: string | null = null;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      gitRoot = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const root = gitRoot ?? start;
  const chain: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    chain.push(dir);
    if (dir === root || dirname(dir) === dir) break;
  }
  return chain.reverse().map((path) => ({ path, gitRoot }));
}

/**
 * A project layer loads only when its folder is trusted: the folder's own
 * `projects` entry decides, and without one the git root's entry decides.
 */
function isCodexProjectDirTrusted(dir: string, gitRoot: string | null, trust: ProjectTrust): boolean {
  const own = trust.get(dir);
  if (own !== undefined) return own === "trusted";
  if (gitRoot) return trust.get(gitRoot) === "trusted";
  return false;
}

function normalizeDir(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // no-cause: A path that cannot be resolved is compared as written; a wrong trust guess still fails the start closed.
    return absolute;
  }
}

export type CodexMcpStatusRequest = (
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number },
) => Promise<Record<string, unknown>>;

/**
 * Asks the app-server which MCP servers the thread has and throws
 * CodexMcpIsolationError unless every reported server is disabled. A failed or
 * malformed answer fails closed as well.
 */
export async function verifyCodexMcpServersDisabled(
  request: CodexMcpStatusRequest,
  threadId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const active: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < CODEX_MCP_STATUS_MAX_PAGES; page++) {
    let response: Record<string, unknown>;
    try {
      response = await request(
        "mcpServerStatus/list",
        { threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) },
        { timeoutMs: options.timeoutMs ?? CODEX_MCP_STATUS_TIMEOUT_MS },
      );
    } catch (error) {
      throw new CodexMcpIsolationError(
        "status_failed",
        `Codex did not report its MCP servers (mcpServerStatus/list failed), so the session was stopped: Ravi cannot confirm that Codex loaded no MCP server of its own. ${CODEX_STATUS_VERSION_HINT}`,
        [],
        { cause: error },
      );
    }
    if (!Array.isArray(response.data)) {
      throw new CodexMcpIsolationError(
        "status_failed",
        "Codex answered mcpServerStatus/list without a server list, so the session was stopped.",
      );
    }
    active.push(...listActiveCodexMcpServers(response.data));
    const next = response.nextCursor;
    if (next === null || next === undefined) {
      return finishStatusCheck(active);
    }
    if (typeof next !== "string" || next.length === 0 || next === cursor) {
      throw new CodexMcpIsolationError(
        "status_failed",
        "Codex answered mcpServerStatus/list with an invalid cursor, so the session was stopped.",
      );
    }
    cursor = next;
  }
  throw new CodexMcpIsolationError(
    "status_failed",
    "Codex reported more MCP server pages than Ravi reads, so the session was stopped.",
  );
}

function finishStatusCheck(active: string[]): void {
  if (active.length === 0) return;
  const names = [...new Set(active)].sort();
  throw new CodexMcpIsolationError(
    "server_active",
    `Codex loaded MCP server ${formatNames(names)} that Ravi did not turn off, so the session was stopped. ${IMPORT_HINT}`,
    names,
  );
}

/**
 * The names of reported servers that are not disabled. An entry counts as
 * disabled only with `runtimeStatus: "disabled"` and no tools; any other or
 * missing status, a plugin server, or an unnamed entry counts as active.
 */
export function listActiveCodexMcpServers(entries: readonly unknown[]): string[] {
  const active: string[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" && record.name.length > 0 ? record.name : "(unnamed)";
    if (record?.runtimeStatus === "disabled" && !hasTools(record.tools)) continue;
    active.push(name);
  }
  return active;
}

function hasTools(tools: unknown): boolean {
  if (tools === null || tools === undefined) return false;
  if (Array.isArray(tools)) return tools.length > 0;
  const record = asRecord(tools);
  return record ? Object.keys(record).length > 0 : true;
}

/**
 * True for any app-server message that shows an MCP tool call:
 * `item/mcpToolCall/*` notifications, and `item/started|completed` whose item
 * is of the MCP tool call type.
 */
export function isCodexMcpToolCallMessage(method: string, params: Record<string, unknown>): boolean {
  if (method.startsWith("item/mcpToolCall/")) return true;
  if (method !== "item/started" && method !== "item/completed") return false;
  const type = asRecord(params.item)?.type;
  return type === "mcpToolCall" || type === "mcp_tool_call";
}

export function codexMcpToolCallError(params: Record<string, unknown>): CodexMcpIsolationError {
  const item = asRecord(params.item);
  const server = typeof item?.server === "string" && item.server ? item.server : null;
  return new CodexMcpIsolationError(
    "mcp_tool_call",
    `Codex called a tool of its own MCP server${server ? ` ${JSON.stringify(server)}` : ""}, which no Ravi permission decision covers, so the turn was stopped. ${IMPORT_HINT}`,
    server ? [server] : [],
  );
}

function formatNames(names: readonly string[]): string {
  const shown = names.slice(0, CODEX_MCP_ERROR_NAME_LIMIT).map((name) => JSON.stringify(name));
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
