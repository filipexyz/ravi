/**
 * Runtime-native MCP entries and their migration into the registry (spec mcp,
 * Import).
 *
 * Runtimes load only registered servers. The entries a runtime used to load
 * from its own configuration are found here, normalized and planned as
 * registrations:
 *
 * - `<agent cwd>/.mcp.json` (Claude Code project file);
 * - `~/.claude.json`: user entries (`mcpServers`) and project entries
 *   (`projects[<agent cwd>].mcpServers`);
 * - plugin `.mcp.json` files and `plugin.json` `mcpServers` under Ravi's user
 *   plugin directory (`~/ravi/plugins/<plugin>`);
 * - `$CODEX_HOME/config.toml` (default `~/.codex`) and
 *   `<agent cwd>/.codex/config.toml` (`[mcp_servers.<name>]`).
 *
 * Source files are only read, never written. Values that may be secrets (the
 * full URL, environment values) stay in memory and go only to the credentials
 * store; every public view here holds names, display URLs and reasons only.
 */

import { isAbsolute, join, resolve } from "node:path";

import {
  checkMcpServerName,
  MCP_TOOL_NAME_PREFIX,
  mcpDisplayUrl,
  mcpInlineSecretArgIndex,
  parseMcpServerUrl,
} from "./names.js";
import { type CodexTomlParse, readCodexConfigText } from "../runtime/codex-mcp-isolation.js";
import type { McpServerSecret } from "./secrets.js";
import type { McpTransport } from "./registry-db.js";

// ============================================================================
// Types
// ============================================================================

export type McpImportSourceKind =
  | "agent-mcp-json"
  | "claude-user"
  | "claude-project"
  | "plugin"
  | "codex-home"
  | "codex-project";

/** The file system reads discovery needs (injectable for tests and doctor). */
export interface McpImportFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Names of the subdirectories of a directory (empty when it cannot be listed). */
  listDirs(path: string): string[];
}

/** Ravi's default Claude `settingSources` (`src/runtime/runtime-request-builder.ts`). */
export const MCP_IMPORT_DEFAULT_CLAUDE_SETTING_SOURCES: readonly ("user" | "project")[] = ["project"];

export interface McpImportAgent {
  id: string;
  cwd: string;
  /**
   * The runtime provider the agent runs on (`claude`, `codex`, `pi`, `grok`).
   * Claude sources reach only Claude agents and Codex sources only Codex
   * agents; any other value reaches no source.
   */
  runtime: string;
  /** Claude `settingSources`; default `["project"]`, as Ravi launches Claude. */
  settingSources?: readonly ("user" | "project")[];
}

export interface McpImportSource {
  kind: McpImportSourceKind;
  path: string;
  /** `claude-project`: the project directory the entries belong to. */
  scope: string | null;
  agentIds: string[];
  status: "read" | "invalid";
  problem: string | null;
  entries: number;
}

/** One runtime-native entry. `url` and `env` values are secrets: never print them. */
export interface NativeMcpEntry {
  kind: McpImportSourceKind;
  path: string;
  scope: string | null;
  nativeName: string;
  agentIds: string[];
  transport: McpTransport | null;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  /** Why the entry cannot be imported as it is, or null. Never holds a value. */
  unsupported: string | null;
  /**
   * Why no given agent's runtime loaded the entry (wrong runtime, a settings
   * source the agent does not load, or disabled in the runtime), or null when
   * `agentIds` names the agents that loaded it.
   */
  notLoaded: string | null;
  notes: string[];
}

export interface NativeMcpDiscovery {
  sources: McpImportSource[];
  entries: NativeMcpEntry[];
}

export interface DiscoverNativeMcpInput {
  agents: readonly McpImportAgent[];
  homeDir: string;
  /** `$CODEX_HOME`; default `<homeDir>/.codex`. */
  codexHome?: string | null;
  /** Plugin roots; default every `<homeDir>/ravi/plugins/<dir>` with `.claude-plugin/plugin.json`. */
  pluginDirs?: readonly string[];
  fs: McpImportFs;
  /** The TOML parser for Codex files; default Bun's (a test seam). */
  parseToml?: CodexTomlParse;
}

/** A source file larger than this is not read (`~/.claude.json` also holds history). */
export const MCP_IMPORT_SOURCE_MAX_BYTES = 32 * 1024 * 1024;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EXPANSION = /\$\{[^}]*\}/;
const MAX_NATIVE_NAME = 128;

// ============================================================================
// Discovery
// ============================================================================

function expandHomeIn(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ReadResult = { ok: true; text: string } | { ok: false; problem: string } | null;

function readSource(fs: McpImportFs, path: string): ReadResult {
  if (!fs.exists(path)) return null;
  let text: string | null = null;
  try {
    text = fs.readFile(path);
  } catch {
    // no-cause: the reader error can name paths or quote content; the source is reported as unreadable.
    text = null;
  }
  if (text === null) return { ok: false, problem: "the file could not be read" };
  if (Buffer.byteLength(text, "utf8") > MCP_IMPORT_SOURCE_MAX_BYTES) {
    return { ok: false, problem: "the file is larger than 32 MB" };
  }
  return { ok: true, text };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // no-cause: the parser error quotes the file, which may hold a secret.
    return null;
  }
}

