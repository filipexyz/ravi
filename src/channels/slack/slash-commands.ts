/**
 * Slack slash commands (`/ravi`): control for Ravi, not a message to an agent.
 *
 * A command never opens an agent turn and never spends model tokens. The
 * Socket Mode runner acks it within Slack's 3 s, verifies where it came from
 * and publishes `ravi.inbound.command`; the daemon resolves the person, the
 * session of the chat the command was typed in, checks that person's authority
 * and answers through the stored `response_url`. This module is the part both
 * sides share: the payload and event shapes, the text parser and the help.
 *
 * Spec: channels/slack/commands.
 */

import { cleanSlackId } from "./routing.js";

export const SLACK_COMMAND_TOPIC = "ravi.inbound.command";
export const SLACK_COMMAND_ENVELOPE_TYPE = "slash_commands";
export const SLACK_COMMAND_SOURCE = "slack.socket_mode";

/** Longer text is cut: no subcommand needs more, and it is never an agent prompt. */
export const SLACK_COMMAND_MAX_TEXT_LENGTH = 500;
export const SLACK_COMMAND_DEFAULT_IDLE_HOURS = 12;
export const SLACK_COMMAND_MAX_IDLE_HOURS = 24 * 30;

const SLACK_ID_PATTERN = /^[A-Z][A-Z0-9]{1,31}$/;
const SLACK_COMMAND_NAME_PATTERN = /^\/[a-z0-9][a-z0-9_-]{0,31}$/i;

/** The fields of a `slash_commands` payload Ravi reads. `token`, `user_name` and the like are never read. */
export interface SlackCommandPayload {
  readonly teamId: string;
  readonly enterpriseId?: string;
  readonly apiAppId?: string;
  readonly channelId: string;
  readonly userId: string;
  /** The command as typed, with its slash: `/ravi`. The name is configurable per instance. */
  readonly command: string;
  readonly text: string;
  readonly triggerId?: string;
  /** Held only by the runner, which stores it and publishes its id. */
  readonly responseUrl?: string;
}

/** What the runner publishes on `ravi.inbound.command`. It carries no `token` and no `response_url`. */
export interface SlackCommandEvent {
  readonly provider: "slack";
  readonly source: typeof SLACK_COMMAND_SOURCE;
  readonly accountId: string;
  /** Account scope routes are matched in; differs from `accountId` only when the instance configures it. */
  readonly routeAccountId: string;
  readonly instanceId: string;
  readonly envelopeId?: string;
  readonly apiAppId?: string;
  readonly teamId: string;
  readonly enterpriseId?: string;
  readonly channelId: string;
  readonly userId: string;
  readonly command: string;
  readonly text: string;
  readonly triggerId?: string;
  readonly responseUrlId?: string;
  /** The runner already answered inside the ack (help, usage, unknown word): the daemon only audits. */
  readonly ackedWithHelp?: boolean;
  readonly receivedAt: number;
}

export type SlackCommandParse =
  | { readonly kind: "status" }
  | { readonly kind: "threads" }
  | { readonly kind: "stop" }
  | { readonly kind: "close"; readonly threadRef: string }
  | { readonly kind: "close_idle"; readonly hours: number }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly command: "close" }
  | { readonly kind: "unknown"; readonly word: string };

/** Subcommands whose answer is static text: Slack takes it in the ack itself. */
export function isSlackCommandAnsweredInAck(parse: SlackCommandParse): boolean {
  return parse.kind === "help" || parse.kind === "usage" || parse.kind === "unknown";
}

function foldWord(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Parse what follows `/ravi`. Words are matched without accents or case; a thread ref keeps its case. */
export function parseSlackCommandText(text: string): SlackCommandParse {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return { kind: "help" };
  switch (foldWord(first)) {
    case "help":
    case "?":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "threads":
      return { kind: "threads" };
    case "stop":
      return { kind: "stop" };
    case "close": {
      const target = tokens[1];
      if (!target) return { kind: "usage", command: "close" };
      if (foldWord(target) === "idle") return parseIdleClose(tokens[2]);
      return { kind: "close", threadRef: target };
    }
    default:
      return { kind: "unknown", word: first.slice(0, 40) };
  }
}

function parseIdleClose(rawHours: string | undefined): SlackCommandParse {
  if (rawHours === undefined) return { kind: "close_idle", hours: SLACK_COMMAND_DEFAULT_IDLE_HOURS };
  const match = /^(\d{1,3})h?$/i.exec(rawHours);
  const hours = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > SLACK_COMMAND_MAX_IDLE_HOURS) {
    return { kind: "usage", command: "close" };
  }
  return { kind: "close_idle", hours };
}

