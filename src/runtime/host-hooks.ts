import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { requestCascadingApproval, requestPollAnswer, type ApprovalTarget } from "../approval/service.js";
import { createBashPermissionHook, createToolPermissionHook } from "../bash/index.js";
import { createPreCompactHook } from "../hooks/index.js";
import { createRtkRewriteHook } from "../hooks/rtk-rewrite.js";
import { createSanitizeBashHook } from "../hooks/sanitize-bash.js";
import { nats } from "../nats.js";
import type { AgentConfig } from "../router/index.js";
import { getSpecState, isSpecModeActive } from "../spec/server.js";
import { logger } from "../utils/logger.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeCapabilities, RuntimeHookMatcher } from "./types.js";

const log = logger.child("runtime:host-hooks");
const CRASH_RECOVERY_HOOK_OWNERSHIP_CHANGED_REASON =
  "Runtime host hook denied because durable turn ownership changed before authorization completed.";

class RuntimeCrashRecoveryHookOwnershipChangedError extends Error {
  constructor() {
    super(CRASH_RECOVERY_HOOK_OWNERSHIP_CHANGED_REASON);
    this.name = "RuntimeCrashRecoveryHookOwnershipChangedError";
  }
}

export interface RuntimeHostHookApprovalServices {
  requestCascadingApproval: typeof requestCascadingApproval;
  requestPollAnswer: typeof requestPollAnswer;
  emitApprovalEvent(topic: string, payload: Record<string, unknown>): Promise<unknown>;
}

interface RuntimeHostHookAttemptSafety {
  streamingSession: Pick<RuntimeHostStreamingSession, "currentCrashRecoveryAttemptId" | "currentTurnToolStarted">;
  crashRecovery: Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety">;
}

interface RuntimeHostHookAttemptFence {
  beforeExternalApproval(): void;
  ownsAttempt(): boolean;
  finalizeAllowedTool(): boolean;
}

export interface RuntimeHostHooksOptions {
  runtimeCapabilities: RuntimeCapabilities;
  agent: AgentConfig;
  sessionName: string;
  sessionCwd: string;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  streamingSession: RuntimeHostHookAttemptSafety["streamingSession"];
  crashRecovery: RuntimeHostHookAttemptSafety["crashRecovery"];
  approvalServices?: RuntimeHostHookApprovalServices;
}

export function createRuntimeHostHooks({
  runtimeCapabilities,
  agent,
  sessionName,
  sessionCwd,
  resolvedSource,
  approvalSource,
  streamingSession,
  crashRecovery,
  approvalServices = {
    requestCascadingApproval,
    requestPollAnswer,
    emitApprovalEvent: (topic, payload) => nats.emit(topic, payload),
  },
}: RuntimeHostHooksOptions): Record<string, RuntimeHookMatcher[]> {
  if (!runtimeCapabilities.supportsHostSessionHooks) {
    return {};
  }

  const attemptSafety = { streamingSession, crashRecovery };
  const hookOpts = { getAgentId: () => agent.id };
  const hooks: Record<string, RuntimeHookMatcher[]> = {
    PreToolUse: [
      createToolPermissionHook(hookOpts),
      createBashPermissionHook(hookOpts),
      createSanitizeBashHook(),
      createRtkRewriteHook(),
    ],
    PermissionRequest: [
      {
        hooks: [
          async () => {
            const fence = createRuntimeHostHookAttemptFence(attemptSafety);
            if (!fence || !fence.finalizeAllowedTool()) {
              return denyPermissionRequestForOwnershipChange();
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PermissionRequest" as const,
                decision: { behavior: "allow" as const },
              },
            };
          },
        ],
      },
    ],
  };

  const preCompactHook = createPreCompactHook({ memoryModel: agent.memoryModel });
  hooks.PreCompact = [
    {
      hooks: [
        async (input, toolUseId, context) => {
          log.info("PreCompact hook called", {
            sessionName,
            agentId: agent.id,
            inputKeys: Object.keys(input),
            hookEventName: (input as any).hook_event_name,
          });
          return preCompactHook(input as any, toolUseId ?? null, context as any);
        },
      ],
    },
  ];

  hooks.PreToolUse = [
    ...(hooks.PreToolUse ?? []),
    { hooks: [createSpecBlockHook(sessionName)] },
    {
      matcher: "mcp__spec__exit_spec_mode",
      hooks: [
        createExitSpecHook({
          sessionName,
          agent,
          resolvedSource,
          approvalSource,
          attemptSafety,
          approvalServices,
        }),
      ],
    },
    {
      matcher: "ExitPlanMode",
      hooks: [
        createExitPlanHook({
          sessionName,
          sessionCwd,
          agent,
          resolvedSource,
          approvalSource,
          attemptSafety,
          approvalServices,
        }),
      ],
    },
    {
      matcher: "AskUserQuestion",
      hooks: [
        createAskUserQuestionHook({
          sessionName,
          agent,
          resolvedSource,
          approvalSource,
          attemptSafety,
          approvalServices,
        }),
      ],
    },
    // This catch-all is the final synchronous boundary before Claude may
    // execute any tool, including tools auto-allowed by bypassPermissions.
    // Earlier policy hooks may deny/rewrite; an allowed call cannot leave the
    // hook chain without durable started_tool evidence.
    { hooks: [createCrashRecoveryPreToolUseFence(attemptSafety)] },
  ];

  log.info("Hooks registered", {
    sessionName,
    hookEvents: Object.keys(hooks),
  });

  return hooks;
}