/** The server map of a Claude-style file: `{mcpServers: {...}}`, or a bare map in a plugin file. */
function claudeServerMap(document: Record<string, unknown>, allowBare: boolean): Record<string, unknown> | null {
  if (isPlainObject(document.mcpServers)) return document.mcpServers;
  if (document.mcpServers !== undefined) return null;
  if (!allowBare) return {};
  const values = Object.values(document);
  if (values.every((value) => isPlainObject(value) && ("command" in value || "url" in value))) return document;
  return {};
}

function safeNativeName(name: string): string {
  return name.length > MAX_NATIVE_NAME ? name.slice(0, MAX_NATIVE_NAME) : name;
}

/** The agents whose runtime loaded an entry of a source, by native name. */
type LoadedBy = (nativeName: string) => { agentIds: string[]; notLoaded: string | null };

interface EntryContext {
  kind: McpImportSourceKind;
  path: string;
  scope: string | null;
  loadedBy: LoadedBy;
  /** Plugin root, substituted for `${CLAUDE_PLUGIN_ROOT}`. */
  pluginRoot?: string;
}

function baseEntry(context: EntryContext, nativeName: string): NativeMcpEntry {
  const loaded = context.loadedBy(nativeName);
  return {
    kind: context.kind,
    path: context.path,
    scope: context.scope,
    nativeName: safeNativeName(nativeName),
    agentIds: [...loaded.agentIds],
    transport: null,
    url: null,
    command: null,
    args: [],
    env: {},
    enabled: true,
    unsupported: null,
    notLoaded: loaded.agentIds.length ? null : loaded.notLoaded,
    notes: [],
  };
}

function unsupported(entry: NativeMcpEntry, reason: string): NativeMcpEntry {
  entry.unsupported = reason;
  entry.url = null;
  entry.env = {};
  return entry;
}

function substitutePluginRoot(value: string, context: EntryContext): string {
  return context.pluginRoot ? value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => context.pluginRoot as string) : value;
}

function hasNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Shared validation of a normalized entry: values that the runtime would
 * expand, environment key names, a secret on the command line, the URL.
 */
function finishEntry(entry: NativeMcpEntry, raw: { url?: unknown; command?: unknown; args?: unknown; env?: unknown }) {
  if (entry.transport === "http") {
    if (typeof raw.url !== "string" || !raw.url.trim()) return unsupported(entry, "it has no URL");
    if (EXPANSION.test(raw.url)) {
      return unsupported(entry, "its URL uses environment variable expansion, which the runtime resolves at start");
    }
    let parsed: URL | null = null;
    try {
      parsed = parseMcpServerUrl(raw.url);
    } catch {
      // no-cause: the URL may carry a token; the fixed reason below never repeats it.
      parsed = null;
    }
    if (!parsed) {
      return unsupported(entry, "its URL is not a valid https URL (plain http only on a loopback host)");
    }
    entry.url = parsed.toString();
    return entry;
  }
  if (typeof raw.command !== "string" || !raw.command.trim()) return unsupported(entry, "it has no command");
  if (/[\0\n\r]/.test(raw.command)) return unsupported(entry, "its command holds a control character");
  entry.command = raw.command.trim();
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
      return unsupported(entry, "its args are not a list of strings");
    }
    entry.args = [...(raw.args as string[])];
  }
  if (raw.env !== undefined) {
    if (!isPlainObject(raw.env)) return unsupported(entry, "its env is not a table of strings");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (!ENV_KEY.test(key)) return unsupported(entry, "an env key is not a valid variable name");
      if (typeof value !== "string") return unsupported(entry, `env ${key} is not a string`);
      if (!value) return unsupported(entry, `env ${key} is empty`);
      env[key] = value;
    }
    entry.env = env;
  }
  if ([entry.command, ...entry.args, ...Object.values(entry.env)].some((value) => EXPANSION.test(value))) {
    return unsupported(entry, "it uses environment variable expansion, which the runtime resolves at start");
  }
  const secretArg = mcpInlineSecretArgIndex(entry.args);
  if (secretArg !== null) {
    return unsupported(
      entry,
      `argument ${secretArg + 1} looks like a secret value; move it to an env key and register the server with ravi mcp add`,
    );
  }
  return entry;
}

