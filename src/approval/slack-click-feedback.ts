import { nats as runtimeNats } from "../nats.js";
import { respondToSlackInteraction } from "../channels/slack/interactions.js";
import { logger } from "../utils/logger.js";
import { evaluateApprovalInboundEvent } from "./decision.js";
import {
  buildSlackApprovalClickNotice,
  isSlackApprovalActionId,
  isSlackPermissionGrantActionId,
  parseSlackGrantActionValue,
  type SlackApprovalClickNotice,
} from "./slack-blocks.js";
import { getApprovalRequest } from "./store.js";

const log = logger.child("approval:slack-click-feedback");

/**
 * Every click on a Slack approval button gets an answer, privately, to whoever
 * clicked. The waiter of a live request answers the click that decides it; this
 * runner answers every click that decides nothing: someone without the
 * permission, a request that expired or was already decided, a request that no
 * longer exists. It never decides or grants anything.
 */
export interface SlackApprovalClickFeedbackDependencies {
  readonly now: () => number;
  readonly respond: (input: { responseUrlId: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

const defaultDependencies: SlackApprovalClickFeedbackDependencies = {
  now: Date.now,
  respond: respondToSlackInteraction,
};

export async function answerSlackApprovalClick(
  data: Record<string, unknown>,
  dependencies: SlackApprovalClickFeedbackDependencies = defaultDependencies,
): Promise<SlackApprovalClickNotice | null> {
  const actionId = typeof data.actionId === "string" ? data.actionId : undefined;
  if (!isSlackApprovalActionId(actionId) && !isSlackPermissionGrantActionId(actionId)) return null;
  const responseUrlId = typeof data.responseUrlId === "string" ? data.responseUrlId.trim() : "";
  if (!responseUrlId) return null;

  const notice = clickNotice(data, dependencies.now());
  if (!notice) return null;

  const requestId = clickRequestId(data);
  const request = requestId ? getApprovalRequest(requestId) : null;
  await dependencies.respond({
    responseUrlId,
    payload: {
      response_type: "ephemeral",
      // A card that can no longer decide anything loses its buttons. A person
      // without the permission keeps the card as it was and only gets the note.
      replace_original: notice !== "unauthorized",
      text: buildSlackApprovalClickNotice(notice, request ?? undefined),
    },
  });
  return notice;
}

function clickNotice(data: Record<string, unknown>, now: number): SlackApprovalClickNotice | null {
  const evaluation = evaluateApprovalInboundEvent({ topic: "ravi.inbound.interaction", data }, now);
  if (evaluation.kind === "decide") return null;
  // A scope selection on a live card is answered by that request's waiter.
  if (evaluation.kind === "scope") return null;
  switch (evaluation.reason) {
    case "unauthorized_grantor":
    case "missing_actor":
      return "unauthorized";
    case "unknown_request":
      return "unknown";
    case "not_open": {
      const requestId = clickRequestId(data);
      const request = requestId ? getApprovalRequest(requestId) : null;
      if (!request) return "unknown";
      if (request.status === "decided") {
        const actorId = typeof data.userId === "string" ? data.userId.trim().toUpperCase() : "";
        // The click that decided it is answered by the waiter.
        if (actorId && request.decidedBy?.toUpperCase() === actorId) return null;
        return "already_decided";
      }
      return "expired";
    }
    default:
      return null;
  }
}

function clickRequestId(data: Record<string, unknown>): string {
  const selectedOption = typeof data.selectedOption === "string" ? data.selectedOption : undefined;
  const value = typeof data.value === "string" ? data.value : undefined;
  return parseSlackGrantActionValue(selectedOption ?? value).requestId;
}

let runnerAbort: (() => void) | null = null;

export async function startSlackApprovalClickFeedback(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
): Promise<void> {
  if (runnerAbort) return;
  const stream = natsClient.subscribe("ravi.inbound.interaction", { queue: "ravi-approval-click-feedback" });
  let stopped = false;
  runnerAbort = () => {
    stopped = true;
    void stream.return?.(undefined);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (stopped) return;
        try {
          await answerSlackApprovalClick(event.data as Record<string, unknown>);
        } catch (error) {
          log.warn("Failed to answer a Slack approval click", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack approval click feedback stopped", { error });
    }
  })();
}

export function stopSlackApprovalClickFeedback(): void {
  runnerAbort?.();
  runnerAbort = null;
}
