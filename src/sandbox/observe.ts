/**
 * What E2B itself records about a sandbox, saved next to a run's outputs.
 *
 * E2B keeps three things per sandbox, readable for days after it is killed:
 * - platform logs (/v2/sandboxes/{id}/logs): every process the sandbox ran,
 *   with its command line, exit status and output size, plus envd/orchestrator lines;
 * - lifecycle events (/events/sandboxes/{id}): created, paused, resumed, killed,
 *   with the kill reason (request or timeout) and billed execution time;
 * - metrics (Sandbox.getMetrics): CPU, memory and disk sampled every 5 s.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_PAGE_SIZE = 1000;
const MAX_LOG_PAGES = 50;
const EVENT_PAGE_SIZE = 100;
const MAX_EVENT_PAGES = 10;
const LOG_WAIT_ATTEMPTS = 15;
const DEFAULT_E2B_API_URL = "https://api.e2b.app";

export interface E2bLogEntry {
  timestamp: string;
  level: string;
  message: string;
  fields?: Record<string, string>;
}

export interface E2bLifecycleEvent {
  type: string;
  timestamp: string;
  eventData?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface E2bMetricSample {
  timestamp: Date | string;
  cpuUsedPct: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
}

export interface E2bTelemetrySummary {
  logLines: number;
  processes: number;
  failedProcesses: number;
  events: string[];
  killReason: string | null;
  executionMs: number | null;
  metricSamples: number;
  peakCpuPct: number | null;
  peakMemMB: number | null;
  memTotalMB: number | null;
  peakDiskMB: number | null;
  /** Parts that could not be fetched, e.g. "logs: HTTP 500". */
  errors: string[];
}

export interface CollectE2bTelemetryOptions {
  sandboxId: string;
  apiKey: string;
  outputDir: string;
  /** Values to mask in everything written (credentials passed into the sandbox). */
  secrets?: string[];
  /** Wait until the killed/paused event is visible; set right after ending the sandbox. */
  waitForEnd?: boolean;
  apiUrl?: string;
  fetch?: typeof fetch;
  getMetrics?: (sandboxId: string) => Promise<E2bMetricSample[]>;
  sleep?: (ms: number) => Promise<void>;
}

/** Replace every secret value in `text` with ***. Short values are skipped to avoid mangling. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.replaceAll(secret, "***");
  }
  return out;
}

// E2B's logs hold every command line, so a credential from an older run (or one
// that is no longer in this environment) can sit there. These shapes are masked
// whatever the known values are. Only E2B telemetry gets this: the patch and
// transcripts must stay byte-exact.
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  [/(\w+:\/\/)[^\s/:@"'\\]+:[^\s/@"'\\]+@/g, "$1***@"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "***"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "***"],
  [/\be2b_[A-Za-z0-9]{20,}/g, "***"],
];

/** redactSecrets plus generic masking of URL credentials and known token shapes. */
export function redactTelemetry(text: string, secrets: readonly string[] = []): string {
  let out = redactSecrets(text, secrets);
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function e2bApiUrl(override?: string): string {
  if (override) return override;
  if (process.env.E2B_API_URL?.trim()) return process.env.E2B_API_URL.trim();
  const domain = process.env.E2B_DOMAIN?.trim();
  return domain ? `https://api.${domain}` : DEFAULT_E2B_API_URL;
}

async function getJson(fetchImpl: typeof fetch, baseUrl: string, path: string, apiKey: string): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl}${path}`, { headers: { "X-API-Key": apiKey } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchE2bLogs(
  sandboxId: string,
  apiKey: string,
  options: { apiUrl?: string; fetch?: typeof fetch } = {},
): Promise<E2bLogEntry[]> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = e2bApiUrl(options.apiUrl);
  const entries: E2bLogEntry[] = [];
  const seen = new Set<string>();
  // No cursor on the first page: cursor=0 returns nothing, the default starts at the sandbox's start.
  let cursor: number | null = null;
  for (let page = 0; page < MAX_LOG_PAGES; page++) {
    const body = (await getJson(
      fetchImpl,
      baseUrl,
      `/v2/sandboxes/${encodeURIComponent(sandboxId)}/logs?direction=forward&limit=${LOG_PAGE_SIZE}` +
        (cursor === null ? "" : `&cursor=${cursor}`),
      apiKey,
    )) as { logs?: E2bLogEntry[] };
    const logs = body.logs ?? [];
    let added = 0;
    for (const entry of logs) {
      // The cursor is a millisecond timestamp, so a page can repeat the previous page's last lines.
      const key = `${entry.timestamp}\u0000${entry.message}\u0000${JSON.stringify(entry.fields ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      added++;
    }
    if (logs.length < LOG_PAGE_SIZE || added === 0) break;
    const last = Date.parse(logs[logs.length - 1].timestamp);
    if (!Number.isFinite(last)) break;
    cursor = last;
  }
  return entries;
}

