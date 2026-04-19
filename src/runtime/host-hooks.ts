import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { requestCascadingApproval, requestPollAnswer, type ApprovalTarget } from "../approval/service.js";
import { createBashPermissionHook, createToolPermissionHook } from "../bash/index.js";
import { createPreCompactHook } from "../hooks/index.js";
import { createSanitizeBashHook } from "../hooks/sanitize-bash.js";
import { nats } from "../nats.js";
import type { AgentConfig } from "../router/index.js";
import { getSpecState, isSpecModeActive } from "../spec/server.js";
import { logger } from "../utils/logger.js";
import type { RuntimeCapabilities, RuntimeHookMatcher } from "./types.js";

const log = logger.child("runtime:host-hooks");

export interface RuntimeHostHooksOptions {
  runtimeCapabilities: RuntimeCapabilities;
  agent: AgentConfig;
  sessionName: string;
  sessionCwd: string;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
}

export function createRuntimeHostHooks({
  runtimeCapabilities,
  agent,
  sessionName,
  sessionCwd,
  resolvedSource,
  approvalSource,
}: RuntimeHostHooksOptions): Record<string, RuntimeHookMatcher[]> {
  if (!runtimeCapabilities.supportsHostSessionHooks) {
    return {};
  }

  const hookOpts = { getAgentId: () => agent.id };
  const hooks: Record<string, RuntimeHookMatcher[]> = {
    PreToolUse: [createToolPermissionHook(hookOpts), createBashPermissionHook(hookOpts), createSanitizeBashHook()],
    PermissionRequest: [
      {
        hooks: [
          async () => ({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest" as const,
              decision: { behavior: "allow" as const },
            },
          }),
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
      hooks: [createExitSpecHook({ sessionName, agent, resolvedSource, approvalSource })],
    },
    {
      matcher: "ExitPlanMode",
      hooks: [createExitPlanHook({ sessionName, sessionCwd, agent, resolvedSource, approvalSource })],
    },
    {
      matcher: "AskUserQuestion",
      hooks: [createAskUserQuestionHook({ sessionName, agent, resolvedSource, approvalSource })],
    },
  ];

  log.info("Hooks registered", {
    sessionName,
    hookEvents: Object.keys(hooks),
  });

  return hooks;
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
}) {
  return async (input: any) => {
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

    const result = await requestCascadingApproval({
      resolvedSource: options.resolvedSource,
      approvalSource: options.approvalSource,
      type: "plan",
      sessionName: options.sessionName,
      agentId: options.agent.id,
      text: planText,
    });

    if (result.approved) return {};

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
}) {
  return async (input: any) => {
    const targetSource = options.resolvedSource ?? options.approvalSource;
    if (!targetSource) {
      log.info("AskUserQuestion auto-approved (no source available)", { sessionName: options.sessionName });
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

    if (!questions || questions.length === 0) return {};

    log.info("AskUserQuestion hook: sending polls", {
      sessionName: options.sessionName,
      questionCount: questions.length,
      isDelegated,
    });

    nats
      .emit("ravi.approval.request", {
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

      const result = await requestPollAnswer(targetSource, pollName, optionLabels, {
        selectableCount: q.multiSelect ? optionLabels.length : 1,
      });

      answers[q.question] = "selectedLabels" in result ? result.selectedLabels.join(", ") : result.freeText;
    }

    nats
      .emit("ravi.approval.response", {
        type: "question",
        sessionName: options.sessionName,
        agentId: options.agent.id,
        approved: true,
        answers,
        timestamp: Date.now(),
      })
      .catch(() => {});

    log.info("AskUserQuestion answers collected", { sessionName: options.sessionName, answers, isDelegated });
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
}) {
  return async (input: any) => {
    const spec = (input.tool_input as Record<string, unknown> | undefined)?.spec as string | undefined;
    if (!spec) return {};

    const result = await requestCascadingApproval({
      resolvedSource: options.resolvedSource,
      approvalSource: options.approvalSource,
      type: "spec",
      sessionName: options.sessionName,
      agentId: options.agent.id,
      text: spec,
    });

    if (result.approved) {
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
