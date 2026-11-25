/**
 * Credentials and login of registered MCP servers (spec mcp, Credentials And
 * Login), against a fake authorization server and an OAuth-protected MCP
 * server built with `@modelcontextprotocol/server` 2.4.0 (after SDK probe d1).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { serve } from "bun";

import { buildCredentialInventory } from "../credentials/index.js";
import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import type { ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { classifyMcpFailure, McpLoginRequired } from "./connections.js";
import { McpGateway, mcpStepUpScopes } from "./gateway.js";
import { McpLoginError, type McpLoginDeps, runMcpLogin, runMcpLogout } from "./login.js";
import { mcpClientMetadataUrl, mcpLoginCommand, mcpLoginRedirectUrl } from "./login-options.js";
import {
  breakStaleMcpCredentialLock,
  createMcpAuthProvider,
  McpOAuthSession,
  RaviMcpOAuthProvider,
  setMcpStaleLockHookForTests,
  storedMcpTokens,
  withMcpCredentialLock,
} from "./oauth-provider.js";
import {
  attachMcpServer,
  createMcpServer,
  getMcpServer,
  type McpConfigChangedEvent,
  removeMcpServer,
  setMcpConfigChangedEmitterForTests,
} from "./registry-db.js";
import { deleteMcpServerSecret, readMcpServerSecret, writeMcpServerSecret } from "./secrets.js";
import { startOAuthFixture, type OAuthFixture } from "./test-fixtures/oauth-server.js";
import { setMcpTraceSinksForTests } from "./trace.js";

const AGENT = "main";
const METADATA_URL = "https://client.example.com/ravi/client.json";

let stateDir: string;
let fixture: OAuthFixture | null = null;
let gateway: McpGateway | null = null;
let events: McpConfigChangedEvent[] = [];
let prompts: string[] = [];

beforeEach(async () => {
  stateDir = (await createIsolatedRaviState("ravi-mcp-oauth-")) as string;
  events = [];
  prompts = [];
  setMcpConfigChangedEmitterForTests((event) => void events.push(event));
  setPermissionAuditPublisherForTest(() => {});
  setMcpTraceSinksForTests({ call: () => {}, catalog: () => {} });
});

afterEach(async () => {
  await gateway?.stop();
  gateway = null;
  await fixture?.close();
  fixture = null;
  setMcpTraceSinksForTests({ call: null, catalog: null });
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  await cleanupIsolatedRaviState(stateDir);
});

/** A loopback port nobody listens on right now. */
function freePort(): number {
  const probe = serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

async function register(name = "console", authKind: "oauth" | "bearer" = "oauth", options = {}) {
  fixture ??= startOAuthFixture(options);
  createMcpServer({ name, transport: "http", url: fixture.url, authKind });
  await writeMcpServerSecret(name, { url: fixture.url });
  attachMcpServer({ agentId: AGENT, server: name });
  return getMcpServer(name)!;
}

/** The browser: approve, then follow the redirect to the loopback listener. */
function browserDeps(extra: Partial<McpLoginDeps> = {}): McpLoginDeps {
  return {
    prompt: (line) => void prompts.push(line),
    // A test's stderr is no terminal; these tests read the URL from the prompt as an operator would.
    showAuthorizationUrl: true,
    openBrowser: (url) =>
      void (async () => {
        const location = await fixture!.approve(url);
        await fetch(location);
      })().catch(() => {
        // The login may stop listening first (a refused answer); the browser's error is not the test's.
      }),
    timeoutMs: 10_000,
    ...extra,
  };
}

function authorizationUrlFromPrompts(): string {
  const line = prompts.find((entry) => entry.includes("/authorize?"));
  if (!line) throw new Error("no authorization URL was shown");
  return line;
}

function dbBytes(): string {
  return readFileSync(join(stateDir, "ravi.db")).toString("latin1");
}

/** No issued token in any place that is not the credentials store. */
function expectNoTokenOutside(...surfaces: string[]): void {
  const tokens = fixture!.issuedTokens();
  expect(tokens.length).toBeGreaterThan(0);
  const places = [
    ...surfaces,
    JSON.stringify(getMcpServer("console")),
    dbBytes(),
    JSON.stringify(process.env),
    process.argv.join(" "),
  ];
  for (const token of tokens) {
    for (const place of places) expect(place.includes(token)).toBe(false);
  }
}

function context(): ContextRecord {
  return {
    contextId: "ctx_oauth",
    contextKey: "rctx_oauth",
    kind: "agent-runtime",
    agentId: AGENT,
    sessionKey: "agent:main:main",
    sessionName: "main-session",
    capabilities: [],
    metadata: {},
    createdAt: Date.now(),
  };
}

function newGateway(): McpGateway {
  gateway = new McpGateway({
    subscribe: false,
    refreshTickMs: 0,
    authorize: { isOperatorOwnTurn: () => true, canUseTool: () => true },
  });
  return gateway;
}

describe("ravi mcp login (OAuth)", () => {
  it("runs the code flow with dynamic registration over the loopback redirect and stores the login", async () => {
    const before = await register();
    const port = freePort();
    const result = await runMcpLogin({ server: before, port }, browserDeps());

    expect(result).toMatchObject({
      server: "console",
      authKind: "oauth",
      registration: "dynamic",
      era: "modern",
      toolCount: 2,
      // The scope of the server's 401 challenge.
      scopes: ["mcp:read"],
    });
    expect(result.expiresAt).toBeNumber();
    expect(fixture!.registrations).toBe(1);
    const authorize = fixture!.authorizations[0]!;
    expect(authorize).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      redirect_uri: mcpLoginRedirectUrl(port),
      resource: fixture!.url,
    });
    expect(authorize.state?.length).toBeGreaterThanOrEqual(40);
    expect(fixture!.tokenRequests.map((request) => request.grant)).toEqual(["authorization_code"]);
    expect(fixture!.tokenRequests[0]!.resource).toBe(fixture!.url);

    const secret = await readMcpServerSecret("console");
    expect(secret?.url).toBe(fixture!.url);
    expect(secret?.oauth).toMatchObject({
      clientSource: "dynamic",
      redirectUrl: mcpLoginRedirectUrl(port),
      resource: fixture!.url,
      client: { client_id: "dcr-client-1" },
    });
    expect(storedMcpTokens(secret?.oauth)?.refresh_token).toBeString();

    const row = getMcpServer("console")!;
    expect(row.status).toBe("unknown");
    expect(row.credentialRev).toBe(before.credentialRev + 1);
    expect(events.some((event) => event.change === "config" && event.servers?.includes("console"))).toBe(true);

    // The prompt shows the authorization server's host on its own line, never a token.
    expect(prompts).toContain(`Authorization server: 127.0.0.1:${new URL(fixture!.issuer).port}`);
    const inventory = await buildCredentialInventory({ describe: false });
    const item = inventory.items.find((entry) => entry.provider === "mcp" && entry.connection === "console");
    expect(item).toMatchObject({ status: "active", scopes: ["mcp:read"] });
    expect(item?.rotatedAt).toBeNumber();
    expectNoTokenOutside(JSON.stringify(result), prompts.join("\n"), JSON.stringify(inventory));
  });

  it("uses a client metadata document with --paste: no registration, the URL is the client id", async () => {
    const server = await register("console", "oauth", { variant: "cimd" });
    const result = await runMcpLogin(
      { server, paste: true, clientMetadataUrl: METADATA_URL },
      {
        prompt: (line) => void prompts.push(line),
        showAuthorizationUrl: true,
        readPastedUrl: () => fixture!.approve(authorizationUrlFromPrompts()),
        openBrowser: () => {
          throw new Error("--paste must not open a browser");
        },
      },
    );
    expect(result.registration).toBe("metadata_document");
    expect(fixture!.registrations).toBe(0);
    expect(fixture!.authorizations[0]!.client_id).toBe(METADATA_URL);
    expect(fixture!.tokenRequests[0]!.clientId).toBe(METADATA_URL);
    expect((await readMcpServerSecret("console"))?.oauth?.clientSource).toBe("metadata_document");
  });

  it("uses a client id given with --client-id and never registers", async () => {
    const server = await register();
    const result = await runMcpLogin({ server, port: freePort(), clientId: "manual-client" }, browserDeps());
    expect(result.registration).toBe("preregistered");
    expect(fixture!.registrations).toBe(0);
    expect(fixture!.authorizations[0]!.client_id).toBe("manual-client");
  });

  it("refuses a sign-in answer whose issuer is another server, and stores nothing", async () => {
    const server = await register("console", "oauth", { callbackIssuer: "http://127.0.0.1:9" });
    const error = await runMcpLogin({ server, port: freePort() }, browserDeps()).catch((caught) => caught);
    expect(error).toBeInstanceOf(McpLoginError);
    expect((error as McpLoginError).code).toBe("issuer_mismatch");
    expect(fixture!.tokenRequests).toEqual([]);
    expect((await readMcpServerSecret("console"))?.oauth).toBeUndefined();
    expect(getMcpServer("console")!.credentialRev).toBe(server.credentialRev);
  });

  it("refuses a pasted answer with another state (the SDK does not check it), and stores nothing", async () => {
    const server = await register("console", "oauth", { callbackState: "forged-state" });
    const error = await runMcpLogin(
      { server, paste: true },
      {
        prompt: (line) => void prompts.push(line),
        showAuthorizationUrl: true,
        readPastedUrl: () => fixture!.approve(authorizationUrlFromPrompts()),
      },
    ).catch((caught) => caught);
    expect((error as McpLoginError).message).toContain("state");
    expect((error as McpLoginError).code).toBe("state_mismatch");
    expect(fixture!.tokenRequests).toEqual([]);
    expect((await readMcpServerSecret("console"))?.oauth).toBeUndefined();
  });

  it("ignores a loopback request with another state and keeps waiting", async () => {
    const server = await register("console", "oauth", { callbackState: "forged-state" });
    const port = freePort();
    let answered = 0;
    const error = await runMcpLogin(
      { server, port },
      browserDeps({
        timeoutMs: 1_500,
        openBrowser: (url) =>
          void (async () => {
            const response = await fetch(await fixture!.approve(url));
            answered = response.status;
          })(),
      }),
    ).catch((caught) => caught);
    expect(answered).toBe(400);
    expect((error as McpLoginError).code).toBe("timeout");
    expect(fixture!.tokenRequests).toEqual([]);
  });

  it("never shows or opens an authorization URL that is not https", async () => {
    for (const endpoint of [
      "file:///Applications/Calculator.app",
      "smb://evil.example/share",
      "http://evil.example/a",
    ]) {
      await fixture?.close();
      fixture = null;
      await cleanupIsolatedRaviState(stateDir);
      stateDir = (await createIsolatedRaviState("ravi-mcp-oauth-")) as string;
      prompts = [];
      const server = await register("console", "oauth", { authorizationEndpoint: endpoint });
      const opened: string[] = [];
      await expect(
        runMcpLogin({ server, port: freePort() }, browserDeps({ openBrowser: (url) => void opened.push(url) })),
      ).rejects.toMatchObject({ code: "login_failed" });
      expect(opened).toEqual([]);
      expect(prompts.join("\n")).not.toContain(new URL(endpoint).host || "Calculator");
      expect((await readMcpServerSecret("console"))?.oauth).toBeUndefined();
    }
  });

  it("refuses a pasted URL that is not this login's redirect", async () => {
    const server = await register();
    const error = await runMcpLogin(
      { server, paste: true },
      {
        prompt: (line) => void prompts.push(line),
        showAuthorizationUrl: true,
        readPastedUrl: async () => "https://evil.example/callback?code=x",
      },
    ).catch((caught) => caught);
    expect((error as McpLoginError).code).toBe("invalid_callback");
    expect((error as Error).message).not.toContain("code=x");
  });

  it("reuses the client registration for the same redirect and registers again when it changes", async () => {
    const server = await register();
    const port = freePort();
    await runMcpLogin({ server, port }, browserDeps());
    await runMcpLogin({ server: getMcpServer("console")!, port }, browserDeps());
    expect(fixture!.registrations).toBe(1);

    const other = freePort();
    await runMcpLogin({ server: getMcpServer("console")!, port: other }, browserDeps());
    expect(fixture!.registrations).toBe(2);
    expect((await readMcpServerSecret("console"))?.oauth?.redirectUrl).toBe(mcpLoginRedirectUrl(other));
  });

  it("fails clearly when the loopback port is taken", async () => {
    const server = await register();
    const busy = serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    try {
      const error = await runMcpLogin({ server, port: busy.port as number }, browserDeps()).catch((caught) => caught);
      expect((error as McpLoginError).code).toBe("port_unavailable");
    } finally {
      busy.stop(true);
    }
  });

  it("refuses rows without a login and the wrong flags", async () => {
    const server = await register();
    const none = { ...server, authKind: "none" as const };
    await expect(runMcpLogin({ server: none })).rejects.toMatchObject({ code: "no_login_needed" });
    await expect(runMcpLogin({ server: { ...server, transport: "stdio" } })).rejects.toMatchObject({
      code: "not_http",
    });
    await expect(runMcpLogin({ server, bearerToken: "x" })).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("only accepts an https client metadata document URL with a path", () => {
    expect(mcpClientMetadataUrl({})).toBeUndefined();
    expect(mcpClientMetadataUrl({ RAVI_MCP_CLIENT_METADATA_URL: METADATA_URL })).toBe(METADATA_URL);
    for (const bad of ["http://client.example.com/c.json", "https://client.example.com/", "nonsense"]) {
      expect(() => mcpClientMetadataUrl({ RAVI_MCP_CLIENT_METADATA_URL: bad })).toThrow(McpLoginError);
    }
  });
});

describe("the daemon's use of a stored login", () => {
  async function loggedIn(options = {}) {
    const server = await register("console", "oauth", options);
    await runMcpLogin({ server, port: freePort() }, browserDeps());
    return getMcpServer("console")!;
  }

  it("connects with the stored token and refreshes once after a 401", async () => {
    await loggedIn();
    const row = await newGateway().refresh("console");
    expect(row?.status).toBe("ok");

    const before = (await readMcpServerSecret("console"))!.oauth!;
    const revision = getMcpServer("console")!.credentialRev;
    await gateway!.connections.closeAll();
    fixture!.revokeAccessTokens();
    const refreshed = await gateway!.refresh("console");
    expect(refreshed?.status).toBe("ok");
    expect(fixture!.tokenRequests.map((request) => request.grant)).toEqual(["authorization_code", "refresh_token"]);
    expect(fixture!.tokenRequests[1]!.resource).toBe(fixture!.url);
    const after = (await readMcpServerSecret("console"))!.oauth!;
    expect(storedMcpTokens(after)?.access_token).not.toBe(storedMcpTokens(before)?.access_token);
    expect(after.client).toEqual(before.client);
    // A refresh is not a new registration: the credential revision stays.
    expect(getMcpServer("console")!.credentialRev).toBe(revision);
    expectNoTokenOutside(JSON.stringify(refreshed));
  });

  it("refreshes an expiring token before it is used", async () => {
    await loggedIn({ expiresIn: 30 });
    const provider = await createMcpAuthProvider(getMcpServer("console")!);
    const before = storedMcpTokens((await readMcpServerSecret("console"))!.oauth)!.access_token;
    const token = await provider!.token();
    expect(token).not.toBe(before);
    expect(fixture!.tokenRequests.filter((request) => request.grant === "refresh_token")).toHaveLength(1);
  });

  it("refreshes once when two processes hit the same expired token", async () => {
    await loggedIn();
    const stored = (await readMcpServerSecret("console"))!.oauth!;
    const failed = storedMcpTokens(stored)!.access_token;
    fixture!.revokeAccessTokens();
    fixture!.setOptions({ refreshDelayMs: 200 });
    // Two sessions with their own memory, as the daemon and a CLI process would have.
    const first = new McpOAuthSession("console", stored);
    const second = new McpOAuthSession("console", stored);
    await Promise.all([first.refresh(failed), second.refresh(failed)]);

    expect(fixture!.tokenRequests.filter((request) => request.grant === "refresh_token")).toHaveLength(1);
    const current = storedMcpTokens((await readMcpServerSecret("console"))!.oauth)!.access_token;
    expect(current).not.toBe(failed);
    expect(await first.token()).toBe(current);
    expect(await second.token()).toBe(current);
    expect(existsSync(join(stateDir, "mcp", "locks", "console"))).toBe(false);
  });

  it("does not write a refresh back after the server was removed meanwhile", async () => {
    await loggedIn();
    const stored = (await readMcpServerSecret("console"))!.oauth!;
    const failed = storedMcpTokens(stored)!.access_token;
    fixture!.revokeAccessTokens();
    fixture!.setOptions({ refreshDelayMs: 300 });
    const session = new McpOAuthSession("console", stored);
    const refreshing = session.refresh(failed);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A removal that does not wait for the lock: the refresh itself must notice the row is gone.
    removeMcpServer("console");
    await deleteMcpServerSecret("console");
    await expect(refreshing).rejects.toMatchObject({ code: "closed" });
    expect(fixture!.tokenRequests.filter((request) => request.grant === "refresh_token")).toHaveLength(1);
    expect(await readMcpServerSecret("console")).toBeNull();
  });

  it("removal waits for a refresh in flight, so the secret stays deleted", async () => {
    await loggedIn();
    const stored = (await readMcpServerSecret("console"))!.oauth!;
    const failed = storedMcpTokens(stored)!.access_token;
    fixture!.revokeAccessTokens();
    fixture!.setOptions({ refreshDelayMs: 300 });
    const refreshing = new McpOAuthSession("console", stored).refresh(failed).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    removeMcpServer("console");
    const deleted = await withMcpCredentialLock("console", () => deleteMcpServerSecret("console"));
    expect(deleted).toBe(true);
    expect(await refreshing).toMatchObject({ code: "closed" });
    expect(await readMcpServerSecret("console")).toBeNull();
  });

  it("drops a refresh that outlived its lock: a logout that broke the lock stands", async () => {
    await loggedIn();
    const stored = (await readMcpServerSecret("console"))!.oauth!;
    const failed = storedMcpTokens(stored)!.access_token;
    fixture!.revokeAccessTokens();
    fixture!.setOptions({ refreshDelayMs: 400 });
    const lock = { staleMs: 100 };
    const refreshing = new McpOAuthSession("console", stored, { lock }).refresh(failed).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The logout finds the lock older than the stale limit and breaks it.
    expect(await runMcpLogout(getMcpServer("console")!, { lock })).toEqual({
      server: "console",
      removed: true,
      revocation: "not_offered",
    });
    expect(await refreshing).toMatchObject({ code: "connect_failed" });
    expect(await readMcpServerSecret("console")).toEqual({ url: fixture!.url });
    expect(readdirSync(join(stateDir, "mcp", "locks"))).toEqual([]);
  });

  it("gives up a token refresh that hangs, and stores nothing", async () => {
    await loggedIn();
    const stored = (await readMcpServerSecret("console"))!.oauth!;
    const failed = storedMcpTokens(stored)!.access_token;
    fixture!.revokeAccessTokens();
    fixture!.setOptions({ refreshDelayMs: 2_000 });
    const started = Date.now();
    await expect(
      new McpOAuthSession("console", stored, { refreshTimeoutMs: 150 }).refresh(failed),
    ).rejects.toMatchObject({ code: "connect_failed" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(storedMcpTokens((await readMcpServerSecret("console"))!.oauth)?.access_token).toBe(failed);
  });

  it("marks the row needs_login when the refresh token is refused", async () => {
    await loggedIn();
    fixture!.revokeAccessTokens();
    fixture!.revokeRefreshTokens();
    const row = await newGateway().refresh("console");
    expect(row).toMatchObject({ status: "needs_login", statusDetail: "run ravi mcp login console --execute" });
  });

  it("answers a step-up (403 insufficient_scope) on that call only, naming the scope", async () => {
    // The login's token has the base scope only; the admin tool challenges for mcp:admin.
    await loggedIn();
    const server = getMcpServer("console")!;
    const narrow = fixture!.mintAccessToken(["mcp:read"]);
    const secret = (await readMcpServerSecret("console"))!;
    await writeMcpServerSecret("console", {
      ...secret,
      oauth: { ...secret.oauth, tokens: { ...secret.oauth!.tokens, access_token: narrow, scope: "mcp:read" } },
    });
    // Refresh and connect still read a missing scope as a login that cannot work.
    expect(classifyMcpFailure(new InsufficientScopeError({ requiredScope: "mcp:admin" }), server)).toBe("needs_login");
    expect(mcpStepUpScopes(new InsufficientScopeError({ requiredScope: "mcp:admin" }))).toEqual(["mcp:admin"]);

    const gw = newGateway();
    const result = await gw.call(
      { context: context(), agentId: AGENT },
      { server: server.name, tool: "admin", arguments: {}, surface: "claude" },
    );
    expect(result).toMatchObject({ ok: false, outcome: "error" });
    const reason = result.ok ? "" : result.reason;
    expect(reason).toContain("mcp:admin");
    expect(reason).toContain("ravi mcp login console");
    expect(reason).toContain("Allow changes");
    // The server stays usable: the row is not marked, and a tool the login covers still works.
    expect(getMcpServer("console")!.status).not.toBe("needs_login");
    const whoami = await gw.call(
      { context: context(), agentId: AGENT },
      { server: server.name, tool: "whoami", arguments: {}, surface: "claude" },
    );
    expect(whoami).toMatchObject({ ok: true });
    expect(fixture!.authorizations).toHaveLength(1);
    expectNoTokenOutside(JSON.stringify(result));
  });

  it("has no provider for a row without a stored login, and never starts an authorization", async () => {
    const server = await register();
    expect(await createMcpAuthProvider(server)).toBeNull();
    const row = await newGateway().refresh("console");
    expect(row?.status).toBe("needs_login");
    expect(fixture!.authorizations).toEqual([]);
    expect(fixture!.registrations).toBe(0);
  });

  it("asks for a login when an expired token has no refresh token", async () => {
    await loggedIn({ refreshTokens: false, expiresIn: 1 });
    const provider = await createMcpAuthProvider(getMcpServer("console")!);
    await expect(provider!.token()).rejects.toBeInstanceOf(McpLoginRequired);
  });
});

describe("bearer login and logout", () => {
  it("names the exact login command in its hints: --execute, and the token on stdin for a bearer server", async () => {
    expect(mcpLoginCommand("docs")).toBe("ravi mcp login docs --execute");
    expect(mcpLoginCommand("docs", "oauth")).toBe("ravi mcp login docs --execute");
    expect(mcpLoginCommand("docs", "bearer")).toBe("ravi mcp login docs --token-stdin --execute < token.txt");

    const server = await register("console", "bearer");
    await runMcpLogin({ server, bearerToken: fixture!.mintAccessToken() });
    await runMcpLogout(getMcpServer("console")!);
    expect(getMcpServer("console")).toMatchObject({
      status: "needs_login",
      statusDetail: "run ravi mcp login console --token-stdin --execute < token.txt",
    });
  });

  it("stores a bearer token only after the server accepted it", async () => {
    const server = await register("console", "bearer");
    await expect(runMcpLogin({ server, bearerToken: "not-a-token" })).rejects.toMatchObject({ code: "token_refused" });
    expect((await readMcpServerSecret("console"))?.bearer).toBeUndefined();

    const token = fixture!.mintAccessToken();
    const result = await runMcpLogin({ server, bearerToken: `${token}\n` });
    expect(result).toMatchObject({ authKind: "bearer", registration: null, toolCount: 2 });
    expect((await readMcpServerSecret("console"))?.bearer).toBe(token);
    expect(getMcpServer("console")!.credentialRev).toBe(server.credentialRev + 1);

    const row = await newGateway().refresh("console");
    expect(row?.status).toBe("ok");
    expect(fixture!.bearers.at(-1)).toBe(token);
    expectNoTokenOutside(JSON.stringify(result), JSON.stringify(row));
  });

  it("refuses a bearer token with spaces or line breaks inside", async () => {
    const server = await register("console", "bearer");
    await expect(runMcpLogin({ server, bearerToken: "two words" })).rejects.toMatchObject({ code: "invalid_option" });
  });

  it("logout forgets the login, keeps the URL and marks the row needs_login", async () => {
    const server = await register();
    await runMcpLogin({ server, port: freePort() }, browserDeps());
    const loggedIn = getMcpServer("console")!;

    expect(await runMcpLogout(loggedIn)).toEqual({ server: "console", removed: true, revocation: "not_offered" });
    const secret = await readMcpServerSecret("console");
    expect(secret).toEqual({ url: fixture!.url });
    const row = getMcpServer("console")!;
    expect(row).toMatchObject({ status: "needs_login", statusDetail: "run ravi mcp login console --execute" });
    expect(row.credentialRev).toBe(loggedIn.credentialRev + 1);
    expect(await runMcpLogout(row)).toEqual({ server: "console", removed: false, revocation: "not_offered" });
    expect(getMcpServer("console")!.credentialRev).toBe(row.credentialRev);
  });
});

describe("revocation of a forgotten or replaced OAuth grant (RFC 7009)", () => {
  async function loggedIn(options = {}) {
    const server = await register("console", "oauth", options);
    const result = await runMcpLogin({ server, port: freePort() }, browserDeps());
    return { row: getMcpServer("console")!, result };
  }

  it("logout revokes the refresh token, then the access token, form encoded with the client id", async () => {
    const { row } = await loggedIn({ revocation: "ok" });
    const tokens = storedMcpTokens((await readMcpServerSecret("console"))!.oauth)!;
    const result = await runMcpLogout(row);
    expect(result).toEqual({ server: "console", removed: true, revocation: "revoked" });
    expect(fixture!.revocations).toEqual([
      {
        hint: "refresh_token",
        clientId: "dcr-client-1",
        contentType: "application/x-www-form-urlencoded",
        known: true,
      },
      { hint: "access_token", clientId: "dcr-client-1", contentType: "application/x-www-form-urlencoded", known: true },
    ]);
    expect(fixture!.revokedTokens).toEqual([tokens.refresh_token!, tokens.access_token]);
    expect(await readMcpServerSecret("console")).toEqual({ url: fixture!.url });
    expectNoTokenOutside(JSON.stringify(result), prompts.join("\n"));
  });

  it("a login that replaces a grant revokes the old one and keeps the new one working", async () => {
    const { row } = await loggedIn({ revocation: "ok" });
    const old = storedMcpTokens((await readMcpServerSecret("console"))!.oauth)!;
    const again = await runMcpLogin({ server: row, port: freePort() }, browserDeps());
    expect(again.previousGrant).toBe("revoked");
    expect(fixture!.revokedTokens).toEqual([old.refresh_token!, old.access_token]);
    const fresh = storedMcpTokens((await readMcpServerSecret("console"))!.oauth)!;
    expect(fixture!.revokedTokens).not.toContain(fresh.access_token);
    expect((await newGateway().refresh("console"))?.status).toBe("ok");
    expectNoTokenOutside(JSON.stringify(again), prompts.join("\n"));
  });

  it("a first login has no previous grant", async () => {
    const { result } = await loggedIn({ revocation: "ok" });
    expect(result.previousGrant).toBeNull();
    expect(fixture!.revocations).toEqual([]);
  });

  it("a refused revocation does not block the logout, and says it was not confirmed", async () => {
    const { row } = await loggedIn({ revocation: "fail" });
    const result = await runMcpLogout(row);
    expect(result).toEqual({ server: "console", removed: true, revocation: "not_confirmed" });
    expect(fixture!.revocations).toHaveLength(2);
    expect(await readMcpServerSecret("console")).toEqual({ url: fixture!.url });
    expect(getMcpServer("console")!.status).toBe("needs_login");
    expectNoTokenOutside(JSON.stringify(result));
  });

  it("sends nothing to a revocation endpoint on another origin", async () => {
    const { row } = await loggedIn({ revocation: "ok", revocationEndpoint: "https://elsewhere.example.com/revoke" });
    let sent = 0;
    const result = await runMcpLogout(row, {
      fetch: (async () => {
        sent++;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ server: "console", removed: true, revocation: "not_confirmed" });
    expect(sent).toBe(0);
    expect(fixture!.revocations).toEqual([]);
  });

  it("gives up a revocation that hangs, and still forgets the login", async () => {
    const { row } = await loggedIn({ revocation: "ok" });
    const started = Date.now();
    const result = await runMcpLogout(row, {
      revocationTimeoutMs: 100,
      fetch: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ server: "console", removed: true, revocation: "not_confirmed" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await readMcpServerSecret("console")).toEqual({ url: fixture!.url });
  });
});

describe("the authorization URL", () => {
  it("is shown only where a person reads it, with the warning not to paste it anywhere", async () => {
    const server = await register();
    await runMcpLogin({ server, port: freePort() }, browserDeps());
    const shown = prompts.join("\n");
    expect(shown).toContain("/authorize?");
    expect(shown).toContain("do not paste it into a chat or a ticket");
  });

  it("stays off a non-terminal output: the browser opens it, no line carries it", async () => {
    const server = await register();
    const result = await runMcpLogin({ server, port: freePort() }, browserDeps({ showAuthorizationUrl: false }));
    expect(result.authKind).toBe("oauth");
    expect(fixture!.authorizations).toHaveLength(1);
    expect(prompts.some((line) => line.includes("/authorize?"))).toBe(false);
    expect(prompts.some((line) => line.includes(fixture!.issuer))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("/authorize");
  });

  it("refuses --paste without a terminal before it contacts the server", async () => {
    const server = await register();
    await expect(
      runMcpLogin({ server, port: freePort(), paste: true }, browserDeps({ showAuthorizationUrl: false })),
    ).rejects.toMatchObject({ code: "invalid_option" });
    expect(fixture!.authorizations).toEqual([]);
    expect(fixture!.registrations).toBe(0);
    expect(fixture!.tokenRequests).toEqual([]);
  });
});

describe("credential lock", () => {
  it("serializes holders and breaks a lock left by a process that is gone", async () => {
    const order: string[] = [];
    await Promise.all([
      withMcpCredentialLock("console", async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 100));
        order.push("a-end");
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await withMcpCredentialLock("console", async () => void order.push("b"));
      })(),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);

    const path = join(stateDir, "mcp", "locks", "console");
    writeFileSync(path, "999999999 stale", { mode: 0o600 });
    await withMcpCredentialLock("console", async () => void order.push("after-stale"), { timeoutMs: 500 });
    expect(order.at(-1)).toBe("after-stale");

    // A live holder that is too old is broken too.
    writeFileSync(path, `${process.pid} old`, { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path, old, old);
    await withMcpCredentialLock("console", async () => void order.push("after-old"), { timeoutMs: 500 });
    expect(order.at(-1)).toBe("after-old");
    expect(readdirSync(join(stateDir, "mcp", "locks"))).toEqual([]);
  });

  it("never takes away a live lock that replaced the stale one it judged", () => {
    const directory = join(stateDir, "mcp", "locks");
    const path = join(directory, "console");
    // Create the directory through the lock helper's own path rule.
    return withMcpCredentialLock("console", async () => {}).then(() => {
      writeFileSync(path, "999999999 stale", { mode: 0o600 });
      // The other waiter wins the race: it breaks the same stale lock and takes the lock itself.
      setMcpStaleLockHookForTests((lockPath) => {
        setMcpStaleLockHookForTests(null);
        unlinkSync(lockPath);
        writeFileSync(lockPath, `${process.pid} live-owner`, { mode: 0o600 });
      });
      try {
        expect(breakStaleMcpCredentialLock(path, 120_000)).toBe(false);
      } finally {
        setMcpStaleLockHookForTests(null);
      }
      expect(readFileSync(path, "utf8")).toBe(`${process.pid} live-owner`);
      expect(readdirSync(directory)).toEqual(["console"]);
      unlinkSync(path);
    });
  });

  it("times out on a live, fresh lock", async () => {
    const path = join(stateDir, "mcp", "locks");
    await withMcpCredentialLock("console", async () => {
      await expect(withMcpCredentialLock("console", async () => "never", { timeoutMs: 100 })).rejects.toMatchObject({
        code: "timeout",
      });
    });
    expect(readdirSync(path)).toEqual([]);
  });
});

describe("RaviMcpOAuthProvider", () => {
  it("compares the state in constant time and keeps no stored tokens for a new login", () => {
    const provider = new RaviMcpOAuthProvider({
      server: "console",
      redirectUrl: mcpLoginRedirectUrl(4000),
      stored: {
        tokens: { access_token: "old-access", refresh_token: "old-refresh" },
        client: { client_id: "dcr-client-1" },
        clientSource: "dynamic",
        redirectUrl: mcpLoginRedirectUrl(4000),
      },
    });
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "dcr-client-1" });
    expect(provider.matchesState(provider.state())).toBe(true);
    expect(provider.matchesState(`${provider.state()}x`)).toBe(false);
    expect(provider.matchesState(null)).toBe(false);
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: [mcpLoginRedirectUrl(4000)],
      token_endpoint_auth_method: "none",
    });
  });

  it("drops a stored registration made for another redirect or another kind of client id", () => {
    const stored = {
      client: { client_id: "dcr-client-1" },
      clientSource: "dynamic" as const,
      redirectUrl: mcpLoginRedirectUrl(4000),
    };
    expect(
      new RaviMcpOAuthProvider({ server: "c", redirectUrl: mcpLoginRedirectUrl(4001), stored }).clientInformation(),
    ).toBeUndefined();
    expect(
      new RaviMcpOAuthProvider({
        server: "c",
        redirectUrl: mcpLoginRedirectUrl(4000),
        stored,
        clientMetadataUrl: METADATA_URL,
      }).clientInformation(),
    ).toBeUndefined();
  });
});
