import { ConsoleApiError } from "@/server/console/api-error";

export const SAFE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
export type OperationRecord = { id: string; requestHash: string; sessionHash: string; createdAt: Date };
export function validateOperationReplay(record: OperationRecord, requestHash: string, sessionHash: string, now = Date.now()) {
  if (record.requestHash !== requestHash || record.sessionHash !== sessionHash) {
    throw new ConsoleApiError(409, { error: "idempotency_conflict" });
  }
  if (record.createdAt.getTime() + SAFE_REPLAY_WINDOW_MS <= now) {
    throw new ConsoleApiError(409, { error: "executor_replay_expired" });
  }
}
