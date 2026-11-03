import type { JsonRecord } from "@/server/db/schema";

const RETRYABLE_OPERATION_ACTIONS = new Set([
  "create",
  "start",
  "stop",
  "restart",
  "backup",
  "restore",
  "rotate_controller",
]);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const BACKUP_REF_PATTERN = /^mbk_[a-f0-9]{32}$/;

export type ManagedRuntimeRetryOperation = {
  action: string;
  createdAt: Date;
  id: string;
  safeInputJson: JsonRecord;
  status: string;
};

export type ManagedRuntimeRetryResolution =
  | { ok: true; safeInput: JsonRecord }
  | {
      error:
        | "managed_runtime_retry_source_invalid"
        | "managed_runtime_retry_source_missing";
      ok: false;
    };

export function resolveManagedRuntimeRetrySafeInput(
  operations: ManagedRuntimeRetryOperation[],
): ManagedRuntimeRetryResolution {
  const failed = [...operations]
    .filter((operation) => operation.status === "failed")
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .at(0);
  if (!failed) {
    return { error: "managed_runtime_retry_source_missing", ok: false };
  }

  const retryAction = failed.action === "retry"
    ? failed.safeInputJson.retryAction
    : failed.action;
  const retryOperationId = failed.action === "retry"
    ? failed.safeInputJson.retryOperationId
    : failed.id;
  if (
    typeof retryAction !== "string" ||
    !RETRYABLE_OPERATION_ACTIONS.has(retryAction) ||
    typeof retryOperationId !== "string" ||
    !UUID_PATTERN.test(retryOperationId)
  ) {
    return { error: "managed_runtime_retry_source_invalid", ok: false };
  }

  const safeInput: JsonRecord = { retryAction, retryOperationId };
  if (retryAction === "restore") {
    const backupRef = failed.safeInputJson.backupRef;
    if (typeof backupRef !== "string" || !BACKUP_REF_PATTERN.test(backupRef)) {
      return { error: "managed_runtime_retry_source_invalid", ok: false };
    }
    safeInput.backupRef = backupRef;
  }
  if (
    retryAction === "create" &&
    typeof failed.safeInputJson.sizePreset === "string" &&
    SAFE_REF_PATTERN.test(failed.safeInputJson.sizePreset)
  ) {
    safeInput.sizePreset = failed.safeInputJson.sizePreset;
  }
  return { ok: true, safeInput };
}
