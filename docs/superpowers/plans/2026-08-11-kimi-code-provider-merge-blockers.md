# Kimi Code Merge Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the four post-CI merge blockers from the native Kimi Code provider without weakening replay, privacy, or path-safety guarantees.

**Architecture:** The transport accepts a tool-call assistant message with omitted text rather than an invalid empty string. State uses a 1 MiB durable-history budget and a validated lifecycle cleanup boundary. Workspace identity treats platform device values as signed opaque identifiers. Existing generic provider behavior remains unchanged.

**Tech Stack:** Bun, TypeScript, Node fs, RAVI Runtime, Bun test.

## Global Constraints

- No Kimi network request or exposed credential.
- Tests are RED before production edits and GREEN after.
- Kimi request bodies remain capped at 2 MiB serialized UTF-8.
- Persisted Kimi native history is capped at 1 MiB; no lossy summarization.
- Cleanup is validated, idempotent, reparse-safe, and never deletes a live locator.
- Private live gates L-01 through L-04 remain pending.

---

### Task 1: Normalize tool-call assistant messages and durable budget

**Files:**
- Modify: `src/runtime/kimi-code-turn.ts`
- Modify: `src/runtime/kimi-code-transport.ts`
- Modify: `src/runtime/kimi-code-state.ts`
- Test: `src/runtime/kimi-code-transport.test.ts`
- Test: `src/runtime/kimi-code-provider.test.ts`
- Test: `src/runtime/kimi-code-state.test.ts`

**Interfaces:**
- Produces: assistant native messages where `content` is omitted only for non-empty `tool_calls` with empty public text.
- Produces: state publication rejection at 1 MiB before any locator update.

- [ ] **Step 1: Write RED tests.**
  - Assert a continuation assistant tool-call with empty text has no `content` key in the serialized request.
  - Assert a non-tool empty assistant message is rejected.
  - Assert a snapshot larger than 1 MiB rejects before publish and preserves the previous locator.
  - Assert a previously accepted 1–2 MiB snapshot cannot exist.

- [ ] **Step 2: Run focused tests and confirm RED.**

  Run: `rtk bun test src/runtime/kimi-code-transport.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/kimi-code-state.test.ts`

  Expected: new tests fail for empty content and 4 MiB acceptance.

- [ ] **Step 3: Implement minimal boundary fixes.**
  - Widen only the tool-call assistant native type to optional `content`.
  - Strip empty content only under the exact tool-call condition when constructing a request.
  - Replace the durable 4 MiB state cap with the named 1 MiB history cap.

- [ ] **Step 4: Run focused GREEN and typecheck.**

- [ ] **Step 5: Commit.**

### Task 2: Retain only live Kimi state and clean on lifecycle deletion

**Files:**
- Modify: `src/runtime/kimi-code-state.ts`
- Modify: lifecycle owner(s) found by tracing `deleteSession`, reset, and idle-expiry paths
- Test: `src/runtime/kimi-code-state.test.ts`
- Test: corresponding lifecycle test files

**Interfaces:**
- Produces: `cleanupKimiCodeSessionState(session, env?)` that validates the locator/root and removes only its UUID directory.
- Produces: post-publication revision pruning that retains the returned locator.

- [ ] **Step 1: Trace generic reset, delete, and expiry callers to their provider-state boundary.**
- [ ] **Step 2: Add RED tests for revision pruning, invalid locator no-op/fail-closed, reset/delete/expiry cleanup, and idempotence.**
- [ ] **Step 3: Implement validated cleanup and lifecycle wiring.**
- [ ] **Step 4: Run lifecycle/state GREEN and typecheck.**
- [ ] **Step 5: Commit.**

### Task 3: Accept signed Darwin device identities

**Files:**
- Modify: `src/runtime/kimi-code-state.ts`
- Test: `src/runtime/kimi-code-state.test.ts`

**Interfaces:**
- Produces: workspace identity parser accepting an optional leading minus on device only.

- [ ] **Step 1: Add RED fixtures for negative device identity acceptance and persistence/resume equality.**
- [ ] **Step 2: Implement signed opaque device validation; retain positive inode validation.**
- [ ] **Step 3: Run state GREEN plus typecheck.**
- [ ] **Step 4: Commit.**

### Task 4: Integrate, review, and update PR

**Files:**
- Update: `.ravi/specs/runtime/providers/kimi-code/CHECKS.md` only after fresh evidence.

- [ ] **Step 1: Run the focused Kimi/runtime/lifecycle tests sequentially.**
- [ ] **Step 2: Run typecheck, build, spec gate, quality gate, diff check, and sanitization.**
- [ ] **Step 3: Dispatch adversarial review of all fixes; resolve Critical/Important findings with a scoped re-review.**
- [ ] **Step 4: Push the branch and monitor PR #406 CI.**
- [ ] **Step 5: Keep L-01–L-04 explicitly pending until a new private credential is used.**
