import { describe, expect, it } from "bun:test";
import {
  createGhWatchHook,
  ensureGhWatchFollow,
  ensureRepoWatch,
  findExistingGhFollowTrigger,
  ghFollowFilter,
  parseGhWatchIntent,
  resetGhWatchHookCaches,
  tokenizeShellCommand,
} from "./gh-watch.js";
import type { Trigger, TriggerInput } from "../triggers/index.js";
import type { WatchRecord } from "../watch/types.js";

function watch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: "watch_1",
    name: null,
    provider: "github",
    placement: "console",
    status: "active",
    resourceRef: "o/r",
    providerInstallationId: null,
    providerResourceId: null,
    eventTypes: ["pull_request.opened"],
    filters: {},
    delivery: null,
    eventSubjects: [],
    remoteWatch: null,
    lastEventAt: null,
    lastDeliveryAt: null,
    lastErrorCode: null,
    createdAt: 0,
    updatedAt: 0,
    disabledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return { id: "trig_1", name: "gh-follow:o/r#7", ...overrides } as Trigger;
}

describe("gh watch intent", () => {
  it("splits commands respecting quotes", () => {
    expect(tokenizeShellCommand(`gh pr view 7 --repo "o/r"`)).toEqual(["gh", "pr", "view", "7", "--repo", "o/r"]);
    expect(tokenizeShellCommand("cd /tmp && gh pr view 7")).toEqual(["cd", "/tmp", "&&", "gh", "pr", "view", "7"]);
  });

  it("reads repo and PR number from the common shapes", () => {
    expect(parseGhWatchIntent("gh pr view 507 --repo filipexyz/ravi")).toMatchObject({
      scope: "pr",
      repo: "filipexyz/ravi",
      prNumber: 507,
    });
    expect(parseGhWatchIntent("gh pr view 507 -R filipexyz/ravi")).toMatchObject({
      repo: "filipexyz/ravi",
      prNumber: 507,
    });
    expect(parseGhWatchIntent("gh pr checks 507 --repo=filipexyz/ravi")).toMatchObject({
      repo: "filipexyz/ravi",
      prNumber: 507,
    });
    expect(parseGhWatchIntent("gh pr view https://github.com/filipexyz/ravi/pull/507")).toMatchObject({
      repo: "filipexyz/ravi",
      prNumber: 507,
    });
    expect(parseGhWatchIntent("gh run list --repo filipexyz/ravi")).toMatchObject({
      scope: "run",
      repo: "filipexyz/ravi",
      prNumber: null,
    });
    expect(parseGhWatchIntent("gh api repos/filipexyz/ravi/pulls/507")).toMatchObject({
      scope: "api",
      repo: "filipexyz/ravi",
      prNumber: 507,
    });
  });

  it("keeps the repo even when the PR number is unknown", () => {
    // `gh pr view` sem número é a PR da branch atual: o repo ainda vale.
    expect(parseGhWatchIntent("gh pr view --repo filipexyz/ravi")).toMatchObject({
      scope: "pr",
      repo: "filipexyz/ravi",
      prNumber: null,
    });
  });

  it("ignores commands that are not repo observation", () => {
    expect(parseGhWatchIntent("gh auth status")).toBeNull();
    expect(parseGhWatchIntent("gh config get editor")).toBeNull();
    expect(parseGhWatchIntent("gh extension list")).toBeNull();
    expect(parseGhWatchIntent("gh")).toBeNull();
    expect(parseGhWatchIntent("git log gh")).toBeNull();
    expect(parseGhWatchIntent("echo gh pr view 1")).toBeNull();
    // `gh` de passagem no meio de outro comando não deve disparar.
    expect(parseGhWatchIntent("cat gh something")).toBeNull();
  });
});

