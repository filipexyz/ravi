import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { agentCan } from "../permissions/provider-runtime.js";
import { enforceScopeCheck } from "../permissions/scope.js";
import type { AgentConfig } from "../router/index.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeRequestContext } from "./runtime-request-context.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";

let stateDir: string | null = null;
let previousTurnScopedAuthority: string | undefined;

const agent: AgentConfig = { id: "provider-agent", cwd: "/tmp/provider-agent" };
const sessionKey = "agent:provider-agent:whatsapp:group:chat_group_1";
const sessionName = "provider-group";

const runtimeResolution: TaskRuntimeResolution = {
  options: {},
  sources: { model: null, effort: null, thinking: null },
  hasTaskRuntimeContext: false,
};

function contactPrompt(contactId: string): RuntimeLaunchPrompt {
  return {
    prompt: "do something",
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
      senderName: contactId,
      isGroup: true,
      groupName: "Ravi Dev",
      timestamp: 1000,
      actorType: "contact",
      contactId,
    },
  };
}

function unknownPrompt(): RuntimeLaunchPrompt {
  const prompt = contactPrompt("unknown");
  delete prompt.source!.contactId;
  delete prompt.context!.contactId;
  prompt.source!.actorType = "unknown";
  prompt.context!.actorType = "unknown";
  prompt.context!.senderId = "";
  prompt.context!.senderName = "Unknown";
  return prompt;
}

function cronPrompt(): RuntimeLaunchPrompt {
  return {
    prompt: "scheduled run",
    _cron: true,
    _jobId: "job-1",
    source: {
      channel: "whatsapp",
      accountId: "main",
      chatId: "120363428243036323@g.us",
      canonicalChatId: "chat_group_1",
    },
  } as RuntimeLaunchPrompt;
}

/** Build the real delegated turn context for a prompt and return the tool context the gate sees. */
function turnContext(prompt: RuntimeLaunchPrompt): ToolContext {
  const { toolContext } = buildRuntimeRequestContext({
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
  return toolContext as ToolContext;
}

describe("delegated turn enforcement (end-to-end)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-delegated-e2e-test-");
    previousTurnScopedAuthority = process.env.RAVI_TURN_SCOPED_AUTHORITY;
    process.env.RAVI_TURN_SCOPED_AUTHORITY = "1";
    dbCreateAgent({ id: agent.id, cwd: agent.cwd });
    getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
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

  it("does not authorize a resolved actor without provider-owned actor authority", () => {
    const ctx = turnContext(contactPrompt("luis"));

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(false);
    expect(decision.errorMessage).toContain("execute on group:sessions_info");
  });

  it("fails closed for an unresolved actor in the same powerful agent session", () => {
    const ctx = turnContext(unknownPrompt());

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(false);
    expect(decision.errorMessage).toContain("execute on group:sessions_info");
  });

  it("does not leak resolved actor state to the next unresolved speaker", () => {
    const trusted = turnContext(contactPrompt("luis"));
    expect(runWithContext(trusted, () => agentCan(agent.id, "use", "tool", "Bash"))).toBe(false);

    // Next turn, same session/surface, but actor identity resolution failed.
    const untrusted = turnContext(unknownPrompt());
    expect(runWithContext(untrusted, () => agentCan(agent.id, "use", "tool", "Bash"))).toBe(false);
  });

  it("runs cron automation with bootstrap authority but without system admin", () => {
    const ctx = turnContext(cronPrompt());

    expect(runWithContext(ctx, () => agentCan(agent.id, "use", "tool", "Bash"))).toBe(true);
    expect(runWithContext(ctx, () => agentCan(agent.id, "admin", "system", "*"))).toBe(false);
    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(true);
  });

  it("lets cron automation inherit the executor agent runtime permission profile", () => {
    dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
    const ctx = turnContext(cronPrompt());

    expect(runWithContext(ctx, () => agentCan(agent.id, "admin", "system", "*"))).toBe(true);
    expect(runWithContext(ctx, () => agentCan(agent.id, "execute", "executable", "omni"))).toBe(true);
  });

  it("does not add extra cron authority without provider-owned automation config", () => {
    const ctx = turnContext(cronPrompt());

    expect(runWithContext(ctx, () => agentCan(agent.id, "execute", "group", "sessions_info"))).toBe(true);
    expect(runWithContext(ctx, () => agentCan(agent.id, "access", "session", "restricted"))).toBe(false);
  });

  it("keeps contact turns denied without provider-owned actor and surface authority", () => {
    const ctx = turnContext(contactPrompt("luis"));

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(false);
  });
});
