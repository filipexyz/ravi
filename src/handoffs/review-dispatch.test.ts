import { describe, expect, it } from "bun:test";
import {
  buildReviewerBrief,
  decideReviewDispatch,
  isFullSha,
  parsePullRequestRef,
  pickReviewerRuntime,
  readReviewEvidence,
  reviewAutoDispatchEnabled,
  reviewThreadKey,
  type ReviewEvidence,
  type ReviewTarget,
} from "./review-dispatch.js";

const SHA = "135fbbc78acc79545ca641d4ae21819c56d498e1";
const TARGET: ReviewTarget = { repo: "filipexyz/ravi", pr: 938, sha: SHA };
const GREEN: ReviewEvidence = {
  prState: "open",
  headSha: SHA,
  gate: { name: "Quality Gate", checkRunId: 138095411611, conclusion: "success", completedAt: "2026-11-23T23:33:30Z" },
};

describe("review dispatch", () => {
  it("parses owner/repo#number and full SHAs only", () => {
    expect(parsePullRequestRef("filipexyz/ravi#938")).toEqual({ repo: "filipexyz/ravi", pr: 938 });
    // One spelling per repository, so one PR head has one review key.
    expect(parsePullRequestRef("FilipeXYZ/Ravi#938")).toEqual({ repo: "filipexyz/ravi", pr: 938 });
    expect(parsePullRequestRef("#938")).toBeNull();
    expect(parsePullRequestRef("filipexyz/ravi#0")).toBeNull();
    expect(parsePullRequestRef("ravi#938")).toBeNull();
    expect(isFullSha(SHA)).toBe(true);
    expect(isFullSha(SHA.slice(0, 8))).toBe(false);
  });

  it("dispatches only an open PR whose head is the SHA with the gate green", () => {
    expect(decideReviewDispatch(TARGET, GREEN)).toEqual({ dispatch: true });
    expect(decideReviewDispatch(TARGET, { ...GREEN, prState: "closed" })).toMatchObject({ dispatch: false });
    expect(decideReviewDispatch(TARGET, { ...GREEN, headSha: "a".repeat(40) })).toMatchObject({
      dispatch: false,
      reason: expect.stringContaining("PR head is aaaaaaaa"),
    });
    expect(decideReviewDispatch(TARGET, { ...GREEN, gate: null })).toMatchObject({ dispatch: false });
    expect(decideReviewDispatch(TARGET, { ...GREEN, gate: { ...GREEN.gate!, conclusion: null } })).toEqual({
      dispatch: false,
      reason: "quality gate still running",
    });
    expect(decideReviewDispatch(TARGET, { ...GREEN, gate: { ...GREEN.gate!, conclusion: "failure" } })).toEqual({
      dispatch: false,
      reason: "quality gate concluded failure",
    });
  });

  it("reads the newest gate run of the SHA and the PR head", async () => {
    const calls: string[] = [];
    const evidence = await readReviewEvidence(
      TARGET,
      async (endpoint) => {
        calls.push(endpoint);
        if (endpoint.endsWith("/pulls/938")) return { state: "open", head: { sha: SHA } };
        return {
          check_runs: [
            {
              id: 1,
              name: "Quality Gate",
              head_sha: SHA,
              status: "completed",
              conclusion: "failure",
              completed_at: "t1",
            },
            { id: 2, name: "Quality Gate", head_sha: SHA, status: "in_progress", conclusion: null, completed_at: null },
            { id: 9, name: "Other", head_sha: SHA, status: "completed", conclusion: "success", completed_at: "t9" },
          ],
        };
      },
      "Quality Gate",
    );
    expect(calls[1]).toContain(`commits/${SHA}/check-runs?check_name=Quality%20Gate`);
    // A rerun in progress is the current gate: the older failure does not count.
    expect(evidence.gate).toEqual({ name: "Quality Gate", checkRunId: 2, conclusion: null, completedAt: null });
  });

  it("never gives the review to the author's model", () => {
    expect(pickReviewerRuntime({ provider: "claude", model: "opus" }).model).toBe("sonnet");
    expect(pickReviewerRuntime({ provider: "claude", model: "claude-opus-5-5" }).model).toBe("sonnet");
    expect(pickReviewerRuntime({ provider: "claude", model: "sonnet" }).model).toBe("opus");
    // Opus through another runtime is still Opus.
    expect(pickReviewerRuntime({ provider: "pi", model: "anthropic/claude-opus-4-6" }).model).toBe("sonnet");
    expect(pickReviewerRuntime({ provider: "codex", model: "gpt-6-astra" })).toEqual({
      provider: "claude",
      model: "opus",
      effort: "high",
    });
  });

  it("is on unless the setting turns it off", () => {
    expect(reviewAutoDispatchEnabled(() => null)).toBe(true);
    expect(reviewAutoDispatchEnabled(() => "off")).toBe(false);
    expect(reviewAutoDispatchEnabled(() => "false")).toBe(false);
  });

  it("writes a brief that pins the SHA, the gate read and how to answer", () => {
    const brief = buildReviewerBrief({
      target: TARGET,
      gate: GREEN.gate!,
      authorSessionName: "main-t-1",
      authorModel: "opus",
      note: "PR 2 pronta",
    });
    expect(brief).toContain(`SHA a revisar: ${SHA}`);
    expect(brief).toContain("check-run 138095411611, success, 2026-11-23T23:33:30Z");
    expect(brief).toContain(`--awaiting merge --ref ${SHA}`);
    expect(brief).toContain("Não edite a PR nem comente nela");
    expect(reviewThreadKey(TARGET)).toBe(`review:filipexyz/ravi#938@${SHA}`);
  });
});
