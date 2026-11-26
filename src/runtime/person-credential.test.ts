import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { accessActorFromTurn } from "../access/actor.js";
import { blockContact, createContact } from "../contacts.js";
import { resolveConnectorTurn } from "../link/connector-turn.js";
import { isActorBreakGlassLimitedContext, isRelayHeldBelowAgent } from "../permissions/actor-limit.js";
import { dbEnsureContactChatGrant } from "../permissions/contact-chat-grants.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
import type { AgentConfig } from "../router/index.js";
import { dbCreateAgent, dbUpdateAgent, dbUpsertChat } from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession } from "../router/sessions.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext, revokeRuntimeContext } from "./context-registry.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import {
  personCredentialContactId,
  personCredentialMetadata,
  resolvePersonCredentialCaller,
} from "./person-credential.js";
import { buildRuntimeRequestContext } from "./runtime-request-context.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";

const agent: AgentConfig = { id: "person-agent", cwd: "/tmp/person-agent" };
const sessionKey = "agent:person-agent:main";
const sessionName = "person-main";
const runtimeResolution: TaskRuntimeResolution = {
  options: {},
  sources: { model: null, effort: null, thinking: null },
  hasTaskRuntimeContext: false,
};

let stateDir: string | null = null;

/** A credential the operator issued for one person, as a paired device key is. */
function credentialFor(contactId: string, extra: { agentId?: string } = {}) {
  return createRuntimeContext({
    kind: "person-key",
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
    capabilities: [{ permission: "mutate", objectType: "voice", objectId: "*", source: "test" }],
    metadata: personCredentialMetadata(contactId),
    ttlMs: 60_000,
  });
}

/** The relay a surface publishes with that credential (the voice door does exactly this). */
function relayPrompt(credentialContextId: string): RuntimeLaunchPrompt {
  return {
    prompt: "[voice] apaga tudo",
    _cliDestination: true,
    _turnOrigin: buildSessionRelayTurnOrigin("send", { contextId: credentialContextId }),
  };
}

function turnFor(prompt: RuntimeLaunchPrompt) {
  return buildRuntimeRequestContext({
    dbSessionKey: sessionKey,
    sessionName,
    sessionCwd: agent.cwd,
    agent,
    prompt,
    runtimeProviderId: "codex",
    model: "gpt-5",
    runtimeResolution,
  }).runtimeContext;
}

function accessFor(turn: ReturnType<typeof turnFor>) {
  return accessActorFromTurn(
    resolveConnectorTurn({
      env: {},
      runtimeContext: { present: true, record: turn },
      activeUserId: "operator-user",
      activeOrgId: "test-org",
      ownerName: "Operator",
    }),
    { getAgentName: () => "Agent" },
  );
}