export async function fetchE2bEvents(
  sandboxId: string,
  apiKey: string,
  options: { apiUrl?: string; fetch?: typeof fetch } = {},
): Promise<E2bLifecycleEvent[]> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = e2bApiUrl(options.apiUrl);
  const events: E2bLifecycleEvent[] = [];
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const body = await getJson(
      fetchImpl,
      baseUrl,
      `/events/sandboxes/${encodeURIComponent(sandboxId)}?orderAsc=true&limit=${EVENT_PAGE_SIZE}&offset=${page * EVENT_PAGE_SIZE}`,
      apiKey,
    );
    const batch = Array.isArray(body) ? (body as E2bLifecycleEvent[]) : [];
    events.push(...batch);
    if (batch.length < EVENT_PAGE_SIZE) break;
  }
  return events;
}

async function defaultGetMetrics(sandboxId: string, apiKey: string): Promise<E2bMetricSample[]> {
  const { Sandbox } = await import("e2b");
  return (await Sandbox.getMetrics(sandboxId, { apiKey })) as E2bMetricSample[];
}

function isEndEvent(event: E2bLifecycleEvent): boolean {
  return event.type === "sandbox.lifecycle.killed" || event.type === "sandbox.lifecycle.paused";
}

function hhmmss(timestamp: string): string {
  const match = /T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(timestamp);
  return match ? match[1] : timestamp;
}

/**
 * One line per process start/end from E2B's platform logs: what ran in the
 * sandbox, when, and how it exited. This is the quickest view of a run.
 */
