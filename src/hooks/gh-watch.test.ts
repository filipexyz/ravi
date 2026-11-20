import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildGhFollowTriggerInput,
  ensureFollowWatchProducer,
  ensureGhWatchFollow,
  resolveGhFollowContext,
  ensureRepoWatch,
  findExistingGhFollowTrigger,
  ghFollowFilter,
  isSupersededGhFollowFilter,
  observeGhBashCommand,
  parseGhWatchIntent,
  resetGhWatchCaches,
  supersededGhFollowFilters,
  tokenizeShellCommand,
} from "./gh-watch.js";
import type { InboxNatsPayload } from "../inbox/types.js";
import { watchEventFromInboxPayload } from "../watch/events.js";
import { deriveLocalGitHubEvents, WORKFLOW_CONCLUSIONS_WITH_OUTCOME_EVENT } from "../watch/local-events.js";
import { evaluateFilter, validateFilter } from "../triggers/filter.js";
import { handOffClosingThreadFollows, resolveDurableFollowOwner } from "../triggers/follow-owner.js";
import type { Trigger, TriggerInput } from "../triggers/index.js";
import type { WatchRecord } from "../watch/types.js";

import { registerInboundSlackThread, closeSlackThreadLifecycle } from "../channels/slack/thread-lifecycle-store.js";
import { getOrCreateSession, deleteSession } from "../router/sessions.js";
import { dbCreateTrigger, dbGetTrigger } from "../triggers/triggers-db.js";
import { runGhFollowMaintenance } from "./gh-follow-sweep.js";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent } from "../router/router-db.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gh-follow-owner-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

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
      follow: false,
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

  it("follows only the commands that create or mutate your own PR", () => {
    // Criar PR é a intenção de acompanhar. Visualizar é consulta.
    expect(parseGhWatchIntent("gh pr create --title x --body y")).toMatchObject({
      follow: true,
      prNumber: null,
      repo: null,
    });
    expect(parseGhWatchIntent("gh pr ready 507 --repo o/r")).toMatchObject({ follow: true, prNumber: 507 });
    expect(parseGhWatchIntent("gh pr edit 507 --repo o/r --title nova")).toMatchObject({ follow: true, prNumber: 507 });

    for (const command of [
      "gh pr view 507 --repo o/r",
      "gh pr checks 507 --repo o/r",
      "gh pr diff 507 --repo o/r",
      "gh pr list --repo o/r",
      "gh pr status",
      "gh pr review 507 --approve",
      "gh pr comment 507 --body ok",
      "gh run list --repo o/r",
      "gh repo view o/r",
      "gh api repos/o/r/pulls/507",
    ]) {
      expect(parseGhWatchIntent(command)).toMatchObject({ follow: false });
    }
  });

  it("does not follow a PR that is ending", () => {
    // Acompanhar o que já está acabando não serve pra nada.
    expect(parseGhWatchIntent("gh pr merge 507 --repo o/r")).toMatchObject({ follow: false });
    expect(parseGhWatchIntent("gh pr close 507 --repo o/r")).toMatchObject({ follow: false });
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

  it("does not treat a --head branch as the repository", () => {
    // `fix/busy-turn-honest` casa com REPO_SLUG. Se o valor de --head vazar
    // para positional, o follow cria um watch fantasma e o poller chama
    // `gh pr list --repo fix/busy-turn-honest` para sempre.
    expect(parseGhWatchIntent('gh pr create --head fix/busy-turn-honest --title "x"')).toMatchObject({
      scope: "pr",
      repo: null,
      prNumber: null,
      follow: true,
    });
    expect(parseGhWatchIntent('gh pr create --head=fix/busy-turn-honest --title "x"')).toMatchObject({
      repo: null,
      follow: true,
    });
    expect(parseGhWatchIntent("gh pr create -H fix/busy-turn-honest --title x")).toMatchObject({
      repo: null,
      follow: true,
    });
    expect(parseGhWatchIntent("gh pr ready 507 --head fix/busy-turn-honest")).toMatchObject({
      repo: null,
      prNumber: 507,
      follow: true,
    });
    expect(parseGhWatchIntent("gh pr edit 507 --title owner/looks-like-repo")).toMatchObject({
      repo: null,
      prNumber: 507,
      follow: true,
    });
  });

  it("still reads repo from --repo and PR URLs when --head is present", () => {
    expect(parseGhWatchIntent("gh pr create --head fix/busy-turn-honest --title x --repo owner/real")).toMatchObject({
      repo: "owner/real",
      prNumber: null,
      follow: true,
    });
    expect(parseGhWatchIntent("gh pr create --repo=owner/real --head=fix/busy-turn-honest --title x")).toMatchObject({
      repo: "owner/real",
      follow: true,
    });
    expect(parseGhWatchIntent("gh pr ready --undo 507 -R owner/real")).toMatchObject({
      repo: "owner/real",
      prNumber: 507,
      follow: true,
    });
    expect(
      parseGhWatchIntent("gh pr edit https://github.com/owner/real/pull/88 --title owner/looks-like-repo"),
    ).toMatchObject({
      repo: "owner/real",
      prNumber: 88,
      follow: true,
    });
  });

  it("follows gh when a known wrapper sits in front of the executable", () => {
    const bare =
      'gh pr create -R filipexyz/ravi --base main --head dev --title "ship" --body-file /tmp/pr-dev-to-main.md';
    const bareIntent = parseGhWatchIntent(bare);
    expect(bareIntent).toMatchObject({
      scope: "pr",
      repo: "filipexyz/ravi",
      prNumber: null,
      follow: true,
    });

    // `timeout` sem duração, com duração, e o comando real (`2>&1 | tail`)
    // têm de produzir a mesma intenção que o `gh` nu.
    expect(parseGhWatchIntent(`timeout ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`timeout 200 ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`timeout --foreground 30 ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`timeout -k 5 200 ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`env VAR=x ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`env FOO=bar BAR=baz ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`timeout 200 env VAR=x ${bare}`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`timeout 200 ${bare} 2>&1 | tail -5`)).toEqual(bareIntent);
    expect(parseGhWatchIntent(`cd /tmp && timeout 200 ${bare} 2>&1 | tail -5`)).toEqual(bareIntent);

    for (const wrapped of [
      `nice ${bare}`,
      `nice -n 10 ${bare}`,
      `sudo -n ${bare}`,
      `sudo -u root ${bare}`,
      `command -p ${bare}`,
      `stdbuf -oL ${bare}`,
      `stdbuf -o L ${bare}`,
      `nohup ${bare}`,
      `time -p ${bare}`,
      `exec ${bare}`,
    ]) {
      expect(parseGhWatchIntent(wrapped)).toEqual(bareIntent);
    }

    expect(parseGhWatchIntent("timeout 30 gh pr ready 507 --repo o/r | tail -5")).toMatchObject({
      follow: true,
      prNumber: 507,
      repo: "o/r",
    });
    expect(parseGhWatchIntent("env VAR=x gh pr edit 88 -R o/r --title nova")).toMatchObject({
      follow: true,
      prNumber: 88,
      repo: "o/r",
    });
  });

  it("does not treat a wrapper around a different program as gh", () => {
    expect(parseGhWatchIntent("timeout 200 echo gh pr create --title x")).toBeNull();
    expect(parseGhWatchIntent("env VAR=x echo gh pr create --title x")).toBeNull();
    expect(parseGhWatchIntent("nice echo gh pr create --title x")).toBeNull();
    // `command -v` resolve o caminho e não executa.
    expect(parseGhWatchIntent("command -v gh")).toBeNull();
    expect(parseGhWatchIntent("command -V gh pr create --title x")).toBeNull();
    expect(parseGhWatchIntent("echo gh pr create --title x")).toBeNull();
  });
});

