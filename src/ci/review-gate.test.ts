import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const { createApi, evaluate } = require("./review-gate.cjs");
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const args = { owner: "example", repo: "repo", number: 1, expectedSha: HEAD };
const author = { login: "author", __typename: "User" };
const reviewer = { login: "reviewer", __typename: "User" };
const authorProvenance = '<!-- ravi-author {"agent":"builder","session":"build-session"} -->';
function verdict(overrides = {}) {
  return `<!-- ravi-review ${JSON.stringify({
    head: HEAD,
    agent: "reviewer",
    session: "review-session",
    authorSession: "build-session",
    verdict: "approved",
    reason: "Reviewed the complete diff and focused test evidence.",
    resolves: [],
    ...overrides,
  })} -->`;
}
const approval = {
  id: "approval",
  author: reviewer,
  state: "APPROVED",
  commit: { oid: HEAD },
  submittedAt: "2026-10-31T20:00:00Z",
  body: verdict(),
  url: "https://github.com/example/repo/pull/1#pullrequestreview-approval",
};
const finding = {
  id: "finding",
  author: { login: "review-bot", __typename: "Bot" },
  state: "COMMENTED",
  commit: { oid: HEAD },
  submittedAt: "2026-10-31T19:00:00Z",
  body: "Finding tracked in the native thread.",
  url: "https://github.com/example/repo/pull/1#pullrequestreview-finding",
};
const thread = {
  id: "thread",
  isResolved: true,
  isOutdated: false,
  comments: {
    nodes: [{ url: "https://github.com/example/repo/pull/1#discussion_r1", pullRequestReview: { id: "finding" } }],
  },
};
const dismissal = {
  __typename: "ReviewDismissedEvent",
  id: "dismissal",
  actor: reviewer,
  review: { id: "finding" },
  dismissalMessage: `review-gate-dismiss ${HEAD}\nReason: The reported input is rejected by the validated upstream boundary.`,
  createdAt: "2026-10-31T19:30:00Z",
  previousReviewState: "COMMENTED",
  url: "https://github.com/example/repo/pull/1#event-1",
  pullRequestCommit: null,
};

