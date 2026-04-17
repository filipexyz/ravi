export const DELIVERY_BARRIER_VALUES = ["immediate_interrupt", "after_tool", "after_response", "after_task"] as const;

export type DeliveryBarrier = (typeof DELIVERY_BARRIER_VALUES)[number];

export const DEFAULT_DELIVERY_BARRIER: DeliveryBarrier = "after_tool";

export interface DeliveryBarrierInferenceInput {
  deliveryBarrier?: string | DeliveryBarrier | null;
  prompt?: unknown;
  taskBarrierTaskId?: string | null;
  _humanUrgent?: unknown;
  _heartbeat?: unknown;
  _trigger?: unknown;
  _systemSupervisor?: unknown;
}

const DELIVERY_BARRIER_PRIORITY: Record<DeliveryBarrier, number> = {
  immediate_interrupt: 0,
  after_tool: 1,
  after_response: 2,
  after_task: 3,
};

const DELIVERY_BARRIER_ALIASES: Record<string, DeliveryBarrier> = {
  p0: "immediate_interrupt",
  interrupt: "immediate_interrupt",
  immediate: "immediate_interrupt",
  now: "immediate_interrupt",
  p1: "after_tool",
  tool: "after_tool",
  after_tool: "after_tool",
  "after-tool": "after_tool",
  p2: "after_response",
  response: "after_response",
  after_response: "after_response",
  "after-response": "after_response",
  p3: "after_task",
  task: "after_task",
  after_task: "after_task",
  "after-task": "after_task",
};

export function normalizeDeliveryBarrier(value?: string | null): DeliveryBarrier | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return DELIVERY_BARRIER_ALIASES[normalized];
}

export function parseDeliveryBarrier(value?: string | null, fallback = DEFAULT_DELIVERY_BARRIER): DeliveryBarrier {
  return normalizeDeliveryBarrier(value) ?? fallback;
}

export function inferDeliveryBarrier(input: DeliveryBarrierInferenceInput): DeliveryBarrier {
  const explicit = normalizeDeliveryBarrier(
    typeof input.deliveryBarrier === "string" ? input.deliveryBarrier : (input.deliveryBarrier ?? undefined),
  );
  if (explicit) {
    return explicit;
  }

  if (input._humanUrgent) {
    return "immediate_interrupt";
  }

  if (input.taskBarrierTaskId) {
    return "after_task";
  }

  const prompt = typeof input.prompt === "string" ? input.prompt : "";

  if (prompt.startsWith("[System] Answer:")) {
    return "immediate_interrupt";
  }

  if (input._heartbeat || input._trigger || input._systemSupervisor || prompt.startsWith("[System] Execute:")) {
    return "after_task";
  }

  if (prompt.startsWith("[System] Ask:") || prompt.startsWith("[System] Inform:")) {
    return "after_response";
  }

  return DEFAULT_DELIVERY_BARRIER;
}

export function describeDeliveryBarrier(barrier: DeliveryBarrier): string {
  switch (barrier) {
    case "immediate_interrupt":
      return "p0/immediate_interrupt";
    case "after_tool":
      return "p1/after_tool";
    case "after_response":
      return "p2/after_response";
    case "after_task":
      return "p3/after_task";
  }
}

export function chooseMoreUrgentBarrier(left: DeliveryBarrier, right: DeliveryBarrier): DeliveryBarrier {
  return DELIVERY_BARRIER_PRIORITY[left] <= DELIVERY_BARRIER_PRIORITY[right] ? left : right;
}
