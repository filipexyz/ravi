/**
 * Meeting assistant runner (spec `calendar/meeting-assistant`).
 *
 * Started by the daemon. While a `ravi login` session exists, at start and
 * every `RAVI_CALENDAR_ASSISTANT_INTERVAL_MS` (5 minutes) it reads the
 * operator's Console calendar and keeps one one-shot routine (a cron job on
 * the default agent's main session, run as the operator) per reminder that
 * `planCalendarReminders` asks for: the recording setup question, the prep
 * question the day before, the briefing before the start and the follow-up
 * once the recording is ready.
 *
 * Routines are scheduled at most 36 hours ahead; later ones come on a later
 * run. Each routine is named by its reminder key. A key is scheduled once: the
 * key is recorded here, so a routine that ran (and deleted itself) or that
 * the operator removed is not scheduled again. A routine still waiting whose
 * reminder is no longer wanted (the meeting moved, was cancelled or decided,
 * the setting was turned off) is removed and its key forgotten.
 */

import { isCloudAuthError } from "../cloud-auth/errors.js";
import { dbCreateCronJob, dbDeleteCronJob, dbListCronJobs } from "../cron/cron-db.js";
import type { CronJob, CronJobInput } from "../cron/types.js";
import { executeWrite } from "../db/write-retry.js";
import { CRON_OPERATOR_OWNER } from "../link/connector-turn.js";
import { nats } from "../nats.js";
import { getAgent } from "../router/config.js";
import { getDb, getDefaultAgentId } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { planCalendarReminders, CALENDAR_FOLLOWUP_MAX_AGE_MS, type CalendarReminder } from "./assistant.js";
import { CALENDAR_EVENTS_MAX_SPAN_MS, openCalendarConsoleClient, type CalendarConsoleClient } from "./console.js";

const log = logger.child("calendar:assistant");

export const CALENDAR_ROUTINE_PREFIX = "calendar:";
const DEFAULT_INTERVAL_MS = 5 * 60_000;
/** A routine never starts sooner than this after it is scheduled. */
const MIN_DELAY_MS = 10_000;
/** A routine about to run is left alone, even if its reminder went away. */
const KEEP_IF_DUE_WITHIN_MS = 60_000;
const MARK_RETENTION_MS = 45 * 24 * 3600 * 1000;
/** Routines are scheduled at most this far ahead, so `ravi cron list` holds only the next day or so. */
export const CALENDAR_ROUTINE_HORIZON_MS = 36 * 3600 * 1000;
const QUIET_CODES: ReadonlySet<string> = new Set([
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_INVALID",
  "INSTALLATION_REVOKED",
  "UNAUTHORIZED",
  "NOT_FOUND",
]);

export interface CalendarRoutineStore {
  list(): CronJob[];
  create(input: CronJobInput): CronJob;
  delete(id: string): boolean;
}

export interface CalendarAssistantRunnerOptions {
  intervalMs?: number;
  openClient?: () => CalendarConsoleClient | null;
  routines?: CalendarRoutineStore;
  emitRefresh?: () => Promise<void>;
  /** The agent whose main session runs the routines; defaults to the default agent. */
  agentId?: () => string | null;
  now?: () => number;
}

export interface CalendarAssistantTickResult {
  status: "ran" | "skipped" | "error";
  reason?: "no_login" | "no_agent";
  code?: string;
  created: number;
  removed: number;
}

export function calendarAssistantIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAVI_CALENDAR_ASSISTANT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_INTERVAL_MS;
}

export class CalendarAssistantRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<CalendarAssistantTickResult> | null = null;
  private readonly intervalMs: number;

  constructor(private readonly options: CalendarAssistantRunnerOptions = {}) {
    this.intervalMs = options.intervalMs ?? calendarAssistantIntervalMs();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting meeting assistant runner", { intervalMs: this.intervalMs });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log.info("Stopped meeting assistant runner");
  }

  tickOnce(): Promise<CalendarAssistantTickResult> {
    if (this.inFlight) return this.inFlight;
    const current = this.tick().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = current;
    return current;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickOnce()
        .catch((error) => log.error("Meeting assistant tick failed", { error: errorMessage(error) }))
        .finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<CalendarAssistantTickResult> {
    let client: CalendarConsoleClient | null;
    try {
      client = this.options.openClient ? this.options.openClient() : openCalendarConsoleClient();
    } catch {
      client = null;
    }
    if (!client) return { status: "skipped", reason: "no_login", created: 0, removed: 0 };
    const agentId = this.options.agentId ? this.options.agentId() : defaultRoutineAgent();
    if (!agentId) return { status: "skipped", reason: "no_agent", created: 0, removed: 0 };

    const now = (this.options.now ?? Date.now)();
    let reminders: CalendarReminder[];
    try {
      const overview = await client.overview();
      const synced = overview.connections.some((connection) => connection.settings.syncEnabled);
      const events = synced
        ? await client.events({
            from: new Date(now - CALENDAR_FOLLOWUP_MAX_AGE_MS),
            to: new Date(now - CALENDAR_FOLLOWUP_MAX_AGE_MS + CALENDAR_EVENTS_MAX_SPAN_MS),
          })
        : { events: [], truncated: false };
      reminders = planCalendarReminders({ overview, events: events.events, now });
    } catch (error) {
      const code = isCloudAuthError(error) ? error.code : "UNKNOWN";
      // A Console from before the calendar answers 404: nothing to do here yet.
      if (QUIET_CODES.has(code) || (isCloudAuthError(error) && error.status === 401)) {
        log.debug("Meeting assistant waiting for a login with the calendar", { code });
      } else {
        log.warn("Meeting assistant could not read the calendar", { code, error: errorMessage(error) });
      }
      return { status: "error", code, created: 0, removed: 0 };
    }
    const result = reconcileCalendarRoutines({
      reminders,
      agentId,
      now,
      routines: this.options.routines ?? defaultRoutineStore,
    });
    if (result.created > 0 || result.removed > 0) {
      log.info("Meeting assistant routines updated", result);
      try {
        await (this.options.emitRefresh ?? defaultEmitRefresh)();
      } catch (error) {
        log.warn("Could not signal the cron runner", { error: errorMessage(error) });
      }
    }
    return { status: "ran", ...result };
  }
}

