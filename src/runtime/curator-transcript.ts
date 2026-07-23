import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message } from "../db.js";
import { logger } from "../utils/logger.js";

const log = logger.child("learning-loop:transcript");

export function sessionScopedCuratorTranscriptPath(agentCwd: string, sessionName: string, base: string): string {
  const safe = sessionName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "session";
  return `${agentCwd}/.curator-transcripts/${base}-${safe}.md`;
}

export function writeCuratorTranscript(
  path: string,
  messages: Message[],
  sinceMessageId: number,
  kind: "skills" | "memory",
): void {
  const header = `# Session transcript delta (${kind}) — messages.id > ${sinceMessageId}\n\n`;
  const body = messages
    .map((message) => `## msg#${message.id} — ${message.role} — ${message.created_at}\n\n${message.content}\n`)
    .join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, header + body, "utf-8");
  } catch (error) {
    log.warn("failed to write curator transcript (best-effort)", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