/** A Claude Code entry (`.mcp.json`, `~/.claude.json`, plugin files). */
function claudeEntry(context: EntryContext, nativeName: string, raw: unknown): NativeMcpEntry {
  const entry = baseEntry(context, nativeName);
  if (!isPlainObject(raw)) return unsupported(entry, "the entry is not an object");
  const declared = typeof raw.type === "string" ? raw.type : undefined;
  const type = declared ?? (raw.command !== undefined ? "stdio" : raw.url !== undefined ? "http" : undefined);
  if (type === "sse") return unsupported(entry, "it uses the legacy SSE transport, which Ravi does not support");
  if (type !== "stdio" && type !== "http") {
    const shown = declared && /^[a-z-]{1,20}$/.test(declared) ? declared : "unknown";
    return unsupported(entry, `its transport (${shown}) is not supported`);
  }
  if (hasNonEmpty(raw.headers)) {
    return unsupported(
      entry,
      "it sends HTTP headers (often a token); register it with ravi mcp add and give the credential to its login",
    );
  }
  entry.transport = type;
  const resolveValue = (value: unknown): unknown =>
    typeof value === "string" ? substitutePluginRoot(value, context) : value;
  return finishEntry(entry, {
    url: resolveValue(raw.url),
    command: resolveValue(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map(resolveValue) : raw.args,
    env: isPlainObject(raw.env)
      ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, resolveValue(value)]))
      : raw.env,
  });
}

/** A Codex entry (`[mcp_servers.<name>]`). */
function codexEntry(context: EntryContext, nativeName: string, raw: unknown): NativeMcpEntry {
  const entry = baseEntry(context, nativeName);
  if (!isPlainObject(raw)) return unsupported(entry, "the entry is not a table");
  if (raw.enabled === false) entry.enabled = false;
  if (hasNonEmpty(raw.bearer_token_env_var) || hasNonEmpty(raw.http_headers) || hasNonEmpty(raw.env_http_headers)) {
    return unsupported(
      entry,
      "it sends a token or HTTP headers; register it with ravi mcp add and give the credential to its login",
    );
  }
  if (hasNonEmpty(raw.env_vars)) {
    return unsupported(
      entry,
      "it passes variables from the environment (env_vars); register it with ravi mcp add --env",
    );
  }
  if (hasNonEmpty(raw.cwd)) {
    return unsupported(entry, "it sets a working directory, which a registered server does not keep");
  }
  if (hasNonEmpty(raw.enabled_tools) || hasNonEmpty(raw.disabled_tools)) {
    entry.notes.push("its tool filter is not kept; grant the tools by name instead");
  }
  if (raw.command !== undefined) entry.transport = "stdio";
  else if (raw.url !== undefined) entry.transport = "http";
  else return unsupported(entry, "it has neither a command nor a URL");
  return finishEntry(entry, raw);
}

function addEntries(
  discovery: NativeMcpDiscovery,
  source: McpImportSource,
  map: Record<string, unknown>,
  build: (name: string, raw: unknown) => NativeMcpEntry,
): void {
  for (const [name, raw] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
    discovery.entries.push(build(name, raw));
    source.entries++;
  }
}

function pushSource(
  discovery: NativeMcpDiscovery,
  kind: McpImportSourceKind,
  path: string,
  scope: string | null,
  agentIds: string[],
  problem: string | null = null,
): McpImportSource {
  const source: McpImportSource = {
    kind,
    path,
    scope,
    agentIds: [...agentIds],
    status: problem ? "invalid" : "read",
    problem,
    entries: 0,
  };
  discovery.sources.push(source);
  return source;
}

function readClaudeFile(
  discovery: NativeMcpDiscovery,
  fs: McpImportFs,
  kind: McpImportSourceKind,
  path: string,
  agentIds: string[],
  loadedBy: LoadedBy,
  options: { allowBare?: boolean; pluginRoot?: string } = {},
): void {
  const read = readSource(fs, path);
  if (!read) return;
  if (!read.ok) {
    pushSource(discovery, kind, path, null, agentIds, read.problem);
    return;
  }
  const document = parseJsonObject(read.text);
  const map = document ? claudeServerMap(document, options.allowBare === true) : null;
  if (!map) {
    pushSource(discovery, kind, path, null, agentIds, "the file is not valid JSON with an mcpServers object");
    return;
  }
  const source = pushSource(discovery, kind, path, null, agentIds);
  const context: EntryContext = { kind, path, scope: null, loadedBy, pluginRoot: options.pluginRoot };
  addEntries(discovery, source, map, (name, raw) => claudeEntry(context, name, raw));
}

