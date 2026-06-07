import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { grantRelation } from "../permissions/relations.js";
import { canWithCapabilities } from "../permissions/engine.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbGetContext } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import type { AgentConfig } from "../router/index.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeRequestContext, refreshRuntimeRequestContextForTurn } from "./runtime-request-context.js";
import { getRuntimeToolAccessMode } from "./host-services.js";

let stateDir: string | null = null;
let previousTurnScopedAuthority: string | undefined;

const agent: AgentConfig = {
  id: "rebac-agent",
  cwd: "/tmp/rebac-agent",
};
const sessionKey = "agent:rebac-agent:whatsapp:group:chat_group_1";
const sessionName = "rebac-group";

const runtimeResolution: TaskRuntimeResolution = {
  options: {},
  sources: {
    model: null,
    effort: null,
    thinking: null,
  },
  hasTaskRuntimeContext: false,
};

describe("runtime request context authority", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-authority-test-");
    previousTurnScopedAuthority = process.env.RAVI_TURN_SCOPED_AUTHORITY;
    process.env.RAVI_TURN_SCOPED_AUTHORITY = "1";
  });

  afterEach(async () => {
    if (previousTurnScopedAuthority === undefined) {
      delete process.env.RAVI_TURN_SCOPED_AUTHORITY;
    } else {
      process.env.RAVI_TURN_SCOPED_AUTHORITY = previousTurnScopedAuthority;
    }
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates and refreshes turn-runtime authority from agent, contact and chat grants", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    grantRelation("agent", agent.id, "admin", "system", "*");
    grantRelation("contact", "luis", "use", "tool", "Read");
    grantRelation("contact", "ana", "use", "tool", "Bash");
    grantRelation("chat", "chat_group_1", "use", "tool", "*");

    const initialPrompt = promptForContact("luis", "read");
    const source = initialPrompt.source!;
    const { runtimeContext, toolContext, raviEnv } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/rebac-agent",
      agent,
      prompt: initialPrompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: source,
    });
    const runtimeEnv: Record<string, string> = { ...raviEnv, RAVI_TASK_ID: "stale-task" };

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(
      getRuntimeToolAccessMode({} as Parameters<typeof getRuntimeToolAccessMode>[0], agent.id, runtimeContext),
    ).toBe("restricted");
    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:luis",
      surfacePrincipal: "chat:chat_group_1",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);

    const initialContextId = runtimeContext.contextId;
    const nextPrompt = promptForContact("ana", "run");
    const refreshed = refreshRuntimeRequestContextForTurn({
      runtimeContext,
      toolContext,
      runtimeEnv,
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/rebac-agent",
      agent,
      prompt: nextPrompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: nextPrompt.source,
    });

    expect(refreshed).toBe(runtimeContext);
    expect(runtimeContext.contextId).not.toBe(initialContextId);
    expect(dbGetContext(initialContextId)?.revokedAt).toBeNumber();
    expect(toolContext.contextId).toBe(runtimeContext.contextId);
    expect(toolContext.context).toBe(runtimeContext);
    expect(runtimeEnv.RAVI_CONTEXT_KEY).toBe(runtimeContext.contextKey);
    expect(runtimeEnv.RAVI_CONTACT_ID).toBe("ana");
    expect(runtimeEnv.RAVI_ACTOR_TYPE).toBe("contact");
    expect(runtimeEnv.RAVI_TASK_ID).toBeUndefined();
    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:ana",
      surfacePrincipal: "chat:chat_group_1",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
  });

  it("fails closed for external prompts without a resolved contact actor", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    grantRelation("agent", agent.id, "admin", "system", "*");
    grantRelation("chat", "chat_group_1", "use", "tool", "*");

    const prompt = promptForContact("", "unknown");
    delete prompt.source!.contactId;
    delete prompt.context!.contactId;
    prompt.source!.actorType = "unknown";
    prompt.context!.actorType = "unknown";

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/rebac-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "unknown",
      actorResolution: "missing_contact",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });
});

function promptForContact(contactId: string, text: string): RuntimeLaunchPrompt {
  return {
    prompt: text,
    source: {
      channel: "whatsapp",
      accountId: "main",
      chatId: "120363428243036323@g.us",
      canonicalChatId: "chat_group_1",
      actorType: "contact",
      contactId,
    },
    context: {
      channelId: "whatsapp",
      channelName: "WhatsApp",
      accountId: "main",
      chatId: "120363428243036323@g.us",
      canonicalChatId: "chat_group_1",
      messageId: `msg_${contactId}`,
      senderId: contactId,
      isGroup: true,
      timestamp: 1000,
      actorType: "contact",
      contactId,
    },
  };
}
