import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { nats } from "../nats.js";
import { createContact, updateContact } from "../contacts.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
import { dbCreateAgent, dbGetContext, dbUpdateAgent, dbUpsertChat } from "../router/router-db.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import { dbDeleteContactChatGrant, dbEnsureContactChatGrant } from "../permissions/contact-chat-grants.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  issueRuntimeContext,
  resolveRuntimeContext,
  revokeRuntimeContext,
  revokeLiveRuntimeContextsForContactGrant,
  revokeAgentRuntimeContextsForSession,
} from "./context-registry.js";
import { isRuntimeContextLive } from "./context-liveness.js";
import { createRuntimeHostServices } from "./host-services.js";
import { shutdownRuntimeStreamingSession, type RuntimeHostStreamingSession } from "./host-session.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";
import {
  buildRuntimeRequestContext,
  refreshRuntimeRequestContextForTurn,
  startActiveRuntimeRequestContextLease,
  type RuntimeRequestContextOptions,
} from "./runtime-request-context.js";

const HOUR = 60 * 60 * 1000;
const READ = "use:tool:Read";
const WRITE = "use:tool:Write";
let stateDir: string | null = null;
let now = 0;
let active = true;
let abort: AbortController;
let stop: (() => void) | undefined;
const timers = new Set<() => void>();
let restoreMocks: (() => void)[] = [];

function options(prompt: RuntimeRequestContextOptions["prompt"] = { prompt: "Work" }): RuntimeRequestContextOptions {
  return {
    dbSessionKey: "agent:lease-test:main",
    sessionName: "lease-test",
    sessionCwd: "/tmp/lease-test",
    agent: { id: "lease-test", cwd: "/tmp/lease-test" },
    prompt,
    runtimeProviderId: "codex",
    model: "test-model",
    runtimeResolution: {
      options: {},
      sources: { model: null, effort: null, thinking: null },
      hasTaskRuntimeContext: false,
    },
    resolvedSource: prompt.source,
  };
}

function setCapabilities(capabilities: string[]) {
  dbUpdateAgent("lease-test", { defaults: { runtimePermissions: { profile: "explicit-only", capabilities } } });
}

function start(input = options()) {
  const request = buildRuntimeRequestContext(input);
  stop = startActiveRuntimeRequestContextLease({
    ...input,
    runtimeContext: request.runtimeContext,
    isActive: () => active,
    signal: abort.signal,
  });
  return request;
}

function advance(ms: number) {
  now += ms;
  for (const heartbeat of [...timers]) heartbeat();
}

beforeEach(async () => {
  const emit = spyOn(nats, "emit").mockResolvedValue(undefined);
  stateDir = await createIsolatedRaviState("ravi-context-active-lease-");
  dbCreateAgent({ id: "lease-test", cwd: "/tmp/lease-test" });
  getOrCreateSession("agent:lease-test:main", "lease-test", "/tmp/lease-test", { name: "lease-test" });
  setCapabilities([READ]);
  active = true;
  abort = new AbortController();
  now = Date.now();
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const schedule = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    timers.add(callback);
    return { unref() {}, callback };
  }) as unknown as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((timer: { callback: () => void }) => {
    timers.delete(timer.callback);
  }) as unknown as typeof clearInterval);
  restoreMocks = [
    () => date.mockRestore(),
    () => schedule.mockRestore(),
    () => clear.mockRestore(),
    () => emit.mockRestore(),
  ];
});

