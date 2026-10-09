/**
 * Local mirror of the Console link requests this install is waiting on.
 * Holds ids and chat coordinates only; the approval token is never stored.
 */

import { getDb, getDbChanges } from "../router/router-db.js";
import type { LinkOrigin } from "../cloud-auth/link-identity.js";
import type { LinkChatTarget } from "./link-dm.js";

export type LocalLinkRequestStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "failed";

export interface LocalLinkRequest {
  id: string;
  consoleUrl: string;
  installationId: string;
  contactId: string;
  displayName: string | null;
  origin: LinkOrigin | null;
  dm: LinkChatTarget;
  status: LocalLinkRequestStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface LocalLinkRequestRow {
  id: string;
  console_url: string;
  installation_id: string;
  contact_id: string;
  display_name: string | null;
  origin_channel: string | null;
  origin_account_id: string | null;
  origin_chat_id: string | null;
  origin_thread_id: string | null;
  origin_message_id: string | null;
  dm_channel: string;
  dm_account_id: string;
  dm_chat_id: string;
  status: LocalLinkRequestStatus;
  expires_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export function insertLocalLinkRequest(input: {
  id: string;
  consoleUrl: string;
  installationId: string;
  contactId: string;
  displayName: string | null;
  origin: LinkOrigin | null;
  dm: LinkChatTarget;
  expiresAt: number;
  now?: number;
}): LocalLinkRequest {
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `INSERT INTO cloud_link_requests (
         id, console_url, installation_id, contact_id, display_name,
         origin_channel, origin_account_id, origin_chat_id, origin_thread_id, origin_message_id,
         dm_channel, dm_account_id, dm_chat_id, status, expires_at, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      input.id,
      input.consoleUrl,
      input.installationId,
      input.contactId,
      input.displayName,
      input.origin?.channel ?? null,
      input.origin?.accountId ?? null,
      input.origin?.chatId ?? null,
      input.origin?.threadId ?? null,
      input.origin?.sourceMessageId ?? null,
      input.dm.channel,
      input.dm.accountId,
      input.dm.chatId,
      input.expiresAt,
      now,
      now,
    );
  const row = getLocalLinkRequest(input.id);
  if (!row) throw new Error("Failed to record the local link request.");
  return row;
}

export function getLocalLinkRequest(id: string): LocalLinkRequest | null {
  const row = getDb().prepare(`SELECT * FROM cloud_link_requests WHERE id = ?`).get(id) as
    | LocalLinkRequestRow
    | undefined;
  return row ? rowToRequest(row) : null;
}

export function listPendingLocalLinkRequests(limit = 50): LocalLinkRequest[] {
  const rows = getDb()
    .prepare(`SELECT * FROM cloud_link_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`)
    .all(limit) as LocalLinkRequestRow[];
  return rows.map(rowToRequest);
}

export function listPendingLocalLinkRequestsForContact(contactId: string): LocalLinkRequest[] {
  const rows = getDb()
    .prepare(`SELECT * FROM cloud_link_requests WHERE contact_id = ? AND status = 'pending' ORDER BY created_at ASC`)
    .all(contactId) as LocalLinkRequestRow[];
  return rows.map(rowToRequest);
}

/**
 * Move a pending request to a terminal status. Returns true only for the
 * caller that made the change, so a confirmation is sent once even when
 * several daemons share this database.
 */
export function completeLocalLinkRequest(
  id: string,
  status: Exclude<LocalLinkRequestStatus, "pending">,
  now = Date.now(),
) {
  getDb()
    .prepare(
      `UPDATE cloud_link_requests
          SET status = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(status, now, now, id);
  return getDbChanges() === 1;
}

/** Drop finished rows older than the retention window. */
export function pruneLocalLinkRequests(olderThan: number): number {
  getDb().prepare(`DELETE FROM cloud_link_requests WHERE status != 'pending' AND updated_at < ?`).run(olderThan);
  return getDbChanges();
}

function rowToRequest(row: LocalLinkRequestRow): LocalLinkRequest {
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
    id: row.id,
    consoleUrl: row.console_url,
    installationId: row.installation_id,
    contactId: row.contact_id,
    displayName: row.display_name,
    origin,
    dm: { channel: row.dm_channel, accountId: row.dm_account_id, chatId: row.dm_chat_id },
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
