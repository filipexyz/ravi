// One Vercel Workflow per Page chat agent turn (K11): model rounds and tool
// calls are durable steps; a write waits on a hook the confirmation endpoint
// resumes, for at most CONFIRMATION_WAIT. See
// `.ravi/specs/console/pages/chat-rooms/SPEC.md`.

import { defineHook, sleep } from "workflow";

import {
  applyConfirmationStep,
  askRaviStep,
  beginTurnStep,
  checkRaviStep,
  finishTurnStep,
  modelRoundStep,
  postRaviFollowUpStep,
  requestConfirmationStep,
  runToolStep,
  startRaviFollowUpStep,
} from "./page-chat-steps";

/** Matches TURN_MAX_ROUNDS in the turn logic; a safety stop for the loop. */
const MAX_ROUNDS = 8;
const CONFIRMATION_WAIT = "10m";
/** Quick checks for the installation's Ravi before the turn moves on. */
const ASK_RAVI_QUICK_CHECKS = 4;
const ASK_RAVI_QUICK_WAIT = "15s";
/** Waits between checks for a late answer, then every last one until the request expires (about a day). */
const FOLLOW_UP_WAITS = ["1m", "2m", "5m", "10m", "15m", "30m"] as const;
const FOLLOW_UP_MAX_CHECKS = 60;

export const pageChatConfirmationHook = defineHook<{ decision: "confirmed" | "cancelled" }>();

export function pageChatConfirmationToken(confirmationId: string) {
  return `page-chat-confirmation:${confirmationId}`;
}

export async function pageChatTurnWorkflow(turnId: string) {
  "use workflow";
  const begun = await beginTurnStep(turnId);
  if (!begun.ok) return { status: "skipped" as const };
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const result = await modelRoundStep(turnId);
      if (result.kind === "final") break;
      for (const call of result.calls) {
        if (call.kind === "run") {
          await runToolStep(turnId, call.toolCallId);
        } else if (call.kind === "confirm") {
          const pending = await requestConfirmationStep(turnId, call.toolCallId);
          if (!pending.ok || !pending.confirmationId) continue;
          const hook = pageChatConfirmationHook.create({ token: pageChatConfirmationToken(pending.confirmationId) });
          const outcome = await Promise.race([
            hook.then((payload) => payload.decision),
            sleep(CONFIRMATION_WAIT).then(() => "expired" as const),
          ]);
          await applyConfirmationStep(turnId, call.toolCallId, pending.confirmationId, outcome);
        } else if (call.kind === "ask_ravi") {
          const asked = await askRaviStep(turnId, call.toolCallId);
          if (!asked.ok || !asked.requestId) continue;
          for (let check = 1; check <= ASK_RAVI_QUICK_CHECKS; check += 1) {
            await sleep(ASK_RAVI_QUICK_WAIT);
            const reply = await checkRaviStep(turnId, call.toolCallId, asked.requestId, check === ASK_RAVI_QUICK_CHECKS);
            if (reply.answered) break;
            if (reply.pending) await startRaviFollowUpStep(turnId, asked.requestId);
          }
        }
      }
    }
    await finishTurnStep(turnId, "complete", null);
    return { status: "complete" as const };
  } catch (error) {
    await finishTurnStep(turnId, "failed", error instanceof Error ? error.message.slice(0, 300) : "turn_failed");
    return { status: "failed" as const };
  }
}

/** Waits for a late answer of the installation's Ravi and posts it in the room. */
export async function pageChatRaviFollowUpWorkflow(turnId: string, requestId: string) {
  "use workflow";
  for (let check = 0; check < FOLLOW_UP_MAX_CHECKS; check += 1) {
    await sleep(FOLLOW_UP_WAITS[Math.min(check, FOLLOW_UP_WAITS.length - 1)] ?? "30m");
    const result = await postRaviFollowUpStep(turnId, requestId);
    if (result.done) return { status: "posted" as const };
  }
  return { status: "gave_up" as const };
}
