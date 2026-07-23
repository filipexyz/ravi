import { randomUUID } from "node:crypto";
import { getDb } from "../../router/router-db.js";

export interface SlackInteractionResponseUrlInput {
  readonly accountId: string;
  readonly envelopeId?: string;
  readonly teamId?: string;
  readonly channelId?: string;
  readonly userId?: string;
  readonly messageTs?: string;
  readonly responseUrl: string;
  readonly ttlMs?: number;
}

export interface SlackInteractionResponseInput {
  readonly responseUrlId: string;
  readonly payload: Record<string, unknown>;
}

const DEFAULT_RESPONSE_URL_TTL_MS = 30 * 60 * 1000;

interface SlackInteractionResponseUrlRow {
  id: string;
  response_url: string;
  expires_at: number;
}

export function storeSlackInteractionResponseUrl(input: SlackInteractionResponseUrlInput): string {
  ensureSlackInteractionResponseUrlTable();
  pruneExpiredSlackInteractionResponseUrls();

  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + (input.ttlMs ?? DEFAULT_RESPONSE_URL_TTL_MS);
  getDb()
    .prepare(
      `INSERT INTO slack_interaction_response_urls (
        id, account_id, envelope_id, team_id, channel_id, user_id, message_ts,
        response_url, created_at, expires_at, used_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      input.accountId,
      input.envelopeId ?? null,
      input.teamId ?? null,
      input.channelId ?? null,
      input.userId ?? null,
      input.messageTs ?? null,
      input.responseUrl,
      now,
      expiresAt,
    );
  return id;
}

export async function respondToSlackInteraction(
  input: SlackInteractionResponseInput,
): Promise<Record<string, unknown>> {
  ensureSlackInteractionResponseUrlTable();
  const now = Date.now();
  const row = getDb()
    .prepare("SELECT id, response_url, expires_at FROM slack_interaction_response_urls WHERE id = ?")
    .get(input.responseUrlId) as SlackInteractionResponseUrlRow | undefined;
  if (!row) throw new Error(`Slack interaction response handle not found: ${input.responseUrlId}`);
  if (row.expires_at <= now) throw new Error(`Slack interaction response handle expired: ${input.responseUrlId}`);

  const response = await fetch(row.response_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Slack interaction response failed: ${response.status} ${response.statusText}`);
  }
  getDb()
    .prepare(
      `UPDATE slack_interaction_response_urls
        SET used_count = used_count + 1, last_used_at = ?
        WHERE id = ?`,
    )
    .run(now, input.responseUrlId);
  return {
    ok: true,
    status: response.status,
    body: text,
  };
}

function ensureSlackInteractionResponseUrlTable(): void {
  const db = getDb();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS slack_interaction_response_urls (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      envelope_id TEXT,
      team_id TEXT,
      channel_id TEXT,
      user_id TEXT,
      message_ts TEXT,
      response_url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    )`,
  ).run();
  db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_slack_interaction_response_urls_expires
      ON slack_interaction_response_urls(expires_at)`,
  ).run();
}

function pruneExpiredSlackInteractionResponseUrls(): void {
  getDb().prepare("DELETE FROM slack_interaction_response_urls WHERE expires_at <= ?").run(Date.now());
}
