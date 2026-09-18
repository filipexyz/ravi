import { describe, expect, it } from "bun:test";
import {
  ensureGhWatchFollow,
  ensureRepoWatch,
  findExistingGhFollowTrigger,
  ghFollowFilter,
  observeGhBashCommand,
  parseGhWatchIntent,
  resetGhWatchCaches,
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
});

describe("gh watch observation", () => {
  function deps(overrides: Partial<Parameters<typeof observeGhBashCommand>[2]> = {}) {
    return {
      listWatches: () => ({ items: [watch()] }) as never,
      // Sem fake explícito, um caminho não coberto cairia no createWatch real e
      // escreveria no banco de produção. Foi o que aconteceu uma vez.
      createWatch: async () => {
        throw new Error("createWatch real chamado do teste");
      },
      listTriggers: () => [] as Trigger[],
      createTrigger: () => trigger(),
      emitTriggersRefresh: async () => {},
      resolveRepoFromCwd: () => null,
      ...overrides,
    };
  }

  it("subscribes once and then stays quiet for the same PR", async () => {
    resetGhWatchCaches();
    let created = 0;
    const d = deps({
      createTrigger: () => {
        created += 1;
        return trigger();
      },
    });

    await observeGhBashCommand("gh pr view 7 --repo o/r", {}, d);
    await observeGhBashCommand("gh pr checks 7 --repo o/r", {}, d);
    await observeGhBashCommand("gh pr diff 7 --repo o/r", {}, d);

    expect(created).toBe(1);
  });

  it("resolves the repo from the session cwd when the command omits it", async () => {
    resetGhWatchCaches();
    const created: string[] = [];
    await observeGhBashCommand(
      "gh pr view 7",
      { cwd: "/tmp/repo" },
      deps({
        resolveRepoFromCwd: (cwd) => (cwd === "/tmp/repo" ? "o/r" : null),
        createTrigger: (input) => {
          created.push(input.name);
          return trigger();
        },
      }),
    );

    expect(created).toEqual(["gh-follow:o/r#7"]);
  });

  it("does not use the process cwd when the session cwd is unknown", async () => {
    resetGhWatchCaches();
    let asked = 0;
    let created = 0;
    await observeGhBashCommand(
      "gh pr view 7",
      {},
      deps({
        resolveRepoFromCwd: () => {
          asked += 1;
          return "daemon/repo";
        },
        createTrigger: () => {
          created += 1;
          return trigger();
        },
      }),
    );

    // Sem cwd de sessão, criar watch pro repo errado seria pior que não criar.
    expect(asked).toBe(0);
    expect(created).toBe(0);
  });

  it("never throws, even when the subscription cannot be written", async () => {
    resetGhWatchCaches();
    const d = deps({
      listWatches: () => {
        throw new Error("db down");
      },
      createTrigger: () => {
        throw new Error("db down");
      },
    });

    // Um observador que derruba a tool call seria pior que não existir.
    await expect(observeGhBashCommand("gh pr view 7 --repo o/r", {}, d)).resolves.toBeUndefined();
  });

  it("does no work for commands without a gh intent", async () => {
    resetGhWatchCaches();
    let listed = 0;
    const d = deps({
      listWatches: () => {
        listed += 1;
        return { items: [] } as never;
      },
    });

    await observeGhBashCommand("ls -la", {}, d);
    await observeGhBashCommand("gh auth status", {}, d);

    expect(listed).toBe(0);
  });
});
