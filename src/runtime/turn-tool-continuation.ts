import {
  PROVIDER_ENDED_AFTER_TOOLS_USER_MESSAGE,
  PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE,
} from "./public-failure.js";

/**
 * One-shot ACP recovery after Grok `handle_prompt` closes following tools
 * without a model step. Not a user prompt. Never re-issues open tools.
 */
export const RUNTIME_POST_TOOL_CONTINUE_PROMPT =
  "[System] Continue the current turn. Tool results are already in this session. Do not repeat completed tools. Reply to the user, or say explicitly that the work is done.";

export interface TurnToolContinuationLedger {
  started: Map<string, string>;
  terminal: Set<string>;
  issued: boolean;
  awaitingPostTool: boolean;
  postToolAssistantChars: number;
}

export type TurnAfterToolsDecision =
  | { action: "complete" }
  | { action: "interrupt" }
  | { action: "continue"; reason: "no_post_tool_continuation" }
  | {
      action: "fail";
      code: "open_tools" | "no_post_tool_continuation";
      error: string;
      recoverable: true;
    };

export function createTurnToolContinuationLedger(): TurnToolContinuationLedger {
  return {
    started: new Map(),
    terminal: new Set(),
    issued: false,
    awaitingPostTool: false,
    postToolAssistantChars: 0,
  };
}

export function resetTurnToolContinuationLedger(ledger: TurnToolContinuationLedger): void {
  ledger.started.clear();
  ledger.terminal.clear();
  ledger.issued = false;
  ledger.awaitingPostTool = false;
  ledger.postToolAssistantChars = 0;
}

export function noteTurnToolStarted(ledger: TurnToolContinuationLedger, id: string | undefined, name?: string): void {
  ledger.issued = true;
  ledger.awaitingPostTool = true;
  const toolId = id?.trim();
  if (!toolId) {
    return;
  }
  ledger.started.set(toolId, name?.trim() || "tool");
}

export function noteTurnToolTerminal(ledger: TurnToolContinuationLedger, id: string | undefined, name?: string): void {
  ledger.issued = true;
  const toolId = id?.trim();
  if (!toolId) {
    return;
  }
  ledger.terminal.add(toolId);
  if (name?.trim() && !ledger.started.has(toolId)) {
    ledger.started.set(toolId, name.trim());
  }
}

export function noteTurnPostToolAssistant(ledger: TurnToolContinuationLedger, chars: number): void {
  if (!ledger.awaitingPostTool || chars <= 0) {
    return;
  }
  ledger.postToolAssistantChars += chars;
}

export function listOpenTurnToolNames(ledger: TurnToolContinuationLedger): string[] {
  const names: string[] = [];
  for (const [id, name] of ledger.started) {
    if (!ledger.terminal.has(id)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * A turn that issued tools is not user-visible-complete until tool results
 * were consumed and the model produced a post-tool continuation, or the
 * tools failed/cancelled with a visible explanation.
 *
 * Grok ACP `session/prompt` is a single RPC. `handle_prompt.done ok=true`
 * (or `stopReason=cancelled` after tools) is not an explicit model stop —
 * the provider can close after the first tool batch without feeding results
 * back. One continue is allowed only when every started tool already
 * terminated; open tools never continue (that would re-run Bash).
 */
export function resolveTurnAfterTools(input: {
  issuedTools: boolean;
  openToolNames: string[];
  postToolAssistantChars: number;
  locallyAborted: boolean;
  promptCompletedOk: boolean;
  continueAttempted: boolean;
  streamDead?: boolean;
}): TurnAfterToolsDecision {
  const openToolNames = uniqueNames(input.openToolNames);
  if (input.locallyAborted && !input.promptCompletedOk) {
    return { action: "interrupt" };
  }
  if (openToolNames.length > 0) {
    return {
      action: "fail",
      code: "open_tools",
      error: PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE,
      recoverable: true,
    };
  }
  if (input.issuedTools && input.postToolAssistantChars <= 0) {
    if (!input.continueAttempted && !input.streamDead) {
      return { action: "continue", reason: "no_post_tool_continuation" };
    }
    return {
      action: "fail",
      code: "no_post_tool_continuation",
      error: PROVIDER_ENDED_AFTER_TOOLS_USER_MESSAGE,
      recoverable: true,
    };
  }
  return { action: "complete" };
}

/**
 * Host refuse-closed gate. Open tools may never complete on any provider.
 * Grok additionally cannot complete after tools with zero post-tool text —
 * that is the handle_prompt early-return shape.
 */
export function resolveHostTurnCompleteAfterTools(input: {
  provider: string;
  issuedTools: boolean;
  openToolNames: string[];
  postToolAssistantChars: number;
}): Extract<TurnAfterToolsDecision, { action: "fail" }> | null {
  const decision = resolveTurnAfterTools({
    issuedTools: input.issuedTools,
    openToolNames: input.openToolNames,
    postToolAssistantChars: input.postToolAssistantChars,
    locallyAborted: false,
    promptCompletedOk: true,
    continueAttempted: true,
    streamDead: true,
  });
  if (decision.action !== "fail") {
    return null;
  }
  if (decision.code === "open_tools") {
    return decision;
  }
  if (input.provider === "grok") {
    return decision;
  }
  return null;
}

function uniqueNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