function readCodexFile(
  discovery: NativeMcpDiscovery,
  fs: McpImportFs,
  kind: McpImportSourceKind,
  path: string,
  agentIds: string[],
  loadedBy: LoadedBy,
  parseToml: CodexTomlParse | undefined,
): void {
  const read = readSource(fs, path);
  if (!read) return;
  if (!read.ok) {
    pushSource(discovery, kind, path, null, agentIds, read.problem);
    return;
  }
  const config = readCodexConfigText(read.text, parseToml);
  const context: EntryContext = { kind, path, scope: null, loadedBy };
  if (config.kind === "scanned") {
    // Bun's TOML reader rejected a file Codex may accept (a date-time value, for example): the scan names
    // the servers but cannot read their values, so each one is listed and none is imported.
    const source = pushSource(discovery, kind, path, null, agentIds);
    const names = Object.fromEntries(config.mcpServerKeys.map((name) => [name, null]));
    addEntries(discovery, source, names, (name) =>
      unsupported(
        baseEntry(context, name),
        "Ravi could not read the values of this file (its TOML reader rejected it); register the server with ravi mcp add",
      ),
    );
    return;
  }
  const document = config.kind === "parsed" ? config.document : null;
  if (!document || (document.mcp_servers !== undefined && !isPlainObject(document.mcp_servers))) {
    pushSource(
      discovery,
      kind,
      path,
      null,
      agentIds,
      document
        ? "its mcp_servers entry is not a table"
        : "Ravi could not read it as TOML, nor tell which MCP servers it declares",
    );
    return;
  }
  const map = isPlainObject(document.mcp_servers) ? document.mcp_servers : {};
  const source = pushSource(discovery, kind, path, null, agentIds);
  addEntries(discovery, source, map, (name, raw) => codexEntry(context, name, raw));
}

/** `~/.claude.json`, read once: the user entries, the local-scope entries and the per-directory switches. */
type ClaudeUserConfig = { path: string; read: ReadResult; document: Record<string, unknown> | null };

function readClaudeUserConfigFile(fs: McpImportFs, path: string): ClaudeUserConfig {
  const read = readSource(fs, path);
  return { path, read, document: read?.ok ? parseJsonObject(read.text) : null };
}

/** A list of names under `key` of an object, ignoring anything that is not a string. */
function nameList(value: unknown, key: string): Set<string> {
  if (!isPlainObject(value) || !Array.isArray(value[key])) return new Set();
  return new Set((value[key] as unknown[]).filter((item): item is string => typeof item === "string"));
}

function readClaudeUserEntries(
  discovery: NativeMcpDiscovery,
  config: ClaudeUserConfig,
  claudeAgentIds: string[],
  userLoadedBy: LoadedBy,
  claudeAgentsByCwd: ReadonlyMap<string, string[]>,
  cwds: readonly string[],
): void {
  const { path, read, document } = config;
  if (!read) return;
  if (!read.ok) {
    pushSource(discovery, "claude-user", path, null, claudeAgentIds, read.problem);
    return;
  }
  if (!document) {
    pushSource(discovery, "claude-user", path, null, claudeAgentIds, "the file is not valid JSON");
    return;
  }
  if (isPlainObject(document.mcpServers)) {
    const source = pushSource(discovery, "claude-user", path, null, claudeAgentIds);
    const context: EntryContext = { kind: "claude-user", path, scope: null, loadedBy: userLoadedBy };
    addEntries(discovery, source, document.mcpServers, (name, raw) => claudeEntry(context, name, raw));
  }
  if (!isPlainObject(document.projects)) return;
  for (const cwd of cwds) {
    const project = document.projects[cwd];
    if (!isPlainObject(project) || !isPlainObject(project.mcpServers)) continue;
    // Claude Code 2.1.323 loads no local-scope entry for a Ravi session, whatever its settingSources (live probe).
    const source = pushSource(discovery, "claude-project", path, cwd, []);
    const context: EntryContext = {
      kind: "claude-project",
      path,
      scope: cwd,
      loadedBy: () => ({
        agentIds: [],
        notLoaded: claudeAgentsByCwd.get(cwd)?.length
          ? "Claude Code does not load local-scope entries (projects in ~/.claude.json) in Ravi sessions"
          : "only Claude Code reads this entry, and no selected agent in this directory runs on Claude",
      }),
    };
    addEntries(discovery, source, project.mcpServers, (name, raw) => claudeEntry(context, name, raw));
  }
}

/** Ravi's user plugin roots: `<home>/ravi/plugins/<dir>` holding `.claude-plugin/plugin.json`. */
export function defaultMcpImportPluginDirs(homeDir: string, fs: McpImportFs): string[] {
  const root = join(homeDir, "ravi", "plugins");
  if (!fs.exists(root)) return [];
  return fs
    .listDirs(root)
    .sort()
    .map((name) => join(root, name))
    .filter((dir) => fs.exists(join(dir, ".claude-plugin", "plugin.json")));
}

