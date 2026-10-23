/**
 * The sandbox side of the Console's Ravi provider (F4 prototype, behind
 * `RAVI_CLOUD_PROVIDER_RAVI=1` on the Console). The Console starts an E2B
 * sandbox from the `ravi-cloud-worker` template with `ravi cloud worker
 * session` and these variables; this loop runs the agent with the Claude Agent
 * SDK and speaks the Console's callback protocol:
 *
 *   RAVI_SESSION_CALLBACK_URL  https://<console>/api/cloud-agents/ravi-provider/sessions/<id>
 *   RAVI_SESSION_TOKEN         per-session bearer (only its hash is stored)
 *   ANTHROPIC_API_KEY          the model key the runtime uses
 *
 *   GET  <callback>/inbox?spec=1&ack=<id>,<id>
 *        -> { session: { id, status }, items: InboxItem[], spec? }
 *        Items stay until acknowledged (`ack`, at most 100 per pull).
 *        InboxItem: { id, at, type: "message", text }
 *                 | { id, at, type: "confirmation", toolUseId, allow, message? }
 *                 | { id, at, type: "custom_tool_result", toolUseId, text, isError }
 *                 | { id, at, type: "interrupt" } | { id, at, type: "vault_updated" }  (read the spec again)
 *        spec: { title, agent: { model, system, effort, webSearch, webFetch, web, mcpServers,
 *                customTools }, skills: [{ directory, files }], budgetCents, credentials: [{ serverUrl,
 *                accessToken }] }
 *   POST <callback>/events   { events: [{ id, at, event }] (<= 100), usage }
 *        event = the Console's normalized ProviderEvent without id and at; `id` is unique per
 *        event (the Console dedupes on it; `rvc_` is reserved for the Console's own events).
 *   POST <callback>/outputs  raw bytes (<= 20 MB), name in `x-ravi-output-name`, content-type set
 *
 * Every call carries `Authorization: Bearer <RAVI_SESSION_TOKEN>`. A tool the
 * spec marks `ask` is reported as a `tool_use` event with permission `ask`
 * plus an idle `requires_action` status, and runs only after the matching
 * `confirmation` arrives. `ask_human` is an in-process tool reported as
 * `custom_tool_use` and answered by `custom_tool_result`. The loop ends when
 * the session is terminated, deleted or gone (401/404/409/410 after the first
 * contact). The token and callback URL are removed from the environment the
 * agent's tools see.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative } from "node:path";

export const RAVI_SESSION_CALLBACK_ENV = "RAVI_SESSION_CALLBACK_URL";
export const RAVI_SESSION_TOKEN_ENV = "RAVI_SESSION_TOKEN";
export const RAVI_SESSION_OUTPUTS_DIR = "/mnt/session/outputs";
export const RAVI_SESSION_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
/** The in-process MCP server that carries `ask_human`. */
export const ASK_HUMAN_SERVER = "ravi_session";
const ASK_HUMAN_TOOL = "ask_human";
const TOOL_RESULT_MAX_CHARS = 2_000;
const MESSAGE_MAX_CHARS = 50_000;
const ERROR_MAX_CHARS = 500;
const MAX_EVENTS_PER_POST = 100;
/** Extra tries for an output upload that failed, before the turn reports it missing. */
const OUTPUT_UPLOAD_RETRIES = 3;
const MAX_ACKS_PER_PULL = 100;
const MAX_OUTPUT_FILES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const SKILL_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface RaviSessionMcpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  /** `ask`: every tool waits for a person, except `allowTools`. `allow`: every tool runs, except `askTools`. */
  permission: "ask" | "allow";
  allowTools: string[];
  askTools: string[];
}

/** What the session runs (from `inbox.spec`), normalized. */
export interface RaviSessionSpec {
  title: string;
  model: string;
  system: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  mcpServers: RaviSessionMcpServer[];
  webSearch: boolean;
  webFetch: boolean;
  web: { allowedDomains: string[]; blockedDomains: string[] };
  askHuman: boolean;
  askHumanDescription: string | null;
  skills: Array<{ directory: string; files: Array<{ path: string; content: string }> }>;
  /** The run's budget; the runtime stops a turn when the session's cost reaches it. */
  budgetUsd: number | null;
  outputsDir: string;
}

export type RaviSessionStatus = "rescheduling" | "running" | "idle" | "terminated";
export type RaviStopReason =
  | { type: "end_turn" }
  | { type: "requires_action"; eventIds: string[] }
  | { type: "budget_reached" }
  | { type: "other"; raw: string };

