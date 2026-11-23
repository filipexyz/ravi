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
  /** Deadline of the post; defaults to `SLACK_RESPONSE_URL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

const DEFAULT_RESPONSE_URL_TTL_MS = 30 * 60 * 1000;

/**
 * Slack accepts at most five posts to one `response_url`
 * (docs.slack.dev/interactivity/handling-user-interaction). The sixth is
 * refused here, before the request, so a command that answers more than
 * that fails visibly in the log instead of as a Slack 4xx.
 */
export const SLACK_RESPONSE_URL_MAX_USES = 5;
export const SLACK_RESPONSE_URL_TIMEOUT_MS = 15_000;

interface SlackInteractionResponseUrlRow {
  id: string;
  response_url: string;
  expires_at: number;
  used_count: number;
}

export function storeSlackInteractionResponseUrl(input: SlackInteractionResponseUrlInput): string {
  if (!isAllowedSlackInteractionResponseUrl(input.responseUrl)) {
    throw new Error("Slack interaction response URL is not trusted.");
  }
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
    .prepare("SELECT id, response_url, expires_at, used_count FROM slack_interaction_response_urls WHERE id = ?")
    .get(input.responseUrlId) as SlackInteractionResponseUrlRow | undefined;
  if (!row) throw new Error(`Slack interaction response handle not found: ${input.responseUrlId}`);
  if (row.expires_at <= now) throw new Error(`Slack interaction response handle expired: ${input.responseUrlId}`);
  if (!isAllowedSlackInteractionResponseUrl(row.response_url)) {
    throw new Error(`Slack interaction response handle is not trusted: ${input.responseUrlId}`);
  }

  // The use is taken BEFORE the request, in one statement that also checks the limit: the count
  // is shared by every caller (this process, another daemon, `ravi slack interaction-respond`),
  // and a check followed by a count after the await would let two of them both take the last slot.
  const reserved = getDb()
    .prepare(
      `UPDATE slack_interaction_response_urls
        SET used_count = used_count + 1, last_used_at = ?
        WHERE id = ? AND used_count < ?`,
    )
    .run(now, input.responseUrlId, SLACK_RESPONSE_URL_MAX_USES);
  if (reserved.changes !== 1) {
    throw new Error(
      `Slack interaction response handle exhausted (${SLACK_RESPONSE_URL_MAX_USES} uses): ${input.responseUrlId}`,
    );
  }

  // A request that fails or times out leaves the use spent: Slack may have taken it, and counting
  // one too many is safe where counting one too few is not.
  const response = await fetch(row.response_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.payload),
    // A hung Slack host must not hold a consumer loop (`/ravi` answers through here).
    signal: AbortSignal.timeout(input.timeoutMs ?? SLACK_RESPONSE_URL_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    // Slack answered and refused: that post is not one of the handle's uses.
    getDb()
      .prepare("UPDATE slack_interaction_response_urls SET used_count = used_count - 1 WHERE id = ? AND used_count > 0")
      .run(input.responseUrlId);
    throw new Error(`Slack interaction response failed: ${response.status} ${response.statusText}`);
  }
  return {
    ok: true,
    status: response.status,
    body: text,
  };
}

/** A workspace host: one DNS label under slack.com, as in Slack's Socket Mode slash command example. */
const SLACK_WORKSPACE_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.slack\.com$/;

/**
 * Slack posts interaction handles under `/actions/` (Block Kit, shortcuts) and
 * slash-command handles under `/commands/`. The host is `hooks.slack.com`, or
 * the workspace's own `<workspace>.slack.com`: Slack's Socket Mode example for a
 * slash command shows `https://<workspace>.slack.com/commands/...`, while its HTTP
 * example shows `https://hooks.slack.com/commands/...`. Any other host or path is
 * not a handle Slack issued, and is never posted to.
 */
export function isAllowedSlackInteractionResponseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === "hooks.slack.com" || SLACK_WORKSPACE_HOST.test(url.hostname)) &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.hash &&
    (url.pathname.startsWith("/actions/") || url.pathname.startsWith("/commands/"))
  );
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