function readPlugin(
  discovery: NativeMcpDiscovery,
  fs: McpImportFs,
  pluginRoot: string,
  agentIds: string[],
  loadedBy: LoadedBy,
): void {
  readClaudeFile(discovery, fs, "plugin", join(pluginRoot, ".mcp.json"), agentIds, loadedBy, {
    allowBare: true,
    pluginRoot,
  });
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const read = readSource(fs, manifestPath);
  if (!read || !read.ok) return;
  const manifest = parseJsonObject(read.text);
  if (!manifest || manifest.mcpServers === undefined) return;
  if (typeof manifest.mcpServers === "string") {
    const target = resolve(pluginRoot, manifest.mcpServers);
    // A manifest may only point inside its own plugin.
    if (isAbsolute(manifest.mcpServers) || !(target === pluginRoot || target.startsWith(`${pluginRoot}/`))) {
      pushSource(discovery, "plugin", manifestPath, null, agentIds, "mcpServers points outside the plugin");
      return;
    }
    if (target !== join(pluginRoot, ".mcp.json")) {
      readClaudeFile(discovery, fs, "plugin", target, agentIds, loadedBy, { allowBare: true, pluginRoot });
    }
    return;
  }
  if (!isPlainObject(manifest.mcpServers)) {
    pushSource(discovery, "plugin", manifestPath, null, agentIds, "mcpServers is neither an object nor a path");
    return;
  }
  const source = pushSource(discovery, "plugin", manifestPath, null, agentIds);
  const context: EntryContext = { kind: "plugin", path: manifestPath, scope: null, loadedBy, pluginRoot };
  addEntries(discovery, source, manifest.mcpServers, (name, raw) => claudeEntry(context, name, raw));
}

interface ResolvedImportAgent {
  id: string;
  cwd: string;
  runtime: string;
  settingSources: readonly ("user" | "project")[];
}

/** A source every matching agent loads, entry by entry, with the reason when none does. */
function loadedByAll(agentIds: string[], noneReason: string): LoadedBy {
  return () => ({ agentIds, notLoaded: agentIds.length ? null : noneReason });
}

/**
 * Every runtime-native MCP entry the given agents' runtimes loaded, so the
 * import moves what each runtime used and widens nothing:
 *
 * - Claude Code files reach Claude agents only, Codex files Codex agents only;
 * - `<cwd>/.mcp.json` reaches the Claude agents of that directory whose
 *   `settingSources` hold `project`, unless Claude Code has it disabled there
 *   (`disabledMcpjsonServers` in `<cwd>/.claude/settings.json`, or
 *   `disabledMcpServers` in `~/.claude.json` `projects[<cwd>]`);
 * - `~/.claude.json` user entries reach the Claude agents whose
 *   `settingSources` hold `user`, except where that directory disables them;
 * - local-scope entries (`projects[<cwd>].mcpServers`) reach nobody;
 * - plugin entries reach every Claude agent; Codex home entries every Codex
 *   agent; `<cwd>/.codex/config.toml` the Codex agents of that directory.
 *
 * An entry no agent loaded keeps an empty `agentIds` and says why in
 * `notLoaded`. Sources that do not exist are left out; unreadable ones are
 * listed as invalid.
 */