export interface SlackCommandMessage {
  readonly response_type: "ephemeral";
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

/** An ephemeral message: only the person who typed the command sees it. */
export function slackCommandMessage(
  text: string,
  extraBlocks: readonly Record<string, unknown>[] = [],
): SlackCommandMessage {
  return {
    response_type: "ephemeral",
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }, ...extraBlocks],
  };
}

/**
 * The help every person gets. It names the command as it was typed, so an
 * instance that renamed it (`/hana`) reads its own name. It lists names only:
 * what a person may actually run is decided when they run it.
 */
export function slackCommandHelpMessage(
  command: string,
  note?: { readonly unknown?: string; readonly usage?: "close" },
): SlackCommandMessage {
  const name = SLACK_COMMAND_NAME_PATTERN.test(command) ? command : "/ravi";
  const lines: string[] = [];
  if (note?.unknown) lines.push(`I don't know \`${escapeBackticks(note.unknown)}\`.`);
  if (note?.usage === "close") {
    lines.push(`Usage: \`${name} close <thread>\` or \`${name} close idle [12h]\`.`);
  }
  lines.push(
    `*Ravi controls* (\`${name}\`)`,
    `• \`${name} status\`: who answers in this chat, whether it is working, and how many threads are open`,
    `• \`${name} threads\`: open threads of this session, with age and state`,
    `• \`${name} close <thread>\`: close a thread (the name \`${name} threads\` shows)`,
    `• \`${name} close idle [12h]\`: close threads with no activity for more than N hours, no turn running and no open question`,
    `• \`${name} stop\`: interrupt the turn running in this session (the queue goes on)`,
    "Only you see the replies. Slack does not accept commands inside a thread: use the channel or the DM.",
  );
  return slackCommandMessage(lines.join("\n"));
}

function escapeBackticks(value: string): string {
  return value.replaceAll("`", "'");
}

