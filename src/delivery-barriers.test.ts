import { describe, expect, it } from "bun:test";
import { inferDeliveryBarrier } from "./delivery-barriers.js";

describe("delivery barrier inference", () => {
  it("keeps explicit barriers authoritative", () => {
    expect(inferDeliveryBarrier({ prompt: "[System] Inform: oi", deliveryBarrier: "p0" })).toBe("immediate_interrupt");
  });

  it("treats system answers as immediate interrupt by default", () => {
    expect(inferDeliveryBarrier({ prompt: "[System] Answer: [from: dev] oi" })).toBe("immediate_interrupt");
  });

  it("treats system execute as after_task by default", () => {
    expect(inferDeliveryBarrier({ prompt: "[System] Execute: faz isso" })).toBe("after_task");
  });

  it("treats ask/inform as after_response by default", () => {
    expect(inferDeliveryBarrier({ prompt: "[System] Ask: [from: dev] pergunta" })).toBe("after_response");
    expect(inferDeliveryBarrier({ prompt: "[System] Inform: contexto" })).toBe("after_response");
  });

  it("treats human urgent signals as immediate interrupt", () => {
    expect(inferDeliveryBarrier({ prompt: "!! urgente", _humanUrgent: true })).toBe("immediate_interrupt");
  });

  it("treats supervisor sources as after_task", () => {
    expect(inferDeliveryBarrier({ prompt: "heartbeat", _heartbeat: true })).toBe("after_task");
    expect(inferDeliveryBarrier({ prompt: "trigger", _trigger: true })).toBe("after_task");
    expect(inferDeliveryBarrier({ prompt: "supervisor", _systemSupervisor: true })).toBe("after_task");
  });

  it("treats taskBarrierTaskId as after_task", () => {
    expect(inferDeliveryBarrier({ prompt: "dispatch", taskBarrierTaskId: "task-123" })).toBe("after_task");
  });

  it("falls back to after_tool for generic prompts", () => {
    expect(inferDeliveryBarrier({ prompt: "plain prompt" })).toBe("after_tool");
  });
});
