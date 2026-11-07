/** Trusted runner snapshot, carried with the prompt (or spawned shell). */
export interface CronRunAuthority {
  jobId: string;
  ownerPrincipal: string;
  /** Admission ceiling: a later identity link cannot promote this run. */
  ownerIsOperator: boolean;
  creatorChat?: string;
}

export const CRON_RUN_AUTHORITY_ENV = "RAVI_CRON_RUN_AUTHORITY";

/** Missing/malformed snapshots fail closed; never reconstruct from the live job. */
export function readCronRunAuthority(value: unknown, jobId: string): CronRunAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.jobId !== jobId ||
    typeof record.ownerPrincipal !== "string" ||
    !record.ownerPrincipal.trim() ||
    typeof record.ownerIsOperator !== "boolean" ||
    (record.creatorChat !== undefined && typeof record.creatorChat !== "string")
  )
    return null;
  return {
    jobId,
    ownerPrincipal: record.ownerPrincipal,
    ownerIsOperator: record.ownerIsOperator,
    ...(record.creatorChat ? { creatorChat: record.creatorChat as string } : {}),
  };
}

export function readSpawnedCronRunAuthority(env: NodeJS.ProcessEnv, jobId: string): CronRunAuthority | null {
  try {
    return readCronRunAuthority(JSON.parse(env[CRON_RUN_AUTHORITY_ENV] ?? "null"), jobId);
  } catch {
    return null;
  }
}
