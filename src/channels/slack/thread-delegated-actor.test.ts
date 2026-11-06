import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resolveAccessActor, type AccessActorDeps } from "../../access/actor.js";
import { runWithContext } from "../../cli/context.js";
import { writeCachedActorBinding } from "../../cloud-auth/actor-bindings.js";
import { ConsoleApiClient } from "../../cloud-auth/client.js";
import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import { turnActorContactId, unattributedTurnRefusal } from "../../cloud-auth/turn-actor.js";
import { ensureContactFromInbound, updateContact } from "../../contacts.js";
import { dbDeleteContactChatGrant, dbEnsureContactChatGrant } from "../../permissions/contact-chat-grants.js";
import { canWithCapabilities } from "../../permissions/provider-runtime.js";
import { dbCreateAgent, dbGetContext, dbUpdateAgent, dbUpsertChat } from "../../router/router-db.js";
import { getOrCreateSession, getSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import {
  issueRuntimeContext,
  resolveRuntimeContext,
  revokeLiveRuntimeContextsForContactGrant,
  revokeRuntimeContext,
} from "../../runtime/context-registry.js";
import { createQueuedRuntimeUserMessage } from "../../runtime/delivery-queue.js";
import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import {
  buildRuntimeRequestContext,
  refreshRuntimeRequestContextForTurn,
} from "../../runtime/runtime-request-context.js";
import { classifyTurnProvenance } from "../../runtime/turn-provenance.js";
import { dbCreateTagDefinition } from "../../tags/index.js";
import type { TaskRuntimeResolution } from "../../tasks/types.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../../test/ravi-state.js";
import {
  closeSlackThread,
  finalizeSlackThreadCreation,
  reportSlackThreadProgress,
  sendSlackThreadMessage,
  type SlackThreadLifecycleDependencies,
} from "./thread-lifecycle.js";
import { createSlackThreadLifecycle, markSlackThreadRootDelivered } from "./thread-lifecycle-store.js";

const AGENT = { id: "thread-worker", cwd: "/tmp/thread-worker" };
const ROOT_KEY = "thread-parent";
const CHANNEL = "C123";
const INSTANCE = "slack-test-instance";
const ACCOUNT = "slack-test-account";
const REQUEST_ID = "slack-thread:delegated-actor";
const THREAD_TS = "1713000000.000100";
const OWNER_USER = "test_operator_user";
const ORG = "test_org";
const READ_PROFILE = "permission-thread-read";
const runtimeResolution: TaskRuntimeResolution = {
  options: {},
  sources: { model: null, effort: null, thinking: null },
  hasTaskRuntimeContext: false,
};
const contextEnvKeys = [...RAVI_RUNTIME_CONTEXT_ENV_KEYS, "RAVI_AUTOMATION_PRINCIPAL", "RAVI_CLOUD_AUTH_BACKEND"];

let stateDir: string | null = null;
let previousEnv: Map<string, string | undefined>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-thread-delegated-actor-");
  previousEnv = new Map(contextEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of contextEnvKeys) delete process.env[key];
  dbCreateAgent(AGENT);
});

