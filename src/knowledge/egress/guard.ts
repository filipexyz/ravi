// Egress guard (contract §13.8): in a conversation that got a contact packet,
// the reply may only link pages marked for that conversation's instance.
// Ravi-hosted links that are not marked become "[link removido]", other hosts
// follow `knowledge.egress.allow`, and images are always removed.
//
// It applies only to sessions and chats with an unexpired guard row
// (`knowledge_guarded_sessions`, written by the packet). Lookups open
// knowledge.db read-only and never create it: no file means no guarded chats,
// which is also what `ravi-channels` sees before the daemon ever wrote one.

import type { Database } from "bun:sqlite";
import { executeWrite } from "../../db/write-retry.js";
import { dbGetInstanceByInstanceId } from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";
import { listMarkedUrlsForInstance, listRaviHosts } from "../mirror/store.js";
import { knowledgeSettings } from "../settings.js";
import { getKnowledgeDb, openKnowledgeDbReadonly } from "../store/db.js";

const log = logger.child("knowledge:egress");

export const REMOVED_LINK_TEXT = "[link removido]";
/** How long a packet keeps its conversation guarded after the last packet. */
export const KNOWLEDGE_GUARD_TTL_MS = 30 * 60_000;

export type GuardedSession = {
  sessionName: string;
  agentId: string;
  /** The OSS instance name (`MessageTarget.accountId`), never the Omni UUID. */
  instanceId: string;
  channel: string;
  /** `MessageTarget.chatId` as received. */
  chatId: string;
  /** `normalizeOutboundJid(chatId)`: what `OmniSender.send` receives. */
  normalizedChatId: string;
  contactId: string;
  guardedUntil: number;
};

export type EgressGuardContext = {
  instanceId: string;
  /** Hosts allowed for this instance, or null when other hosts are unrestricted. */
  allowHosts: readonly string[] | null;
  /** The mirror's Ravi-hosted hosts (the org's default hosts and bound custom domains). */
  raviHosts: readonly string[];
  /** Pages marked for this instance. */
  markedUrls: readonly { host: string; path: string }[];
};

/**
 * Normalize a chatId to a valid WhatsApp JID for the omni API.
 *
 * Handles ravi-internal formats:
 *   "group:120363407390920496"  → "120363407390920496@g.us"
 *   "120363407390920496@g.us"   → unchanged
 *   "178035101794451@lid"       → unchanged
 *   "5511999@s.whatsapp.net"    → unchanged
 *
 * Lives here (not in the gateway) so guard rows and `OmniSender.send` agree.
 */
export function normalizeOutboundJid(chatId: string): string {
  if (chatId.startsWith("group:")) {
    return chatId.slice(6) + "@g.us";
  }
  return chatId;
}

// ---------------------------------------------------------------------------
// Guard rows

type GuardRow = {
  session_name: string;
  agent_id: string;
  instance_id: string;
  channel: string;
  chat_id: string;
  normalized_chat_id: string;
  contact_id: string;
  guarded_until: number;
};

function rowToGuarded(row: GuardRow): GuardedSession {
  return {
    sessionName: row.session_name,
    agentId: row.agent_id,
    instanceId: row.instance_id,
    channel: row.channel,
    chatId: row.chat_id,
    normalizedChatId: row.normalized_chat_id,
    contactId: row.contact_id,
    guardedUntil: row.guarded_until,
  };
}

/** Runs a read on a short-lived read-only handle. No file, or any error, gives `fallback`. */
function readGuardDb<T>(read: (db: Database) => T, fallback: T): T {
  const db = openKnowledgeDbReadonly();
  if (!db) return fallback;
  try {
    return read(db);
  } catch (error) {
    log.warn("guard lookup failed", { error: error instanceof Error ? error.message : String(error) });
    return fallback;
  } finally {
    db.close();
  }
}

/** The unexpired guard row of a session, or null. */
export function isGuardedSession(sessionName: string, now: number = Date.now()): GuardedSession | null {
  const name = sessionName?.trim();
  if (!name) return null;
  return readGuardDb((db) => {
    const row = db
      .prepare("SELECT * FROM knowledge_guarded_sessions WHERE session_name = ? AND guarded_until > ?")
      .get(name, now) as GuardRow | null;
    return row ? rowToGuarded(row) : null;
  }, null);
}

/**
 * The unexpired guard row of a chat, by `(target.channel, target.chatId)`.
 * The chat id may be the received one or its normalized JID. An empty channel
 * matches any channel (message edits may arrive without one).
 */
