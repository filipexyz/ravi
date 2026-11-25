/**
 * The MCP gateway in the daemon (spec mcp, Gateway).
 *
 * `call` is the one way an agent's tool call reaches a registered server:
 * it runs `authorizeMcpUse` first (no network and no child start before an
 * allow), connects through the shared connection of that server, and calls
 * the tool with automatic `input_required` fulfilment off. The gateway loops
 * itself (at most 4 rounds, `input-loop.ts`, the one loop both call paths
 * share) with the call scope in hand: each embedded `elicitation/create` goes
 * to the elicitation handler, and the retry carries the answers and the
 * byte-exact `requestState`. A legacy-era server asks
 * with an `elicitation/create` request on the shared connection instead; it
 * reaches the same handler only when exactly one call is in flight on that
 * connection, and is declined otherwise. The daemon's gateway answers through
 * `requestMcpElicitation` (src/mcp/elicitation.ts); a gateway built without a
 * handler declines without asking anyone.
 *
 * Results: text and structured content pass through, images are kept for the
 * surfaces that show them, resource links become text and are never fetched,
 * other content is reported by type and size, text is capped at 256 KB, and
 * upstream `_meta` and annotations are dropped unread.
 *
 * File uploads (spec mcp, File Uploads): a call that fills an argument the
 * server marked `x-mcp-file` passes gate B (the attachment's uploads flag, a
 * modern HTTP server that offers uploads, an agent that runs on this host,
 * and `authorizeMcpUse` on the `upload` surface) and gate A (each path, in
 * `files.ts`) before anything is sent. It then goes through the raw dispatch
 * with the files extension declared: the person confirms, the server answers
 * `upload_required`, each file goes to its validated storage target
 * (`upload-target.ts`), and the call is sent once more with the
 * `requestState` and nothing else. That retry is never sent twice; a `task`
 * it answers is followed like any other. Targets, headers and the request
 * state never leave this process: the trace gets the number of files, the
 * bytes and the upload outcome only.
 *
 * `refresh` is the daemon's own probe of a server (not an agent's use): it
 * connects, lists the tools and writes status, era, discover verdict,
 * extensions and catalog back to the registry. A modern HTTP server that
 * offers uploads is listed a second time with the files extension declared
 * (the catalog attachments with uploads on see, addendum A1). It runs on every `config`
 * change of a server, at start, and on a timer for rows that are due.
 */

import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";

import { subscribe } from "../nats.js";
import { type ContextRecord, dbGetAgent, dbGetContext } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { type AuthorizeMcpUseDeps, authorizeMcpUse, type McpDenialCode } from "./authorize.js";
import { type BuiltMcpCatalog, buildMcpCatalog, mcpCatalogFingerprint, stableMcpJson } from "./catalog.js";
import {
  classifyMcpFailure,
  isMcpInsufficientScope,
  isMcpInvalidResult,
  isMcpRateLimited,
  isMcpStaleVerdictSignal,
  isMcpVersionRefusal,
  MCP_DEFAULT_RETRY_AFTER_MS,
  McpConnectionError,
  McpConnectionManager,
  type McpConnectionManagerOptions,
  type McpConnectionLease,
  mcpFailureDetail,
  mcpLegacyVerdictExpired,
  mcpScopeTokens,
  type McpStoredVerdict,
  parseMcpStoredVerdict,
  safeMcpErrorText,
} from "./connections.js";
import { type McpCallOrigin, readMcpServerBackoff, recordMcpServerRateLimit } from "./calls-db.js";
import { type McpOriginTurnResolver, mcpCallOriginOfContext, requestMcpElicitation } from "./elicitation.js";
import { mcpAttachmentDeclaresUploads, mcpCatalogForAttachment, mcpServerDeclaresFileUpload } from "./extensions.js";
import {
  type McpFileGateCode,
  type McpFileGateDeps,
  type McpStagedFile,
  mcpCallHasFileArguments,
  stageMcpFileArguments,
} from "./files.js";
import {
  MCP_INPUT_ROUND_ANSWER_MS,
  McpInputError,
  type McpInputAnswer,
  runMcpInputRequiredLoop,
} from "./input-loop.js";
import { McpServerListCache, mcpResultTtlMs } from "./list-cache.js";
import { createMcpAuthProvider } from "./oauth-provider.js";
import {
  callMcpToolRaw,
  createMcpRawDispatcher,
  MCP_TERMINAL_TASK_STATUSES,
  McpRawDispatchError,
  type McpRawDispatcher,
  type McpRawTask,
  mcpUsesRawDispatch,
} from "./raw-dispatch.js";
import {
  getMcpServer,
  listMcpServers,
  type McpConfigChangedEvent,
  type McpEra,
  type McpServerRecord,
  pruneMcpElicitationRequests,
  recordMcpServerProbe,
} from "./registry-db.js";
import { refreshMcpSkillPins } from "./skills.js";
import {
  emitMcpCatalogChanged,
  type McpCallElicitationTrace,
  type McpCallSurface,
  type McpUploadTrace,
  recordMcpCallTrace,
} from "./trace.js";
import {
  type McpUploadLookup,
  type McpUploadTransport,
  performMcpUploads,
  validateMcpUploadTargets,
} from "./upload-target.js";

import { getMcpGateway, MCP_MAX_CALL_BUDGET_MS, setMcpGatewayInstance } from "./gateway-instance.js";
import { mcpLoginCommand } from "./login-options.js";

const log = logger.child("mcp:gateway");

export { getMcpGateway, MCP_MAX_CALL_BUDGET_MS } from "./gateway-instance.js";
/**
 * The longest a detached request is kept open in the daemon, counted from the
 * call's start (a call past its inline budget that may detach). Past it the
 * request is abandoned and its outcome delivered as unknown.
 */
export const MCP_DETACHED_CALL_MAX_MS = 30 * 60 * 1000;
export const MCP_MIN_CALL_BUDGET_MS = 1_000;
/** Re-exported: the loop lives in `input-loop.ts`, shared by both call paths. */
export { MCP_MAX_INPUT_ROUNDS } from "./input-loop.js";
export const MCP_TEXT_CAP_BYTES = 256 * 1024;
export const MCP_STRUCTURED_CAP_BYTES = 256 * 1024;
export const MCP_IMAGE_CAP_BYTES = 5 * 1024 * 1024;
export const MCP_IMAGES_TOTAL_CAP_BYTES = 10 * 1024 * 1024;
const LIST_TIMEOUT_MS = 30_000;
/**
 * The longest `stop` waits for refreshes in flight after aborting them: the
 * daemon stops its components one by one under one guard, so a server that
 * never answers must not hold up the rest of the shutdown.
 */
export const MCP_GATEWAY_STOP_WAIT_MS = 2_000;
/** How often the daemon looks for rows due for a refresh. */
export const MCP_REFRESH_TICK_MS = 15 * 60 * 1000;
const ERROR_RETRY_MS = 15 * 60 * 1000;
const OK_REFRESH_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

/** Held while a person is being asked, so the runtime's tool watchdog waits too. */
export interface McpPersonWait {
  begin(): void;
  end(): void;
}

export interface McpCallScope {
  /** The turn's context record; none is denied (`no_turn`). */
  context: ContextRecord | null | undefined;
  agentId: string;
  /** Claude: the session's approval wait lease (spec mcp, Elicitation). */
  approvalWait?: McpPersonWait;
}

export interface McpCallInput {
  server: string;
  /** The remote tool name (not the exposed `mcp__` name). */
  tool: string;
  arguments?: Record<string, unknown>;
  surface: McpCallSurface;
  /** Inline budget; clamped to 1 s .. 240 s (default 240 s). */
  budgetMs?: number;
  signal?: AbortSignal;
  /**
   * The call may leave its turn (spec mcp, Background Calls And Tasks): a
   * task result, or a call still running at the end of the budget, returns a
   * call id and the outcome arrives later in the turn's session. Honoured only
   * when the gateway has a call follower and the turn names its session.
   */
  detach?: boolean;
}

export type McpResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type McpGatewayCallResult =
  | {
      ok: true;
      /** `detached`: the call continues in the background; `content` holds the handle text. */
      outcome: "ok" | "tool_error" | "detached";
      content: McpResultContent[];
      structuredContent?: Record<string, unknown>;
      /** Bytes handed back: text, structured content and decoded images. */
      bytes: number;
      /** Something was cut or left out by a cap. */
      truncated: boolean;
      era: McpEra;
      rounds: number;
      /** `detached`: the call's id in `mcp_calls` and why it left the turn. */
      callId?: string;
      detachReason?: "task" | "budget";
    }
  | { ok: false; outcome: "denied"; code: McpDenialCode; reason: string }
  /** A file argument was refused before anything was sent (gate A or B of File Uploads). */
  | { ok: false; outcome: "file_refused"; code: McpFileRefusalCode; reason: string }
  | { ok: false; outcome: "needs_login" | "timeout" | "cancelled" | "error"; reason: string };

/** Why a file argument was refused: gate B (`uploads_off`, `server_kind`, `remote_agent`) or gate A (`files.ts`). */
export type McpFileRefusalCode = "uploads_off" | "server_kind" | "remote_agent" | McpFileGateCode;

/** What a call sends with: the files extension declared or not, and the files gate A staged. */
interface McpCallPlan {
  uploads: boolean;
  files: McpStagedFile[];
  /**
   * False when the call cannot leave its turn: no request of it declares the
   * tasks extension, so a compliant server answers inline instead of
   * starting a task nobody follows.
   */
  tasks?: boolean;
}

export interface McpElicitationRequest {
  scope: McpCallScope;
  server: string;
  tool: string;
  era: McpEra;
  /** The server's key for this input request (`legacy` for a legacy server request). */
  key: string;
  params: ElicitRequest["params"];
  /** When the call's inline budget ends (epoch ms); the answer must come before it. */
  deadline: number;
  /**
   * When the person's time for this `input_required` round ends (epoch ms):
   * shared by every question of the round, never past `deadline`. The
   * gateway always sets it; absent, the handler gives the person one round's
   * time from when it is asked.
   */
  answerBy?: number;
  /** The call's cancellation. */
  signal?: AbortSignal;
  /** Tell the gateway how the request was answered and why (a fixed reason code), for the call's trace and note. */
  report?: (outcome: McpElicitationOutcome) => void;
}

/** How one elicitation request was answered: the action and a fixed reason code (never content). */
export interface McpElicitationOutcome {
  action: "accept" | "decline" | "cancel";
  reason: string;
}

export type McpElicitationHandler = (request: McpElicitationRequest) => Promise<ElicitResult>;

/** What a call binds to its connection, for legacy-era elicitation requests. */
interface McpCallBinding {
  scope: McpCallScope;
  server: string;
  tool: string;
  deadline: number;
  signal?: AbortSignal;
  /** Where the call collects how its questions were answered. */
  onElicitation?: (outcome: McpElicitationOutcome) => void;
}

/** What a detached call ended with: a gateway outcome, or a task the follower polls from now on. */
export type McpDetachedWork =
  | { kind: "result"; result: McpGatewayCallResult }
  | { kind: "task"; task: McpRawTask; era: McpEra };

/** A call that leaves its turn, as the gateway hands it to the follower. */
export interface McpDetachInput {
  server: string;
  /** The server row's `createdAt`: the registration the call was made on. */
  serverCreatedAt?: number;
  tool: string;
  agentId: string;
  surface: McpCallSurface;
  era: McpEra | null;
  sessionName: string;
  sessionKey: string | null;
  origin: McpCallOrigin;
  reason: "task" | "budget";
  /** `task`: the task the server started. */
  task?: McpRawTask;
  /** The call declared the files extension: its task polls declare it too. */
  filesUpload?: boolean;
  /** When the call started (epoch ms). */
  startedAt: number;
}

/**
 * The follower of detached calls (`call-follower.ts`). `detach` records the
 * call and returns its id (it throws when the call cannot be recorded, and the
 * gateway then does not detach); `settle` hands over what a kept request
 * finally answered.
 */
