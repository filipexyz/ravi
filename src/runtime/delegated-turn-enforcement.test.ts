import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { agentCan } from "../permissions/engine.js";
import { grantRelation } from "../permissions/relations.js";
import { enforceScopeCheck } from "../permissions/scope.js";
import type { AgentConfig } from "../router/index.js";
import { dbCreateAgent } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeRequestContext } from "./runtime-request-context.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";

let stateDir: string | null = null;
let previousTurnScopedAuthority: string | undefined;

const agent: AgentConfig = { id: "rebac-agent", cwd: "/tmp/rebac-agent" };
const sessionKey = "agent:rebac-agent:whatsapp:group:chat_group_1";
const sessionName = "rebac-group";

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
    sessionCwd: "/tmp/rebac-agent",
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
    // Powerful executor agent (superadmin ceiling).
    grantRelation("agent", agent.id, "admin", "system", "*");
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

  it("allows a trusted actor through the real CLI gate", () => {
    grantRelation("contact", "luis", "execute", "group", "sessions_info");
    const ctx = turnContext(contactPrompt("luis"));

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(true);
  });

  it("denies an untrusted actor in the same powerful agent session", () => {
    const ctx = turnContext(contactPrompt("estranho"));

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(false);
    expect(decision.errorMessage).toContain("execute on group:sessions_info");
  });

  it("does not leak a trusted actor's authority to the next untrusted speaker", () => {
    grantRelation("contact", "luis", "use", "tool", "Bash");

    const trusted = turnContext(contactPrompt("luis"));
    expect(runWithContext(trusted, () => agentCan(agent.id, "use", "tool", "Bash"))).toBe(true);

    // Next turn, same session/surface, different (untrusted) speaker.
    const untrusted = turnContext(contactPrompt("estranho"));
    expect(runWithContext(untrusted, () => agentCan(agent.id, "use", "tool", "Bash"))).toBe(false);
  });

  it("denies a cron automation principal even though the executor agent is superadmin", () => {
    const ctx = turnContext(cronPrompt());

    expect(runWithContext(ctx, () => agentCan(agent.id, "use", "tool", "Bash"))).toBe(false);
    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(false);
  });

  it("covers a cron automation once its principal is granted a role", () => {
    grantRelation("automation", "cron:job-1", "member", "role", "ops");
    grantRelation("role", "ops", "execute", "group", "sessions_info");
    const ctx = turnContext(cronPrompt());

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(true);
  });

  it("lets a surface deny veto an otherwise-trusted actor", () => {
    grantRelation("contact", "luis", "execute", "group", "sessions_info");
    grantRelation("chat", "chat_group_1", "deny_execute", "group", "sessions_info");
    const ctx = turnContext(contactPrompt("luis"));

    const decision = runWithContext(ctx, () => enforceScopeCheck("admin", "sessions", "info"));
    expect(decision.allowed).toBe(false);
  });
});
