/**
 * Transport-level failures emitted by OpenAI-compatible provider clients.
 *
 * Ravi never produces these strings itself. They bubble up from the provider
 * client (pi with DeepSeek/OpenRouter/..., fetch/undici, node sockets) when the
 * connection dies before a response arrives: the turn ends with
 * `usage: 0`, `stopReason: "error"` and a message such as
 * `Error: Connection error.`
 *
 * Classification is deliberately a closed list of transport signatures. It is
 * never inferred from prompt prefixes (`[System]`) or from arbitrary free text,
 * so an unknown inbound/provider failure stays fail-closed.
 */
const TRANSPORT_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bconnection error\b/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bsocket hang up\b/i,
  /\bETIMEDOUT\b/,
  /\bfetch failed\b/i,
  // Node/undici AbortError text. Kept to the documented operation-abort form:
  // a bare `terminated` would also match unrelated provider text such as
  // `Request terminated by policy` and wrongly treat it as a transport drop.
  /\boperation was terminated\b/i,
  /\bnetwork error\b/i,
];

/** True when `message` carries a closed-list transport failure signature. */
export function isTransportFailureMessage(message: unknown): boolean {
  const text = typeof message === "string" ? message : message instanceof Error ? message.message : "";
  if (!text) return false;
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Runtime `failureKind` for a transport failure, or `undefined` when unknown. */
export function classifyTransportFailureKind(message: unknown): "transport" | undefined {
  return isTransportFailureMessage(message) ? "transport" : undefined;
}