export function formatProcessTimeline(logs: readonly E2bLogEntry[]): string {
  const lines: string[] = [];
  for (const entry of logs) {
    const fields = entry.fields ?? {};
    if (fields.event_type === "process_start") {
      lines.push(`${hhmmss(entry.timestamp)}  start pid=${fields.pid ?? "?"}  ${fields.command ?? entry.message}`);
    } else if (fields.event_type === "process_end") {
      let status = "";
      try {
        const result = JSON.parse(fields.process_result ?? "{}") as { status?: string; error?: string };
        status = [result.status, result.error && result.error !== result.status ? result.error : undefined]
          .filter(Boolean)
          .join(" ");
      } catch {
        status = fields.process_result ?? "";
      }
      const pid = /pid (\d+)/.exec(entry.message)?.[1] ?? fields.pid ?? "?";
      lines.push(
        `${hhmmss(entry.timestamp)}  end   pid=${pid}  ${status || "ended"}  stdout=${fields.stdout_bytes ?? "?"}B stderr=${fields.stderr_bytes ?? "?"}B`,
      );
    } else if (entry.level === "error" || entry.level === "warn") {
      lines.push(`${hhmmss(entry.timestamp)}  ${entry.level.padEnd(5)} ${entry.message}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function isFailedProcessEnd(entry: E2bLogEntry): boolean {
  if (entry.fields?.event_type !== "process_end") return false;
  try {
    const result = JSON.parse(entry.fields.process_result ?? "{}") as { status?: string; error?: string };
    return Boolean(result.error) || (result.status !== undefined && result.status !== "exit status 0");
  } catch {
    return false;
  }
}

export function summarizeTelemetry(
  logs: readonly E2bLogEntry[],
  events: readonly E2bLifecycleEvent[],
  metrics: readonly E2bMetricSample[],
  errors: string[] = [],
): E2bTelemetrySummary {
  const MB = 1024 * 1024;
  const end = [...events].reverse().find(isEndEvent);
  const data = (end?.eventData ?? {}) as { kill_reason?: string; execution?: { execution_time?: number } };
  const peak = (pick: (sample: E2bMetricSample) => number) =>
    metrics.length > 0 ? Math.max(...metrics.map(pick)) : null;
  const peakMem = peak((sample) => sample.memUsed);
  const peakDisk = peak((sample) => sample.diskUsed);
  return {
    logLines: logs.length,
    processes: logs.filter((entry) => entry.fields?.event_type === "process_start").length,
    failedProcesses: logs.filter(isFailedProcessEnd).length,
    events: events.map((event) => event.type.replace("sandbox.lifecycle.", "")),
    killReason: data.kill_reason ?? null,
    executionMs: data.execution?.execution_time ?? null,
    metricSamples: metrics.length,
    peakCpuPct: peak((sample) => sample.cpuUsedPct),
    peakMemMB: peakMem === null ? null : Math.round(peakMem / MB),
    memTotalMB: metrics.length > 0 ? Math.round(metrics[metrics.length - 1].memTotal / MB) : null,
    peakDiskMB: peakDisk === null ? null : Math.round(peakDisk / MB),
    errors,
  };
}

function metricsCsv(metrics: readonly E2bMetricSample[]): string {
  const MB = 1024 * 1024;
  const rows = metrics.map((sample) =>
    [
      new Date(sample.timestamp).toISOString(),
      sample.cpuUsedPct,
      sample.cpuCount,
      Math.round(sample.memUsed / MB),
      Math.round(sample.memTotal / MB),
      Math.round(sample.diskUsed / MB),
      Math.round(sample.diskTotal / MB),
    ].join(","),
  );
  return `timestamp,cpu_pct,cpu_count,mem_used_mb,mem_total_mb,disk_used_mb,disk_total_mb\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}

/**
 * Fetch E2B's logs, lifecycle events and metrics for one sandbox and write them
 * under `<outputDir>/e2b/`. Never throws for a part that fails; the summary lists it.
 */
export async function collectE2bTelemetry(
  options: CollectE2bTelemetryOptions,
): Promise<{ summary: E2bTelemetrySummary; files: string[] }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const api = { apiUrl: options.apiUrl, fetch: options.fetch };
  const dir = join(options.outputDir, "e2b");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const errors: string[] = [];
  const write = (name: string, content: string) => {
    writeFileSync(join(dir, name), redactTelemetry(content, options.secrets));
    files.push(`e2b/${name}`);
  };
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // The kill/pause event and the last log lines show up a few seconds after the call returns.
  let events: E2bLifecycleEvent[] = [];
  for (let attempt = 0; attempt < (options.waitForEnd ? 6 : 1); attempt++) {
    try {
      events = await fetchE2bEvents(options.sandboxId, options.apiKey, api);
    } catch (error) {
      errors.push(`events: ${reason(error)}`);
      break;
    }
    if (!options.waitForEnd || events.some(isEndEvent)) break;
    await sleep(2_000);
  }
  write("events.json", `${JSON.stringify(events, null, 2)}\n`);

  // Logs reach the API later than events. Right after the sandbox ends, wait until
  // they cover its end, i.e. until a line at or after the kill/pause event shows up.
  const endEvent = [...events].reverse().find(isEndEvent);
  const endAt = endEvent ? Date.parse(endEvent.timestamp) : Number.NaN;
  let logs: E2bLogEntry[] = [];
  for (let attempt = 0; attempt < (options.waitForEnd ? LOG_WAIT_ATTEMPTS : 1); attempt++) {
    if (attempt > 0) await sleep(3_000);
    try {
      logs = await fetchE2bLogs(options.sandboxId, options.apiKey, api);
    } catch (error) {
      errors.push(`logs: ${reason(error)}`);
      break;
    }
    if (!options.waitForEnd || !Number.isFinite(endAt)) break;
    const lastAt = logs.length > 0 ? Date.parse(logs[logs.length - 1].timestamp) : Number.NaN;
    if (lastAt >= endAt) break;
    if (attempt === LOG_WAIT_ATTEMPTS - 1) {
      errors.push(
        `logs: incomplete, E2B was still ingesting them; run \`ravi sandbox logs ${options.sandboxId}\` later`,
      );
    }
  }
  write("logs.jsonl", logs.map((entry) => JSON.stringify(entry)).join("\n") + (logs.length ? "\n" : ""));
  write("processes.txt", formatProcessTimeline(logs));

  let metrics: E2bMetricSample[] = [];
  try {
    metrics = await (options.getMetrics ?? ((id) => defaultGetMetrics(id, options.apiKey)))(options.sandboxId);
  } catch (error) {
    errors.push(`metrics: ${reason(error)}`);
  }
  write("metrics.csv", metricsCsv(metrics));

  const summary = summarizeTelemetry(logs, events, metrics, errors);
  write("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, files };
}