/** Brings the routines in line with the wanted reminders; returns what changed. */
export function reconcileCalendarRoutines(input: {
  reminders: readonly CalendarReminder[];
  agentId: string;
  now: number;
  routines: CalendarRoutineStore;
}): { created: number; removed: number } {
  ensureCalendarAssistantSchema();
  const { now, routines } = input;
  const wanted = new Map(input.reminders.map((reminder) => [reminder.key, reminder]));
  let created = 0;
  let removed = 0;

  for (const job of routines.list()) {
    if (!job.name.startsWith(CALENDAR_ROUTINE_PREFIX) || wanted.has(job.name)) continue;
    if (!job.enabled || (job.nextRunAt ?? 0) <= now + KEEP_IF_DUE_WITHIN_MS) continue;
    if (routines.delete(job.id)) {
      forgetCalendarRoutine(job.name);
      removed += 1;
    }
  }

  for (const reminder of wanted.values()) {
    if (reminder.at > now + CALENDAR_ROUTINE_HORIZON_MS || calendarRoutineScheduled(reminder.key)) continue;
    routines.create({
      agentId: input.agentId,
      name: reminder.key,
      description: reminder.description,
      enabled: true,
      deleteAfterRun: true,
      schedule: { type: "at", at: Math.max(reminder.at, now + MIN_DELAY_MS) },
      sessionTarget: "main",
      message: reminder.message,
      ownerPrincipal: CRON_OPERATOR_OWNER,
    });
    rememberCalendarRoutine(reminder.key, now);
    created += 1;
  }

  pruneCalendarRoutineMarks(now);
  return { created, removed };
}

export function ensureCalendarAssistantSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS calendar_assistant_marks (
      key TEXT PRIMARY KEY,
      scheduled_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_assistant_marks_scheduled
      ON calendar_assistant_marks(scheduled_at);
  `);
}

export function calendarRoutineScheduled(key: string): boolean {
  ensureCalendarAssistantSchema();
  return Boolean(getDb().prepare("SELECT 1 FROM calendar_assistant_marks WHERE key = ?").get(key));
}

function rememberCalendarRoutine(key: string, now: number): void {
  executeWrite(
    getDb(),
    (db) => {
      db.prepare("INSERT OR IGNORE INTO calendar_assistant_marks (key, scheduled_at) VALUES (?, ?)").run(key, now);
    },
    { label: "calendar_assistant_mark" },
  );
}

function forgetCalendarRoutine(key: string): void {
  executeWrite(
    getDb(),
    (db) => {
      db.prepare("DELETE FROM calendar_assistant_marks WHERE key = ?").run(key);
    },
    { label: "calendar_assistant_unmark" },
  );
}

function pruneCalendarRoutineMarks(now: number): void {
  executeWrite(
    getDb(),
    (db) => {
      db.prepare("DELETE FROM calendar_assistant_marks WHERE scheduled_at < ?").run(now - MARK_RETENTION_MS);
    },
    { label: "calendar_assistant_prune" },
  );
}

const defaultRoutineStore: CalendarRoutineStore = {
  list: dbListCronJobs,
  create: dbCreateCronJob,
  delete: dbDeleteCronJob,
};

function defaultRoutineAgent(): string | null {
  const agentId = getDefaultAgentId();
  return getAgent(agentId) ? agentId : null;
}

async function defaultEmitRefresh(): Promise<void> {
  await nats.emit("ravi.cron.refresh", {});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let singleton: CalendarAssistantRunner | null = null;

export function getCalendarAssistantRunner(): CalendarAssistantRunner {
  singleton ??= new CalendarAssistantRunner();
  return singleton;
}

export async function startCalendarAssistantRunner(): Promise<void> {
  await getCalendarAssistantRunner().start();
}

export async function stopCalendarAssistantRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}
