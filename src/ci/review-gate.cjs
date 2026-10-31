// Dependency-free so the gate can run with a read-only token, without installing PR dependencies.
const { readFileSync, appendFileSync } = require("node:fs");

const CHECK_NAME = "Review Gate";
const SHA = /^[a-f0-9]{40}$/;
// Set true when native writer approval should be mandatory even in single-writer repos.
const REQUIRE_NATIVE_WRITER_APPROVAL = false;
const FIELDS = {
  comments: `comments(first:100, after:$cursor) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { id body url updatedAt author { login __typename } }
  }`,
  reviewThreads: `reviewThreads(first:100, after:$cursor) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { id isResolved isOutdated comments(first:1) {
      nodes { url pullRequestReview { id } }
    } }
  }`,
  reviews: `reviews(first:100, after:$cursor) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { id state submittedAt body url author { login __typename } commit { oid } }
  }`,
  // Filtering timelineItems by itemTypes gives an UNFILTERED totalCount on GitHub.
  // Fetch the whole connection and filter locally, so completeness is verifiable.
  timelineItems: `timelineItems(first:100, after:$cursor) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { __typename ... on Node { id }
      ... on ReviewDismissedEvent {
        actor { login __typename } review { id } dismissalMessage
        createdAt previousReviewState url pullRequestCommit { commit { oid } }
      }
    }
  }`,
};

function requireData(condition, message) {
  if (!condition) throw new Error(`Review data unavailable or inconsistent: ${message}`);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value) {
  requireData(nonempty(value) && Number.isFinite(Date.parse(value)), "invalid timestamp");
  return Date.parse(value);
}

function validatePR(pr, expectedSha) {
  requireData(pr && SHA.test(pr.headRefOid), "missing PR/head SHA");
  requireData(pr.state === "OPEN" && nonempty(pr.baseRefName), "PR is not open");
  requireData(nonempty(pr.author?.login), "missing PR author");
  requireData(typeof pr.isDraft === "boolean", "missing draft state");
  requireData(typeof pr.body === "string" && nonempty(pr.url), "missing PR body/URL");
  requireData(pr.headRefOid === expectedSha, "head SHA changed; a new run is required");
  return pr;
}

async function readPR(api, repo, number, expectedSha) {
  const result = await api.graphql(
    `query($owner:String!,$repo:String!,$number:Int!) {
    repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
      headRefOid state baseRefName isDraft body url author { login }
    } }
  }`,
    { ...repo, number },
  );
  requireData(!result?.errors, "GraphQL errors");
  return validatePR(result?.repository?.pullRequest, expectedSha);
}

function envelope(body, name) {
  const matches = [...body.matchAll(new RegExp(`<!-- ${name} ([\\s\\S]*?) -->`, "g"))];
  requireData(matches.length <= 1, `duplicate ${name} provenance`);
  if (!matches.length) return null;
  const value = JSON.parse(matches[0][1]);
  requireData(value && typeof value === "object" && !Array.isArray(value), `invalid ${name} provenance`);
  return value;
}

function identity(value) {
  return value && nonempty(value.agent) && nonempty(value.session);
}

