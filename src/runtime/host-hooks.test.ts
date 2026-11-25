import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { AgentConfig } from "../router/index.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createRuntimeHostHooks, type RuntimeHostHookApprovalServices } from "./host-hooks.js";
import { buildRuntimeHostAttachments } from "./runtime-host-attachments.js";
import type { RuntimeCapabilities, RuntimeHookMatcher } from "./types.js";

const capabilities = { supportsHostSessionHooks: true } as RuntimeCapabilities;
const agent: AgentConfig = { id: "hook-agent", cwd: "/tmp/hook-agent" };
const source = { channel: "whatsapp", accountId: "main", chatId: "chat-1" };

function createHarness(
  options: {
    attemptId?: string;
    marker?: (input: { attemptId: string; startedTool?: true; materializedOutput?: true }) => void;
    services?: Partial<RuntimeHostHookApprovalServices>;
  } = {},
) {
  const streamingSession: { currentCrashRecoveryAttemptId?: string; currentTurnToolStarted?: boolean } = {
    currentCrashRecoveryAttemptId: options.attemptId,
    currentTurnToolStarted: false,
  };
  const markTurnAttemptSafety = mock((input: { attemptId: string; startedTool?: true; materializedOutput?: true }) => {
    options.marker?.(input);
    return undefined;
  });
  const approvalServices: RuntimeHostHookApprovalServices = {
    requestCascadingApproval: async (request) => {
      request.beforeExternalApproval?.();
      return { approved: true, isDelegated: false };
    },
    requestPollAnswer: async () => ({ selectedLabels: ["A"] }),
    emitApprovalEvent: async () => {},
    ...options.services,
  };
  const hooks = createRuntimeHostHooks({
    runtimeCapabilities: capabilities,
    agent,
    sessionName: "hook-session",
    sessionCwd: "/tmp/hook-agent",
    resolvedSource: source,
    streamingSession,
    crashRecovery: {
      markTurnAttemptSafety,
    } as unknown as Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety">,
    approvalServices,
  });

  const hook = (event: string, matcher?: string) => {
    const entry = hooks[event]?.find((candidate) => candidate.matcher === matcher);
    const callback = entry?.hooks[0];
    if (!callback) throw new Error(`Missing ${event}:${matcher ?? "<default>"} hook`);
    return callback;
  };

  const crashRecoveryPreToolHook = () => {
    const entry = hooks.PreToolUse?.filter((candidate) => candidate.matcher === undefined).at(-1);
    const callback = entry?.hooks[0];
    if (!callback) throw new Error("Missing crash recovery PreToolUse hook");
    return callback;
  };

  return { streamingSession, markTurnAttemptSafety, approvalServices, hook, crashRecoveryPreToolHook };
}

function expectPreToolDenied(result: any): void {
  expect(result).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Runtime host hook denied because durable turn ownership changed before authorization completed.",
    },
  });
}

