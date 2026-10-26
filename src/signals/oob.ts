import { publishSessionPrompt } from "../omni/session-stream.js";
import type { SignalRecord, SignalSeverity } from "./types.js";
import { effectiveSeverity, kindCeiling, minSeverity, producerClassCeiling } from "./validation.js";
import { budgetDay, dbAppendSignalEvent, dbRecordSignalSurface, dbUpdateSignal } from "./signal-db.js";
import { describeClearRule } from "./probes.js";
import { sendSignalPage } from "./page.js";

export interface DeliverOobResult {
  delivered: boolean;
  reason?: "below_oob" | "duplicate";
  route?: "oob" | "page";
  severity?: SignalSeverity;
  pageLine?: "sent" | "skipped_no_binding" | "failed";
}

export function buildSignalOobPrompt(
  signal: SignalRecord,
  severity: SignalSeverity,
  pageLine?: DeliverOobResult["pageLine"],
): string {
  const lines = [
    `[System] Inform: [signal:${signal.id}] ${severity} ${signal.title}.`,
    signal.detail ? signal.detail : "",
    `Closes when ${describeClearRule(signal.clearWhen)}.`,
    `Ack: ravi signals ack ${signal.id}.`,
  ].filter(Boolean);
  // Only a page that actually went out lets the agent skip the alert; an
  // interrupt has no page line, and a skipped or failed page reached nobody.
  if (pageLine === "sent") {
    lines.push(
      "The operator already received the one-line notice. Add context only; do not repeat the alert verbatim.",
    );
  } else if (severity === "interrupt" || severity === "page") {
    lines.push("The operator has not received a notice for this signal. Tell the operator now.");
  }
  return lines.join("\n");
}

export async function deliverSignalOob(input: {
  signal: SignalRecord;
  sessionName: string;
  now?: number;
  publishPrompt?: (sessionName: string, payload: Record<string, unknown>) => Promise<void>;
  sendPage?: (signal: SignalRecord, sessionName: string) => Promise<"sent" | "skipped_no_binding" | "failed">;
  routeSeverity?: SignalSeverity;
  bucket?: string;
}): Promise<DeliverOobResult> {
  const now = input.now ?? Date.now();
  const effective = effectiveSeverity(input.signal.severity, input.signal.kind, input.signal.producerClass);
  const ceiling = minSeverity(kindCeiling(input.signal.kind), producerClassCeiling(input.signal.producerClass));
  const deliverySeverity = minSeverity(input.routeSeverity ?? effective, ceiling);
  if (deliverySeverity !== "nudge" && deliverySeverity !== "interrupt" && deliverySeverity !== "page") {
    return { delivered: false, reason: "below_oob" };
  }
  const bucket = input.bucket ?? `${budgetDay(now)}:${input.signal.escalationCount + 1}`;
  const route = deliverySeverity === "page" ? "page" : "oob";
  const recorded = dbRecordSignalSurface({
    signalId: input.signal.id,
    route,
    sessionName: input.sessionName,
    bucket,
    now,
  });
  if (!recorded) {
    return { delivered: false, reason: "duplicate" };
  }

  input.signal.escalationCount += 1;
  input.signal.state = "surfaced";
  input.signal.surfacedAt = now;
  input.signal.version += 1;
  input.signal.updatedAt = now;
  dbUpdateSignal(input.signal);

  let pageLine: DeliverOobResult["pageLine"];
  if (deliverySeverity === "page") {
    const sender = input.sendPage ?? ((signal, sessionName) => sendSignalPage(signal, sessionName, bucket));
    pageLine = await sender(input.signal, input.sessionName).catch(() => "failed" as const);
  }

  const publish = input.publishPrompt ?? ((sessionName, payload) => publishSessionPrompt(sessionName, payload));
  await publish(input.sessionName, {
    prompt: buildSignalOobPrompt(input.signal, deliverySeverity, pageLine),
    deliveryBarrier: deliverySeverity === "nudge" ? "after_response" : "immediate_interrupt",
    deliveryBarrierSource: "explicit",
    _signal: {
      id: input.signal.id,
      key: input.signal.key,
      severity: deliverySeverity,
      route,
    },
  });

  dbAppendSignalEvent({
    signalId: input.signal.id,
    type: "signal.escalated",
    actorType: "system",
    actorId: "signals.tick",
    payload: {
      route,
      severity: deliverySeverity,
      sessionName: input.sessionName,
      escalation: input.signal.escalationCount,
      pageLine: pageLine ?? null,
    },
    now,
  });

  return { delivered: true, route, severity: deliverySeverity, pageLine };
}