describe("person credentials", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-person-credential-");
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    dbUpdateAgent(agent.id, {
      defaults: {
        runtimePermissions: {
          capabilities: ["mutate:image:generate", "admin:system:*", "execute:executable:*"],
        },
      },
    });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("a person's relay is their turn: the agent without the break-glass they do not hold", () => {
    const stranger = createContact({ phone: "5511900000989", name: "Stranger" });
    const turn = turnFor(relayPrompt(credentialFor(stranger.id).contextId));

    expect(turn.metadata?.actorPrincipal).toBe(`contact:${stranger.id}`);
    expect(canWithCapabilities(turn.capabilities, "admin", "system", "*")).toBe(false);
    expect(canWithCapabilities(turn.capabilities, "execute", "executable", "rm")).toBe(false);
    expect(canWithCapabilities(turn.capabilities, "mutate", "image", "generate")).toBe(true);
    expect(turn.metadata?.actorBreakGlassWithheld).toEqual(["admin:system:*", "execute:executable:*"]);
    // Held: automation guards refuse what this turn would write with the agent's power.
    expect(isActorBreakGlassLimitedContext(turn)).toBe(true);
    // Never the operator: no owner connectors and no operator relay (the person
    // has no verified chat here, so access refuses rather than guess).
    const access = accessFor(turn);
    expect(access.kind).not.toBe("operator");
    expect(access).toMatchObject({ actorPrincipal: `contact:${stranger.id}` });
  });

  it("the owner's own credential keeps the agent's whole authority", () => {
    const owner = createContact({
      phone: "5511900000990",
      name: "Owner",
      tags: ["permission-owner"],
      status: "allowed",
    });
    const turn = turnFor(relayPrompt(credentialFor(owner.id).contextId));

    expect(turn.metadata?.actorPrincipal).toBe(`contact:${owner.id}`);
    expect(canWithCapabilities(turn.capabilities, "admin", "system", "*")).toBe(true);
    expect(canWithCapabilities(turn.capabilities, "execute", "executable", "rm")).toBe(true);
    expect(turn.metadata?.actorBreakGlassWithheld).toBeUndefined();
  });

  it("a person credential never lends owner authority, even the owner's (a guest can speak on it)", () => {
    // An agent with a closed list: the owner typing would act with their own power (owner authority),
    // but a turn produced with a credential (a paired device, a call) stays agent ∩ person.
    dbUpdateAgent(agent.id, {
      defaults: { runtimePermissions: { capabilities: ["execute:executable:git", "mutate:image:generate"] } },
    });
    const owner = createContact({
      phone: "5511900000994",
      name: "Owner",
      tags: ["permission-owner"],
      status: "allowed",
    });
    const turn = turnFor(relayPrompt(credentialFor(owner.id).contextId));

    expect(turn.metadata?.actorPrincipal).toBe(`contact:${owner.id}`);
    expect(turn.metadata?.ownerAuthority).toBeUndefined();
    expect(canWithCapabilities(turn.capabilities, "execute", "executable", "git")).toBe(true);
    expect(canWithCapabilities(turn.capabilities, "execute", "executable", "codex")).toBe(false);
  });

  it("applies the person's grants in the session's chat, as if they had typed there", () => {
    dbCreateTagDefinition({
      slug: "permission-image",
      label: "Image",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["mutate:image:generate", "mutate:mail:send"] } },
    });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "120363400000000989@g.us",
      chatType: "group",
      title: "Governed",
    });
    attachChatToSession({ sessionKey, chatId: chat.id, attachedByType: "system", attachedReason: "test" });
    const member = createContact({ phone: "5511900000991", name: "Member" });
    dbEnsureContactChatGrant({
      contactId: member.id,
      profileSlug: "permission-image",
      scopeType: "chat",
      scopeId: chat.id,
    });

    const turn = turnFor(relayPrompt(credentialFor(member.id).contextId));

    expect(turn.metadata?.actorPrincipal).toBe(`contact:${member.id}`);
    expect(canWithCapabilities(turn.capabilities, "mutate", "image", "generate")).toBe(true);
    expect(canWithCapabilities(turn.capabilities, "use", "tool", "Read")).toBe(false);
    expect(canWithCapabilities(turn.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("a revoked credential, or a blocked person, lends nothing at all", () => {
    const stranger = createContact({ phone: "5511900000992", name: "Gone" });
    const credential = credentialFor(stranger.id);
    revokeRuntimeContext(credential.contextId, { reason: "test" });
    const revoked = turnFor(relayPrompt(credential.contextId));
    expect(revoked.capabilities).toEqual([]);
    expect(isRelayHeldBelowAgent(revoked.metadata)).toBe(true);

    const blocked = createContact({ phone: "5511900000993", name: "Blocked" });
    const live = credentialFor(blocked.id);
    blockContact(blocked.id);
    expect(resolvePersonCredentialCaller(relayPrompt(live.contextId))?.usable).toBe(false);
    expect(turnFor(relayPrompt(live.contextId)).capabilities).toEqual([]);
  });

  it("only a key without an agent or session is a person credential", () => {
    const person = createContact({ phone: "5511900000994", name: "Person" });
    expect(personCredentialContactId(credentialFor(person.id))).toBe(person.id);
    // A key bound to an agent is that agent's work, whatever its metadata says.
    expect(personCredentialContactId(credentialFor(person.id, { agentId: agent.id }))).toBeNull();
    expect(
      personCredentialContactId({
        agentId: undefined,
        sessionKey: sessionKey,
        metadata: personCredentialMetadata("x"),
      }),
    ).toBeNull();
    expect(personCredentialContactId({ metadata: {} })).toBeNull();
  });
});
