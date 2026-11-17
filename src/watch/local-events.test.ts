import { describe, expect, it } from "bun:test";
import {
  deriveLocalGitHubEvents,
  PULL_REQUEST_COMMENT_EVENT,
  type LocalCommentObservation,
  type LocalWatchSnapshot,
} from "./local-events.js";

function comment(overrides: Partial<LocalCommentObservation> = {}): LocalCommentObservation {
  return {
    key: "issue:9",
    id: 9,
    number: 1,
    url: "https://github.com/o/r/pull/1#issuecomment-9",
    body: "olha o CI",
    author: "luis",
    updatedAt: "2026-10-22T19:00:00Z",
    ...overrides,
  };
}

function snapshotWith(input: {
  pullRequests?: Array<{ number: number; title?: string; draft?: boolean; headSha?: string }>;
  workflowRuns?: Array<{ id: number; status?: string; conclusion?: string | null }>;
}): LocalWatchSnapshot {
  return {
    version: 1,
    pullRequests: Object.fromEntries(
      (input.pullRequests ?? []).map((pr) => [
        String(pr.number),
        {
          number: pr.number,
          title: pr.title ?? `PR ${pr.number}`,
          url: `https://x/${pr.number}`,
          draft: pr.draft === true,
          ...(pr.headSha ? { headSha: pr.headSha } : {}),
        },
      ]),
    ),
    workflowRuns: Object.fromEntries(
      (input.workflowRuns ?? []).map((run) => [
        String(run.id),
        {
          id: run.id,
          name: `run-${run.id}`,
          status: run.status ?? "completed",
          conclusion: run.conclusion ?? "success",
        },
      ]),
    ),
  };
}

