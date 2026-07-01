import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact } from "../contacts.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbGetContext, dbUpdateAgent } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { dbCreateTask, dbDispatchTask } from "../tasks/task-db.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import type { AgentConfig } from "../router/index.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeRequestContext, refreshRuntimeRequestContextForTurn } from "./runtime-request-context.js";
import { getRuntimeToolAccessMode } from "./host-services.js";

let stateDir: string | null = null;

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
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("uses agent identity authority by default when the env var is unset", () => {
    const previous = process.env.RAVI_TURN_SCOPED_AUTHORITY;
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
    expect(runtimeContext.metadata?.authorityMode).toBe("agent-identity");
    expect(runtimeContext.metadata?.agentIdentityPrincipal).toBe("agent_identity:provider-agent:chat:chat_group_1");
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    if (previous === undefined) {
      delete process.env.RAVI_TURN_SCOPED_AUTHORITY;
    } else {
      process.env.RAVI_TURN_SCOPED_AUTHORITY = previous;
    }
  });

  it("ignores the retired turn-scoped env flag and still issues workspace agent identity contexts", () => {
    const previous = process.env.RAVI_TURN_SCOPED_AUTHORITY;
    process.env.RAVI_TURN_SCOPED_AUTHORITY = "0";
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt: { prompt: "internal task without a channel surface" },
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
    });

    expect(runtimeContext.kind).toBe("turn-runtime");
    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "agent-identity",
      actorPrincipal: "unknown",
      actorResolution: "not_applicable",
      agentIdentityPrincipal: "agent_identity:provider-agent:workspace:default",
      agentIdentityCompartment: "workspace:default",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
    if (previous === undefined) {
      delete process.env.RAVI_TURN_SCOPED_AUTHORITY;
    } else {
      process.env.RAVI_TURN_SCOPED_AUTHORITY = previous;
    }
  });

  it("keeps actor and surface as audit-only branches in agent identity turns", () => {
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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:luis",
      actorAuthorizationMode: "invoke-only",
      surfacePrincipal: "chat:chat_group_1",
      surfaceAuthorizationMode: "compartment",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
      agentIdentityCompartment: "chat:chat_group_1",
    });
    expect(runtimeContext.metadata?.actorCapabilityCount).toBe(0);
    expect(runtimeContext.metadata?.surfaceCapabilityCount).toBe(0);
    expect(runtimeContext.metadata?.effectiveCapabilityCount).toBeGreaterThan(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "context", "codex-bash-hook")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "info")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "access", "session", "main")).toBe(false);
  });

  it("does not materialize role authority without a provider-owned runtime config", () => {
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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:luis",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
    });
    expect(runtimeContext.metadata?.actorCapabilityCount).toBe(0);
    expect(runtimeContext.metadata?.effectiveCapabilityCount).toBeGreaterThan(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "info")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "access", "session", "restricted")).toBe(false);
  });

  it("records observation permission grants as turn metadata without widening agent identity authority", () => {
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
      permissionGrants: ["mutate:tasks:report"],
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
      authorityMode: "agent-identity",
      turnCapabilityCount: 1,
      turnCapabilities: [
        {
          permission: "mutate",
          objectType: "tasks",
          objectId: "report",
          source: "observer-rule",
        },
      ],
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "tasks", "report")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "trace")).toBe(false);
  });

  it("expands observer CLI shortcuts to tool and semantic command capabilities only", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("luis", "observe");
    prompt._observation = {
      sourceSessionKey: "source-session",
      sourceSessionName: "source",
      bindingId: "binding-1",
      ruleId: "rule-1",
      role: "observer",
      mode: "report",
      permissionGrants: ["execute:group:tasks", "tasks.report"],
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
      authorityMode: "agent-identity",
      turnCapabilityCount: 2,
      turnCapabilities: [
        {
          permission: "use",
          objectType: "tool",
          objectId: "tasks_report",
          source: "observer-rule",
        },
        {
          permission: "mutate",
          objectType: "tasks",
          objectId: "report",
          source: "observer-rule",
        },
      ],
    });
    expect(
      (runtimeContext.metadata?.turnCapabilities as Array<{ permission: string; objectType: string }>).some(
        (capability) => capability.permission === "execute" && capability.objectType === "group",
      ),
    ).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "tasks", "report")).toBe(false);
  });

  it("expands observation CLI shortcuts to tool and semantic command capabilities", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("luis", "observe");
    prompt._observation = {
      sourceSessionKey: "source-session",
      sourceSessionName: "source",
      bindingId: "binding-1",
      ruleId: "rule-1",
      role: "observer",
      mode: "report",
      permissionGrants: ["tasks.report"],
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
      turnCapabilityCount: 2,
      turnCapabilities: [
        {
          permission: "use",
          objectType: "tool",
          objectId: "tasks_report",
          source: "observer-rule",
        },
        {
          permission: "mutate",
          objectType: "tasks",
          objectId: "report",
          source: "observer-rule",
        },
      ],
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "tasks_report")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "tasks", "report")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "group", "tasks_report")).toBe(false);
  });

  it("does not let turn permission grants widen agent identity authority", () => {
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
      permissionGrants: ["execute:executable:curl"],
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
      authorityMode: "agent-identity",
      turnCapabilityCount: 1,
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "executable", "curl")).toBe(false);
  });

  it("adds task-scoped self capabilities for the active task session only", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    const ownTask = dbCreateTask({
      title: "Own Task",
      instructions: "Report from the assigned runtime session",
      createdBy: "test",
      createdByAgentId: agent.id,
      createdBySessionName: "launcher",
    }).task;
    const otherTask = dbCreateTask({
      title: "Other Task",
      instructions: "Must remain isolated",
      createdBy: "test",
      createdByAgentId: agent.id,
      createdBySessionName: "launcher",
    }).task;
    dbDispatchTask(ownTask.id, {
      agentId: agent.id,
      sessionName,
      assignedBy: "test",
    });

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt: {
        prompt: "Report progress",
        taskBarrierTaskId: ownTask.id,
      },
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "agent-identity",
      taskSelfCapabilityCount: 2,
      taskSelfTaskId: ownTask.id,
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "task", ownTask.id)).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "task", ownTask.id)).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "task", otherTask.id)).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "tasks", "report")).toBe(false);
  });

  it("allows turn permission grants when the agent identity already has the capability", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    dbUpdateAgent(agent.id, {
      defaults: {
        runtimePermissions: {
          capabilities: ["execute:executable:curl", "read:sessions:info"],
        },
      },
    });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

    const prompt = promptForContact("luis", "observe");
    prompt._observation = {
      sourceSessionKey: "source-session",
      sourceSessionName: "source",
      bindingId: "binding-1",
      ruleId: "rule-1",
      role: "observer",
      mode: "observe",
      permissionGrants: ["execute:executable:curl"],
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

    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "executable", "curl")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "info")).toBe(false);
  });

  it("does not block an agent identity turn just because the surface has no capability policy", () => {
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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:luis",
      surfacePrincipal: "chat:chat_group_1",
    });
    expect(runtimeContext.metadata?.surfaceCapabilityCount).toBe(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "info")).toBe(true);
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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:luis",
      actorDisplayName: "Luís",
      surfacePrincipal: "chat:chat_group_1",
      surfaceDisplayName: "Ravi Dev",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
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
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);

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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:ana",
      actorDisplayName: "Ana",
      surfacePrincipal: "chat:chat_group_1",
      surfaceDisplayName: "Ravi Dev",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
      actor: {
        actorType: "contact",
        contactId: "ana",
        canonicalChatId: "chat_group_1",
        senderName: "Ana",
        groupName: "Ravi Dev",
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
  });

  it("adds self-scoped task capabilities only for the active task binding", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    const created = dbCreateTask({
      title: "Self-scoped task permissions",
      instructions: "The task worker may report only its own task.",
      createdBy: "test",
      createdByAgentId: agent.id,
      createdBySessionName: sessionName,
    });
    dbDispatchTask(created.task.id, {
      agentId: agent.id,
      sessionName,
      assignedBy: "test",
    });

    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: sessionKey,
      sessionName,
      sessionCwd: "/tmp/provider-agent",
      agent,
      prompt: {
        prompt: "work on the active task",
        taskBarrierTaskId: created.task.id,
      },
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
    });

    expect(runtimeContext.metadata).toMatchObject({
      authorityMode: "agent-identity",
      taskSelfCapabilityCount: 2,
      taskSelfTaskId: created.task.id,
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "task", created.task.id)).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "task", created.task.id)).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "task", "task-other")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "tasks", "report")).toBe(false);
  });

  it("does not require admin-tagged contact authority for agent identity group turns", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    const owner = createContact({
      phone: "5511988887777",
      name: "Owner",
      tags: ["permission.admin"],
      status: "allowed",
    });

    const prompt = promptForContact(owner.id, "publish page");
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
      authorityMode: "agent-identity",
      actorPrincipal: `contact:${owner.id}`,
      actorCapabilityCount: 0,
      surfaceCapabilityCount: 0,
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "info")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "pages", "*")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "sessions", "trace")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("materializes image authority from the agent identity instead of the contact tag", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    dbCreateTagDefinition({
      slug: "permission-family",
      label: "Family Image",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: [
            "mutate:image:generate",
            "use:tool:image_generate",
            "use:tool:Bash",
            "execute:executable:ravi",
            "read:skills:show",
            "read:context:codex-bash-hook",
            "read:sessions:actions",
          ],
        },
      },
    });
    dbUpdateAgent(agent.id, {
      defaults: {
        runtimePermissions: {
          capabilities: [
            "mutate:image:generate",
            "use:tool:image_generate",
            "use:tool:Bash",
            "execute:executable:ravi",
            "read:skills:show",
            "read:context:codex-bash-hook",
            "read:sessions:actions",
          ],
        },
      },
    });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
    const family = createContact({
      phone: "5511977776666",
      name: "Family",
      tags: ["permission.family"],
      status: "allowed",
    });

    const prompt = promptForContact(family.id, "generate an image");
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
      authorityMode: "agent-identity",
      actorPrincipal: `contact:${family.id}`,
      actorCapabilityCount: 0,
      surfaceCapabilityCount: 0,
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
    });
    expect(Number(runtimeContext.metadata?.effectiveCapabilityCount)).toBeGreaterThanOrEqual(7);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "image", "generate")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "image_generate")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "execute", "executable", "ravi")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "read", "skills", "show")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "mutate", "mail", "send")).toBe(false);
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
      authorityMode: "agent-identity",
      actorPrincipal: "unknown",
      actorResolution: "missing_contact",
      actorDisplayName: "Desconhecido",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "admin", "system", "*")).toBe(false);
  });

  it("does not require chat delegation overrides in the agent identity model", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:luis",
      surfacePrincipal: "chat:chat_group_1",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
  });

  it("does not grant non-bootstrap resource access without provider-owned agent identity config", () => {
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });

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
      authorityMode: "agent-identity",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
    });
    expect(canWithCapabilities(denied.capabilities, "use", "tool", "Bash")).toBe(true);
    expect(canWithCapabilities(denied.capabilities, "access", "session", "restricted")).toBe(false);
  });

  it("runs cron prompts under an automation-scoped agent identity", () => {
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
      authorityMode: "agent-identity",
      actorPrincipal: "automation:cron:job-1",
      actorResolution: "resolved",
      agentIdentityPrincipal: "agent_identity:provider-agent:automation:cron:job-1",
      agentIdentityCompartment: "automation:cron:job-1",
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
      authorityMode: "agent-identity",
      actorPrincipal: "automation:session-followup",
      actorResolution: "resolved",
      surfacePrincipal: "chat:chat_group_1",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
      agentIdentityCompartment: "chat:chat_group_1",
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
      authorityMode: "agent-identity",
      actorPrincipal: "automation:daemon-restart",
      actorResolution: "resolved",
      surfacePrincipal: "chat:chat_group_1",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
      agentIdentityCompartment: "chat:chat_group_1",
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
      authorityMode: "agent-identity",
      actorPrincipal: "contact:luis",
      actorResolution: "resolved",
      surfacePrincipal: "chat:chat_group_1",
      agentIdentityPrincipal: "agent_identity:provider-agent:chat:chat_group_1",
      actor: {
        actorType: "contact",
        contactId: "luis",
        canonicalChatId: "chat_group_1",
      },
    });
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
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
    expect(runtimeContext.metadata?.authorityMode).toBe("agent-identity");
    expect(runtimeContext.metadata?.actorPrincipal).toBe("automation:trigger:trigger-1");
    expect(runtimeContext.metadata?.agentIdentityPrincipal).toBe(
      "agent_identity:provider-agent:automation:trigger:trigger-1",
    );
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