afterEach(async () => {
  stop?.();
  stop = undefined;
  for (const restore of restoreMocks) restore();
  timers.clear();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("active runtime context lifetime", () => {
  it("replaces a completed turn snapshot so retained host services authorize the next turn", async () => {
    const contact = createContact({ phone: "rotation-actor@example.test", status: "allowed" });
    const input = options({
      prompt: "first turn",
      source: {
        channel: "slack",
        accountId: "test",
        chatId: "first-chat",
        actorType: "contact",
        contactId: contact.id,
      },
    });
    const request = start(input);
    const retained = request.runtimeContext;
    const host = createRuntimeHostServices({
      context: retained,
      agentId: input.agent.id,
      sessionName: input.sessionName,
      toolContext: request.toolContext,
    });
    const read = { permission: "use", objectType: "tool", objectId: "Read" };
    expect((await host.authorizeCapability(read)).allowed).toBe(true);
    stop?.();
    expect((await host.authorizeCapability(read)).allowed).toBe(false);

    const next = refreshRuntimeRequestContextForTurn({ ...options(), ...request });
    expect(next).toBe(retained);
    expect(resolveRuntimeContext(next.contextKey, { touch: false })).not.toBeNull();
    // Resolving the new key alone misses stale fields on the object retained by host tools.
    expect((await host.authorizeCapability(read)).allowed).toBe(true);
    expect(isRuntimeContextLive(retained)).toBe(true);
    expect(retained.revokedAt).toBeUndefined();
    expect(retained.source).toBeUndefined();
    expect(retained).toEqual(dbGetContext(next.contextId)!);
  });

  it("keeps a working turn authorized beyond an hour with the same key and capabilities", () => {
    const { runtimeContext: context } = start();
    const issued = structuredClone(context);
    expect(context.expiresAt! - context.createdAt).toBe(HOUR);
    advance(30 * 60 * 1000);
    advance(30 * 60 * 1000);
    advance(30 * 60 * 1000);
    const resolved = resolveRuntimeContext(issued.contextKey, { touch: false });
    expect(resolved).not.toBeNull();
    expect(resolved?.contextId).toBe(issued.contextId);
    expect(resolved?.capabilities).toEqual(issued.capabilities);
    expect(context.expiresAt).toBe(resolved?.expiresAt);
    expect(isRuntimeContextLive(context)).toBe(true);
    expect(resolveRuntimeContext(issued.contextKey, { readOnly: true })?.expiresAt).toBe(resolved?.expiresAt);
    expect(resolved!.expiresAt! - now).toBeLessThanOrEqual(HOUR);
    expect(resolved?.metadata?.actorPrincipal).toBe(issued.metadata?.actorPrincipal);
  });

  it("never adds a newly granted capability to an active turn", () => {
    const { runtimeContext: context } = start();
    const issued = structuredClone(context.capabilities);
    setCapabilities([READ, WRITE]);
    advance(30 * 60 * 1000);
    advance(31 * 60 * 1000);
    const resolved = resolveRuntimeContext(context.contextKey, { touch: false });
    expect(resolved).not.toBeNull();
    expect(resolved?.capabilities).toEqual(issued);
    expect(canWithCapabilities(resolved!.capabilities, "use", "tool", "Write")).toBe(false);
  });

  it("keeps an existing wildcard when a new redundant grant is added", () => {
    setCapabilities(["use:tool:*"]);
    const { runtimeContext: context } = start();
    const issued = structuredClone(context.capabilities);
    setCapabilities(["use:tool:*", READ]);
    advance(30 * 60 * 1000);
    advance(31 * 60 * 1000);
    expect(resolveRuntimeContext(context.contextKey, { touch: false })?.capabilities).toEqual(issued);
  });

  it("does not extend a narrowed relay beyond its original lease after the caller's grant is removed", () => {
    const contact = createContact({ phone: "relay-actor@example.test", status: "allowed" });
    const chat = dbUpsertChat({
      channel: "slack",
      instanceId: "test",
      platformChatId: "relay-chat",
      chatType: "group",
    });
    dbCreateTagDefinition({
      slug: "permission-lease-read",
      label: "Read",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: [READ] } },
    });
    const grant = {
      contactId: contact.id,
      profileSlug: "permission-lease-read",
      scopeType: "chat" as const,
      scopeId: chat.id,
    };
    dbEnsureContactChatGrant(grant);
    const callerInput = options({
      prompt: "first",
      source: {
        channel: "slack",
        accountId: "test",
        chatId: "relay-chat",
        canonicalChatId: chat.id,
        actorType: "contact",
        contactId: contact.id,
      },
    });
    const caller = buildRuntimeRequestContext(callerInput).runtimeContext;
    expect(caller.metadata?.actorAuthorizationMode).toBe("user-overlay");
    buildRuntimeRequestContext(callerInput); // ordinary rotation leaves queued relays usable
    expect(resolveRuntimeContext(caller.contextKey, { touch: false })).toBeNull();
    const { runtimeContext: relay } = start(
      options({
        prompt: "relay",
        _turnOrigin: buildSessionRelayTurnOrigin("inform", {
          agentId: caller.agentId!,
          contextId: caller.contextId,
          sessionKey: caller.sessionKey!,
          sessionName: caller.sessionName!,
        }),
      }),
    );
    expect(relay.metadata?.relayNarrowing).toBe(true);
    const originalExpiry = relay.expiresAt;
    dbDeleteContactChatGrant(grant);
    revokeLiveRuntimeContextsForContactGrant(contact.id, `permission-lease-read@chat:${chat.id}`);
    advance(30 * 60 * 1000);
    expect(dbGetContext(relay.contextId)?.expiresAt).toBe(originalExpiry);
    advance(31 * 60 * 1000);
    expect(resolveRuntimeContext(relay.contextKey, { touch: false })).toBeNull();
  });

  it("revokes the context and descendants when the live executor ceiling shrinks", () => {
    const { runtimeContext: context } = start();
    const child = issueRuntimeContext({ parent: context, cliName: "worker", inheritCapabilities: true });
    setCapabilities([]);
    advance(1 * 60 * 1000);
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(dbGetContext(context.contextId)?.revokedAt).toBe(now);
    expect(timers.size).toBe(0);
  });

  it("cannot renew a revoked or already expired context", () => {
    const { runtimeContext: context } = start();
    revokeRuntimeContext(context.contextId);
    advance(60 * 1000);
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    stop?.();
    const { runtimeContext: expired } = start();
    const expiry = expired.expiresAt;
    advance(HOUR + 1);
    expect(resolveRuntimeContext(expired.contextKey, { touch: false })).toBeNull();
    expect(dbGetContext(expired.contextId)?.expiresAt).toBe(expiry);
    expect(timers.size).toBe(0);
  });

  it("stops immediately at the turn boundary and abort, without extending children", () => {
    const { runtimeContext: context } = start();
    const child = issueRuntimeContext({ parent: context, cliName: "worker", inheritCapabilities: true });
    const childExpiry = child.expiresAt;
    advance(30 * 60 * 1000);
    expect(dbGetContext(child.contextId)?.expiresAt).toBe(childExpiry);
    stop?.();
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(timers.size).toBe(0);
    const { runtimeContext: next } = start();
    abort.abort();
    expect(resolveRuntimeContext(next.contextKey, { touch: false })).toBeNull();
    expect(timers.size).toBe(0);
  });

  it("cascades revocation through real shutdown before the terminal callback releases the lease", () => {
    const { runtimeContext: context } = start();
    const child = issueRuntimeContext({ parent: context, cliName: "worker", inheritCapabilities: true });
    const streaming = {
      abortController: abort,
      queryHandle: { interrupt: async () => {} },
      onTurnComplete: () => stop?.(),
    } as unknown as RuntimeHostStreamingSession;
    shutdownRuntimeStreamingSession(streaming, "explicit_abort");
    expect(abort.signal.aborted).toBe(true);
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(timers.size).toBe(0);
  });

  it("revokes surviving child credentials on a session reset after normal completion", () => {
    const { runtimeContext: context } = start();
    const child = issueRuntimeContext({ parent: context, cliName: "worker", inheritCapabilities: true });
    const grandchild = issueRuntimeContext({ parent: child, cliName: "nested", inheritCapabilities: true });
    const otherInput = { ...options(), dbSessionKey: "agent:lease-test:other", sessionName: "lease-other" };
    getOrCreateSession(otherInput.dbSessionKey, otherInput.agent.id, otherInput.sessionCwd, {
      name: otherInput.sessionName,
    });
    const other = buildRuntimeRequestContext(otherInput).runtimeContext;
    stop?.();
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).not.toBeNull();
    // Ordinary launch/rotation preserves independent child TTLs.
    revokeAgentRuntimeContextsForSession(context.sessionKey!, {
      cascade: false,
      reason: "stale_turn_context_reclaimed",
    });
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).not.toBeNull();
    revokeAgentRuntimeContextsForSession(context.sessionKey!, { reason: "session_reset_test" });
    expect(resolveRuntimeContext(child.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(grandchild.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(other.contextKey, { touch: false })).not.toBeNull();
  });

  it("does not let an old lease renew or revoke the next turn after rotation", () => {
    const input = options();
    const request = start(input);
    const previous = structuredClone(request.runtimeContext);
    const next = refreshRuntimeRequestContextForTurn({ ...input, ...request });
    advance(60 * 1000);
    expect(resolveRuntimeContext(previous.contextKey, { touch: false })).toBeNull();
    expect(resolveRuntimeContext(next.contextKey, { touch: false })?.contextId).toBe(next.contextId);
    expect(timers.size).toBe(0);
  });

  it("does not extend an idle credential just because a caller keeps touching it", () => {
    const { runtimeContext: context } = buildRuntimeRequestContext(options());
    const expiresAt = context.expiresAt;
    advance(30 * 60 * 1000);
    expect(resolveRuntimeContext(context.contextKey)?.lastUsedAt).toBe(now);
    expect(dbGetContext(context.contextId)?.expiresAt).toBe(expiresAt);
    advance(31 * 60 * 1000);
    expect(resolveRuntimeContext(context.contextKey)).toBeNull();
  });

  it("does not keep a finished owner alive merely because its context is being used", () => {
    const { runtimeContext: context } = start();
    active = false;
    advance(60 * 1000);
    expect(resolveRuntimeContext(context.contextKey)).toBeNull();
    expect(timers.size).toBe(0);
  });

  it("revalidates a human actor before renewal even outside a governed chat", () => {
    const contact = createContact({ phone: "contact-lease@example.test", status: "allowed" });
    const { runtimeContext: context } = start(
      options({
        prompt: "Work",
        source: { channel: "slack", accountId: "test", chatId: "test", actorType: "contact", contactId: contact.id },
      }),
    );
    updateContact(contact.id, { status: "blocked" });
    advance(60 * 1000);
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();
  });
});
