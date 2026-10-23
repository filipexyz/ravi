import { statfsSync } from "node:fs";
import os from "node:os";
import { getRaviStateDir } from "../utils/paths.js";
import type { ClearWhen, SignalRecord } from "./types.js";
import { evaluateClearExpression } from "./validation.js";
import { dbGetSignalById } from "./signal-db.js";
import { getDb } from "../router/router-db.js";

export interface SignalProbeResult {
  fields: Record<string, unknown>;
  checkedAt: number;
}

export interface SignalProbe {
  id: string;
  read(signal?: SignalRecord): SignalProbeResult;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, SignalProbeResult & { cachedAt: number }>();
let diskProbeOverride: (() => SignalProbeResult) | null = null;

export function setDiskProbeForTests(probe: (() => SignalProbeResult) | null): void {
  diskProbeOverride = probe;
  cache.clear();
}

export function clearProbeCache(): void {
  cache.clear();
}

function stateVolumePath(): string {
  return getRaviStateDir();
}

function readDisk(): SignalProbeResult {
  if (diskProbeOverride) {
    const override = diskProbeOverride();
    return { fields: override.fields, checkedAt: override.checkedAt };
  }
  const path = stateVolumePath();
  const stats = statfsSync(path);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes)) {
    throw new Error("disk probe returned invalid filesystem statistics");
  }
  return {
    fields: {
      path,
      free_pct: Math.round((freeBytes / totalBytes) * 1000) / 10,
      free_bytes: freeBytes,
      total_bytes: totalBytes,
    },
    checkedAt: Date.now(),
  };
}

function readMemory(): SignalProbeResult {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    fields: {
      total_bytes: total,
      free_bytes: free,
      available_pct: total > 0 ? Math.round((free / total) * 1000) / 10 : 0,
    },
    checkedAt: Date.now(),
  };
}

function readLoad(): SignalProbeResult {
  return {
    fields: {
      load1: os.loadavg()[0],
      cores: os.cpus().length,
    },
    checkedAt: Date.now(),
  };
}

function readTaskState(signal?: SignalRecord): SignalProbeResult {
  if (!signal?.subjectId) {
    throw new Error("task.state probe requires subject_id=task");
  }
  const row = getDb()
    .prepare("SELECT status, archived_at, assignee_session_name FROM tasks WHERE id = ?")
    .get(signal.subjectId) as
    | { status: string; archived_at: number | null; assignee_session_name: string | null }
    | undefined;
  if (!row) {
    return { fields: { status: "missing", archived: 1, archived_at: null, terminal: 1 }, checkedAt: Date.now() };
  }
  return {
    fields: {
      status: row.status,
      archived: row.archived_at ? 1 : 0,
      archived_at: row.archived_at,
      terminal:
        row.archived_at || row.status === "done" || row.status === "failed" || row.status === "archived" ? 1 : 0,
      assignee_session_name: row.assignee_session_name,
    },
    checkedAt: Date.now(),
  };
}

function readSessionState(signal?: SignalRecord): SignalProbeResult {
  if (!signal?.subjectId) {
    throw new Error("session.state probe requires subject_id=session");
  }
  const row = getDb()
    .prepare("SELECT ephemeral, expires_at, updated_at FROM sessions WHERE name = ? OR session_key = ? LIMIT 1")
    .get(signal.subjectId, signal.subjectId) as
    | { ephemeral: number; expires_at: number | null; updated_at: number }
    | undefined;
  if (!row) {
    return { fields: { exists: 0, ephemeral: 0, ended: 1 }, checkedAt: Date.now() };
  }
  const now = Date.now();
  return {
    fields: {
      exists: 1,
      ephemeral: row.ephemeral,
      ended: row.ephemeral === 1 && row.expires_at !== null && row.expires_at <= now ? 1 : 0,
      expires_at: row.expires_at,
    },
    checkedAt: now,
  };
}

export const SIGNAL_PROBES: Record<string, SignalProbe> = {
  "host.disk": { id: "host.disk", read: readDisk },
  "host.memory": { id: "host.memory", read: readMemory },
  "host.load": { id: "host.load", read: readLoad },
  "task.state": { id: "task.state", read: readTaskState },
  "session.state": { id: "session.state", read: readSessionState },
};

export function listProbeIds(): string[] {
  return Object.keys(SIGNAL_PROBES).sort();
}

