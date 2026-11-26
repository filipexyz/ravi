/**
 * One entry point for notices addressed to a session. Spec: `runtime/session-inbox`.
 *
 * The producer declares the mode; the core decides the path. `now` keeps today's behaviour (a
 * session prompt that may wake the session). `deferred` writes to the session inbox and wakes
 * nothing. The channel is never part of this decision.
 */

import { publishSessionPrompt } from "../omni/session-stream.js";
import { enqueueInboxItem, type InboxItem, type InboxItemInput } from "./store.js";

export type SessionDeliveryMode = "now" | "deferred";

export type DeliverToSessionInput =
  | { mode: "now"; payload: Record<string, unknown>; messageId?: string }
  | { mode: "deferred"; item: Omit<InboxItemInput, "targetSessionName"> };

export type DeliverToSessionResult = { mode: "now" } | { mode: "deferred"; item: InboxItem };

export interface DeliverToSessionDeps {
  publish?: typeof publishSessionPrompt;
}

export async function deliverToSession(
  sessionName: string,
  input: DeliverToSessionInput,
  deps: DeliverToSessionDeps = {},
): Promise<DeliverToSessionResult> {
  if (input.mode === "deferred") {
    const item = enqueueInboxItem({
      ...input.item,
      targetSessionName: sessionName,
    });
    return { mode: "deferred", item };
  }
  const publish = deps.publish ?? publishSessionPrompt;
  await publish(sessionName, input.payload, input.messageId ? { messageId: input.messageId } : {});
  return { mode: "now" };
}
