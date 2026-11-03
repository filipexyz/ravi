/**
 * `X-Ravi-Exec-Context`: who is asking for a connector call and where.
 *
 * Sent by the local Ravi daemon on every exec: base64url of a JSON object,
 * at most 2 KB, version 1. The Worker cannot verify it (it trusts the
 * daemon holding the operator's CLI session; "Revoke installation" is the
 * answer to a daemon that lies). A missing header is an older CLI and is
 * treated as the terminal; a header that is present but malformed,
 * oversized or of an unknown version fails closed.
 */

import { z } from "zod";

export const EXEC_CONTEXT_HEADER = "x-ravi-exec-context";
export const EXEC_CONTEXT_MAX_BYTES = 2048;

// Printable labels only: they end up in usage rows and audit metadata.
const label = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);

const execContextV1Schema = z.strictObject({
  v: z.literal(1),
  agentId: label(200).optional(),
  sessionName: label(500).optional(),
  routine: z
    .strictObject({
      kind: z.enum(["cron", "heartbeat", "trigger"]),
      id: label(200).optional(),
    })
    .optional(),
  speaker: z.strictObject({
    kind: z.enum(["terminal", "owner", "contact", "agent", "automation"]),
    contactId: label(200).optional(),
    consoleUserId: label(200).optional(),
  }),
  conversation: z.enum(["terminal", "dm", "group", "automation"]),
  // sha256 hex of the root runtime turn context id.
  turnKey: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  agentDisplayName: label(200).optional(),
});

export type ExecContextV1 = z.infer<typeof execContextV1Schema>;

export interface ParsedExecContext {
  context: ExecContextV1;
  /** No header: an older CLI. Policy treats it as the terminal; usage records `legacy_cli`. */
  legacyCli: boolean;
}

export type ExecContextFailure = "too_large" | "not_base64url" | "not_json" | "unsupported_version" | "invalid";

export type ExecContextParseResult =
  | ({ ok: true } & ParsedExecContext)
  | { ok: false; reason: ExecContextFailure };

export const LEGACY_CLI_EXEC_CONTEXT: ExecContextV1 = Object.freeze({
  v: 1,
  speaker: Object.freeze({ kind: "terminal" }),
  conversation: "terminal",
}) as ExecContextV1;

export function parseExecContextHeader(value: string | null | undefined): ExecContextParseResult {
  if (value === null || value === undefined) {
    return { ok: true, context: LEGACY_CLI_EXEC_CONTEXT, legacyCli: true };
  }
  const encoded = value.trim();
  if (encoded.length > EXEC_CONTEXT_MAX_BYTES) return { ok: false, reason: "too_large" };
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return { ok: false, reason: "not_base64url" };

  let text: string;
  try {
    text = base64UrlDecodeUtf8(encoded);
  } catch {
    return { ok: false, reason: "not_base64url" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "invalid" };
  if ((json as { v?: unknown }).v !== 1) return { ok: false, reason: "unsupported_version" };
  const parsed = execContextV1Schema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return { ok: true, context: parsed.data, legacyCli: false };
}

/**
 * A personal connection serves only its owner's own requests: the
 * terminal, the owner's own DM, and the owner's cron jobs and heartbeat.
 * Never a group, another agent, a trigger or other automations, or a
 * contact who is not the account owner. Fails closed on a context that
 * contradicts itself: a speaker whose Console user is someone else is not
 * the owner, whatever its kind says.
 */
export function personalUseDenial(
  context: ExecContextV1,
  ownerUserId: string | null,
): "connector_group_blocked" | "connector_speaker_not_owner" | null {
  if (context.conversation === "group") return "connector_group_blocked";
  const { speaker } = context;
  if (speaker.consoleUserId !== undefined && speaker.consoleUserId !== ownerUserId) {
    return "connector_speaker_not_owner";
  }
  const relayed = relayOrAutomationDenial(context);
  if (relayed) return relayed;
  if (speaker.kind === "contact" && (!ownerUserId || speaker.consoleUserId !== ownerUserId)) {
    return "connector_speaker_not_owner";
  }
  return null;
}

/**
 * A turn that no connection serves, whoever's it is: a relay from another
 * agent, a trigger, or an automation other than the operator's routines
 * (cron, heartbeat). A shared organization account checks only this (it
 * is nobody's own; its grant then decides the conversations).
 */
export function relayOrAutomationDenial(context: ExecContextV1): "connector_speaker_not_owner" | null {
  if (context.routine?.kind === "trigger") return "connector_speaker_not_owner";
  if (context.speaker.kind === "agent") return "connector_speaker_not_owner";
  if (context.speaker.kind === "automation") {
    const kind = context.routine?.kind;
    if (kind !== "cron" && kind !== "heartbeat") return "connector_speaker_not_owner";
  }
  return null;
}

/**
 * What may be stored with an approval or shown back to the owner: the
 * labels and the classification, never the turn key.
 */
export function safeExecContext(parsed: ParsedExecContext): Record<string, unknown> {
  const { context } = parsed;
  return {
    v: context.v,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentDisplayName ? { agentDisplayName: context.agentDisplayName } : {}),
    ...(context.sessionName ? { sessionName: context.sessionName } : {}),
    ...(context.routine ? { routine: { ...context.routine } } : {}),
    speaker: { ...context.speaker },
    conversation: context.conversation,
    ...(parsed.legacyCli ? { legacyCli: true } : {}),
  };
}

/** Audit metadata of an exec: who asked and where, never content. */
export function execAuditMetadata(
  parsed: ParsedExecContext,
  localInstallationId: string | null,
): Record<string, unknown> {
  return {
    agentId: parsed.context.agentId ?? null,
    routineKind: parsed.context.routine?.kind ?? null,
    conversation: parsed.context.conversation,
    speakerKind: parsed.context.speaker.kind,
    installationId: localInstallationId,
    ...(parsed.legacyCli ? { legacyCli: true } : {}),
  };
}

/** `cron:<id>`, `heartbeat`, ...; empty when the turn is no routine. */
export function routineKey(context: ExecContextV1): string {
  if (!context.routine) return "";
  return context.routine.id ? `${context.routine.kind}:${context.routine.id}` : context.routine.kind;
}

function base64UrlDecodeUtf8(input: string): string {
  const normalized = input.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
