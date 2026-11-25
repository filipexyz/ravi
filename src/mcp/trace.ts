/**
 * Trace events of the MCP gateway (spec mcp, Trace).
 *
 * `mcp.call` is a session trace event of the turn that made the call:
 * server, tool, surface, era, duration, outcome and byte counts. It never
 * carries arguments, results, answers, URLs or headers. A call without a
 * session (the operator's terminal) is logged instead, with the same fields.
 *
 * `mcp.elicitation` is a session trace event of the turn whose call a server
 * asked a question in: server, tool, era, mode, the number of fields, how many
 * questions went out, the action sent back and the reason for a refusal. It
 * never carries the server's message, an answer, a URL or who was
 * asked.
 *
 * `mcp.catalog.changed` is published on `ravi.mcp.catalog.changed` when a
 * server's catalog fingerprint changes (`variant: "files"` for the catalog
 * listed with the files extension declared): server name, fingerprints and
 * counts, never tool descriptions or schemas. Changes are traced, not blocked.
 *
 * A call with file arguments adds `upload` to its `mcp.call` event: the
 * number of files and bytes sent and the upload outcome, never a path, a
 * target, a header or the request state.
 *
 * A call made through the gateway adds `elicitation`: what was answered to the
 * server's questions (`accepted`, `declined`, `cancelled`, or `none` when it
 * asked nothing) and the fixed reason code of that answer, so a declined
 * write does not read as a plain `ok`. Never an answer, a field or a message.
 *
 * `mcp.skill` is a session trace event of the turn that read a remote skill
 * (`op: "read"`): server, skill id, file path, bytes, whether the bytes came
 * from the cache or the server, the outcome and the fixed reason code of a
 * refusal (`MCP_SKILL_EXTERNAL_DENIED`, `MCP_AUDIENCE`, `MCP_SKILL_STALE`,
 * `MCP_SKILL_DIGEST_MISMATCH`, ...). `op: "pin_state"` records a pin the
 * client changed by itself (stale, or restored), with the reason. Never the
 * skill's content. Without a session it is logged with the same fields.
 */

import { publish } from "../nats.js";
import type { ContextRecord } from "../router/router-db.js";
import { recordSessionEvent } from "../session-trace/session-trace-db.js";
import { logger } from "../utils/logger.js";
import type { McpEra } from "./registry-db.js";

const log = logger.child("mcp:trace");

export const MCP_CATALOG_CHANGED_TOPIC = "ravi.mcp.catalog.changed";

export type McpCallSurface = "claude" | "cli";
/** `background`: the follower's record of a detached call when its outcome is known. */
export type McpCallTraceSurface = McpCallSurface | "background";
export type McpCallTraceOutcome =
  | "ok"
  | "tool_error"
  | "denied"
  | "file_refused"
  | "needs_login"
  | "timeout"
  | "cancelled"
  | "error"
  | "detached"
  | "expired"
  | "lost"
  | "discarded";

export interface McpCallTraceInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  server: string;
  tool: string;
  surface: McpCallTraceSurface;
  era: McpEra | null;
  durationMs: number;
  outcome: McpCallTraceOutcome;
  /** The session to trace under when there is no context record (a detached call's follower). */
  session?: { key: string | null; name: string | null };
  /** A detached call's id (`mc_...`). */
  callId?: string;
  /** Size of the result handed back (text, structured content, images), in bytes. */
  bytes: number;
  /** Input rounds (`input_required`) the call went through. */
  rounds?: number;
  /** A call with file arguments: how many files and bytes went to storage, and how it ended. Never a target. */
  upload?: McpUploadTrace;
  /** What the server's questions were answered with (gateway calls). */
  elicitation?: McpCallElicitationTrace;
}

/** The elicitation part of an `mcp.call` event: an outcome and a fixed reason code, nothing else. */
export interface McpCallElicitationTrace {
  outcome: "accepted" | "declined" | "cancelled" | "none";
  /** The reason code of the answer that decided the outcome (absent for `none`). */
  reason?: string;
}