function createRuntimeHostHookAttemptFence(
  safety: RuntimeHostHookAttemptSafety,
): RuntimeHostHookAttemptFence | undefined {
  const attemptId = safety.streamingSession.currentCrashRecoveryAttemptId;
  if (!attemptId) return undefined;

  const ownsAttempt = () => safety.streamingSession.currentCrashRecoveryAttemptId === attemptId;
  const assertOwnership = () => {
    if (!ownsAttempt()) {
      throw new RuntimeCrashRecoveryHookOwnershipChangedError();
    }
  };

  return {
    ownsAttempt,
    beforeExternalApproval: () => {
      assertOwnership();
      safety.crashRecovery.markTurnAttemptSafety({ attemptId, materializedOutput: true });
      assertOwnership();
    },
    finalizeAllowedTool: () => {
      if (!ownsAttempt()) return false;
      safety.crashRecovery.markTurnAttemptSafety({ attemptId, startedTool: true });
      if (!ownsAttempt()) return false;
      safety.streamingSession.currentTurnToolStarted = true;
      return true;
    },
  };
}

function denyPreToolUseForOwnershipChange() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: CRASH_RECOVERY_HOOK_OWNERSHIP_CHANGED_REASON,
    },
  };
}

function denyPermissionRequestForOwnershipChange() {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest" as const,
      decision: {
        behavior: "deny" as const,
        message: CRASH_RECOVERY_HOOK_OWNERSHIP_CHANGED_REASON,
      },
    },
  };
}

function createCrashRecoveryPreToolUseFence(safety: RuntimeHostHookAttemptSafety) {
  return async () => {
    try {
      const fence = createRuntimeHostHookAttemptFence(safety);
      if (!fence || !fence.finalizeAllowedTool()) {
        return denyPreToolUseForOwnershipChange();
      }
      return {};
    } catch (error) {
      log.error("Failed to persist crash recovery PreToolUse fence", { error });
      return denyPreToolUseForOwnershipChange();
    }
  };
}

function isRuntimeCrashRecoveryHookOwnershipChanged(error: unknown): boolean {
  return error instanceof RuntimeCrashRecoveryHookOwnershipChangedError;
}