export interface McpCallSink {
  detach(input: McpDetachInput, controller?: AbortController): string;
  settle(id: string, work: McpDetachedWork): void;
}

/**
 * What `McpGateway.withServer` ended with. `insufficient_scope`: the stored
 * login is valid but lacks a scope these methods need (the skills scope of a
 * Console server); the row keeps its status, so its tool calls go on working.
 */
export type McpServerUse<T> =
  | { ok: true; value: T; era: McpEra }
  | { ok: false; outcome: "denied"; code: McpDenialCode; reason: string }
  | {
      ok: false;
      outcome: "needs_login" | "insufficient_scope" | "rate_limited" | "timeout" | "error";
      reason: string;
      thrown?: unknown;
    };

/** The answer of a gateway with no elicitation surface: decline, nothing sent to anyone. */
export const declineMcpElicitation: McpElicitationHandler = async () => ({ action: "decline" });

export interface McpGatewayOptions extends McpConnectionManagerOptions {
  /** Answers embedded elicitation requests (default: decline). */
  elicit?: McpElicitationHandler;
  /** Overrides for `authorizeMcpUse` (tests). */
  authorize?: AuthorizeMcpUseDeps;
  /** Interval of the refresh timer (0 turns it off). */
  refreshTickMs?: number;
  /** Subscribe to `ravi.config.changed` on start (default true). */
  subscribe?: boolean;
  /**
   * The refresh tick's reconciliation of remote skill pins with each server's
   * listing (default: `refreshMcpSkillPins`; false turns it off).
   */
  skillPinsRefresh?: false | ((gateway: McpGateway, signal: AbortSignal) => Promise<unknown>);
  /** Read a context record by id, for a detached call's late questions (default: the registry). */
  readContext?: (contextId: string) => ContextRecord | null;
  /** Classify a turn for the person a detached call belongs to (default: the connector turn classifier). */
  resolveTurn?: McpOriginTurnResolver;
  /** File uploads (tests): the agent lookup, gate A's decisions, the storage transport and resolver. */
  files?: {
    getAgent?: (agentId: string) => { cwd?: string | null; remote?: string | null } | null;
    gate?: McpFileGateDeps;
    transport?: McpUploadTransport;
    lookup?: McpUploadLookup;
  };
}

// ============================================================================
// Results
// ============================================================================

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function cutUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut;
}

function decodedSize(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function describeOmitted(kind: string, mimeType: unknown, bytes: number): string {
  const type = typeof mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? `, ${mimeType}` : "";
  return `[${kind} content${type}, ${bytes} bytes, not shown]`;
}

/** Where server text imitates Ravi's note marker: `[Ravi note` in any case or spacing. */
const RAVI_NOTE_IMITATION = /\[\s*ravi\s*note\b[^\]\n]{0,80}\]?/giu;
const RAVI_NOTE_IMITATION_TEST = /\[\s*ravi\s*note\b/iu;

/** What a server's imitation of the marker becomes, so only Ravi's own line carries it. */
export const MCP_SERVER_TEXT_MARK = "[text from the MCP server]";

/**
 * Server text as the model may read it: every imitation of Ravi's note
 * marker (`[Ravi note`, in any case or spacing, also behind compatibility
 * forms such as full-width brackets or invisible format characters) becomes
 * `[text from the MCP server]`, so a server can never write a line that
 * reads as Ravi's own. Text without an imitation passes unchanged.
 */
export function neutralizeMcpRaviNoteImitation(text: string): string {
  if (RAVI_NOTE_IMITATION_TEST.test(text)) return text.replace(RAVI_NOTE_IMITATION, MCP_SERVER_TEXT_MARK);
  const folded = text.normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (!RAVI_NOTE_IMITATION_TEST.test(folded)) return text;
  return folded.replace(RAVI_NOTE_IMITATION, MCP_SERVER_TEXT_MARK);
}

/** Structured content with every string (keys too) passed through `neutralizeMcpRaviNoteImitation`. */
function neutralizeStructured(value: unknown): unknown {
  if (typeof value === "string") return neutralizeMcpRaviNoteImitation(value);
  if (Array.isArray(value)) return value.map(neutralizeStructured);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value))
      out[neutralizeMcpRaviNoteImitation(key)] = neutralizeStructured(entry);
    return out;
  }
  return value;
}

/**
 * The call result as the gateway hands it on. Upstream `_meta`, annotations
 * and unknown fields are dropped; nothing in the result decides anything.
 * Server text that imitates Ravi's note marker is neutralized here, in text
 * items and in structured content alike, so every reader gets it neutralized.
 */
export function normalizeMcpCallResult(raw: unknown): {
  outcome: "ok" | "tool_error";
  content: McpResultContent[];
  structuredContent?: Record<string, unknown>;
  bytes: number;
  truncated: boolean;
} {
  const result = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(result.content) ? result.content : [];
  const content: McpResultContent[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  let truncated = false;
  let textCutNoted = false;

  const pushText = (raw: string) => {
    if (textCutNoted) return;
    const text = neutralizeMcpRaviNoteImitation(raw);
    const size = byteLength(text);
    if (textBytes + size <= MCP_TEXT_CAP_BYTES) {
      content.push({ type: "text", text });
      textBytes += size;
      return;
    }
    const room = MCP_TEXT_CAP_BYTES - textBytes;
    if (room > 0) content.push({ type: "text", text: cutUtf8(text, room) });
    textBytes = MCP_TEXT_CAP_BYTES;
    truncated = true;
    textCutNoted = true;
    content.push({ type: "text", text: "[truncated: the result's text is longer than 256 KB]" });
  };

  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    switch (item.type) {
      case "text":
        if (typeof item.text === "string") pushText(item.text);
        break;
      case "image": {
        const data = typeof item.data === "string" ? item.data : "";
        const mimeType = typeof item.mimeType === "string" ? item.mimeType : "";
        const size = decodedSize(data);
        if (
          data &&
          /^image\/[\w.+-]+$/.test(mimeType) &&
          size <= MCP_IMAGE_CAP_BYTES &&
          imageBytes + size <= MCP_IMAGES_TOTAL_CAP_BYTES
        ) {
          content.push({ type: "image", data, mimeType });
          imageBytes += size;
        } else {
          truncated = true;
          pushText(describeOmitted("image", mimeType, size));
        }
        break;
      }
      case "resource_link": {
        const uri = typeof item.uri === "string" ? item.uri.slice(0, 2048) : "";
        const name = typeof item.name === "string" ? item.name.slice(0, 200) : "";
        pushText(`[resource link${name ? ` "${name}"` : ""}: ${uri || "(no uri)"}; not fetched]`);
        break;
      }
      case "resource": {
        const resource =
          item.resource && typeof item.resource === "object" ? (item.resource as Record<string, unknown>) : {};
        const uri = typeof resource.uri === "string" ? resource.uri.slice(0, 2048) : "(no uri)";
        if (typeof resource.text === "string") {
          pushText(`[resource ${uri}]\n${resource.text}`);
        } else {
          const blob = typeof resource.blob === "string" ? resource.blob : "";
          pushText(describeOmitted(`resource ${uri}`, resource.mimeType, decodedSize(blob)));
        }
        break;
      }
      case "audio":
        pushText(describeOmitted("audio", item.mimeType, decodedSize(typeof item.data === "string" ? item.data : "")));
        break;
      default:
        pushText(describeOmitted(typeof item.type === "string" ? item.type.slice(0, 40) : "unknown", undefined, 0));
    }
  }

  let structuredContent: Record<string, unknown> | undefined;
  let structuredBytes = 0;
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const neutralized = neutralizeStructured(JSON.parse(JSON.stringify(structured))) as Record<string, unknown>;
    const encoded = JSON.stringify(neutralized);
    structuredBytes = byteLength(encoded);
    if (structuredBytes <= MCP_STRUCTURED_CAP_BYTES) {
      structuredContent = neutralized;
    } else {
      structuredBytes = 0;
      truncated = true;
      pushText("[structured content larger than 256 KB, not shown]");
    }
  }

  return {
    outcome: result.isError === true ? "tool_error" : "ok",
    content,
    ...(structuredContent ? { structuredContent } : {}),
    bytes: textBytes + imageBytes + structuredBytes,
    truncated,
  };
}

// ============================================================================
// Refresh policy
// ============================================================================

/** Whether the daemon's timer should probe this row again. */
export function mcpRefreshDue(server: McpServerRecord, now: number): boolean {
  if (!server.enabled) return false;
  if (server.status === "unknown") return true;
  if (server.status === "needs_login") return false;
  if (mcpLegacyVerdictExpired(server, now)) return true;
  const age = server.checkedAt === null ? Number.POSITIVE_INFINITY : now - server.checkedAt;
  if (server.status === "error") return age >= ERROR_RETRY_MS;
  // A modern server's tools/list ttlMs: the list is listed again once it is no longer fresh.
  if (typeof server.catalogExpiresAt === "number" && now >= server.catalogExpiresAt) return true;
  return age >= OK_REFRESH_MS;
}

function sameVerdict(server: McpServerRecord, verdict: McpStoredVerdict): boolean {
  const stored = parseMcpStoredVerdict(server);
  if (!stored || stored.kind !== verdict.kind || server.era !== verdict.kind) return false;
  if (stored.decidedAt !== verdict.decidedAt) return false;
  return stored.kind === "legacy" || stableMcpJson(stored) === stableMcpJson(verdict);
}

/** The registration fields a probe result belongs to. */
function registrationKey(server: McpServerRecord): string {
  return stableMcpJson({
    transport: server.transport,
    urlDisplay: server.urlDisplay,
    command: server.command,
    args: server.args,
    envKeys: server.envKeys,
    authKind: server.authKind,
    credentialRev: server.credentialRev,
    protocol: server.protocol,
    enabled: server.enabled,
  });
}

// ============================================================================
// Detached calls
// ============================================================================

/** What a call reports while it runs: the era of its connection and its input rounds. */
interface CallProgress {
  era: (era: McpEra) => void;
  rounds: (rounds: number) => void;
  /** What the call uploaded (counts and outcome only). */
  upload?: (upload: McpUploadTrace) => void;
  /** How each of the server's questions was answered, in order. */
  elicitation?: (outcome: McpElicitationOutcome) => void;
}

// ============================================================================
// Step-up, back-off and Ravi's notes
// ============================================================================

/**
 * A step-up answer (403 `insufficient_scope`) on either call path, with the
 * scopes its challenge names (plain scope tokens only; empty when it named
 * none). Null for any other failure. A step-up concerns this one request: the
 * stored login is valid, so the row keeps its status.
 */
export function mcpStepUpScopes(error: unknown): string[] | null {
  if (error instanceof McpRawDispatchError) {
    return error.kind === "insufficient_scope" ? mcpScopeTokens(error.requiredScopes.join(" ")) : null;
  }
  if (isMcpInsufficientScope(error)) {
    return mcpScopeTokens((error as { requiredScope?: unknown }).requiredScope as string | undefined);
  }
  return null;
}

/** What the model reads when a tool call was refused for a scope the stored login lacks. */
export function mcpStepUpCallText(server: string, scopes: readonly string[]): string {
  const missing = scopes.length > 0 ? ` (missing scope ${scopes.join(" ")})` : "";
  return (
    `MCP server ${server} refused this call: the stored login does not allow it${missing}, so nothing ran. ` +
    `The operator can log in again and allow it (ravi mcp login ${server} --execute), or, for a Ravi Console ` +
    `server, turn "Allow changes" on for that bridge. The server's other tools still work with the current login.`
  );
}

/** What a request Ravi did not send because of the server's back-off answers. */
export function mcpBackoffText(server: string, remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `MCP server ${server} asked Ravi to slow down (HTTP 429), so nothing was sent; try again in ${seconds} s.`;
}

function rateLimitedText(server: string, retryAfterMs: number): string {
  return `MCP server ${server} asks Ravi to slow down (HTTP 429), so nothing ran; try again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s.`;
}

