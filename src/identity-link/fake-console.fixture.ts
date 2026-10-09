/**
 * In-memory Console and chat fakes for the `ravi link` tests.
 */

import type { OutboundAccountResolution } from "../channels/account-resolution.js";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import type { ContextRecord } from "../router/router-db.js";
import type { IdentityLinkDeps } from "./link-service.js";
import type { LinkChatTarget, LinkDmRoute, LinkMessenger } from "./link-dm.js";

export const CONSOLE_URL = "https://console.example";
export const APPROVE_URL = "https://console.example/link/ravi_lr_secret_token";

export interface ConsoleCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Handler = (call: ConsoleCall) => { status?: number; body: unknown } | undefined;

export function bindingPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "bind_1",
    contactId: "contact_luis",
    actorPrincipal: "contact:contact_luis",
    consoleUserId: "user_luis",
    orgId: "org_acme",
    installationId: "ins_console",
    ...overrides,
  };
}

export function requestPayload(status: string, overrides: Record<string, unknown> = {}) {
  return { id: "lr_1", status, expiresAt: "2026-10-09T12:10:00.000Z", ...overrides };
}

/** Console that answers /me and lets each test script the link endpoints. */
export function createFakeConsole() {
  const calls: ConsoleCall[] = [];
  const handlers: Handler[] = [];
  const client = new ConsoleApiClient({
    consoleUrl: CONSOLE_URL,
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const call: ConsoleCall = {
        method: init?.method ?? "GET",
        path: `${parsed.pathname}${parsed.search}`,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      if (call.path === "/api/cli/me") {
        return json(200, {
          user: { id: "user_operator", email: "operator@example.com" },
          organization: { id: "org_acme", slug: "acme" },
          localInstallation: { id: "ins_console", name: "laptop" },
        });
      }
      for (const handler of handlers) {
        const answer = handler(call);
        if (answer) return json(answer.status ?? 200, answer.body);
      }
      return json(404, { error: { code: "NOT_FOUND", message: `no fake for ${call.method} ${call.path}` } });
    },
  });
  return {
    client,
    calls,
    on(handler: Handler) {
      handlers.unshift(handler);
    },
    linkCalls() {
      return calls.filter((call) => call.path !== "/api/cli/me").map((call) => `${call.method} ${call.path}`);
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function createMemoryCredentials(installationId = "ins_console") {
  let stored: CloudCredentials | null = {
    version: 1,
    consoleUrl: CONSOLE_URL,
    installationId,
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: null,
    scopes: [],
    user: { id: "user_operator" },
    organization: { id: "org_acme" },
    createdAt: "2026-10-09T12:00:00.000Z",
    updatedAt: "2026-10-09T12:00:00.000Z",
  };
  return {
    get current() {
      return stored;
    },
    readCredentials: () => stored,
    writeCredentials: (next: CloudCredentials) => {
      stored = next;
    },
    deleteCredentials: () => {
      stored = null;
    },
  };
}

export interface SentMessage {
  target: LinkChatTarget;
  text: string;
  privateLink: boolean;
}

export function createFakeMessenger(options: { email?: string | null; dmChatId?: string; fail?: boolean } = {}) {
  const sent: SentMessage[] = [];
  const messenger: LinkMessenger = {
    async send(target, text, sendOptions = {}) {
      if (options.fail) throw new Error("channel_not_found");
      sent.push({ target, text, privateLink: sendOptions.privateLink === true });
      const isDm = target.chatId.startsWith("U") && options.dmChatId;
      return { chatId: isDm ? (options.dmChatId as string) : target.chatId };
    },
    async lookupEmail(_route: LinkDmRoute) {
      return options.email ?? null;
    },
  };
  return { messenger, sent };
}

/** A native Slack account; the route only reads `kind` and `provider`. */
export const slackNative = (accountId: string | undefined): OutboundAccountResolution =>
  ({
    kind: "native",
    accountId: accountId ?? "",
    instanceId: `slack-${accountId ?? ""}`,
    provider: "slack",
    channelName: "slack",
    credentialConfigured: true,
  }) as unknown as OutboundAccountResolution;

export function slackTurnContext(overrides: Record<string, unknown> = {}): ContextRecord {
  return createRuntimeContext({
    kind: "turn-runtime",
    agentId: "main",
    source: { channel: "slack", accountId: "acme", chatId: "C0CHANNEL", threadId: "1712345678.000100" },
    metadata: {
      actorPrincipal: "contact:contact_luis",
      actorResolution: "resolved",
      actor: {
        channel: "slack",
        accountId: "acme",
        chatId: "C0CHANNEL",
        threadId: "1712345678.000100",
        sourceMessageId: "1712345690.000200",
        actorType: "contact",
        contactId: "contact_luis",
        platformIdentityId: "pi_luis",
        rawSenderId: "U0LUIS",
        senderName: "Luís Filipe",
      },
      ...overrides,
    },
  });
}

export function linkDeps(
  fake: ReturnType<typeof createFakeConsole>,
  credentials: ReturnType<typeof createMemoryCredentials>,
  messenger: LinkMessenger,
  extra: Partial<IdentityLinkDeps> = {},
): IdentityLinkDeps {
  return {
    client: fake.client,
    readCredentials: credentials.readCredentials,
    writeCredentials: credentials.writeCredentials,
    deleteCredentials: credentials.deleteCredentials,
    messenger,
    resolveAccount: slackNative,
    env: process.env,
    now: () => Date.parse("2026-10-09T12:00:00.000Z"),
    ...extra,
  };
}