/** The upload part of an `mcp.call` event: counts and an outcome, nothing else. */
export interface McpUploadTrace {
  files: number;
  bytes: number;
  /** `sent`: every file reached storage; `failed`: one did not; `refused`: a gate or a target refused it. */
  outcome: "sent" | "failed" | "refused";
}

export interface McpCatalogChangedEvent {
  server: string;
  /** `files`: the catalog listed with the files extension declared (what attachments with uploads on see). */
  variant?: "files";
  fingerprint: string;
  previousFingerprint: string | null;
  toolCount: number;
  droppedCount: number;
}

export type McpElicitationTraceAction = "accept" | "decline" | "cancel";

export interface McpElicitationTraceInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  server: string;
  tool: string;
  era: McpEra;
  /** `form`, `url`, or `unknown` for a request whose mode Ravi does not serve. */
  mode: "form" | "url" | "unknown";
  /** Fields the form asked for (0 for URL mode). */
  fieldCount: number;
  /** Questions that went out to the person (0 when nothing was sent). */
  questions: number;
  action: McpElicitationTraceAction;
  /** Why Ravi answered without the person, or why the answer is not an accept: a fixed code. */
  reason: string;
  durationMs: number;
}

export interface McpSkillTraceInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  server: string;
  /** `read`: a `ravi mcp skills read`; `pin_state`: a pin the client marked stale or restored by itself. */
  op: "read" | "pin_state";
  /** `mcp:<server>:<path>`. */
  skill: string;
  /** The file read, relative to the skill root (reads only). */
  file?: string;
  /** Bytes of the file handed back (0 when refused). */
  bytes?: number;
  /** Where the bytes came from (a read that returned a file). */
  source?: "cached" | "fetched";
  /** `ok`, `denied` (a gate refused it), `error`; for `pin_state`: `stale` or `restored`. */
  outcome: "ok" | "denied" | "error" | "stale" | "restored";
  /** A fixed code: the error code of a refused read, the stale reason of a pin change. */
  reason?: string;
  /** The pin whose state changed (pin_state). */
  pinAgent?: string;
  durationMs?: number;
}

type CallTraceSink = (input: McpCallTraceInput) => void;
type SkillTraceSink = (input: McpSkillTraceInput) => void;
type CatalogChangedSink = (event: McpCatalogChangedEvent) => void;
type ElicitationTraceSink = (input: McpElicitationTraceInput) => void;

let callSinkForTests: CallTraceSink | null = null;
let catalogSinkForTests: CatalogChangedSink | null = null;
let elicitationSinkForTests: ElicitationTraceSink | null = null;
let skillSinkForTests: SkillTraceSink | null = null;

/** Tests: capture the trace events (null restores the real sinks). */
export function setMcpTraceSinksForTests(sinks: {
  call?: CallTraceSink | null;
  catalog?: CatalogChangedSink | null;
  elicitation?: ElicitationTraceSink | null;
  skill?: SkillTraceSink | null;
}) {
  if (sinks.call !== undefined) callSinkForTests = sinks.call;
  if (sinks.catalog !== undefined) catalogSinkForTests = sinks.catalog;
  if (sinks.elicitation !== undefined) elicitationSinkForTests = sinks.elicitation;
  if (sinks.skill !== undefined) skillSinkForTests = sinks.skill;
}