afterEach(async () => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("Slack thread delegated Console actor", () => {
  it.each(["contact", "operator"])(
    "attributes the first child turn to its verified %s caller without replacing the agent principal",
    async (caller) => {
      const fixture = seedRoot();
      const person = seedPerson("U111", caller === "operator" ? OWNER_USER : "test_contact_user");
      const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, person));
      expect(parentTurn.runtimeContext.metadata?.actorPrincipal).toBe(`contact:${person.contactId}`);
      expect(parentTurn.runtimeContext.metadata?.consoleUserId).toBe(person.consoleUserId);
      seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
      const transport = captureTransport();

      deliverRoot();
      await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);

      expect(transport.prompts).toHaveLength(1);
      assertDelegatedContact(buildPublishedTurn(transport.prompts[0]!), person.contactId);
    },
  );

  it("keeps the admitted bootstrap caller when root delivery and the queued child start follow parent key rotation", async () => {
    const fixture = seedRoot();
    const original = seedPerson("U111", "test_original_user");
    const replacement = seedPerson("U222", OWNER_USER);
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
    const admittedContextId = parentTurn.runtimeContext.contextId;
    const admittedContextKey = parentTurn.runtimeContext.contextKey;
    seedCreation(fixture.rootChatId, admittedContextId);

    rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, replacement));
    expect(resolveRuntimeContext(admittedContextKey, { touch: false })).toBeNull();
    expect(dbGetContext(admittedContextId)?.metadata?.revocationReason).toBe("turn_context_rotated");
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);

    const queued = enqueue(transport.prompts[0]!);
    assertDelegatedContact(buildPublishedTurn(queued), original.contactId);
  });

  it("attributes thread-send to the current parent caller instead of the person who created the thread", async () => {
    const fixture = seedRoot();
    const original = seedPerson("U111", "test_original_user");
    const sender = seedPerson("U222", "test_followup_user");
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
    seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    buildPublishedTurn(transport.prompts[0]!);
    rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, sender));

    const sent = await sendFromParent(fixture.parent, parentTurn, transport.dependencies);

    expect(sent.reopened).toBe(false);
    expect(transport.prompts).toHaveLength(2);
    assertDelegatedContact(buildPublishedTurn(transport.prompts[1]!), sender.contactId);
  });

  it.each([false, true])("preserves a queued thread-send caller after key rotation (reopened=%s)", async (reopened) => {
    const fixture = seedRoot();
    const original = seedPerson("U111", "test_original_user");
    const sender = seedPerson("U222", "test_followup_user");
    const replacement = seedPerson("U333", OWNER_USER);
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
    seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const childTurn = buildPublishedTurn(transport.prompts[0]!);
    if (reopened) {
      await runWithContext(childTurn.toolContext, () =>
        closeSlackThread(getSession(`${ROOT_KEY}:thread:${THREAD_TS}`)!, undefined, transport.dependencies),
      );
    }
    rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, sender));
    const senderContextKey = parentTurn.runtimeContext.contextKey;

    const sent = await sendFromParent(fixture.parent, parentTurn, transport.dependencies);
    const queued = enqueue(transport.prompts[1]!);
    rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, replacement));

    expect(sent.reopened).toBe(reopened);
    expect(sent.record.status).toBe("open");
    expect(resolveRuntimeContext(senderContextKey, { touch: false })).toBeNull();
    assertDelegatedContact(buildPublishedTurn(queued), sender.contactId);
  });

  it.each([false, true])(
    "withdraws a revoked grant after source rotation (child already materialized=%s)",
    async (materialized) => {
      const fixture = seedRoot();
      const original = seedPerson("U111", "test_original_user");
      const replacement = seedPerson("U222", OWNER_USER);
      seedReadProfile();
      const grant = seedReadGrant(original.contactId, fixture.rootChatId);
      // A chat grant is valid for a pending group participant too; identity
      // resolution must not substitute an unrelated global allowed policy.
      updateContact(original.contactId, { status: "pending" });
      const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
      expect(parentTurn.runtimeContext.metadata?.actorAuthorizationMode).toBe("user-overlay");
      expect(parentTurn.runtimeContext.metadata?.userOverlayGrants).toContain(
        `${READ_PROFILE}@chat:${fixture.rootChatId}`,
      );
      expect(canReadBases(parentTurn)).toBe(true);
      seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
      const transport = captureTransport();
      deliverRoot();
      await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
      const queued = enqueue(transport.prompts[0]!);
      const childTurn = materialized ? buildPublishedTurn(queued) : null;
      const cli = childTurn
        ? issueRuntimeContext({ parent: childTurn.runtimeContext, cliName: "bases-reader", inheritCapabilities: true })
        : null;
      if (childTurn) {
        expect(canReadBases(childTurn)).toBe(true);
        assertDelegatedContact(childTurn, original.contactId);
      }
      rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, replacement));

      // Exercise the real storage + invalidation mechanism used by permissions
      // deny; this is not a CLI parsing test or a hand-written revocation marker.
      expect(dbDeleteContactChatGrant(grant)).toBe(true);
      revokeLiveRuntimeContextsForContactGrant(original.contactId, `${READ_PROFILE}@chat:${fixture.rootChatId}`);

      if (childTurn && cli) {
        expect(resolveRuntimeContext(childTurn.runtimeContext.contextKey, { touch: false })).toBeNull();
        expect(resolveRuntimeContext(cli.contextKey, { touch: false })).toBeNull();
        assertDenied(childTurn);
      }
      // A delayed bootstrap, or a replay after invalidating the active child,
      // must not remint the historical grant from the completed caller.
      const laterTurn = buildPublishedTurn(queued);
      expect(canReadBases(laterTurn)).toBe(false);
      assertDenied(laterTurn);
    },
  );

  it("refuses a deleted grant even when context invalidation has not run", async () => {
    const fixture = seedRoot();
    const person = seedPerson("U111", "test_contact_user");
    seedReadProfile();
    const grant = seedReadGrant(person.contactId, fixture.rootChatId);
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, person));
    seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const childTurn = buildPublishedTurn(transport.prompts[0]!);
    expect(canReadBases(childTurn)).toBe(true);
    assertDelegatedContact(childTurn, person.contactId);

    // Stop between the grant deletion and its invalidation step. Both issued
    // keys remain live, so the refusal must come from the current grant state.
    expect(dbDeleteContactChatGrant(grant)).toBe(true);

    expect(resolveRuntimeContext(parentTurn.runtimeContext.contextKey, { touch: false })).not.toBeNull();
    expect(resolveRuntimeContext(childTurn.runtimeContext.contextKey, { touch: false })).not.toBeNull();
    assertDenied(childTurn);
  });

  it("sends no Bases HTTP request when the caller is revoked after a successful preflight", async () => {
    const fixture = seedRoot();
    const person = seedPerson("U111", "test_contact_user");
    const accessToken = seedConsoleLogin();
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, person));
    seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const childTurn = buildPublishedTurn(transport.prompts[0]!);
    assertDelegatedContact(childTurn, person.contactId);
    const fetch = mock(async () => new Response(JSON.stringify({ bases: [] }), { status: 200 }));
    const client = new ConsoleApiClient({ consoleUrl: "https://console.example.test", fetch });

    await runWithContext({ ...childTurn.toolContext, transport: "tool" }, async () => {
      expect(unattributedTurnRefusal()).toBeNull();
      revokeRuntimeContext(parentTurn.runtimeContext.contextId);

      await expect(
        client.requestJson("GET", "/api/cli/projects/p/bases?includeArchived=1", undefined, accessToken),
      ).rejects.toMatchObject({ code: "ACTOR_UNKNOWN" });
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks the actor on a second Bases HTTP request instead of reusing the first request's header", async () => {
    const fixture = seedRoot();
    const person = seedPerson("U111", "test_contact_user");
    const accessToken = seedConsoleLogin();
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, person));
    seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const childTurn = buildPublishedTurn(transport.prompts[0]!);
    assertDelegatedContact(childTurn, person.contactId);
    const requests: Array<{ url: string; contactId: string | null }> = [];
    const fetch = mock(async (url: string, init?: RequestInit) => {
      requests.push({ url, contactId: new Headers(init?.headers).get("x-ravi-actor-contact") });
      return new Response(JSON.stringify({ bases: [] }), { status: 200 });
    });
    const client = new ConsoleApiClient({ consoleUrl: "https://console.example.test", fetch });

    await runWithContext({ ...childTurn.toolContext, transport: "tool" }, async () => {
      expect(unattributedTurnRefusal()).toBeNull();
      await client.requestJson("GET", "/api/cli/projects/p/bases?includeArchived=1", undefined, accessToken);
      expect(requests).toEqual([
        {
          url: "https://console.example.test/api/cli/projects/p/bases?includeArchived=1",
          contactId: person.contactId,
        },
      ]);
      revokeRuntimeContext(parentTurn.runtimeContext.contextId);

      await expect(
        client.requestJson("POST", "/api/cli/projects/p/bases/b/views/v/share", { siteId: "test-site" }, accessToken),
      ).rejects.toMatchObject({ code: "ACTOR_UNKNOWN" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps another contact and another scope live when a historical caller's grant is revoked", async () => {
    const fixture = seedRoot();
    const original = seedPerson("U111", "test_original_user");
    const other = seedPerson("U222", "test_other_user");
    const otherChat = dbUpsertChat({
      channel: "slack",
      instanceId: INSTANCE,
      platformChatId: "C456",
      chatType: "channel",
    });
    seedReadProfile();
    const grant = seedReadGrant(original.contactId, fixture.rootChatId);
    seedReadGrant(other.contactId, fixture.rootChatId);
    seedReadGrant(original.contactId, otherChat.id);
    const otherContactSession = getOrCreateSession("other-contact", AGENT.id, AGENT.cwd, { name: "other-contact" });
    const otherScopeSession = getOrCreateSession("other-scope", AGENT.id, AGENT.cwd, { name: "other-scope" });
    const otherContactTurn = buildTurn(otherContactSession, humanPrompt(fixture.rootChatId, other));
    const otherScopePrompt = humanPrompt(otherChat.id, original);
    otherScopePrompt.source!.chatId = "C456";
    otherScopePrompt.context!.chatId = "C456";
    const otherScopeTurn = buildTurn(otherScopeSession, otherScopePrompt);
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
    seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const childTurn = buildPublishedTurn(transport.prompts[0]!);
    rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, other));

    expect(dbDeleteContactChatGrant(grant)).toBe(true);
    revokeLiveRuntimeContextsForContactGrant(original.contactId, `${READ_PROFILE}@chat:${fixture.rootChatId}`);

    assertDenied(childTurn);
    for (const [control, person] of [
      [otherContactTurn, other],
      [otherScopeTurn, original],
    ] as const) {
      expect(resolveRuntimeContext(control.runtimeContext.contextKey, { touch: false })).not.toBeNull();
      expect(canReadBases(control)).toBe(true);
      expect(resolveAccessActor(actorDeps(control))).toMatchObject({ kind: "contact", contactId: person.contactId });
    }
  });

  it("does not revive an explicitly revoked historical caller when a delayed completion overwrites its reason", async () => {
    const fixture = seedRoot();
    const original = seedPerson("U111", "test_original_user");
    const replacement = seedPerson("U222", OWNER_USER);
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
    const originalContextId = parentTurn.runtimeContext.contextId;
    seedCreation(fixture.rootChatId, originalContextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const queued = enqueue(transport.prompts[0]!);
    const childTurn = buildPublishedTurn(queued);
    rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, replacement));
    assertDelegatedContact(childTurn, original.contactId);

    revokeRuntimeContext(originalContextId);
    assertDenied(childTurn);
    revokeRuntimeContext(originalContextId, { reason: "turn_context_completed" });

    assertDenied(childTurn);
    assertDenied(buildPublishedTurn(queued));
  });

  it.each([false, true])(
    "refuses a caller who opts out after admission (child already materialized=%s)",
    async (materialized) => {
      const fixture = seedRoot();
      const person = seedPerson("U111", "test_contact_user");
      const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, person));
      seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
      const transport = captureTransport();
      deliverRoot();
      await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
      const queued = enqueue(transport.prompts[0]!);
      const childTurn = materialized ? buildPublishedTurn(queued) : null;

      updateContact(person.contactId, { opt_out: true });

      assertDenied(childTurn ?? buildPublishedTurn(queued));
    },
  );

  it("follows legitimate derived CLI credentials on both sides of the thread handoff", async () => {
    const fixture = seedRoot();
    const person = seedPerson("U111", "test_contact_user");
    const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, person));
    const callerCli = issueRuntimeContext({
      parent: parentTurn.runtimeContext,
      cliName: "thread-creator",
      inheritCapabilities: true,
    });
    seedCreation(fixture.rootChatId, callerCli.contextId);
    const transport = captureTransport();
    deliverRoot();
    await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
    const childTurn = buildPublishedTurn(transport.prompts[0]!);
    assertDelegatedContact(childTurn, person.contactId);

    const readerCli = issueRuntimeContext({
      parent: childTurn.runtimeContext,
      cliName: "bases-reader",
      inheritCapabilities: true,
    });
    const deps = actorDeps({ ...childTurn, runtimeContext: readerCli });
    expect(resolveAccessActor(deps)).toMatchObject({ kind: "contact", contactId: person.contactId });
    expect(unattributedTurnRefusal(deps.turn!.env, deps)).toBeNull();
    expect(turnActorContactId(deps.turn!.env, deps)).toBe(person.contactId);
  });

  it.each(["report", "close-return"])(
    "keeps the original person through a real %s after the parent's speaker changes",
    async (operation) => {
      const fixture = seedRoot();
      const original = seedPerson("U111", "test_original_user");
      const replacement = seedPerson("U222", OWNER_USER);
      const parentTurn = buildTurn(fixture.parent, humanPrompt(fixture.rootChatId, original));
      seedCreation(fixture.rootChatId, parentTurn.runtimeContext.contextId);
      const transport = captureTransport();
      deliverRoot();
      await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
      const childTurn = buildPublishedTurn(transport.prompts[0]!);
      const child = getSession(`${ROOT_KEY}:thread:${THREAD_TS}`)!;
      rotateParent(parentTurn, fixture.parent, humanPrompt(fixture.rootChatId, replacement));

      await runWithContext(childTurn.toolContext, async () => {
        if (operation === "report") {
          await reportSlackThreadProgress(child, "Found the requested record", transport.dependencies);
        } else {
          const closed = await closeSlackThread(child, "The requested record is verified", transport.dependencies);
          expect(closed.parentReturnDelivered).toBe(true);
        }
      });

      expect(transport.prompts).toHaveLength(2);
      const queued = enqueue(transport.prompts[1]!);
      expect(queued.sessionName).toBe(fixture.parent.name!);
      assertDelegatedContact(buildTurn(fixture.parent, queued.payload), original.contactId);
    },
  );

  it.each(["agent", "unknown", "missing_context"] as const)(
    "refuses a bootstrap with a genuinely %s initiator despite a logged-in operator",
    async (initiator) => {
      const fixture = seedRoot();
      // A known person and an attractive display name must not supply authority
      // to a turn with no structured human caller.
      const person = seedPerson("U111", OWNER_USER);
      const prompt = humanPrompt(fixture.rootChatId, person);
      delete prompt.source!.contactId;
      delete prompt.source!.platformIdentityId;
      delete prompt.context!.contactId;
      delete prompt.context!.platformIdentityId;
      prompt.source!.actorType = initiator === "agent" ? "agent" : "unknown";
      prompt.context!.actorType = prompt.source!.actorType;
      if (initiator === "agent") {
        prompt.source!.actorAgentId = AGENT.id;
        prompt.context!.actorAgentId = AGENT.id;
      }
      const parentTurn = buildTurn(fixture.parent, prompt);
      seedCreation(
        fixture.rootChatId,
        initiator === "missing_context" ? undefined : parentTurn.runtimeContext.contextId,
      );
      const transport = captureTransport();
      deliverRoot();
      await finalizeSlackThreadCreation(REQUEST_ID, transport.dependencies);
      const childTurn = buildPublishedTurn(transport.prompts[0]!);
      const deps = actorDeps(childTurn);

      expect(childTurn.runtimeContext.metadata?.actorPrincipal).toBe(`agent:${AGENT.id}`);
      expect(resolveAccessActor(deps).kind).toBe("refused");
      expect(unattributedTurnRefusal(deps.turn!.env, deps)).not.toBeNull();
      expect(turnActorContactId(deps.turn!.env, deps)).toBeNull();
    },
  );
});

