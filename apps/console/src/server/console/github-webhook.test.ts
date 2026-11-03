import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  normalizeGithubWebhookEvent,
  verifyGithubWebhookSignature,
} from "./github-webhook";
import { githubInstallationSnapshotFromEnvelope } from "./github-app";

describe("github webhook", () => {
  test("verifies GitHub sha256 webhook signatures", () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const secret = "test-github-webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGithubWebhookSignature({ body, secret, signature })).toBe(true);
    expect(verifyGithubWebhookSignature({ body, secret, signature: signature.replace(/.$/, "0") })).toBe(false);
    expect(verifyGithubWebhookSignature({ body, secret, signature: null })).toBe(false);
  });

  test("maps merged pull request webhook to derived merged watch event", () => {
    const event = normalizeGithubWebhookEvent("pull_request", {
      action: "closed",
      number: 42,
      pull_request: {
        base: { ref: "main" },
        head: { ref: "feature", sha: "abc123" },
        html_url: "https://github.com/acme/repo/pull/42",
        merged: true,
        number: 42,
        state: "closed",
        title: "Ship it",
        updated_at: "2026-05-21T12:00:00.000Z",
        user: { login: "octocat" },
      },
      repository: { full_name: "acme/repo" },
    });

    expect(event?.eventType).toBe("watch.github.pull_request.merged");
    expect(event?.payload).toMatchObject({
      action: "closed",
      authorLogin: "octocat",
      baseRef: "main",
      headRef: "feature",
      headSha: "abc123",
      merged: true,
      number: 42,
      repositoryFullName: "acme/repo",
    });
  });

  test("maps GitHub push webhook to fine-grained Ravi push events", () => {
    const basePayload = {
      after: "abc123",
      before: "def456",
      commits: [{ id: "abc123" }],
      head_commit: {
        timestamp: "2026-05-21T12:00:00.000Z",
        url: "https://github.com/acme/repo/commit/abc123",
      },
      repository: {
        default_branch: "main",
        full_name: "acme/repo",
      },
    };

    expect(normalizeGithubWebhookEvent("push", { ...basePayload, ref: "refs/heads/main" })?.eventType)
      .toBe("watch.github.push.default_branch");
    expect(normalizeGithubWebhookEvent("push", { ...basePayload, ref: "refs/heads/feature" })?.eventType)
      .toBe("watch.github.push.branch");
    expect(normalizeGithubWebhookEvent("push", { ...basePayload, ref: "refs/tags/v1.0.0" })?.eventType)
      .toBe("watch.github.push.tag");
  });

  test("ignores unsupported pull request actions", () => {
    expect(
      normalizeGithubWebhookEvent("pull_request", {
        action: "synchronize",
        pull_request: { number: 42 },
        repository: { full_name: "acme/repo" },
      }),
    ).toBeNull();
  });

  test("reads safe GitHub installation metadata from webhook envelope", () => {
    const snapshot = githubInstallationSnapshotFromEnvelope("123", {
      account: {
        id: "99",
        login: "acme",
        type: "Organization",
      },
      installation: {
        htmlUrl: "https://github.com/organizations/acme/settings/installations/123",
        repositorySelection: "selected",
      },
      repositories: [
        {
          defaultBranch: "main",
          fullName: "acme/ravi",
          id: "456",
          name: "ravi",
          visibility: "private",
        },
      ],
    });

    expect(snapshot).toMatchObject({
      accountId: "99",
      accountLogin: "acme",
      accountType: "Organization",
      githubUrl: "https://github.com/organizations/acme/settings/installations/123",
      installationId: "123",
      repositorySelection: "selected",
    });
    expect(snapshot?.repositories).toEqual([
      {
        defaultBranch: "main",
        fullName: "acme/ravi",
        id: "456",
        name: "ravi",
        selected: true,
        visibility: "private",
      },
    ]);
  });
});
