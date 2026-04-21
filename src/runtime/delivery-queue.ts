import { DEFAULT_DELIVERY_BARRIER, type DeliveryBarrier } from "../delivery-barriers.js";
import type { RuntimeTraceTurnStartResult } from "../session-trace/runtime-trace.js";
import { dbHasActiveTaskForSession } from "../tasks/task-db.js";
import { logger } from "../utils/logger.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { RuntimePromptMessage } from "./types.js";

const log = logger.child("runtime:delivery-queue");

export interface RuntimePromptDeliveryMessage {
  prompt: string;
  deliveryBarrier?: DeliveryBarrier;
  taskBarrierTaskId?: string;
}

export function getRuntimePromptDeliveryBarrier(prompt: RuntimePromptDeliveryMessage): DeliveryBarrier {
  return prompt.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;
}

export function createQueuedRuntimeUserMessage(prompt: RuntimePromptDeliveryMessage): RuntimeUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt.prompt },
    session_id: "",
    parent_tool_use_id: null,
    deliveryBarrier: getRuntimePromptDeliveryBarrier(prompt),
    taskBarrierTaskId: prompt.taskBarrierTaskId,
    pendingId: Math.random().toString(36).slice(2, 10),
    queuedAt: Date.now(),
  };
}

function isGeneratingText(session: RuntimeHostStreamingSession): boolean {
  return !session.done && session.turnActive && !session.compacting && !session.toolRunning;
}

export function canReleaseRuntimeDeliveryBarrier(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  barrier: DeliveryBarrier,
  taskBarrierTaskId?: string,
  hasActiveTask = dbHasActiveTaskForSession(sessionName, taskBarrierTaskId),
): boolean {
  switch (barrier) {
    case "immediate_interrupt":
      if (session.starting || session.compacting) return false;
      if (session.toolRunning && session.currentToolSafety === "unsafe") return false;
      return true;
    case "after_tool":
      return !session.starting && !session.compacting && !session.toolRunning;
    case "after_response":
      return !session.starting && !session.compacting && !session.toolRunning && !isGeneratingText(session);
    case "after_task":
      return (
        !hasActiveTask && !session.starting && !session.compacting && !session.toolRunning && !isGeneratingText(session)
      );
  }
}

export function getDeliverableRuntimeMessages(
  sessionName: string,
  session: RuntimeHostStreamingSession,
): RuntimeUserMessage[] {
  if (session.pendingMessages.length === 0) {
    return [];
  }

  const activeTaskByExemption = new Map<string, boolean>();
  return session.pendingMessages.filter((message) =>
    canReleaseRuntimeDeliveryBarrier(
      sessionName,
      session,
      message.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER,
      message.taskBarrierTaskId,
      (() => {
        const key = message.taskBarrierTaskId ?? "__default__";
        if (!activeTaskByExemption.has(key)) {
          activeTaskByExemption.set(key, dbHasActiveTaskForSession(sessionName, message.taskBarrierTaskId));
        }
        return activeTaskByExemption.get(key) ?? false;
      })(),
    ),
  );
}

export function hasDeliverableRuntimeMessages(sessionName: string, session: RuntimeHostStreamingSession): boolean {
  return getDeliverableRuntimeMessages(sessionName, session).length > 0;
}

export function shouldInterruptRuntimeForIncoming(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  barrier: DeliveryBarrier,
  taskBarrierTaskId?: string,
): { interrupt: boolean; reason: string } {
  if (session.pushMessage) {
    return { interrupt: false, reason: "waiting" };
  }
  if (session.starting) {
    return { interrupt: false, reason: "starting" };
  }
  if (barrier === "after_task" && dbHasActiveTaskForSession(sessionName, taskBarrierTaskId)) {
    return { interrupt: false, reason: "active_task" };
  }
  if (session.compacting) {
    return { interrupt: false, reason: "compacting" };
  }
  if (session.toolRunning) {
    if (barrier !== "immediate_interrupt") {
      return { interrupt: false, reason: "tool" };
    }
    if (session.currentToolSafety === "unsafe") {
      return { interrupt: false, reason: "unsafe_tool" };
    }
    return { interrupt: true, reason: "safe_tool" };
  }
  if (barrier === "after_response" || barrier === "after_task") {
    return { interrupt: false, reason: "response" };
  }
  return { interrupt: true, reason: "response" };
}