export type RaviSessionEvent =
  | { kind: "message"; role: "agent" | "user"; text: string }
  | {
      kind: "tool_use";
      tool: string;
      server: string | null;
      input: unknown;
      permission: "allow" | "ask" | "deny" | null;
    }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { kind: "status"; status: RaviSessionStatus; stopReason: RaviStopReason | null }
  | { kind: "error"; errorType: string; message: string; retrying: boolean }
  | { kind: "custom_tool_use"; tool: string; input: unknown };

export interface RaviSessionEventEntry {
  id: string;
  at: string;
  event: RaviSessionEvent;
}

export interface RaviSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  listCostCents: number | null;
  activeSeconds: number;
}

type InboxItem =
  | { id: string; type: "message"; text: string }
  | { id: string; type: "confirmation"; toolUseId: string; allow: boolean; message: string | null }
  | { id: string; type: "custom_tool_result"; toolUseId: string; text: string; isError: boolean }
  | { id: string; type: "interrupt" }
  | { id: string; type: "vault_updated" };

export type ToolDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** One agent turn: the messages the runtime streams (Claude Agent SDK `SDKMessage` shapes). */
export type RunAgentTurn = (input: {
  prompt: string;
  spec: RaviSessionSpec;
  resume: string | null;
  abortController: AbortController;
  env: Record<string, string>;
  /** What is left of the run's budget, in US$ (null: no budget). */
  maxBudgetUsd: number | null;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID: string },
  ) => Promise<ToolDecision>;
  askHuman: ((input: { question: string; options?: string[] }) => Promise<string>) | null;
}) => AsyncIterable<unknown>;

export interface WorkerSessionDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  runTurn?: RunAgentTurn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Inbox poll interval during a turn (default 1 s; idle polls back off to 5 s). */
  pollMs?: number;
  /** Where the agent leaves files to upload (default /mnt/session/outputs). */
  outputsDir?: string;
  log?: (line: string) => void;
}

export interface WorkerSessionResult {
  status: "terminated";
  turns: number;
  eventsPosted: number;
  outputsUploaded: number;
}

export class WorkerSessionError extends Error {
  constructor(
    readonly code: "SESSION_ENV_MISSING" | "SESSION_CALLBACK_INVALID" | "SESSION_UNAUTHORIZED",
    message: string,
  ) {
    super(message);
    this.name = "WorkerSessionError";
  }
}

