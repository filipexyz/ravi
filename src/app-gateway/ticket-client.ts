/**
 * Relay connection ticket client (`POST /api/cli/apps/relay-ticket`).
 *
 * Uses the stored CLI session with the inbox runner's refresh-once-on-
 * `AUTH_EXPIRED` pattern on top of `refreshCredentialsForStore`; token refresh
 * is never re-implemented here. The ticket is a bearer credential: it is kept
 * in memory only and never logged.
 */

import { type ConsoleApiClient, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { APP_GATEWAY_RELAY_TICKET_PATH, isUuid, RELAY_SUBPROTOCOL } from "./constants.js";

const TICKET_MAX_CHARS = 4_096;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface RelayTicket {
  ticket: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Unix seconds; open a second socket with a fresh ticket at this time. */
  renewAt: number;
  relayUrl: string;
  protocol: typeof RELAY_SUBPROTOCOL;
  issuer: string;
  /** This installation's Console id: the value grants are bound to. */
  installationId: string;
  organizationId: string;
}

export interface CredentialStore {
  write: (credentials: CloudCredentials) => void;
  delete: () => void;
}

export async function fetchRelayTicket(input: {
  client: ConsoleApiClient;
  credentials: CloudCredentials;
  store: CredentialStore;
  env?: NodeJS.ProcessEnv;
}): Promise<RelayTicket> {
  const call = (token: string) => input.client.requestJson<unknown>("POST", APP_GATEWAY_RELAY_TICKET_PATH, {}, token);
  let payload: unknown;
  try {
    payload = await call(input.credentials.accessToken);
  } catch (error) {
    if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
    const refreshed = await refreshCredentialsForStore({
      client: input.client,
      credentials: input.credentials,
      write: input.store.write,
      delete: input.store.delete,
    });
    Object.assign(input.credentials, refreshed);
    payload = await call(refreshed.accessToken);
  }
  return parseRelayTicket(payload, input.env ?? process.env);
}

export function parseRelayTicket(payload: unknown, env: NodeJS.ProcessEnv = process.env): RelayTicket {
  const invalid = (detail: string): never => {
    throw new CloudAuthError("PAYLOAD_INVALID", `Console returned an invalid relay ticket response (${detail}).`);
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid("not an object");
  const record = payload as Record<string, unknown>;
  const { ticket, expiresAt, renewAt, relayUrl, protocol, issuer, installationId, organizationId } = record;
  if (typeof ticket !== "string" || ticket.length > TICKET_MAX_CHARS || !COMPACT_JWS_PATTERN.test(ticket)) {
    invalid("ticket");
  }
  if (
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(renewAt) ||
    (renewAt as number) > (expiresAt as number)
  ) {
    invalid("expiry");
  }
  if (protocol !== RELAY_SUBPROTOCOL) invalid("protocol");
  if (typeof issuer !== "string" || !issuer.trim()) invalid("issuer");
  if (!isUuid(installationId) || !isUuid(organizationId)) invalid("installation");
  if (typeof relayUrl !== "string" || !isAcceptedRelayUrl(relayUrl, env)) invalid("relayUrl");
  return {
    ticket: ticket as string,
    expiresAt: expiresAt as number,
    renewAt: renewAt as number,
    relayUrl: relayUrl as string,
    protocol: RELAY_SUBPROTOCOL,
    issuer: issuer as string,
    installationId: installationId as string,
    organizationId: organizationId as string,
  };
}

/** `wss:` only; `ws:` only for loopback hosts or with `RAVI_ALLOW_INSECURE_CONSOLE_URL=true`. */
export function isAcceptedRelayUrl(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "wss:") return true;
  if (url.protocol !== "ws:") return false;
  return env.RAVI_ALLOW_INSECURE_CONSOLE_URL === "true" || LOOPBACK_HOSTS.has(url.hostname);
}
