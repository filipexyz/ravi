/**
 * `--notify <session>` — the weekly operator message.
 *
 * The message is deliberately about the week, not the single run: GB freed per
 * class over the receipt window plus current disk usage. Delivery uses the same
 * session prompt publication path as cron agent jobs; in fixture mode the
 * message is written to `RAVI_STORAGE_FIXTURE_NOTIFY_OUT` instead so tests
 * never touch NATS.
 */

import { appendFileSync } from "node:fs";
import { formatGigabytes } from "./format.js";
import type { StorageSummary } from "./summary.js";

export interface StorageNotifyResult {
  target: string;
  delivered: boolean;
  message: string;
  error?: string;
}

export function formatStorageNotify(summary: StorageSummary): string {
  const classParts = Object.entries(summary.classes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => `${id} ${formatGigabytes(entry.freedBytes)}`)
    .join(", ");
  const disk = summary.disk
    ? `disco ${summary.disk.usedPercent}% usado (${formatGigabytes(summary.disk.availableBytes)} livres)`
    : "disco indisponível";
  return [
    `storage: ${formatGigabytes(summary.freedBytes)} liberados na semana`,
    classParts ? `por classe: ${classParts}` : "por classe: nenhuma liberação",
    disk,
  ].join(" | ");
}

export async function deliverStorageNotify(
  target: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageNotifyResult> {
  const out = env.RAVI_STORAGE_FIXTURE_NOTIFY_OUT?.trim();
  if (env.RAVI_STORAGE_FIXTURE_MODE === "1" && out) {
    try {
      appendFileSync(out, `${JSON.stringify({ target, message, at: new Date().toISOString() })}\n`, "utf8");
      return { target, delivered: true, message };
    } catch (error) {
      return {
        target,
        delivered: false,
        message,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const { publishSessionPrompt } = await import("../omni/session-stream.js");
    await publishSessionPrompt(target, {
      prompt: `[System] Inform: [from: storage:weekly] ${message}`,
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "explicit",
    });
    return { target, delivered: true, message };
  } catch (error) {
    return {
      target,
      delivered: false,
      message,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
