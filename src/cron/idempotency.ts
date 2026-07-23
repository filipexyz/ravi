import {
  buildExplicitReactionActionKey,
  buildObserverReactionActionKey,
  executeIdempotentReactionAction,
  fingerprintReactionAction,
  type ReactionActionRecord,
} from "../policy/reaction-actions.js";
import { dbCreateCronJob, dbGetCronJob } from "./cron-db.js";
import type { CronJob, CronJobInput } from "./types.js";

export interface CronCreationIdempotency {
  explicitKey?: string;
  observer?: {
    ruleId: string;
    sourceTurnIds: string[];
  };
}

export interface CronCreationResult {
  created: boolean;
  targetId: string;
  job: CronJob | null;
  reaction?: ReactionActionRecord;
}

/** Create a cron once, retaining the reaction ledger even after a one-shot job deletes itself. */
export function createCronJobIdempotently(
  input: CronJobInput,
  idempotency?: CronCreationIdempotency,
): CronCreationResult {
  const actionType = "cron.add";
  const actionFingerprint = fingerprintReactionAction(input);
  const explicitKey = idempotency?.explicitKey;
  const key =
    explicitKey !== undefined
      ? buildExplicitReactionActionKey(explicitKey)
      : idempotency?.observer
        ? buildObserverReactionActionKey({
            ...idempotency.observer,
            actionType,
            actionFingerprint,
          })
        : null;

  if (!key) {
    const job = dbCreateCronJob(input);
    return { created: true, targetId: job.id, job };
  }

  const outcome = executeIdempotentReactionAction({
    ...key,
    actionType,
    actionFingerprint,
    execute: () => {
      const job = dbCreateCronJob(input);
      return { targetType: "cron", targetId: job.id };
    },
  });
  return {
    created: outcome.created,
    targetId: outcome.record.targetId,
    job: dbGetCronJob(outcome.record.targetId),
    reaction: outcome.record,
  };
}
