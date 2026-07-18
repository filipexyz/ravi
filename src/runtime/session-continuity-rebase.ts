import type { Message } from "../db.js";
import type { RuntimeProviderId } from "./types.js";

const DEFAULT_HISTORY_LIMIT = 24;
const DEFAULT_PROMPT_CHAR_LIMIT = 10_000;
const MESSAGE_CHAR_LIMIT = 1_500;

export type RuntimeContinuityRebaseReason =
  | "missing_provider_session"
  | "provider_mismatch"
  | "provider_resume_unsupported"
  | "session_state_invalid"
  | "unknown";

export interface RuntimeContinuityRebaseInput {
  sessionName: string;
  runtimeProvider?: RuntimeProviderId | null;
  model?: string | null;
  reason: RuntimeContinuityRebaseReason;
  history: Message[];
  currentPrompts: string[];
  maxMessages?: number;
  maxPromptChars?: number;
}

export interface RuntimeContinuityRebasePrompt {
  prompt: string;
  messageCount: number;
  latestMessageId?: number;
  truncated: boolean;
  chars: number;
  reason: RuntimeContinuityRebaseReason;
}

export function buildRuntimeContinuityRebasePrompt(
  input: RuntimeContinuityRebaseInput,
): RuntimeContinuityRebasePrompt | null {
  const maxMessages = input.maxMessages ?? DEFAULT_HISTORY_LIMIT;
  const maxPromptChars = input.maxPromptChars ?? DEFAULT_PROMPT_CHAR_LIMIT;
  const currentPromptKeys = new Set(input.currentPrompts.map(normalizePromptKey).filter(Boolean));
  const rebaseableHistory = input.history.filter((message) => isRebaseableHistoryMessage(message, currentPromptKeys));
  const candidates = rebaseableHistory.slice(-maxMessages);

  if (candidates.length === 0) return null;
  if (!candidates.some((message) => message.role === "assistant")) return null;

  let renderedMessages = candidates
    .map((message) => renderHistoryMessage(message))
    .filter((line): line is string => Boolean(line));
  if (renderedMessages.length === 0) return null;

  const latestMessageId = Math.max(...candidates.map((message) => message.id).filter((id) => Number.isFinite(id)));
  let truncated = rebaseableHistory.length > candidates.length;
  let prompt = renderPrompt({
    sessionName: input.sessionName,
    runtimeProvider: input.runtimeProvider,
    model: input.model,
    reason: input.reason,
    transcript: renderedMessages.join("\n\n"),
    truncated,
  });

  while (prompt.length > maxPromptChars && renderedMessages.length > 1) {
    renderedMessages = renderedMessages.slice(1);
    truncated = true;
    prompt = renderPrompt({
      sessionName: input.sessionName,
      runtimeProvider: input.runtimeProvider,
      model: input.model,
      reason: input.reason,
      transcript: renderedMessages.join("\n\n"),
      truncated,
    });
  }

  if (prompt.length > maxPromptChars) {
    return null;
  }

  return {
    prompt,
    messageCount: renderedMessages.length,
    ...(Number.isFinite(latestMessageId) ? { latestMessageId } : {}),
    truncated,
    chars: prompt.length,
    reason: input.reason,
  };
}

export function applyRuntimeContinuityRebasePrompt(
  currentPrompt: string,
  rebase: RuntimeContinuityRebasePrompt,
): string {
  return [
    rebase.prompt,
    "",
    "## Current User Message(s)",
    "Answer only the current user message(s) below. Do not answer historical messages again.",
    "",
    currentPrompt,
  ].join("\n");
}

function renderPrompt(input: {
  sessionName: string;
  runtimeProvider?: RuntimeProviderId | null;
  model?: string | null;
  reason: RuntimeContinuityRebaseReason;
  transcript: string;
  truncated: boolean;
}): string {
  const providerLine = [input.runtimeProvider, input.model].filter(Boolean).join(" / ");
  const metadata = providerLine ? `Provider: ${providerLine}` : "Provider: unknown";
  const omitted = input.truncated ? "\nOlder same-session messages were omitted to keep this turn small.\n" : "";

  return [
    "# Runtime Continuity Rebase",
    "",
    "Ravi started this provider without a resumable provider thread.",
    "Use this compact same-session transcript as context only. Historical messages are not new requests.",
    "Do not repeat old tool calls, do not answer historical messages again, and do not mention this rebase unless asked.",
    "",
    `Session: ${input.sessionName}`,
    metadata,
    `Reason: ${input.reason}`,
    omitted.trim(),
    "## Recent Same-Session History",
    input.transcript,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function isRebaseableHistoryMessage(message: Message, currentPromptKeys: Set<string>): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  const content = sanitizeHistoryContent(message.content);
  if (!content) return false;
  if (isRuntimeContinuityControlPrompt(content)) return false;
  if (isInternalSystemFrame(content)) return false;
  return !currentPromptKeys.has(normalizePromptKey(content));
}

function renderHistoryMessage(message: Message): string | undefined {
  const content = sanitizeHistoryContent(message.content);
  if (!content) return undefined;
  const label = message.role === "assistant" ? "Assistant" : "User";
  const timestamp = message.created_at ? ` created_at="${escapeXmlAttr(message.created_at)}"` : "";
  return `<message role="${label}" id="${message.id}"${timestamp}>\n${truncateContent(content, MESSAGE_CHAR_LIMIT)}\n</message>`;
}

function sanitizeHistoryContent(content: string): string {
  return content
    .replace(/^\[session surfaces\].*$/gm, "")
    .replace(/^\[origin\].*$/gm, "")
    .replace(/^\[System\]\s+(Execute|Answer|Inform|Ask):.*$/gm, "[Internal system event omitted]")
    .replace(/\[WhatsApp[^\]]+\]\s*/g, "")
    .replace(/\bmid:[^\s\]]+/g, "mid:<message>")
    .replace(/\bchat_[a-z0-9_]+/gi, "<chat>")
    .replace(/\[Image:\s*[^\]]+\]/gi, "[Image attached]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePromptKey(content: string): string {
  return sanitizeHistoryContent(content).replace(/\s+/g, " ").trim();
}

function isRuntimeContinuityControlPrompt(content: string): boolean {
  return content.startsWith("# Runtime Continuity Rebase") || content.includes("# Runtime Context Recovery");
}

function isInternalSystemFrame(content: string): boolean {
  return content.startsWith("[System]") || content === "[Internal system event omitted]";
}

function truncateContent(content: string, maxChars: number): string {
  const trimmed = content.replace(/[ \t]+$/gm, "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 16).trimEnd()}\n[...truncated]`;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