/** Reasons for which Ravi answered a question without the person's own decision, as the model reads them. */
const NOBODY_ASKED: Record<string, string> = {
  no_person:
    "nobody was asked: this kind of turn (a routine, a relay, the terminal or a delivery) has no person who can confirm.",
  not_credential_principal:
    "nobody was asked: only the operator, whose login this server uses, can confirm, and this is not the operator's own turn.",
  no_private_surface: "nobody was asked: Ravi has no private way to reach the person of this turn.",
  not_authorized: "nobody was asked: this agent may not ask people questions for this server.",
  no_time: "nobody was asked: too little of the call's time was left to ask.",
  no_handler: "nobody was asked: this Ravi process cannot ask people.",
  audit_failed: "nobody was asked: Ravi could not record the question.",
  store_failed: "nobody was asked: Ravi could not record the question.",
  unsupported_request: "nobody was asked: Ravi does not ask a person this kind of question.",
  unsupported_form: "nobody was asked: Ravi does not ask a person a form of this shape.",
  too_many_fields: "nobody was asked: the form has more fields than Ravi asks a person.",
  secret_field:
    "nobody was asked: the form asks for something that looks like a secret, which Ravi never asks in a chat.",
  unsafe_url: "nobody was asked: the address the server gave is not one Ravi shows a person.",
  timeout: "the person was asked but did not answer in time.",
  send_failed: "the question could not be delivered to the person.",
  wrong_actor: "the question could not be delivered to the person.",
  cancelled: "the call was cancelled while the person was being asked.",
  invalid_answer: "the person's answers did not fit the question, so nothing was sent.",
  error: "Ravi could not finish asking the person.",
};

/** The `mcp.call` trace part for the questions of one call. */
export function mcpElicitationSummary(outcomes: readonly McpElicitationOutcome[]): McpCallElicitationTrace {
  if (outcomes.length === 0) return { outcome: "none" };
  const refused = outcomes.find((outcome) => outcome.action !== "accept");
  if (refused) return { outcome: refused.action === "decline" ? "declined" : "cancelled", reason: refused.reason };
  return { outcome: "accepted", reason: outcomes[outcomes.length - 1]!.reason };
}

const RAVI_NOTE_PREFIX = "[Ravi note, not from the MCP server]";

/**
 * Ravi's own line for the model, or null: when a question was answered
 * `decline` or `cancel` without a person's explicit decision (nobody could be
 * asked, the person did not answer, the question could not be delivered),
 * and when a confirmed write came back expired. Only fixed texts; never an
 * answer, a field or a reason the server wrote.
 */
export function mcpRaviNoteFor(
  server: string,
  outcomes: readonly McpElicitationOutcome[],
  result: McpGatewayCallResult,
): string | null {
  const undecided = outcomes.find(
    (outcome) => outcome.action !== "accept" && !(outcome.action === "decline" && outcome.reason === "declined"),
  );
  if (undecided) {
    const text =
      NOBODY_ASKED[undecided.reason] ??
      (undecided.reason === "unreported"
        ? null
        : `Ravi answered for the person without their decision (${undecided.reason.slice(0, 40)}).`);
    if (text) return `${RAVI_NOTE_PREFIX} MCP server ${server} asked for the person's input, and ${text}`;
  }
  const structured = result.ok ? result.structuredContent : undefined;
  if (
    result.ok &&
    result.outcome === "tool_error" &&
    structured?.error === "confirmation_expired" &&
    outcomes.some((outcome) => outcome.action === "accept")
  ) {
    return `${RAVI_NOTE_PREFIX} The person confirmed, but the answer reached MCP server ${server} after its confirmation had expired, so nothing changed. Call the tool again only if the person still wants this; they will be asked again.`;
  }
  return null;
}

/**
 * The result with Ravi's note in front of everything the server sent, where
 * server text cannot hide it. A failed call's reason, which may quote the
 * server's error message, has any imitation of the marker neutralized first,
 * with or without a note (the result's text items were neutralized when they
 * were read). A result that only had structured content keeps its JSON as a
 * text item after the note, as a reader that shows text would have shown it
 * without the note.
 */
export function withMcpRaviNote(result: McpGatewayCallResult, note: string | null): McpGatewayCallResult {
  if (!result.ok) {
    if (result.outcome === "denied" || result.outcome === "file_refused") return result;
    const reason = neutralizeMcpRaviNoteImitation(result.reason);
    return { ...result, reason: note ? `${note}\n${reason}` : reason };
  }
  if (!note || result.outcome === "detached") return result;
  const structuredOnly = result.structuredContent !== undefined && !result.content.some((item) => item.type === "text");
  return {
    ...result,
    content: [
      { type: "text", text: note },
      ...result.content,
      ...(structuredOnly ? [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }] : []),
    ],
    bytes: result.bytes + byteLength(note),
  };
}

/**
 * The approval wait lease of a call that may detach: held as usual while it
 * waits for the caller, and let go for good when the call detaches (the
 * caller's tool call is over, so its watchdog must not wait any more).
 */
function detachableWait(inner: McpPersonWait | undefined): { lease?: McpPersonWait; release(): void } {
  if (!inner) return { release() {} };
  let depth = 0;
  let released = false;
  return {
    lease: {
      begin() {
        if (released) return;
        depth++;
        inner.begin();
      },
      end() {
        if (released || depth === 0) return;
        depth--;
        inner.end();
      },
    },
    release() {
      if (released) return;
      released = true;
      while (depth > 0) {
        depth--;
        try {
          inner.end();
        } catch {
          // no-cause: ending the lease cannot change the call; the next one is ended too.
        }
      }
    },
  };
}

/** A task that is already finished when the server returns it is a plain result; null while it runs. */
export function mcpTaskResultInline(task: McpRawTask, server: string): McpGatewayCallResult | null {
  if (!MCP_TERMINAL_TASK_STATUSES.has(task.status)) return null;
  if (task.status === "completed") {
    return { ok: true, ...normalizeMcpCallResult(task.result ?? {}), era: "modern", rounds: 0 };
  }
  if (task.status === "failed") {
    return {
      ok: false,
      outcome: "error",
      reason: `The task of MCP server ${server} failed: ${neutralizeMcpRaviNoteImitation(task.error?.message ?? "no reason given")}`,
    };
  }
  return {
    ok: false,
    outcome: "cancelled",
    reason: `The task of MCP server ${server} was cancelled${task.statusMessage ? `: ${neutralizeMcpRaviNoteImitation(task.statusMessage)}` : "."}`,
  };
}

/** The text the model reads when its call leaves the turn. */
export function mcpDetachedText(id: string, reason: "task" | "budget", server: string, tool: string, budgetMs: number) {
  const what =
    reason === "task"
      ? `MCP call ${id} (${server} ${tool}) continues in the background as a task on the server.`
      : `MCP call ${id} (${server} ${tool}) is still running after ${Math.round(budgetMs / 1000)} s and continues in the background.`;
  const cancel =
    reason === "task"
      ? `To ask the server to stop it: ravi mcp calls cancel ${id}. The server decides whether its work stops (it may finish what it started, or keep running); the answer that arrives here says what happened.`
      : `To stop waiting for it: ravi mcp calls cancel ${id}. Ravi drops the request; whether the server already ran it is unknown.`;
  return `${what} Its result arrives in this session as a new message when it finishes. Do not call the tool again for this request. ${cancel}`;
}

function detachedResult(
  id: string,
  reason: "task" | "budget",
  server: string,
  tool: string,
  era: McpEra,
  budgetMs: number,
): McpGatewayCallResult {
  return {
    ok: true,
    outcome: "detached",
    content: [{ type: "text", text: mcpDetachedText(id, reason, server, tool, budgetMs) }],
    bytes: 0,
    truncated: false,
    era,
    rounds: 0,
    callId: id,
    detachReason: reason,
  };
}

// ============================================================================
// Gateway
// ============================================================================

export class McpGateway {
  readonly connections: McpConnectionManager;
  private readonly options: McpGatewayOptions;
  private readonly refreshing = new Map<string, Promise<McpServerRecord | null>>();
  private readonly refreshAgain = new Set<string>();
  /** Servers whose next refresh negotiates instead of adopting the stored verdict. */
  private readonly renegotiate = new Set<string>();
  /** One response cache per row and registration, shared by that row's clients. */
  private readonly listCaches = new Map<string, McpServerListCache>();
  private abort: AbortController | null = null;
  /** Aborts the gateway's own refreshes (listings) when it stops. */
  private refreshAbort = new AbortController();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Refreshes waiting for a server's back-off to end. */
  private readonly backoffTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  private callSink: McpCallSink | null = null;
  /** At most one reconciliation of remote skill pins runs at a time (one `skills/list` walk per server per tick). */
  private skillPinsRun: Promise<void> | null = null;

  constructor(options: McpGatewayOptions = {}) {
    this.options = options;
    this.connections = new McpConnectionManager({
      // The stored login of a bearer or OAuth row; a refresh it needs runs under the credential lock.
      authProvider: (server) =>
        createMcpAuthProvider(server, {
          ...(options.readSecret ? { readSecret: options.readSecret } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.stateDir ? { lock: { stateDir: options.stateDir() } } : {}),
        }),
      ...options,
      responseCacheStore: (server) => this.listCacheFor(server),
      // A legacy server's own request: answered only when the connection could tie it to one call.
      onLegacyElicitation: async (ask) => {
        const call = ask.call as McpCallBinding | undefined;
        if (!call || typeof call !== "object" || !call.scope || call.server !== ask.server) {
          return { action: "decline" };
        }
        // A legacy request is its own round: the person gets the round's time, never past the call's deadline.
        return this.answer(
          {
            scope: call.scope,
            server: call.server,
            tool: call.tool,
            era: "legacy",
            key: "legacy",
            params: ask.params,
            deadline: call.deadline,
            answerBy: this.now() + MCP_INPUT_ROUND_ANSWER_MS,
            ...(call.signal ? { signal: call.signal } : {}),
          },
          call.onElicitation,
        );
      },
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The response cache of this row's registration: a changed registration starts an empty one. */
  private listCacheFor(server: McpServerRecord): McpServerListCache {
    const registration = registrationKey(server);
    let cache = this.listCaches.get(server.name);
    if (!cache || cache.registration !== registration) {
      cache = new McpServerListCache(registration);
      this.listCaches.set(server.name, cache);
    }
    return cache;
  }

  /** The follower that takes calls leaving their turn (null: no call detaches). */
  attachCallSink(sink: McpCallSink | null): void {
    this.callSink = sink;
  }

  /**
   * A raw dispatcher for a row `mcpUsesRawDispatch` selects, with the stored
   * URL and the same login the connections use (a refresh runs under the
   * credential lock). The follower polls tasks with it.
   */
  createRawDispatcher(
    server: McpServerRecord,
    options: { uploads?: boolean; tasks?: boolean } = {},
  ): Promise<McpRawDispatcher> {
    const gatewayOptions = this.options;
    return createMcpRawDispatcher(server, {
      ...(options.uploads ? { uploads: true } : {}),
      ...(options.tasks === false ? { tasks: false } : {}),
      ...(gatewayOptions.readSecret ? { readSecret: gatewayOptions.readSecret } : {}),
      ...(gatewayOptions.fetch ? { fetch: gatewayOptions.fetch } : {}),
      ...(gatewayOptions.now ? { now: gatewayOptions.now } : {}),
      authProvider: (row) =>
        createMcpAuthProvider(row, {
          ...(gatewayOptions.readSecret ? { readSecret: gatewayOptions.readSecret } : {}),
          ...(gatewayOptions.fetch ? { fetch: gatewayOptions.fetch } : {}),
          ...(gatewayOptions.now ? { now: gatewayOptions.now } : {}),
          ...(gatewayOptions.stateDir ? { lock: { stateDir: gatewayOptions.stateDir() } } : {}),
        }),
    });
  }

  /** Record that a server needs the operator's login (the follower's polls report it too). */
  noteServerNeedsLogin(server: McpServerRecord): void {
    this.markStatus(server, "needs_login", `run ${mcpLoginCommand(server.name, server.authKind)}`);
  }

  /** Probe a server again, ignoring its stored verdict (addendum A6: a modern row answered -32022). */
  reprobeServer(server: McpServerRecord): void {
    this.scheduleRefresh(server.name, { ignoreStoredVerdict: true });
  }

  /** Who a call is made for, recorded when it detaches. */
  originOf(context: ContextRecord | null | undefined): McpCallOrigin {
    const person = mcpCallOriginOfContext(context, this.options.resolveTurn);
    return { contextId: context?.contextId ?? null, ...person };
  }

  /**
   * The context a detached call's late question may be asked under: the
   * origin turn's record read again, and only while its person is still the
   * origin person. Anything else (no record, a revoked one, a turn of
   * somebody else, an origin with no person) is null, so the elicitation
   * handler declines without asking anyone. A turn's context is revoked when
   * the turn completes and the classifier names nobody for an ended turn, so
   * a question that comes after the origin turn ended is declined.
   */
  lateContext(origin: McpCallOrigin): ContextRecord | null {
    if (!origin.contextId || !origin.contactId) return null;
    let context: ContextRecord | null = null;
    try {
      context = (this.options.readContext ?? dbGetContext)(origin.contextId);
    } catch {
      // no-cause: an unreadable context names no person; the question is declined.
      return null;
    }
    if (!context) return null;
    const now = mcpCallOriginOfContext(context, this.options.resolveTurn);
    return now.contactId === origin.contactId && now.operatorOwn === origin.operatorOwn ? context : null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.refreshAbort.signal.aborted) this.refreshAbort = new AbortController();
    if (this.options.subscribe !== false) this.runSubscription();
    const tickMs = this.options.refreshTickMs ?? MCP_REFRESH_TICK_MS;
    if (tickMs > 0) {
      this.tickTimer = setInterval(() => {
        void this.refreshDue();
      }, tickMs);
      this.tickTimer.unref?.();
    }
    void this.refreshDue();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const timer of this.backoffTimers.values()) clearTimeout(timer);
    this.backoffTimers.clear();
    // Refreshes in flight are aborted: listings (and the skill pin walk) through their signal, connects
    // still opening by the manager (it closes their transports, so a stdio child that was starting is
    // stopped too).
    this.refreshAbort.abort();
    const refreshes = [...this.refreshing.values(), ...(this.skillPinsRun ? [this.skillPinsRun] : [])];
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.allSettled([this.connections.stop(), ...refreshes]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MCP_GATEWAY_STOP_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private runSubscription(): void {
    const controller = new AbortController();
    this.abort = controller;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const message of subscribe("ravi.config.changed", { signal: controller.signal })) {
            if (controller.signal.aborted) break;
            await this.handleConfigChanged(message.data);
          }
        } catch {
          // no-cause: the subscription is retried below; the registry stays readable meanwhile.
          if (controller.signal.aborted) break;
          log.warn("MCP config subscription failed; retrying in 2 s");
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    })();
  }