/** The callback URL and token, or why they are unusable (https only; http only for localhost). */
export function readWorkerSessionEnv(env: NodeJS.ProcessEnv): { callbackUrl: string; token: string } {
  const rawUrl = env[RAVI_SESSION_CALLBACK_ENV]?.trim() ?? "";
  const token = env[RAVI_SESSION_TOKEN_ENV]?.trim() ?? "";
  if (!rawUrl || !token) {
    throw new WorkerSessionError(
      "SESSION_ENV_MISSING",
      `${RAVI_SESSION_CALLBACK_ENV} and ${RAVI_SESSION_TOKEN_ENV} are set by the Console when it starts the sandbox.`,
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WorkerSessionError("SESSION_CALLBACK_INVALID", `${RAVI_SESSION_CALLBACK_ENV} is not a URL.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search
  ) {
    throw new WorkerSessionError(
      "SESSION_CALLBACK_INVALID",
      `${RAVI_SESSION_CALLBACK_ENV} must be an https URL without credentials or a query string.`,
    );
  }
  return { callbackUrl: url.toString().replace(/\/+$/, ""), token };
}

// ---------------------------------------------------------------------------
// Normalizing the Console's spec and inbox (data, never instructions)

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A skill file path inside its directory: relative, no `..`, no absolute paths. */
function safeRelativePath(path: string): string | null {
  const clean = normalize(path).replace(/^(\.\/)+/, "");
  if (!clean || clean.startsWith("/") || clean.startsWith("..") || clean.includes("\0")) return null;
  return clean;
}

export function parseSessionSpec(value: unknown): RaviSessionSpec | null {
  const spec = record(value);
  const agent = record(spec?.agent);
  if (!spec || !agent || typeof agent.model !== "string" || !agent.model) return null;
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const tokens = new Map<string, string>();
  for (const entry of Array.isArray(spec.credentials) ? spec.credentials : []) {
    const credential = record(entry);
    if (typeof credential?.serverUrl === "string" && typeof credential.accessToken === "string") {
      tokens.set(credential.serverUrl, credential.accessToken);
    }
  }
  const web = record(agent.web) ?? {};
  const askHumanTool = (Array.isArray(agent.customTools) ? agent.customTools : [])
    .map(record)
    .find((tool) => tool?.name === ASK_HUMAN_TOOL);
  const budgetCents = typeof spec.budgetCents === "number" && spec.budgetCents > 0 ? spec.budgetCents : null;
  return {
    title: typeof spec.title === "string" ? spec.title : "",
    model: agent.model,
    system: typeof agent.system === "string" ? agent.system : "",
    effort: efforts.includes(String(agent.effort)) ? (agent.effort as RaviSessionSpec["effort"]) : null,
    mcpServers: (Array.isArray(agent.mcpServers) ? agent.mcpServers : []).flatMap((entry) => {
      const server = record(entry);
      if (!server || typeof server.name !== "string" || typeof server.url !== "string") return [];
      if (server.name === ASK_HUMAN_SERVER || !/^https:\/\//.test(server.url)) return [];
      const token = tokens.get(server.url);
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      return [
        {
          name: server.name,
          url: server.url,
          headers,
          permission: server.permission === "allow" ? ("allow" as const) : ("ask" as const),
          allowTools: strings(server.allowTools),
          askTools: strings(server.askTools),
        },
      ];
    }),
    webSearch: agent.webSearch === true,
    webFetch: agent.webFetch === true,
    web: { allowedDomains: strings(web.allowedDomains), blockedDomains: strings(web.blockedDomains) },
    askHuman: askHumanTool !== undefined,
    askHumanDescription: typeof askHumanTool?.description === "string" ? askHumanTool.description : null,
    skills: (Array.isArray(spec.skills) ? spec.skills : []).flatMap((entry) => {
      const skill = record(entry);
      if (typeof skill?.directory !== "string" || !SKILL_DIRECTORY.test(skill.directory)) return [];
      const files = (Array.isArray(skill.files) ? skill.files : []).flatMap((file) => {
        const item = record(file);
        const path = typeof item?.path === "string" ? safeRelativePath(item.path) : null;
        return path && typeof item?.content === "string" ? [{ path, content: item.content }] : [];
      });
      return files.length > 0 ? [{ directory: skill.directory, files }] : [];
    }),
    budgetUsd: budgetCents === null ? null : budgetCents / 100,
    outputsDir: RAVI_SESSION_OUTPUTS_DIR,
  };
}

function parseInboxItem(value: unknown): InboxItem | null {
  const item = record(value);
  if (!item || typeof item.type !== "string" || typeof item.id !== "string" || !item.id) return null;
  const id = item.id;
  switch (item.type) {
    case "message":
      return typeof item.text === "string" && item.text.trim()
        ? { id, type: "message", text: item.text.slice(0, MESSAGE_MAX_CHARS) }
        : null;
    case "confirmation":
      return typeof item.toolUseId === "string"
        ? {
            id,
            type: "confirmation",
            toolUseId: item.toolUseId,
            allow: item.allow === true,
            message: typeof item.message === "string" ? item.message.slice(0, 2_000) : null,
          }
        : null;
    case "custom_tool_result":
      return typeof item.toolUseId === "string"
        ? {
            id,
            type: "custom_tool_result",
            toolUseId: item.toolUseId,
            text: typeof item.text === "string" ? item.text.slice(0, MESSAGE_MAX_CHARS) : "",
            isError: item.isError === true,
          }
        : null;
    case "interrupt":
    case "vault_updated":
      return { id, type: item.type };
    default:
      return null;
  }
}

/** `mcp__<server>__<tool>` -> server and tool; built-in tools have no server. */
export function splitToolName(name: string): { server: string | null; tool: string } {
  const match = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : { server: null, tool: name };
}

/**
 * Whether a tool runs, waits for a person or is refused. Built-in tools act
 * inside the sandbox and run (web tools only when the spec enables them); MCP
 * tools follow their server's permission; unknown MCP servers are refused.
 */
export function toolPermission(spec: RaviSessionSpec, toolName: string): "allow" | "ask" | "deny" {
  const { server, tool } = splitToolName(toolName);
  if (server === null) {
    if (tool === "WebSearch") return spec.webSearch ? "allow" : "deny";
    if (tool === "WebFetch") return spec.webFetch ? "allow" : "deny";
    return "allow";
  }
  if (server === ASK_HUMAN_SERVER) return spec.askHuman && tool === ASK_HUMAN_TOOL ? "allow" : "deny";
  const config = spec.mcpServers.find((entry) => entry.name === server);
  if (!config) return "deny";
  if (config.askTools.includes(tool)) return "ask";
  if (config.permission === "allow") return "allow";
  return config.allowTools.includes(tool) ? "allow" : "ask";
}

/** An entry is a domain (optionally `*.`) with an optional path: `docs.example.org/api` covers `/api` and below. */
function domainMatches(url: URL, domains: string[]): boolean {
  const name = url.hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => {
    const slash = domain.indexOf("/");
    const d = (slash < 0 ? domain : domain.slice(0, slash)).toLowerCase().replace(/^\*\./, "");
    if (name !== d && !name.endsWith(`.${d}`)) return false;
    const path = slash < 0 ? "" : domain.slice(slash).replace(/\/+$/, "");
    return !path || url.pathname === path || url.pathname.startsWith(`${path}/`);
  });
}

/**
 * The agent's web domain filters: WebFetch to a host outside the allowed list
 * (or inside the blocked one) is refused; WebSearch gets the lists as its
 * `allowed_domains` / `blocked_domains`.
 */
export function applyWebFilters(spec: RaviSessionSpec, toolName: string, input: Record<string, unknown>): ToolDecision {
  const { allowedDomains, blockedDomains } = spec.web;
  if (toolName === "WebFetch" && (allowedDomains.length > 0 || blockedDomains.length > 0)) {
    let url: URL;
    try {
      url = new URL(String(input.url ?? ""));
    } catch {
      return { behavior: "deny", message: "WebFetch needs a valid URL." };
    }
    const host = url.hostname;
    if (allowedDomains.length > 0 && !domainMatches(url, allowedDomains)) {
      return { behavior: "deny", message: `${host} is not in this agent's allowed web domains.` };
    }
    if (domainMatches(url, blockedDomains)) {
      return { behavior: "deny", message: `${host} is in this agent's blocked web domains.` };
    }
  }
  if (toolName === "WebSearch") {
    if (allowedDomains.length > 0)
      return { behavior: "allow", updatedInput: { ...input, allowed_domains: allowedDomains } };
    if (blockedDomains.length > 0)
      return { behavior: "allow", updatedInput: { ...input, blocked_domains: blockedDomains } };
  }
  return { behavior: "allow", updatedInput: input };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const entry = record(block);
      return entry && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// ---------------------------------------------------------------------------
// The session loop

export async function runWorkerSession(deps: WorkerSessionDeps = {}): Promise<WorkerSessionResult> {
  const env = deps.env ?? process.env;
  const { callbackUrl, token } = readWorkerSessionEnv(env);
  // The agent's tools never see the callback credentials.
  delete env[RAVI_SESSION_TOKEN_ENV];
  delete env[RAVI_SESSION_CALLBACK_ENV];
  const session = new WorkerSession(callbackUrl, token, env, deps);
  return session.run();
}

class WorkerSession {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly prefix = randomUUID().slice(0, 8);
  private seq = 0;
  private spec: RaviSessionSpec | null = null;
  private needSpec = true;
  private contacted = false;
  private terminated = false;
  private readonly seenItems = new Set<string>();
  private readonly pendingAcks = new Set<string>();
  private readonly messages: string[] = [];
  private readonly confirmations = new Map<string, Extract<InboxItem, { type: "confirmation" }>>();
  private readonly customResults = new Map<string, Extract<InboxItem, { type: "custom_tool_result" }>>();
  private readonly emittedToolUses = new Set<string>();
  private buffer: RaviSessionEventEntry[] = [];
  private readonly usage: RaviSessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    listCostCents: 0,
    activeSeconds: 0,
  };
  private readonly uploaded = new Map<string, string>();
  private readonly warnedLargeOutputs = new Set<string>();
  private activeTurn: AbortController | null = null;
  private resume: string | null = null;
  private turns = 0;
  private eventsPosted = 0;
  private outputsUploaded = 0;

  constructor(
    private readonly callbackUrl: string,
    private readonly token: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly deps: WorkerSessionDeps,
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.pollMs = deps.pollMs ?? 1_000;
  }

  async run(): Promise<WorkerSessionResult> {
    let idlePolls = 0;
    // The first pull authenticates and brings the spec.
    await this.pollOnce();
    if (!this.terminated) {
      this.emitStatus("idle", { type: "end_turn" });
      await this.flush();
    }
    while (!this.terminated) {
      // A message waits in the queue until the spec has arrived.
      const prompt = this.spec ? this.messages.shift() : undefined;
      if (prompt !== undefined) {
        idlePolls = 0;
        await this.runTurn(prompt);
        continue;
      }
      // Events a failed post kept (the turn's final status among them) go out while idle too.
      if (this.buffer.length > 0) await this.flush();
      if (this.terminated) break;
      const received = await this.pollOnce();
      if (this.terminated) break;
      if (received === 0) {
        idlePolls += 1;
        await this.sleep(Math.min(this.pollMs * idlePolls, 5_000));
      }
    }
    return {
      status: "terminated",
      turns: this.turns,
      eventsPosted: this.eventsPosted,
      outputsUploaded: this.outputsUploaded,
    };
  }

  // -------------------------------------------------------------------------
  // One turn

  private async runTurn(prompt: string): Promise<void> {
    const spec = this.spec!;
    const remaining = this.remainingBudgetUsd(spec);
    if (remaining !== null && remaining <= 0) {
      this.emit({ kind: "error", errorType: "budget_reached", message: "The run's budget is spent.", retrying: false });
      this.emitStatus("idle", { type: "budget_reached" });
      await this.flush();
      return;
    }
    const runTurn = this.deps.runTurn ?? defaultRunAgentTurn;
    const abortController = new AbortController();
    this.activeTurn = abortController;
    this.turns += 1;
    this.emitStatus("running", null);
    await this.flush();
    const polling = this.pollWhile(abortController.signal);
    let stopReason: RaviStopReason = { type: "end_turn" };
    try {
      const stream = runTurn({
        prompt,
        spec,
        resume: this.resume,
        abortController,
        env: this.agentEnv(),
        maxBudgetUsd: remaining,
        canUseTool: (toolName, input, options) => this.canUseTool(spec, toolName, input, options.toolUseID),
        askHuman: spec.askHuman ? (input) => this.askHuman(input) : null,
      });
      for await (const message of stream) {
        const reason = this.consume(spec, message);
        if (reason) stopReason = reason;
        await this.flush();
        if (this.terminated) break;
      }
      if (abortController.signal.aborted) stopReason = { type: "other", raw: "interrupted" };
    } catch (error) {
      if (abortController.signal.aborted) {
        stopReason = { type: "other", raw: "interrupted" };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          kind: "error",
          errorType: "runtime_error",
          message: clip(message, ERROR_MAX_CHARS),
          retrying: false,
        });
        stopReason = { type: "other", raw: "runtime_error" };
      }
    } finally {
      this.activeTurn = null;
      abortController.abort();
      await polling;
    }
    if (this.terminated) return;
    // The turn reports completion only after its outputs are up, or names the ones that are not.
    let missing = await this.uploadOutputs(spec);
    for (let attempt = 1; missing.length > 0 && attempt <= OUTPUT_UPLOAD_RETRIES && !this.terminated; attempt += 1) {
      await this.sleep(this.pollMs * 2 ** attempt);
      missing = await this.uploadOutputs(spec);
    }
    if (this.terminated) return;
    if (missing.length > 0) {
      this.emit({
        kind: "error",
        errorType: "output_upload_failed",
        message: clip(`Not uploaded after ${OUTPUT_UPLOAD_RETRIES + 1} tries: ${missing.join(", ")}`, 300),
        retrying: false,
      });
    }
    this.emitStatus("idle", stopReason);
    await this.flush();
  }

  private remainingBudgetUsd(spec: RaviSessionSpec): number | null {
    if (spec.budgetUsd === null) return null;
    return Math.round((spec.budgetUsd - (this.usage.listCostCents ?? 0) / 100) * 10_000) / 10_000;
  }

  /** Maps one runtime message to events; returns a stop reason when the turn reports one. */
  private consume(spec: RaviSessionSpec, value: unknown): RaviStopReason | null {
    const message = record(value);
    if (!message) return null;
    if (typeof message.session_id === "string" && message.session_id) this.resume = message.session_id;
    if (message.type === "assistant") {
      const content = record(message.message)?.content;
      if (!Array.isArray(content)) return null;
      for (const block of content) {
        const entry = record(block);
        if (!entry) continue;
        if (entry.type === "text" && typeof entry.text === "string" && entry.text.trim()) {
          this.emit({ kind: "message", role: "agent", text: clip(entry.text, MESSAGE_MAX_CHARS) });
        } else if (entry.type === "tool_use" && typeof entry.id === "string" && typeof entry.name === "string") {
          this.emitToolUse(spec, entry.id, entry.name, entry.input);
        }
      }
      return null;
    }
    if (message.type === "user") {
      const content = record(message.message)?.content;
      if (!Array.isArray(content)) return null;
      for (const block of content) {
        const entry = record(block);
        if (entry?.type !== "tool_result" || typeof entry.tool_use_id !== "string") continue;
        this.emit({
          kind: "tool_result",
          toolUseId: entry.tool_use_id,
          isError: entry.is_error === true,
          text: clip(contentText(entry.content), TOOL_RESULT_MAX_CHARS),
        });
      }
      return null;
    }
    if (message.type === "result") {
      this.addUsage(message);
      if (message.subtype === "success" && message.is_error !== true) return { type: "end_turn" };
      const subtype = typeof message.subtype === "string" ? message.subtype : "error";
      if (subtype === "error_max_budget_usd") return { type: "budget_reached" };
      this.emit({
        kind: "error",
        errorType: subtype,
        message: `The agent turn ended with ${subtype}.`,
        retrying: false,
      });
      return { type: "other", raw: subtype };
    }
    return null;
  }

  private addUsage(result: Record<string, unknown>): void {
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
    const models = record(result.modelUsage);
    const perModel = models
      ? Object.values(models)
          .map(record)
          .filter((entry) => entry !== null)
      : [];
    if (perModel.length > 0) {
      for (const model of perModel) {
        this.usage.inputTokens += number(model.inputTokens);
        this.usage.outputTokens += number(model.outputTokens);
        this.usage.cacheReadTokens += number(model.cacheReadInputTokens);
        this.usage.cacheWriteTokens += number(model.cacheCreationInputTokens);
      }
    } else {
      const usage = record(result.usage) ?? {};
      this.usage.inputTokens += number(usage.input_tokens);
      this.usage.outputTokens += number(usage.output_tokens);
      this.usage.cacheReadTokens += number(usage.cache_read_input_tokens);
      this.usage.cacheWriteTokens += number(usage.cache_creation_input_tokens);
    }
    this.usage.listCostCents =
      Math.round(((this.usage.listCostCents ?? 0) + number(result.total_cost_usd) * 100) * 1000) / 1000;
    this.usage.activeSeconds += Math.round(number(result.duration_ms) / 100) / 10;
  }

  private emitToolUse(spec: RaviSessionSpec, id: string, name: string, input: unknown): void {
    if (this.emittedToolUses.has(id)) return;
    this.emittedToolUses.add(id);
    const { server, tool } = splitToolName(name);
    if (server === ASK_HUMAN_SERVER) return; // reported as custom_tool_use by askHuman
    this.emit({ kind: "tool_use", tool, server, input, permission: toolPermission(spec, name) }, id);
  }

  private async canUseTool(
    spec: RaviSessionSpec,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<ToolDecision> {
    const permission = toolPermission(spec, toolName);
    this.emitToolUse(spec, toolUseId, toolName, input);
    if (permission === "deny") {
      await this.flush();
      return { behavior: "deny", message: `${splitToolName(toolName).tool} is not available to this agent.` };
    }
    if (permission === "allow") return applyWebFilters(spec, toolName, input);
    this.emitStatus("idle", { type: "requires_action", eventIds: [toolUseId] });
    await this.flush();
    const decision = await this.waitFor(() => this.confirmations.get(toolUseId));
    this.confirmations.delete(toolUseId);
    if (!this.terminated) {
      this.emitStatus("running", null);
      await this.flush();
    }
    if (decision?.allow) return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: decision?.message
        ? `A person denied this action: ${decision.message}`
        : decision
          ? "A person denied this action."
          : "The session ended before a person decided.",
    };
  }

  private async askHuman(input: { question: string; options?: string[] }): Promise<string> {
    const id = this.nextId();
    const question = clip(String(input.question ?? ""), 2_000);
    const options = (input.options ?? []).slice(0, 6).map((option) => clip(String(option), 200));
    this.emit(
      {
        kind: "custom_tool_use",
        tool: ASK_HUMAN_TOOL,
        input: options.length > 0 ? { question, options } : { question },
      },
      id,
    );
    this.emitStatus("idle", { type: "requires_action", eventIds: [id] });
    await this.flush();
    const answer = await this.waitFor(() => this.customResults.get(id));
    this.customResults.delete(id);
    if (!this.terminated) {
      this.emitStatus("running", null);
      await this.flush();
    }
    if (!answer) return "The session ended before anyone answered.";
    return answer.isError ? `No answer: ${answer.text}` : answer.text;
  }

  /** Waits (the turn's background poller reads the inbox) until `pick` finds the item, or the turn or session ends. */
  private async waitFor<T>(pick: () => T | undefined): Promise<T | undefined> {
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      if (this.terminated || !this.activeTurn || this.activeTurn.signal.aborted) return undefined;
      await this.sleep(this.pollMs);
    }
  }

  private async pollWhile(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.terminated) {
      await this.sleep(this.pollMs);
      if (signal.aborted || this.terminated) return;
      await this.pollOnce();
    }
  }

  // -------------------------------------------------------------------------
  // Console calls

  /** One inbox pull (acknowledging what was handled); returns how many new items arrived. */
  private async pollOnce(): Promise<number> {
    const acks = [...this.pendingAcks].slice(0, MAX_ACKS_PER_PULL);
    const query = new URLSearchParams();
    if (this.needSpec) query.set("spec", "1");
    if (acks.length > 0) query.set("ack", acks.join(","));
    const search = query.toString();
    let response: Response;
    try {
      response = await this.call(`${this.callbackUrl}/inbox${search ? `?${search}` : ""}`, { method: "GET" });
    } catch (error) {
      this.log(`inbox read failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    if (this.ended(response)) return 0;
    if (!response.ok) {
      this.log(`inbox read answered ${response.status}`);
      return 0;
    }
    this.contacted = true;
    for (const id of acks) this.pendingAcks.delete(id);
    const payload = record(await response.json().catch(() => null)) ?? {};
    if (record(payload.session)?.status === "terminated") {
      this.terminate();
      return 0;
    }
    if (payload.spec !== undefined) {
      const spec = parseSessionSpec(payload.spec);
      if (spec) {
        this.spec = this.deps.outputsDir ? { ...spec, outputsDir: this.deps.outputsDir } : spec;
        this.needSpec = false;
      } else {
        this.log("the session spec is unusable");
      }
    }
    let count = 0;
    for (const raw of Array.isArray(payload.items) ? payload.items : []) {
      const item = parseInboxItem(raw);
      if (!item || this.seenItems.has(item.id)) continue;
      this.seenItems.add(item.id);
      this.pendingAcks.add(item.id);
      count += 1;
      if (item.type === "message") this.messages.push(item.text);
      else if (item.type === "confirmation") this.confirmations.set(item.toolUseId, item);
      else if (item.type === "custom_tool_result") this.customResults.set(item.toolUseId, item);
      else if (item.type === "interrupt") this.activeTurn?.abort();
      else this.needSpec = true;
    }
    return count;
  }

  /**
   * Whether a response says the session is over. Before the first successful
   * call a refused token is an error; afterwards a refusal means the Console
   * deleted the session.
   */
  private ended(response: Response): boolean {
    const refused = response.status === 401 || response.status === 403;
    if (refused && !this.contacted) {
      throw new WorkerSessionError("SESSION_UNAUTHORIZED", "The Console refused the session token.");
    }
    if (refused || response.status === 404 || response.status === 409 || response.status === 410) {
      this.terminate();
      return true;
    }
    return false;
  }

  private terminate(): void {
    this.terminated = true;
    this.activeTurn?.abort();
  }

  /** Posts the buffered events (100 per call) with the usage; on failure they stay buffered for the next flush. */
  private async flush(): Promise<void> {
    while (this.buffer.length > 0 && !this.terminated) {
      const events = this.buffer.slice(0, MAX_EVENTS_PER_POST);
      try {
        const response = await this.call(`${this.callbackUrl}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events, usage: this.usage }),
        });
        if (this.ended(response)) return;
        if (!response.ok) throw new Error(`events answered ${response.status}`);
        this.contacted = true;
        this.buffer = this.buffer.slice(events.length);
        this.eventsPosted += events.length;
      } catch (error) {
        if (error instanceof WorkerSessionError) throw error;
        this.log(`event post failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

  /** Uploads new or changed outputs; returns the names whose upload failed (tried again later). */
  private async uploadOutputs(spec: RaviSessionSpec): Promise<string[]> {
    const failed: string[] = [];
    if (!existsSync(spec.outputsDir)) return failed;
    for (const path of listFiles(spec.outputsDir)) {
      if (this.terminated) return [];
      const name = relative(spec.outputsDir, path);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      const version = `${stats.size}:${stats.mtimeMs}`;
      if (this.uploaded.get(name) === version) continue;
      if (stats.size > RAVI_SESSION_OUTPUT_MAX_BYTES) {
        if (!this.warnedLargeOutputs.has(name)) {
          this.warnedLargeOutputs.add(name);
          this.emit({
            kind: "error",
            errorType: "output_too_large",
            message: clip(`${name} is larger than 20 MB and was not uploaded.`, 300),
            retrying: false,
          });
        }
        continue;
      }
      try {
        const response = await this.call(`${this.callbackUrl}/outputs`, {
          method: "POST",
          headers: {
            "content-type": MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
            "x-ravi-output-name": encodeURIComponent(name),
          },
          body: readFileSync(path),
        });
        if (this.ended(response)) return [];
        if (!response.ok) throw new Error(`outputs answered ${response.status}`);
        this.uploaded.set(name, version);
        this.outputsUploaded += 1;
      } catch (error) {
        if (error instanceof WorkerSessionError) throw error;
        this.log(`output upload failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
        failed.push(name);
      }
    }
    return failed;
  }

  private call(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    return this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  // -------------------------------------------------------------------------

  private agentEnv(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[0] !== RAVI_SESSION_TOKEN_ENV && entry[0] !== RAVI_SESSION_CALLBACK_ENV,
      ),
    );
  }

  private nextId(): string {
    this.seq += 1;
    return `rs-${this.prefix}-${this.seq}`;
  }

  private emit(event: RaviSessionEvent, id?: string): void {
    const now = (this.deps.now ?? (() => new Date()))();
    this.buffer.push({ id: id ?? this.nextId(), at: now.toISOString(), event });
  }

  private emitStatus(status: RaviSessionStatus, stopReason: RaviStopReason | null): void {
    this.emit({ kind: "status", status, stopReason });
  }

  private log(line: string): void {
    (this.deps.log ?? ((text: string) => console.error(`[ravi cloud worker session] ${text}`)))(line);
  }
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || files.length >= MAX_OUTPUT_FILES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_OUTPUT_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root, 0);
  return files.sort();
}

