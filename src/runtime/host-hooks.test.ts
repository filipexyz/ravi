import { describe, expect, it, mock } from "bun:test";
import type { AgentConfig } from "../router/index.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createRuntimeHostHooks, type RuntimeHostHookApprovalServices } from "./host-hooks.js";
import type { RuntimeCapabilities } from "./types.js";

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
