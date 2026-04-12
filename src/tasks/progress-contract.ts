const TASK_PROGRESS_MESSAGE_PLACEHOLDERS = new Set([
  "wip",
  "progress",
  "update",
  "updating",
  "working",
  "todo",
  "tbd",
  "na",
  "n/a",
  "ok",
]);

export function normalizeTaskProgressMessage(value?: string | null): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  const contentLength = (normalized.match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/g) ?? []).length;
  const letterCount = (normalized.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) ?? []).length;
  if (contentLength < 5 || letterCount < 3) {
    return undefined;
  }

  if (TASK_PROGRESS_MESSAGE_PLACEHOLDERS.has(normalized.toLowerCase())) {
    return undefined;
  }

  return normalized;
}

export function requireTaskProgressMessage(
  value: string | null | undefined,
  errorMessage = "Task progress requires a descriptive message.",
): string {
  const normalized = normalizeTaskProgressMessage(value);
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
}
