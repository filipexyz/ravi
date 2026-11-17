/** Child process of thread-attention-admission.test.ts; never uses a live broker/provider. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsMsg } from "nats";
import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";

const [mode, clock] = process.argv.slice(2);
const state = process.env.RAVI_STATE_DIR;
if (!state?.includes("ravi-attention-admission-")) throw new Error("Isolated fixture state required");
const now = Number(clock);
const { RuntimePromptSubscription } = await import("../../runtime/prompt-subscription.js");
const { reconcileSlackThreadLifecycle } = await import("./thread-lifecycle.js");
const subscription = new RuntimePromptSubscription({
  isRunning: () => true,
  canAcceptPrompt: () => true,
  getStreamingSessionCount: () => 0,
  markConsumerReady: () => {},
  handlePrompt: async (_session, prompt) => {
    appendFileSync(join(state, "handled.jsonl"), `${JSON.stringify(prompt)}\n`);
  },
});
// Exercise the real consumer admission boundary, with transport delivery supplied by the fixture.
const dispatch = subscription as unknown as {
  dispatchPrompt(session: string, prompt: RuntimeLaunchPrompt, msg: JsMsg): Promise<void>;
};
const brokerPath = join(state, "broker.json");
type Delivery = { id: string; acceptedAt: number; sequence: number; session: string; payload: Record<string, unknown> };
const deliveries: Delivery[] = existsSync(brokerPath) ? JSON.parse(readFileSync(brokerPath, "utf8")) : [];
async function consume(delivery: Delivery) {
  await dispatch.dispatchPrompt(
    delivery.session,
    delivery.payload as unknown as RuntimeLaunchPrompt,
    {
      subject: `ravi.session.${delivery.session}.prompt`,
      info: { stream: "SESSION_PROMPTS", streamSequence: delivery.sequence, timestampNanos: delivery.acceptedAt },
      ack() {},
      nak() {
        throw new Error("Unexpected rejection in crash fixture");
      },
    } as unknown as JsMsg,
  );
}
if (mode === "late-copy") {
  await consume({ ...deliveries[0]!, sequence: deliveries.length + 1 });
} else {
  const result = await reconcileSlackThreadLifecycle({
    now: () => now,
    publishEvent: async () => {},
    publishPrompt: async (session, payload, options) => {
      const id = options?.messageId;
      if (!id) throw new Error("Stable transport id required");
      const prior = [...deliveries].reverse().find((row) => row.id === id);
      // A fresh broker delivery after the 2-minute transport dedup window is NOT a redelivery.
      if (prior && now - prior.acceptedAt < 120_000) return;
      const delivery = { id, acceptedAt: now, sequence: deliveries.length + 1, session, payload };
      deliveries.push(delivery);
      writeFileSync(brokerPath, JSON.stringify(deliveries));
      if (mode === "crash-before-consume") process.exit(23);
      await consume(delivery);
      // Real process exit between broker acceptance and producer finishThreadTurnNotice.
      if (mode === "crash-after-consume") process.exit(23);
    },
  });
  if (result.failures) throw new Error(`Reconciliation failures: ${result.failures}`);
}
