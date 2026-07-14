---
id: learning-loop/skill-curation
title: "Skill Curation Learning Loop"
kind: capability
domain: learning-loop
capabilities:
  - skill-curation
tags:
  - learning-loop
  - skills
  - curation
  - hermes
applies_to:
  - runtime
  - skills
  - memory
owners:
  - ravi-dev
status: active
normative: true
---

# Skill Curation Learning Loop

**See:** `/home/ravi/vault-ravi/knowledge/hermes-learning-loop/DA-hermes-learning-loop-core.md` (extracted Hermes core). The MEMORY and SKILL dispatchers share the durable terminal cadence in `src/runtime/learning-loop-cadence.ts` while keeping independent watermarks and curator profiles.

## Intent

Give every Ravi agent a compounding learning loop, adapted from NousResearch Hermes: after every turn the agent reviews the conversation and persists what it learned — not just facts about the user (memory, done) but **how to do this class of task for this user** (skills). A slow background curator keeps the skill library from bloating. The whole thing must run autonomously, in-process-driven, without the failure modes that already cost this codebase a full session (see Known Failure Modes).

Two nested loops:

- **FAST (terminal-turn nudge).** Hermes forks the agent in-process every N turns and asks "should any skill/memory be saved or updated?". Ravi persists the cadence phase per session and, at the interval, dispatches a fresh isolated curator task that reads only the post-watermark delta and writes via `ravi skills` / `ravi memory`.
- **SLOW (maintenance curator).** An inactivity-triggered job that runs deterministic lifecycle transitions on the skill library (active → stale → archive), never deletes, and optionally (opt-in, default OFF) consolidates overlapping skills into class-level umbrellas.

## Invariants

**Counter & trigger (from the memory half — non-negotiable, learned the hard way):**
- I1. The cadence transition MUST execute in the host process and persist under the dedicated `learningLoopCadence` namespace in `runtime_session_json`. Every full-column provider write MUST carry that namespace forward after a fresh DB read; a blind replace is the forbidden lost-update.
- I2. The runtime MUST dispatch the curador DIRECTLY in-process at the interval. It MUST NOT depend on a cross-process NATS `Stop` hook for cadence — that hook did not fire reliably for omni conversation turns.
- I3. Skill review fires on a terminal-turn cadence (default 10), not a contextual "looks important" heuristic. Exactly one of `turn.complete`, `turn.interrupted`, or `turn.failed` ticks each real turn. Curator and report sessions are excluded before the tick.

**The review fork (fast loop):**
- I4. The review runs in an ISOLATED execution (a curador task / ephemeral session), NOT the live user session. It MUST NOT write to — nor otherwise mutate, DIRECTLY OR INDIRECTLY — the parent session's message log or runtime state (params, watermark-except-via-completion, tokens). The review persists ONLY through its restricted tools (I5). Otherwise the parent re-reads the harness prompt next turn and turns into a curator (the "curator-takeover" bug).
- I5. The review's tool surface MUST be restricted (via REBAC) to the persistence tools only — `ravi skills` + `ravi memory` (+ `ravi specs` where relevant). No terminal/network — a review thread must not expand blast radius.
- I6. The review prompt MUST carry the Hermes signal taxonomy, write-order, and guardrails VERBATIM (paraphrase drops the value). Posture is ACTIVE: "most sessions produce at least one skill update; a pass that does nothing is a missed learning opportunity, not a neutral outcome."
- I7. Write action-order MUST be, earliest-that-fits: (1) patch a skill that was in play this session → (2) patch an existing class-level umbrella → (3) add a support file (`references/` | `templates/` | `scripts/`) under an umbrella → (4) create a new class-level umbrella (last resort). Without the hierarchy the loop degenerates into one-skill-per-session.
- I8. User style/format/workflow preferences MUST be embedded in the SKILL.md body ("how to do this class of task for this user"), not only in memory ("who the user is"). Frustration ("stop doing X", "too verbose", "just give me the answer") is a FIRST-CLASS skill signal, not just a memory signal.
- I9. **Negative-capture guardrail (mandatory).** The loop MUST NOT capture environment-dependent failures (missing binaries, fresh-install errors, unconfigured credentials) or negative tool claims ("X is broken", "Y never works"). These harden into refusals the agent cites against itself for months after the real problem was fixed. When a genuine fix emerged, capture the FIX (install command, config step, env var) under a setup/troubleshooting skill — positive form, never the negative claim. (This is the same lesson ravi-dev learned the same day: E.38 / feedback-prove-code-is-running.)
- I10. Protected skills (bundled / hub-installed) MUST NOT be edited by the loop. Pinned skills MAY be patched but MUST NOT be archived/deleted/consolidated.
- I11. Every write carries provenance metadata (`write_origin=background_review` / curador task id) so foreground vs background writes are auditable.

