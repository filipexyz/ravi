import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeProviderId } from "./runtime/types.js";

export interface TranscriptLocatorInput {
  runtimeProvider?: RuntimeProviderId;
  providerSessionId?: string;
  sdkSessionId?: string;
  agentCwd?: string;
  remote?: string;
}

export interface TranscriptLocatorResult {
  path?: string;
  reason?: string;
}

export function locateRuntimeTranscript(input: TranscriptLocatorInput): TranscriptLocatorResult {
  const providerSessionId = input.providerSessionId ?? input.sdkSessionId;
  if (!providerSessionId) {
    return { reason: "No runtime session ID is available." };
  }

  if (input.remote) {
    return { reason: "Transcript lookup is not available for remote sessions." };
  }

  const provider = input.runtimeProvider ?? "claude";

  if (provider === "claude") {
    if (!input.agentCwd) {
      return { reason: "Agent working directory is unavailable." };
    }

    const escapedCwd = input.agentCwd.replace(/\//g, "-");
    const path = `${homedir()}/.claude/projects/${escapedCwd}/${providerSessionId}.jsonl`;
    return existsSync(path) ? { path } : { reason: `Transcript not found at ${path}` };
  }

  if (provider === "codex") {
    const path = findCodexSessionFile(providerSessionId);
    return path ? { path } : { reason: `Transcript not found under ${join(homedir(), ".codex", "sessions")}` };
  }

  return { reason: `Transcript lookup is unsupported for provider '${provider}'.` };
}

function findCodexSessionFile(sessionId: string): string | undefined {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) {
    return undefined;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = safeReadDir(current);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }

      if (!entry.isFile() || (!path.endsWith(".json") && !path.endsWith(".jsonl"))) {
        continue;
      }

      try {
        const raw = readFileSync(path, "utf8");
        if (extractCodexSessionId(raw, path) === sessionId) {
          return path;
        }
      } catch {
        // Ignore malformed or unrelated files.
      }
    }
  }

  return undefined;
}

function extractCodexSessionId(raw: string, path: string): string | undefined {
  if (path.endsWith(".jsonl")) {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          payload?: { id?: string };
          session?: { id?: string };
        };
        if (parsed.payload?.id) {
          return parsed.payload.id;
        }
        if (parsed.session?.id) {
          return parsed.session.id;
        }
      } catch {
        // Ignore malformed lines.
      }
    }
    return undefined;
  }

  const parsed = JSON.parse(raw) as {
    session?: { id?: string };
  };
  return parsed.session?.id;
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
