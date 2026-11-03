import { CLI_ACCESS_TOKEN_TTL_SECONDS, getCliAccessTokenSecret } from "./tokens";

export type CliAuthPublicConfig = {
  version: 1;
  provider: "ravi-console" | "workos";
  configured: boolean;
  exchangeConfigured: boolean;
  mode: "console_device" | "authkit_device" | "connect_device";
  clientId: string | null;
  issuer: string | null;
  scopes: string[];
  endpoints: {
    deviceAuthorization: string | null;
    token: string | null;
    exchange: string;
    refresh: string;
    logout: string;
    me: string;
  };
  tokenTtlSeconds: number;
};

export type CliWorkosValidationConfig = {
  clientId: string;
  issuer: string | string[];
  jwksUrl: string;
  accessTokenSecret: string;
};

export type CliAuthPublicConfigOptions = {
  flow?: "console_device" | "legacy_provider";
};

export const CLI_PUBLIC_SCOPES = ["openid", "profile", "email"] as const;

export const DEFAULT_CLI_SCOPES = [
  "console.me.read",
  "console.projects.read",
  "console.projects.link",
  "console.knowledge.read",
  "console.knowledge.write",
  "console.bases.read",
  "console.bases.write",
  "console.watches.read",
  "console.watches.write",
  "console.inbox.read",
  "console.inbox.subscribe",
  "console.inbox.deliver",
  "console.inbox.ack",
  "console.sync.read",
  "console.sync.write",
  "console.runtime-traces.read",
  "console.runtime-traces.write",
  "console.installations.read",
  "console.installations.write",
  "console.control.read",
  "artifacts.read",
  "artifacts.publish",
  "artifacts.versions.read",
] as const;

export function getCliAuthPublicConfig(
  requestUrl: string,
  options: CliAuthPublicConfigOptions = {},
): CliAuthPublicConfig {
  const origin = consoleOrigin(requestUrl);
  const mode = options.flow === "console_device" ? "console_device" : cliAuthMode();
  if (mode === "console_device") {
    const configured = Boolean(getCliAccessTokenSecret());
    return {
      version: 1,
      provider: "ravi-console",
      configured,
      exchangeConfigured: configured,
      mode,
      clientId: "ravi-cli",
      issuer: origin,
      scopes: [],
      endpoints: {
        deviceAuthorization: new URL("/api/cli/auth/device", origin).toString(),
        token: null,
        exchange: new URL("/api/cli/auth/exchange", origin).toString(),
        refresh: new URL("/api/cli/auth/refresh", origin).toString(),
        logout: new URL("/api/cli/auth/logout", origin).toString(),
        me: new URL("/api/cli/me", origin).toString(),
      },
      tokenTtlSeconds: CLI_ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  const clientId = cliClientId();
  const issuer = cliIssuer(mode);
  const endpoints = publicWorkosEndpoints(mode, issuer);
  const publicConfigured = Boolean(clientId && endpoints.deviceAuthorization && endpoints.token);
  const exchangeConfigured = Boolean(clientId && issuer && getCliAccessTokenSecret());

  return {
    version: 1,
    provider: "workos",
    configured: publicConfigured && exchangeConfigured,
    exchangeConfigured,
    mode,
    clientId,
    issuer,
    scopes: [...CLI_PUBLIC_SCOPES],
    endpoints: {
      ...endpoints,
      exchange: new URL("/api/cli/auth/exchange", origin).toString(),
      refresh: new URL("/api/cli/auth/refresh", origin).toString(),
      logout: new URL("/api/cli/auth/logout", origin).toString(),
      me: new URL("/api/cli/me", origin).toString(),
    },
    tokenTtlSeconds: CLI_ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function getCliWorkosValidationConfig(): CliWorkosValidationConfig | null {
  if (process.env.RAVI_AUTH_MODE === "oidc") return null;
  const mode = cliAuthMode();
  const clientId = cliClientId();
  const issuer = cliIssuer(mode);
  const validationIssuers = cliValidationIssuers(mode, issuer, clientId);
  const jwksUrl =
    normalizedUrl(process.env.WORKOS_CLI_AUTH_JWKS_URL) ??
    defaultJwksUrl(mode, clientId, issuer);
  const accessTokenSecret = getCliAccessTokenSecret();

  if (!clientId || !issuer || !jwksUrl || !accessTokenSecret) return null;

  return {
    clientId,
    issuer: validationIssuers,
    jwksUrl,
    accessTokenSecret,
  };
}

function cliAuthMode(): CliAuthPublicConfig["mode"] {
  if (process.env.RAVI_AUTH_MODE === "oidc") return "console_device";
  if (process.env.WORKOS_CLI_AUTH_MODE === "console_device") return "console_device";
  return process.env.WORKOS_CLI_AUTH_MODE === "connect_device" ? "connect_device" : "authkit_device";
}

function cliClientId() {
  return process.env.WORKOS_CLI_AUTH_CLIENT_ID?.trim() || process.env.WORKOS_CLIENT_ID?.trim() || null;
}

function cliIssuer(mode: CliAuthPublicConfig["mode"]) {
  return normalizedIssuer(process.env.WORKOS_CLI_AUTH_ISSUER) ?? (mode === "authkit_device" ? "https://api.workos.com" : null);
}

function cliValidationIssuers(
  mode: CliAuthPublicConfig["mode"],
  issuer: string | null,
  clientId: string | null,
): string[] {
  const issuers = issuer ? [issuer] : [];
  if (mode === "authkit_device") {
    issuers.push("https://api.workos.com");
    if (clientId) issuers.push(workosUserManagementIssuer(clientId));
  }
  return [...new Set(issuers)];
}

function publicWorkosEndpoints(mode: CliAuthPublicConfig["mode"], issuer: string | null) {
  if (mode === "connect_device") {
    return {
      deviceAuthorization: normalizedUrl(process.env.WORKOS_CLI_DEVICE_AUTHORIZATION_URL) ?? (issuer ? new URL("/oauth2/device_authorization", issuer).toString() : null),
      token: normalizedUrl(process.env.WORKOS_CLI_TOKEN_URL) ?? (issuer ? new URL("/oauth2/token", issuer).toString() : null),
    };
  }

  return {
    deviceAuthorization:
      normalizedUrl(process.env.WORKOS_CLI_DEVICE_AUTHORIZATION_URL) ??
      "https://api.workos.com/user_management/authorize/device",
    token: normalizedUrl(process.env.WORKOS_CLI_TOKEN_URL) ?? "https://api.workos.com/user_management/authenticate",
  };
}

function consoleOrigin(requestUrl: string) {
  const configured = normalizedUrl(process.env.NEXT_PUBLIC_CONSOLE_URL);
  if (configured) return new URL(configured).origin;
  return new URL(requestUrl).origin;
}

function normalizedIssuer(value: string | undefined) {
  const url = normalizedUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizedUrl(value: string | undefined) {
  if (!value) return null;
  const input = value.trim();
  if (!input) return null;
  try {
    return new URL(input.startsWith("http://") || input.startsWith("https://") ? input : `https://${input}`).toString();
  } catch {
    return null;
  }
}

function defaultJwksUrl(
  mode: CliAuthPublicConfig["mode"],
  clientId: string | null,
  issuer: string | null,
) {
  if (!clientId || !issuer) return null;
  if (mode === "authkit_device") {
    return `https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`;
  }
  return new URL("/oauth2/jwks", issuer).toString();
}

function workosUserManagementIssuer(clientId: string) {
  return `https://api.workos.com/user_management/${clientId}`;
}
