// Starts and resumes Page chat workflows from route handlers.

import { start } from "workflow/api";
import { requirePageChatEngine } from "../../chat/engine";

import {
  pageChatConfirmationHook,
  pageChatConfirmationToken,
  pageChatRaviFollowUpWorkflow,
  pageChatTurnWorkflow,
} from "@/workflows/page-chat-turn";

export async function startPageChatTurn(turnId: string): Promise<string | null> {
  requirePageChatEngine();
  const run = await start(pageChatTurnWorkflow, [turnId]);
  return run.runId ?? null;
}

export async function startRaviFollowUp(turnId: string, requestId: string): Promise<void> {
  requirePageChatEngine();
  await start(pageChatRaviFollowUpWorkflow, [turnId, requestId]);
}

/** Wakes the turn waiting on this confirmation. A turn that stopped waiting (expired) has no hook: nothing to wake. */
export async function resumePageChatConfirmation(confirmationId: string, decision: "confirmed" | "cancelled") {
  requirePageChatEngine();
  try {
    await pageChatConfirmationHook.resume(pageChatConfirmationToken(confirmationId), { decision });
  } catch (error) {
    console.warn("Page chat confirmation had no waiting turn", { confirmationId, error: error instanceof Error ? error.message : "error" });
  }
}
