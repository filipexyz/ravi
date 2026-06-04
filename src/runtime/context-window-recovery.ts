import type { Message } from "../db.js";
import type { RuntimeProviderId } from "./types.js";

export const RUNTIME_CONTEXT_WINDOW_RECOVERY_REASON = "runtime_context_window_exhausted";

const DEFAULT_HISTORY_LIMIT = 36;
const DEFAULT_PROMPT_CHAR_LIMIT = 12_000;
const MESSAGE_CHAR_LIMIT = 1_200;

export interface RuntimeContextWindowFailure {
  kind: "context_window_exhausted";
  confidence: "medium" | "high";
  matched: string;
}

export interface RuntimeContextWindowFailureInput {
  runtimeProvider?: RuntimeProviderId | null;
  error?: string | null;
  rawEvent?: Record<string, unknown> | null;
}

export interface RuntimeContextRecoveryPromptInput {
  sessionName: string;
  runtimeProvider?: RuntimeProviderId | null;
  model?: string | null;
  error?: string | null;
  history: Message[];
  maxMessages?: number;
  maxPromptChars?: number;
}

export interface RuntimeContextRecoveryPrompt {
  prompt: string;
  messageCount: number;
  latestUserRequest?: string;
  truncated: boolean;
  chars: number;
}

export function classifyRuntimeContextWindowFailure(
  input: RuntimeContextWindowFailureInput,
): RuntimeContextWindowFailure | null {
  const text = collectFailureText(input).toLowerCase();
  if (!text) return null;

  const highConfidencePatterns: Array<[RegExp, string]> = [
    [/ran out of room in the model'?s context window/i, "codex_context_window"],
    [/context window/i, "context_window"],
    [/prompt is too long/i, "prompt_too_long"],
  ];
  for (const [pattern, matched] of highConfidencePatterns) {
    if (pattern.test(text)) {
      return { kind: "context_window_exhausted", confidence: "high", matched };
    }
  }

  const mediumConfidencePatterns: Array<[RegExp, string]> = [
    [/context length/i, "context_length"],
    [/context_limit/i, "context_limit"],
    [/maximum context/i, "maximum_context"],
    [/too many tokens/i, "too_many_tokens"],
    [/token(?:s)?\s+(?:limit|maximum|budget)/i, "token_limit"],
  ];
  for (const [pattern, matched] of mediumConfidencePatterns) {
    if (pattern.test(text)) {
      return { kind: "context_window_exhausted", confidence: "medium", matched };
    }
  }

  return null;
}

export function buildRuntimeContextRecoveryPrompt(
  input: RuntimeContextRecoveryPromptInput,
): RuntimeContextRecoveryPrompt {
  const maxMessages = input.maxMessages ?? DEFAULT_HISTORY_LIMIT;
  const maxPromptChars = input.maxPromptChars ?? DEFAULT_PROMPT_CHAR_LIMIT;
  const selected = input.history.slice(-maxMessages);
  const renderedMessages = selected
    .map((message) => renderHistoryMessage(message))
    .filter((line): line is string => Boolean(line));
  const latestUserRequest = findLatestUserRequest(selected);

  let transcript = renderedMessages.join("\n\n");
  let truncated = input.history.length > selected.length;
  let prompt = renderPrompt({
    sessionName: input.sessionName,
    runtimeProvider: input.runtimeProvider,
    model: input.model,
    latestUserRequest,
    transcript,
    truncated,
  });

  while (prompt.length > maxPromptChars && renderedMessages.length > 1) {
    renderedMessages.shift();
    transcript = renderedMessages.join("\n\n");
    truncated = true;
    prompt = renderPrompt({
      sessionName: input.sessionName,
      runtimeProvider: input.runtimeProvider,
      model: input.model,
      latestUserRequest,
      transcript,
      truncated,
    });
  }

  if (prompt.length > maxPromptChars) {
    const overflow = prompt.length - maxPromptChars;
    const clippedTranscript = transcript.slice(Math.min(transcript.length, overflow + 300));
    truncated = true;
    prompt = renderPrompt({
      sessionName: input.sessionName,
      runtimeProvider: input.runtimeProvider,
      model: input.model,
      latestUserRequest,
      transcript: clippedTranscript,
      truncated,
    });
  }

  return {
    prompt,
    messageCount: renderedMessages.length,
    ...(latestUserRequest ? { latestUserRequest } : {}),
    truncated,
    chars: prompt.length,
  };
}

function renderPrompt(input: {
  sessionName: string;
  runtimeProvider?: RuntimeProviderId | null;
  model?: string | null;
  latestUserRequest?: string;
  transcript: string;
  truncated: boolean;
}): string {
  const providerLine = [input.runtimeProvider, input.model].filter(Boolean).join(" / ");
  const metadata = providerLine ? `Previous runtime: ${providerLine}` : "Previous runtime: unknown";
  const omitted = input.truncated ? "\nOlder recovered messages were omitted to keep this first turn small.\n" : "";

  return [
    "# Runtime Context Recovery",
    "",
    "The previous provider thread exhausted its context window. Ravi cleared only provider state and started a fresh provider session.",
    "Use this compact same-session transcript as recovered context. Historical messages are not new requests.",
    "Do not mention recovery mechanics unless the user asks.",
    "",
    `Session: ${input.sessionName}`,
    metadata,
    omitted.trim(),
    "## Latest User Request",
    input.latestUserRequest ?? "(No recent user request was available in local history.)",
    "",
    "## Compact Recent History",
    input.transcript || "(No local message history was available.)",
    "",
    "## Continuation Instructions",
    "- Continue from the latest user request.",
    "- Preserve commitments already made in the recent history.",
    "- If previous work may have created files or side effects, inspect the workspace before repeating actions.",
    "- Prefer the next concrete step over explaining the recovery.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderHistoryMessage(message: Message): string | undefined {
  const content = sanitizeHistoryContent(message.content);
  if (!content) return undefined;
  const label = message.role === "assistant" ? "Assistant" : "User";
  const timestamp = message.created_at ? ` (${message.created_at})` : "";
  return `${label}${timestamp}:\n${truncateContent(content, MESSAGE_CHAR_LIMIT)}`;
}

function findLatestUserRequest(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const content = sanitizeHistoryContent(messages[index]?.content ?? "");
    if (content) return truncateContent(content, 2_000);
  }
  return undefined;
}

function sanitizeHistoryContent(content: string): string {
  return content
    .replace(/^\[session surfaces\].*$/gm, "")
    .replace(/^\[origin\].*$/gm, "")
    .replace(/\[WhatsApp[^\]]+\]\s*/g, "")
    .replace(/\bmid:[^\s\]]+/g, "mid:<message>")
    .replace(/\bchat_[a-z0-9_]+/gi, "<chat>")
    .replace(/\[Image:\s*[^\]]+\]/gi, "[Image attached]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateContent(content: string, maxChars: number): string {
  const trimmed = content.replace(/[ \t]+$/gm, "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 16).trimEnd()}\n[...truncated]`;
}

function collectFailureText(input: RuntimeContextWindowFailureInput): string {
  const parts: string[] = [];
  if (input.runtimeProvider) parts.push(String(input.runtimeProvider));
  if (input.error) parts.push(input.error);
  collectRawText(input.rawEvent, parts, 0);
  return parts.join("\n");
}

function collectRawText(value: unknown, parts: string[], depth: number): void {
  if (depth > 4 || value === undefined || value === null) return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      collectRawText(item, parts, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["type", "subtype", "status", "code", "error", "errors", "message", "result", "detail"]) {
    collectRawText(record[key], parts, depth + 1);
  }
}
