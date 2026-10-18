import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { OutboundAccountResolution } from "../channels/account-resolution.js";
import { readCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { dbCreateAgent, dbCreateRoute, dbGetRoute } from "../router/router-db.js";
import type { RouterConfig } from "../router/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  APPROVE_URL,
  bindingPayload,
  createFakeConsole,
  createFakeMessenger,
  createMemoryCredentials,
  linkDeps,
  requestPayload,
} from "./fake-console.fixture.js";
import { handleLinkingDirectMessage, type LinkingDirectMessage } from "./link-dm-flow.js";
import { ensureLinkedDmRoute } from "./link-dm-route.js";
import { getLocalLinkRequest } from "./link-requests-db.js";
import { requestIdentityLink } from "./link-service.js";
import { getContactLinkState } from "./link-states-db.js";
import { processPendingLinkRequests } from "./link-watcher.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const GROUP = "120363000000000000@g.us";
const DM = "5511999999999@s.whatsapp.net";

const omni = (accountId: string | undefined): OutboundAccountResolution => ({
  kind: "omni",
  accountId: accountId ?? "",
  instanceId: "omni-1",
});

/** An instance with no default agent: an unknown private chat reaches no one. */
const noDefaultAgent = {
  agents: {},
  routes: [],
  defaultAgent: "main",
  defaultDmScope: "per-peer",
  accountAgents: {},
  instanceToAccount: {},
  instances: {},
} as unknown as RouterConfig;

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-identity-dm-flow-");
  dbCreateAgent({ id: "vendas", cwd: "/tmp/vendas" });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function whatsappGroupTurn() {
  return createRuntimeContext({
    kind: "turn-runtime",
    agentId: "vendas",
    source: { channel: "whatsapp", accountId: "wa-main", chatId: GROUP },
    metadata: {
      actorPrincipal: "contact:contact_luis",
      actorResolution: "resolved",
      actor: {
        channel: "whatsapp",
        accountId: "wa-main",
        chatId: GROUP,
        sourceMessageId: "MSG1",
        actorType: "contact",
        contactId: "contact_luis",
        rawSenderId: "5511999999999",
        senderName: "Luís Filipe",
      },
    },
  });
}

function privateMessage(overrides: Partial<LinkingDirectMessage> = {}): LinkingDirectMessage {
  return {
    contactId: "contact_luis",
    channel: "whatsapp",
    accountId: "wa-main",
    chatId: DM,
    routePattern: "5511999999999",
    platformUserId: "5511999999999",
    platformIdentityId: "pi_luis",
    displayName: "Luís Filipe",
    ...overrides,
  };
}

function setup() {
  const fake = createFakeConsole();
  fake.on((call) =>
    call.method === "POST" && call.path === "/api/cli/link/requests"
      ? {
          status: 201,
          body: { version: 1, status: "pending", request: requestPayload("pending"), approveUrl: APPROVE_URL },
        }
      : undefined,
  );
  const { messenger, sent } = createFakeMessenger();
  const deps = {
    ...linkDeps(fake, createMemoryCredentials(), messenger, { resolveAccount: omni, now: () => NOW }),
    getConfig: () => noDefaultAgent,
    emitConfigChanged: () => {},
    wakeWatcher: () => {},
  };
  return { fake, sent, deps };
}

