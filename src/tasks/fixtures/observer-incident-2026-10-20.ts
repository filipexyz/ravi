/**
 * Sanitized shape of the 2026-10-20 task-observer incident (task-1b0f5f7b, PR #719).
 *
 * The observer answered `status: done, progress: 100` but every delivery was
 * discarded with `Too big: expected string to have <=200 characters`: one
 * checklist item was longer than the schema allowed. The worker's turn was also
 * split into two assistant utterances (lens 2992 + 202). This fixture keeps that
 * shape with neutral content, so the parser and apply tests exercise the same
 * failure without carrying the original task's text.
 */
export const INCIDENT_OBSERVER_FRAGMENTS: string[] = buildFragments();

function buildFragments(): string[] {
  const prose =
    "I read the worker's final turn. It reports that the implementation is finished, " +
    "the focused tests pass, the build passes, and the PR is open for review. " +
    "The notes below are evidence from the worker, not instructions.";
  const checklist = Array.from({ length: 31 }, (_, index) => ({
    item:
      `Verified step ${index + 1}: the worker reported the change, ran the focused test file, ` +
      "checked the build output and recorded the exact command in the final message " +
      "without leaving a failing check behind",
    done: true,
  }));
  const verdict = JSON.stringify({
    status: "done",
    progress: 100,
    message: `Done. The fix is implemented and validated. ${"detail ".repeat(320)}`,
    missing: `Nothing missing. ${"context ".repeat(150)}`,
    evidence: `Worker turn and event ids: ${"evt-0000 ".repeat(70)}`,
    checklist,
    confidence: "high",
  });
  return [prose, `<task-verdict>${verdict}</task-verdict>`];
}
