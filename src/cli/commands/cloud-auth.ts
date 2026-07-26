import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
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
  ensureRemoteClientInstallationId,
  readRemoteInstallationCredential,
  toSafeRemoteInstallationCredential,
  writeRemoteInstallationCredential,
  type StoredRemoteInstallationCredential,
} from "../../cloud-auth/installation-storage.js";
import {
  discoverRemoteLoginEndpoint,
  consumeRemoteIdentityLinkChallenge,
  createRemoteLoginAuthorization,
  loadRemoteLoginProvider,
  normalizeRemoteLoginEndpoint,
  parseRemoteLoginProviderModuleConfigs,
  reconcileRemoteInstallation,
  type RemoteInstallationCredential,
  type RemoteLoginDiscovery,
  type RemoteLoginProvider,
} from "../../cloud-auth/remote-login.js";
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
  endpoint?: string;
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

export interface CloudLinkOptions {
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
  isInteractive?: boolean;
  promptEndpoint?: (defaultEndpoint: string) => Promise<string>;
  readIdentityLinkChallenge?: () => Promise<string>;
  discoverEndpoint?: (endpointUrl: string) => Promise<RemoteLoginDiscovery>;
  ensureClientInstallationId?: (seed?: string) => string;
  readInstallationCredential?: (endpointUrl?: string) => StoredRemoteInstallationCredential | null;
  writeInstallationCredential?: (
    endpointUrl: string,
    clientInstallationId: string,
    credential: RemoteInstallationCredential,
  ) => StoredRemoteInstallationCredential;
  loadProvider?: (provider: string) => Promise<RemoteLoginProvider>;
}