export function discoverNativeMcpEntries(input: DiscoverNativeMcpInput): NativeMcpDiscovery {
  const discovery: NativeMcpDiscovery = { sources: [], entries: [] };
  const agents: ResolvedImportAgent[] = input.agents.map((agent) => ({
    id: agent.id,
    cwd: resolve(expandHomeIn(agent.cwd, input.homeDir)),
    runtime: agent.runtime.trim(),
    settingSources: agent.settingSources ?? MCP_IMPORT_DEFAULT_CLAUDE_SETTING_SOURCES,
  }));
  if (agents.length === 0) return discovery;
  const ids = (list: readonly ResolvedImportAgent[]) => [...new Set(list.map((agent) => agent.id))];
  const cwds = [...new Set(agents.map((agent) => agent.cwd))].sort();
  const claude = agents.filter((agent) => agent.runtime === "claude");
  const codex = agents.filter((agent) => agent.runtime === "codex");
  const claudeAgentsByCwd = new Map(cwds.map((cwd) => [cwd, ids(claude.filter((agent) => agent.cwd === cwd))]));

  const userConfig = readClaudeUserConfigFile(input.fs, join(input.homeDir, ".claude.json"));
  const projects = isPlainObject(userConfig.document?.projects) ? userConfig.document.projects : {};
  const disabledIn = (cwd: string) => nameList(projects[cwd], "disabledMcpServers");
  const rejectedIn = new Map<string, Set<string>>();
  for (const cwd of cwds) {
    const read = readSource(input.fs, join(cwd, ".claude", "settings.json"));
    const settings = read?.ok ? parseJsonObject(read.text) : null;
    rejectedIn.set(cwd, nameList(settings, "disabledMcpjsonServers"));
  }

  for (const cwd of cwds) {
    const here = claude.filter((agent) => agent.cwd === cwd);
    const withProject = ids(here.filter((agent) => agent.settingSources.includes("project")));
    const loadedBy: LoadedBy = (name) => {
      if (here.length === 0) {
        return {
          agentIds: [],
          notLoaded: "only Claude Code reads this file, and no selected agent in this directory runs on Claude",
        };
      }
      if (withProject.length === 0) {
        return {
          agentIds: [],
          notLoaded: "no selected Claude agent in this directory loads project settings (settingSources)",
        };
      }
      if (rejectedIn.get(cwd)?.has(name) || disabledIn(cwd).has(name)) {
        return {
          agentIds: [],
          notLoaded:
            "Claude Code has it disabled in this directory (disabledMcpjsonServers or disabledMcpServers), so it never ran",
        };
      }
      return { agentIds: withProject, notLoaded: null };
    };
    readClaudeFile(discovery, input.fs, "agent-mcp-json", join(cwd, ".mcp.json"), ids(here), loadedBy);
  }

  const withUser = claude.filter((agent) => agent.settingSources.includes("user"));
  const userLoadedBy: LoadedBy = (name) => {
    if (claude.length === 0) {
      return { agentIds: [], notLoaded: "only Claude Code reads this file, and no selected agent runs on Claude" };
    }
    if (withUser.length === 0) {
      return { agentIds: [], notLoaded: "no selected Claude agent loads user settings (settingSources)" };
    }
    const loaded = ids(withUser.filter((agent) => !disabledIn(agent.cwd).has(name)));
    return {
      agentIds: loaded,
      notLoaded: loaded.length
        ? null
        : "Claude Code has it disabled in the directory of every selected agent (disabledMcpServers), so it never ran",
    };
  };
  readClaudeUserEntries(discovery, userConfig, ids(claude), userLoadedBy, claudeAgentsByCwd, cwds);

  const pluginLoadedBy = loadedByAll(
    ids(claude),
    "only Claude Code loads plugin servers, and no selected agent runs on Claude",
  );
  const pluginDirs = input.pluginDirs ?? defaultMcpImportPluginDirs(input.homeDir, input.fs);
  for (const pluginRoot of [...pluginDirs].sort()) {
    readPlugin(discovery, input.fs, pluginRoot, ids(claude), pluginLoadedBy);
  }

  const codexHome = input.codexHome?.trim() ? expandHomeIn(input.codexHome.trim(), input.homeDir) : null;
  readCodexFile(
    discovery,
    input.fs,
    "codex-home",
    join(codexHome ?? join(input.homeDir, ".codex"), "config.toml"),
    ids(codex),
    loadedByAll(ids(codex), "only Codex reads this file, and no selected agent runs on Codex"),
    input.parseToml,
  );
  for (const cwd of cwds) {
    const here = ids(codex.filter((agent) => agent.cwd === cwd));
    readCodexFile(
      discovery,
      input.fs,
      "codex-project",
      join(cwd, ".codex", "config.toml"),
      here,
      loadedByAll(here, "only Codex reads this file, and no selected agent in this directory runs on Codex"),
      input.parseToml,
    );
  }
  return discovery;
}

// ============================================================================
// Names
// ============================================================================

/**
 * The registry name of a native entry: lower case, underscores and every
 * other character outside `[a-z0-9-]` become hyphens, repeats collapse, edge
 * hyphens go. A result outside the name grammar (or reserved) needs `--as`.
 */
export function normalizeMcpImportName(nativeName: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = nativeName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const checked = checkMcpServerName(name);
  if (checked.ok) return { ok: true, name: checked.name };
  return { ok: false, reason: checked.error.message };
}

/** The grant prefix a native name had and the one the registered server gets. */
export function mcpImportPermissionNames(nativeName: string, name: string): { from: string; to: string } {
  return { from: `${MCP_TOOL_NAME_PREFIX}${nativeName}__*`, to: `${MCP_TOOL_NAME_PREFIX}${name}__*` };
}

// ============================================================================
// Matching against the registry
// ============================================================================

/** What the registry shows of a server, without secrets. */
export interface McpImportRegisteredView {
  name: string;
  origin: string;
  transport: McpTransport;
  urlDisplay: string | null;
  command: string | null;
  args: readonly string[];
  envKeys: readonly string[];
}

