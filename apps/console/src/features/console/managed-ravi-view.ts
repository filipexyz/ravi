import type {
  ManagedRaviAggregate,
  ManagedRaviCommand,
  ManagedRaviOperationAction,
  ManagedRaviSessionEvent,
} from "./types";

export type ManagedRaviChatMessage = {
  id: string;
  role: "assistant" | "system" | "user";
  text: string;
};

export type ManagedRaviFailureDiagnostic = {
  action: ManagedRaviOperationAction | null;
  code: string;
  completedAt: string;
  guidance: string;
  operationId: string | null;
  phase: string | null;
  retryable: boolean;
  summary: string;
};

export function managedRaviLifecycleActions(
  aggregate: ManagedRaviAggregate,
): ManagedRaviOperationAction[] {
  const state = aggregate.instance.observedState;
  if (["deleted", "deleting", "provisioning", "starting", "stopping", "restarting"].includes(state)) {
    return [];
  }
  if (state === "ready") return ["stop", "restart", "backup", "delete"];
  if (state === "stopped") {
    return aggregate.backups.length > 0
      ? ["start", "backup", "restore", "delete"]
      : ["start", "backup", "delete"];
  }
  if (state === "failed" || state === "degraded") return ["retry", "delete"];
  return ["delete"];
}

export function managedRaviTranscript(
  commands: ManagedRaviCommand[],
): ManagedRaviChatMessage[] {
  const sorted = [...commands].sort(
    (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
  );
  const history = [...sorted]
    .reverse()
    .map((command) => historyMessages(command.result))
    .find((messages) => messages.length > 0);

  if (history) return history;

  return sorted.flatMap((command) => {
    if (command.action !== "prompt_send") return [];
    const prompt = stringValue(command.input.prompt);
    if (!prompt) return [];
    const messages: ManagedRaviChatMessage[] = [
      { id: `${command.id}:prompt`, role: "user", text: prompt },
    ];
    if (command.status === "failed") {
      messages.push({
        id: `${command.id}:failure`,
        role: "system",
        text: readableCode(command.failureCode ?? "managed_runtime_prompt_failed"),
      });
    }
    return messages;
  });
}

export function managedRaviLiveText(event: ManagedRaviSessionEvent) {
  if (!/(response|stream|assistant)/i.test(event.eventType)) return null;
  return findText(event.payload);
}

export function managedRaviReadableState(aggregate: ManagedRaviAggregate) {
  const state = aggregate.instance.observedState;
  if (state === "ready" && aggregate.connections.some((connection) => connection.status === "online")) {
    return "Ready";
  }
  return readableCode(state);
}

export function managedRaviFailureDiagnostic(
  aggregate: ManagedRaviAggregate,
): ManagedRaviFailureDiagnostic | null {
  const operation = aggregate.latestOperation;
  if (operation && ["pending", "claimed", "running", "succeeded"].includes(operation.status)) {
    return null;
  }
  const failedOperation = operation?.status === "failed" ? operation : null;
  const code = failedOperation?.failureCode ?? aggregate.instance.failureCode;
  if (!code) return null;

  const retryable = managedRaviLifecycleActions(aggregate).includes("retry");
  const action = failedOperation?.action ?? null;
  return {
    action,
    code,
    completedAt:
      failedOperation?.completedAt
      ?? failedOperation?.updatedAt
      ?? aggregate.instance.updatedAt,
    guidance: retryable
      ? action === "create" || action === "retry"
        ? "Retry resumes from the last verified phase without allocating a duplicate VM."
        : "Retry resumes this Ravi from its last verified state."
      : "Copy the operation reference to correlate this failure with runtime diagnostics.",
    operationId: failedOperation?.id ?? null,
    phase: failedOperation?.phase ?? aggregate.instance.provisioningPhase,
    retryable,
    summary: readableCode(code),
  };
}

export function readableCode(value: string) {
  return value
    .replace(/^managed_runtime_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function historyMessages(result: Record<string, unknown> | null) {
  const history = recordValue(result?.history);
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  return messages.flatMap((value, index): ManagedRaviChatMessage[] => {
    const message = recordValue(value);
    if (!message) return [];
    const role = roleValue(message.role);
    const text = stringValue(message.text) ?? stringValue(message.content);
    if (!role || !text) return [];
    return [{ id: `history:${index}:${role}`, role, text }];
  });
}

function findText(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => findText(item, depth + 1))
      .filter((item): item is string => Boolean(item));
    return items.length > 0 ? items.join("") : null;
  }
  const record = recordValue(value);
  if (!record) return null;
  for (const key of ["text", "content", "message", "delta", "output", "data"]) {
    const text = findText(record[key], depth + 1);
    if (text) return text;
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function roleValue(value: unknown): ManagedRaviChatMessage["role"] | null {
  return value === "assistant" || value === "system" || value === "user"
    ? value
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
