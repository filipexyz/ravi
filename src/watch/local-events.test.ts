import { describe, expect, it } from "bun:test";
import { deriveLocalGitHubEvents, type LocalWatchSnapshot } from "./local-events.js";

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
});