type BuiltTurn = ReturnType<typeof buildRuntimeRequestContext>;
type PublishedPrompt = { sessionName: string; payload: RuntimeLaunchPrompt };

function seedRoot() {
  const parent = getOrCreateSession(ROOT_KEY, AGENT.id, AGENT.cwd, { name: ROOT_KEY, chatType: "channel" });
  const rootChat = dbUpsertChat({
    channel: "slack",
    instanceId: INSTANCE,
    platformChatId: CHANNEL,
    chatType: "channel",
    title: "Delegated actor fixture",
  });
  return { parent, rootChatId: rootChat.id };
}

function seedReadProfile() {
  dbUpdateAgent(AGENT.id, {
    defaults: { runtimePermissions: { profile: "explicit-only", capabilities: ["read:bases:list"] } },
  });
  dbCreateTagDefinition({
    slug: READ_PROFILE,
    label: "Thread read fixture",
    kind: "system",
    source: "permissions",
    metadata: { permissions: { capabilities: ["read:bases:list"] } },
  });
}

function seedReadGrant(contactId: string, chatId: string) {
  const grant = { contactId, profileSlug: READ_PROFILE, scopeType: "chat" as const, scopeId: chatId };
  dbEnsureContactChatGrant(grant);
  return grant;
}

function canReadBases(turn: BuiltTurn): boolean {
  return canWithCapabilities(turn.runtimeContext.capabilities, "read", "bases", "list");
}

