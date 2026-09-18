import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalWatchSnapshot } from "./local-events.js";
import { LocalWatchRunner, type LocalWatchSource } from "./local-runner.js";
import type { WatchNatsPayload, WatchRecord } from "./types.js";

function makeWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: "watch_1",
    name: "repo watch",
    provider: "github",
    resourceRef: "o/r",
    eventTypes: ["pull_request.opened", "pull_request.merged", "workflow_run.failed"],
    placement: "local",
    status: "active",
    filters: {},
    eventSubjects: [],
    providerInstallationId: null,
    providerResourceId: null,
    delivery: null,
    lastEventAt: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as WatchRecord;
}

function snapshot(
  pullRequests: Array<{ number: number; draft?: boolean }>,
  workflowRuns: Array<{ id: number; conclusion?: string }> = [],
): LocalWatchSnapshot {
  return {
    version: 1,
    pullRequests: Object.fromEntries(
      pullRequests.map((pr) => [
        String(pr.number),
        { number: pr.number, title: `PR ${pr.number}`, url: `https://x/${pr.number}`, draft: pr.draft === true },
      ]),
    ),
    workflowRuns: Object.fromEntries(
      workflowRuns.map((run) => [
        String(run.id),
        { id: run.id, name: `run-${run.id}`, status: "completed", conclusion: run.conclusion ?? "success" },
      ]),
    ),
  };
}

function harness(options: {
  watches: WatchRecord[];
  snapshots: LocalWatchSnapshot[];
  departed?: (numbers: number[]) => Record<string, { state: string; title: string; url: string }>;
  publish?: (subject: string, payload: WatchNatsPayload) => Promise<void>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "ravi-local-watch-"));
  const published: Array<{ subject: string; payload: WatchNatsPayload }> = [];
  const departedCalls: number[][] = [];
  let index = 0;
  const source: LocalWatchSource = {
    readSnapshot() {
      const current = options.snapshots[Math.min(index, options.snapshots.length - 1)]!;
      index += 1;
      return current;
    },
    readDeparted(_repo, numbers) {
      departedCalls.push(numbers);
      return options.departed?.(numbers) ?? {};
    },
  };
  const runner = new LocalWatchRunner({
    intervalMs: 60_000,
    stateDir: dir,
    source,
    listLocalWatches: () => options.watches,
    publish: async (subject, payload) => {
      published.push({ subject, payload });
      await options.publish?.(subject, payload);
    },
  });
  return { runner, published, departedCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("local watch runner", () => {
  it("distinguishes merged from closed by asking for the final state", async () => {
    const h = harness({
      watches: [makeWatch({ eventTypes: ["pull_request.merged", "pull_request.closed"] })],
      snapshots: [snapshot([{ number: 1 }, { number: 2 }]), snapshot([])],
      departed: () => ({
        "1": { state: "MERGED", title: "PR 1", url: "https://x/1" },
        "2": { state: "CLOSED", title: "PR 2", url: "https://x/2" },
      }),
    });
    try {
      await h.runner.start();
      await h.runner.tick(); // baseline
      await h.runner.tick();

      // Sem o estado final, as duas PRs virariam "closed" — foi o bug real que
      // a revisão achou: `departed` era sempre vazio.
      expect(h.departedCalls).toEqual([[1, 2]]);
      const subjects = h.published.map((item) => item.payload.subject).sort();
      expect(subjects).toEqual(["ravi.watch.github.pull_request.closed", "ravi.watch.github.pull_request.merged"]);
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });

  it("does not ask for the final state when nothing left the open list", async () => {
    const h = harness({
      watches: [makeWatch()],
      snapshots: [snapshot([{ number: 1 }]), snapshot([{ number: 1 }])],
    });
    try {
      await h.runner.start();
      await h.runner.tick();
      await h.runner.tick();

      expect(h.departedCalls).toEqual([]);
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });

  it("publishes nothing on the baseline tick", async () => {
    const h = harness({ watches: [makeWatch()], snapshots: [snapshot([{ number: 1 }])] });
    try {
      await h.runner.start();
      const result = await h.runner.tick();

      expect(result).toMatchObject({ watchesScanned: 1, eventsPublished: 0, errors: 0 });
      expect(h.published).toEqual([]);
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });

  it("publishes the derived event with the watch contract on change", async () => {
    const h = harness({
      watches: [makeWatch()],
      snapshots: [snapshot([{ number: 1 }]), snapshot([{ number: 1 }, { number: 2 }])],
    });
    try {
      await h.runner.start();
      await h.runner.tick(); // baseline
      const result = await h.runner.tick();

      expect(result.eventsPublished).toBe(1);
      const [published] = h.published;
      expect(published!.subject).toBe("ravi.watch.github.pull_request.opened");
      expect(published!.payload).toMatchObject({
        version: 1,
        connector: "github",
        placement: "local",
        watchId: "watch_1",
        eventType: "pull_request.opened",
        subject: "ravi.watch.github.pull_request.opened",
      });
      expect(published!.payload.payload).toMatchObject({ repository: "o/r", number: 2 });
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });

  it("drops event types the watch did not subscribe to", async () => {
    const h = harness({
      watches: [makeWatch({ eventTypes: ["pull_request.opened"] })],
      snapshots: [snapshot([]), snapshot([], [{ id: 9, conclusion: "failure" }])],
    });
    try {
      await h.runner.start();
      await h.runner.tick();
      const result = await h.runner.tick();

      // O run falhou, mas o watch só pediu pull_request.opened: nada é publicado.
      expect(result.eventsPublished).toBe(0);
      expect(h.published).toEqual([]);
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });

  it("does not republish what the console watch already delivers", async () => {
    const local = makeWatch({ eventTypes: ["pull_request.opened", "workflow_run.failed"] });
    const console = makeWatch({
      id: "watch_console",
      placement: "console",
      eventTypes: ["watch.github.pull_request.opened"],
    });
    const h = harness({
      watches: [local, console],
      snapshots: [snapshot([], []), snapshot([{ number: 3 }], [{ id: 11, conclusion: "failure" }])],
    });
    try {
      await h.runner.start();
      await h.runner.tick();
      await h.runner.tick();

      // A PR aberta seria entrega dupla (webhook + poll); o CI só o local tem.
      // `workflow_run.completed` não está assinado por este watch, então não sai.
      expect(h.published.map((item) => item.payload.eventType)).toEqual(["workflow_run.failed"]);
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });

  it("skips watches that are not local github", async () => {
    const h = harness({
      watches: [makeWatch({ id: "watch_console", placement: "console" })],
      snapshots: [snapshot([{ number: 1 }])],
    });
    try {
      await h.runner.start();
      const result = await h.runner.tick();

      expect(result.watchesScanned).toBe(0);
    } finally {
      await h.runner.stop();
      h.cleanup();
    }
  });
});