function short(value: string, max = 64): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function recordMcpCallTrace(input: McpCallTraceInput): void {
  if (callSinkForTests) {
    callSinkForTests(input);
    return;
  }
  const payload = {
    server: short(input.server),
    tool: short(input.tool),
    surface: input.surface,
    era: input.era,
    outcome: input.outcome,
    bytes: Math.max(0, Math.trunc(input.bytes)),
    ...(input.rounds ? { rounds: input.rounds } : {}),
    ...(input.callId ? { callId: short(input.callId) } : {}),
    ...(input.upload
      ? {
          upload: {
            files: Math.max(0, Math.trunc(input.upload.files)),
            bytes: Math.max(0, Math.trunc(input.upload.bytes)),
            outcome: input.upload.outcome,
          },
        }
      : {}),
    ...(input.elicitation
      ? {
          elicitation: {
            outcome: input.elicitation.outcome,
            ...(input.elicitation.reason ? { reason: short(input.elicitation.reason, 40) } : {}),
          },
        }
      : {}),
  };
  const sessionKey = input.context?.sessionKey ?? input.session?.key ?? undefined;
  try {
    if (sessionKey) {
      recordSessionEvent({
        sessionKey,
        sessionName: input.context?.sessionName ?? input.session?.name ?? null,
        agentId: input.agentId,
        eventType: "mcp.call",
        eventGroup: "tool",
        status: input.outcome,
        payloadJson: payload,
        durationMs: Math.max(0, Math.trunc(input.durationMs)),
      });
      return;
    }
  } catch {
    // no-cause: a trace write failure must not change the call's outcome; the log line below keeps the record.
  }
  log.info("mcp.call", { agentId: short(input.agentId), durationMs: Math.trunc(input.durationMs), ...payload });
}

export function recordMcpElicitationTrace(input: McpElicitationTraceInput): void {
  if (elicitationSinkForTests) {
    elicitationSinkForTests(input);
    return;
  }
  const payload = {
    server: short(input.server),
    tool: short(input.tool),
    era: input.era,
    mode: input.mode,
    fieldCount: Math.max(0, Math.trunc(input.fieldCount)),
    questions: Math.max(0, Math.trunc(input.questions)),
    action: input.action,
    reason: short(input.reason, 40),
  };
  const sessionKey = input.context?.sessionKey;
  try {
    if (sessionKey) {
      recordSessionEvent({
        sessionKey,
        sessionName: input.context?.sessionName ?? null,
        agentId: input.agentId,
        eventType: "mcp.elicitation",
        eventGroup: "tool",
        status: input.action,
        payloadJson: payload,
        durationMs: Math.max(0, Math.trunc(input.durationMs)),
      });
      return;
    }
  } catch {
    // no-cause: a trace write failure must not change the answer; the log line below keeps the record.
  }
  log.info("mcp.elicitation", { agentId: short(input.agentId), durationMs: Math.trunc(input.durationMs), ...payload });
}

export function recordMcpSkillTrace(input: McpSkillTraceInput): void {
  if (skillSinkForTests) {
    skillSinkForTests(input);
    return;
  }
  const payload = {
    op: input.op,
    server: short(input.server),
    skill: short(input.skill, 240),
    ...(input.file !== undefined ? { file: short(input.file, 300) } : {}),
    ...(input.bytes !== undefined ? { bytes: Math.max(0, Math.trunc(input.bytes)) } : {}),
    ...(input.source ? { source: input.source } : {}),
    outcome: input.outcome,
    ...(input.reason ? { reason: short(input.reason, 40) } : {}),
    ...(input.pinAgent ? { pinAgent: short(input.pinAgent) } : {}),
  };
  const sessionKey = input.context?.sessionKey;
  try {
    if (sessionKey) {
      recordSessionEvent({
        sessionKey,
        sessionName: input.context?.sessionName ?? null,
        agentId: input.agentId,
        eventType: "mcp.skill",
        eventGroup: "tool",
        status: input.outcome,
        payloadJson: payload,
        durationMs: Math.max(0, Math.trunc(input.durationMs ?? 0)),
      });
      return;
    }
  } catch {
    // no-cause: a trace write failure must not change the read's outcome; the log line below keeps the record.
  }
  log.info("mcp.skill", { agentId: short(input.agentId), ...payload });
}

export function emitMcpCatalogChanged(event: McpCatalogChangedEvent): void {
  if (catalogSinkForTests) {
    catalogSinkForTests(event);
    return;
  }
  log.info("mcp.catalog.changed", { ...event });
  publish(MCP_CATALOG_CHANGED_TOPIC, { ...event }, { quietConnect: true }).catch(() => {
    // no-cause: best-effort notification; the stored catalog and fingerprint are the record.
    log.warn("ravi.mcp.catalog.changed could not be published", { server: event.server });
  });
}