**The maintenance curator (slow loop):**
- I12. Lifecycle transitions (active → stale ~30d → archive ~90d) MUST be a PURE function (no LLM) driven by derived activity timestamps. Zero token cost.
- I13. The curator MUST be inactivity-gated (idle-triggered, long interval e.g. 7d + a min-idle window) so it never competes with the user for attention.
- I14. The curator MUST NEVER delete — only archive (recoverable). Consolidation into umbrellas is opt-in, default OFF (it is an expensive, lossy editorial decision).

**Runtime dispatch & durability (blocker-grade — from spec review):**
- I15. **Reentrancy guard (mandatory).** The nudge MUST NOT tick or dispatch for the review/curador's OWN sessions — any session whose name ends `-curator` or that runs a curador task. A review turn scheduling another review is an infinite loop. (The memory nudge guards `sessionName.endsWith("-curator")`.)
- I16. **Cadence phase ≠ durable watermark.** The persisted phase only decides WHEN to inspect. Memory and skill watermarks independently decide WHAT delta each curator reads and advance only when that curator task completes. On first state creation, a missing watermark is seeded at the current message cursor so rollout never replays the full historical transcript.
- I17. Explicit provider quota MUST NOT complete a curator turn successfully. A task-bound `quota_exhausted` failure blocks the task and clears its checkpoint deadline; an active/blocked curator prevents duplicate dispatch for the same origin session.
- I17. **Deploy target (mandatory, not advisory).** Runtime changes deploy to the daemon's real path — the NPM global (`pm_exec_path`), NOT the bun global (`bun add -g` only updates the CLI). Every change MUST be `npm install -g <tgz>` and verified present in the running bundle before any live validation (E.38). Validating against the wrong bundle already cost a full day.

## Ravi Adaptation & Open Problems

- **Fork = curador task / ephemeral session** reusing the parent runtime (same model + credential), fed a conversation-delta snapshot. Same mechanism the memory half already uses. Measure spawn cost on high-traffic sessions before committing to per-10-turn dispatch.
- **Library = `ravi skills`** (list/show/install/lint). Skills already have the SKILL.md + `references/`/`templates/`/`scripts/` umbrella shape.
- **OPEN PROBLEM (medium) — `skills_in_play` detection.** Hermes detects loaded skills from `/skill-name` + `skill_view` in the history. In Ravi, skills load via the `Skill` tool + automatic skill-gates, so the in-play set is DERIVED from the tool-call sequence, not narrated. See S3 for the required sub-spec.
- Deploy reality is now the invariant **I17** (was a note; the review flagged it must be normative).

## Scope — COMPLETE (not an MVP subset)

The target is the FULL learning loop, both loops and all durable components. Sequencing below is build ORDER, not a gate — everything ships.

**Fast loop (per-turn review):**
- S1. Skill nudge — merge-safe durable per-session phase → direct skill-curator dispatch at the interval. Env `RAVI_SKILL_NUDGE_INTERVAL` (default 10).
- S2. Combined review — when memory + skill nudges land the same turn, one dispatch with the concatenated verbatim prompt (never two forks).
- S3. `skills_in_play` manifest (sub-spec — the medium-hard piece):
  - **Compute:** during the session window covered by the review delta, the runtime collects every skill id (a) invoked via the `Skill` tool and (b) auto-loaded by a skill-gate firing on a tool call. Source of truth = the runtime's own tool-call stream (not the message text), recorded per session.
  - **Format:** an ordered list of skill ids, most-recently-in-play first, deduped, e.g. `["ravi-dev:cli-creator", "validating-coherence"]`.
  - **Inject:** appended to the review snapshot as an explicit block (`Skills in play this session: [...]`) that the write-order prompt references for step (1). It supplements — never replaces — whatever the model can infer from the transcript.
  - **Fallback:** if the manifest is empty, write-order step (1) is skipped and the loop starts at (2); the review MUST NOT fabricate an in-play skill to satisfy (1).
  - **Scope note:** the manifest is READ-ONLY input to the review; computing it MUST NOT mutate session state (I4).