export function probeSignal(
  probeId: string,
  signal?: SignalRecord,
  options: { force?: boolean } = {},
): SignalProbeResult & { error?: string } {
  const probe = SIGNAL_PROBES[probeId];
  if (!probe) {
    return { fields: {}, checkedAt: Date.now(), error: `Unknown probe: ${probeId}` };
  }
  const cacheKey = `${probeId}:${signal?.subjectId ?? ""}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (diskProbeOverride && probeId === "host.disk") {
    try {
      const result = probe.read(signal);
      return { ...result, cachedAt: now } as SignalProbeResult & { cachedAt?: number };
    } catch (error) {
      return {
        fields: {},
        checkedAt: now,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (!options.force && cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }
  const started = Date.now();
  try {
    const result = probe.read(signal);
    if (Date.now() - started > 1000) {
      return { ...result, error: `Probe ${probeId} exceeded 1s` };
    }
    const entry = { ...result, cachedAt: now };
    cache.set(cacheKey, entry);
    return entry;
  } catch (error) {
    return {
      fields: cached?.fields ?? {},
      checkedAt: now,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ClearEvaluation {
  cleared: boolean;
  error?: string;
  fields?: Record<string, unknown>;
  observedAt: number;
  nextClearSince: number | null;
  matched: boolean;
}

export function evaluateClearRule(
  signal: SignalRecord,
  input: { now?: number; probe?: typeof probeSignal } = {},
): ClearEvaluation {
  const now = input.now ?? Date.now();
  const probe = input.probe ?? probeSignal;
  const rule = signal.clearWhen;
  switch (rule.type) {
    case "decay": {
      const cleared = now - signal.openedAt >= rule.after_ms;
      return { cleared, observedAt: now, nextClearSince: null, matched: cleared };
    }
    case "manual":
    case "producer_resolve":
      return { cleared: false, observedAt: now, nextClearSince: null, matched: false };
    case "metric": {
      const value = signal.evidence?.[rule.field];
      const fields = { [rule.field]: value };
      const expr = `${rule.field} ${opToSymbol(rule.op)} ${rule.value}`;
      const matched = evaluateClearExpression(expr, fields);
      return { cleared: matched, observedAt: now, nextClearSince: null, matched, fields };
    }
    case "probe": {
      const result = probe(rule.probe, signal);
      if (result.error) {
        return {
          cleared: false,
          error: result.error,
          fields: result.fields,
          observedAt: result.checkedAt,
          nextClearSince: signal.clearSince ?? null,
          matched: false,
        };
      }
      let matched = false;
      try {
        matched = evaluateClearExpression(rule.expr, result.fields);
      } catch (error) {
        return {
          cleared: false,
          error: error instanceof Error ? error.message : String(error),
          fields: result.fields,
          observedAt: result.checkedAt,
          nextClearSince: signal.clearSince ?? null,
          matched: false,
        };
      }
      if (!matched) {
        return {
          cleared: false,
          fields: result.fields,
          observedAt: result.checkedAt,
          nextClearSince: null,
          matched: false,
        };
      }
      if (rule.grace_ms <= 0) {
        return {
          cleared: true,
          fields: result.fields,
          observedAt: result.checkedAt,
          nextClearSince: signal.clearSince ?? now,
          matched: true,
        };
      }
      const since = signal.clearSince ?? now;
      return {
        cleared: now - since >= rule.grace_ms,
        fields: result.fields,
        observedAt: result.checkedAt,
        nextClearSince: since,
        matched: true,
      };
    }
  }
}

function opToSymbol(op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq"): string {
  switch (op) {
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "eq":
      return "==";
    case "neq":
      return "!=";
  }
}

export function describeClearRule(rule: ClearWhen): string {
  switch (rule.type) {
    case "probe":
      return `${rule.expr} (probe ${rule.probe}, recheck ${Math.round(rule.recheck_ms / 1000)}s, grace ${Math.round(rule.grace_ms / 1000)}s)`;
    case "metric":
      return `${rule.field} ${opToSymbol(rule.op)} ${rule.value} (metric)`;
    case "producer_resolve":
      return `producer resolves (ttl ${Math.round(rule.ttl_ms / 1000)}s)`;
    case "decay":
      return `decay at ${new Date(Date.now() + rule.after_ms).toISOString()}`;
    case "manual":
      return "manual resolution";
  }
}

export function isProbeRegistered(probeId: string): boolean {
  return Object.hasOwn(SIGNAL_PROBES, probeId);
}

export function getSignalForProbe(id: string): SignalRecord | null {
  return dbGetSignalById(id);
}
