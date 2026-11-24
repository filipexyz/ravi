import { logger } from "../utils/logger.js";
import { publishHandoffEvent } from "./events.js";
import { acknowledgeHandoffsForPullRequest } from "./store.js";

const log = logger.child("handoffs:pr-events");

/** The PR lifecycle events the GitHub watch already publishes; the handoffs read no GitHub themselves. */
export const HANDOFF_PR_EVENT_TOPICS = [
  "ravi.watch.github.pull_request.merged",
  "ravi.watch.github.pull_request.closed",
] as const;

/**
 * A `review` or `merge` wait on a PR ends when the PR does. Driven by the watch events, so the daemon
 * neither polls GitHub nor learns the state of a PR no watch reports.
 */
export async function handleHandoffPullRequestEvent(
  topic: string,
  data: Record<string, unknown> | undefined,
  now = Date.now(),
): Promise<number> {
  const payload = (data?.payload ?? {}) as { repository?: unknown; number?: unknown };
  const repo = typeof payload.repository === "string" ? payload.repository : null;
  const number = typeof payload.number === "number" ? payload.number : Number(payload.number);
  if (!repo || !Number.isSafeInteger(number) || number <= 0) return 0;
  const merged = topic.endsWith(".merged");
  const acked = acknowledgeHandoffsForPullRequest(repo, number, merged ? "PR merged" : "PR closed", now);
  for (const handoff of acked) await publishHandoffEvent("acknowledged", handoff, now);
  return acked.length;
}

export function startHandoffPullRequestListener(): { stop(): Promise<void> } {
  const controller = new AbortController();
  const loop = (async () => {
    const { nats } = await import("../nats.js");
    for (const topic of HANDOFF_PR_EVENT_TOPICS) {
      void (async () => {
        try {
          for await (const event of nats.subscribe(topic, { signal: controller.signal })) {
            try {
              await handleHandoffPullRequestEvent(event.topic, event.data as Record<string, unknown>);
            } catch (error) {
              log.warn("Handoff PR event not applied", {
                topic: event.topic,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted)
            log.warn("Handoff PR event subscription ended", {
              topic,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      })();
    }
  })();
  return {
    async stop() {
      controller.abort();
      await loop.catch((error) => {
        log.warn("Handoff PR event listener did not start", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}
