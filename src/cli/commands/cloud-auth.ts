import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ConsoleApiClient,
  getMeWithAutoRefresh,
  normalizeConsoleUrl,
  refreshCredentialsForStore,
} from "../../cloud-auth/client.js";
import {
  CloudAuthError,
  cloudAuthErrorFromUnknown,
  formatCloudAuthError,
  isCloudAuthError,
} from "../../cloud-auth/errors.js";
import { redactCloudAuthPayload } from "../../cloud-auth/redaction.js";
import {
  deleteCloudCredentials,
  readCloudCredentials,
  toSafeCloudAuthSession,
  writeCloudCredentials,
} from "../../cloud-auth/storage.js";
import type { CloudCredentials, ConsoleAuthConfig, ConsoleMeResponse } from "../../cloud-auth/types.js";
import { DEFAULT_CONSOLE_URL } from "../../cloud-auth/types.js";

export interface CloudLoginOptions {
  console?: string;
  json?: boolean;
  open?: boolean;
  poll?: boolean;
  timeoutSeconds?: string;
  intervalSeconds?: string;
}

export interface CloudWhoamiOptions {
  console?: string;
  json?: boolean;
}

export interface CloudLogoutOptions {
  console?: string;
  json?: boolean;
}

export interface CloudAuthCommandDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  openExternal?: (url: string) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export async function runLogin(options: CloudLoginOptions = {}, deps: CloudAuthCommandDeps = {}) {
  const consoleUrl = normalizeConsoleUrl(options.console ?? DEFAULT_CONSOLE_URL);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl });
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const env = deps.env ?? process.env;
  const existing = read();
  const installationId = existing?.consoleUrl === consoleUrl ? existing.installationId : crypto.randomUUID();
  const config = await client.getAuthConfig();
  const deviceAuth = await client.startDeviceAuthorization(config);
  const authUrl = deviceAuth.verificationUriComplete;
  const verificationUrl = deviceAuth.verificationUri;
  const userCode = deviceAuth.userCode;
  const openBrowser = options.open !== false;

  if (authUrl && openBrowser) {
    try {
      await (deps.openExternal ?? openExternal)(authUrl);
    } catch {
      // Fallback URL/code is still printed below for headless or blocked browser launches.
    }
  }

  if (!options.json) {
    printLoginStart({ consoleUrl, authUrl, verificationUrl, userCode, openBrowser });
  }

  const credentials = await exchangeUntilComplete({
    client,
    installationId,
    config,
    deviceCode: deviceAuth.deviceCode,
    existing,
    poll: options.poll !== false,
    timeoutSeconds: parsePositiveNumber(options.timeoutSeconds, 300),
    intervalSeconds: parsePositiveNumber(
      options.intervalSeconds,
      deviceAuth.interval ?? numberFrom(config.interval) ?? 5,
    ),
    installation: localInstallationMetadata(env),
    sleep: deps.sleep ?? sleep,
  });
  write(credentials);

  const payload = {
    success: true,
    session: toSafeCloudAuthSession(credentials),
    auth: safeAuthConfig(config, deviceAuth),
  };
  printPayload(payload, options.json, () => {
    const label = credentials.user?.email ?? credentials.user?.name ?? credentials.user?.displayName ?? "Ravi Cloud";
    console.log(`✓ Logged in to ${credentials.consoleUrl} as ${label}`);
    console.log("Run `ravi whoami` to inspect the linked CLI session.");
  });
  return payload;
}

export async function runWhoami(options: CloudWhoamiOptions = {}, deps: CloudAuthCommandDeps = {}) {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const del = deps.deleteCredentials ?? deleteCloudCredentials;
  const credentials = requireStoredCredentials(read(), options.console);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const result = await getMeWithAutoRefresh({
    client,
    credentials,
    write,
    delete: del,
  });
  const session = mergeMeIntoSession(result.credentials, result.me);
  const payload = { success: true, authenticated: true, session };
  printPayload(payload, options.json, () => printWhoami(session));
  return payload;
}