  /**
   * React to `ravi.config.changed`. A `config` change of MCP servers drops
   * their connections and refreshes them; the gateway's own `status` writes
   * and other reasons are ignored. An MCP event without a server list drops
   * every connection.
   */
  async handleConfigChanged(data: unknown): Promise<void> {
    if (!data || typeof data !== "object") return;
    const event = data as Partial<McpConfigChangedEvent>;
    if (event.reason !== "mcp_servers" || event.change === "status") return;
    const names = Array.isArray(event.servers)
      ? event.servers.filter((name): name is string => typeof name === "string")
      : null;
    if (names === null) {
      await this.connections.closeAll();
      for (const server of listMcpServers({ enabled: true })) this.scheduleRefresh(server.name);
      return;
    }
    for (const name of names) {
      await this.connections.close(name);
      this.scheduleRefresh(name);
    }
  }

  /**
   * Probe every row that is due (status unknown, an expired legacy verdict, an
   * old error or check), and drop Slack elicitation rows settled more than a
   * day ago.
   */
  async refreshDue(): Promise<void> {
    const now = this.now();
    try {
      pruneMcpElicitationRequests(now);
    } catch {
      // no-cause: pruning is housekeeping; the next tick tries again.
      log.warn("Settled MCP elicitation rows could not be pruned");
    }
    let due: McpServerRecord[];
    try {
      due = listMcpServers({ enabled: true }).filter((server) => mcpRefreshDue(server, now));
    } catch {
      // no-cause: an unreadable registry is retried on the next tick.
      log.warn("MCP refresh skipped: the registry could not be read");
      return;
    }
    await Promise.allSettled(due.map((server) => this.refresh(server.name)));
    await this.refreshSkillPins();
  }

  /** Reconcile remote skill pins with their servers' listings (spec mcp, Remote Skills). Never throws. */
  refreshSkillPins(): Promise<void> {
    if (this.options.skillPinsRefresh === false) return Promise.resolve();
    if (this.skillPinsRun) return this.skillPinsRun;
    const refresh =
      this.options.skillPinsRefresh ??
      ((gateway: McpGateway, signal: AbortSignal) => refreshMcpSkillPins(gateway, {}, signal));
    // The gateway's own signal: stop() aborts the walk and its listing like any refresh.
    const run = refresh(this, this.refreshAbort.signal)
      .then(() => undefined)
      .catch(() => {
        // no-cause: the reconciliation is a cache refresh; reads still check every manifest.
        log.warn("Remote skill pins could not be reconciled; the next tick tries again");
      })
      .finally(() => {
        this.skillPinsRun = null;
      });
    this.skillPinsRun = run;
    return run;
  }

  private scheduleRefresh(name: string, options: { ignoreStoredVerdict?: boolean } = {}): void {
    if (options.ignoreStoredVerdict) this.renegotiate.add(name);
    if (this.refreshing.has(name)) {
      this.refreshAgain.add(name);
      return;
    }
    void this.refresh(name);
  }

  /**
   * Connect to a server, list its tools and write status, era, verdict,
   * extensions and catalog. Concurrent refreshes of one server share one run.
   * Returns the updated row (null when it is not registered).
   */
  refresh(name: string): Promise<McpServerRecord | null> {
    const existing = this.refreshing.get(name);
    if (existing) return existing;
    const run = this.refreshOnce(name).finally(() => {
      this.refreshing.delete(name);
      if (this.refreshAgain.delete(name)) void this.refresh(name);
    });
    this.refreshing.set(name, run);
    return run;
  }

  private async refreshOnce(name: string): Promise<McpServerRecord | null> {
    const server = getMcpServer(name);
    if (!server) {
      this.listCaches.delete(name);
      await this.connections.close(name);
      return null;
    }
    if (!server.enabled) {
      this.listCaches.delete(name);
      await this.connections.close(name);
      return server;
    }
    const backoffUntil = this.backoffUntil(server);
    if (backoffUntil !== null) {
      // The server asked Ravi to slow down: nothing is sent, the row keeps what it says, and the probe
      // runs again once the back-off ends.
      this.refreshAfterBackoff(name, backoffUntil);
      return server;
    }
    const renegotiate = this.renegotiate.delete(name);
    for (let attempt = renegotiate ? 1 : 0; ; attempt++) {
      let lease: McpConnectionLease | null = null;
      try {
        lease = await this.connections.acquire(server, { ignoreStoredVerdict: attempt > 0 });
        // The server's ttlMs is honoured: within it the held list is served without a round trip.
        // A renegotiation, or a row with no catalog yet, always fetches.
        const cache = this.listCacheFor(server);
        const writesBefore = cache.toolsListWriteCount;
        const cacheMode = attempt > 0 || !server.catalog || server.status !== "ok" ? "refresh" : "use";
        const listed = await lease.client.listTools(undefined, {
          timeout: LIST_TIMEOUT_MS,
          cacheMode,
          signal: this.refreshAbort.signal,
        });
        const fetched = cache.toolsListWriteCount !== writesBefore;
        const ttlMs = lease.era === "modern" ? mcpResultTtlMs(listed) : null;
        const freshUntil = cache.toolsListFreshUntil;
        const catalogExpiresAt =
          ttlMs === null ? null : Math.min(freshUntil ?? this.now() + ttlMs, this.now() + OK_REFRESH_MS);
        const built = buildMcpCatalog(server.name, Array.isArray(listed.tools) ? listed.tools : []);
        const extensions = lease.client.getServerCapabilities()?.extensions;
        const current = getMcpServer(name);
        if (!current || registrationKey(current) !== registrationKey(server)) {
          // The registration changed while this probe ran; its config event refreshes again.
          return current;
        }
        const updated = recordMcpServerProbe(name, {
          status: "ok",
          statusDetail: null,
          era: lease.era,
          discover: lease.verdict,
          extensions:
            extensions && typeof extensions === "object" && !Array.isArray(extensions)
              ? (JSON.parse(JSON.stringify(extensions)) as Record<string, unknown>)
              : null,
          catalog: built.catalog,
          catalogFingerprint: built.fingerprint,
          catalogExpiresAt,
          checkedAt: this.now(),
        });
        if (built.fingerprint !== current.catalogFingerprint) {
          emitMcpCatalogChanged({
            server: name,
            fingerprint: built.fingerprint,
            previousFingerprint: current.catalogFingerprint,
            toolCount: built.catalog.tools.length,
            droppedCount: built.catalog.dropped.length,
          });
        }
        // A list served from the cache keeps the files catalog listed with it.
        if (updated && (fetched || !updated.filesCatalog)) return (await this.refreshFilesCatalog(updated)) ?? updated;
        return updated;
      } catch (error) {
        if ((error instanceof McpConnectionError && error.code === "closed") || this.refreshAbort.signal.aborted) {
          // The gateway stopped or the registration changed mid-probe: nothing was learned about the server.
          return getMcpServer(name);
        }
        if (attempt === 0 && lease && isMcpStaleVerdictSignal(error, lease, "tools/list")) {
          log.info("MCP server answered outside its stored protocol verdict; probing again", { server: name });
          await lease.discard();
          lease = null;
          continue;
        }
        if (isMcpRateLimited(error)) {
          // A 429 is a back-off, never a failed server: the row keeps its status and detail.
          const retryAfterMs = this.noteRateLimit(server, lease ? "tools/list" : "connect");
          log.warn("MCP server refresh rate limited; probing again after its back-off", { server: name });
          this.refreshAfterBackoff(name, this.now() + retryAfterMs);
          return getMcpServer(name);
        }
        const kind = classifyMcpFailure(error, server);
        const detail = mcpFailureDetail(kind, error, server, lease?.secrets ?? []);
        log.warn("MCP server refresh failed", { server: name, kind });
        if (lease) await lease.discard();
        lease = null;
        const current = getMcpServer(name);
        if (!current || registrationKey(current) !== registrationKey(server)) return current;
        return recordMcpServerProbe(name, {
          status: kind === "needs_login" ? "needs_login" : "error",
          statusDetail: detail,
          checkedAt: this.now(),
        });
      } finally {
        lease?.release();
      }
    }
  }

