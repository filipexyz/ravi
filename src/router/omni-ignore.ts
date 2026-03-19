export const IGNORED_OMNI_INSTANCE_IDS_SETTING = "omni.ignoreInstanceIds";

function normalizeEntries(values: Iterable<unknown>): string[] {
  const normalized = new Set<string>();

  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    normalized.add(trimmed);
  }

  return [...normalized];
}

export function parseIgnoredOmniInstanceIds(value: string | null | undefined): string[] {
  if (!value) return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return normalizeEntries(parsed);
    if (typeof parsed === "string") return normalizeEntries([parsed]);
  } catch {
    return normalizeEntries(trimmed.split(/[,\n]/g));
  }

  return [];
}

export function serializeIgnoredOmniInstanceIds(ids: Iterable<string>): string {
  return JSON.stringify(normalizeEntries(ids).sort());
}

export function isIgnoredOmniInstanceId(
  ignoredInstanceIds: readonly string[] | undefined,
  instanceId: string,
): boolean {
  return ignoredInstanceIds?.includes(instanceId) ?? false;
}