export async function runLogout(options: CloudLogoutOptions = {}, deps: CloudAuthCommandDeps = {}) {
  const read = deps.readCredentials ?? readCloudCredentials;
  const del = deps.deleteCredentials ?? deleteCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  let credentials: CloudCredentials | null;
  try {
    credentials = read();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (cloudError.code !== "CREDENTIALS_INVALID") {
      throw cloudError;
    }
    del();
    const payload = {
      success: true,
      loggedOut: true,
      consoleUrl: normalizeConsoleUrl(options.console ?? DEFAULT_CONSOLE_URL),
      revoked: false,
      revokeError: cloudError.toJSON(),
    };
    printPayload(payload, options.json, () => {
      console.log("Invalid Ravi Cloud credentials were removed locally.");
      console.log(`Console revoke did not complete: ${cloudError.code}`);
    });
    return payload;
  }

  if (!credentials || (options.console && normalizeConsoleUrl(options.console) !== credentials.consoleUrl)) {
    const payload = {
      success: true,
      loggedOut: false,
      consoleUrl: normalizeConsoleUrl(options.console ?? DEFAULT_CONSOLE_URL),
    };
    printPayload(payload, options.json, () => {
      console.log("No Ravi Cloud CLI credentials are stored locally.");
    });
    return payload;
  }

  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  let revoked = false;
  let revokeError: ReturnType<CloudAuthError["toJSON"]> | null = null;
  let logoutCredentials = credentials;
  try {
    await client.logout(
      { refreshToken: logoutCredentials.refreshToken, installationId: logoutCredentials.installationId },
      logoutCredentials.accessToken,
    );
    revoked = true;
  } catch (error) {
    if (isCloudAuthError(error) && error.code === "AUTH_EXPIRED") {
      try {
        logoutCredentials = await refreshCredentialsForStore({
          client,
          credentials,
          write,
          delete: del,
        });
        await client.logout(
          { refreshToken: logoutCredentials.refreshToken, installationId: logoutCredentials.installationId },
          logoutCredentials.accessToken,
        );
        revoked = true;
      } catch (refreshOrLogoutError) {
        revokeError = cloudAuthErrorFromUnknown(refreshOrLogoutError).toJSON();
      }
    } else {
      revokeError = cloudAuthErrorFromUnknown(error).toJSON();
    }
  } finally {
    del();
  }

  const payload = {
    success: true,
    loggedOut: true,
    consoleUrl: credentials.consoleUrl,
    revoked,
    ...(revokeError ? { revokeError } : {}),
  };
  printPayload(payload, options.json, () => {
    console.log(`✓ Ravi Cloud credentials removed for ${credentials.consoleUrl}`);
    if (!revoked && revokeError) console.log(`Console revoke did not complete: ${revokeError.code}`);
  });
  return payload;
}

export async function runCloudAuthRootCommand<T>(asJson: boolean | undefined, fn: () => Promise<T>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      console.log(JSON.stringify(formatCloudAuthError(cloudError), null, 2));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    process.exit(cloudError.exitCode);
  }
}

