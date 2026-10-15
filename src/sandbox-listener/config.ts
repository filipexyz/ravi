// Sandbox listener configuration, read from ravi.db settings. Slice 05b
// (`ravi gateway expose`) writes these keys after Console provisions the
// tunnel; the daemon starts the listener only when every one of them is
// present and well-formed. The listener never derives any of them from a
// request. Missing `gateway.access.clientId` is a refusal to start, not a
// degraded mode (Console listener SPEC §Request Checks step 4).

import { dbGetSetting } from "../router/router-db.js";
import { ACCESS_AUD_RE, ACCESS_TEAM_DOMAIN_RE } from "./access-jwt.js";
import { INSTALLATION_ID_RE } from "./contract.js";

export const SANDBOX_LISTENER_SETTINGS = Object.freeze({
  port: "gateway.listener.port",
  accessTeamDomain: "gateway.access.teamDomain",
  accessAud: "gateway.access.aud",
  accessClientId: "gateway.access.clientId",
  installationId: "gateway.installationId",
  consoleUrl: "gateway.consoleUrl",
  tunnelHostname: "gateway.tunnel.hostname",
  driftLatched: "gateway.tunnel.driftLatched",
} as const);

export type SandboxListenerSettingKey = keyof typeof SANDBOX_LISTENER_SETTINGS;

export interface SandboxListenerConfig {
  port: number;
  accessTeamDomain: string;
  accessAud: string;
  /** The Gate's Access service token client id; `common_name` is pinned to it. */
  accessClientId: string;
  installationId: string;
  /** Configured Console origin, the grant issuer: `https://host[:port]`, no path. */
  consoleIssuer: string;
  /** `<installationId>.<TUNNEL_ZONE>`; the `Host` header must equal it. */
  tunnelHostname: string;
  /** Persistent drift latch (05a sets it); a latched listener refuses every request with 503. */
  driftLatched: boolean;
}

export type ReadSandboxListenerConfigResult =
  | { enabled: false; reason: "not_configured" }
  | { enabled: false; reason: "config_invalid"; invalid: SandboxListenerSettingKey[] }
  | { enabled: true; config: SandboxListenerConfig };

// Cloudflare service token client ids look like `<32 hex>.access`; accept any
// bounded token so a Console-side format change does not lock the listener out.
const ACCESS_CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function readSandboxListenerConfig(
  get: (key: string) => string | null = dbGetSetting,
): ReadSandboxListenerConfigResult {
  const raw = Object.fromEntries(
    (Object.keys(SANDBOX_LISTENER_SETTINGS) as SandboxListenerSettingKey[]).map((key) => [
      key,
      get(SANDBOX_LISTENER_SETTINGS[key]),
    ]),
  ) as Record<SandboxListenerSettingKey, string | null>;
  return validateSandboxListenerConfig(raw);
}

export function validateSandboxListenerConfig(
  raw: Partial<Record<SandboxListenerSettingKey, string | null | undefined>>,
): ReadSandboxListenerConfigResult {
  const portRaw = raw.port?.trim();
  if (!portRaw) return { enabled: false, reason: "not_configured" };

  const invalid: SandboxListenerSettingKey[] = [];
  const port = /^[0-9]{1,5}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid.push("port");

  const accessTeamDomain = raw.accessTeamDomain?.trim() ?? "";
  if (!ACCESS_TEAM_DOMAIN_RE.test(accessTeamDomain)) invalid.push("accessTeamDomain");
  const accessAud = raw.accessAud?.trim() ?? "";
  if (!ACCESS_AUD_RE.test(accessAud)) invalid.push("accessAud");
  const accessClientId = raw.accessClientId?.trim() ?? "";
  if (!ACCESS_CLIENT_ID_RE.test(accessClientId)) invalid.push("accessClientId");
  const installationId = raw.installationId?.trim() ?? "";
  if (!INSTALLATION_ID_RE.test(installationId)) invalid.push("installationId");

  const consoleIssuer = normalizeConsoleIssuer(raw.consoleUrl);
  if (!consoleIssuer) invalid.push("consoleUrl");

  const tunnelHostname = raw.tunnelHostname?.trim().toLowerCase() ?? "";
  if (!HOSTNAME_RE.test(tunnelHostname) || !tunnelHostname.startsWith(`${installationId}.`)) {
    invalid.push("tunnelHostname");
  }

  if (invalid.length > 0) return { enabled: false, reason: "config_invalid", invalid };
  return {
    enabled: true,
    config: {
      port,
      accessTeamDomain,
      accessAud,
      accessClientId,
      installationId,
      consoleIssuer: consoleIssuer!,
      tunnelHostname,
      driftLatched: raw.driftLatched?.trim() === "1",
    },
  };
}

/** `https://host[:port]` only: no path, query, fragment, credentials or trailing slash. Null when it is not. */
export function normalizeConsoleIssuer(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (trimmed.endsWith("/") && trimmed !== `${url.origin}/`) return null;
  return url.origin;
}