export function wakeRuntimeSessionIfDeliverable(
  sessionName: string,
  streamingSessions: Map<string, RuntimeHostStreamingSession>,
): void {
  const session = streamingSessions.get(sessionName);
  if (!session || !session.pushMessage) {
    if (session) {
      session.pendingWake = true;
    }
    return;
  }
  if (!hasDeliverableRuntimeMessages(sessionName, session)) {
    return;
  }
  const resolver = session.pushMessage;
  session.pushMessage = null;
  session.pendingWake = false;
  resolver(null);
}

export interface RuntimeMessageGeneratorOptions {
  sessionName: string;
  session: RuntimeHostStreamingSession;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  traceTurnStart?: (input: {
    combinedPrompt: string;
    deliverableMessages: RuntimeUserMessage[];
  }) => Promise<RuntimeTraceTurnStartResult | null | undefined> | RuntimeTraceTurnStartResult | null | undefined;
}

export async function* createRuntimeMessageGenerator({
  sessionName,
  session,
  stashedMessages,
  traceTurnStart,
}: RuntimeMessageGeneratorOptions): AsyncGenerator<RuntimePromptMessage> {
  const stashed = stashedMessages.get(sessionName);
  if (stashed && stashed.length > 0) {
    log.info("Re-injecting stashed messages", { sessionName, count: stashed.length });
    for (const message of [...stashed].reverse()) {
      session.pendingMessages.unshift({ ...message });
    }
    stashedMessages.delete(sessionName);
  }

  while (!session.done) {
    const deliverable = getDeliverableRuntimeMessages(sessionName, session);

    if (deliverable.length === 0) {
      if (session.pendingWake) {
        session.pendingWake = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        session.pushMessage = () => {
          session.pendingWake = false;
          resolve();
        };
      });
      if (session.pendingMessages.length === 0 && session.done) break;
      continue;
    }

    const yieldedIds = new Set(
      deliverable.map((message) => message.pendingId).filter((pendingId): pendingId is string => Boolean(pendingId)),
    );
    session.currentTurnPendingIds = [...yieldedIds];
    const combined = deliverable.map((m) => m.message.content).join("\n\n");
    log.info("Generator: yielding", {
      sessionName,
      count: deliverable.length,
      queued: session.pendingMessages.length,
    });

    const turnCompleted = new Promise<void>((resolve) => {
      session.onTurnComplete = resolve;
    });
    session.turnActive = true;
    session.currentTraceTurnTerminalRecorded = false;

    if (traceTurnStart) {
      try {
        const traceTurn = await traceTurnStart({
          combinedPrompt: combined,
          deliverableMessages: deliverable.map((message) => ({ ...message })),
        });
        if (traceTurn) {
          session.currentTraceTurnId = traceTurn.turnId;
          session.currentTraceTurnStartedAt = traceTurn.startedAt;
          session.currentTraceUserPromptSha256 = traceTurn.userPromptSha256;
          session.currentTraceSystemPromptSha256 = traceTurn.systemPromptSha256;
          session.currentTraceRequestBlobSha256 = traceTurn.requestBlobSha256;
        }
      } catch (error) {
        log.warn("Generator: failed to trace turn start", { sessionName, error });
      }
    }

    yield {
      type: "user" as const,
      message: { role: "user" as const, content: combined },
      session_id: "",
      parent_tool_use_id: null,
    };

    await turnCompleted;

    if (session.interrupted) {
      log.info("Generator: turn interrupted, keeping queue", {
        sessionName,
        count: session.pendingMessages.length,
      });
      session.interrupted = false;
    } else {
      session.pendingMessages = session.pendingMessages.filter(
        (message) => !message.pendingId || !yieldedIds.has(message.pendingId),
      );
      log.info("Generator: turn complete", {
        sessionName,
        cleared: deliverable.length,
        remaining: session.pendingMessages.length,
      });
    }
    session.currentTurnPendingIds = undefined;
  }
}