  /**
   * The catalog an attachment with uploads on sees (addendum A1): `tools/list`
   * on the raw dispatch with the files extension declared, every page. Only
   * for a modern HTTP server that offers uploads; any other row has none. A
   * listing that fails clears it, so those attachments see the plain catalog
   * until the next refresh (never a stale file schema).
   */
  private async refreshFilesCatalog(server: McpServerRecord): Promise<McpServerRecord | null> {
    if (!(mcpUsesRawDispatch(server) && mcpServerDeclaresFileUpload(server))) {
      return server.filesCatalog
        ? recordMcpServerProbe(server.name, { status: server.status, filesCatalog: null })
        : null;
    }
    if (this.backoffUntil(server) !== null) return null;
    let built: BuiltMcpCatalog;
    try {
      const dispatcher = await this.createRawDispatcher(server, { uploads: true });
      const tools: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const listed = await dispatcher.request("tools/list", cursor ? { cursor } : {}, {
          timeoutMs: LIST_TIMEOUT_MS,
          signal: this.refreshAbort.signal,
        });
        if (Array.isArray(listed.tools)) tools.push(...listed.tools);
        cursor = typeof listed.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
        if (!cursor) break;
      }
      built = buildMcpCatalog(server.name, tools as Parameters<typeof buildMcpCatalog>[1]);
    } catch (error) {
      // Stopped mid-listing: nothing was learned, the row keeps what it has.
      if (this.refreshAbort.signal.aborted) return null;
      if (error instanceof McpRawDispatchError && error.kind === "rate_limited") {
        this.noteRateLimit(server, "tools/list", error.retryAfterMs ?? MCP_DEFAULT_RETRY_AFTER_MS);
      }
      log.warn("MCP upload catalog could not be listed; attachments with uploads see the plain catalog", {
        server: server.name,
        kind: error instanceof McpRawDispatchError ? error.kind : "error",
      });
      return server.filesCatalog
        ? recordMcpServerProbe(server.name, { status: server.status, filesCatalog: null })
        : null;
    }
    const previous = server.filesCatalog ? mcpCatalogFingerprint(server.filesCatalog) : null;
    const current = getMcpServer(server.name);
    if (!current || registrationKey(current) !== registrationKey(server)) return current;
    const updated = recordMcpServerProbe(server.name, { status: current.status, filesCatalog: built.catalog });
    if (built.fingerprint !== previous) {
      emitMcpCatalogChanged({
        server: server.name,
        variant: "files",
        fingerprint: built.fingerprint,
        previousFingerprint: previous,
        toolCount: built.catalog.tools.length,
        droppedCount: built.catalog.dropped.length,
      });
    }
    return updated;
  }

  /**
   * Store the era verdict a connection negotiated (era, discover, checked
   * time) and nothing else: the row's status moves only with the outcome of a
   * use (`noteUsable`) or a refresh, never because a connection opened.
   */
  private persistVerdict(server: McpServerRecord, lease: McpConnectionLease): void {
    if (sameVerdict(server, lease.verdict)) return;
    try {
      const current = getMcpServer(server.name);
      if (!current || registrationKey(current) !== registrationKey(server)) return;
      recordMcpServerProbe(server.name, {
        status: current.status,
        era: lease.era,
        discover: lease.verdict,
        checkedAt: this.now(),
      });
    } catch {
      // no-cause: the verdict is a cache; the next connect negotiates again.
      log.warn("MCP era verdict could not be stored", { server: server.name });
    }
  }

  /**
   * A use of the server succeeded: a row in `error` is `ok` again (its detail
   * cleared). Any other status stays: `unknown` waits for the refresh that
   * lists the catalog, and `needs_login` rows are never used.
   */
  private noteUsable(server: McpServerRecord): void {
    try {
      const current = getMcpServer(server.name);
      if (!current || current.status !== "error" || registrationKey(current) !== registrationKey(server)) return;
      recordMcpServerProbe(server.name, {
        status: "ok",
        statusDetail: null,
        checkedAt: current.checkedAt ?? this.now(),
      });
    } catch {
      // no-cause: the status is a cache; the use itself succeeded.
      log.warn("MCP server status could not be stored", { server: server.name });
    }
  }

  /** When the server's back-off ends (epoch ms), or null when none holds: one back-off per server, for everyone. */
  private backoffUntil(server: McpServerRecord): number | null {
    try {
      return readMcpServerBackoff(server.name, this.now());
    } catch {
      // no-cause: an unreadable record holds no back-off; a request the server refuses records it again.
      return null;
    }
  }

  /** The answer of a request Ravi did not send because the server's back-off holds. */
  private backoffFailure(server: McpServerRecord): { ms: number } | null {
    const until = this.backoffUntil(server);
    return until === null ? null : { ms: until - this.now() };
  }

  /** Probe a row again once its back-off ends (one timer per row; only while the gateway runs). */
  private refreshAfterBackoff(name: string, until: number): void {
    if (!this.running || this.backoffTimers.has(name)) return;
    const timer = setTimeout(
      () => {
        this.backoffTimers.delete(name);
        if (this.running) this.scheduleRefresh(name);
      },
      Math.max(1_000, until - this.now() + 500),
    );
    timer.unref?.();
    this.backoffTimers.set(name, timer);
  }

  /**
   * Record an HTTP 429 (addendum A7): the server's one back-off, which every
   * request to it honours, and what `ravi mcp show` reports. Without a value
   * from the caller, the `Retry-After` the SDK path's fetch captured is used
   * (60 s when the answer named none). Returns the back-off in ms.
   */
  private noteRateLimit(server: McpServerRecord, method: string, retryAfterMs?: number): number {
    const ms = retryAfterMs ?? this.connections.takeRetryAfterMs(server.name) ?? MCP_DEFAULT_RETRY_AFTER_MS;
    try {
      recordMcpServerRateLimit(server.name, method, this.now() + ms, this.now());
    } catch {
      // no-cause: an unrecorded back-off is only lost; the call's own answer is the outcome.
      log.warn("MCP rate limit could not be recorded", { server: server.name });
    }
    return ms;
  }

  private markStatus(server: McpServerRecord, status: "needs_login" | "error", detail: string): void {
    try {
      recordMcpServerProbe(server.name, { status, statusDetail: detail, checkedAt: this.now() });
    } catch {
      // no-cause: the status is a cache; the call's own outcome below is what the caller gets.
      log.warn("MCP server status could not be stored", { server: server.name });
    }
  }

  /**
   * Call one tool for one turn. Never throws: every failure is an outcome.
   * Authorization runs first; a denial makes no network call and starts no
   * child.
   *
   * A call that may detach (`input.detach`, a follower attached, a turn that
   * names its session) goes through the raw dispatch when its server declares
   * tasks or file uploads, and returns `detached` with a call id when the
   * server answers with a task or the inline budget ends first. Otherwise the
   * budget is a timeout, as it always was.
   */
  async call(scope: McpCallScope, input: McpCallInput): Promise<McpGatewayCallResult> {
    const started = this.now();
    let era: McpEra | null = null;
    let rounds = 0;
    let upload: McpUploadTrace | null = null;
    const elicitations: McpElicitationOutcome[] = [];
    const finish = (raw: McpGatewayCallResult): McpGatewayCallResult => {
      const result = withMcpRaviNote(raw, mcpRaviNoteFor(input.server, elicitations, raw));
      recordMcpCallTrace({
        context: scope.context,
        agentId: scope.agentId,
        server: input.server,
        tool: input.tool,
        surface: input.surface,
        era,
        durationMs: this.now() - started,
        outcome: result.outcome,
        bytes: result.ok && result.outcome !== "detached" ? result.bytes : 0,
        rounds,
        ...(upload ? { upload } : {}),
        elicitation: mcpElicitationSummary(elicitations),
      });
      return result.ok ? { ...result, rounds } : result;
    };

    const decision = authorizeMcpUse(
      { context: scope.context, agentId: scope.agentId, server: input.server, tool: input.tool, surface: "call" },
      this.options.authorize,
    );
    if (!decision.allowed) {
      return finish({ ok: false, outcome: "denied", code: decision.code, reason: decision.reason });
    }
    const args = input.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return finish({ ok: false, outcome: "error", reason: "The tool arguments must be a JSON object." });
    }
    if (input.signal?.aborted) return finish({ ok: false, outcome: "cancelled", reason: "The call was cancelled." });
    // One back-off per server: while it holds, the call is answered here and nothing is sent.
    const backoff = this.backoffFailure(decision.server);
    if (backoff) return finish({ ok: false, outcome: "error", reason: mcpBackoffText(input.server, backoff.ms) });

    const budget = Math.min(
      MCP_MAX_CALL_BUDGET_MS,
      Math.max(MCP_MIN_CALL_BUDGET_MS, Math.trunc(input.budgetMs ?? MCP_MAX_CALL_BUDGET_MS)),
    );
    const progress: CallProgress = {
      era: (value: McpEra) => {
        era = value;
      },
      rounds: (count: number) => {
        rounds = count;
      },
      upload: (value) => {
        upload = value;
      },
      elicitation: (outcome) => {
        elicitations.push(outcome);
      },
    };
    // File arguments: gate B, then gate A, both before any network call.
    const plan: McpCallPlan = {
      uploads: mcpAttachmentDeclaresUploads(decision.server, decision.attachment),
      files: [],
    };
    let callArgs = args;
    const catalogTool =
      mcpCatalogForAttachment(decision.server, decision.attachment)?.tools.find((tool) => tool.name === input.tool) ??
      null;
    if (mcpCallHasFileArguments(catalogTool, args)) {
      const staged = this.stageFiles(scope, input, args, decision, catalogTool!);
      if (!staged.ok) {
        upload = { files: 0, bytes: 0, outcome: "refused" };
        return finish(staged.result);
      }
      plan.files = staged.files;
      callArgs = staged.arguments;
    }
    if (this.canDetach(scope, input)) {
      return finish(
        await this.callDetachable(scope, input, callArgs, decision.server, started, budget, progress, plan),
      );
    }
    if (plan.files.length > 0) {
      // A call that sends files runs on the raw dispatch even when it cannot leave its turn. It declares no
      // tasks on any request (the first, after input, after the upload), so the server answers inline.
      const work = await this.runRawCall(scope, input, callArgs, decision.server, started + budget, progress, {
        ...plan,
        tasks: false,
      });
      if (work.kind === "result") return finish(work.result);
      return finish(
        mcpTaskResultInline(work.task, decision.server.name) ?? {
          ok: false,
          outcome: "error",
          reason: `MCP server ${decision.server.name} started a background task (${work.task.taskId}) although this call did not declare tasks, and this turn has no session its result could arrive in. Do not call the tool again blindly: the task may still complete on the server.`,
        },
      );
    }
    return finish(await this.runSdkCall(scope, input, callArgs, decision.server, started + budget, budget, progress));
  }

  /**
   * Gate B, then gate A, for a call that fills a file argument. Gate B: the
   * attachment has uploads on, the server is a modern HTTP server that offers
   * uploads, the agent runs on this host (a remote-spawn agent's paths are not
   * here), and `authorizeMcpUse` passes on the `upload` surface (a denial is
   * recorded). Gate A reads each path (`stageMcpFileArguments`). Nothing here
   * touches the network.
   */
  private stageFiles(
    scope: McpCallScope,
    input: McpCallInput,
    args: Record<string, unknown>,
    decision: Extract<ReturnType<typeof authorizeMcpUse>, { allowed: true }>,
    tool: NonNullable<McpServerRecord["catalog"]>["tools"][number],
  ):
    | { ok: true; arguments: Record<string, unknown>; files: McpStagedFile[] }
    | { ok: false; result: McpGatewayCallResult } {
    const server = decision.server;
    const refuse = (code: McpFileRefusalCode, reason: string) => ({
      ok: false as const,
      result: { ok: false as const, outcome: "file_refused" as const, code, reason },
    });
    if (!decision.attachment.uploads) {
      return refuse(
        "uploads_off",
        `File uploads are off for agent ${scope.agentId} on MCP server ${server.name}, so nothing was sent. The operator turns them on with: ravi mcp set ${server.name} --uploads on --agent ${scope.agentId} --execute`,
      );
    }
    if (
      server.transport !== "http" ||
      server.era !== "modern" ||
      server.protocol === "legacy" ||
      !mcpServerDeclaresFileUpload(server)
    ) {
      return refuse(
        "server_kind",
        `MCP server ${server.name} does not take file uploads (only modern HTTP servers that offer the files extension do), so nothing was sent.`,
      );
    }
    let agent: { cwd?: string | null; remote?: string | null } | null = null;
    try {
      agent = (this.options.files?.getAgent ?? dbGetAgent)(scope.agentId);
    } catch {
      // no-cause: an agent that cannot be read has no workspace to read files from; refused below.
      agent = null;
    }
    if (!agent) return refuse("remote_agent", `Agent ${scope.agentId} could not be read, so no file was sent.`);
    if (agent.remote) {
      return refuse(
        "remote_agent",
        `Agent ${scope.agentId} runs on a remote host; its files are not on the daemon's host, so MCP file uploads are refused for it.`,
      );
    }
    const onUpload = authorizeMcpUse(
      { context: scope.context, agentId: scope.agentId, server: server.name, tool: input.tool, surface: "upload" },
      this.options.authorize,
    );
    if (!onUpload.allowed) {
      return { ok: false, result: { ok: false, outcome: "denied", code: onUpload.code, reason: onUpload.reason } };
    }
    const staged = stageMcpFileArguments(
      {
        context: scope.context!,
        agentId: scope.agentId,
        cwd: agent.cwd ? agent.cwd.replace(/^~(?=\/|$)/, process.env.HOME ?? "~") : null,
        tool,
        arguments: args,
      },
      this.options.files?.gate,
    );
    if (!staged.ok) return refuse(staged.code, `${staged.reason} Nothing was sent.`);
    return { ok: true, arguments: staged.arguments, files: staged.files };
  }

  /**
   * Use one server's connection for a read that is not a tool call (the
   * skills methods, spec mcp Remote Skills). Never throws: authorization
   * (surface `skill`) runs first and again on the era the connection speaks,
   * a denial makes no network call, and every failure is an outcome whose
   * text carries no URL or secret. A stale stored verdict is negotiated again
   * once; the reads are idempotent. Errors `run` throws on purpose (a
   * verification failure) come back as `thrown`, for the caller to judge.
   */
  async withServer<T>(
    scope: McpCallScope,
    serverName: string,
    run: (lease: McpConnectionLease) => Promise<T>,
    /** The methods `run` sends, recorded with a 429 for `ravi mcp show`. */
    method = "skills",
  ): Promise<McpServerUse<T>> {
    const decision = authorizeMcpUse(
      { context: scope.context, agentId: scope.agentId, server: serverName, surface: "skill" },
      this.options.authorize,
    );
    if (!decision.allowed) return { ok: false, outcome: "denied", code: decision.code, reason: decision.reason };
    const server = decision.server;
    const backoff = this.backoffFailure(server);
    if (backoff) return { ok: false, outcome: "rate_limited", reason: mcpBackoffText(server.name, backoff.ms) };
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease: McpConnectionLease;
      try {
        lease = await this.connections.acquire(server, { ignoreStoredVerdict: attempt > 0 });
      } catch (error) {
        return this.serverConnectFailure(error, server);
      }
      this.persistVerdict(server, lease);
      const onEra = this.authorizeOnEra(scope, { server: serverName }, lease.era, "skill");
      if (!onEra.allowed) {
        lease.release();
        return { ok: false, outcome: "denied", code: onEra.code, reason: onEra.reason };
      }
      try {
        const value = await run(lease);
        this.noteUsable(server);
        return { ok: true, value, era: lease.era };
      } catch (error) {
        // Only the signals of addendum A6 renegotiate and send once more; a server error in its own era
        // (-32602 not found, -32603 the Console unreachable) is the answer, never sent twice.
        if (attempt === 0 && isMcpStaleVerdictSignal(error, lease, method)) {
          await lease.discard();
          continue;
        }
        return this.serverRunFailure(error, server, lease, method);
      } finally {
        lease.release();
      }
    }
    return { ok: false, outcome: "error", reason: "The MCP server refused the protocol revision." };
  }

  /**
   * The daemon's own use of a server, for no turn: the refresh tick's
   * reconciliation of remote skill pins, which reads manifests only and
   * whose result never reaches a model. The row must be registered and
   * enabled; the back-off is honoured (nothing is sent while it holds) and a
   * 429 recorded, as for `withServer`. No turn is authorized here, so this is
   * never used to answer a command.
   */
  async withServerUnattended<T>(
    serverName: string,
    run: (lease: McpConnectionLease) => Promise<T>,
    method = "skills",
  ): Promise<McpServerUse<T>> {
    let server: McpServerRecord | null = null;
    try {
      server = getMcpServer(serverName);
    } catch {
      // no-cause: an unreadable registry uses no server; the next tick tries again.
      server = null;
    }
    if (!server) {
      return {
        ok: false,
        outcome: "denied",
        code: "not_registered",
        reason: `MCP server ${serverName} is not registered.`,
      };
    }
    if (!server.enabled) {
      return { ok: false, outcome: "denied", code: "disabled", reason: `MCP server ${serverName} is disabled.` };
    }
    const backoff = this.backoffFailure(server);
    if (backoff) return { ok: false, outcome: "rate_limited", reason: mcpBackoffText(server.name, backoff.ms) };
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease: McpConnectionLease;
      try {
        lease = await this.connections.acquire(server, { ignoreStoredVerdict: attempt > 0 });
      } catch (error) {
        return this.serverConnectFailure(error, server);
      }
      this.persistVerdict(server, lease);
      try {
        const value = await run(lease);
        this.noteUsable(server);
        return { ok: true, value, era: lease.era };
      } catch (error) {
        if (attempt === 0 && isMcpStaleVerdictSignal(error, lease, method)) {
          await lease.discard();
          continue;
        }
        return this.serverRunFailure(error, server, lease, method);
      } finally {
        lease.release();
      }
    }
    return { ok: false, outcome: "error", reason: "The MCP server refused the protocol revision." };
  }

  /** `withServer`'s answer when no connection could be acquired. */
  private serverConnectFailure(error: unknown, server: McpServerRecord): McpServerUse<never> {
    const failed = this.connectFailure(error, server);
    if (failed.ok) return { ok: false, outcome: "error", reason: "The MCP server could not be reached." };
    if (failed.outcome === "denied") return failed;
    return {
      ok: false,
      outcome: failed.outcome === "cancelled" || failed.outcome === "file_refused" ? "error" : failed.outcome,
      reason: failed.reason,
      thrown: error,
    };
  }

  /**
   * `withServer`'s answer when the work on a lease threw: safe text only, the
   * error kept as `thrown`. A step-up answer (403 `insufficient_scope`) on
   * these methods is not a failed login: the login holds the scopes the tool
   * calls need, and the skills scope is optional (a Console answers
   * `skills/get` and `resources/read` without it with exactly this), so the
   * row is not marked `needs_login`. A 429 is recorded for `ravi mcp show`.
   */
  private serverRunFailure(
    error: unknown,
    server: McpServerRecord,
    lease: McpConnectionLease,
    method: string,
  ): McpServerUse<never> {
    const stepUp = mcpStepUpScopes(error);
    if (stepUp) {
      const missing = stepUp.length > 0 ? stepUp.join(" ") : "the skills scope, for a Ravi Console server";
      return {
        ok: false,
        outcome: "insufficient_scope",
        reason: `MCP server ${server.name} refused this request: the stored login lacks the scope it needs (${missing}). The server's tools still work.`,
        thrown: error,
      };
    }
    if (isMcpRateLimited(error)) {
      const retryAfterMs = this.noteRateLimit(server, method);
      return { ok: false, outcome: "rate_limited", reason: rateLimitedText(server.name, retryAfterMs), thrown: error };
    }
    const kind = classifyMcpFailure(error, server);
    if (kind === "needs_login") {
      this.markStatus(server, "needs_login", `run ${mcpLoginCommand(server.name, server.authKind)}`);
      return {
        ok: false,
        outcome: "needs_login",
        reason: `MCP server ${server.name} needs a login: run ${mcpLoginCommand(server.name, server.authKind)}`,
        thrown: error,
      };
    }
    return {
      ok: false,
      outcome: kind === "timeout" ? "timeout" : "error",
      reason: `MCP server ${server.name}: ${mcpFailureDetail(kind, error, server, lease.secrets)}`,
      thrown: error,
    };
  }

  /** A call may leave its turn only with a follower to deliver it and a session to deliver it to. */
  private canDetach(scope: McpCallScope, input: McpCallInput): boolean {
    return input.detach === true && this.callSink !== null && Boolean(scope.context?.sessionName?.trim());
  }

  /**
   * The SDK client path: connect (or reuse the server's connection), authorize
   * again on the era it speaks, and call through the shared input loop. One
   * more attempt only after a `-32022` refusal (the server ran nothing).
   */
  private async runSdkCall(
    scope: McpCallScope,
    input: McpCallInput,
    args: Record<string, unknown>,
    server: McpServerRecord,
    deadline: number,
    budget: number,
    progress: CallProgress,
  ): Promise<McpGatewayCallResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease: McpConnectionLease;
      try {
        lease = await this.connections.acquire(server, { ignoreStoredVerdict: attempt > 0 });
      } catch (error) {
        return this.connectFailure(error, server);
      }
      progress.era(lease.era);
      this.persistVerdict(server, lease);
      // The era is known only now (a stored verdict may have been refused, or a reconnect answered the
      // legacy way). The audience rule depends on it (a credentialed row on the legacy leg is
      // operator-only), so the use is authorized again on the era this connection speaks, before
      // anything is sent on it.
      const onEra = this.authorizeOnEra(scope, input, lease.era);
      if (!onEra.allowed) {
        lease.release();
        return { ok: false, outcome: "denied", code: onEra.code, reason: onEra.reason };
      }
      lease.bindCall({
        scope,
        server: input.server,
        tool: input.tool,
        deadline,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(progress.elicitation ? { onElicitation: progress.elicitation } : {}),
      } satisfies McpCallBinding);
      try {
        const result = await this.callWithInput(scope, input, args, lease, deadline, progress);
        const normalized = normalizeMcpCallResult(result);
        this.noteUsable(server);
        return { ok: true, ...normalized, era: lease.era, rounds: 0 };
      } catch (error) {
        const step = await this.callFailure(error, { attempt, lease, server, input, budget, deadline });
        if (step === "retry") continue;
        return step;
      } finally {
        lease.release();
      }
    }
    return { ok: false, outcome: "error", reason: "The MCP server refused the protocol revision." };
  }

  /**
   * The raw dispatch path (a modern HTTP server that declares tasks or file
   * uploads): the same authorization on the modern era, the same input loop,
   * and a task handed back to the caller instead of a result.
   */
  private async runRawCall(
    scope: McpCallScope,
    input: McpCallInput,
    args: Record<string, unknown>,
    server: McpServerRecord,
    deadline: number,
    progress: CallProgress,
    plan: McpCallPlan = { uploads: false, files: [] },
  ): Promise<McpDetachedWork> {
    let dispatcher: McpRawDispatcher;
    try {
      dispatcher = await this.createRawDispatcher(server, {
        uploads: plan.uploads,
        ...(plan.tasks === false ? { tasks: false } : {}),
      });
    } catch (error) {
      return { kind: "result", result: this.connectFailure(error, server) };
    }
    progress.era("modern");
    const onEra = this.authorizeOnEra(scope, input, "modern");
    if (!onEra.allowed) {
      return { kind: "result", result: { ok: false, outcome: "denied", code: onEra.code, reason: onEra.reason } };
    }
    try {
      const result = await callMcpToolRaw(dispatcher, {
        tool: input.tool,
        arguments: args,
        answer: this.inputAnswerer(scope, input, "modern", deadline, progress.elicitation),
        deadline,
        now: () => this.now(),
        onRound: progress.rounds,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      this.noteUsable(server);
      if (result.resultType === "task") return { kind: "task", task: result.task, era: "modern" };
      if (result.resultType === "upload_required") {
        if (plan.files.length === 0) {
          return {
            kind: "result",
            result: {
              ok: false,
              outcome: "error",
              reason: `MCP server ${server.name} asked for a file upload, but this call names no file Ravi may send; nothing was uploaded and the call was not sent again.`,
            },
          };
        }
        return await this.uploadAndRetry(dispatcher, server, input, args, deadline, progress, plan, result);
      }
      return {
        kind: "result",
        result: { ok: true, ...normalizeMcpCallResult(result.result), era: "modern", rounds: 0 },
      };
    } catch (error) {
      return { kind: "result", result: this.rawCallFailure(error, server, input, deadline) };
    }
  }

  /**
   * The upload step of a file call: validate every target against the files
   * of this call, send each file, then send the call once more with the same
   * arguments and the `requestState`, and nothing else. A refused target or a
   * failed upload sends no retry (the server runs nothing). The retry is never
   * sent twice: whatever it answers, or fails with, is the call's outcome.
   */
  private async uploadAndRetry(
    dispatcher: McpRawDispatcher,
    server: McpServerRecord,
    input: McpCallInput,
    args: Record<string, unknown>,
    deadline: number,
    progress: CallProgress,
    plan: McpCallPlan,
    asked: { uploads: unknown[]; requestState: string },
  ): Promise<McpDetachedWork> {
    const fail = (reason: string): McpDetachedWork => ({
      kind: "result",
      result: { ok: false, outcome: "error", reason },
    });
    const validated = validateMcpUploadTargets(asked.uploads, plan.files, this.now());
    if (!validated.ok) {
      progress.upload?.({ files: 0, bytes: 0, outcome: "refused" });
      return fail(
        `${validated.reason} Nothing was uploaded and the call was not completed; call the tool again to start over.`,
      );
    }
    const sent = await performMcpUploads(validated.plans, {
      deadline,
      now: () => this.now(),
      ...(this.options.files?.transport ? { transport: this.options.files.transport } : {}),
      ...(this.options.files?.lookup ? { lookup: this.options.files.lookup } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    progress.upload?.({ files: sent.files, bytes: sent.bytes, outcome: sent.ok ? "sent" : "failed" });
    if (!sent.ok) {
      if (sent.code === "cancelled") {
        return {
          kind: "result",
          result: {
            ok: false,
            outcome: "cancelled",
            reason: `${sent.reason} The call was not completed on the server.`,
          },
        };
      }
      return fail(
        `${sent.reason} The call was not completed on the server (Ravi did not confirm the upload to it); call the tool again to start over.`,
      );
    }
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      return {
        kind: "result",
        result: {
          ok: false,
          outcome: "timeout",
          reason: `The files were uploaded, but no time was left to complete the call on MCP server ${server.name}; it was not completed. Call the tool again to start over.`,
        },
      };
    }
    let retried: Awaited<ReturnType<McpRawDispatcher["callTool"]>>;
    try {
      // Same name and arguments, the request state, nothing else (no answers, no new confirmation).
      retried = await dispatcher.callTool(
        { name: input.tool, arguments: args, requestState: asked.requestState },
        { timeoutMs: remaining, ...(input.signal ? { signal: input.signal } : {}) },
      );
    } catch (error) {
      return { kind: "result", result: this.uploadRetryFailure(error, server, input) };
    }
    if (retried.resultType === "task") return { kind: "task", task: retried.task, era: "modern" };
    if (retried.resultType === "complete") {
      return {
        kind: "result",
        result: { ok: true, ...normalizeMcpCallResult(retried.result), era: "modern", rounds: 0 },
      };
    }
    return fail(
      `MCP server ${server.name} asked for more after the upload (${retried.resultType}); Ravi does not send the call a third time. Its outcome on the server is unknown.`,
    );
  }

  /** The outcome of the retry after an upload that failed: never sent again, whatever happened. */
  private uploadRetryFailure(error: unknown, server: McpServerRecord, input: McpCallInput): McpGatewayCallResult {
    const never = "It was not sent again.";
    if (input.signal?.aborted) {
      return {
        ok: false,
        outcome: "cancelled",
        reason: `The call was cancelled after its files were uploaded; its outcome on the server is unknown. ${never}`,
      };
    }
    if (error instanceof McpRawDispatchError) {
      // Answered before the server handled the call: nothing ran. Ravi keeps no
      // upload between calls, so the next call uploads the files again.
      const again = "Ravi does not keep the upload between calls, so calling the tool again uploads the files again.";
      if (error.kind === "rate_limited") {
        const retryAfterMs = this.noteRateLimit(server, "tools/call", error.retryAfterMs ?? MCP_DEFAULT_RETRY_AFTER_MS);
        return {
          ok: false,
          outcome: "error",
          reason: `The files were uploaded, but ${rateLimitedText(server.name, retryAfterMs)} ${again} ${never}`,
        };
      }
      const stepUp = mcpStepUpScopes(error);
      if (stepUp) {
        // A scope this login lacks concerns this call only: the row keeps its status.
        return {
          ok: false,
          outcome: "error",
          reason: `The files were uploaded, but ${mcpStepUpCallText(server.name, stepUp)} ${again} ${never}`,
        };
      }
      if (error.kind === "needs_login") {
        if (server.authKind !== "none") {
          this.markStatus(server, "needs_login", `run ${mcpLoginCommand(server.name, server.authKind)}`);
          return {
            ok: false,
            outcome: "needs_login",
            reason: `The files were uploaded, but MCP server ${server.name} needs a login, so nothing ran: run ${mcpLoginCommand(server.name, server.authKind)}, then call the tool again. ${again} ${never}`,
          };
        }
      }
      if (error.kind === "missing_capability" || error.kind === "unsupported_version") {
        if (error.kind === "unsupported_version") this.scheduleRefresh(server.name, { ignoreStoredVerdict: true });
        return {
          ok: false,
          outcome: "error",
          reason: `The files were uploaded, but MCP server ${server.name} refused the call before running it, so nothing ran: ${error.message} ${again} ${never}`,
        };
      }
      if (!error.outcomeUnknown && error.kind !== "invalid_params") {
        return {
          ok: false,
          outcome: error.kind === "needs_login" ? "needs_login" : "error",
          reason: `The files were uploaded, but MCP server ${server.name} refused to complete the call: ${error.message} The upload is used up; call the tool again to start over. ${never}`,
        };
      }
      return {
        ok: false,
        outcome: error.kind === "timeout" ? "timeout" : "error",
        reason: `The files were uploaded, but completing the call on MCP server ${server.name} failed: ${error.message} Its outcome on the server is unknown. ${never}`,
      };
    }
    return {
      ok: false,
      outcome: "error",
      reason: `The files were uploaded, but completing the call failed: ${safeMcpErrorText(error)} Its outcome on the server is unknown. ${never}`,
    };
  }

  /** The outcome of a raw call that failed. A call whose outcome is unknown is never sent again. */
  private rawCallFailure(
    error: unknown,
    server: McpServerRecord,
    input: McpCallInput,
    deadline: number,
  ): McpGatewayCallResult {
    if (input.signal?.aborted) {
      return {
        ok: false,
        outcome: "cancelled",
        reason: "The call was cancelled; its outcome on the server is unknown and it was not sent again.",
      };
    }
    if (error instanceof McpInputError) return { ok: false, outcome: "error", reason: error.message };
    if (!(error instanceof McpRawDispatchError)) {
      return { ok: false, outcome: "error", reason: `The MCP call failed: ${safeMcpErrorText(error)}` };
    }
    switch (error.kind) {
      case "insufficient_scope":
        // A step-up concerns this call only (a write on a read-only grant, say): the row keeps its status,
        // its connection stays, and the model is told the scope and what the operator can do.
        return { ok: false, outcome: "error", reason: mcpStepUpCallText(server.name, mcpStepUpScopes(error) ?? []) };
      case "needs_login":
        if (server.authKind !== "none") {
          this.markStatus(server, "needs_login", `run ${mcpLoginCommand(server.name, server.authKind)}`);
          return {
            ok: false,
            outcome: "needs_login",
            reason: `MCP server ${server.name} needs a login: run ${mcpLoginCommand(server.name, server.authKind)}`,
          };
        }
        return { ok: false, outcome: "error", reason: error.message };
      case "unsupported_version":
        // The stored modern verdict is stale (addendum A6): probe again at once. The server ran nothing.
        this.scheduleRefresh(server.name, { ignoreStoredVerdict: true });
        return {
          ok: false,
          outcome: "error",
          reason: `MCP server ${server.name} refused the protocol revision, so nothing ran. Ravi is probing the server again; the call can be made again after that.`,
        };
      case "missing_capability":
        return {
          ok: false,
          outcome: "error",
          reason: error.requiredExtensions.includes("io.modelcontextprotocol/files")
            ? `MCP server ${server.name} needs file uploads for this call, so nothing ran. Files are sent only for an agent with uploads on (ravi mcp set ${server.name} --uploads on --agent <agent> --execute).`
            : `MCP server ${server.name} needs a client capability Ravi did not declare for this call (${error.requiredExtensions.join(", ") || "unnamed"}), so nothing ran.`,
        };
      case "rate_limited": {
        const retryAfterMs = this.noteRateLimit(server, "tools/call", error.retryAfterMs ?? MCP_DEFAULT_RETRY_AFTER_MS);
        return { ok: false, outcome: "error", reason: rateLimitedText(server.name, retryAfterMs) };
      }
      default:
        break;
    }
    if (error.outcomeUnknown) {
      const timedOut = error.kind === "timeout" || this.now() >= deadline;
      return {
        ok: false,
        outcome: timedOut ? "timeout" : "error",
        reason: `${error.message} Its outcome on the server is unknown and it was not sent again.`,
      };
    }
    return { ok: false, outcome: "error", reason: error.message };
  }

  /**
   * A call that may leave its turn. The work runs under its own cancellation
   * and a longer deadline; the caller waits for the inline budget only. A task
   * result, or the budget ending first, records the call with the follower and
   * returns its id. After that the caller's cancellation no longer reaches the
   * work (`ravi mcp calls cancel` does), the approval wait lease is let go,
   * and a late question is asked only under the origin turn (`lateContext`).
   */
  private async callDetachable(
    scope: McpCallScope,
    input: McpCallInput,
    args: Record<string, unknown>,
    server: McpServerRecord,
    started: number,
    budget: number,
    progress: CallProgress,
    plan: McpCallPlan = { uploads: false, files: [] },
  ): Promise<McpGatewayCallResult> {
    const sink = this.callSink;
    const context = scope.context;
    const sessionName = context?.sessionName?.trim();
    if (!sink || !context || !sessionName) {
      return this.runSdkCall(scope, input, args, server, started + budget, budget, progress);
    }
    const controller = new AbortController();
    let detached = false;
    let origin: McpCallOrigin | null = null;
    let era: McpEra | null = null;
    const onCallerAbort = () => {
      if (!detached) controller.abort();
    };
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const wait = detachableWait(scope.approvalWait);
    const gateway = this;
    const workScope: McpCallScope = {
      agentId: scope.agentId,
      ...(wait.lease ? { approvalWait: wait.lease } : {}),
      get context() {
        return detached ? (origin ? gateway.lateContext(origin) : null) : context;
      },
    };
    const workDeadline = started + MCP_DETACHED_CALL_MAX_MS;
    const workInput: McpCallInput = { ...input, signal: controller.signal };
    const elicited: McpElicitationOutcome[] = [];
    const workProgress: CallProgress = {
      era: (value) => {
        era = value;
        progress.era(value);
      },
      rounds: progress.rounds,
      ...(progress.upload ? { upload: progress.upload } : {}),
      elicitation: (outcome) => {
        elicited.push(outcome);
        progress.elicitation?.(outcome);
      },
    };
    const work: Promise<McpDetachedWork> = (
      mcpUsesRawDispatch(server) || plan.files.length > 0
        ? this.runRawCall(workScope, workInput, args, server, workDeadline, workProgress, plan)
        : this.runSdkCall(workScope, workInput, args, server, workDeadline, workDeadline - started, workProgress).then(
            (result): McpDetachedWork => ({ kind: "result", result }),
          )
    ).catch(
      (error): McpDetachedWork => ({
        kind: "result",
        result: { ok: false, outcome: "error", reason: `The MCP call failed inside Ravi: ${safeMcpErrorText(error)}` },
      }),
    );

    let timer: ReturnType<typeof setTimeout> | null = null;
    const budgetEnd = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), Math.max(0, started + budget - this.now()));
      timer.unref?.();
    });
    const detachWith = (reason: "task" | "budget", task?: McpRawTask): string => {
      origin = this.originOf(context);
      const id = sink.detach(
        {
          server: server.name,
          serverCreatedAt: server.createdAt,
          tool: input.tool,
          agentId: scope.agentId,
          surface: input.surface,
          era,
          sessionName,
          sessionKey: context.sessionKey ?? null,
          origin,
          reason,
          ...(task ? { task } : {}),
          ...(plan.uploads ? { filesUpload: true } : {}),
          startedAt: started,
        },
        reason === "budget" ? controller : undefined,
      );
      detached = true;
      wait.release();
      return id;
    };
    try {
      const first = await Promise.race([work, budgetEnd]);
      if (first !== "budget") {
        if (first.kind === "result") return first.result;
        const inline = mcpTaskResultInline(first.task, server.name);
        if (inline) return inline;
        let taskCallId: string | null = null;
        try {
          taskCallId = detachWith("task", first.task);
        } catch {
          // no-cause: the row could not be written; the model is told below that the result cannot arrive.
          log.warn("MCP task could not be recorded for delivery", { server: server.name });
        }
        if (taskCallId === null) {
          return {
            ok: false,
            outcome: "error",
            reason: `MCP server ${server.name} started a background task (${first.task.taskId}), but Ravi could not record it, so its result will not arrive in this session. Do not call the tool again blindly: the task may still complete on the server.`,
          };
        }
        return detachedResult(taskCallId, "task", server.name, input.tool, first.era, budget);
      }
      let recorded: string | null = null;
      try {
        recorded = detachWith("budget");
      } catch {
        // no-cause: without a row nobody would deliver the result, so the call ends as a timeout below.
        log.warn("MCP call could not be recorded for delivery; it ends at its budget", { server: server.name });
      }
      if (recorded === null) {
        controller.abort();
        return {
          ok: false,
          outcome: "timeout",
          reason: `The MCP call did not finish within ${Math.round(budget / 1000)} s; its outcome on the server is unknown and it was not sent again.`,
        };
      }
      const id = recorded;
      void work.then((late) => {
        try {
          // The late result carries Ravi's note too, the same as an inline one would.
          const noted: McpDetachedWork =
            late.kind === "result"
              ? {
                  kind: "result",
                  result: withMcpRaviNote(late.result, mcpRaviNoteFor(server.name, elicited, late.result)),
                }
              : late;
          sink.settle(id, noted);
        } catch {
          // no-cause: the follower reports its own failures; the row stays for restart recovery.
          log.warn("MCP detached call could not be settled", { server: server.name });
        }
      });
      return detachedResult(id, "budget", server.name, input.tool, era ?? server.era ?? "modern", budget);
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** `authorizeMcpUse` for a call, with the row read as speaking the era of the connection in hand. */
  private authorizeOnEra(
    scope: McpCallScope,
    input: { server: string; tool?: string },
    era: McpEra,
    surface: "call" | "skill" = "call",
  ) {
    const deps = this.options.authorize ?? {};
    const readServer = deps.getServer ?? getMcpServer;
    return authorizeMcpUse(
      {
        context: scope.context,
        agentId: scope.agentId,
        server: input.server,
        ...(surface === "call" ? { tool: input.tool } : {}),
        surface,
      },
      {
        ...deps,
        getServer: (name) => {
          const row = readServer(name);
          return row ? { ...row, era } : null;
        },
      },
    );
  }

  /** The outcome of a call whose connection could not be opened. */
  private connectFailure(error: unknown, server: McpServerRecord): McpGatewayCallResult {
    if (error instanceof McpConnectionError && error.code === "closed") {
      return { ok: false, outcome: "error", reason: "The MCP gateway is stopping; the call was not sent." };
    }
    if (isMcpRateLimited(error)) {
      const retryAfterMs = this.noteRateLimit(server, "connect");
      return { ok: false, outcome: "error", reason: rateLimitedText(server.name, retryAfterMs) };
    }
    const kind = classifyMcpFailure(error, server);
    if (kind === "needs_login") {
      this.markStatus(server, "needs_login", `run ${mcpLoginCommand(server.name, server.authKind)}`);
      return {
        ok: false,
        outcome: "needs_login",
        reason: `MCP server ${server.name} needs a login: run ${mcpLoginCommand(server.name, server.authKind)}`,
      };
    }
    const detail = mcpFailureDetail(kind, error, server);
    this.markStatus(server, "error", detail);
    return {
      ok: false,
      outcome: kind === "timeout" ? "timeout" : "error",
      reason: `MCP server ${server.name} could not be reached: ${detail}`,
    };
  }

  /**
   * The outcome of a call that failed after it was sent, or `retry` when the
   * server refused the protocol revision before running anything (once).
   * A call whose outcome is unknown is never sent again.
   */
  private async callFailure(
    error: unknown,
    state: {
      attempt: number;
      lease: McpConnectionLease;
      server: McpServerRecord;
      input: McpCallInput;
      budget: number;
      deadline: number;
    },
  ): Promise<McpGatewayCallResult | "retry"> {
    const { lease, server } = state;
    if (state.input.signal?.aborted) {
      return {
        ok: false,
        outcome: "cancelled",
        reason: "The call was cancelled; its outcome on the server is unknown and it was not sent again.",
      };
    }
    if (error instanceof McpInputError) return { ok: false, outcome: "error", reason: error.message };
    if (isMcpRateLimited(error)) {
      // A 429 is answered before the server runs anything: the server's back-off, never sent again here.
      const retryAfterMs = this.noteRateLimit(server, "tools/call");
      return { ok: false, outcome: "error", reason: rateLimitedText(server.name, retryAfterMs) };
    }
    const stepUp = mcpStepUpScopes(error);
    if (stepUp) {
      // A step-up concerns this call only: the connection stays, the row keeps its status.
      return { ok: false, outcome: "error", reason: mcpStepUpCallText(server.name, stepUp) };
    }
    if (state.attempt === 0 && isMcpVersionRefusal(error)) {
      // The server refused the revision before running anything: negotiate again and call once more.
      await lease.discard();
      return "retry";
    }
    if (lease.reusedVerdict && lease.era === "modern" && isMcpInvalidResult(error)) {
      // The server no longer speaks the stored revision. The tool may have run, so it is not sent again;
      // the connection is dropped and a refresh negotiates afresh.
      await lease.discard();
      this.scheduleRefresh(server.name, { ignoreStoredVerdict: true });
      return {
        ok: false,
        outcome: "error",
        reason: `MCP server ${server.name} answered outside its stored protocol revision; the outcome is unknown and the call was not sent again. Ravi is probing the server again.`,
      };
    }
    const kind = classifyMcpFailure(error, server);
    if (kind === "needs_login") {
      await lease.discard();
      this.markStatus(server, "needs_login", `run ${mcpLoginCommand(server.name, server.authKind)}`);
      return {
        ok: false,
        outcome: "needs_login",
        reason: `MCP server ${server.name} needs a login: run ${mcpLoginCommand(server.name, server.authKind)}`,
      };
    }
    if (kind === "refused") {
      // The server refused the call (401 on a row without a login, or a plain 403). A login does not
      // change that, so the row is not marked needs_login; the tool did not run.
      await lease.discard();
      return {
        ok: false,
        outcome: "error",
        reason: `MCP server ${server.name} ${mcpFailureDetail(kind, error, server)}.`,
      };
    }
    if (kind === "timeout" || this.now() >= state.deadline) {
      return {
        ok: false,
        outcome: "timeout",
        reason: `The MCP call did not finish within ${Math.round(state.budget / 1000)} s; its outcome on the server is unknown and it was not sent again.`,
      };
    }
    return { ok: false, outcome: "error", reason: `The MCP call failed: ${safeMcpErrorText(error, lease.secrets)}` };
  }

  private async callWithInput(
    scope: McpCallScope,
    input: McpCallInput,
    args: Record<string, unknown>,
    lease: McpConnectionLease,
    deadline: number,
    progress: CallProgress,
  ): Promise<unknown> {
    return runMcpInputRequiredLoop({
      server: input.server,
      deadline,
      now: () => this.now(),
      onRound: progress.rounds,
      answer: this.inputAnswerer(scope, input, lease.era, deadline, progress.elicitation),
      send: async (retry, remaining) =>
        (await lease.client.callTool(
          { name: input.tool, arguments: args, ...(retry ?? {}) } as {
            name: string;
            arguments: Record<string, unknown>;
          },
          {
            allowInputRequired: true,
            timeout: remaining,
            maxTotalTimeout: remaining,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        )) as unknown as Record<string, unknown>,
    });
  }

  /**
   * The answer step of the `input_required` loop for one call: each embedded
   * request goes to the elicitation handler with the call's scope and the
   * round's shared window (`answerBy`). Both call paths (the SDK client here,
   * the raw dispatch for tasks and uploads) and the follower's task input use
   * it. `onOutcome` hears how each request was answered.
   */
  inputAnswerer(
    scope: McpCallScope,
    input: Pick<McpCallInput, "server" | "tool" | "signal">,
    era: McpEra,
    deadline: number,
    onOutcome?: (outcome: McpElicitationOutcome) => void,
  ): McpInputAnswer {
    return (key, params, round) =>
      this.answer(
        {
          scope,
          server: input.server,
          tool: input.tool,
          era,
          key,
          params,
          deadline,
          answerBy: round?.answerBy ?? this.now() + MCP_INPUT_ROUND_ANSWER_MS,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        onOutcome,
      );
  }

  /**
   * Ask the handler, raced against the call's deadline and its cancellation:
   * a handler that has not answered by then answers `cancel` (it is not
   * waited for). Anything but `accept`, `decline` or `cancel`, and a handler
   * that fails, answers `cancel`, never content.
   */
  private async answer(
    request: McpElicitationRequest,
    onOutcome?: (outcome: McpElicitationOutcome) => void,
  ): Promise<ElicitResult> {
    let settled = false;
    let reported: McpElicitationOutcome | null = null;
    const done = (result: ElicitResult, reason: string): ElicitResult => {
      settled = true;
      const action: McpElicitationOutcome["action"] =
        result.action === "accept" || result.action === "decline" ? result.action : "cancel";
      const outcome: McpElicitationOutcome = reported && reported.action === action ? reported : { action, reason };
      try {
        onOutcome?.(outcome);
      } catch {
        // no-cause: the outcome only feeds the trace and the note; the answer stands.
      }
      return result;
    };
    const handler = this.options.elicit;
    if (!handler) return done(await declineMcpElicitation(request), "no_handler");
    const answerBy = Math.min(request.answerBy ?? this.now() + MCP_INPUT_ROUND_ANSWER_MS, request.deadline);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const limit = new Promise<"timeout" | "cancelled">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, request.deadline - this.now()));
      timer.unref?.();
      const signal = request.signal;
      if (signal) {
        if (signal.aborted) resolve("cancelled");
        onAbort = () => resolve("cancelled");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const answer = await Promise.race([
        handler({
          ...request,
          answerBy,
          report: (outcome) => {
            if (!settled) reported = outcome;
          },
        }),
        limit,
      ]);
      if (answer === "timeout" || answer === "cancelled") return done({ action: "cancel" }, answer);
      if (answer?.action === "accept" || answer?.action === "decline" || answer?.action === "cancel") {
        return done(answer, "unreported");
      }
      return done({ action: "cancel" }, "error");
    } catch {
      // no-cause: an answer that fails is a cancel, never content.
      return done({ action: "cancel" }, "error");
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && request.signal) request.signal.removeEventListener("abort", onAbort);
    }
  }
}

// ============================================================================
// The daemon's gateway
// ============================================================================

/** The daemon's gateway; it asks people through `requestMcpElicitation` unless told otherwise. */
export async function startMcpGateway(options: McpGatewayOptions = {}): Promise<McpGateway> {
  const running = getMcpGateway();
  if (running) return running;
  const gateway = new McpGateway({ elicit: requestMcpElicitation, ...options });
  setMcpGatewayInstance(gateway);
  await gateway.start();
  return gateway;
}

export async function stopMcpGateway(): Promise<void> {
  const gateway = getMcpGateway();
  setMcpGatewayInstance(null);
  await gateway?.stop();
}
