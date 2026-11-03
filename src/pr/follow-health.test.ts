import { expect, it } from "bun:test";
import { followFingerprint, requireFollowRuntime } from "./follow-health.js";
import type { Trigger } from "../triggers/types.js";

it("requires both live consumers and the current loaded follow, independently of fireCount", async () => {
  const trigger = {
    id: "trg_1",
    enabled: true,
    topic: "ravi.watch.github.>",
    replySession: "publisher",
    fireCount: 0,
  } as Trigger;
  await requireFollowRuntime(trigger, async (id) => {
    expect(id).toBe(trigger.id);
    return { running: true, producerRunning: true, fingerprint: followFingerprint(trigger) };
  });
  expect(followFingerprint({ ...trigger, fireCount: 10 })).toBe(followFingerprint(trigger));
  expect(followFingerprint({ ...trigger, replySession: "elsewhere" })).not.toBe(followFingerprint(trigger));
});

it("refuses old, unreachable, stopped, malformed and producer-less runtimes before mutation", async () => {
  for (const probe of [
    async () => {
      throw new Error("private transport diagnostic");
    },
    async () => ({}),
    async () => ({ running: false, producerRunning: true, fingerprint: null }),
    async () => ({ running: true, producerRunning: false, fingerprint: null }),
  ])
    await expect(requireFollowRuntime(undefined, probe)).rejects.toMatchObject({ code: "FOLLOW_RUNTIME_UNAVAILABLE" });
});
