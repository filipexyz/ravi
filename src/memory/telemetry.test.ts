import { describe, expect, it } from "bun:test";
import { MEMORY_CURATION_CYCLE_TOPIC, emitCurationCycleEvent } from "./telemetry.js";

describe("emitCurationCycleEvent (R22 / R23)", () => {
  it("publishes to the canonical topic with the full telemetry payload", async () => {
    const captured: Array<{ topic: string; data: Record<string, unknown> }> = [];
    await emitCurationCycleEvent(
      {
        agentId: "ravi-dev",
        cadenceTurn: 10,
        proposed: 4,
        saved: 3,
        skipped: 1,
        stagedHitl: 0,
        consolidations: 0,
        sessionKey: "sess-1",
        hookId: "hook-abc",
        skipReasons: { "R4:env-failure": 1 },
      },
      {
        now: 1_700_000_000_000,
        publish: async (topic, data) => {
          captured.push({ topic, data });
        },
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.topic).toBe(MEMORY_CURATION_CYCLE_TOPIC);
    expect(captured[0]!.data).toMatchObject({
      emittedAt: 1_700_000_000_000,
      topic: MEMORY_CURATION_CYCLE_TOPIC,
      agentId: "ravi-dev",
      cadenceTurn: 10,
      proposed: 4,
      saved: 3,
      skipped: 1,
      sessionKey: "sess-1",
      hookId: "hook-abc",
      skipReasons: { "R4:env-failure": 1 },
      recallMiss: false,
    });
  });

  it("R23: flags recallMiss when hadUserCorrection is true but saved is zero", async () => {
    const captured: Array<{ data: Record<string, unknown> }> = [];
    await emitCurationCycleEvent(
      {
        agentId: "ravi-dev",
        cadenceTurn: 5,
        proposed: 1,
        saved: 0,
        skipped: 1,
        stagedHitl: 0,
        consolidations: 0,
        hadUserCorrection: true,
      },
      {
        publish: async (_topic, data) => {
          captured.push({ data });
        },
      },
    );
    expect(captured[0]!.data.recallMiss).toBe(true);
  });

  it("R23: does NOT flag recallMiss when the curator did save something", async () => {
    const captured: Array<{ data: Record<string, unknown> }> = [];
    await emitCurationCycleEvent(
      {
        agentId: "ravi-dev",
        cadenceTurn: 5,
        proposed: 2,
        saved: 2,
        skipped: 0,
        stagedHitl: 0,
        consolidations: 0,
        hadUserCorrection: true,
      },
      {
        publish: async (_topic, data) => {
          captured.push({ data });
        },
      },
    );
    expect(captured[0]!.data.recallMiss).toBe(false);
  });

  it("R2 best-effort: swallows publish errors so the curator flow is not blocked", async () => {
    await expect(
      emitCurationCycleEvent(
        {
          agentId: "ravi-dev",
          cadenceTurn: 1,
          proposed: 0,
          saved: 0,
          skipped: 0,
          stagedHitl: 0,
          consolidations: 0,
        },
        {
          publish: async () => {
            throw new Error("NATS down");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