export function guardedSessionForChat(
  channel: string,
  chatId: string,
  now: number = Date.now(),
): GuardedSession | null {
  const chat = chatId?.trim();
  if (!chat) return null;
  const normalized = normalizeOutboundJid(chat);
  const channelKey = channel?.trim().toLowerCase() ?? "";
  return readGuardDb((db) => {
    const rows = db
      .prepare(
        `SELECT * FROM knowledge_guarded_sessions
         WHERE (chat_id = ? OR normalized_chat_id = ? OR chat_id = ? OR normalized_chat_id = ?) AND guarded_until > ?
         ORDER BY guarded_until DESC`,
      )
      .all(chat, chat, normalized, normalized, now) as GuardRow[];
    const row = rows.find((candidate) => !channelKey || candidate.channel.toLowerCase() === channelKey);
    return row ? rowToGuarded(row) : null;
  }, null);
}

/**
 * The unexpired guard row for what `OmniSender.send` receives: the Omni
 * instance UUID and an already normalized JID. The UUID is mapped to the
 * instance name through `instances.instance_id`.
 */
export function guardedSessionForInstanceChat(
  omniInstanceId: string,
  to: string,
  now: number = Date.now(),
  deps: { instanceNameForOmniId?: (omniInstanceId: string) => string | null } = {},
): GuardedSession | null {
  const target = to?.trim();
  const omniId = omniInstanceId?.trim();
  if (!target || !omniId) return null;
  const rows = readGuardDb(
    (db) =>
      db
        .prepare(
          "SELECT * FROM knowledge_guarded_sessions WHERE normalized_chat_id = ? AND guarded_until > ? ORDER BY guarded_until DESC",
        )
        .all(normalizeOutboundJid(target), now) as GuardRow[],
    [] as GuardRow[],
  );
  if (rows.length === 0) return null;
  const names = new Set<string>([omniId]);
  try {
    const name = (deps.instanceNameForOmniId ?? defaultInstanceNameForOmniId)(omniId);
    if (name) names.add(name);
  } catch (error) {
    log.warn("instance lookup failed", { error: error instanceof Error ? error.message : String(error) });
  }
  const row = rows.find((candidate) => names.has(candidate.instance_id));
  return row ? rowToGuarded(row) : null;
}

function defaultInstanceNameForOmniId(omniInstanceId: string): string | null {
  return dbGetInstanceByInstanceId(omniInstanceId)?.name ?? null;
}

/** Writes (or extends) a session's guard row. Used by the packet. */
export function upsertGuardedSession(row: GuardedSession): void {
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(
        `INSERT INTO knowledge_guarded_sessions
           (session_name, agent_id, instance_id, channel, chat_id, normalized_chat_id, contact_id, guarded_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_name) DO UPDATE SET
           agent_id = excluded.agent_id, instance_id = excluded.instance_id, channel = excluded.channel,
           chat_id = excluded.chat_id, normalized_chat_id = excluded.normalized_chat_id,
           contact_id = excluded.contact_id, guarded_until = excluded.guarded_until`,
      ).run(
        row.sessionName,
        row.agentId,
        row.instanceId,
        row.channel,
        row.chatId,
        row.normalizedChatId,
        row.contactId,
        row.guardedUntil,
      );
    },
    { label: "knowledge_guard_upsert" },
  );
}

/** Removes a session's guard row. */
export function deleteGuardedSession(sessionName: string): number {
  return executeWrite(
    getKnowledgeDb(),
    (db) => db.prepare("DELETE FROM knowledge_guarded_sessions WHERE session_name = ?").run(sessionName).changes,
    { label: "knowledge_guard_delete" },
  );
}

// ---------------------------------------------------------------------------
// Text guard

const LINK_PATTERN = new RegExp(
  [
    // 1. Markdown image.
    String.raw`!\[[^\]\n]*\]\([^)\n]*\)`,
    // 2. Markdown link: [text](url "title").
    String.raw`\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)`,
    // 3. Slack <url|text> or <url>.
    String.raw`<([a-z][a-z0-9+.-]*:[^>|\s]+)(?:\|[^>\n]*)?>`,
    // 4. http(s) URL.
    String.raw`\bhttps?:\/\/[^\s<>"'\x60]+`,
    // 5. Bare domain with optional port and path, whatever precedes it,
    //    except an email address (its local part or its domain).
    String.raw`(?<![\w.+-]@[a-z0-9.-]*)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![\w@-])(?::\d+)?(?:[\/?#][^\s<>"'\x60]*)?`,
  ].join("|"),
  "gi",
);
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»]+$/;

/**
 * Rewrites one text for a guarded conversation. Pure: the caller passes the
 * instance's allow list, the mirror's Ravi hosts and the marked pages.
 */