function requireStoredCredentials(credentials: CloudCredentials | null, consoleUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalizeConsoleUrl(consoleUrl)}.`,
    );
  }
  return credentials;
}

async function exchangeUntilComplete(input: {
  client: ConsoleApiClient;
  installationId: string;
  config: ConsoleAuthConfig;
  deviceCode: string;
  existing: CloudCredentials | null;
  poll: boolean;
  timeoutSeconds: number;
  intervalSeconds: number;
  installation: NonNullable<Parameters<ConsoleApiClient["exchange"]>[0]["installation"]>;
  sleep: (ms: number) => Promise<void>;
}): Promise<CloudCredentials> {
  const deadline = Date.now() + input.timeoutSeconds * 1000;

  while (true) {
    try {
      const credentials = await exchangeDeviceCredentials(input);
      return {
        ...credentials,
        createdAt: input.existing?.createdAt ?? credentials.createdAt,
      };
    } catch (error) {
      if (!isCloudAuthError(error) || error.code !== "AUTH_PENDING" || !input.poll || Date.now() >= deadline) {
        throw error;
      }
      await input.sleep(input.intervalSeconds * 1000);
    }
  }
}

async function exchangeDeviceCredentials(input: {
  client: ConsoleApiClient;
  installationId: string;
  config: ConsoleAuthConfig;
  deviceCode: string;
  installation: NonNullable<Parameters<ConsoleApiClient["exchange"]>[0]["installation"]>;
}) {
  if (input.config.mode === "console_device" || !input.config.endpoints?.token) {
    return input.client.exchange({
      installationId: input.installationId,
      deviceCode: input.deviceCode,
      installation: input.installation,
    });
  }

  const providerToken = await input.client.pollDeviceToken(input.config, input.deviceCode);
  return input.client.exchange({
    installationId: input.installationId,
    workosAccessToken: providerToken.accessToken,
    installation: input.installation,
  });
}

function mergeMeIntoSession(credentials: CloudCredentials, me: ConsoleMeResponse) {
  return {
    consoleUrl: credentials.consoleUrl,
    user: me.user ?? credentials.user ?? null,
    organization: me.organization ?? me.org ?? credentials.organization ?? null,
    installation: {
      id: me.installation?.id ?? me.installation?.installationId ?? me.installationId ?? credentials.installationId,
    },
    scopes: me.scopes ?? credentials.scopes,
    accessTokenExpiresAt: me.accessTokenExpiresAt ?? me.expiresAt ?? credentials.accessTokenExpiresAt,
    refreshTokenExpiresAt: me.refreshTokenExpiresAt ?? credentials.refreshTokenExpiresAt ?? null,
  };
}

function safeAuthConfig(
  config: ConsoleAuthConfig,
  deviceAuth?: {
    verificationUriComplete?: string;
    verificationUri?: string;
    userCode?: string;
    expiresIn?: number | null;
    interval?: number | null;
  },
): Record<string, unknown> {
  return redactCloudAuthPayload({
    provider: config.provider ?? null,
    authorizationUrl: firstString(
      deviceAuth?.verificationUriComplete,
      config.verificationUriComplete,
      config.authorizationUrl,
      config.authUrl,
      config.loginUrl,
    ),
    verificationUri: firstString(deviceAuth?.verificationUri, config.verificationUri, config.verificationUrl),
    userCode: firstString(deviceAuth?.userCode, config.userCode),
    expiresIn: deviceAuth?.expiresIn ?? config.expiresIn ?? null,
    interval: deviceAuth?.interval ?? config.interval ?? null,
  });
}

function printLoginStart(input: {
  consoleUrl: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  openBrowser: boolean;
}): void {
  console.log(`Ravi Cloud login: ${input.consoleUrl}`);
  if (input.openBrowser && input.authUrl) console.log("Opening browser for authentication...");
  if (input.verificationUrl) console.log(`Verification URL: ${input.verificationUrl}`);
  if (input.userCode) console.log(`Code: ${input.userCode}`);
}

function printWhoami(session: ReturnType<typeof mergeMeIntoSession>): void {
  const user = session.user?.email ?? session.user?.name ?? session.user?.displayName ?? "unknown user";
  const org = session.organization?.name ?? session.organization?.slug ?? session.organization?.id ?? "no organization";
  console.log(`Console: ${session.consoleUrl}`);
  console.log(`User: ${user}`);
  console.log(`Organization: ${org}`);
  console.log(`Installation: ${session.installation.id}`);
  console.log(`Scopes: ${session.scopes.length ? session.scopes.join(", ") : "-"}`);
  console.log(`Access token expires: ${session.accessTokenExpiresAt ?? "-"}`);
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    console.log(JSON.stringify(redactCloudAuthPayload(payload), null, 2));
    return;
  }
  printHuman();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function localInstallationMetadata(env: NodeJS.ProcessEnv) {
  return {
    name: env.RAVI_CLI_INSTALLATION_NAME || hostname(),
    hostname: hostname(),
    platform: `${process.platform}-${process.arch}`,
    raviVersion: env.RAVI_VERSION || env.npm_package_version,
  };
}

function openExternal(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