describe("gh watch follow", () => {
  const LOCAL_TYPES = ["pull_request.merged", "workflow_run.failed"];

  function placementOf(input: { placement?: unknown }): "local" | "console" {
    return input.placement === "local" ? "local" : "console";
  }

  it("reuses the existing watch and still adds the local one for CI", async () => {
    let created = 0;
    const result = await ensureRepoWatch("o/r", {
      listWatches: () => ({ items: [watch()], total: 1 }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        created += 1;
        return {
          watch: watch({ id: "new", placement: input.placement === "local" ? "local" : "console" }),
          createdRemote: false,
        };
      },
    });

    // O Console entrega ciclo de vida; o local entrega CI. São dois produtores.
    expect(result).toMatchObject({ watchId: "watch_1", reused: true, ciWatchReused: false });
    expect(created).toBe(1);
  });

  it("does not create a second local watch when one already covers the event set", async () => {
    let created = 0;
    const result = await ensureRepoWatch("o/r", {
      listWatches: () =>
        ({
          items: [
            watch(),
            watch({ id: "local_1", placement: "local", eventTypes: LOCAL_TYPES, filters: { managedBy: "gh-follow" } }),
          ],
          total: 2,
        }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async () => {
        created += 1;
        return { watch: watch({ id: "new" }), createdRemote: false };
      },
    });

    expect(result).toMatchObject({ ciWatchId: "local_1", ciWatchReused: true });
    expect(created).toBe(0);
  });

  it("replaces its own local watch when the derivation gained new events", async () => {
    const created: string[][] = [];
    const removed: string[] = [];
    const result = await ensureRepoWatch("o/r", {
      listWatches: () =>
        ({
          items: [
            watch(),
            // Watch criado quando a derivação só produzia ciclo de vida.
            watch({
              id: "local_old",
              placement: "local",
              eventTypes: ["pull_request.opened"],
              filters: { managedBy: "gh-follow" },
            }),
          ],
          total: 2,
        }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        created.push(input.eventTypes ?? []);
        return { watch: watch({ id: "local_new", placement: "local" }), createdRemote: false };
      },
      removeWatch: async (id) => {
        removed.push(id);
        return true;
      },
    });

    // Reaproveitar o watch antigo deixaria o follow mudo no evento novo.
    expect(created).toEqual([LOCAL_TYPES]);
    expect(result).toMatchObject({ ciWatchId: "local_new", ciWatchReused: false });
    expect(removed).toEqual(["local_old"]);
  });

  it("does not replace a local watch someone else created without the ownership mark", async () => {
    const removed: string[] = [];
    await ensureRepoWatch("o/r", {
      listWatches: () =>
        ({
          items: [watch(), watch({ id: "local_user", placement: "local", eventTypes: ["pull_request.opened"] })],
          total: 2,
        }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async () => ({ watch: watch({ id: "local_new", placement: "local" }), createdRemote: false }),
      removeWatch: async (id) => {
        removed.push(id);
        return true;
      },
    });

    expect(removed).toEqual([]);
  });

  it("does not reactivate a disabled local watch that belongs to the user", async () => {
    const created: string[] = [];
    const disabled = watch({
      id: "local_user_off",
      placement: "local",
      status: "disabled",
      eventTypes: LOCAL_TYPES,
      filters: {},
    });

    const result = await ensureRepoWatch("o/r", {
      // O id do watch local é derivado de repo + eventos: criar aqui encontraria
      // essa mesma linha e a traria de volta como ativa.
      listWatches: (input) => ({ items: input?.status === "all" ? [disabled] : [], total: 1 }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        if (input.placement === "local") created.push("local");
        return { watch: watch({ id: "local_new", placement: "local" }), createdRemote: false };
      },
    });

    expect(created).toEqual([]);
    expect(result.ciWatchId).toBeNull();
  });

  it("requests exactly the locally supported event types for the CI watch", async () => {
    const requested: string[][] = [];
    await ensureRepoWatch("o/r", {
      listWatches: () => ({ items: [] }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        requested.push(input.eventTypes ?? []);
        return {
          watch: watch({ id: "new", placement: input.placement === "local" ? "local" : "console" }),
          createdRemote: false,
        };
      },
    });

    expect(requested[0]).toEqual(LOCAL_TYPES);
  });

  it("does not create a local watch when the catalog supports nothing locally", async () => {
    const placements: string[] = [];
    await ensureRepoWatch("o/r", {
      listWatches: () => ({ items: [watch()] }) as never,
      localEventTypes: () => [],
      createWatch: async (input) => {
        placements.push(placementOf(input));
        return { watch: watch({ id: "new" }), createdRemote: false };
      },
    });

    // Sem evento local suportado, um watch local só gastaria poll sem publicar nada.
    expect(placements).toEqual([]);
  });

  it("falls back to local when creating the console watch fails", async () => {
    const placements: string[] = [];
    const result = await ensureRepoWatch("o/r", {
      listWatches: () => ({ items: [] }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        placements.push(placementOf(input));
        if (input.placement !== "local") throw new Error("AUTH_REQUIRED");
        return { watch: watch({ id: "local_1", placement: "local" }), createdRemote: false };
      },
    });

    expect(placements).toEqual(["local", "console"]);
    expect(result).toMatchObject({ watchId: "local_1", reused: false });
  });

  it("ensures only the local producer without touching the Console watch", async () => {
    const placements: string[] = [];
    const result = await ensureFollowWatchProducer("o/r", {
      listWatches: () => ({ items: [] }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        placements.push(input.placement ?? "console");
        return { watch: watch({ id: "local_new", placement: "local" }), createdRemote: false };
      },
    });

    // A manutenção roda a cada minuto: criar watch de Console aqui seria chamada
    // de rede por repo por tick.
    expect(placements).toEqual(["local"]);
    expect(result).toMatchObject({ ciWatchId: "local_new", ciWatchReused: false });
  });

  it("reconciles the producer to the current event set on every maintenance pass", async () => {
    const created: string[][] = [];
    const result = await ensureFollowWatchProducer("o/r", {
      listWatches: () =>
        ({
          items: [
            watch(),
            watch({
              id: "local_old",
              placement: "local",
              eventTypes: ["pull_request.opened"],
              filters: { managedBy: "gh-follow" },
            }),
          ],
        }) as never,
      localEventTypes: () => LOCAL_TYPES,
      createWatch: async (input) => {
        created.push(input.eventTypes ?? []);
        return { watch: watch({ id: "local_new", placement: "local" }), createdRemote: false };
      },
      removeWatch: async () => true,
    });

    expect(created).toEqual([LOCAL_TYPES]);
    expect(result.ciWatchId).toBe("local_new");
  });

  it("creates the PR trigger once and reuses it afterwards", async () => {
    const created: string[] = [];
    const deps = {
      listWatches: () => ({ items: [watch()] }) as never,
      createWatch: async () => ({ watch: watch(), createdRemote: false }),
      listTriggers: () => [] as Trigger[],
      createTrigger: (input: TriggerInput) => {
        expect(input.cooldownMs).toBe(0);
        expect(input.debounceMs).toBe(0);
        created.push(input.name);
        return trigger();
      },
      emitTriggersRefresh: async () => {},
      updateTrigger: () => true,
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

  it("refreshes the instructions of an existing follow", async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const stale = trigger({
      message: "Activity on o/r#7. Tell the user what changed.",
      filter: "old",
      topic: "ravi.watch.github.*",
      cooldownMs: 30_000,
      debounceMs: 2_000,
    });

    const result = await ensureGhWatchFollow(
      { repo: "o/r", prNumber: 7, context: { sessionName: "dev" } },
      {
        listWatches: () => ({ items: [watch()] }) as never,
        listTriggers: () => [stale],
        emitTriggersRefresh: async () => {},
        updateTrigger: (id, patch) => {
          updates.push({ id, patch: patch as Record<string, unknown> });
          return true;
        },
      },
    );

    // Sem isso, acompanhamentos antigos seguem com o texto velho e nunca passam a
    // considerar comentário, mesmo recebendo o evento.
    expect(result.triggerRepaired).toBe(true);
    expect(updates).toHaveLength(1);
    expect(String(updates[0].patch.message)).toContain("comment");
    expect(updates[0].patch.filter).toBe(ghFollowFilter("o/r", 7));
    expect(updates[0].patch.topic).toBe("ravi.watch.github.>");
    expect(updates[0].patch.cooldownMs).toBe(0);
    expect(updates[0].patch.debounceMs).toBe(0);
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
    expect(filter).toContain(`data.payload.number == "7"`);
  });

  it("generates a filter the trigger runtime accepts and matches only that PR", () => {
    // Filtro inválido não ativa o trigger (fail-closed): o follow ficaria mudo.
    const filter = ghFollowFilter("o/r", 7);
    expect(validateFilter(filter)).toEqual({ ok: true });

    expect(evaluateFilter(filter, { payload: { repository: "o/r", number: 7 } })).toBe(true);
    expect(evaluateFilter(filter, { payload: { repository: "o/r", pull_request: { number: 7 } } })).toBe(true);
    expect(evaluateFilter(filter, { payload: { repository: "o/r", number: 8 } })).toBe(false);
    expect(evaluateFilter(filter, { payload: { repository: "o/other", number: 7 } })).toBe(false);
  });

  it("finds the existing trigger by name", () => {
    expect(findExistingGhFollowTrigger("o/r", 7, [trigger()])?.id).toBe("trig_1");
    expect(findExistingGhFollowTrigger("o/r", 8, [trigger()])).toBeUndefined();
  });
});

describe("gh follow filter: which events wake the owner", () => {
  const filter = ghFollowFilter("o/r", 7);
  const hears = (event: unknown) => evaluateFilter(filter, event);

  // The envelope a watch publishes: the event type and the placement sit beside the payload.
  // The local runner sets `placement: "local"` (its own test, "publishes the derived event with
  // the watch contract on change", pins it); the Console sends the placement of the watch.
  type Placement = "local" | "console";
  const event = (eventType: string, payload: Record<string, unknown> = {}, placement: Placement = "local") => ({
    eventType,
    placement,
    payload: { repository: "o/r", number: 7, ...payload },
  });
  const run = (eventType: string, conclusion: string | null, name = "CI", placement: Placement = "local") =>
    event(eventType, { runId: 1, name, status: "completed", conclusion, branch: "feat/x" }, placement);

  const OUTCOMES: Array<[conclusion: string, outcomeEvent: string]> = [
    ["success", "workflow_run.succeeded"],
    ["failure", "workflow_run.failed"],
    ["timed_out", "workflow_run.failed"],
    ["startup_failure", "workflow_run.failed"],
    ["cancelled", "workflow_run.cancelled"],
  ];

  it("hears each CI result once from the local producer: the outcome event, not the completed event repeating it", () => {
    for (const [conclusion, outcomeEvent] of OUTCOMES) {
      expect(hears(run(outcomeEvent, conclusion))).toBe(true);
      expect(hears(run("workflow_run.completed", conclusion))).toBe(false);
    }
  });

  it("keeps workflow_run.completed when it is the only event the run produces", () => {
    // action_required is a CI run waiting for approval: nothing else reports it.
    for (const conclusion of ["action_required", "neutral", "skipped", "stale", null, "a_conclusion_added_later"]) {
      expect(hears(run("workflow_run.completed", conclusion))).toBe(true);
    }
  });

  it("keeps the Console's workflow_run.completed whatever its conclusion: it is the only CI event the Console sends", () => {
    // The Console reports `completed` and no outcome event. Dropping it for `success` or `failure`
    // would leave a follow whose local poller produces nothing deaf to every CI result.
    for (const conclusion of [
      ...OUTCOMES.map(([name]) => name),
      "action_required",
      "neutral",
      "skipped",
      "stale",
      null,
    ]) {
      expect(hears(run("workflow_run.completed", conclusion, "CI", "console"))).toBe(true);
    }
  });

  it("hears an event that does not say where it comes from", () => {
    // A missing `placement` makes `placement == "local"` false, so the exclusion does not apply.
    const unplaced = { eventType: "workflow_run.completed", payload: run("workflow_run.completed", "success").payload };
    expect(hears(unplaced)).toBe(true);
  });

  it("drops the PR Description workflow, whatever its outcome and wherever it was reported", () => {
    for (const placement of ["local", "console"] as const) {
      for (const [conclusion, outcomeEvent] of OUTCOMES) {
        expect(hears(run(outcomeEvent, conclusion, "PR Description", placement))).toBe(false);
        expect(hears(run("workflow_run.completed", conclusion, "PR Description", placement))).toBe(false);
      }
      expect(hears(run("workflow_run.completed", "action_required", "PR Description", placement))).toBe(false);
    }
    // Another workflow with a similar name is still CI.
    expect(hears(run("workflow_run.failed", "failure", "PR Description Required Sections"))).toBe(true);
  });

  it("never drops a PR lifecycle or comment event, which carry no workflow name or conclusion", () => {
    for (const eventType of [
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.ready_for_review",
      "pull_request.converted_to_draft",
      "pull_request.merged",
      "pull_request.closed",
      "pull_request_comment.created",
    ]) {
      expect(hears(event(eventType))).toBe(true);
      expect(hears(event(eventType, {}, "console"))).toBe(true);
    }
    // The Console delivers lifecycle with the number under pull_request and no event type at all.
    expect(hears({ payload: { repository: "o/r", pull_request: { number: 7 } } })).toBe(true);
  });

  it("still listens only to that repository and PR", () => {
    expect(hears(run("workflow_run.succeeded", "success"))).toBe(true);
    expect(hears(event("workflow_run.succeeded", { number: 8, conclusion: "success", name: "CI" }))).toBe(false);
    expect(hears(event("workflow_run.succeeded", { repository: "o/other", conclusion: "success", name: "CI" }))).toBe(
      false,
    );
    expect(hears(event("pull_request_comment.created", { number: 8 }))).toBe(false);
  });

  it("negates an equality because a missing path makes every comparison false, `!=` included", () => {
    // Why the exclusions read `!(x == y)`: `data.payload.name != "PR Description"` would be
    // false for an event that has no payload.name and silently drop every lifecycle event.
    const notEqual = `data.payload.name != "PR Description"`;
    const negatedEqual = `!(data.payload.name == "PR Description")`;
    const lifecycle = event("pull_request.synchronize");
    expect(evaluateFilter(notEqual, lifecycle)).toBe(false);
    expect(evaluateFilter(negatedEqual, lifecycle)).toBe(true);
    expect(filter).not.toContain("!=");
  });

  describe("against what the watch derivation really emits", () => {
    function derive(name: string, conclusion: string | null) {
      const pullRequest = {
        number: 7,
        title: "t",
        url: "https://github.com/o/r/pull/7",
        draft: false,
        headSha: "a",
        headRefName: "feat/x",
      };
      const base = { version: 1 as const, pullRequests: { "7": pullRequest }, comments: {} };
      const running = { id: 1, name, status: "in_progress", conclusion: null, branch: "feat/x" };
      const derived = deriveLocalGitHubEvents("o/r", {
        previous: { ...base, workflowRuns: { "1": running } },
        current: { ...base, workflowRuns: { "1": { ...running, status: "completed", conclusion } } },
        departed: {},
      }).events;
      // What the local runner publishes: the derived event inside its watch envelope.
      return derived.map((emitted) => ({ ...emitted, placement: "local" as const }));
    }

    it("lets exactly one event of a finished run reach the follow, whatever its conclusion", () => {
      const conclusions = [
        "success",
        "failure",
        "timed_out",
        "startup_failure",
        "cancelled",
        "action_required",
        "neutral",
        "skipped",
        "stale",
        null,
      ];
      for (const conclusion of conclusions) {
        const events = derive("CI", conclusion);
        // The derivation may emit the outcome event and `completed`, or `completed` alone.
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.filter((emitted) => hears(emitted))).toHaveLength(1);
      }
    });

    it("lets nothing of a PR Description run reach the follow", () => {
      for (const conclusion of ["success", "failure", "cancelled", "action_required", null]) {
        expect(derive("PR Description", conclusion).filter((emitted) => hears(emitted))).toEqual([]);
      }
    });

    // The Console reports `workflow_run.completed` and none of the outcome events, so a Console
    // completion is the only CI signal of its run whenever the local poller produces nothing.
    function consoleRun(conclusion: string | null, name = "CI") {
      const inbox: InboxNatsPayload = {
        version: 1,
        eventId: "item_1",
        sequence: 1,
        dedupeKey: "watch:watch_c:github:delivery_1",
        eventType: "watch.github.workflow_run.completed",
        category: "source_control",
        severity: "info",
        sensitivity: "private",
        title: null,
        summary: null,
        organization: { id: "org_1" },
        project: null,
        source: { type: "github_webhook", provider: "github", providerEventType: "workflow_run" },
        actor: { type: "github_user", id: "octocat", login: "octocat" },
        target: { type: "github_repository", id: "repo_1", ref: "o/r" },
        payload: {
          watch: { id: "watch_c", provider: "github", placement: "console", resourceRef: "o/r" },
          repository: "o/r",
          number: 7,
          name,
          status: "completed",
          conclusion,
        },
        links: null,
        delivery: {
          subscriptionId: "sub_1",
          installationId: "cli_1",
          pollId: "poll_1",
          leaseId: null,
          localDeliveredAt: "2026-11-19T17:00:00.000Z",
        },
        occurredAt: "2026-11-19T17:00:00.000Z",
        createdAt: "2026-11-19T17:00:00.000Z",
      };
      return watchEventFromInboxPayload(inbox);
    }

    const CONCLUSIONS = [
      "success",
      "failure",
      "timed_out",
      "startup_failure",
      "cancelled",
      "action_required",
      "neutral",
      "skipped",
      "stale",
      null,
    ];

    it("hears a repo that only the Console reports on exactly once per finished run, whatever the conclusion", () => {
      // No local poller output: the Console's `completed` is all the follow can ever hear.
      for (const conclusion of CONCLUSIONS) {
        expect(consoleRun(conclusion)).toMatchObject({ placement: "console", eventType: "workflow_run.completed" });
        expect([consoleRun(conclusion)].filter((emitted) => hears(emitted))).toHaveLength(1);
      }
    });

    it("drops the PR Description workflow from the Console as well", () => {
      for (const conclusion of CONCLUSIONS) {
        expect(hears(consoleRun(conclusion, "PR Description"))).toBe(false);
      }
    });

    it("hears a run twice when the Console and the local poller both report it: the cost of keeping the Console signal", () => {
      // The local derivation emits the outcome event and `completed` (the follow drops the second);
      // the Console adds its own `completed`. Two events, down from the three before the exclusion.
      for (const [conclusion, outcomeEvent] of OUTCOMES) {
        const reported = [...derive("CI", conclusion), consoleRun(conclusion)!];
        const heard = reported.filter((emitted) => hears(emitted));
        expect(reported).toHaveLength(3);
        expect(heard.map((emitted) => [emitted.placement, emitted.eventType])).toEqual([
          ["local", outcomeEvent],
          ["console", "workflow_run.completed"],
        ]);
      }
    });

    it("drops the repeat for exactly the conclusions that have their own event", () => {
      expect([...WORKFLOW_CONCLUSIONS_WITH_OUTCOME_EVENT].sort()).toEqual(
        OUTCOMES.map(([conclusion]) => conclusion).sort(),
      );
    });
  });
});

describe("gh follow filter generations", () => {
  // The literal an earlier release wrote: it listened to the PR and nothing else.
  const GENERATION_1 = `data.payload.repository == "o/r" && (data.payload.number == "7" || data.payload.pull_request.number == "7")`;

  it("recognises the filter the previous release generated, and only that", () => {
    expect(supersededGhFollowFilters("o/r", 7)).toEqual([GENERATION_1]);
    expect(isSupersededGhFollowFilter(GENERATION_1, "o/r", 7)).toBe(true);
    expect(isSupersededGhFollowFilter(`  ${GENERATION_1}\n`, "o/r", 7)).toBe(true);
  });

  it("does not take the current filter, a customised one, or another PR's for superseded", () => {
    expect(isSupersededGhFollowFilter(ghFollowFilter("o/r", 7), "o/r", 7)).toBe(false);
    expect(isSupersededGhFollowFilter(`data.payload.repository == "o/r"`, "o/r", 7)).toBe(false);
    expect(isSupersededGhFollowFilter(GENERATION_1, "o/r", 8)).toBe(false);
    expect(isSupersededGhFollowFilter(GENERATION_1, "o/other", 7)).toBe(false);
    expect(isSupersededGhFollowFilter(undefined, "o/r", 7)).toBe(false);
    expect(isSupersededGhFollowFilter("", "o/r", 7)).toBe(false);
  });

  it("keeps the previous filter a valid one, so a follow that still carries it keeps working until repaired", () => {
    expect(validateFilter(GENERATION_1)).toEqual({ ok: true });
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

    await observeGhBashCommand("gh pr ready 7 --repo o/r", {}, d);
    await observeGhBashCommand("gh pr edit 7 --repo o/r --title nova", {}, d);
    await observeGhBashCommand("gh pr ready 7 --repo o/r", {}, d);

    expect(created).toBe(1);
  });

  it("viewing a PR never subscribes", async () => {
    resetGhWatchCaches();
    let listed = 0;
    let created = 0;
    const d = deps({
      listWatches: () => {
        listed += 1;
        return { items: [watch()] } as never;
      },
      createTrigger: () => {
        created += 1;
        return trigger();
      },
    });

    // Olhar uma PR não é intenção de acompanhar: é consulta.
    await observeGhBashCommand("gh pr view 7 --repo o/r", {}, d);
    await observeGhBashCommand("gh pr checks 7 --repo o/r", {}, d);
    await observeGhBashCommand("gh pr diff 7 --repo o/r", {}, d);

    expect(listed).toBe(0);
    expect(created).toBe(0);
  });

  it("resolves gh pr create --head from the cwd remote, not the branch name", async () => {
    resetGhWatchCaches();
    const queued: string[] = [];
    let asked = 0;

    await observeGhBashCommand(
      'gh pr create --head fix/busy-turn-honest --title "x"',
      { cwd: "/repo", sessionName: "main" },
      deps({
        resolveRepoFromCwd: () => {
          asked += 1;
          return "o/r";
        },
        addPending: (entry) => {
          queued.push(entry.repo);
        },
      }),
    );

    // Sem isso o follow criaria watch em `fix/busy-turn-honest` e nunca perguntaria o cwd.
    expect(queued).toEqual(["o/r"]);
    expect(asked).toBe(1);
  });

  it("keeps an explicit --repo when --head looks like owner/name", async () => {
    resetGhWatchCaches();
    const queued: string[] = [];
    let asked = 0;

    await observeGhBashCommand(
      "gh pr create --head fix/busy-turn-honest --repo o/r --title x",
      { cwd: "/repo" },
      deps({
        resolveRepoFromCwd: () => {
          asked += 1;
          return "cwd/wrong";
        },
        addPending: (entry) => {
          queued.push(entry.repo);
        },
      }),
    );

    expect(queued).toEqual(["o/r"]);
    expect(asked).toBe(0);
  });

  it("resolves the repo from an explicit cd when the session cwd is not a repo", async () => {
    resetGhWatchCaches();
    const queued: Array<{ repo: string; cwd: string | null }> = [];

    await observeGhBashCommand(
      "cd /srv/checkout/repo && gh pr create --head fix/x --title x",
      { sessionName: "agent-workspace" },
      deps({
        resolveRepoFromCwd: (cwd) => (cwd.endsWith("/repo") ? "o/r" : null),
        addPending: (entry) => {
          queued.push({ repo: entry.repo, cwd: entry.cwd });
        },
      }),
    );

    // Sem isto, um cwd que não é repo (workspace de agent) engolia a intenção em silêncio.
    // O pendente guarda o diretório do `cd` para o sweep conseguir resolver a PR.
    expect(queued).toEqual([{ repo: "o/r", cwd: "/srv/checkout/repo" }]);
  });

  it("finds gh through wrappers and resolves a relative cd against the session cwd", async () => {
    resetGhWatchCaches();
    const asked: string[] = [];
    const queued: Array<{ repo: string; cwd: string | null }> = [];

    await observeGhBashCommand(
      "cd checkout/repo && env gh pr create --head fix/x --title x",
      { cwd: "/workspace", sessionName: "agent-workspace" },
      deps({
        resolveRepoFromCwd: (cwd) => {
          asked.push(cwd);
          return cwd === "/workspace/checkout/repo" ? "o/r" : null;
        },
        addPending: (entry) => {
          queued.push({ repo: entry.repo, cwd: entry.cwd });
        },
      }),
    );

    expect(asked).toEqual(["/workspace", "/workspace/checkout/repo"]);
    expect(queued).toEqual([{ repo: "o/r", cwd: "/workspace/checkout/repo" }]);
  });

  it("keeps the cd directory for the pending entry when the repository is explicit", async () => {
    resetGhWatchCaches();
    const queued: Array<{ repo: string; cwd: string | null }> = [];

    await observeGhBashCommand(
      "cd /srv/checkout/repo && gh pr create --repo o/r --head fix/x --title x",
      { sessionName: "agent-workspace" },
      deps({
        resolveRepoFromCwd: () => null,
        addPending: (entry) => {
          queued.push({ repo: entry.repo, cwd: entry.cwd });
        },
      }),
    );

    // Sem cwd de sessão, o único diretório útil é o do `cd`: é onde o sweep acha a PR.
    expect(queued).toEqual([{ repo: "o/r", cwd: "/srv/checkout/repo" }]);
  });

  it("resolves consecutive cd commands in order", async () => {
    resetGhWatchCaches();
    const asked: string[] = [];
    const queued: Array<{ repo: string; cwd: string | null }> = [];

    await observeGhBashCommand(
      "cd /srv && cd checkout/repo && gh pr create --head fix/x --title x",
      { cwd: "/workspace", sessionName: "agent-workspace" },
      deps({
        resolveRepoFromCwd: (cwd) => {
          asked.push(cwd);
          return cwd === "/srv/checkout/repo" ? "o/r" : null;
        },
        addPending: (entry) => {
          queued.push({ repo: entry.repo, cwd: entry.cwd });
        },
      }),
    );

    // O segundo `cd` é relativo ao primeiro, não ao cwd da sessão.
    expect(asked).toEqual(["/workspace", "/srv/checkout/repo"]);
    expect(queued).toEqual([{ repo: "o/r", cwd: "/srv/checkout/repo" }]);
  });

  it("stays quiet when neither the cwd nor the command names a repo", async () => {
    resetGhWatchCaches();
    let queued = 0;

    await observeGhBashCommand(
      "gh pr create --head fix/x --title x",
      { sessionName: "agent-workspace" },
      deps({
        addPending: () => {
          queued += 1;
        },
      }),
    );

    expect(queued).toBe(0);
  });

  it("queues a pending follow for gh pr create, which has no number yet", async () => {
    resetGhWatchCaches();
    const queued: Array<{ repo: string; cwd: string | null; sessionName?: string }> = [];

    await observeGhBashCommand(
      "gh pr create --title x --body y",
      { cwd: "/repo", sessionName: "main", agentId: "main" },
      deps({
        resolveRepoFromCwd: (cwd) => (cwd === "/repo" ? "o/r" : null),
        addPending: (entry) => {
          queued.push({ repo: entry.repo, cwd: entry.cwd, sessionName: entry.sessionName });
        },
      }),
    );

    // O número nasce durante a execução: a PR é resolvida pelo cwd no tick seguinte.
    expect(queued).toEqual([{ repo: "o/r", cwd: "/repo", sessionName: "main" }]);
  });

  it("does not memoize the pending path, so a second PR is still followed", async () => {
    resetGhWatchCaches();
    const queued: string[] = [];

    const d = deps({
      resolveRepoFromCwd: () => "o/r",
      addPending: (entry) => {
        queued.push(`${entry.repo}#${entry.createdAt}`);
      },
    });

    await observeGhBashCommand("gh pr create --title a", { cwd: "/repo" }, d);
    await observeGhBashCommand("gh pr create --title b", { cwd: "/repo" }, d);

    // Com memo aqui, a chave seria `o/r#*` e a segunda PR nunca entraria.
    expect(queued).toHaveLength(2);
  });

  it("resolves the repo from the session cwd when the command omits it", async () => {
    resetGhWatchCaches();
    const created: string[] = [];
    await observeGhBashCommand(
      "gh pr ready 7",
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
      "gh pr ready 7",
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
    await expect(observeGhBashCommand("gh pr ready 7 --repo o/r", {}, d)).resolves.toBeUndefined();
  });

  it("queues the same pending follow when gh pr create is wrapped and piped", async () => {
    resetGhWatchCaches();
    const queued: string[] = [];
    let triggers = 0;

    await observeGhBashCommand(
      'timeout 200 env VAR=x gh pr create -R o/r --base main --head dev --title "ship" --body-file /tmp/pr.md 2>&1 | tail -5',
      { cwd: "/repo", sessionName: "main" },
      deps({
        addPending: (entry) => {
          queued.push(entry.repo);
        },
        createTrigger: () => {
          triggers += 1;
          return trigger();
        },
      }),
    );

    // O número nasce na execução. `2>&1` não pode virar a PR 1, senão o follow
    // cria trigger em vez de enfileirar.
    expect(queued).toEqual(["o/r"]);
    expect(triggers).toBe(0);
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
    await observeGhBashCommand("gh pr view 1 --repo o/r", {}, d);

    expect(listed).toBe(0);
  });

  it("creates nothing for text the Bash gate never runs as gh", async () => {
    resetGhWatchCaches();
    let work = 0;
    const d = deps({
      listWatches: () => {
        work += 1;
        return { items: [] } as never;
      },
      createTrigger: () => {
        work += 1;
        return trigger();
      },
      addPending: () => {
        work += 1;
      },
    });

    await observeGhBashCommand("ls x\\;gh pr edit 7 -R o/r", { cwd: "/repo", sessionName: "main" }, d);
    expect(tokenizeShellCommand("ls x\\;gh")).toEqual(["ls", "x;gh"]);
    expect(work).toBe(0);
  });
});

describe("durable PR follow owner", () => {
  function seed() {
    getOrCreateSession("parent-key", "agent-test", "/tmp/follow-test", { name: "parent" });
    getOrCreateSession("parent-key:thread:1.2", "agent-test", "/tmp/follow-test", { name: "child" });
    return registerInboundSlackThread({
      parentSessionKey: "parent-key",
      parentSessionName: "parent",
      childSessionKey: "parent-key:thread:1.2",
      childSessionName: "child",
      accountId: "slack-account",
      instanceId: "slack-instance",
      platformChatId: "C123",
      threadCanonicalChatId: "thread-chat",
      providerThreadId: "1.2",
    });
  }
  const deps = { listWatches: () => ({ items: [watch()] }) as never, emitTriggersRefresh: async () => {} };
  const childContext = {
    sessionName: "child",
    source: { channel: "slack", accountId: "slack-account", chatId: "C123#1.2", threadId: "1.2" },
  };

  it("arms the follow for the open thread that published, and closing the thread hands it to the parent", async () => {
    const record = seed();
    // An active trigger needs its bound agent; only then does the store refuse to close a thread it addresses.
    dbCreateAgent({ id: "agent-test", cwd: "/tmp/follow-test" });
    const result = await ensureGhWatchFollow({ repo: "o/r", prNumber: 7, context: childContext }, deps);
    expect(dbGetTrigger(result.triggerId!)!).toMatchObject({
      agentId: "agent-test",
      replySession: "child",
      replySource: { channel: "slack", accountId: "slack-account", chatId: "C123", threadId: "1.2" },
    });
    // The open thread owns the follow, so the store alone still refuses to close it with the follow pending.
    expect(() => closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! })).toThrow(
      "still receives active triggers",
    );

    expect(
      handOffClosingThreadFollows({ childSessionKey: record.childSessionKey!, childSessionName: "child" }),
    ).toEqual([result.triggerId!]);
    expect(dbGetTrigger(result.triggerId!)!).toMatchObject({
      replySession: "parent",
      replySource: { channel: "slack", accountId: "slack-account", chatId: "C123" },
    });
    expect(dbGetTrigger(result.triggerId!)!.replySource?.threadId).toBeUndefined();
    expect(closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! }).changed).toBe(true);
  });

  it("hands over only the PR follows addressed to the closing child", () => {
    const record = seed();
    dbCreateAgent({ id: "agent-test", cwd: "/tmp/follow-test" });
    const own = dbCreateTrigger({
      name: "gh-follow:o/r#7",
      topic: "ravi.watch.github.>",
      message: "own",
      agentId: "agent-test",
      session: "main",
      replySession: "child",
      replySource: childContext.source,
    });
    const custom = dbCreateTrigger({
      name: "custom-review",
      topic: "ravi.watch.github.>",
      message: "custom",
      agentId: "agent-test",
      session: "main",
      replySession: "child",
      replySource: childContext.source,
    });
    const parentOwned = dbCreateTrigger({
      name: "gh-follow:o/r#8",
      topic: "ravi.watch.github.>",
      message: "parent",
      session: "main",
      replySession: "parent",
    });

    const moved = handOffClosingThreadFollows({ childSessionKey: record.childSessionKey!, childSessionName: "child" });

    expect(moved).toEqual([own.id]);
    expect(dbGetTrigger(own.id)!.replySession).toBe("parent");
    // Another kind of trigger is a decision of whoever created it: the close keeps refusing it.
    expect(dbGetTrigger(custom.id)!.replySession).toBe("child");
    expect(dbGetTrigger(parentOwned.id)!.replySession).toBe("parent");
    expect(() => closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! })).toThrow(custom.id);
  });

  it("resolves a closed thread's follow to the parent, as the page comment follow always does", () => {
    const record = seed();
    expect(resolveGhFollowContext(childContext)).toMatchObject({ sessionName: "child" });
    closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! });
    expect(resolveGhFollowContext(childContext)).toMatchObject({
      sessionName: "parent",
      source: { channel: "slack", accountId: "slack-account", chatId: "C123" },
    });
  });

  it("resolves a delayed creation after the child has closed and been pruned", async () => {
    const record = seed();
    closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! });
    deleteSession(record.childSessionKey!);
    const result = await ensureGhWatchFollow({ repo: "o/r", prNumber: 7, context: childContext }, deps);
    expect(dbGetTrigger(result.triggerId!)!.replySession).toBe("parent");
  });

  it("tells a thread that owns a PR follow to report what changes its parent's work", () => {
    // The follow no longer wakes the channel session for a PR a thread published, so the thread carries the news.
    const message = buildGhFollowTriggerInput("o/r", 7, childContext).message;
    expect(message).toContain("`ravi sessions report`");
    expect(message).toContain("the CI conclusion on the head SHA");
    expect(message).toContain("if you are not a thread, ignore this sentence");
  });

  it("keeps an open thread's follow with the thread when another session observes the PR", async () => {
    seed();
    const old = dbCreateTrigger({
      name: "gh-follow:o/r#7",
      topic: "ravi.watch.github.>",
      message: "old",
      session: "main",
      replySession: "child",
      replySource: childContext.source,
    });
    const result = await ensureGhWatchFollow({ repo: "o/r", prNumber: 7, context: { sessionName: "unrelated" } }, deps);
    expect(result.triggerId).toBe(old.id);
    // The instruction text is refreshed; the recipient is not stolen by the observer.
    expect(dbGetTrigger(old.id)!.replySession).toBe("child");
    expect(dbGetTrigger(old.id)!.replySource).toEqual(childContext.source);
  });

  it("maintenance repairs a closed child's legacy follow and refreshes the runner", async () => {
    const record = seed();
    closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! });
    const old = dbCreateTrigger({
      name: "gh-follow:o/r#7",
      topic: "ravi.watch.github.>",
      message: "old",
      session: "main",
      replySession: "child",
      replySource: childContext.source,
    });
    let refreshes = 0;
    const result = await runGhFollowMaintenance({
      readPending: () => [],
      listPrStates: () => new Map([[7, "OPEN"]]),
      listWatches: () => [],
      ensureWatches: async () => {},
      emitTriggersRefresh: async () => {
        refreshes++;
      },
    });
    expect(result.triggersRepaired).toBe(1);
    expect(refreshes).toBe(1);
    expect(dbGetTrigger(old.id)!.replySession).toBe("parent");
  });

  it("fails closed when a known thread has no parent or an unknown thread has no lifecycle", () => {
    seed();
    deleteSession("parent-key");
    expect(() => resolveGhFollowContext(childContext)).toThrow("parent session is missing");
    expect(() => resolveGhFollowContext({ sessionKey: "missing:thread:1.2" })).toThrow("lifecycle is missing");
    expect(resolveGhFollowContext({ sessionName: "normal" })).toEqual({ sessionName: "normal" });
  });

  it("resolves the owner through the shared helper and keeps the PR follow wording of its refusals", () => {
    seed();
    expect(resolveGhFollowContext(childContext)).toEqual(
      resolveDurableFollowOwner(childContext, "PR follow", undefined, { openThreadOwns: true }),
    );
    expect(resolveDurableFollowOwner(childContext, "PR follow")).toMatchObject({ sessionName: "parent" });
    expect(() => resolveGhFollowContext({ sessionKey: "missing:thread:1.2" })).toThrow(
      "Cannot register PR follow: thread lifecycle is missing or ambiguous.",
    );
    deleteSession("parent-key");
    expect(() => resolveGhFollowContext(childContext)).toThrow(
      "Cannot register PR follow: durable parent session is missing.",
    );
  });

  it("keeps refusing a thread-like key that is not a Slack timestamp: only the page comment follow takes the narrower rule", () => {
    // A task's own thread key. `ravi pr publish` validates the publisher's lineage through this same resolver.
    expect(() => resolveGhFollowContext({ sessionKey: "agent:agent-test:thread:thr_m3k2x9_a1b2c3d4e5" })).toThrow(
      "Cannot register PR follow: thread lifecycle is missing or ambiguous.",
    );
  });

  it("maintenance removes burst loss from existing follows once without changing owners or paused state", async () => {
    seed();
    const input = buildGhFollowTriggerInput("o/r", 833, { sessionName: "parent", source: childContext.source });
    const legacy = dbCreateTrigger({ ...input, cooldownMs: 30_000 });
    const paused = dbCreateTrigger({
      ...input,
      name: "gh-follow:o/r#834",
      cooldownMs: 30_000,
      debounceMs: 2_000,
      enabled: false,
    });
    const unrelated = dbCreateTrigger({ ...input, name: "custom-review", cooldownMs: 30_000, debounceMs: 2_000 });
    let refreshes = 0;
    const maintenanceDeps = {
      readPending: () => [],
      listPrStates: () =>
        new Map([
          [833, "OPEN"],
          [834, "OPEN"],
        ]),
      listWatches: () => [],
      ensureWatches: async () => {},
      emitTriggersRefresh: async () => {
        refreshes++;
      },
    };

    expect((await runGhFollowMaintenance(maintenanceDeps)).triggersRepaired).toBe(2);
    expect(dbGetTrigger(legacy.id)).toMatchObject({
      cooldownMs: 0,
      debounceMs: 0,
      replySession: "parent",
      replySource: childContext.source,
      enabled: true,
    });
    expect(dbGetTrigger(paused.id)).toMatchObject({
      cooldownMs: 0,
      debounceMs: 0,
      enabled: false,
      replySession: "parent",
    });
    expect(dbGetTrigger(unrelated.id)).toMatchObject({ cooldownMs: 30_000, debounceMs: 2_000 });
    expect((await runGhFollowMaintenance(maintenanceDeps)).triggersRepaired).toBe(0);
    expect(refreshes).toBe(1);
  });
});
