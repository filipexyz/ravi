import { describe, expect, it } from "bun:test";
import {
  dropExpiredPendingGhFollows,
  PENDING_GH_FOLLOW_TTL_MS,
  type PendingGhFollow,
  readPendingGhFollows,
  removePendingGhFollow,
  writePendingGhFollows,
} from "./gh-follow-pending.js";
import {
  parseGhFollowTriggerName,
  runGhFollowMaintenance,
  selectGhFollowFilterRepairs,
  selectStaleGhFollowTriggers,
} from "./gh-follow-sweep.js";
import { ghFollowFilter } from "./gh-watch.js";
import { validateFilter } from "../triggers/filter.js";
import type { Trigger } from "../triggers/index.js";

const LEGACY_UNQUOTED_FILTER = (repo: string, prNumber: number) =>
  `data.payload.repository == ${JSON.stringify(repo)} && (data.payload.number == ${prNumber} || data.payload.pull_request.number == ${prNumber})`;

function trigger(name: string, id = "t1"): Trigger {
  return { id, name } as Trigger;
}

function pending(overrides: Partial<PendingGhFollow> = {}): PendingGhFollow {
  return { repo: "o/r", cwd: "/repo", sessionName: "main", createdAt: 1000, ...overrides };
}

describe("gh follow pending queue", () => {
  it("keeps one pending per repo and cwd", () => {
    let store: PendingGhFollow[] = [];
    const write = (entries: PendingGhFollow[]) => {
      store = entries;
    };
    // Simula a leitura do store em memória.
    const read = () => store;

    const first = addPendingWith(read, write, pending({ createdAt: 1 }));
    expect(first).toHaveLength(1);
    const second = addPendingWith(read, write, pending({ createdAt: 2 }));
    expect(second).toHaveLength(1);
    expect(second[0]!.createdAt).toBe(2);

    // Repo diferente é outra pendência.
    const third = addPendingWith(read, write, pending({ repo: "o/other", createdAt: 3 }));
    expect(third).toHaveLength(2);
  });

  it("expires pendings that took too long to resolve", () => {
    const now = 1_000_000;
    const fresh = pending({ createdAt: now - 1_000 });
    const old = pending({ cwd: "/other", createdAt: now - PENDING_GH_FOLLOW_TTL_MS - 1 });

    expect(dropExpiredPendingGhFollows([fresh, old], now)).toEqual([fresh]);
  });

  it("writes and reads the queue from disk", () => {
    const dir = `/tmp/gh-follow-test-${process.pid}-${Date.now()}`;
    writePendingGhFollows([pending()], dir);
    expect(readPendingGhFollows(dir)).toEqual([pending()]);
    const left = removePendingGhFollow(readPendingGhFollows(dir), (entry) => entry.repo === "o/r", dir);
    expect(left).toEqual([]);
    expect(readPendingGhFollows(dir)).toEqual([]);
  });
});

function addPendingWith(
  read: () => PendingGhFollow[],
  write: (entries: PendingGhFollow[]) => void,
  entry: PendingGhFollow,
) {
  const current = read();
  const key = `${entry.repo}\0${entry.cwd ?? ""}`;
  const next = current.filter((item) => `${item.repo}\0${item.cwd ?? ""}` !== key);
  next.push(entry);
  write(next);
  return next;
}

describe("gh follow trigger names", () => {
  it("parses repo and PR number", () => {
    expect(parseGhFollowTriggerName("gh-follow:filipexyz/ravi#507")).toEqual({ repo: "filipexyz/ravi", prNumber: 507 });
    expect(parseGhFollowTriggerName("gh-follow:o/r#1")).toEqual({ repo: "o/r", prNumber: 1 });
  });

  it("ignores anything that is not ours", () => {
    expect(parseGhFollowTriggerName("bug-follow:x")).toBeNull();
    expect(parseGhFollowTriggerName("gh-follow:o/r")).toBeNull();
    expect(parseGhFollowTriggerName("gh-follow:or#abc")).toBeNull();
    expect(parseGhFollowTriggerName("")).toBeNull();
  });
});

