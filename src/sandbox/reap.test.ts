import { describe, expect, it } from "bun:test";
import { MAX_SANDBOX_TIMEOUT_MIN } from "./e2b.js";
import {
  DEFAULT_REAP_OLDER_THAN_MIN,
  type ReapDeps,
  type ReapSandboxInfo,
  killCandidates,
  listRaviTaskSandboxes,
  processIsAlive,
  reapSandboxes,
  selectReapCandidates,
} from "./reap.js";

const HOST = "host-hash-16chars";
const OTHER_HOST = "other-host-hash0";
const NOW = 1_700_000_000_000;
const minutesAgo = (min: number) => new Date(NOW - min * 60_000);

function sandbox(
  sandboxId: string,
  overrides: Partial<ReapSandboxInfo> & { metadata?: Record<string, string> } = {},
): ReapSandboxInfo {
  return {
    sandboxId,
    state: "running",
    startedAt: minutesAgo(5),
    templateId: "tpl_1",
    ...overrides,
    metadata: { purpose: "ravi-task", ravi_run: "a".repeat(24), ravi_host: HOST, ...overrides.metadata },
  };
}

/** Fake E2B listing: `list` records the metadata filter and applies it the way E2B's AND filter does. */
function fakeE2b(all: ReapSandboxInfo[], options: { killFails?: string[]; serverFilters?: boolean } = {}) {
  const state = { queries: [] as Record<string, string>[], killed: [] as string[], livePids: new Set<number>() };
  const deps: ReapDeps = {
    async list(metadata) {
      state.queries.push(metadata);
      if (options.serverFilters === false) return all;
      return all.filter((info) => Object.entries(metadata).every(([key, value]) => info.metadata[key] === value));
    },
    async kill(sandboxId) {
      if (options.killFails?.includes(sandboxId)) throw new Error(`kill failed for ${sandboxId}`);
      state.killed.push(sandboxId);
    },
    now: () => NOW,
    isAlive: (pid) => state.livePids.has(pid),
  };
  return { state, deps };
}

describe("listRaviTaskSandboxes", () => {
  it("queries E2B by purpose and this host, and repeats the filter client-side", async () => {
    const forged = sandbox("sbx-forged", { metadata: { ravi_host: OTHER_HOST } });
    const notRavi = sandbox("sbx-other-purpose", { metadata: { purpose: "something-else" } });
    const mine = sandbox("sbx-mine");
    // A server that ignores the metadata filter returns everything; the client still narrows it.
    const fake = fakeE2b([forged, notRavi, mine], { serverFilters: false });
    const listed = await listRaviTaskSandboxes({ hostId: HOST, list: fake.deps.list });
    expect(fake.state.queries).toEqual([{ purpose: "ravi-task", ravi_host: HOST }]);
    expect(listed.sandboxes.map((s) => s.sandboxId)).toEqual(["sbx-mine"]);
    expect(listed.skipped).toEqual([
      { sandboxId: "sbx-forged", cause: "other-host" },
      { sandboxId: "sbx-other-purpose", cause: "not-ravi-task" },
    ]);

    // --all-hosts drops the host filter but never the purpose.
    const all = fakeE2b([forged, notRavi, mine], { serverFilters: false });
    const everywhere = await listRaviTaskSandboxes({ hostId: HOST, allHosts: true, list: all.deps.list });
    expect(all.state.queries).toEqual([{ purpose: "ravi-task" }]);
    expect(everywhere.sandboxes.map((s) => s.sandboxId).sort()).toEqual(["sbx-forged", "sbx-mine"]);
    expect(everywhere.skipped).toEqual([{ sandboxId: "sbx-other-purpose", cause: "not-ravi-task" }]);
  });
});