describe("runtime host hook crash recovery fences", () => {
  it("write-ahead fences an auto-allowed Claude tool through the catch-all PreToolUse hook", async () => {
    const order: string[] = [];
    const harness = createHarness({
      attemptId: "attempt-auto-tool",
      marker: (input) => order.push(input.startedTool ? "marker:started" : "unexpected"),
    });

    const result = await harness.crashRecoveryPreToolHook()({ tool_name: "Bash", tool_input: { command: "pwd" } });
    order.push(Object.keys(result).length === 0 ? "allow" : "deny");

    expect(order).toEqual(["marker:started", "allow"]);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(true);
  });

  it("denies an auto-allowed Claude tool when its write-ahead marker cannot persist", async () => {
    const harness = createHarness({
      attemptId: "attempt-auto-tool-marker-failure",
      marker: () => {
        throw new Error("tool marker unavailable");
      },
    });

    const result = await harness.crashRecoveryPreToolHook()({ tool_name: "Edit", tool_input: {} });

    expectPreToolDenied(result);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("denies an auto-allowed Claude tool without a durable attempt binding", async () => {
    const harness = createHarness();

    const result = await harness.crashRecoveryPreToolHook()({ tool_name: "Read", tool_input: {} });

    expectPreToolDenied(result);
    expect(harness.markTurnAttemptSafety).not.toHaveBeenCalled();
  });

  it("fails closed without an attempt binding instead of allowing PermissionRequest", async () => {
    const harness = createHarness();

    const result = await harness.hook("PermissionRequest")({});

    expect(result.hookSpecificOutput).toEqual({
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "Runtime host hook denied because durable turn ownership changed before authorization completed.",
      },
    });
    expect(harness.markTurnAttemptSafety).not.toHaveBeenCalled();
  });

  it("persists startedTool immediately before PermissionRequest allows the provider", async () => {
    const order: string[] = [];
    const harness = createHarness({
      attemptId: "attempt-permission",
      marker: (input) => order.push(input.startedTool ? "marker:started" : "unexpected"),
    });

    const result = await harness.hook("PermissionRequest")({});
    order.push(result.hookSpecificOutput.decision.behavior);

    expect(order).toEqual(["marker:started", "allow"]);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(true);
  });

  it("persists output before ExitPlan approval and startedTool before its final allow", async () => {
    const order: string[] = [];
    const harness = createHarness({
      attemptId: "attempt-plan",
      marker: (input) => order.push(input.materializedOutput ? "marker:output" : "marker:started"),
      services: {
        requestCascadingApproval: mock(async (request) => {
          request.beforeExternalApproval?.();
          order.push("external:plan");
          return { approved: true, isDelegated: false };
        }),
      },
    });

    const result = await harness.hook("PreToolUse", "ExitPlanMode")({ tool_input: { plan: "ship it" } });

    expect(result).toEqual({});
    expect(order).toEqual(["marker:output", "external:plan", "marker:started"]);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(true);
  });

  it("denies ExitPlan when attempt ownership changes while approval is pending", async () => {
    const harness = createHarness({ attemptId: "attempt-plan-race" });
    harness.approvalServices.requestCascadingApproval = mock(async (request) => {
      request.beforeExternalApproval?.();
      harness.streamingSession.currentCrashRecoveryAttemptId = undefined;
      return { approved: true, isDelegated: false };
    });

    const result = await harness.hook("PreToolUse", "ExitPlanMode")({ tool_input: { plan: "ship it" } });

    expectPreToolDenied(result);
    expect(harness.markTurnAttemptSafety).toHaveBeenCalledTimes(1);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("rechecks and persists output immediately before every AskUserQuestion poll", async () => {
    const order: string[] = [];
    let poll = 0;
    const harness = createHarness({
      attemptId: "attempt-questions",
      marker: (input) => order.push(input.materializedOutput ? "marker:output" : "marker:started"),
      services: {
        requestPollAnswer: mock(async () => {
          poll++;
          order.push(`external:poll-${poll}`);
          return { selectedLabels: [poll === 1 ? "A" : "B"] };
        }),
      },
    });

    const result = await harness.hook(
      "PreToolUse",
      "AskUserQuestion",
    )({
      tool_input: {
        questions: [
          {
            question: "First?",
            header: "First",
            options: [{ label: "A", description: "first" }],
            multiSelect: false,
          },
          {
            question: "Second?",
            header: "Second",
            options: [{ label: "B", description: "second" }],
            multiSelect: false,
          },
        ],
      },
    });

    expect(result.hookSpecificOutput.updatedInput.answers).toEqual({ "First?": "A", "Second?": "B" });
    expect(order).toEqual(["marker:output", "external:poll-1", "marker:output", "external:poll-2", "marker:started"]);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(true);
  });

  it("does not send the next question after ownership is lost while awaiting a poll", async () => {
    let polls = 0;
    const harness = createHarness({
      attemptId: "attempt-question-race",
      services: {
        requestPollAnswer: mock(async () => {
          polls++;
          harness.streamingSession.currentCrashRecoveryAttemptId = undefined;
          return { selectedLabels: ["A"] };
        }),
      },
    });

    const result = await harness.hook(
      "PreToolUse",
      "AskUserQuestion",
    )({
      tool_input: {
        questions: [
          { question: "First?", header: "First", options: [{ label: "A", description: "" }], multiSelect: false },
          { question: "Second?", header: "Second", options: [{ label: "B", description: "" }], multiSelect: false },
        ],
      },
    });

    expectPreToolDenied(result);
    expect(polls).toBe(1);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("does not send an AskUserQuestion poll when its output marker fails", async () => {
    let polls = 0;
    const harness = createHarness({
      attemptId: "attempt-question-marker-failure",
      marker: (input) => {
        if (input.materializedOutput) throw new Error("output marker unavailable");
      },
      services: {
        requestPollAnswer: mock(async () => {
          polls++;
          return { selectedLabels: ["A"] };
        }),
      },
    });

    await expect(
      harness.hook(
        "PreToolUse",
        "AskUserQuestion",
      )({
        tool_input: {
          questions: [
            {
              question: "First?",
              header: "First",
              options: [{ label: "A", description: "" }],
              multiSelect: false,
            },
          ],
        },
      }),
    ).rejects.toThrow("output marker unavailable");
    expect(polls).toBe(0);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(false);
  });

  it("fences ExitSpec before external approval and before deactivating the spec", async () => {
    const order: string[] = [];
    const harness = createHarness({
      attemptId: "attempt-spec",
      marker: (input) => order.push(input.materializedOutput ? "marker:output" : "marker:started"),
      services: {
        requestCascadingApproval: mock(async (request) => {
          request.beforeExternalApproval?.();
          order.push("external:spec");
          return { approved: true, isDelegated: false };
        }),
      },
    });

    const result = await harness.hook(
      "PreToolUse",
      "mcp__spec__exit_spec_mode",
    )({
      tool_input: { spec: "# Spec" },
    });

    expect(result).toEqual({});
    expect(order).toEqual(["marker:output", "external:spec", "marker:started"]);
    expect(harness.streamingSession.currentTurnToolStarted).toBe(true);
  });
});

const GATE_AGENT_ID = "gate-agent";
const claudeLike = {
  supportsHostSessionHooks: true,
  supportsMcpServers: true,
  supportsRemoteSpawn: false,
} as RuntimeCapabilities;

function turnContext(capabilities: ContextCapability[]): ToolContext {
  const context: ContextRecord = {
    contextId: `test-${GATE_AGENT_ID}`,
    contextKey: `test-key-${GATE_AGENT_ID}`,
    kind: "test-runtime",
    agentId: GATE_AGENT_ID,
    capabilities,
    createdAt: 0,
  };
  return { agentId: GATE_AGENT_ID, context };
}

function buildSession(agent: Partial<AgentConfig> = {}) {
  const attachments = buildRuntimeHostAttachments({
    runtimeCapabilities: claudeLike,
    agent: { id: GATE_AGENT_ID, cwd: `/tmp/${GATE_AGENT_ID}`, ...agent },
    sessionName: "gate-session",
    sessionCwd: `/tmp/${GATE_AGENT_ID}`,
    streamingSession: { currentCrashRecoveryAttemptId: "attempt-1", currentTurnToolStarted: false },
    crashRecovery: { markTurnAttemptSafety: () => undefined } as unknown as Pick<
      RuntimeCrashRecoveryCoordinator,
      "markTurnAttemptSafety"
    >,
  });
  return { attachments, preToolUse: attachments.hooks?.PreToolUse ?? [] };
}

function matches(entry: RuntimeHookMatcher, toolName: string): boolean {
  return entry.matcher === undefined || entry.matcher.split("|").includes(toolName);
}

/** Runs the PreToolUse chain the way the runtime does: every matching hook, first deny wins. */
async function runPreToolUse(
  chain: RuntimeHookMatcher[],
  capabilities: ContextCapability[],
  input: { tool_name: string; tool_input?: Record<string, unknown>; mcp_server?: { name: string; source: string } },
): Promise<string | null> {
  return runWithContext(turnContext(capabilities), async () => {
    for (const entry of chain.filter((candidate) => matches(candidate, input.tool_name))) {
      for (const hook of entry.hooks) {
        const result = await hook({ hook_event_name: "PreToolUse", tool_input: {}, ...input }, null, {
          signal: new AbortController().signal,
        });
        const output = result?.hookSpecificOutput;
        if (output?.permissionDecision === "deny") return String(output.permissionDecisionReason ?? "denied");
      }
    }
    return null;
  });
}

const toolGrant = (objectId: string): ContextCapability => ({ permission: "use", objectType: "tool", objectId });

describe("tool gate on the registered PreToolUse chain", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-host-hooks-tool-gate-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("denies a tool of a server the runtime loaded from its own configuration", async () => {
    const { preToolUse } = buildSession();
    const call = { tool_name: "mcp__github__create_issue", mcp_server: { name: "github", source: "project" } };

    expect(await runPreToolUse(preToolUse, [toolGrant("Read")], call)).toContain("tool:mcp__github__create_issue");
    expect(await runPreToolUse(preToolUse, [toolGrant("mcp__github__*")], call)).toBeNull();
    expect(await runPreToolUse(preToolUse, [toolGrant("*")], call)).toBeNull();
  });

  it("denies a tool the built-in registry does not list", async () => {
    const { preToolUse } = buildSession();

    for (const toolName of ["ListMcpResourcesTool", "ReadMcpResourceTool", "Monitor", "CronCreate", "Workflow"]) {
      expect(await runPreToolUse(preToolUse, [toolGrant("Read")], { tool_name: toolName })).toContain(
        `tool:${toolName}`,
      );
      expect(await runPreToolUse(preToolUse, [toolGrant(toolName)], { tool_name: toolName })).toBeNull();
    }
  });

  it("exempts exactly the in-process servers the session registers", async () => {
    const specSession = buildSession({ specMode: true });
    // The provider registers this record as built, so its keys are the names Claude Code reports.
    const registered = Object.keys(specSession.attachments.mcpServers ?? {});
    expect(registered).toEqual(["spec"]);
    const [name] = registered;
    const hostCall = { tool_name: `mcp__${name}__enter_spec_mode`, mcp_server: { name: name!, source: "sdk" } };
    const lookalike = { tool_name: `mcp__${name}__ping`, mcp_server: { name: name!, source: "project" } };
    const unregistered = { tool_name: "mcp__other__call", mcp_server: { name: "other", source: "sdk" } };

    expect(await runPreToolUse(specSession.preToolUse, [], hostCall)).toBeNull();
    expect(await runPreToolUse(specSession.preToolUse, [], lookalike)).toContain(`tool:mcp__${name}__ping`);
    expect(await runPreToolUse(specSession.preToolUse, [], unregistered)).toContain("tool:mcp__other__call");

    const plainSession = buildSession();
    expect(plainSession.attachments.mcpServers).toBeUndefined();
    expect(await runPreToolUse(plainSession.preToolUse, [], hostCall)).toContain(`tool:mcp__${name}__enter_spec_mode`);
  });

  it("checks a Monitor shell command through the Bash-matched permission hook", async () => {
    const { preToolUse } = buildSession();
    // Claude Code delivers Monitor's command to Bash-matched hooks as a Bash
    // call. Holding `use tool:Monitor` must not run a command the turn cannot execute.
    const bashMatched = preToolUse.filter((entry) => entry.matcher === "Bash");
    const denial = await runPreToolUse(bashMatched, [toolGrant("Monitor")], {
      tool_name: "Bash",
      tool_input: { command: "curl https://example.com" },
    });

    expect(denial).toContain("cannot execute: curl");
  });
});