function seedConsoleLogin(): string {
  // The real default request resolver reads this isolated file store. Never
  // resolve a host keychain entry or substitute the actor callback under test.
  process.env.RAVI_CLOUD_AUTH_BACKEND = "file";
  const accessToken = "fixture-access-token";
  const timestamp = new Date().toISOString();
  writeCloudCredentials({
    version: 1,
    consoleUrl: "https://console.example.test",
    installationId: "test_installation",
    accessToken,
    refreshToken: "fixture-refresh-token",
    accessTokenExpiresAt: null,
    scopes: ["console.bases.read", "console.bases.write"],
    user: { id: OWNER_USER },
    organization: { id: ORG },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return accessToken;
}

function seedPerson(slackUserId: string, consoleUserId: string) {
  const identity = ensureContactFromInbound({
    channel: "slack",
    instanceId: INSTANCE,
    platformSenderId: slackUserId,
    contactIdentity: slackUserId,
    displayName: "Fixture requester",
    chatId: CHANNEL,
    intakeMode: "discovered",
    source: "test",
  });
  if (!identity.contact || !identity.platformIdentity) throw new Error("Expected persisted Slack contact identity");
  updateContact(identity.contact.id, { status: "allowed" });
  writeCachedActorBinding({
    contactId: identity.contact.id,
    actorPrincipal: `contact:${identity.contact.id}`,
    consoleUserId,
    orgId: ORG,
    installationId: "test_installation",
    platformIdentity: { channel: "slack", platformIdentityId: identity.platformIdentity.id },
  });
  return {
    contactId: identity.contact.id,
    platformIdentityId: identity.platformIdentity.id,
    slackUserId,
    consoleUserId,
  };
}

function humanPrompt(rootChatId: string, person: ReturnType<typeof seedPerson>): RuntimeLaunchPrompt {
  const source = {
    channel: "slack",
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    chatId: CHANNEL,
    canonicalChatId: rootChatId,
    actorType: "contact" as const,
    contactId: person.contactId,
    platformIdentityId: person.platformIdentityId,
  };
  return {
    prompt: "Investigate the requested record in Bases",
    source,
    context: {
      ...source,
      channelId: "slack",
      channelName: "Slack",
      messageId: `message-${person.slackUserId}`,
      senderId: person.slackUserId,
      senderName: "Fixture requester",
      isGroup: true,
      groupName: "Delegated actor fixture",
      timestamp: Date.now(),
    },
  };
}

function turnOptions(session: SessionEntry, prompt: RuntimeLaunchPrompt) {
  return {
    dbSessionKey: session.sessionKey,
    sessionName: session.name ?? session.sessionKey,
    sessionCwd: AGENT.cwd,
    agent: AGENT,
    prompt,
    runtimeProviderId: "codex" as const,
    model: "gpt-6-astra",
    runtimeResolution,
    resolvedSource: prompt.source,
  };
}

function buildTurn(session: SessionEntry, prompt: RuntimeLaunchPrompt): BuiltTurn {
  return buildRuntimeRequestContext(turnOptions(session, prompt));
}

function rotateParent(turn: BuiltTurn, parent: SessionEntry, prompt: RuntimeLaunchPrompt) {
  refreshRuntimeRequestContextForTurn({
    ...turnOptions(parent, prompt),
    runtimeContext: turn.runtimeContext,
    toolContext: turn.toolContext,
    raviEnv: turn.raviEnv,
  });
}

function seedCreation(rootChatId: string, initiatorContextId?: string) {
  createSlackThreadLifecycle({
    requestId: REQUEST_ID,
    parentSessionKey: ROOT_KEY,
    parentSessionName: ROOT_KEY,
    initiatorSessionKey: ROOT_KEY,
    initiatorSessionName: ROOT_KEY,
    initiatorContextId,
    accountId: ACCOUNT,
    instanceId: INSTANCE,
    platformChatId: CHANNEL,
    rootCanonicalChatId: rootChatId,
    initialPrompt: "Investigate the requested record in Bases",
    requestedBy: "Fixture requester",
  });
}

function deliverRoot() {
  markSlackThreadRootDelivered({
    requestId: REQUEST_ID,
    providerThreadId: THREAD_TS,
    canonicalRootMessageId: "fixture-root-message",
  });
}

function captureTransport() {
  const prompts: PublishedPrompt[] = [];
  const dependencies: SlackThreadLifecycleDependencies = {
    publishPrompt: mock(async (sessionName: string, payload: Record<string, unknown>) => {
      // NATS transports JSON, not references to a live parent's ToolContext.
      prompts.push({ sessionName, payload: JSON.parse(JSON.stringify(payload)) as RuntimeLaunchPrompt });
    }),
    publishEvent: mock(async () => {}),
    publishOutbound: mock(async () => {}),
  };
  return { prompts, dependencies };
}

function enqueue(published: PublishedPrompt): PublishedPrompt {
  const queued = JSON.parse(JSON.stringify(createQueuedRuntimeUserMessage(published.payload))) as ReturnType<
    typeof createQueuedRuntimeUserMessage
  >;
  if (!queued.launchPrompt) throw new Error("Queued prompt lost its launch envelope");
  return { sessionName: published.sessionName, payload: queued.launchPrompt };
}

function buildPublishedTurn(published: PublishedPrompt): BuiltTurn {
  const child = getSession(`${ROOT_KEY}:thread:${THREAD_TS}`);
  if (!child) throw new Error("Lifecycle did not materialize its child session");
  expect(published.sessionName).toBe(child.name!);
  expect(published.payload.source?.actorType).toBe("agent");
  expect(classifyTurnProvenance({ prompt: published.payload }).origin).toBe("agent");
  return buildTurn(child, published.payload);
}

function sendFromParent(parent: SessionEntry, turn: BuiltTurn, dependencies: SlackThreadLifecycleDependencies) {
  return runWithContext(turn.toolContext, () =>
    sendSlackThreadMessage(
      { parentSession: parent, ref: REQUEST_ID, message: "Check the next record", origin: turn.toolContext },
      dependencies,
    ),
  );
}

function actorDeps(turn: BuiltTurn): AccessActorDeps {
  return {
    // The real resolver and persisted context are used; only the active login
    // is supplied locally, so these tests never access the host's credentials.
    readCredentials: () => null,
    turn: {
      env: { RAVI_CONTEXT_KEY: turn.runtimeContext.contextKey, RAVI_STATE_DIR: stateDir! },
      activeUserId: OWNER_USER,
      activeOrgId: ORG,
      ownerName: "Fixture operator",
    },
  };
}

function assertDelegatedContact(turn: BuiltTurn, contactId: string) {
  const deps = actorDeps(turn);
  expect(turn.runtimeContext.metadata?.actorPrincipal).toBe(`agent:${AGENT.id}`);
  expect(resolveAccessActor(deps)).toMatchObject({ kind: "contact", contactId, agent: { id: AGENT.id } });
  expect(unattributedTurnRefusal(deps.turn!.env, deps)).toBeNull();
  expect(turnActorContactId(deps.turn!.env, deps)).toBe(contactId);
}

function assertDenied(turn: BuiltTurn) {
  const deps = actorDeps(turn);
  expect(resolveAccessActor(deps).kind).toBe("refused");
  expect(unattributedTurnRefusal(deps.turn!.env, deps)).not.toBeNull();
  expect(turnActorContactId(deps.turn!.env, deps)).toBeNull();
}
