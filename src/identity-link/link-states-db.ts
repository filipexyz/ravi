/**
 * People in the middle of linking their Console account (`ravi link`).
 *
 * A Console write refused for a person with no link, or their own `ravi link`
 * in a WhatsApp group, leaves a row here: on WhatsApp the agent never starts
 * a conversation, so the person is asked to message the agent in private
 * (`awaiting_dm`). When that private message arrives, the daemon answers it
 * itself with the approval link (`link_sent`), with no agent turn. The row
 * goes away once the link is approved, denied, or the state expires.
 */

import type { LinkOrigin } from "../cloud-auth/link-identity.js";
import { getDb, getDbChanges } from "../router/router-db.js";

export type ContactLinkStatus = "awaiting_dm" | "link_sent";

/** How long a person stays in the linking flow without finishing it. */
export const LINK_STATE_TTL_MS = 7 * 24 * 60 * 60_000;

export interface ContactLinkState {
  contactId: string;
  status: ContactLinkStatus;
  /** Channel and instance (account) the person is expected to write to in private. */
  channel: string;
  accountId: string;
  /** Agent whose turn was refused; the private chat is routed to it when it has no route. */
  agentId: string | null;
  displayName: string | null;
  /** The chat where the person asked, which gets the confirmation. */
  origin: LinkOrigin | null;
  dmChatId: string | null;
  /** Route pattern of the private chat (the sender's phone or LID), seen on their first DM. */
  routePattern: string | null;
  requestId: string | null;
  requestExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface ContactLinkStateRow {
  contact_id: string;
  status: ContactLinkStatus;
  channel: string;
  account_id: string;
  agent_id: string | null;
  display_name: string | null;
  origin_channel: string | null;
  origin_account_id: string | null;
  origin_chat_id: string | null;
  origin_thread_id: string | null;
  origin_message_id: string | null;
  dm_chat_id: string | null;
  route_pattern: string | null;
  request_id: string | null;
  request_expires_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

/**
 * Put the person in `awaiting_dm`, or refresh it. A row already in
 * `link_sent` keeps its request: asking again while a link is pending does
 * not drop the link the person already has.
 */
export function enterAwaitingDm(input: {
  contactId: string;
  channel: string;
  accountId: string;
  agentId: string | null;
  displayName: string | null;
  origin: LinkOrigin | null;
  now?: number;
}): ContactLinkState {
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO contact_link_states (
         contact_id, status, channel, account_id, agent_id, display_name,
         origin_channel, origin_account_id, origin_chat_id, origin_thread_id, origin_message_id,
         dm_chat_id, route_pattern, request_id, request_expires_at, created_at, updated_at, expires_at
       ) VALUES (?, 'awaiting_dm', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
       ON CONFLICT(contact_id) DO UPDATE SET
         status = CASE WHEN contact_link_states.status = 'link_sent'
                        AND contact_link_states.request_expires_at > excluded.updated_at
                       THEN 'link_sent' ELSE 'awaiting_dm' END,
         channel = excluded.channel,
         account_id = excluded.account_id,
         agent_id = COALESCE(excluded.agent_id, contact_link_states.agent_id),
         display_name = COALESCE(excluded.display_name, contact_link_states.display_name),
         origin_channel = excluded.origin_channel,
         origin_account_id = excluded.origin_account_id,
         origin_chat_id = excluded.origin_chat_id,
         origin_thread_id = excluded.origin_thread_id,
         origin_message_id = excluded.origin_message_id,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    )
    .run(
      input.contactId,
      input.channel,
      input.accountId,
      input.agentId,
      input.displayName,
      input.origin?.channel ?? null,
      input.origin?.accountId ?? null,
      input.origin?.chatId ?? null,
      input.origin?.threadId ?? null,
      input.origin?.sourceMessageId ?? null,
      now,
      now,
      now + LINK_STATE_TTL_MS,
    );
  const state = readRow(input.contactId);
  if (!state) throw new Error("Failed to record the linking state.");
  return state;
}

/** The person's linking state, or null when there is none or it expired (an expired row is dropped). */
export function getContactLinkState(contactId: string, now = Date.now()): ContactLinkState | null {
  const state = readRow(contactId);
  if (!state) return null;
  if (state.expiresAt <= now) {
    clearContactLinkState(contactId);
    return null;
  }
  return state;
}

/** Record the approval link sent in the private chat. */
export function markLinkSent(input: {
  contactId: string;
  requestId: string;
  requestExpiresAt: number;
  dmChatId: string;
  routePattern: string | null;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `UPDATE contact_link_states
          SET status = 'link_sent', request_id = ?, request_expires_at = ?, dm_chat_id = ?,
              route_pattern = COALESCE(?, route_pattern), updated_at = ?
        WHERE contact_id = ?`,
    )
    .run(input.requestId, input.requestExpiresAt, input.dmChatId, input.routePattern, now, input.contactId);
}

/** Back to `awaiting_dm` after the link expired: the person's next private message gets a new one. */
export function reopenAwaitingDm(contactId: string, requestId: string, now = Date.now()): boolean {
  getDb()
    .prepare(
      `UPDATE contact_link_states
          SET status = 'awaiting_dm', request_id = NULL, request_expires_at = NULL, updated_at = ?
        WHERE contact_id = ? AND request_id = ?`,
    )
    .run(now, contactId, requestId);
  return getDbChanges() === 1;
}

export function clearContactLinkState(contactId: string): boolean {
  getDb().prepare(`DELETE FROM contact_link_states WHERE contact_id = ?`).run(contactId);
  return getDbChanges() === 1;
}

function readRow(contactId: string): ContactLinkState | null {
  const row = getDb().prepare(`SELECT * FROM contact_link_states WHERE contact_id = ?`).get(contactId) as
    | ContactLinkStateRow
    | undefined;
  return row ? rowToState(row) : null;
}

function rowToState(row: ContactLinkStateRow): ContactLinkState {
  const origin =
    row.origin_channel && row.origin_account_id && row.origin_chat_id
      ? {
          channel: row.origin_channel,
          accountId: row.origin_account_id,
          chatId: row.origin_chat_id,
          ...(row.origin_thread_id ? { threadId: row.origin_thread_id } : {}),
          ...(row.origin_message_id ? { sourceMessageId: row.origin_message_id } : {}),
        }
      : null;
  return {
    contactId: row.contact_id,
    status: row.status,
    channel: row.channel,
    accountId: row.account_id,
    agentId: row.agent_id,
    displayName: row.display_name,
    origin,
    dmChatId: row.dm_chat_id,
    routePattern: row.route_pattern,
    requestId: row.request_id,
    requestExpiresAt: row.request_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}