function fixture() {
  const state: any = {
    pr: {
      headRefOid: HEAD,
      author,
      state: "OPEN",
      baseRefName: "dev",
      isDraft: false,
      body: authorProvenance,
      url: "https://github.com/example/repo/pull/1",
    },
    reviewThreads: [structuredClone(thread)],
    reviews: [structuredClone(finding), structuredClone(approval)],
    timelineItems: [],
    comments: [],
    writers: ["reviewer"],
  };
  const calls: any[] = [];
  const api: any = {
    permission: async () => "write",
    independentWriters: async () => structuredClone(state.writers),
    graphql: async (query: string, variables: any) => {
      calls.push({ query, variables });
      const key = ["reviewThreads", "reviews", "timelineItems", "comments"].find((name) =>
        query.includes(`${name}(first:`),
      );
      const pr = structuredClone(state.pr);
      if (key) {
        const nodes = structuredClone(state[key]);
        pr[key] = { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      return { repository: { pullRequest: pr } };
    },
  };
  return { api, state, calls };
}

describe("required review gate scenarios", () => {
  test("1: an unresolved thread blocks, even with an independent head approval", async () => {
    const { api, state } = fixture();
    state.reviewThreads[0].isResolved = false;
    const result = await evaluate(api, args);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("Unresolved review thread");
  });

  test("2: resolved threads plus an independent approval on the head pass", async () => {
    const { api } = fixture();
    const result = await evaluate(api, args);
    expect(result.ok).toBe(true);
    expect(result.sha).toBe(HEAD);
    expect(result.audit.join("\n")).toContain(`by reviewer on ${HEAD}`);
  });

  test("3: API failure never becomes an empty list/success", async () => {
    const { api } = fixture();
    api.graphql = async () => {
      throw new Error("HTTP 403");
    };
    await expect(evaluate(api, args)).rejects.toThrow("HTTP 403");
  });

  test("4: new push invalidates the old approval, including a previously resolved thread", async () => {
    const { api, state } = fixture();
    state.pr.headRefOid = NEXT;
    const result = await evaluate(api, { ...args, expectedSha: NEXT });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("No independent writer approval");
    await expect(evaluate(api, args)).rejects.toThrow("head SHA changed");
  });
});

describe("identity, dismissal and current evidence", () => {
  test.each([author, { login: "bot", __typename: "Bot" }])("author/bot cannot approve", async (actor) => {
    const { api, state } = fixture();
    state.reviews[1].author = actor;
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("reader cannot approve and permission API failure blocks", async () => {
    const { api } = fixture();
    api.permission = async () => "read";
    expect((await evaluate(api, args)).ok).toBe(false);
    api.permission = async () => {
      throw new Error("permission denied");
    };
    await expect(evaluate(api, args)).rejects.toThrow("permission denied");
  });

  test("later changes requested supersede an earlier approval", async () => {
    const { api, state } = fixture();
    state.reviews.push({ ...approval, id: "changes", state: "CHANGES_REQUESTED", submittedAt: "2026-10-31T21:00:00Z" });
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("outdated unresolved findings still block", async () => {
    const { api, state } = fixture();
    state.reviewThreads[0].isResolved = false;
    state.reviewThreads[0].isOutdated = true;
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("justified dismissal is audited and STILL requires native resolution", async () => {
    const { api, state } = fixture();
    state.reviews[0].state = "DISMISSED";
    state.timelineItems.push(structuredClone(dismissal));
    const result = await evaluate(api, args);
    expect(result.ok).toBe(true);
    expect(result.audit.join("\n")).toContain("Dismissal dismissal by reviewer for thread");
    state.reviewThreads[0].isResolved = false;
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test.each(["missing reason", "wrong sha", "self dismissal", "no event", "automatic stale dismissal"])(
    "rejects dismissal: %s",
    async (variant) => {
      const { api, state } = fixture();
      state.reviews[0].state = "DISMISSED";
      const event: any = structuredClone(dismissal);
      if (variant === "missing reason") event.dismissalMessage = `review-gate-dismiss ${HEAD}\nReason: `;
      if (variant === "wrong sha") event.dismissalMessage = event.dismissalMessage.replace(HEAD, NEXT);
      if (variant === "self dismissal") event.actor = author;
      if (variant === "automatic stale dismissal") event.pullRequestCommit = { commit: { oid: NEXT } };
      if (variant !== "no event") state.timelineItems.push(event);
      expect((await evaluate(api, args)).ok).toBe(false);
    },
  );

  test("head changing mid-query blocks", async () => {
    const { api, state } = fixture();
    const original = api.graphql;
    let calls = 0;
    api.graphql = async (...values: any[]) => {
      if (++calls === 4) state.pr.headRefOid = NEXT;
      return original(...values);
    };
    await expect(evaluate(api, args)).rejects.toThrow("head SHA changed");
  });

  test("a stale justified dismissal requires a new independent approval explicitly renewing it", async () => {
    const { api, state } = fixture();
    state.pr.headRefOid = NEXT;
    state.reviews[0].state = "DISMISSED";
    state.timelineItems.push(structuredClone(dismissal));
    state.reviews[1].commit.oid = NEXT;
    expect((await evaluate(api, { ...args, expectedSha: NEXT })).ok).toBe(false);
    state.reviews[1].body = `${verdict({ head: NEXT })}\nreview-gate-renew dismissal ${NEXT}\nReason: Rechecked the changed code; the upstream input validation still applies.`;
    state.reviews[1].url = "https://github.com/example/repo/pull/1#pullrequestreview-2";
    expect((await evaluate(api, { ...args, expectedSha: NEXT })).ok).toBe(true);
  });

  test("native stale approval dismissal is not a finding waiver", async () => {
    const { api, state } = fixture();
    state.reviews[0].state = "DISMISSED";
    state.timelineItems.push({
      ...dismissal,
      previousReviewState: "APPROVED",
      pullRequestCommit: { commit: { oid: HEAD } },
      dismissalMessage: null,
    });
    expect((await evaluate(api, args)).ok).toBe(true);
    state.reviewThreads[0].isResolved = false;
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("same-SHA review state changing mid-query also blocks", async () => {
    const { api, state } = fixture();
    const original = api.graphql;
    let calls = 0;
    api.graphql = async (...values: any[]) => {
      if (++calls === 6) state.reviewThreads[0].isResolved = false;
      return original(...values);
    };
    await expect(evaluate(api, args)).rejects.toThrow("evidence changed");
  });

  test("zero threads is valid only with explicit complete data and an approval", async () => {
    const { api, state } = fixture();
    state.reviewThreads = [];
    expect((await evaluate(api, args)).ok).toBe(true);
    state.reviews = [];
    expect((await evaluate(api, args)).ok).toBe(false);
  });
});

describe("complete API data or fail closed", () => {
  test.each([
    "null PR",
    "missing nodes",
    "truncated nodes",
    "null node",
    "missing pageInfo",
    "missing resolution",
    "missing head",
    "graphql error",
    "repeated cursor",
  ])("rejects %s", async (variant) => {
    const { api } = fixture();
    const original = api.graphql;
    api.graphql = async (...values: any[]) => {
      const result = await original(...values);
      const pr = result.repository.pullRequest;
      if (variant === "null PR") result.repository.pullRequest = null;
      if (variant === "graphql error") result.errors = [{ message: "partial error" }];
      if (pr.reviewThreads) {
        if (variant === "missing nodes") delete pr.reviewThreads.nodes;
        if (variant === "truncated nodes") pr.reviewThreads.totalCount++;
        if (variant === "null node") pr.reviewThreads.nodes = [null];
        if (variant === "missing pageInfo") delete pr.reviewThreads.pageInfo;
        if (variant === "missing resolution") delete pr.reviewThreads.nodes[0].isResolved;
        if (variant === "missing head") delete pr.headRefOid;
        if (variant === "repeated cursor") pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "same" };
      }
      return result;
    };
    await expect(evaluate(api, args)).rejects.toThrow();
  });

  test("unresolved thread on page two blocks", async () => {
    const { api } = fixture();
    const original = api.graphql;
    api.graphql = async (query: string, variables: any) => {
      const result = await original(query, variables);
      const pr = result.repository.pullRequest;
      if (pr.reviewThreads) {
        pr.reviewThreads = variables.cursor
          ? {
              nodes: [{ ...thread, id: "second", isResolved: false }],
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: "last" },
            }
          : { nodes: [thread], totalCount: 2, pageInfo: { hasNextPage: true, endCursor: "next" } };
      }
      return result;
    };
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test.each([403, 429, 500])("HTTP %d blocks", async (status) => {
    const api = createApi("test", async () => new Response("{}", { status }));
    await expect(evaluate(api, args)).rejects.toThrow(`HTTP ${status}`);
  });

  test.each(["", "null", "{}", '{"data":null}', '{"data":{},"errors":[{"message":"denied"}]}'])(
    "empty/partial response blocks: %s",
    async (body) => {
      const api = createApi("test", async () => new Response(body));
      await expect(evaluate(api, args)).rejects.toThrow();
    },
  );

  test("network failure blocks", async () => {
    const api = createApi("test", async () => {
      throw new Error("offline");
    });
    await expect(evaluate(api, args)).rejects.toThrow("offline");
  });
});

test("workflow gate is unconditional, read-only, and listens for pushes and review changes", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/review-gate.yml", import.meta.url), "utf8");
  expect(workflow).toContain("name: Review Gate\n");
  expect(workflow).toContain("synchronize");
  expect(workflow).toContain("pull_request_review:");
  expect(workflow).toContain("pull_request_review_comment:");
  expect(workflow).toContain("run: node src/ci/review-gate.cjs");
  expect(workflow).not.toContain("continue-on-error:");
  expect(workflow).not.toContain("if:");
  expect(workflow).not.toContain("paths-ignore:");
  expect(workflow).not.toContain("paths:");
  expect(workflow).not.toContain("branches:");
  expect(workflow).not.toContain(": write");
});

describe("agent/session verdicts and code blockers across GitHub surfaces", () => {
  const blockedComment = {
    id: "code-blocker",
    author,
    body: "Independent review: **blocked-por-código**. Flags still enable stdin.",
    url: "https://github.com/example/repo/pull/1#issuecomment-6550021053",
    updatedAt: "2026-10-31T21:00:00Z",
  };

  test("#776: issue comment after green turns the same head red; edit/delete re-evaluate", async () => {
    const { api, state } = fixture();
    expect((await evaluate(api, args)).ok).toBe(true);
    state.comments.push(structuredClone(blockedComment));
    const blocked = await evaluate(api, args);
    expect(blocked.sha).toBe(HEAD);
    expect(blocked.ok).toBe(false);
    expect(blocked.problems.join("\n")).toContain(blockedComment.url);
    state.comments[0].body = "Finding withdrawn after checking the corrected branch.";
    expect((await evaluate(api, args)).ok).toBe(true);
    state.comments[0].body = blockedComment.body;
    expect((await evaluate(api, args)).ok).toBe(false);
    state.comments = [];
    expect((await evaluate(api, args)).ok).toBe(true);
  });

  test.each(["PR body", "review body", "issue comment"])(
    "code blocker in %s cannot be hidden by approval",
    async (where) => {
      const { api, state } = fixture();
      if (where === "PR body") state.pr.body += `\n${blockedComment.body}`;
      if (where === "review body") state.reviews[0].body = blockedComment.body;
      if (where === "issue comment") state.comments.push(blockedComment);
      expect((await evaluate(api, args)).problems.join("\n")).toContain("Unresolved code-blocked review");
    },
  );

  test("single writer can publish a review from a different session on the exact head", async () => {
    const { api, state } = fixture();
    state.writers = [];
    state.reviews = [];
    state.reviewThreads = [];
    state.comments = [{ ...blockedComment, body: verdict() }];
    expect((await evaluate(api, args)).ok).toBe(true);
    state.comments[0].body = verdict({ session: "build-session", agent: "builder" });
    expect((await evaluate(api, args)).ok).toBe(false);
    state.comments[0].body = verdict({ head: NEXT });
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("a second writer makes native approval mandatory in addition to the session verdict", async () => {
    const { api, state } = fixture();
    state.reviews[1].state = "COMMENTED";
    state.writers = [];
    expect((await evaluate(api, args)).ok).toBe(true);
    state.writers = ["reviewer"];
    expect((await evaluate(api, args)).problems.join("\n")).toContain("No independent writer approval");
    state.reviews[1].state = "APPROVED";
    expect((await evaluate(api, args)).ok).toBe(true);
    state.reviews[1].body = "Native approval without agent provenance.";
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("finding needs an explicit newer resolution from a current-head independent session", async () => {
    const { api, state } = fixture();
    state.comments = [blockedComment];
    state.reviews[1].body = verdict({ resolves: [blockedComment.url] });
    expect((await evaluate(api, args)).ok).toBe(false);
    state.reviews[1].submittedAt = "2026-10-31T22:00:00Z";
    expect((await evaluate(api, args)).ok).toBe(true);
    state.comments[0] = { ...blockedComment, updatedAt: "2026-10-31T23:00:00Z" };
    expect((await evaluate(api, args)).ok).toBe(false);
  });

  test("missing author provenance, reader publication and malformed verdicts fail closed", async () => {
    const { api, state } = fixture();
    state.pr.body = "";
    expect((await evaluate(api, args)).ok).toBe(false);
    state.pr.body = authorProvenance;
    api.permission = async () => "read";
    expect((await evaluate(api, args)).ok).toBe(false);
    state.reviews[1].body = '<!-- ravi-review {"head":"invalid"} -->';
    await expect(evaluate(api, args)).rejects.toThrow("malformed agent review verdict");
  });

  test("a code blocker on the second issue-comment page is included", async () => {
    const { api } = fixture();
    const original = api.graphql;
    api.graphql = async (query: string, variables: any) => {
      const result = await original(query, variables);
      const pr = result.repository.pullRequest;
      if (pr.comments) {
        pr.comments = variables.cursor
          ? { nodes: [blockedComment], totalCount: 2, pageInfo: { hasNextPage: false, endCursor: "last" } }
          : {
              nodes: [{ ...blockedComment, id: "benign", body: "Review in progress." }],
              totalCount: 2,
              pageInfo: { hasNextPage: true, endCursor: "next" },
            };
      }
      return result;
    };
    expect((await evaluate(api, args)).problems.join("\n")).toContain(blockedComment.url);
  });

  test("a comment edit while a green decision is being evaluated fails closed", async () => {
    const { api, state } = fixture();
    const original = api.graphql;
    let reads = 0;
    api.graphql = async (query: string, variables: any) => {
      if (query.includes("comments(first:100") && ++reads === 2) state.comments.push(blockedComment);
      return original(query, variables);
    };
    await expect(evaluate(api, args)).rejects.toThrow("comments: evidence changed");
  });

  test.each(["missing", "truncated"])("%s issue-comment data cannot mean no blockers", async (variant) => {
    const { api } = fixture();
    const original = api.graphql;
    api.graphql = async (query: string, variables: any) => {
      const result = await original(query, variables);
      const pr = result.repository.pullRequest;
      if (pr.comments) {
        if (variant === "missing") delete pr.comments.nodes;
        else pr.comments.totalCount++;
      }
      return result;
    };
    await expect(evaluate(api, args)).rejects.toThrow("comments:");
  });
});