describe("selectReapCandidates", () => {
  const select = (items: ReapSandboxInfo[], livePids: number[] = []) =>
    selectReapCandidates(items, {
      hostId: HOST,
      olderThanMin: DEFAULT_REAP_OLDER_THAN_MIN,
      now: () => NOW,
      isAlive: (pid) => livePids.includes(pid),
    });

  it("flags paused, overdue and dead-pid sandboxes and skips live runs", () => {
    expect(DEFAULT_REAP_OLDER_THAN_MIN).toBe(MAX_SANDBOX_TIMEOUT_MIN + 10);
    const { candidates, skipped } = select(
      [
        sandbox("sbx-paused", { state: "paused", startedAt: minutesAgo(1) }),
        sandbox("sbx-overdue", { startedAt: minutesAgo(DEFAULT_REAP_OLDER_THAN_MIN + 1) }),
        sandbox("sbx-at-limit", { startedAt: minutesAgo(DEFAULT_REAP_OLDER_THAN_MIN) }),
        sandbox("sbx-dead", { metadata: { ravi_pid: "4242" } }),
        sandbox("sbx-live", { metadata: { ravi_pid: "4243" } }),
        sandbox("sbx-no-pid"),
        sandbox("sbx-bad-pid", { metadata: { ravi_pid: "abc" } }),
      ],
      [4243],
    );
    expect(candidates.map(({ sandboxId, cause }) => [sandboxId, cause])).toEqual([
      ["sbx-paused", "paused"],
      ["sbx-overdue", "overdue"],
      ["sbx-dead", "dead-pid"],
    ]);
    expect(candidates[0]).toMatchObject({
      state: "paused",
      ageMin: 1,
      raviHost: HOST,
      raviRun: "a".repeat(24),
      raviPid: null,
    });
    expect(candidates[2]).toMatchObject({ raviPid: 4242 });
    expect(skipped).toEqual([
      { sandboxId: "sbx-at-limit", cause: "live" },
      { sandboxId: "sbx-live", cause: "live" },
      { sandboxId: "sbx-no-pid", cause: "live" },
      { sandboxId: "sbx-bad-pid", cause: "live" },
    ]);
  });

  it("never reads another host's pid as a local process", () => {
    // 4242 is not alive here, but the sandbox was created elsewhere: that pid means nothing on this host.
    const { candidates, skipped } = select([
      sandbox("sbx-elsewhere", { metadata: { ravi_host: OTHER_HOST, ravi_pid: "4242" } }),
      sandbox("sbx-elsewhere-paused", { state: "paused", metadata: { ravi_host: OTHER_HOST } }),
    ]);
    expect(candidates.map((c) => c.sandboxId)).toEqual(["sbx-elsewhere-paused"]);
    expect(skipped).toEqual([{ sandboxId: "sbx-elsewhere", cause: "live" }]);
  });

  it("checks liveness with signal 0 and treats EPERM as alive", () => {
    expect(processIsAlive(process.pid)).toBe(true);
    // Linux pid_max is at most 2^22 and macOS stops at 99998, so no process has this pid.
    expect(processIsAlive(2 ** 31 - 1)).toBe(false);
  });

  it("never passes a non-positive or fractional pid to process.kill", () => {
    // kill(0, 0) would test this process group and kill(-1, 0) every process: both would say "alive".
    for (const pid of [0, -1, -process.pid, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(processIsAlive(pid)).toBe(false);
    }
  });
});

describe("reapSandboxes", () => {
  const fleet = () => [
    sandbox("sbx-live", { metadata: { ravi_pid: "100" } }),
    sandbox("sbx-dead", { metadata: { ravi_pid: "200" } }),
    sandbox("sbx-paused", { state: "paused" }),
    sandbox("sbx-overdue", { startedAt: minutesAgo(200) }),
    sandbox("sbx-other-host", { state: "paused", metadata: { ravi_host: OTHER_HOST } }),
    sandbox("sbx-forged", {
      state: "paused",
      metadata: { purpose: "ravi-task", ravi_host: OTHER_HOST, ravi_pid: "200" },
    }),
    sandbox("sbx-not-ravi", { state: "paused", metadata: { purpose: "demo" } }),
  ];

  it("plans without killing by default", async () => {
    const fake = fakeE2b(fleet());
    fake.state.livePids.add(100);
    const result = await reapSandboxes({ hostId: HOST }, fake.deps);
    expect(result).toMatchObject({
      hostId: HOST,
      allHosts: false,
      olderThanMin: DEFAULT_REAP_OLDER_THAN_MIN,
      scanned: 4,
      executed: false,
      killed: [],
      failed: [],
    });
    expect(result.candidates.map((c) => c.sandboxId)).toEqual(["sbx-dead", "sbx-paused", "sbx-overdue"]);
    expect(result.skipped).toEqual([{ sandboxId: "sbx-live", cause: "live" }]);
    expect(fake.state.killed).toEqual([]);
  });

  it("with execute, kills only the candidates and reports kill failures without stopping", async () => {
    const fake = fakeE2b(fleet(), { killFails: ["sbx-paused"] });
    fake.state.livePids.add(100);
    const result = await reapSandboxes({ hostId: HOST, execute: true }, fake.deps);
    expect(result.executed).toBe(true);
    expect(result.killed).toEqual(["sbx-dead", "sbx-overdue"]);
    expect(result.failed).toEqual([{ sandboxId: "sbx-paused", error: "kill failed for sbx-paused" }]);
    expect(fake.state.killed).toEqual(["sbx-dead", "sbx-overdue"]);
    // Other hosts' sandboxes, forged or not, and non-ravi sandboxes were never touched.
    for (const id of ["sbx-live", "sbx-other-host", "sbx-forged", "sbx-not-ravi"]) {
      expect(fake.state.killed).not.toContain(id);
    }
  });

  it("includes other hosts' paused and overdue ravi-task sandboxes only with allHosts, never other purposes", async () => {
    const fake = fakeE2b(fleet());
    fake.state.livePids.add(100);
    const result = await reapSandboxes({ hostId: HOST, allHosts: true, execute: true }, fake.deps);
    expect(fake.state.queries).toEqual([{ purpose: "ravi-task" }]);
    expect(result.scanned).toBe(6);
    expect(result.killed.sort()).toEqual(["sbx-dead", "sbx-forged", "sbx-other-host", "sbx-overdue", "sbx-paused"]);
    expect(result.skipped).toEqual([{ sandboxId: "sbx-live", cause: "live" }]);
    expect(fake.state.killed).not.toContain("sbx-not-ravi");
    // sbx-forged is paused, which is why it qualifies here; its dead pid alone would not.
    const forgedRunning = fakeE2b([
      sandbox("sbx-forged-running", { metadata: { ravi_host: OTHER_HOST, ravi_pid: "200" } }),
    ]);
    const running = await reapSandboxes({ hostId: HOST, allHosts: true, execute: true }, forgedRunning.deps);
    expect(running.killed).toEqual([]);
    expect(running.skipped).toEqual([{ sandboxId: "sbx-forged-running", cause: "live" }]);
  });

  it("killCandidates kills exactly the plan's candidates and is the loop execute uses", async () => {
    const fake = fakeE2b(fleet(), { killFails: ["sbx-overdue"] });
    fake.state.livePids.add(100);
    const plan = await reapSandboxes({ hostId: HOST }, fake.deps);
    const result = await killCandidates(plan, fake.deps);
    expect(result.executed).toBe(true);
    expect(result.killed).toEqual(["sbx-dead", "sbx-paused"]);
    expect(result.failed).toEqual([{ sandboxId: "sbx-overdue", error: "kill failed for sbx-overdue" }]);
    expect(fake.state.killed).toEqual(["sbx-dead", "sbx-paused"]);
    expect(result.candidates).toEqual(plan.candidates);
    // The plan itself is left as it was: a dry-run result never gains a kill list.
    expect(plan).toMatchObject({ executed: false, killed: [], failed: [] });
    // Nothing outside the candidates reaches kill, whatever else is in the result.
    const spoofed = { ...plan, skipped: [{ sandboxId: "sbx-live", cause: "live" as const }] };
    const again = fakeE2b(fleet());
    await killCandidates(spoofed, again.deps);
    expect(again.state.killed).toEqual(["sbx-dead", "sbx-paused", "sbx-overdue"]);
  });

  it("honours olderThanMin and rejects a bad one before listing", async () => {
    const fake = fakeE2b([sandbox("sbx-30", { startedAt: minutesAgo(30) })]);
    expect((await reapSandboxes({ hostId: HOST, olderThanMin: 29 }, fake.deps)).candidates).toHaveLength(1);
    expect((await reapSandboxes({ hostId: HOST, olderThanMin: 30 }, fake.deps)).candidates).toHaveLength(0);
    for (const olderThanMin of [0, -1, 1.5, Number.NaN]) {
      await expect(reapSandboxes({ hostId: HOST, olderThanMin }, fake.deps)).rejects.toThrow(/olderThanMin/);
    }
    expect(fake.state.queries).toHaveLength(2);
  });
});
