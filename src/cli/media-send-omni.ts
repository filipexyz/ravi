/**
 * Legacy bridge media send (Telegram/Discord): spawns `omni send --media` with an
 * isolated Omni CLI auth config. Loaded by `sendChannelMedia` only for bridge instances,
 * through a dynamic import, so WhatsApp media never reaches this module.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOmniCliAuthEnv, materializeOmniCliAuthConfig, resolveOmniConnection } from "../omni-config.js";
import { isOmniCliAuthFailure, MediaSendAuthError } from "./media-send-auth.js";
import type { MediaType, ResolvedMediaSendTarget } from "./media-send.js";

export interface LegacyBridgeSendExecution {
  transport: "omni-send";
  args: string[];
  success: true;
  message?: string;
  messageId?: string;
  status?: string;
  raw?: unknown;
}

export interface OmniMediaSendInput {
  /** Absolute path of an existing file. */
  filePath: string;
  caption?: string;
  type: MediaType;
  voiceNote?: boolean;
  target: ResolvedMediaSendTarget;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractErrorMessage(json: Record<string, unknown> | null, fallback: string): string {
  if (!json) return fallback;
  const error = json.error;
  if (typeof error === "string" && error.trim()) return error;
  const message = json.message;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

export async function sendMediaWithOmniCli(input: OmniMediaSendInput): Promise<LegacyBridgeSendExecution> {
  const { target } = input;
  const omniArgs = ["send", "--instance", target.instanceId, "--to", target.chatId, "--media", input.filePath];

  if (input.caption) {
    omniArgs.push("--caption", input.caption);
  }
  if (input.voiceNote === true && input.type === "audio") {
    omniArgs.push("--voice");
  }
  if (target.threadId) {
    omniArgs.push("--thread-id", target.threadId);
  }

  const connection = resolveOmniConnection();
  const authDir = connection ? mkdtempSync(join(tmpdir(), "ravi-omni-cli-auth-")) : undefined;
  try {
    if (connection && authDir) {
      materializeOmniCliAuthConfig(connection, authDir);
    }

    return await new Promise<LegacyBridgeSendExecution>((resolveExecution, rejectExecution) => {
      const child = spawn("omni", omniArgs, {
        env: {
          ...process.env,
          OMNI_FORMAT: "json",
          ...(connection && authDir ? buildOmniCliAuthEnv(connection, authDir) : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          rejectExecution(new Error("omni CLI not found in PATH."));
          return;
        }
        rejectExecution(error);
      });
      child.on("close", (code) => {
        const stdoutJson = parseJsonObject(stdout);
        const stderrJson = parseJsonObject(stderr);

        if (code !== 0) {
          const fallback = stderr.trim() || stdout.trim() || `omni send failed with exit code ${code ?? "unknown"}.`;
          const message = extractErrorMessage(stderrJson ?? stdoutJson, fallback);
          if (isOmniCliAuthFailure(stderr, stdout, message)) {
            rejectExecution(new MediaSendAuthError());
            return;
          }
          rejectExecution(new Error(message));
          return;
        }

        if (!stdoutJson) {
          rejectExecution(new Error(`omni send returned non-JSON stdout: ${stdout.trim() || "<empty>"}`));
          return;
        }

        const data = stdoutJson.data;
        const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
        resolveExecution({
          transport: "omni-send",
          args: omniArgs,
          success: true,
          ...(typeof stdoutJson.message === "string" ? { message: stdoutJson.message } : {}),
          ...(raw && typeof raw.messageId === "string" ? { messageId: raw.messageId } : {}),
          ...(raw && typeof raw.status === "string" ? { status: raw.status } : {}),
          ...(raw ? { raw } : {}),
        });
      });
    });
  } finally {
    if (authDir) {
      rmSync(authDir, { recursive: true, force: true });
    }
  }
}
