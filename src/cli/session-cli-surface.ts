import { SILENT_TOKEN } from "../prompt-builder.js";
import type { RuntimeEffort } from "../runtime/effort.js";
import { CLI_SESSION_BOOTSTRAP_EFFORT } from "../runtime/effort.js";

export const CLI_TRANSCRIPT_PERSIST_TIMEOUT_MS = 5_000;
export const CLI_TRANSCRIPT_PERSIST_POLL_MS = 25;

export interface SessionSendPromptInput {
  prompt: string;
  raw?: boolean;
  callerSessionKey?: string;
}

export interface CliWaitDestinationInput {
  channelOverride?: string;
  toOverride?: string;
  source?: { channel?: string; chatId?: string } | null;
  hasOutputAttachment?: boolean;
}

export interface TranscriptMessageLike {
  id: number;
  role: string;
  content: string;
}

export interface WaitForThisTurnAssistantInput {
  afterId: number;
  readMessages: () => TranscriptMessageLike[];
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function isOperatorCliSend(input: SessionSendPromptInput): boolean {
  return !input.callerSessionKey && !input.raw;
}

export function buildSessionSendPrompt(input: SessionSendPromptInput): string {
  if (input.raw) return input.prompt;
  if (input.callerSessionKey) {
    return `[System] Inform: [from: ${input.callerSessionKey}] ${input.prompt}`;
  }
  return input.prompt;
}

export function isCliWaitDestination(input: CliWaitDestinationInput): boolean {
  if (input.channelOverride?.trim() || input.toOverride?.trim()) return false;
  if (input.source?.channel?.trim() && input.source?.chatId?.trim()) return false;
  // Default output attach is not a chat destination for operator session-relay.
  // Persist + `sessions.read` / CLI transcript are the sink.
  return true;
}

export function sanitizeCliAssistantText(text: string): string {
  return text.split(SILENT_TOKEN).join("").trim();
}

export function snapshotTranscriptCursor(messages: Array<{ id: number }>): number {
  return messages.reduce((max, message) => Math.max(max, message.id), 0);
}

export function readThisTurnAssistantText(messages: TranscriptMessageLike[], afterId: number): { text: string } | null {
  const assistantParts = messages
    .filter((message) => message.id > afterId && message.role === "assistant")
    .map((message) => sanitizeCliAssistantText(message.content))
    .filter((text) => text.length > 0);
  if (assistantParts.length === 0) return null;
  return { text: assistantParts.join("\n\n") };
}

export async function waitForThisTurnAssistantText(input: WaitForThisTurnAssistantInput): Promise<string | null> {
  const timeoutMs = input.timeoutMs ?? CLI_TRANSCRIPT_PERSIST_TIMEOUT_MS;
  const pollMs = input.pollMs ?? CLI_TRANSCRIPT_PERSIST_POLL_MS;
  const sleep = input.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = readThisTurnAssistantText(input.readMessages(), input.afterId);
    if (found) return found.text;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

export function omitSkillVisibilityFromSessionJson(sessionJson: Record<string, unknown>): Record<string, unknown> {
  const params = sessionJson.runtimeSessionParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return sessionJson;
  }
  const { skillVisibility: _skillVisibility, ...rest } = params as Record<string, unknown>;
  return {
    ...sessionJson,
    runtimeSessionParams: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

export function resolveCliSessionBootstrapEffort(input: {
  createdSession: boolean;
  cliDestination: boolean;
  explicitEffort?: RuntimeEffort;
}): RuntimeEffort | undefined {
  if (input.explicitEffort) return input.explicitEffort;
  if (input.createdSession && input.cliDestination) return CLI_SESSION_BOOTSTRAP_EFFORT;
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