export async function runLogin(options: CloudLoginOptions = {}, deps: CloudAuthCommandDeps = {}) {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const env = deps.env ?? process.env;
  const explicitEndpoint = selectExplicitLoginEndpoint(options);
  const existing = read();
  const selected = explicitEndpoint ?? (await selectDefaultLoginEndpoint(existing, deps));
  const discovery = selected.remote
    ? await (deps.discoverEndpoint ?? discoverRemoteLoginEndpoint)(selected.endpointUrl)
    : undefined;
  const client =
    deps.client ??
    new ConsoleApiClient({
      consoleUrl: selected.endpointUrl,
      ...(discovery === undefined
        ? {}
        : {
            authConfigEndpoint: discovery.authConfigEndpoint,
            sessionEndpoints: discovery.sessionEndpoints,
          }),
    });
  const installationId = (
    deps.ensureClientInstallationId ?? ((seed?: string) => ensureRemoteClientInstallationId(seed, env))
  )(existing?.installationId);
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
    printLoginStart({
      endpointUrl: selected.endpointUrl,
      remote: selected.remote,
      authUrl,
      verificationUrl,
      userCode,
      openBrowser,
    });
  }

  let exchanged: CloudCredentials;
  try {
    exchanged = await exchangeUntilComplete({
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
  } catch (error) {
    if (!isCloudAuthError(error) || error.code !== "AUTH_PENDING" || options.poll !== false) {
      throw error;
    }
    const payload = {
      success: true,
      status: "pending" as const,
      endpointUrl: selected.endpointUrl,
      auth: safeAuthConfig(config, deviceAuth),
    };
    printPayload(payload, options.json, () => {
      console.log("Authentication is pending. Complete the browser flow before the challenge expires.");
    });
    return payload;
  }
  const credentials: CloudCredentials = {
    ...exchanged,
    consoleUrl: selected.endpointUrl,
    authMode: selected.remote ? "remote" : "console",
  };
  let installationCredential: ReturnType<typeof toSafeRemoteInstallationCredential> | undefined;
  if (discovery?.installationProvider) {
    const provider = await (
      deps.loadProvider ??
      ((providerId: string) =>
        loadRemoteLoginProvider(providerId, parseRemoteLoginProviderModuleConfigs(env.RAVI_REMOTE_LOGIN_PROVIDERS)))
    )(discovery.installationProvider);
    const previous =
      (
        deps.readInstallationCredential ??
        ((endpointUrl?: string) => readRemoteInstallationCredential(endpointUrl, env))
      )(selected.endpointUrl) ?? undefined;
    const credential = await reconcileRemoteInstallation(provider, {
      endpointUrl: selected.endpointUrl,
      discovery,
      authorization: createRemoteLoginAuthorization({
        endpointUrl: selected.endpointUrl,
        accessToken: credentials.accessToken,
      }),
      installation: {
        clientInstallationId: installationId,
        ...localInstallationMetadata(env),
      },
      ...(previous === undefined ? {} : { previousCredential: previous.credential }),
    });
    const stored = (
      deps.writeInstallationCredential ??
      ((endpointUrl, clientInstallationId, value) =>
        writeRemoteInstallationCredential(endpointUrl, clientInstallationId, value, env))
    )(selected.endpointUrl, installationId, credential);
    installationCredential = toSafeRemoteInstallationCredential(stored);
  }
  write(credentials);

  const payload = {
    success: true,
    session: toSafeCloudAuthSession(credentials),
    auth: safeAuthConfig(config, deviceAuth),
    ...(installationCredential === undefined ? {} : { installationCredential }),
  };
  printPayload(payload, options.json, () => {
    const label =
      credentials.user?.email ?? credentials.user?.name ?? credentials.user?.displayName ?? "remote account";
    console.log(`✓ Logged in to ${credentials.consoleUrl} as ${label}`);
    console.log("Run `ravi whoami` to inspect the linked CLI session.");
  });
  return payload;
}

export async function runWhoami(options: CloudWhoamiOptions = {}, deps: CloudAuthCommandDeps = {}) {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const del = deps.deleteCredentials ?? deleteCloudCredentials;
  const credentials = requireStoredCredentials(
    read(),
    options.console ? normalizeConsoleUrl(options.console) : undefined,
  );
  const client = deps.client ?? (await clientForCredentials(credentials, deps));
  const result = await getMeWithAutoRefresh({
    client,
    credentials,
    write,
    delete: del,
  });
  const session = mergeMeIntoSession(result.credentials, result.me);
  const storedInstallation = (
    deps.readInstallationCredential ??
    ((endpointUrl?: string) => readRemoteInstallationCredential(endpointUrl, deps.env ?? process.env))
  )(credentials.consoleUrl);
  const payload = {
    success: true,
    authenticated: true,
    session,
    ...(storedInstallation === null
      ? {}
      : { installationCredential: toSafeRemoteInstallationCredential(storedInstallation) }),
  };
  printPayload(payload, options.json, () => printWhoami(session));
  return payload;
}

export async function runLink(options: CloudLinkOptions = {}, deps: CloudAuthCommandDeps = {}) {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const del = deps.deleteCredentials ?? deleteCloudCredentials;
  const env = deps.env ?? process.env;
  const credentials = requireStoredCredentials(read());
  if (credentials.authMode !== "remote") {
    throw new CloudAuthError("PAYLOAD_INVALID", "The active CLI login does not support remote identity linking.");
  }
  const discovery = await (deps.discoverEndpoint ?? discoverRemoteLoginEndpoint)(credentials.consoleUrl);
  if (!discovery.installationProvider) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "The active remote endpoint does not advertise a local post-login provider.",
    );
  }
  const client =
    deps.client ??
    new ConsoleApiClient({
      consoleUrl: credentials.consoleUrl,
      authConfigEndpoint: discovery.authConfigEndpoint,
      sessionEndpoints: discovery.sessionEndpoints,
    });
  const session = await getMeWithAutoRefresh({
    client,
    credentials,
    write,
    delete: del,
  });
  const provider = await (
    deps.loadProvider ??
    ((providerId: string) =>
      loadRemoteLoginProvider(providerId, parseRemoteLoginProviderModuleConfigs(env.RAVI_REMOTE_LOGIN_PROVIDERS)))
  )(discovery.installationProvider);
  const challenge = await (deps.readIdentityLinkChallenge ?? readIdentityLinkChallenge)();
  const link = await consumeRemoteIdentityLinkChallenge(
    provider,
    {
      endpointUrl: credentials.consoleUrl,
      discovery,
      authorization: createRemoteLoginAuthorization({
        endpointUrl: credentials.consoleUrl,
        accessToken: session.credentials.accessToken,
      }),
    },
    challenge,
  );
  const payload = {
    success: true,
    endpointUrl: credentials.consoleUrl,
    link,
  };
  printPayload(payload, options.json, () => {
    console.log(
      link.disposition === "linked"
        ? `✓ Identity linked through ${link.provider}`
        : `✓ Identity was already linked through ${link.provider}`,
    );
  });
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

  let revoked = false;
  let revokeError: ReturnType<CloudAuthError["toJSON"]> | null = null;
  let logoutCredentials = credentials;
  let client: ConsoleApiClient | null = null;
  try {
    client = deps.client ?? (await clientForCredentials(credentials, deps));
    await client.logout(
      { refreshToken: logoutCredentials.refreshToken, installationId: logoutCredentials.installationId },
      logoutCredentials.accessToken,
    );
    revoked = true;
  } catch (error) {
    if (isCloudAuthError(error) && error.code === "AUTH_EXPIRED" && client) {
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

function requireStoredCredentials(credentials: CloudCredentials | null, endpointUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (endpointUrl && endpointUrl !== credentials.consoleUrl) {
    throw new CloudAuthError("AUTH_REQUIRED", `No Ravi CLI credentials found for ${endpointUrl}.`);
  }
  return credentials;
}

function selectExplicitLoginEndpoint(options: CloudLoginOptions): { endpointUrl: string; remote: boolean } | undefined {
  if (options.endpoint && options.console) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Use either --endpoint or --console, not both.");
  }
  if (options.endpoint) {
    return {
      endpointUrl: normalizeRemoteLoginEndpoint(options.endpoint),
      remote: true,
    };
  }
  if (options.console) {
    return {
      endpointUrl: normalizeConsoleUrl(options.console),
      remote: false,
    };
  }
  return undefined;
}

async function selectDefaultLoginEndpoint(
  existing: CloudCredentials | null,
  deps: CloudAuthCommandDeps,
): Promise<{ endpointUrl: string; remote: boolean }> {
  if (existing) {
    return {
      endpointUrl:
        existing.authMode === "remote"
          ? normalizeRemoteLoginEndpoint(existing.consoleUrl)
          : normalizeConsoleUrl(existing.consoleUrl),
      remote: existing.authMode === "remote",
    };
  }
  const interactive = deps.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return {
      endpointUrl: normalizeConsoleUrl(DEFAULT_CONSOLE_URL),
      remote: false,
    };
  }
  const entered = await (deps.promptEndpoint ?? promptForEndpoint)(DEFAULT_CONSOLE_URL);
  if (!entered.trim() || normalizeConsoleUrl(entered) === normalizeConsoleUrl(DEFAULT_CONSOLE_URL)) {
    return {
      endpointUrl: normalizeConsoleUrl(DEFAULT_CONSOLE_URL),
      remote: false,
    };
  }
  return {
    endpointUrl: normalizeRemoteLoginEndpoint(entered),
    remote: true,
  };
}

