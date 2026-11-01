/**
 * Attribute long-lived reads and WAL checkpoint pins.
 *
 * `instrumentSlowQueries` reports a query only after it returns, so a read that
 * holds the WAL snapshot (an in-flight statement, an open transaction) is
 * invisible while it blocks checkpoint backfill. This watchdog keeps a registry
 * of in-flight operations, periodically reports the ones still open, and dumps
 * them when the `-shm` checkpoint marks stay pinned while the WAL grows (the
 * signal a reader is holding back the checkpoint).
 */

import { readFileSync } from "node:fs";
import { logger } from "../utils/logger.js";

const log = logger.child("router:db");

export interface OpenDbOperation {
  kind: "statement" | "transaction";
  sql?: string;
  caller: string;
  startedAt: number;
}

export interface LongDbOperation extends OpenDbOperation {
  ms: number;
}

export interface WalMarks {
  mxFrame: number;
  backfill: number;
  marks: number[];
}

export interface PinnedWalReport {
  lagFrames: number;
  mxFrame: number;
  marks: number[];
  openOperations: LongDbOperation[];
}

export interface ReadWatchdogOptions {
  /** Path of the SQLite database whose `-shm` marks are watched. */
  dbPath?: string;
  /** Report operations open at least this long (default 15s). */
  warnMs?: number;
  /** Scan interval (default 10s). */
  intervalMs?: number;
  /** Test seam: read the WAL marks. */
  marksReader?: (dbPath: string) => WalMarks | null;
  /**
   * Probe a PASSIVE checkpoint. A busy result with a growing backlog is the
   * only reliable signal: a reader using WAL read-lock slot 0 blocks backfill
   * without leaving a visible read mark.
   */
  checkpointProbe?: () => { busy: number; log: number; checkpointed: number } | null;
  onLongOperations?: (operations: LongDbOperation[]) => void;
  onPinnedWal?: (report: PinnedWalReport) => void;
  startTimer?: boolean;
}

export interface ReadWatchdog {
  begin(kind: OpenDbOperation["kind"], sql?: string, caller?: string): number;
  finish(id: number): void;
  scan(now?: number): void;
  snapshot(now?: number): LongDbOperation[];
  dispose(): void;
}

const PINNED_LAG_FRAMES = 500;
const PINNED_MIN_GROWTH_FRAMES = 100;
const PINNED_MIN_AGE_MS = 20_000;

/** Read the two WalIndexHdr copies and the WalCkptInfo marks from the -shm file. */
export function readWalMarks(dbPath: string): WalMarks | null {
  try {
    const buffer = readFileSync(`${dbPath}-shm`);
    if (buffer.length < 120) return null;
    const headerA = buffer.readUInt32LE(16);
    const headerB = buffer.readUInt32LE(64);
    const mxFrame = Math.max(headerA, headerB);
    const backfill = buffer.readUInt32LE(96);
    const marks: number[] = [];
    for (let slot = 0; slot < 5; slot += 1) {
      const mark = buffer.readUInt32LE(100 + slot * 4);
      if (mark !== 0 && mark !== 0xffffffff) marks.push(mark);
    }
    return { mxFrame, backfill, marks };
  } catch {
    return null;
  }
}

function formatCaller(error: Error | undefined, skip = 0): string {
  const stack = error?.stack ?? "";
  return stack
    .split("\n")
    .slice(1 + skip, 4 + skip)
    .map((line) => line.trim().replace(/^at\s+/, ""))
    .join(" <- ");
}