/** The ack payload for a static answer, or nothing when the answer needs the daemon. */
export function slackCommandAckPayload(payload: SlackCommandPayload): SlackCommandMessage | undefined {
  const parse = parseSlackCommandText(payload.text);
  if (!isSlackCommandAnsweredInAck(parse)) return undefined;
  return slackCommandHelpMessage(payload.command, {
    ...(parse.kind === "unknown" ? { unknown: parse.word } : {}),
    ...(parse.kind === "usage" ? { usage: parse.command } : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function slackId(value: unknown): string | undefined {
  const id = cleanSlackId(value);
  return id && SLACK_ID_PATTERN.test(id) ? id : undefined;
}

/** Read a `slash_commands` payload, or null when it is not one Ravi can act on. */
export function readSlackCommandPayload(payload: unknown): SlackCommandPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const teamId = slackId(record.team_id);
  const channelId = slackId(record.channel_id);
  const userId = slackId(record.user_id);
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!teamId || !channelId || !userId || !SLACK_COMMAND_NAME_PATTERN.test(command)) return null;
  const rawText = typeof record.text === "string" ? record.text : "";
  const enterpriseId = slackId(record.enterprise_id);
  const apiAppId = slackId(record.api_app_id);
  const triggerId = cleanSlackId(record.trigger_id);
  const responseUrl = typeof record.response_url === "string" ? record.response_url.trim() : undefined;
  return {
    teamId,
    channelId,
    userId,
    command,
    text: rawText.trim().slice(0, SLACK_COMMAND_MAX_TEXT_LENGTH),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(apiAppId ? { apiAppId } : {}),
    ...(triggerId ? { triggerId } : {}),
    ...(responseUrl ? { responseUrl } : {}),
  };
}

export type SlackCommandOriginVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "team_unverified" | "team_mismatch" | "app_mismatch" };

/**
 * Socket Mode has no request signature to check: the event arrives over a
 * WebSocket already authenticated by the app token. What can still be wrong
 * is whose command it is. A distributed app receives every installed
 * workspace's commands on one socket, so the workspace must be this
 * instance's; the app must be the one this connection has been seeing; and
 * the instance is the runner's own, never taken from the payload.
 */
export function verifySlackCommandOrigin(
  payload: Pick<SlackCommandPayload, "teamId" | "apiAppId">,
  expected: { readonly localTeamId?: string; readonly pinnedAppId?: string },
): SlackCommandOriginVerdict {
  if (!expected.localTeamId) return { ok: false, reason: "team_unverified" };
  if (payload.teamId !== expected.localTeamId) return { ok: false, reason: "team_mismatch" };
  if (expected.pinnedAppId && payload.apiAppId && payload.apiAppId !== expected.pinnedAppId) {
    return { ok: false, reason: "app_mismatch" };
  }
  return { ok: true };
}

export function buildSlackCommandEvent(input: {
  readonly payload: SlackCommandPayload;
  readonly accountId: string;
  readonly routeAccountId: string;
  readonly instanceId: string;
  readonly envelopeId?: string;
  readonly responseUrlId?: string;
  readonly ackedWithHelp: boolean;
  readonly receivedAt: number;
}): SlackCommandEvent {
  const { payload } = input;
  return {
    provider: "slack",
    source: SLACK_COMMAND_SOURCE,
    accountId: input.accountId,
    routeAccountId: input.routeAccountId,
    instanceId: input.instanceId,
    ...(input.envelopeId ? { envelopeId: input.envelopeId } : {}),
    ...(payload.apiAppId ? { apiAppId: payload.apiAppId } : {}),
    teamId: payload.teamId,
    ...(payload.enterpriseId ? { enterpriseId: payload.enterpriseId } : {}),
    channelId: payload.channelId,
    userId: payload.userId,
    command: payload.command,
    text: payload.text,
    ...(payload.triggerId ? { triggerId: payload.triggerId } : {}),
    ...(input.responseUrlId ? { responseUrlId: input.responseUrlId } : {}),
    ...(input.ackedWithHelp ? { ackedWithHelp: true } : {}),
    receivedAt: input.receivedAt,
  };
}

/** The daemon's view of an event off the bus: every field checked, nothing trusted by shape. */
export function parseSlackCommandEvent(data: unknown): SlackCommandEvent | null {
  const record = asRecord(data);
  if (!record) return null;
  if (record.provider !== "slack" || record.source !== SLACK_COMMAND_SOURCE) return null;
  const accountId = typeof record.accountId === "string" ? record.accountId.trim() : "";
  const instanceId = typeof record.instanceId === "string" ? record.instanceId.trim() : "";
  const teamId = slackId(record.teamId);
  const channelId = slackId(record.channelId);
  const userId = slackId(record.userId);
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const receivedAt = record.receivedAt;
  if (!accountId || !instanceId || !teamId || !channelId || !userId) return null;
  if (!SLACK_COMMAND_NAME_PATTERN.test(command)) return null;
  if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) return null;
  const routeAccountId =
    typeof record.routeAccountId === "string" && record.routeAccountId.trim()
      ? record.routeAccountId.trim()
      : accountId;
  const text = typeof record.text === "string" ? record.text.slice(0, SLACK_COMMAND_MAX_TEXT_LENGTH) : "";
  const envelopeId = cleanSlackId(record.envelopeId);
  const apiAppId = slackId(record.apiAppId);
  const enterpriseId = slackId(record.enterpriseId);
  const triggerId = cleanSlackId(record.triggerId);
  const responseUrlId = typeof record.responseUrlId === "string" ? record.responseUrlId.trim() : "";
  return {
    provider: "slack",
    source: SLACK_COMMAND_SOURCE,
    accountId,
    routeAccountId,
    instanceId,
    ...(envelopeId ? { envelopeId } : {}),
    ...(apiAppId ? { apiAppId } : {}),
    teamId,
    ...(enterpriseId ? { enterpriseId } : {}),
    channelId,
    userId,
    command,
    text,
    ...(triggerId ? { triggerId } : {}),
    ...(responseUrlId ? { responseUrlId } : {}),
    ...(record.ackedWithHelp === true ? { ackedWithHelp: true } : {}),
    receivedAt,
  };
}
