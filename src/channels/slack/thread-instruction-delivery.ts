/**
 * A parent's `thread-send` waits behind the thread's running turn (follow-up delivery), so the thread
 * can close itself in that turn, with its own `--return`, before the instruction reaches it.
 *
 * Delivery is the moment the thread starts working on the instruction. A thread that closed in the
 * meantime is reopened then, the same transition `thread-send` makes when it publishes to a closed
 * thread. Without it the thread works on a record that says `closed`: the close that ends that work
 * is a no-op (`changed: false`), its `--return` is dropped, and the parent never hears of the result.
 */

import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { logger } from "../../utils/logger.js";
import {
  getSlackThreadLifecycle,
  reopenSlackThreadLifecycle,
  type SlackThreadLifecycleRecord,
} from "./thread-lifecycle-store.js";

const log = logger.child("slack-thread-instruction-delivery");

export interface ThreadInstructionDeliveryDependencies {
  /** Updates the root card of a reopened thread. The default publishes through the lifecycle's outbound. */
  refreshCard?: (record: SlackThreadLifecycleRecord) => Promise<void>;
}

/**
 * Reopens the threads whose queued parent instruction is about to be handed to the thread's provider.
 * Returns the request ids it reopened. It never throws: a failure here must not stop the turn that
 * delivers the instruction, and the next close then reports it as it did before.
 */
export function reopenThreadsForDeliveredInstructions(
  prompts: ReadonlyArray<Pick<RuntimeLaunchPrompt, "_slackThreadLifecycle"> | null | undefined>,
  dependencies: ThreadInstructionDeliveryDependencies = {},
): string[] {
  const reopened: string[] = [];
  for (const prompt of prompts) {
    const lifecycle = prompt?._slackThreadLifecycle;
    if (lifecycle?.eventType !== "thread.message" || !lifecycle.requestId || !lifecycle.childSessionKey) continue;
    if (reopened.includes(lifecycle.requestId)) continue;
    try {
      const current = getSlackThreadLifecycle(lifecycle.requestId);
      // A record that is open, gone, or bound to another child is not this instruction's to reopen.
      if (current?.status !== "closed" || current.childSessionKey !== lifecycle.childSessionKey) continue;
      const record = reopenSlackThreadLifecycle(lifecycle.requestId);
      reopened.push(lifecycle.requestId);
      void refreshReopenedCard(record, dependencies.refreshCard);
    } catch (error) {
      log.warn("Could not reopen a thread for a delivered parent instruction", {
        requestId: lifecycle.requestId,
        error,
      });
    }
  }
  return reopened;
}

/** The root card follows the lifecycle, as it does when `thread-send` reopens a thread at publish. */
async function refreshReopenedCard(
  record: SlackThreadLifecycleRecord,
  refreshCard?: ThreadInstructionDeliveryDependencies["refreshCard"],
): Promise<void> {
  try {
    if (refreshCard) {
      await refreshCard(record);
      return;
    }
    // Loaded on demand: the full lifecycle module reaches back into the runtime.
    const { updateReopenedSlackThreadCard } = await import("./thread-lifecycle.js");
    await updateReopenedSlackThreadCard(record);
  } catch (error) {
    log.warn("Could not update the card of a thread reopened by a delivered parent instruction", {
      requestId: record.requestId,
      error,
    });
  }
}