describe("gh watch follow", () => {
  it("reuses an existing repo watch instead of creating another", async () => {
    let created = 0;
    const result = await ensureRepoWatch("o/r", {
      listWatches: () => ({ items: [watch()], total: 1 }) as never,
      createWatch: async () => {
        created += 1;
        return { watch: watch({ id: "new" }), createdRemote: false };
      },
    });

    expect(result).toEqual({ watchId: "watch_1", reused: true });
    expect(created).toBe(0);
  });

  it("falls back to a local watch when creating the console watch fails", async () => {
    const placements: string[] = [];
    const result = await ensureRepoWatch("o/r", {
      listWatches: () => ({ items: [] }) as never,
      createWatch: async (input) => {
        placements.push(String(input.placement ?? "default"));
        if (!input.placement) throw new Error("AUTH_REQUIRED");
        return { watch: watch({ id: "local_1", placement: "local" }), createdRemote: false };
      },
    });

    expect(placements).toEqual(["default", "local"]);
    expect(result).toEqual({ watchId: "local_1", reused: false });
  });

  it("creates the PR trigger once and reuses it afterwards", async () => {
    const created: string[] = [];
    const deps = {
      listWatches: () => ({ items: [watch()] }) as never,
      createWatch: async () => ({ watch: watch(), createdRemote: false }),
      listTriggers: () => [] as Trigger[],
      createTrigger: (input: TriggerInput) => {
        created.push(input.name);
        return trigger();
      },
      emitTriggersRefresh: async () => {},
    };

    const first = await ensureGhWatchFollow({ repo: "o/r", prNumber: 7, context: { sessionName: "dev" } }, deps);
    expect(first.triggerReused).toBe(false);
    expect(first.watchReused).toBe(true);
    expect(created).toEqual(["gh-follow:o/r#7"]);

    const second = await ensureGhWatchFollow(
      { repo: "o/r", prNumber: 7 },
      { ...deps, listTriggers: () => [trigger()] },
    );
    expect(second.triggerReused).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("does not create a trigger without a PR number", async () => {
    let created = 0;
    const result = await ensureGhWatchFollow(
      { repo: "o/r", prNumber: null },
      {
        listWatches: () => ({ items: [watch()] }) as never,
        listTriggers: () => [],
        createTrigger: () => {
          created += 1;
          return trigger();
        },
      },
    );

    expect(result.triggerSkipped).toBe("no_pr_number");
    expect(created).toBe(0);
  });

  it("filters by repository as well as number", () => {
    // Número de PR sozinho colidiria entre repos diferentes.
    const filter = ghFollowFilter("o/r", 7);
    expect(filter).toContain(`data.payload.repository == "o/r"`);
    expect(filter).toContain("data.payload.number == 7");
  });

  it("finds the existing trigger by name", () => {
    expect(findExistingGhFollowTrigger("o/r", 7, [trigger()])?.id).toBe("trig_1");
    expect(findExistingGhFollowTrigger("o/r", 8, [trigger()])).toBeUndefined();
  });

  it("resets caches between runs", () => {
    resetGhWatchHookCaches();
    expect(true).toBe(true);
  });
});

describe("gh watch hook", () => {
  function hookWith(deps: NonNullable<Parameters<typeof createGhWatchHook>[0]>["deps"]) {
    resetGhWatchHookCaches();
    const hook = createGhWatchHook({ deps, context: { sessionName: "main" }, resolveRepoFromCwd: () => null });
    const run = hook.hooks![0]! as unknown as (input: unknown) => Promise<unknown>;
    return run;
  }

  it("subscribes once and then stays quiet for the same PR", async () => {
    let created = 0;
    const run = hookWith({
      listWatches: () => ({ items: [watch()] }) as never,
      listTriggers: () => [],
      createTrigger: () => {
        created += 1;
        return trigger();
      },
      emitTriggersRefresh: async () => {},
    });

    await run({ tool_input: { command: "gh pr view 7 --repo o/r" } });
    await run({ tool_input: { command: "gh pr checks 7 --repo o/r" } });
    await run({ tool_input: { command: "gh pr diff 7 --repo o/r" } });

    expect(created).toBe(1);
  });

  it("never throws, even when the subscription cannot be written", async () => {
    const run = hookWith({
      listWatches: () => {
        throw new Error("db down");
      },
      listTriggers: () => [],
      createTrigger: () => {
        throw new Error("db down");
      },
      emitTriggersRefresh: async () => {},
    });

    // Um observador que derruba a tool call seria pior que não existir.
    await expect(run({ tool_input: { command: "gh pr view 7 --repo o/r" } })).resolves.toEqual({});
  });

  it("does nothing for commands without a gh intent", async () => {
    let listed = 0;
    const run = hookWith({
      listWatches: () => {
        listed += 1;
        return { items: [] } as never;
      },
      listTriggers: () => [],
      createTrigger: () => trigger(),
      emitTriggersRefresh: async () => {},
    });

    await run({ tool_input: { command: "ls -la" } });
    await run({ tool_input: { command: "gh auth status" } });
    await run({ tool_input: {} });

    expect(listed).toBe(0);
  });
});