/**
 * The session's skills as a local plugin (`<dir>/skills/<directory>/...`),
 * written again before every turn so the agent's edits to it never persist.
 */
function writeSkillsPlugin(spec: RaviSessionSpec, dir: string): string | null {
  if (spec.skills.length === 0) return null;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ravi-session-skills", version: "1.0.0", description: "Skills of this cloud agent" }),
  );
  for (const skill of spec.skills) {
    for (const file of skill.files) {
      const path = join(dir, "skills", skill.directory, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.content);
    }
  }
  return dir;
}

const SKILLS_PLUGIN_DIR = join(tmpdir(), `ravi-session-skills-${process.pid}`);

/** The Claude Agent SDK, with the Console MCP and `ask_human` as MCP servers and Ravi's permission gate. */
const defaultRunAgentTurn: RunAgentTurn = async function* (input) {
  const [sdk, { z }, { resolveClaudeCodeExecutable }] = await Promise.all([
    import("@anthropic-ai/claude-agent-sdk"),
    import("zod"),
    import("../runtime/claude-provider.js"),
  ]);
  const mcpServers: Record<string, import("@anthropic-ai/claude-agent-sdk").McpServerConfig> = {};
  for (const server of input.spec.mcpServers) {
    mcpServers[server.name] = { type: "http", url: server.url, headers: server.headers };
  }
  const askHuman = input.askHuman;
  if (askHuman) {
    mcpServers[ASK_HUMAN_SERVER] = sdk.createSdkMcpServer({
      name: ASK_HUMAN_SERVER,
      version: "1.0.0",
      tools: [
        sdk.tool(
          ASK_HUMAN_TOOL,
          input.spec.askHumanDescription ??
            "Ask the person this run acts for a question and wait for the answer. Use it only when you cannot continue without them.",
          { question: z.string().min(1).max(2_000), options: z.array(z.string().max(200)).max(6).optional() },
          async (args) => ({ content: [{ type: "text" as const, text: await askHuman(args) }] }),
        ),
      ],
    });
  }
  try {
    mkdirSync(input.spec.outputsDir, { recursive: true });
  } catch {
    // The template creates it; without it, outputs are simply not uploaded.
  }
  const plugin = writeSkillsPlugin(input.spec, SKILLS_PLUGIN_DIR);
  const executable = resolveClaudeCodeExecutable(input.env);
  const stream = sdk.query({
    prompt: input.prompt,
    options: {
      model: input.spec.model,
      ...(input.spec.effort ? { effort: input.spec.effort } : {}),
      cwd: process.cwd(),
      ...(input.resume ? { resume: input.resume } : {}),
      abortController: input.abortController,
      env: input.env,
      mcpServers,
      disallowedTools: [...(input.spec.webSearch ? [] : ["WebSearch"]), ...(input.spec.webFetch ? [] : ["WebFetch"])],
      permissionMode: "default",
      // No settings files: an agent that writes .claude/settings.json never widens its own permissions.
      settingSources: [],
      ...(plugin ? { plugins: [{ type: "local" as const, path: plugin }] } : {}),
      ...(input.maxBudgetUsd !== null ? { maxBudgetUsd: Math.max(input.maxBudgetUsd, 0.01) } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: input.spec.system },
      canUseTool: async (toolName, toolInput, options) =>
        input.canUseTool(toolName, toolInput, { toolUseID: options.toolUseID }),
    },
  });
  for await (const message of stream) yield message;
};
