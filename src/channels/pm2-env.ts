import { spawnSync } from "node:child_process";
import { CHANNELS_PM2_PROCESS_NAME } from "../pm2.js";

const RUNNER_ENV_KEYS = [
  "RAVI_CHANNELS_CONSUME_OUTBOUND",
  "RAVI_SLACK_SUBSCRIPTION_SCOPE",
  "RAVI_SLACK_THREAD_REPLY_MODE",
  "RAVI_SLACK_ROOT_REPLY_MODE",
  "RAVI_SLACK_WORKING_REACTION",
  // WhatsApp runtime tuning (src/channels/whatsapp/lib/env.ts and runtime.ts).
  "WHATSAPP_HUMAN_DELAY_ENABLED",
  "WHATSAPP_HUMAN_DELAY_MIN_MS",
  "WHATSAPP_HUMAN_DELAY_MAX_MS",
  "WHATSAPP_TYPING_SIMULATION_ENABLED",
  "WHATSAPP_TYPING_DELAY_BASE_MS",
  "WHATSAPP_TYPING_DELAY_PER_CHAR_MS",
  "WHATSAPP_TYPING_DELAY_MAX_MS",
  "WHATSAPP_TYPING_DEFAULT_MS",
  "WHATSAPP_RATE_LIMIT_INITIAL_BACKOFF_MS",
  "WHATSAPP_RATE_LIMIT_MAX_BACKOFF_MS",
  "WHATSAPP_RATE_LIMIT_JITTER_FACTOR",
  "WHATSAPP_PREWARM_DEVICE_BATCH_SIZE",
  "WHATSAPP_PREWARM_SESSION_BATCH_SIZE",
  "WHATSAPP_AUTH_KEY_CACHE_MAX_ENTRIES",
  "WHATSAPP_MEDIA_MAX_DOWNLOAD_MB",
  "WHATSAPP_TRACK_GROUP_DECRYPT_FAILURES",
] as const;

function cleanEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readExistingPm2Env(processName: string): Record<string, unknown> {
  const result = spawnSync("pm2", ["jlist"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if ((result.status ?? 1) !== 0 || !result.stdout.trim()) return {};
  try {
    const list = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(list)) return {};
    const processInfo = list.find((item) => {
      return item && typeof item === "object" && (item as { name?: unknown }).name === processName;
    }) as { pm2_env?: { env?: Record<string, unknown> } } | undefined;
    return processInfo?.pm2_env?.env ?? {};
  } catch {
    return {};
  }
}

export function buildRunnerPm2Env(): Record<string, string> {
  const existingPm2Env = readExistingPm2Env(CHANNELS_PM2_PROCESS_NAME);
  const envOverrides: Record<string, string> = {};
  for (const key of RUNNER_ENV_KEYS) {
    const value = cleanEnvValue(process.env[key]) ?? cleanEnvValue(existingPm2Env[key]);
    if (value) envOverrides[key] = value;
  }
  return envOverrides;
}