- S4. Review curador profile — verbatim Hermes signals + write-order 1→4 + guardrails; tool surface restricted via REBAC to `ravi skills` + `ravi memory` (+ `ravi specs`); isolated session (I4).
- S5. Provenance on every write (`write_origin=background_review`, curador task id).

**Slow loop (maintenance curator):**
- S6. `apply_automatic_transitions` — pure-function lifecycle (active → stale ~30d → archive ~90d), inactivity-triggered job (~7d + min-idle), never delete.
- S7. Consolidation into class-level umbrellas — opt-in per profile (default OFF), `absorbed_into` on any demote, package-integrity check before merge, dry-run mode before first prod run.
- S8. Reconciliation of curator results (declaration > YAML > heuristic) + structured report.

**Recall & user model (Ravi-native, replacing Hermes's external pieces):**
- S9. FTS5 cross-session recall over the SQLite `messages` table (Ravi already runs SQLite) — a `session_search` surface the review + the agent can query beyond in-context.
- S10. User modeling the Ravi way — reuse `ravi crm` (relationship/preferences) + `ravi specs`/memory for durable user model, instead of importing Honcho's peers/dialectic API. The learning loop writes preferences into memory + the relevant SKILL.md; the user model is read from crm+memory.

**Pilot before fleet-wide** on one profile (e.g. `main` or `researcher`), measuring reviews/session, `Nothing to save.` vs update ratio, latency, token cost, RM-rejected false positives — then roll out. Piloting is a rollout gate, not a scope cut: the complete loop is built first.

**Deferred (real but not in this loop's scope):** the user-facing "action summary" (Hermes surfaces to the user what the review changed) is DEFERRED — Ravi's observability comes from the completion report the trigger posts to the memory-log group + provenance (I11); a per-turn user-facing summary is a later UX addition, not part of the core learning loop.

**Explicitly out (true Hermes-specific optimizations, not needed):** aux-model routing / digest-replay (start same-model), cron skill-ref rewrites (only if Ravi cron references skills), `prune_builtins`. Prompt-cache parity is a cost optimization to pursue after correctness.

## Validation

- `ravi specs get learning-loop/skill-curation --mode full --json`; `ravi specs sync --json`.
- Unit: the cadence advances across terminal types, fires on 9→10, survives rehydration, reconstructs from `session_turns`, preserves co-resident runtime params and skips curator/report sessions.
- Provider/task: a Claude zero-usage weekly-limit envelope becomes `turn.failed`; a task-bound quota failure persists `status=blocked` and removes checkpoint cadence.
- Integration: a curador dispatched at the interval writes to `ravi skills`, NOT to the parent session log (I4).
- E2E live (per E.38 — prove across ≥2-3 real iterations + full chain, never a 0→1 unit test): drive real turns → skill-nudge fires at interval → skill-curador runs → a real SKILL.md patch/create lands → report. Verify the fix is in the bundle at the daemon's `pm_exec_path` first.
- Guardrail check: a session containing an environment failure or "X is broken" claim MUST produce no skill capturing the negative claim (I9).

## Known Failure Modes

- **Lost-update / clobber (already hit):** blind provider-param replace drops cadence/watermarks. Fixed by the dedicated namespace + merge-after-refresh contract in I1.
- **Restart reset / replay:** ephemeral phase resets or zero watermark re-reads history. Fixed by `session_turns` phase reconstruction and cold-start cursor seeding (I16).
- **Quota-success loop:** provider emits explicit limit text followed by nominal success, leaving tasks active forever. Fixed by I17.
- **Cross-process hook unreliable (already hit):** NATS Stop-hook cadence never fired for omni turns. Fixed by I2 (runtime dispatches directly).
- **Wrong deploy target (already hit — cost a full session):** deployed to bun global while the daemon runs from npm global. Fixed by the deploy-reality note.
- **Curator-takeover:** the review fork writing into the parent session → agent becomes a curator. Prevented by I4.
- **Preference-order (1) failure:** without a reliable `skills_in_play` manifest the loop always skips to (2)/(3), losing the patch to the skill that was in play.
- **Guardrail hardening:** ambiguous "frustrated with a broken tool" signal captured as a negative claim → agent self-refuses for months. Prevented by I9 (capture the fix, not the failure).