async function readConnection(api, repo, number, expectedSha, key) {
  const nodes = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor = null;
  let total;
  for (let page = 0; page < 1000; page++) {
    const result = await api.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
      repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
        headRefOid ${FIELDS[key]}
      } }
    }`,
      { ...repo, number, cursor },
    );
    requireData(!result?.errors, `${key}: GraphQL errors`);
    const pr = result?.repository?.pullRequest;
    requireData(pr?.headRefOid === expectedSha, `${key}: head SHA changed or missing`);
    const connection = pr[key];
    requireData(connection && Array.isArray(connection.nodes), `${key}: missing nodes`);
    requireData(Number.isSafeInteger(connection.totalCount) && connection.totalCount >= 0, `${key}: missing count`);
    requireData(typeof connection.pageInfo?.hasNextPage === "boolean", `${key}: missing pageInfo`);
    total ??= connection.totalCount;
    requireData(total === connection.totalCount, `${key}: count changed during pagination`);
    for (const node of connection.nodes) {
      requireData(nonempty(node?.id) && !ids.has(node.id), `${key}: null/duplicate node`);
      ids.add(node.id);
      nodes.push(node);
    }
    requireData(nodes.length <= total, `${key}: more nodes than totalCount`);
    if (!connection.pageInfo.hasNextPage) {
      requireData(nodes.length === total, `${key}: incomplete response`);
      return nodes;
    }
    const next = connection.pageInfo.endCursor;
    requireData(connection.nodes.length > 0 && nonempty(next) && !cursors.has(next), `${key}: invalid pagination`);
    cursors.add(next);
    cursor = next;
  }
  throw new Error(`${key}: pagination limit reached; refusing incomplete evidence`);
}

async function evaluate(api, { owner, repo, number, expectedSha }) {
  requireData(SHA.test(expectedSha), "missing expected SHA");
  const repository = { owner, repo };
  const pr = await readPR(api, repository, number, expectedSha);
  const threads = await readConnection(api, repository, number, expectedSha, "reviewThreads");
  const reviews = await readConnection(api, repository, number, expectedSha, "reviews");
  const timeline = await readConnection(api, repository, number, expectedSha, "timelineItems");
  const comments = await readConnection(api, repository, number, expectedSha, "comments");
  const writers = await api.independentWriters(owner, repo, pr.author.login);
  requireData(Array.isArray(writers) && writers.every(nonempty), "missing independent writer inventory");
  const nativeRequired = REQUIRE_NATIVE_WRITER_APPROVAL || writers.length > 0;
  const problems = [];
  const audit = [];
  if (pr.isDraft) problems.push("PR is still a draft.");

  const permissions = new Map();
  async function independentWriter(actor) {
    if (actor?.__typename !== "User" || !nonempty(actor.login)) return false;
    if (actor.login.toLowerCase() === pr.author.login.toLowerCase()) return false;
    if (!permissions.has(actor.login)) {
      const permission = await api.permission(owner, repo, actor.login);
      requireData(
        ["admin", "maintain", "write", "read", "triage", "none"].includes(permission),
        "missing reviewer permission",
      );
      permissions.set(actor.login, ["admin", "maintain", "write"].includes(permission));
    }
    return permissions.get(actor.login);
  }

  const byId = new Map();
  const latest = new Map();
  for (const review of reviews) {
    requireData(
      ["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state),
      "invalid review state",
    );
    byId.set(review.id, review);
    if (review.state === "PENDING") continue;
    requireData(nonempty(review.author?.login) && SHA.test(review.commit?.oid), "missing review identity/commit");
    timestamp(review.submittedAt);
    if (review.state === "COMMENTED") continue;
    const key = review.author.login.toLowerCase();
    const previous = latest.get(key);
    if (!previous || timestamp(review.submittedAt) >= timestamp(previous.submittedAt)) latest.set(key, review);
  }

  let approved = false;
  for (const review of latest.values()) {
    if (review.state === "CHANGES_REQUESTED")
      problems.push(`Changes requested by ${review.author.login} (${review.id}).`);
    if (review.state === "APPROVED" && review.commit.oid === expectedSha && (await independentWriter(review.author))) {
      approved = true;
      audit.push(`Approval ${review.id} by ${review.author.login} on ${expectedSha}.`);
    }
  }
  if (nativeRequired && !approved) problems.push(`No independent writer approval on head SHA ${expectedSha}.`);

  // An authenticated writer can publish an agent review using the same GitHub
  // account as the author. Independence is recorded runtime provenance, not a
  // claim that two strings are cryptographic proof of two different people.
  const authorIdentity = envelope(pr.body, "ravi-author");
  if (!identity(authorIdentity)) problems.push("Missing author agent/session provenance in PR body.");
  const surfaces = [
    { id: "pr-body", body: pr.body, url: pr.url },
    ...reviews.filter((review) => review.state !== "PENDING"),
    ...comments,
  ];
  const blockers = [];
  const verdicts = [];
  for (const surface of surfaces) {
    requireData(typeof surface.body === "string" && nonempty(surface.url), "missing review body/URL");
    if (/\bblocked-por-c[oó]digo\b/i.test(surface.body)) blockers.push(surface);
    const verdict = envelope(surface.body, "ravi-review");
    if (!verdict || surface.id === "pr-body") continue;
    requireData(
      SHA.test(verdict.head) &&
        identity(verdict) &&
        nonempty(verdict.authorSession) &&
        ["approved", "blocked-por-código"].includes(verdict.verdict) &&
        nonempty(verdict.reason) &&
        Array.isArray(verdict.resolves) &&
        verdict.resolves.every(nonempty),
      "malformed agent review verdict",
    );
    if (verdict.verdict !== "approved" || verdict.head !== expectedSha || !identity(authorIdentity)) continue;
    if (verdict.session === authorIdentity.session || verdict.authorSession !== authorIdentity.session) continue;
    requireData(nonempty(surface.author?.login), "missing verdict publisher");
    const permission = await api.permission(owner, repo, surface.author.login);
    requireData(
      ["admin", "maintain", "write", "read", "triage", "none"].includes(permission),
      "missing publisher permission",
    );
    if (!["admin", "maintain", "write"].includes(permission)) continue;
    const submitted = timestamp(surface.updatedAt ?? surface.submittedAt);
    verdicts.push({ verdict, surface, submitted });
    audit.push(
      `Agent review ${verdict.agent}/${verdict.session} on ${expectedSha}, published by ${surface.author.login}: ${surface.url}`,
    );
  }
  if (!verdicts.length) problems.push(`No independent agent/session verdict on head SHA ${expectedSha}.`);
  for (const blocker of blockers) {
    // A new approval does not implicitly waive a code finding. It must name the
    // exact evidence URL and be newer than that evidence (including edits).
    const blockedAt = blocker.id === "pr-body" ? Infinity : timestamp(blocker.updatedAt ?? blocker.submittedAt);
    if (!verdicts.some(({ verdict, submitted }) => submitted > blockedAt && verdict.resolves.includes(blocker.url))) {
      problems.push(`Unresolved code-blocked review: ${blocker.url}.`);
    }
  }
  audit.push(`Native writer approval ${nativeRequired ? "required" : "not required: no second writer"}.`);

  const dismissals = timeline.filter((event) => event.__typename === "ReviewDismissedEvent");
  for (const thread of threads) {
    requireData(
      typeof thread.isResolved === "boolean" && typeof thread.isOutdated === "boolean",
      "missing thread resolution",
    );
    const comment = thread.comments?.nodes?.[0];
    requireData(nonempty(comment?.url) && nonempty(comment?.pullRequestReview?.id), "missing thread origin");
    const review = byId.get(comment.pullRequestReview.id);
    requireData(review, "thread review missing from complete review list");
    // A native resolution alone is never an approval. A current-head independent
    // approval above re-certifies resolved (including outdated) findings after every push.
    const reviewDismissals = dismissals.filter((event) => event.review?.id === review.id);
    const automaticStaleApproval =
      review.state === "DISMISSED" &&
      reviewDismissals.some((event) => event.previousReviewState === "APPROVED" && event.pullRequestCommit);
    if (thread.isResolved && (review.state !== "DISMISSED" || automaticStaleApproval)) continue;
    let dismissal;
    if (review.state === "DISMISSED") {
      for (const event of reviewDismissals) {
        if (event.pullRequestCommit) continue;
        // Native dismissal events preserve actor, reason, timestamp and URL.
        // The explicit SHA prevents recycling a dismissal on a subsequent push.
        const match = /^review-gate-dismiss ([a-f0-9]{40})\r?\nReason: ([\s\S]+)$/.exec(event.dismissalMessage ?? "");
        if (!match || match[2].trim().length < 20) continue;
        timestamp(event.createdAt);
        requireData(nonempty(event.url), "missing dismissal audit URL");
        if (!(await independentWriter(event.actor))) continue;
        if (match[1] === expectedSha) {
          dismissal = event;
          continue;
        }
        // A native dismissal cannot be dismissed again after a push. Re-certify
        // it in a NEW current-head review, naming the immutable dismissal event.
        for (const attestation of latest.values()) {
          if (attestation.state !== "APPROVED" || attestation.commit.oid !== expectedSha) continue;
          const renewals = [
            ...(attestation.body ?? "").matchAll(/^review-gate-renew (\S+) ([a-f0-9]{40})\r?\nReason: ([^\r\n]+)$/gm),
          ];
          if (
            !renewals.some(
              (renewal) => renewal[1] === event.id && renewal[2] === expectedSha && renewal[3].trim().length >= 20,
            )
          )
            continue;
          if (!(await independentWriter(attestation.author))) continue;
          requireData(nonempty(attestation.url), "missing renewal audit URL");
          dismissal = event;
          audit.push(
            `Dismissal renewed by ${attestation.author.login} on ${expectedSha}: ${attestation.url}\n${attestation.body}`,
          );
        }
      }
    }
    if (dismissal) {
      audit.push(
        `Dismissal ${dismissal.id} by ${dismissal.actor.login} for ${thread.id} on ${expectedSha}: ${dismissal.url}\n${dismissal.dismissalMessage}`,
      );
      // GitHub's native conversation-resolution rule still requires resolving it.
      // A justified dismissal records the exception, but NEVER turns an open thread green.
    } else if (review.state === "DISMISSED") {
      problems.push(`Dismissed finding lacks an independent, justified dismissal for this SHA: ${comment.url}.`);
    }
    if (!thread.isResolved) problems.push(`Unresolved review thread (outdated=${thread.isOutdated}): ${comment.url}.`);
  }

  // Re-read *all* evidence before accepting, not just the head SHA. A review,
  // dismissal or thread change during pagination invalidates this run.
  const current = await readPR(api, repository, number, expectedSha);
  requireData(
    current.baseRefName === pr.baseRefName && current.isDraft === pr.isDraft && current.body === pr.body,
    "PR changed during evaluation",
  );
  if (problems.length === 0) {
    for (const [key, before] of [
      ["reviewThreads", threads],
      ["reviews", reviews],
      ["timelineItems", timeline],
      ["comments", comments],
    ]) {
      const after = await readConnection(api, repository, number, expectedSha, key);
      requireData(JSON.stringify(before) === JSON.stringify(after), `${key}: evidence changed during evaluation`);
    }
    requireData(
      JSON.stringify(await api.independentWriters(owner, repo, pr.author.login)) === JSON.stringify(writers),
      "writer inventory changed during evaluation",
    );
    await readPR(api, repository, number, expectedSha);
  }
  return { ok: problems.length === 0, sha: expectedSha, threads: threads.length, problems, audit };
}

function createApi(token, fetcher = fetch) {
  requireData(nonempty(token), "missing GitHub token");
  async function request(path, body) {
    const response = await fetcher(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
    const payload = await response.json();
    requireData(payload && typeof payload === "object", "empty API response");
    return payload;
  }
  return {
    graphql: async (query, variables) => {
      const payload = await request("/graphql", { query, variables });
      requireData(!payload.errors && payload.data, "GraphQL error or missing data");
      return payload.data;
    },
    permission: async (owner, repo, user) => {
      const payload = await request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(user)}/permission`,
      );
      return payload.permission;
    },
    independentWriters: async (owner, repo, author) => {
      const writers = [];
      const seen = new Set();
      for (let page = 1; page <= 1000; page++) {
        const users = await request(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators?per_page=100&page=${page}`,
        );
        requireData(Array.isArray(users), "missing collaborators");
        for (const user of users) {
          requireData(
            nonempty(user.login) && !seen.has(user.login) && typeof user.permissions?.push === "boolean",
            "incomplete collaborator inventory",
          );
          seen.add(user.login);
          if (user.login.toLowerCase() !== author.toLowerCase() && user.type === "User" && user.permissions.push)
            writers.push(user.login);
        }
        if (users.length < 100) return writers.sort();
      }
      throw new Error("collaborator pagination limit reached");
    },
  };
}

async function main(env = process.env) {
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const pr = event.pull_request;
    requireData(pr && Number.isSafeInteger(pr.number), "workflow is missing pull_request");
    const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
    requireData(nonempty(owner) && nonempty(repo), "missing repository");
    const result = await evaluate(createApi(env.GITHUB_TOKEN), {
      owner,
      repo,
      number: pr.number,
      expectedSha: pr.head?.sha,
    });
    const summary = [
      `${CHECK_NAME}: ${result.ok ? "PASS" : "BLOCKED"}`,
      `Evaluated SHA: ${result.sha}`,
      `Review threads: ${result.threads}`,
      ...result.problems,
      ...result.audit,
    ].join("\n");
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    return result.ok ? 0 : 1;
  } catch (error) {
    // Never convert API errors, permission failures or missing data to an empty list.
    console.error(`${CHECK_NAME}: BLOCKED — ${error.message}`);
    return 1;
  }
}

module.exports = { CHECK_NAME, createApi, evaluate, main };
if (require.main === module)
  main().then((code) => {
    process.exitCode = code;
  });