describe("WhatsApp linking flow", () => {
  it("never writes first from a group: the person is asked to write in private", async () => {
    const { fake, sent, deps } = setup();

    const result = await requestIdentityLink(whatsappGroupTurn(), deps);

    expect(result).toEqual({ success: true, status: "awaiting_dm", linked: false });
    expect(sent).toHaveLength(0);
    expect(fake.linkCalls()).toEqual([]);
    expect(getContactLinkState("contact_luis", NOW)).toMatchObject({
      status: "awaiting_dm",
      channel: "whatsapp",
      accountId: "wa-main",
      agentId: "vendas",
      origin: { channel: "whatsapp", accountId: "wa-main", chatId: GROUP, sourceMessageId: "MSG1" },
    });
  });

  it("leaves private messages of people outside the flow to the agent", async () => {
    const { sent, deps } = setup();
    expect(await handleLinkingDirectMessage(privateMessage(), deps)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("answers the person's private message with the link, then reminds them while it is valid", async () => {
    const { fake, sent, deps } = setup();
    await requestIdentityLink(whatsappGroupTurn(), deps);

    expect(await handleLinkingDirectMessage(privateMessage(), deps)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: { channel: "whatsapp", accountId: "wa-main", chatId: DM },
      privateLink: true,
    });
    expect(sent[0]?.text).toContain(APPROVE_URL);
    expect(sent[0]?.text).toContain("Para eu fazer coisas no seu nome");
    expect(getContactLinkState("contact_luis", NOW)).toMatchObject({
      status: "link_sent",
      requestId: "lr_1",
      routePattern: "5511999999999",
    });
    // The confirmation goes back to the group where the person asked.
    expect(getLocalLinkRequest("lr_1")).toMatchObject({ dm: { chatId: DM }, origin: { chatId: GROUP } });

    expect(await handleLinkingDirectMessage(privateMessage(), deps)).toBe(true);
    expect(fake.linkCalls()).toEqual(["POST /api/cli/link/requests"]);
    expect(sent[1]?.text).toContain("ainda vale por 10 minutos");
    expect(sent[1]?.privateLink).toBe(false);
  });

  it("on approval routes the private chat to the agent, ends the flow and confirms in both chats", async () => {
    const { fake, sent, deps } = setup();
    await requestIdentityLink(whatsappGroupTurn(), deps);
    await handleLinkingDirectMessage(privateMessage(), deps);
    fake.on((call) =>
      call.method === "GET" && call.path === "/api/cli/link/requests/lr_1"
        ? { body: { version: 1, request: requestPayload("approved"), binding: bindingPayload() } }
        : undefined,
    );

    await processPendingLinkRequests(deps);

    expect(readCachedActorBinding("contact_luis")?.consoleUserId).toBe("user_luis");
    expect(getContactLinkState("contact_luis", NOW)).toBeNull();
    expect(dbGetRoute("5511999999999", "wa-main")).toMatchObject({ agent: "vendas", policy: "open" });
    expect(sent.slice(1).map((message) => message.target.chatId)).toEqual([DM, GROUP]);
  });

  it("after the link expires, the next private message gets a new one", async () => {
    const { fake, sent, deps } = setup();
    await requestIdentityLink(whatsappGroupTurn(), deps);
    await handleLinkingDirectMessage(privateMessage(), deps);
    fake.on((call) =>
      call.method === "GET" && call.path === "/api/cli/link/requests/lr_1"
        ? { body: { version: 1, request: requestPayload("expired") } }
        : undefined,
    );

    await processPendingLinkRequests(deps);

    expect(getContactLinkState("contact_luis", NOW)?.status).toBe("awaiting_dm");
    expect(sent[1]?.text).toContain("me mande qualquer mensagem aqui");
  });

  it("a denial ends the flow", async () => {
    const { fake, deps } = setup();
    await requestIdentityLink(whatsappGroupTurn(), deps);
    await handleLinkingDirectMessage(privateMessage(), deps);
    fake.on((call) =>
      call.method === "GET" && call.path === "/api/cli/link/requests/lr_1"
        ? { body: { version: 1, request: requestPayload("denied") } }
        : undefined,
    );

    await processPendingLinkRequests(deps);

    expect(getContactLinkState("contact_luis", NOW)).toBeNull();
  });
});

describe("ensureLinkedDmRoute", () => {
  const state = { channel: "whatsapp", accountId: "wa-main", agentId: "vendas", routePattern: "5511999999999" };
  const quiet = { emitConfigChanged: () => {} };

  it("keeps an explicit route the operator made", () => {
    dbCreateAgent({ id: "suporte", cwd: "/tmp/suporte" });
    dbCreateRoute({ pattern: "5511999999999", accountId: "wa-main", agent: "suporte" });
    expect(ensureLinkedDmRoute(state, { ...quiet, getConfig: () => noDefaultAgent })).toBe("reaches_agent");
    expect(dbGetRoute("5511999999999", "wa-main")?.agent).toBe("suporte");
  });

  it("does not open private chats the operator closed", () => {
    const closed = {
      ...noDefaultAgent,
      agents: { vendas: { id: "vendas", cwd: "/tmp/vendas" } },
      accountAgents: { "wa-main": "vendas" },
      instances: { "wa-main": { dmPolicy: "closed" } },
    } as unknown as RouterConfig;
    expect(ensureLinkedDmRoute(state, { ...quiet, getConfig: () => closed })).toBe("dm_closed");
    expect(dbGetRoute("5511999999999", "wa-main")).toBeNull();
  });

  it("leaves a chat the instance's default agent already answers", () => {
    const open = {
      ...noDefaultAgent,
      agents: { vendas: { id: "vendas", cwd: "/tmp/vendas" } },
      accountAgents: { "wa-main": "vendas" },
      instances: { "wa-main": { dmPolicy: "open" } },
    } as unknown as RouterConfig;
    expect(ensureLinkedDmRoute(state, { ...quiet, getConfig: () => open })).toBe("reaches_agent");
    expect(dbGetRoute("5511999999999", "wa-main")).toBeNull();
  });
});
