/**
 * Test files that no CI job runs, each with the reason.
 *
 * `src/ci/test-discovery.test.ts` fails the gate for every `*.test.ts` file that CI does not run and that is not
 * listed here. Adding a line is a decision, not a way to make the gate quiet: write why the file is not run in CI,
 * and for a file that fails today, link the issue that tracks the fix. The same test fails when an entry is stale
 * (the file is gone or CI runs it now), so this list only shrinks over time.
 */

export type TestExclusion = {
  /** Why CI does not run the file. At least a sentence, naming the issue for a file that fails today. */
  reason: string;
  /** The package.json script that runs the file outside CI. The gate checks the script really selects it. */
  runBy?: string;
};

export const TEST_EXCLUSIONS: Readonly<Record<string, TestExclusion>> = {
  "src/bot.live.test.ts": {
    reason: "Live provider test: it calls real model APIs with real credentials, which CI never has.",
    runBy: "test:live",
  },
  "src/runtime/claude-provider.live.test.ts": {
    reason: "Live provider test: it calls the real Claude API with real credentials, which CI never has.",
    runBy: "test:live",
  },
  "src/runtime/codex-provider.live.test.ts": {
    reason: "Live provider test: it calls the real Codex API with real credentials, which CI never has.",
    runBy: "test:live",
  },
  "src/ci/review-gate.test.ts": {
    reason:
      "Retired Review Gate: its workflow was deleted from dev, and quality/ci-gates/review-merge keeps the script and " +
      "this test as inert material. One test reads the deleted workflow file and fails, so running it would only " +
      "break CI. Delete it together with src/ci/review-gate.cjs if the gate is never coming back.",
  },
};
