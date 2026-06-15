import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { grantRelation } from "../permissions/relations.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
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
  id: "provider-agent",
  cwd: "/tmp/provider-agent",
};
const sessionKey = "agent:provider-agent:whatsapp:group:chat_group_1";
const sessionName = "provider-group";

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

  it("uses turn-scoped authority by default when the env var is unset", () => {
    delete process.env.RAVI_TURN_SCOPED_AUTHORITY;
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("luis", "read");
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(runtimeContext.metadata?.authorityMode).toBe("delegated");
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
  });

  it("does not bootstrap actor or surface capabilities into delegated contact turns", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("luis", "audit");
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:luis",
      surfacePrincipal: "chat:chat_group_1",
    });
    expect(runtimeContext.metadata?.actorCapabilityCount).toBe(0);
    expect(runtimeContext.metadata?.surfaceCapabilityCount).toBe(0);
    expect(runtimeContext.metadata?.effectiveCapabilityCount).toBe(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "group", "context_codex-bash-hook")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "group", "sessions_info")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "access", "session", "main")).toBe(false);
  });

  it("ignores relation-store role grants in the default executor ceiling", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    grantRelation("agent", agent.id, "member", "role", "audit-agent");
    grantRelation("role", "audit-agent", "access", "session", "restricted");

    const prompt = promptForContact("luis", "audit");
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:luis",
    });
    expect(runtimeContext.metadata?.actorCapabilityCount).toBe(0);
    expect(runtimeContext.metadata?.effectiveCapabilityCount).toBe(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "group", "sessions_info")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "access", "session", "restricted")).toBe(false);
  });

  it("stores observation permission grants as turn capabilities for live delegated rechecks", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("luis", "observe");
    prompt._observation = {
      sourceSessionKey: "source-session",
      sourceSessionName: "source",
      bindingId: "binding-1",
      ruleId: "rule-1",
      role: "observer",
      mode: "observe",
      permissionGrants: ["execute:group:observer_report"],
      eventIds: ["event-1"],
    };
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      turnCapabilityCount: 1,
      turnCapabilities: [
        {
          permission: "execute",
          objectType: "group",
          objectId: "observer_report",
          source: "observer-rule",
        },
      ],
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "group", "observer_report")).toBe(false);
  });

  it("keeps relation-store denies out of default runtime materialization", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    grantRelation("chat", "chat_group_1", "deny_execute", "group", "sessions_info");

    const prompt = promptForContact("luis", "audit");
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:luis",
      surfacePrincipal: "chat:chat_group_1",
    });
    expect(runtimeContext.metadata?.surfaceCapabilityCount).toBe(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "group", "sessions_info")).toBe(false);
  });

  it("creates and refreshes turn-runtime authority from provider materialization", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const initialPrompt = promptForContact("luis", "read");
    const source = initialPrompt.source!;
    const { runtimeContext, toolContext, raviEnv } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt: initialPrompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: source,
    });
    const runtimeEnv: Record<string, string> = {
      ...raviEnv,
      RAVI_TASK_ID: "stale-task",
    };

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(
      getRuntimeToolAccessMode({} as Parameters<typeof getRuntimeToolAccessMode>[0], agent.id, runtimeContext),
    ).toBe("restricted");
    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:luis",
      actorDisplayName: "Luís",
      surfacePrincipal: "chat:chat_group_1",
      surfaceDisplayName: "Ravi Dev",
      actor: {
        actorType: "contact",
        contactId: "luis",
        canonicalChatId: "chat_group_1",
        chatId: "120363428243036323@g.us",
        senderName: "Luís",
        groupName: "Ravi Dev",
      },
      actorMetadata: {
        actorType: "contact",
        contactId: "luis",
        senderName: "Luís",
        groupName: "Ravi Dev",
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);

    const initialContextId = runtimeContext.contextId;
    const nextPrompt = promptForContact("ana", "run");
    const refreshed = refreshRuntimeRequestContextForTurn({
      runtimeContext,
      toolContext,
      runtimeEnv,
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
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
      actorDisplayName: "Ana",
      surfacePrincipal: "chat:chat_group_1",
      surfaceDisplayName: "Ravi Dev",
      actor: {
        actorType: "contact",
        contactId: "ana",
        canonicalChatId: "chat_group_1",
        senderName: "Ana",
        groupName: "Ravi Dev",
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
  });

  it("fails closed for external prompts without a resolved contact actor", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("", "unknown");
    delete prompt.source!.contactId;
    delete prompt.context!.contactId;
    prompt.source!.actorType = "unknown";
    prompt.context!.actorType = "unknown";

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
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
      actorDisplayName: "Desconhecido",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("does not materialize relation-store chat delegation overrides by default", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    grantRelation("agent", agent.id, "use", "tool", "Bash");
    grantRelation("chat", "chat_group_1", "delegate_use", "tool", "Bash");

    const prompt = promptForContact("luis", "run bash");
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
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
      actorPrincipal: "contact:luis",
      surfacePrincipal: "chat:chat_group_1",
      actorOverrideCapabilityCount: 0,
      surfaceOverrideCapabilityCount: 0,
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
  });

  it("does not materialize relation-store agent delegation overrides by default", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    grantRelation("agent", agent.id, "use", "tool", "Bash");
    grantRelation("agent", agent.id, "delegate_use", "tool", "Bash");

    const prompt = promptForContact("luis", "run bash");
    const denied = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    }).runtimeContext;

    expect(denied.metadata).toMatchObject({
      actorOverrideCapabilityCount: 0,
      surfaceOverrideCapabilityCount: 0,
    });
    expect(canWithCapabilities(denied.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(denied.capabilities, "access", "session", "restricted")).toBe(false);

    grantRelation("chat", "chat_group_1", "use", "tool", "*");
    const allowed = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    }).runtimeContext;

    expect(canWithCapabilities(allowed.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(allowed.capabilities, "use", "tool", "Read")).toBe(false);
  });

  it("runs cron prompts as automation principals instead of inheriting agent authority", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt: RuntimeLaunchPrompt = {
      prompt: "[Cron: audit] run",
      _cron: true,
      _jobId: "job-1",
    };

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
    });

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "automation:cron:job-1",
      actorResolution: "resolved",
      actor: {
        actorType: "automation",
        automationId: "cron:job-1",
        identityProvenance: { source: "cron", jobId: "job-1" },
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("runs session followup prompts as automation principals with their delivery surface", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt: RuntimeLaunchPrompt = {
      prompt: "[Session Followup: audit] run",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363428243036323@g.us",
        canonicalChatId: "chat_group_1",
        actorType: "automation",
        automationId: "session-followup:cadence-1",
        identityProvenance: { source: "session-followup", cadenceId: "cadence-1", runId: "run-1" },
      },
      _sessionFollowup: true,
      _sessionFollowupCadenceId: "cadence-1",
      _sessionFollowupRunId: "run-1",
    };

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "automation:session-followup",
      actorResolution: "resolved",
      surfacePrincipal: "chat:chat_group_1",
      actor: {
        actorType: "automation",
        automationId: "session-followup",
        identityProvenance: { source: "session-followup", cadenceId: "cadence-1", runId: "run-1" },
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("runs daemon restart resume prompts as automation principals with their delivery surface", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt: RuntimeLaunchPrompt = {
      prompt: "[System] Daemon reiniciou (test). Continue de onde parou.",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363428243036323@g.us",
        canonicalChatId: "chat_group_1",
      },
      _daemonRestartResume: {
        restartEpoch: "restart-test",
        sessionKey,
      },
    };

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "automation:daemon-restart",
      actorResolution: "resolved",
      surfacePrincipal: "chat:chat_group_1",
      actor: {
        actorType: "automation",
        automationId: "daemon-restart",
        canonicalChatId: "chat_group_1",
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("preserves the contact principal for daemon restart resume prompts with a human snapshot source", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const source = promptForContact("luis", "original user request").source;
    const prompt: RuntimeLaunchPrompt = {
      prompt: "[System] Daemon reiniciou (test). Continue de onde parou.",
      source,
      _daemonRestartResume: {
        restartEpoch: "restart-test",
        sessionKey,
      },
    };

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: prompt.source,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "delegated",
      actorPrincipal: "contact:luis",
      actorResolution: "resolved",
      surfacePrincipal: "chat:chat_group_1",
      actor: {
        actorType: "contact",
        contactId: "luis",
        canonicalChatId: "chat_group_1",
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("runs trigger automation prompts with bootstrap capabilities but without system admin", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt: {
        prompt: "[Trigger: audit] run",
        _trigger: true,
        _triggerId: "trigger-1",
      },
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
    });

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(runtimeContext.metadata?.actorPrincipal).toBe("automation:trigger:trigger-1");
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });
});

function promptForContact(contactId: string, text: string): RuntimeLaunchPrompt {
  const senderName = contactId === "ana" ? "Ana" : contactId ? "Luís" : "Desconhecido";
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
      senderName,
      isGroup: true,
      groupName: "Ravi Dev",
      timestamp: 1000,
      actorType: "contact",
      contactId,
    },
  };
}