describe("local github watch events", () => {
  it("emits nothing on the baseline read", () => {
    const current = snapshotWith({ pullRequests: [{ number: 1 }, { number: 2 }], workflowRuns: [{ id: 9 }] });
    const result = deriveLocalGitHubEvents("o/r", { previous: null, current, departed: {} });

    // Sem baseline o primeiro tick despejaria o repositório inteiro como se tudo
    // tivesse acabado de acontecer.
    expect(result.events).toEqual([]);
    expect(result.snapshot).toEqual(current);
  });

  it("emits pull_request.opened for a PR that was not there before", () => {
    const result = deriveLocalGitHubEvents("o/r", {
      previous: snapshotWith({ pullRequests: [{ number: 1 }] }),
      current: snapshotWith({ pullRequests: [{ number: 1 }, { number: 2 }] }),
      departed: {},
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("pull_request.opened");
    expect(result.events[0]!.payload).toMatchObject({ repository: "o/r", number: 2 });
  });

  it("emits merged vs closed from the departed state", () => {
    const previous = snapshotWith({ pullRequests: [{ number: 1 }, { number: 2 }] });
    const current = snapshotWith({ pullRequests: [] });

    const merged = deriveLocalGitHubEvents("o/r", {
      previous,
      current,
      departed: { "1": { state: "MERGED", title: "a", url: "u1" } },
    });
    expect(merged.events.map((event) => event.eventType).sort()).toEqual([
      "pull_request.closed",
      "pull_request.merged",
    ]);

    const closed = deriveLocalGitHubEvents("o/r", {
      previous: snapshotWith({ pullRequests: [{ number: 1 }] }),
      current,
      departed: { "1": { state: "CLOSED", title: "a", url: "u1" } },
    });
    expect(closed.events.map((event) => event.eventType)).toEqual(["pull_request.closed"]);
  });

  it("emits draft transitions only when the flag actually flips", () => {
    const previous = snapshotWith({
      pullRequests: [
        { number: 1, draft: true },
        { number: 2, draft: false },
      ],
    });
    const current = snapshotWith({
      pullRequests: [
        { number: 1, draft: false },
        { number: 2, draft: true },
      ],
    });

    const result = deriveLocalGitHubEvents("o/r", { previous, current, departed: {} });

    expect(result.events.map((event) => event.eventType).sort()).toEqual([
      "pull_request.converted_to_draft",
      "pull_request.ready_for_review",
    ]);
  });

  it("emits synchronize when the head commit moves", () => {
    const previous = snapshotWith({ pullRequests: [{ number: 1, headSha: "aaa" }] });
    const current = snapshotWith({ pullRequests: [{ number: 1, headSha: "bbb" }] });

    const result = deriveLocalGitHubEvents("o/r", { previous, current, departed: {} });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("pull_request.synchronize");
    expect(result.events[0]!.payload).toMatchObject({ repository: "o/r", number: 1, headSha: "bbb" });

    // Mesmo SHA: nada.
    expect(deriveLocalGitHubEvents("o/r", { previous: current, current, departed: {} }).events).toEqual([]);
  });

  it("does not claim a push when either side has no head commit", () => {
    const withoutSha = snapshotWith({ pullRequests: [{ number: 1 }] });
    const withSha = snapshotWith({ pullRequests: [{ number: 1, headSha: "bbb" }] });

    // Baseline sem SHA não é evidência de push: seria um falso synchronize.
    expect(deriveLocalGitHubEvents("o/r", { previous: withoutSha, current: withSha, departed: {} }).events).toEqual([]);
    expect(deriveLocalGitHubEvents("o/r", { previous: withSha, current: withoutSha, departed: {} }).events).toEqual([]);
  });

  it("correlates a CI run to the PR whose branch it ran on", () => {
    // `gh run list` não diz a qual PR o run pertence: a ponte é a branch.
    const current: LocalWatchSnapshot = {
      version: 1,
      pullRequests: {
        "7": { number: 7, title: "minha PR", url: "https://x/7", draft: false, headRefName: "feat/x" },
      },
      workflowRuns: {
        "50": { id: 50, name: "CI", status: "completed", conclusion: "failure", branch: "feat/x" },
      },
    };
    const result = deriveLocalGitHubEvents("o/r", {
      previous: snapshotWith({
        pullRequests: [{ number: 7 }],
        workflowRuns: [{ id: 50, status: "in_progress", conclusion: null }],
      }),
      current,
      departed: {},
    });

    expect(result.events.map((event) => event.eventType)).toEqual(["workflow_run.failed", "workflow_run.completed"]);
    for (const event of result.events) {
      expect(event.payload).toMatchObject({ repository: "o/r", runId: 50, branch: "feat/x", number: 7 });
    }
  });

  it("does not attach a number when the branch has no open PR", () => {
    const result = deriveLocalGitHubEvents("o/r", {
      previous: snapshotWith({ workflowRuns: [{ id: 51, status: "in_progress", conclusion: null }] }),
      current: {
        version: 1,
        pullRequests: {},
        workflowRuns: { "51": { id: 51, name: "CI", status: "completed", conclusion: "success", branch: "main" } },
      },
      departed: {},
    });

    expect(result.events[0]!.payload).not.toHaveProperty("number");
  });

  it("emits a completed workflow run once, with the outcome and the completion", () => {
    const previous = snapshotWith({ workflowRuns: [{ id: 7, status: "in_progress", conclusion: null }] });
    const current = snapshotWith({ workflowRuns: [{ id: 7, status: "completed", conclusion: "failure" }] });

    const first = deriveLocalGitHubEvents("o/r", { previous, current, departed: {} });
    expect(first.events.map((event) => event.eventType)).toEqual(["workflow_run.failed", "workflow_run.completed"]);

    // Já estava completed: não repete a cada tick.
    const second = deriveLocalGitHubEvents("o/r", { previous: current, current, departed: {} });
    expect(second.events).toEqual([]);
  });

  it("ignores workflow runs that are still in flight", () => {
    const result = deriveLocalGitHubEvents("o/r", {
      previous: snapshotWith({ workflowRuns: [] }),
      current: snapshotWith({ workflowRuns: [{ id: 8, status: "in_progress", conclusion: null }] }),
      departed: {},
    });

    expect(result.events).toEqual([]);
  });

  it("emits a new PR comment once, with enough payload for the follow filter", () => {
    const current = snapshotWith({ pullRequests: [{ number: 1 }] });
    const observed = [comment()];

    const first = deriveLocalGitHubEvents("o/r", {
      previous: { ...current, comments: {} },
      current,
      departed: {},
      comments: observed,
    });
    expect(first.events.map((event) => event.eventType)).toEqual([PULL_REQUEST_COMMENT_EVENT]);
    // O filtro do follow casa por repository + number (ou pull_request.number).
    expect(first.events[0]!.payload).toMatchObject({
      repository: "o/r",
      number: 1,
      pull_request: { number: 1 },
      commentId: 9,
      author: "luis",
      url: "https://github.com/o/r/pull/1#issuecomment-9",
    });
    // O estado guarda só a identidade: corpo de terceiro não vai pro snapshot.
    expect(first.snapshot.comments).toEqual({ "issue:9": { updatedAt: "2026-10-22T19:00:00Z" } });

    // Mesmo id de novo (edição/relido) não é comentário novo.
    const second = deriveLocalGitHubEvents("o/r", {
      previous: first.snapshot,
      current,
      departed: {},
      comments: [comment({ updatedAt: "2026-10-22T20:00:00Z", body: "editado" })],
    });
    expect(second.events).toEqual([]);
  });

  it("treats a snapshot from before comment reading as baseline, not as a burst", () => {
    const current = snapshotWith({ pullRequests: [{ number: 1 }] });
    const legacyPrevious = snapshotWith({ pullRequests: [{ number: 1 }] });
    delete legacyPrevious.comments;

    const result = deriveLocalGitHubEvents("o/r", {
      previous: legacyPrevious,
      current,
      departed: {},
      comments: [comment(), comment({ key: "issue:10", id: 10 })],
    });

    // Sem isso, o primeiro tick depois do deploy despejaria os últimos 100
    // comentários do repo como se todos tivessem acabado de acontecer.
    expect(result.events).toEqual([]);
    expect(Object.keys(result.snapshot.comments ?? {}).sort()).toEqual(["issue:10", "issue:9"]);
  });

  it("keeps the previous comment state when the tick could not read comments", () => {
    const current = snapshotWith({ pullRequests: [{ number: 1 }] });
    const previous: LocalWatchSnapshot = { ...current, comments: { "issue:9": { updatedAt: "x" } } };

    const result = deriveLocalGitHubEvents("o/r", { previous, current, departed: {} });

    expect(result.events).toEqual([]);
    expect(result.snapshot.comments).toEqual({ "issue:9": { updatedAt: "x" } });
  });

  it("does not replay a comment that left the recent window and came back", () => {
    const current = snapshotWith({ pullRequests: [{ number: 1 }] });
    const baseline = deriveLocalGitHubEvents("o/r", {
      previous: null,
      current,
      departed: {},
      comments: [comment()],
    });

    // PR fecha: o comentário sai da janela recente e o próximo snapshot não o vê.
    const withoutComments = deriveLocalGitHubEvents("o/r", {
      previous: baseline.snapshot,
      current,
      departed: {},
      comments: [],
    });
    expect(Object.keys(withoutComments.snapshot.comments ?? {})).toEqual(["issue:9"]);

    // PR reabre e o mesmo comentário reaparece na janela: não é comentário novo.
    const reopened = deriveLocalGitHubEvents("o/r", {
      previous: withoutComments.snapshot,
      current,
      departed: {},
      comments: [comment({ updatedAt: "2026-10-22T21:00:00Z" })],
    });
    expect(reopened.events).toEqual([]);
  });

  it("bounds the comment state by dropping the oldest entries", () => {
    const current = snapshotWith({ pullRequests: [{ number: 1 }] });
    const previous: LocalWatchSnapshot = {
      ...current,
      comments: Object.fromEntries(
        Array.from({ length: 520 }, (_, index) => [
          `issue:${1000 + index}`,
          { updatedAt: `2026-10-22T00:00:${String(index % 60).padStart(2, "0")}Z` },
        ]),
      ),
    };

    const result = deriveLocalGitHubEvents("o/r", {
      previous,
      current,
      departed: {},
      comments: [comment({ updatedAt: "2026-10-22T23:00:00Z" })],
    });

    const keys = Object.keys(result.snapshot.comments ?? {});
    expect(keys.length).toBe(500);
    // O recém-visto sobrevive à poda.
    expect(keys).toContain("issue:9");
  });
});