describe("gh follow maintenance", () => {
  it("removes triggers whose PR is no longer open", () => {
    const states = new Map([
      [
        "o/r",
        new Map([
          [1, "OPEN"],
          [2, "MERGED"],
          [3, "CLOSED"],
        ]),
      ],
    ]);
    const stale = selectStaleGhFollowTriggers(
      [trigger("gh-follow:o/r#1", "a"), trigger("gh-follow:o/r#2", "b"), trigger("gh-follow:o/r#3", "c")],
      states,
    );

    expect(stale.map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("keeps triggers it cannot verify", () => {
    // Repo não consultado e PR fora da janela: não removemos o que não verificamos.
    const states = new Map([["o/r", new Map([[1, "OPEN"]])]]);
    const stale = selectStaleGhFollowTriggers(
      [trigger("gh-follow:other/repo#9", "a"), trigger("gh-follow:o/r#7", "b"), trigger("gh-follow:o/r#1", "c")],
      states,
    );

    expect(stale).toEqual([]);
  });

  it("resolves a pending gh pr create and creates the follow", async () => {
    const created: string[] = [];
    const writes: PendingGhFollow[][] = [];

    const result = await runGhFollowMaintenance({
      readPending: () => [pending()],
      writePending: (entries) => {
        writes.push(entries);
      },
      listTriggers: () => [],
      resolvePrNumber: () => 42,
      ensureFollow: async (input) => {
        created.push(`${input.repo}#${input.prNumber}`);
        return { repo: input.repo, watchId: "w1", watchReused: true, triggerId: "t9", triggerReused: false };
      },
      now: () => 1000,
    });

    expect(created).toEqual(["o/r#42"]);
    expect(result.pendingResolved).toBe(1);
    expect(writes).toEqual([[]]);
  });

  it("keeps a pending that cannot be resolved yet", async () => {
    const writes: PendingGhFollow[][] = [];
    const result = await runGhFollowMaintenance({
      readPending: () => [pending()],
      writePending: (entries) => {
        writes.push(entries);
      },
      listTriggers: () => [],
      resolvePrNumber: () => null,
      now: () => 1000,
    });

    // A PR pode não estar visível ainda: tentamos de novo no próximo tick, e
    // como nada mudou a fila nem é reescrita.
    expect(result.pendingResolved).toBe(0);
    expect(writes).toEqual([]);
  });

  it("drops expired pendings instead of retrying forever", async () => {
    const writes: PendingGhFollow[][] = [];
    const result = await runGhFollowMaintenance({
      readPending: () => [pending({ createdAt: 0 })],
      writePending: (entries) => {
        writes.push(entries);
      },
      listTriggers: () => [],
      resolvePrNumber: () => 1,
      ensureFollow: async () => ({
        repo: "o/r",
        watchId: "w",
        watchReused: true,
        triggerId: "t",
        triggerReused: false,
      }),
      now: () => PENDING_GH_FOLLOW_TTL_MS + 1,
    });

    expect(result.pendingDropped).toBe(1);
    expect(writes).toEqual([[]]);
  });

  it("deletes the stale triggers it found and refreshes once", async () => {
    const deleted: string[] = [];
    let refreshes = 0;

    const result = await runGhFollowMaintenance({
      readPending: () => [],
      listTriggers: () => [trigger("gh-follow:o/r#1", "a"), trigger("gh-follow:o/r#2", "b")],
      deleteTrigger: (id) => {
        deleted.push(id);
        return true;
      },
      listPrStates: () =>
        new Map([
          [1, "OPEN"],
          [2, "MERGED"],
        ]),
      emitTriggersRefresh: async () => {
        refreshes += 1;
      },
    });

    expect(deleted).toEqual(["b"]);
    expect(result.triggersRemoved).toBe(1);
    expect(result.triggersKept).toBe(1);
    expect(refreshes).toBe(1);
  });

  it("selects only follows whose filter does not compile", () => {
    expect(validateFilter(LEGACY_UNQUOTED_FILTER("o/r", 1)).ok).toBe(false);

    const repairs = selectGhFollowFilterRepairs([
      { ...trigger("gh-follow:o/r#1", "legacy"), filter: LEGACY_UNQUOTED_FILTER("o/r", 1) },
      { ...trigger("gh-follow:o/r#2", "canonical"), filter: ghFollowFilter("o/r", 2) },
      { ...trigger("gh-follow:o/r#3", "custom"), filter: `data.payload.repository == "o/r"` },
      { ...trigger("bug-follow:x", "not-ours"), filter: "data.bugId == broken" },
    ]);

    expect(repairs.map(({ trigger: item, filter }) => [item.id, filter])).toEqual([
      ["legacy", ghFollowFilter("o/r", 1)],
    ]);
  });

  it("repairs invalid follow filters on live PRs and refreshes once", async () => {
    const updates: Array<[string, string]> = [];
    const deleted: string[] = [];
    let refreshes = 0;

    const result = await runGhFollowMaintenance({
      readPending: () => [],
      listTriggers: () => [
        { ...trigger("gh-follow:o/r#1", "open_legacy"), filter: LEGACY_UNQUOTED_FILTER("o/r", 1) },
        { ...trigger("gh-follow:o/r#2", "merged_legacy"), filter: LEGACY_UNQUOTED_FILTER("o/r", 2) },
        { ...trigger("gh-follow:o/r#3", "open_canonical"), filter: ghFollowFilter("o/r", 3) },
      ],
      deleteTrigger: (id) => {
        deleted.push(id);
        return true;
      },
      updateTrigger: (id, patch) => {
        updates.push([id, patch.filter]);
      },
      listPrStates: () =>
        new Map([
          [1, "OPEN"],
          [2, "MERGED"],
          [3, "OPEN"],
        ]),
      listWatches: () => [],
      emitTriggersRefresh: async () => {
        refreshes += 1;
      },
    });

    // PR morta é removida, não reparada; filtro canônico não é reescrito.
    expect(deleted).toEqual(["merged_legacy"]);
    expect(updates).toEqual([["open_legacy", ghFollowFilter("o/r", 1)]]);
    expect(result.triggersRepaired).toBe(1);
    expect(result.triggersRemoved).toBe(1);
    expect(refreshes).toBe(1);
  });

  it("does nothing when there is no follow to maintain", async () => {
    let stateCalls = 0;
    const result = await runGhFollowMaintenance({
      readPending: () => [],
      listTriggers: () => [trigger("bug-follow:x", "a")],
      listWatches: () => [],
      listPrStates: () => {
        stateCalls += 1;
        return new Map();
      },
    });

    expect(stateCalls).toBe(0);
    expect(result).toMatchObject({ pendingResolved: 0, triggersRemoved: 0, triggersKept: 0, watchesRemoved: 0 });
  });

  it("removes the managed local watch once no subscription needs it", async () => {
    const removed: string[] = [];
    const result = await runGhFollowMaintenance({
      readPending: () => [],
      listTriggers: () => [],
      listWatches: () =>
        [
          {
            id: "w_managed",
            placement: "local",
            status: "active",
            resourceRef: "o/r",
            filters: { managedBy: "gh-follow" },
          },
          { id: "w_user", placement: "local", status: "active", resourceRef: "o/other", filters: {} },
        ] as never,
      removeWatch: async (id) => {
        removed.push(id);
        return true;
      },
    });

    // Sem isto o poller rodaria duas chamadas `gh` por minuto para sempre.
    expect(removed).toEqual(["w_managed"]);
    expect(result.watchesRemoved).toBe(1);
  });

  it("keeps the managed watch while a subscription or a pending still needs it", async () => {
    const removed: string[] = [];
    const watches = [
      { id: "w_a", placement: "local", status: "active", resourceRef: "o/r", filters: { managedBy: "gh-follow" } },
      {
        id: "w_b",
        placement: "local",
        status: "active",
        resourceRef: "o/pending",
        filters: { managedBy: "gh-follow" },
      },
    ] as never;

    const withTrigger = await runGhFollowMaintenance({
      readPending: () => [],
      listTriggers: () => [trigger("gh-follow:o/r#1", "t1")],
      listWatches: () => watches,
      listPrStates: () => new Map([[1, "OPEN"]]),
      removeWatch: async (id) => {
        removed.push(id);
        return true;
      },
    });
    expect(withTrigger.watchesRemoved).toBe(1);
    expect(removed).toEqual(["w_b"]);

    removed.length = 0;
    // PR recém-criada: acompanhamento em formação, o watch ainda é necessário.
    const withPending = await runGhFollowMaintenance({
      readPending: () => [pending({ repo: "o/pending" })],
      writePending: () => {},
      listTriggers: () => [],
      listWatches: () => watches,
      resolvePrNumber: () => null,
      // A pendência precisa estar fresca: vencida, ela é descartada e deixa de
      // justificar o watch.
      now: () => 2_000,
      removeWatch: async (id) => {
        removed.push(id);
        return true;
      },
    });
    expect(withPending.watchesRemoved).toBe(1);
    expect(removed).toEqual(["w_a"]);
  });

  it("never removes a watch it did not create", async () => {
    let removed = 0;
    const result = await runGhFollowMaintenance({
      readPending: () => [],
      listTriggers: () => [],
      listWatches: () =>
        [
          {
            id: "w_console",
            placement: "console",
            status: "active",
            resourceRef: "o/r",
            filters: { managedBy: "gh-follow" },
          },
          { id: "w_user_local", placement: "local", status: "active", resourceRef: "o/r", filters: {} },
          {
            id: "w_disabled",
            placement: "local",
            status: "disabled",
            resourceRef: "o/r",
            filters: { managedBy: "gh-follow" },
          },
        ] as never,
      removeWatch: async () => {
        removed += 1;
        return true;
      },
    });

    expect(removed).toBe(0);
    expect(result.watchesRemoved).toBe(0);
  });
});