/** A registered server with its secret document, read by the CLI to compare full values. */
export interface McpImportRegistered extends McpImportRegisteredView {
  secret: McpServerSecret | null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Whether a registered server shows the same configuration as the entry,
 * judged on what `ravi.db` holds (display URL, command, args, env key names).
 * Two URLs that differ only in an elided token look the same here, so this is
 * for reports (`ravi doctor`); registration compares full values.
 */
export function mcpEntryMatchesDisplay(entry: NativeMcpEntry, server: McpImportRegisteredView): boolean {
  if (entry.unsupported || entry.transport !== server.transport) return false;
  if (entry.transport === "http") {
    try {
      return entry.url !== null && mcpDisplayUrl(entry.url) === server.urlDisplay;
    } catch {
      // no-cause: an entry URL that does not parse matches no server.
      return false;
    }
  }
  return (
    entry.command === server.command &&
    sameList(entry.args, server.args) &&
    sameList(Object.keys(entry.env).sort(), [...server.envKeys].sort())
  );
}

/** Whether a registered server holds exactly the entry's configuration, secrets included. */
function mcpEntryMatchesFully(entry: NativeMcpEntry, server: McpImportRegistered): boolean {
  if (!mcpEntryMatchesDisplay(entry, server) || !server.secret) return false;
  if (entry.transport === "http") return server.secret.url === entry.url;
  const stored = server.secret.env ?? {};
  const keys = Object.keys(entry.env).sort();
  return sameList(keys, Object.keys(stored).sort()) && keys.every((key) => stored[key] === entry.env[key]);
}

/** The full configuration of an entry, for comparing two entries in memory. */
function entryConfigKey(entry: NativeMcpEntry): string {
  return JSON.stringify([
    entry.transport,
    entry.url,
    entry.command,
    entry.args,
    Object.entries(entry.env).sort(([a], [b]) => a.localeCompare(b)),
    entry.enabled,
  ]);
}

// ============================================================================
// Plan
// ============================================================================

export interface McpImportEntryRef {
  kind: McpImportSourceKind;
  path: string;
  scope: string | null;
  nativeName: string;
}

export interface McpImportServerPlan {
  name: string;
  /** `register` a new server; `attach` agents to a server already registered; `unchanged` when nothing is left to do. */
  action: "register" | "attach" | "unchanged";
  transport: McpTransport;
  urlDisplay: string | null;
  command: string | null;
  args: string[];
  envKeys: string[];
  enabled: boolean;
  origin: string;
  /** Every agent the entries reached. */
  agents: string[];
  /** The agents this import attaches (audience operator). */
  attach: string[];
  from: McpImportEntryRef[];
  permissions: Array<{ from: string; to: string }>;
  /** Secret values that move to the credentials store, by name (`url`, `env KEY`). */
  moves: string[];
  notes: string[];
}

export interface McpImportConflict {
  code: "invalid_name" | "name_collision" | "already_registered";
  name: string | null;
  message: string;
  from: McpImportEntryRef[];
}

export interface McpImportSkipped extends McpImportEntryRef {
  reason: string;
}

export interface McpImportPlan {
  servers: McpImportServerPlan[];
  conflicts: McpImportConflict[];
  unsupported: McpImportSkipped[];
  skipped: McpImportSkipped[];
  /** The secret document each `register` server writes. Never printed. */
  secrets: Map<string, McpServerSecret>;
}

export interface PlanMcpImportInput {
  entries: readonly NativeMcpEntry[];
  /** `--as old=new`, keyed by native name or by `<source kind>:<native name>` (which wins). */
  renames?: ReadonlyMap<string, string>;
  /** `--skip <name>`: a native name, or `<source kind>:<native name>`. */
  skip?: ReadonlySet<string>;
  registered: readonly McpImportRegistered[];
  /** Agents already attached, per server name. */
  attached: ReadonlyMap<string, ReadonlySet<string>>;
}

function refOf(entry: NativeMcpEntry): McpImportEntryRef {
  return { kind: entry.kind, path: entry.path, scope: entry.scope, nativeName: entry.nativeName };
}

/**
 * The qualified key of an entry, `<source kind>:<native name>`, for `--as`
 * and `--skip` when one native name appears in several sources.
 */
export function mcpImportEntryKey(entry: Pick<NativeMcpEntry, "kind" | "nativeName">): string {
  return `${entry.kind}:${entry.nativeName}`;
}

export function mcpImportOrigin(path: string): string {
  return `import:${path}`;
}

/**
 * Plan the registrations for the importable entries. Entries that normalize
 * to the same name merge when their configuration is identical; otherwise
 * they collide and need `--as`. An entry identical to a registered server
 * (secrets included) only attaches the missing agents to it; a registered
 * name with another configuration is a conflict.
 */
export function planMcpImport(input: PlanMcpImportInput): McpImportPlan {
  const plan: McpImportPlan = { servers: [], conflicts: [], unsupported: [], skipped: [], secrets: new Map() };
  const renames = input.renames ?? new Map<string, string>();
  const skip = input.skip ?? new Set<string>();
  const groups = new Map<string, NativeMcpEntry[]>();

  for (const entry of input.entries) {
    // An entry no runtime loaded is never registered: importing it would widen what agents reach.
    if (entry.agentIds.length === 0) {
      plan.skipped.push({ ...refOf(entry), reason: entry.notLoaded ?? "no selected agent loads this entry" });
      continue;
    }
    if (entry.unsupported) {
      plan.unsupported.push({ ...refOf(entry), reason: entry.unsupported });
      continue;
    }
    if (skip.has(entry.nativeName) || skip.has(mcpImportEntryKey(entry))) {
      plan.skipped.push({ ...refOf(entry), reason: "skipped with --skip" });
      continue;
    }
    const renamed = renames.get(mcpImportEntryKey(entry)) ?? renames.get(entry.nativeName);
    let name: string;
    if (renamed !== undefined) {
      const checked = checkMcpServerName(renamed);
      if (!checked.ok) {
        plan.conflicts.push({ code: "invalid_name", name: null, message: checked.error.message, from: [refOf(entry)] });
        continue;
      }
      name = checked.name;
    } else {
      const normalized = normalizeMcpImportName(entry.nativeName);
      if (!normalized.ok) {
        plan.conflicts.push({
          code: "invalid_name",
          name: null,
          message: `${JSON.stringify(entry.nativeName)} has no valid registry name (${normalized.reason}); give one with --as ${entry.nativeName}=<name>.`,
          from: [refOf(entry)],
        });
        continue;
      }
      name = normalized.name;
    }
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }

  const registeredByName = new Map(input.registered.map((server) => [server.name, server]));
  const byName = new Map<string, McpImportServerPlan>();
  for (const [name, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = entries[0]!;
    if (entries.some((entry) => entryConfigKey(entry) !== entryConfigKey(first))) {
      plan.conflicts.push({
        code: "name_collision",
        name,
        message: `Entries with different configurations all become "${name}"; rename them with --as <native>=<name> (or --as <source kind>:<native>=<name> when they share a native name), or leave some out with --skip.`,
        from: entries.map(refOf),
      });
      continue;
    }
    const agents = [...new Set(entries.flatMap((entry) => entry.agentIds))].sort();
    const from = entries.map(refOf);
    const notes = [...new Set(entries.flatMap((entry) => entry.notes))];
    const sameAsRegistered = input.registered.find((server) => mcpEntryMatchesFully(first, server));
    const target = sameAsRegistered?.name ?? name;
    if (!sameAsRegistered && registeredByName.has(name)) {
      plan.conflicts.push({
        code: "already_registered",
        name,
        message: `A different MCP server is already registered as "${name}"; import this one under another name with --as, or leave it out with --skip.`,
        from,
      });
      continue;
    }
    const permissions = [
      ...new Map(
        entries.map((entry) => {
          const names = mcpImportPermissionNames(entry.nativeName, target);
          return [`${names.from}\0${names.to}`, names] as const;
        }),
      ).values(),
    ];
    const existing = byName.get(target);
    if (existing) {
      // Two groups that resolve to one registered server.
      existing.agents = [...new Set([...existing.agents, ...agents])].sort();
      existing.from.push(...from);
      existing.permissions.push(...permissions.filter((p) => !existing.permissions.some((q) => q.from === p.from)));
      existing.notes = [...new Set([...existing.notes, ...notes])];
      continue;
    }
    const registered = sameAsRegistered ?? null;
    const transport = first.transport as McpTransport;
    const server: McpImportServerPlan = {
      name: target,
      action: registered ? "attach" : "register",
      transport,
      urlDisplay: transport === "http" ? mcpDisplayUrl(first.url as string) : null,
      command: transport === "stdio" ? first.command : null,
      args: transport === "stdio" ? [...first.args] : [],
      envKeys: Object.keys(first.env).sort(),
      enabled: registered ? true : first.enabled,
      origin: registered ? registered.origin : mcpImportOrigin(first.path),
      agents,
      attach: [],
      from,
      permissions,
      moves: registered
        ? []
        : transport === "http"
          ? ["url"]
          : Object.keys(first.env)
              .sort()
              .map((key) => `env ${key}`),
      notes: registered && registered.name !== name ? [`already registered as ${registered.name}`, ...notes] : notes,
    };
    if (!registered) {
      plan.secrets.set(target, transport === "http" ? { url: first.url as string } : { env: { ...first.env } });
    }
    byName.set(target, server);
    plan.servers.push(server);
  }

  for (const server of plan.servers) {
    const attached = input.attached.get(server.name) ?? new Set<string>();
    server.attach = server.agents.filter((agentId) => !attached.has(agentId));
    if (server.action === "attach" && server.attach.length === 0) server.action = "unchanged";
  }
  plan.servers.sort((a, b) => a.name.localeCompare(b.name));
  return plan;
}

// ============================================================================
// Doctor
// ============================================================================

export interface NativeMcpUnregistered extends McpImportEntryRef {
  transport: McpTransport | null;
  agentIds: string[];
  /** Why the entry cannot be imported as it is, or null when `ravi mcp import` can take it. */
  unsupported: string | null;
}

/**
 * The native entries a runtime loaded that no registered server covers
 * (judged on display values), and the sources that could not be read.
 * Runtimes no longer load either. Entries no runtime ever loaded are left out.
 */
export function findUnregisteredNativeMcpEntries(
  discovery: NativeMcpDiscovery,
  registered: readonly McpImportRegisteredView[],
): { unregistered: NativeMcpUnregistered[]; invalidSources: McpImportSource[] } {
  const unregistered = discovery.entries
    .filter((entry) => entry.agentIds.length > 0)
    .filter((entry) => !registered.some((server) => mcpEntryMatchesDisplay(entry, server)))
    .map((entry) => ({
      ...refOf(entry),
      transport: entry.transport,
      agentIds: [...entry.agentIds],
      unsupported: entry.unsupported,
    }));
  return { unregistered, invalidSources: discovery.sources.filter((source) => source.status === "invalid") };
}