export function guardEgressText(text: string, ctx: EgressGuardContext): { text: string; removed: string[] } {
  if (!text) return { text: text ?? "", removed: [] };
  const removed: string[] = [];
  const guarded = text.replace(LINK_PATTERN, (match: string, markdownUrl?: string, slackUrl?: string) => {
    if (match.startsWith("!")) {
      removed.push(match);
      return "";
    }
    if (markdownUrl !== undefined) {
      if (urlAllowed(markdownUrl, ctx)) return match;
      removed.push(markdownUrl);
      return REMOVED_LINK_TEXT;
    }
    if (slackUrl !== undefined) {
      if (urlAllowed(slackUrl, ctx)) return match;
      removed.push(slackUrl);
      return REMOVED_LINK_TEXT;
    }
    const trailing = match.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (!url || urlAllowed(url, ctx)) return match;
    removed.push(url);
    return REMOVED_LINK_TEXT + trailing;
  });
  if (removed.length === 0) return { text, removed };
  return {
    text: guarded
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
    removed,
  };
}

function urlAllowed(raw: string, ctx: EgressGuardContext): boolean {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d/.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) return ctx.allowHosts === null;
  if (isRaviHosted(host, ctx)) return isMarked(host, parsed, ctx);
  if (ctx.allowHosts === null) return true;
  return ctx.allowHosts.some((allowed) => {
    const normalized = normalizeHost(allowed);
    return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
  });
}

function normalizeHost(host: string): string {
  return (host ?? "").trim().toLowerCase().replace(/\.$/, "");
}

function isRaviHosted(host: string, ctx: EgressGuardContext): boolean {
  if (host === "ravi.page" || host.endsWith(".ravi.page")) return true;
  if (host === "console.ravi.bot") return true;
  if (ctx.raviHosts.some((candidate) => normalizeHost(candidate) === host)) return true;
  return ctx.markedUrls.some((marked) => normalizeHost(marked.host) === host);
}

/**
 * Host, default port and path of a page marked for this instance; the
 * fragment is ignored, a query or another port never matches.
 */
function isMarked(host: string, url: URL, ctx: EgressGuardContext): boolean {
  if (url.port) return false;
  if (url.search && url.search !== "?") return false;
  const path = normalizePath(url.pathname);
  return ctx.markedUrls.some((marked) => normalizeHost(marked.host) === host && normalizePath(marked.path) === path);
}

function normalizePath(path: string): string {
  let value = path || "/";
  try {
    value = decodeURI(value);
  } catch {
    // Keep the raw path.
  }
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, "") || "/";
  return value;
}

// ---------------------------------------------------------------------------
// Guard with the live settings and mirror

export interface EgressGuardDeps {
  allowHosts?: (instanceName: string) => string[] | null;
  raviHosts?: (now: number) => string[];
  markedUrls?: (instanceName: string, now: number) => Array<{ host: string; path: string }>;
  now?: number;
}

/**
 * The guard context for a guarded conversation, read from the settings and
 * the mirror. A lookup that fails closes: the allow list becomes empty and
 * the mirror lists nothing, so only plain text passes.
 */
export function egressContextForGuardedSession(
  guarded: GuardedSession,
  deps: EgressGuardDeps = {},
): EgressGuardContext {
  const now = deps.now ?? Date.now();
  const instanceId = guarded.instanceId;
  return {
    instanceId,
    allowHosts: safeLookup(
      "allow list",
      () => (deps.allowHosts ?? ((name: string) => knowledgeSettings().egressAllow(name)))(instanceId),
      [],
    ),
    raviHosts: safeLookup("ravi hosts", () => (deps.raviHosts ?? listRaviHosts)(now), []),
    markedUrls: safeLookup("marked urls", () => (deps.markedUrls ?? listMarkedUrlsForInstance)(instanceId, now), []),
  };
}

/** Guards one outgoing text of a guarded conversation. */
export function guardTextForGuardedSession(
  text: string,
  guarded: GuardedSession,
  deps: EgressGuardDeps = {},
): { text: string; removed: string[] } {
  const result = guardEgressText(text, egressContextForGuardedSession(guarded, deps));
  if (result.removed.length > 0) {
    log.info("Knowledge egress guard removed links", {
      sessionName: guarded.sessionName,
      instanceId: guarded.instanceId,
      removed: result.removed.length,
    });
  }
  return result;
}

/** Guards a text bound for a chat: unchanged when the chat is not guarded. */
export function guardTextForChat(
  channel: string,
  chatId: string,
  text: string,
  deps: EgressGuardDeps & { guarded?: GuardedSession | null } = {},
): { text: string; guarded: GuardedSession | null } {
  const guarded = deps.guarded !== undefined ? deps.guarded : guardedSessionForChat(channel, chatId, deps.now);
  if (!guarded) return { text, guarded: null };
  return { text: guardTextForGuardedSession(text, guarded, deps).text, guarded };
}

function safeLookup<T>(label: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    log.warn(`egress ${label} unavailable; failing closed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
