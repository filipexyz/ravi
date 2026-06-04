export const DELIVERY_BARRIER_VALUES = ["immediate_interrupt", "after_tool", "after_response", "after_task"] as const;

export type DeliveryBarrier = (typeof DELIVERY_BARRIER_VALUES)[number];
export type DeliveryBarrierSource = "explicit" | "default" | "inferred";

export const DEFAULT_DELIVERY_BARRIER: DeliveryBarrier = "after_tool";

export interface DeliveryBarrierInferenceInput {
  deliveryBarrier?: string | DeliveryBarrier | null;
  prompt?: unknown;
  taskBarrierTaskId?: string | null;
  _humanUrgent?: unknown;
  _heartbeat?: unknown;
  _trigger?: unknown;
  _systemSupervisor?: unknown;
  _cron?: unknown;
  _hook?: unknown;
  _daemonRestartResume?: unknown;
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
  steer: "after_tool",
  steering: "after_tool",
  tool: "after_tool",
  after_tool: "after_tool",
  "after-tool": "after_tool",
  p2: "after_response",
  followup: "after_response",
  "follow-up": "after_response",
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

export function requireDeliveryBarrier(
  value: string | DeliveryBarrier | null | undefined,
  label = "deliveryBarrier",
): DeliveryBarrier {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  const barrier = normalizeDeliveryBarrier(value);
  if (!barrier) {
    throw new Error(`Unknown ${label}: ${value}. Use followup, steer, p0, p1, p2, p3 or the canonical barrier names.`);
  }
  return barrier;
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

  if (input._heartbeat || input._trigger || input._systemSupervisor || prompt.startsWith("[System] Execute:")) {
    return "after_task";
  }

  if (
    input._cron ||
    input._hook ||
    input._daemonRestartResume ||
    prompt.startsWith("[System] Ask:") ||
    prompt.startsWith("[System] Answer:") ||
    prompt.startsWith("[System] Inform:")
  ) {
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