async function clientForCredentials(
  credentials: CloudCredentials,
  deps: CloudAuthCommandDeps,
): Promise<ConsoleApiClient> {
  if (credentials.authMode !== "remote") {
    return new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  }
  const discovery = await (deps.discoverEndpoint ?? discoverRemoteLoginEndpoint)(credentials.consoleUrl);
  return new ConsoleApiClient({
    consoleUrl: credentials.consoleUrl,
    authConfigEndpoint: discovery.authConfigEndpoint,
    sessionEndpoints: discovery.sessionEndpoints,
  });
}

async function promptForEndpoint(defaultEndpoint: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await readline.question(`Remote login endpoint [${defaultEndpoint}]: `);
  } finally {
    readline.close();
  }
}

async function readIdentityLinkChallenge(): Promise<string> {
  if (process.stdin.isTTY && process.stderr.isTTY && typeof process.stdin.setRawMode === "function") {
    return promptForIdentityLinkChallenge();
  }
  let value = "";
  for await (const chunk of process.stdin) {
    value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(value, "utf8") > 1_024) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Identity link input exceeds the supported size.");
    }
  }
  return value.trim();
}

async function promptForIdentityLinkChallenge(): Promise<string> {
  const input = process.stdin;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  process.stderr.write("Identity link challenge: ");
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (result: { value: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      process.stderr.write("\n");
      if ("error" in result) {
        reject(result.error);
      } else {
        resolve(result.value.trim());
      }
    };
    const onError = () => {
      finish({
        error: new CloudAuthError("PAYLOAD_INVALID", "Identity link input could not be read."),
      });
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish({ value });
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish({
            error: new CloudAuthError("PAYLOAD_INVALID", "Identity linking was cancelled."),
          });
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character < " " || character === "\u007f") {
          continue;
        }
        value += character;
        if (Buffer.byteLength(value, "utf8") > 1_024) {
          finish({
            error: new CloudAuthError("PAYLOAD_INVALID", "Identity link input exceeds the supported size."),
          });
          return;
        }
      }
    };
    input.on("error", onError);
    input.on("data", onData);
  });
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
    authMode: credentials.authMode ?? "console",
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
  endpointUrl: string;
  remote: boolean;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  openBrowser: boolean;
}): void {
  console.log(`${input.remote ? "Remote endpoint" : "Ravi Cloud"} login: ${input.endpointUrl}`);
  if (input.openBrowser && input.authUrl) console.log("Opening browser for authentication...");
  if (input.verificationUrl) console.log(`Verification URL: ${input.verificationUrl}`);
  if (input.userCode) console.log(`Code: ${input.userCode}`);
}

function printWhoami(session: ReturnType<typeof mergeMeIntoSession>): void {
  const user = session.user?.email ?? session.user?.name ?? session.user?.displayName ?? "unknown user";
  const org = session.organization?.name ?? session.organization?.slug ?? session.organization?.id ?? "no organization";
  console.log(`Endpoint: ${session.consoleUrl}`);
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
