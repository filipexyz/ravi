import { describe, expect, test } from "bun:test";

import { CliApiError } from "@/server/cli/errors";

import { buildConsoleWatchKey, normalizeGithubEventTypes } from "./watches";

describe("console watches", () => {
  test("normalizes github watch event types deterministically", () => {
    expect(
      normalizeGithubEventTypes([
        "pull_request.merged",
        "push.branch",
        "watch.github.push.branch",
      ]),
    ).toEqual(["watch.github.pull_request.merged", "watch.github.push.branch"]);
  });

  test("rejects unsupported github watch event types with public error", () => {
    expect(() => normalizeGithubEventTypes(["watch.github.push"]))
      .toThrow(CliApiError);
    expect(() => normalizeGithubEventTypes(["watch.github.repository.secret_scanned"]))
      .toThrow(CliApiError);

    try {
      normalizeGithubEventTypes(["watch.github.repository.secret_scanned"]);
    } catch (error) {
      expect(error).toBeInstanceOf(CliApiError);
      expect((error as CliApiError).code).toBe("WATCH_UNSUPPORTED_EVENT");
    }
  });

  test("builds stable watch key regardless of json key order", () => {
    const left = buildConsoleWatchKey({
      delivery: { type: "inbox", subscriptionId: "sub_1", localInstallationId: "ins_1" },
      eventTypes: ["watch.github.push.branch", "watch.github.pull_request.merged"],
      filters: { branch: "main", paths: ["src/**"], actor: { login: "octocat", type: "user" } },
      placement: "console",
      projectId: "proj_1",
      provider: "github",
      providerConnectionId: "conn_1",
      providerInstallationId: "123",
      providerResourceId: "456",
      resourceRef: "Owner/Repo",
    });
    const right = buildConsoleWatchKey({
      delivery: { localInstallationId: "ins_1", subscriptionId: "sub_1", type: "inbox" },
      eventTypes: ["watch.github.pull_request.merged", "watch.github.push.branch"],
      filters: { actor: { type: "user", login: "octocat" }, paths: ["src/**"], branch: "main" },
      placement: "console",
      projectId: "proj_1",
      provider: "github",
      providerConnectionId: "conn_1",
      providerInstallationId: "123",
      providerResourceId: "456",
      resourceRef: "owner/repo",
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^watch:github:[a-f0-9]{40}$/);
  });
});