function createSpecBlockHook(sessionName: string) {
  return async (input: any) => {
    if (!isSpecModeActive(sessionName)) return {};

    const toolName = input.tool_name;
    const blockedInSpec = ["Edit", "Write", "Bash", "NotebookEdit", "Skill", "Task"];

    if (typeof toolName === "string" && toolName.startsWith("mcp__spec__")) return {};

    if (blockedInSpec.includes(toolName)) {
      log.info("Spec mode blocked tool", { sessionName, toolName });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Spec mode ativo. Colete informações e complete a spec antes de implementar. Use Read, Glob, Grep, WebFetch para explorar.",
        },
      };
    }
    return {};
  };
}

function createExitPlanHook(options: {
  sessionName: string;
  sessionCwd: string;
  agent: AgentConfig;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  attemptSafety: RuntimeHostHookAttemptSafety;
  approvalServices: RuntimeHostHookApprovalServices;
}) {
  return async (input: any) => {
    const fence = createRuntimeHostHookAttemptFence(options.attemptSafety);
    if (!fence) return denyPreToolUseForOwnershipChange();

    let planText = "";
    const toolInput = input.tool_input as Record<string, unknown> | undefined;

    try {
      const planDir = join(options.sessionCwd, ".claude", "plans");
      const files = (() => {
        try {
          return readdirSync(planDir)
            .filter((f: string) => f.endsWith(".md"))
            .map((f: string) => ({ name: f, mtime: statSync(join(planDir, f)).mtimeMs }))
            .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
        } catch {
          return [];
        }
      })();
      if (files.length > 0) {
        planText = readFileSync(join(planDir, files[0].name), "utf-8");
      }
    } catch {
      /* fallback below */
    }

    if (!planText && toolInput) {
      if (typeof toolInput.plan === "string") {
        planText = toolInput.plan;
      } else {
        const {
          allowedPrompts: _allowedPrompts,
          pushToRemote: _pushToRemote,
          remoteSessionId: _remoteSessionId,
          remoteSessionTitle: _remoteSessionTitle,
          remoteSessionUrl: _remoteSessionUrl,
          ...rest
        } = toolInput;
        planText = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "(plano vazio)";
      }
    }
    if (!planText) planText = "(plano vazio)";

    let result: Awaited<ReturnType<typeof requestCascadingApproval>>;
    try {
      result = await options.approvalServices.requestCascadingApproval({
        resolvedSource: options.resolvedSource,
        approvalSource: options.approvalSource,
        type: "plan",
        sessionName: options.sessionName,
        agentId: options.agent.id,
        text: planText,
        beforeExternalApproval: fence.beforeExternalApproval,
      });
    } catch (error) {
      if (isRuntimeCrashRecoveryHookOwnershipChanged(error)) {
        return denyPreToolUseForOwnershipChange();
      }
      throw error;
    }

    if (!fence.ownsAttempt()) return denyPreToolUseForOwnershipChange();

    if (result.approved) {
      if (!fence.finalizeAllowedTool()) return denyPreToolUseForOwnershipChange();
      return {};
    }

    const reason = result.reason ? `Plano rejeitado: ${result.reason}` : "Plano rejeitado pelo usuário.";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

function createAskUserQuestionHook(options: {
  sessionName: string;
  agent: AgentConfig;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  attemptSafety: RuntimeHostHookAttemptSafety;
  approvalServices: RuntimeHostHookApprovalServices;
}) {
  return async (input: any) => {
    const fence = createRuntimeHostHookAttemptFence(options.attemptSafety);
    if (!fence) return denyPreToolUseForOwnershipChange();

    const targetSource = options.resolvedSource ?? options.approvalSource;
    if (!targetSource) {
      log.info("AskUserQuestion auto-approved (no source available)", { sessionName: options.sessionName });
      if (!fence.finalizeAllowedTool()) return denyPreToolUseForOwnershipChange();
      return {};
    }

    const isDelegated = !options.resolvedSource && !!options.approvalSource;
    const toolInput = input.tool_input as Record<string, unknown> | undefined;
    const questions = toolInput?.questions as
      | Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>
      | undefined;

    if (!questions || questions.length === 0) {
      if (!fence.finalizeAllowedTool()) return denyPreToolUseForOwnershipChange();
      return {};
    }

    log.info("AskUserQuestion hook: sending polls", {
      sessionName: options.sessionName,
      questionCount: questions.length,
      isDelegated,
    });

    options.approvalServices
      .emitApprovalEvent("ravi.approval.request", {
        type: "question",
        sessionName: options.sessionName,
        agentId: options.agent.id,
        delegated: isDelegated,
        channel: targetSource.channel,
        chatId: targetSource.chatId,
        questionCount: questions.length,
        timestamp: Date.now(),
      })
      .catch(() => {});

    const answers: Record<string, string> = {};
    for (const q of questions) {
      const optionLabels = q.options.map((o) => o.label);
      const hasDescriptions = q.options.some((o) => o.description);
      let pollName = isDelegated ? `[${options.agent.id}] ${q.question}` : q.question;
      if (hasDescriptions) {
        const descLines = q.options.map((o) => `• ${o.label} — ${o.description}`).join("\n");
        pollName += "\n\n" + descLines;
      }
      pollName += "\n(responda a mensagem para outro)";

      let result: Awaited<ReturnType<typeof requestPollAnswer>>;
      try {
        fence.beforeExternalApproval();
        result = await options.approvalServices.requestPollAnswer(targetSource, pollName, optionLabels, {
          selectableCount: q.multiSelect ? optionLabels.length : 1,
        });
      } catch (error) {
        if (isRuntimeCrashRecoveryHookOwnershipChanged(error)) {
          return denyPreToolUseForOwnershipChange();
        }
        throw error;
      }
      if (!fence.ownsAttempt()) return denyPreToolUseForOwnershipChange();

      answers[q.question] = "selectedLabels" in result ? result.selectedLabels.join(", ") : result.freeText;
    }

    options.approvalServices
      .emitApprovalEvent("ravi.approval.response", {
        type: "question",
        sessionName: options.sessionName,
        agentId: options.agent.id,
        approved: true,
        answers,
        timestamp: Date.now(),
      })
      .catch(() => {});

    log.info("AskUserQuestion answers collected", { sessionName: options.sessionName, answers, isDelegated });
    if (!fence.finalizeAllowedTool()) return denyPreToolUseForOwnershipChange();
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        updatedInput: { ...toolInput, answers },
      },
    };
  };
}

