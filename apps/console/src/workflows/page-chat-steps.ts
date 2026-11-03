// Steps of the Page chat agent turn. Each one loads the turn logic lazily so
// the workflow bundle never evaluates database or model code; the logic and
// its tests live in src/server/console/pages/chat-rooms/agent/turn.ts.

export async function beginTurnStep(turnId: string) {
  "use step";
  const { beginTurn } = await import("@/server/console/pages/chat-rooms/agent/turn");
  return beginTurn(turnId);
}

export async function modelRoundStep(turnId: string) {
  "use step";
  const { runModelRound } = await import("@/server/console/pages/chat-rooms/agent/turn");
  return runModelRound(turnId);
}

export async function runToolStep(turnId: string, toolCallId: string) {
  "use step";
  const { runToolCall } = await import("@/server/console/pages/chat-rooms/agent/turn");
  await runToolCall(turnId, toolCallId);
}

export async function requestConfirmationStep(turnId: string, toolCallId: string) {
  "use step";
  const { requestConfirmation } = await import("@/server/console/pages/chat-rooms/agent/turn");
  return requestConfirmation(turnId, toolCallId);
}

export async function applyConfirmationStep(
  turnId: string,
  toolCallId: string,
  confirmationId: string,
  outcome: "confirmed" | "cancelled" | "expired",
) {
  "use step";
  const { applyConfirmation } = await import("@/server/console/pages/chat-rooms/agent/turn");
  await applyConfirmation(turnId, toolCallId, confirmationId, outcome);
}

export async function askRaviStep(turnId: string, toolCallId: string) {
  "use step";
  const { askRavi } = await import("@/server/console/pages/chat-rooms/agent/turn");
  return askRavi(turnId, toolCallId);
}

export async function checkRaviStep(turnId: string, toolCallId: string, requestId: string, last: boolean) {
  "use step";
  const { checkRaviReply } = await import("@/server/console/pages/chat-rooms/agent/turn");
  return checkRaviReply(turnId, toolCallId, requestId, last);
}

export async function startRaviFollowUpStep(turnId: string, requestId: string) {
  "use step";
  const { startRaviFollowUp } = await import("@/server/console/pages/chat-rooms/agent/runner");
  await startRaviFollowUp(turnId, requestId);
}

export async function postRaviFollowUpStep(turnId: string, requestId: string) {
  "use step";
  const { postRaviFollowUp } = await import("@/server/console/pages/chat-rooms/agent/turn");
  return postRaviFollowUp(turnId, requestId);
}

export async function finishTurnStep(turnId: string, outcome: "complete" | "failed", error: string | null) {
  "use step";
  const { finishTurn } = await import("@/server/console/pages/chat-rooms/agent/turn");
  await finishTurn(turnId, outcome, error);
}