export function createReadWatchdog(options: ReadWatchdogOptions = {}): ReadWatchdog {
  const warnMs = options.warnMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 10_000;
  const marksReader = options.marksReader ?? readWalMarks;
  const operations = new Map<number, OpenDbOperation & { callerError?: Error; callerLabel?: string }>();
  let sequence = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const pinnedSince = new Map<number, { mark: number; mxFrame: number; sawAt: number }>();

  // Stack capture happens on begin (cheap Error object); formatting only when
  // an operation is reported, so the hot path stays free.
  const snapshot = (now = Date.now()): LongDbOperation[] =>
    [...operations.values()]
      .map(({ callerError, callerLabel, ...operation }) => ({
        ...operation,
        caller: callerLabel ?? formatCaller(callerError),
        ms: now - operation.startedAt,
      }))
      .sort((left, right) => right.ms - left.ms);

  const pinnedByProbeSince = new Map<string, { backlog: number; sawAt: number }>();

  const detectPinnedWalByCheckpoint = (now: number): void => {
    const probe = options.checkpointProbe?.();
    if (!probe) return;
    const backlog = probe.log - probe.checkpointed;
    const key = "passive";
    // A PASSIVE checkpoint is usually not "busy": it simply stops backfilling
    // at the oldest reader mark and leaves the rest of the log behind. A
    // sustained backlog is the pin.
    if (backlog < PINNED_LAG_FRAMES) {
      pinnedByProbeSince.delete(key);
      return;
    }
    const seen = pinnedByProbeSince.get(key);
    if (!seen) {
      pinnedByProbeSince.set(key, { backlog, sawAt: now });
      return;
    }
    if (backlog >= seen.backlog - PINNED_MIN_GROWTH_FRAMES && now - seen.sawAt >= PINNED_MIN_AGE_MS) {
      const report: PinnedWalReport = {
        lagFrames: backlog,
        mxFrame: probe.log,
        marks: [],
        openOperations: snapshot(now),
      };
      if (options.onPinnedWal) options.onPinnedWal(report);
      else log.warn("WAL checkpoint pinned by a reader", report);
      pinnedByProbeSince.delete(key);
    }
  };

  const detectPinnedWal = (now: number): void => {
    if (options.checkpointProbe) {
      detectPinnedWalByCheckpoint(now);
      return;
    }
    if (!options.dbPath) return;
    const marks = marksReader(options.dbPath);
    if (!marks || marks.mxFrame === 0) {
      pinnedSince.clear();
      return;
    }
    const activeMarks = new Set(marks.marks);
    for (const mark of marks.marks) {
      const lag = marks.mxFrame - mark;
      if (lag < PINNED_LAG_FRAMES) {
        pinnedSince.delete(mark);
        continue;
      }
      const seen = pinnedSince.get(mark);
      if (!seen) {
        pinnedSince.set(mark, { mark, mxFrame: marks.mxFrame, sawAt: now });
        continue;
      }
      const growth = marks.mxFrame - seen.mxFrame;
      if (growth >= PINNED_MIN_GROWTH_FRAMES && now - seen.sawAt >= PINNED_MIN_AGE_MS) {
        const report: PinnedWalReport = {
          lagFrames: lag,
          mxFrame: marks.mxFrame,
          marks: [...marks.marks],
          openOperations: snapshot(now),
        };
        if (options.onPinnedWal) options.onPinnedWal(report);
        else log.warn("WAL checkpoint pinned by a reader", report);
        pinnedSince.delete(mark);
      }
    }
    for (const mark of [...pinnedSince.keys()]) {
      if (!activeMarks.has(mark)) pinnedSince.delete(mark);
    }
  };

  const scan = (now = Date.now()): void => {
    const longOperations = snapshot(now).filter((operation) => operation.ms >= warnMs);
    if (longOperations.length > 0) {
      if (options.onLongOperations) options.onLongOperations(longOperations);
      else
        log.warn("long db operation still open", {
          count: longOperations.length,
          operations: longOperations.slice(0, 5),
        });
    }
    detectPinnedWal(now);
  };

  if (options.startTimer !== false) {
    timer = setInterval(() => scan(), intervalMs);
    timer.unref?.();
  }

  return {
    begin(kind, sql, caller) {
      sequence += 1;
      operations.set(sequence, {
        kind,
        sql,
        caller: caller ?? "",
        callerLabel: caller,
        callerError: caller ? undefined : new Error(),
        startedAt: Date.now(),
      });
      return sequence;
    },
    finish(id) {
      operations.delete(id);
    },
    scan,
    snapshot,
    dispose() {
      if (timer) clearInterval(timer);
      timer = undefined;
      operations.clear();
    },
  };
}