function createExitSpecHook(options: {
  sessionName: string;
  agent: AgentConfig;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  attemptSafety: RuntimeHostHookAttemptSafety;
  approvalServices: RuntimeHostHookApprovalServices;
}) {
  return async (input: any) => {
    const fence = createRuntimeHostHookAttemptFence(options.attemptSafety);
    if (!fence) return denyPreToolUseForOwnershipChange();

    const spec = (input.tool_input as Record<string, unknown> | undefined)?.spec as string | undefined;
    if (!spec) {
      if (!fence.finalizeAllowedTool()) return denyPreToolUseForOwnershipChange();
      return {};
    }

    let result: Awaited<ReturnType<typeof requestCascadingApproval>>;
    try {
      result = await options.approvalServices.requestCascadingApproval({
        resolvedSource: options.resolvedSource,
        approvalSource: options.approvalSource,
        type: "spec",
        sessionName: options.sessionName,
        agentId: options.agent.id,
        text: spec,
        beforeExternalApproval: fence.beforeExternalApproval,
      });
    } catch (error) {
      if (isRuntimeCrashRecoveryHookOwnershipChanged(error)) {
        return denyPreToolUseForOwnershipChange();
      }
      throw error;
    }

    if (!fence.ownsAttempt()) return denyPreToolUseForOwnershipChange();

    if (result.approved) {
      if (!fence.finalizeAllowedTool()) return denyPreToolUseForOwnershipChange();
      const state = getSpecState(options.sessionName);
      if (state) state.active = false;
      return {};
    }

    const reason = result.reason ? `Spec rejeitada: ${result.reason}` : "Spec rejeitada pelo usuário.";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}
