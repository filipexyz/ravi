import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type E2bLogEntry,
  collectE2bTelemetry,
  fetchE2bLogs,
  formatProcessTimeline,
  redactSecrets,
  summarizeTelemetry,
} from "./observe.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const START: E2bLogEntry = {
  timestamp: "2026-10-06T21:39:19.881995507Z",
  level: "info",
  message: "Process with pid 2000 started",
  fields: { event_type: "process_start", pid: "2000", command: "/bin/bash -l -c ravi daemon run" },
};
const END_FAIL: E2bLogEntry = {
  timestamp: "2026-10-06T21:39:20.905439226Z",
  level: "info",
  message: "Process with pid 2000 ended",
  fields: {
    event_type: "process_end",
    process_result: '{"exited":true,"status":"exit status 1"}',
    stdout_bytes: "127",
    stderr_bytes: "13",
  },
};
const KILLED = {
  type: "sandbox.lifecycle.killed",
  timestamp: "2026-10-06T21:39:29Z",
  eventData: { kill_reason: "timeout", execution: { execution_time: 9792 } },
};
const STOPPED: E2bLogEntry = { timestamp: "2026-10-06T21:39:29.3Z", level: "info", message: "Sandbox stopped" };
const METRIC = {
  timestamp: "2026-10-06T21:39:20Z",
  cpuUsedPct: 42.5,
  cpuCount: 2,
  memUsed: 300 * 1024 * 1024,
  memTotal: 4096 * 1024 * 1024,
  diskUsed: 1600 * 1024 * 1024,
  diskTotal: 20000 * 1024 * 1024,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("redactSecrets", () => {
  it("masks long secrets and leaves short values alone", () => {
    expect(redactSecrets("a sk-ant-oat01-xyz b sk-ant-oat01-xyz", ["sk-ant-oat01-xyz", "x"])).toBe("a *** b ***");
  });
});

describe("fetchE2bLogs", () => {
  it("pages forward by timestamp and drops lines repeated across pages", async () => {
    const page1 = Array.from({ length: 1000 }, (_, index) => ({
      timestamp: new Date(Date.UTC(2026, 9, 6, 0, 0, 0, index)).toISOString(),
      level: "debug",
      message: `line ${index}`,
    }));
    const page2 = [page1[999], { ...page1[999], message: "line 1000" }];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return jsonResponse({ logs: urls.length === 1 ? page1 : page2 });
    }) as unknown as typeof fetch;
    const logs = await fetchE2bLogs("sbx", "key", { apiUrl: "https://api.test", fetch: fetchImpl });
    expect(logs).toHaveLength(1001);
    expect(urls[0]).toEndWith("/v2/sandboxes/sbx/logs?direction=forward&limit=1000");
    expect(urls[1]).toContain(`cursor=${Date.parse(page1[999].timestamp)}`);
  });
});

describe("formatProcessTimeline / summarizeTelemetry", () => {
  it("shows each process start and end and counts failures", () => {
    const timeline = formatProcessTimeline([START, END_FAIL, { ...START, level: "debug", fields: {} }]);
    expect(timeline).toBe(
      "21:39:19.881  start pid=2000  /bin/bash -l -c ravi daemon run\n" +
        "21:39:20.905  end   pid=2000  exit status 1  stdout=127B stderr=13B\n",
    );
    const summary = summarizeTelemetry([START, END_FAIL], [KILLED], [METRIC]);
    expect(summary).toMatchObject({
      processes: 1,
      failedProcesses: 1,
      events: ["killed"],
      killReason: "timeout",
      executionMs: 9792,
      peakCpuPct: 42.5,
      peakMemMB: 300,
      memTotalMB: 4096,
      peakDiskMB: 1600,
    });
  });
});

describe("collectE2bTelemetry", () => {
  it("writes logs, events, metrics and a summary, masking secrets, and waits for the end event", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "ravi-observe-test-"));
    dirs.push(outputDir);
    let eventCalls = 0;
    let logCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect((init?.headers ?? {}) as Record<string, string>).toMatchObject({ "X-API-Key": "key" });
      if (url.includes("/events/")) {
        eventCalls++;
        return jsonResponse(eventCalls === 1 ? [] : [KILLED]);
      }
      logCalls++;
      // First read: E2B has not ingested the lines up to the kill yet.
      const lines = [{ ...START, fields: { ...START.fields, command: "clone secret-token-1" } }, END_FAIL];
      return jsonResponse({ logs: logCalls === 1 ? lines : [...lines, STOPPED] });
    }) as unknown as typeof fetch;
    const { summary, files } = await collectE2bTelemetry({
      sandboxId: "sbx",
      apiKey: "key",
      outputDir,
      secrets: ["secret-token-1"],
      waitForEnd: true,
      apiUrl: "https://api.test",
      fetch: fetchImpl,
      getMetrics: async () => [METRIC],
      sleep: async () => {},
    });
    expect(eventCalls).toBe(2);
    expect(logCalls).toBe(2);
    expect(summary.logLines).toBe(3);
    expect(summary.killReason).toBe("timeout");
    expect(summary.errors).toEqual([]);
    expect(files.sort()).toEqual([
      "e2b/events.json",
      "e2b/logs.jsonl",
      "e2b/metrics.csv",
      "e2b/processes.txt",
      "e2b/summary.json",
    ]);
    const processes = readFileSync(join(outputDir, "e2b/processes.txt"), "utf8");
    expect(processes).toContain("clone ***");
    expect(readFileSync(join(outputDir, "e2b/logs.jsonl"), "utf8")).not.toContain("secret-token-1");
    expect(readFileSync(join(outputDir, "e2b/metrics.csv"), "utf8")).toContain("2026-10-06T21:39:20.000Z,42.5,2,300");
  });

  it("records a part that fails instead of throwing", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "ravi-observe-test-"));
    dirs.push(outputDir);
    const { summary } = await collectE2bTelemetry({
      sandboxId: "sbx",
      apiKey: "key",
      outputDir,
      apiUrl: "https://api.test",
      fetch: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
      getMetrics: async () => {
        throw new Error("nope");
      },
    });
    expect(summary.errors).toEqual(["events: HTTP 404", "logs: HTTP 404", "metrics: nope"]);
  });
});
