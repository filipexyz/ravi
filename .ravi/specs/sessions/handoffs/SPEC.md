---
id: sessions/handoffs
title: Session Handoffs
kind: capability
domain: sessions
capability: handoffs
tags:
  - sessions
  - threads
  - orchestration
applies_to:
  - src/handoffs/store.ts
  - src/handoffs/service.ts
  - src/handoffs/reconcile.ts
  - src/handoffs/events.ts
  - src/channels/slack/thread-lifecycle.ts
  - src/cli/commands/sessions.ts
  - src/router/router-db.ts
  - src/gateway.ts
  - src/daemon.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Session Handoffs

## Intent

A handoff is the stored fact "this child session (a thread) waits for its parent session to act". Before it, the wait lived only in the text of a report: a thread that ended its turn and waited was healthy for every turn-health check, so an orchestrating parent that stopped acting was noticed only when a human asked why everything was stopped.

## Rules

- A child declares a handoff with `ravi sessions report --awaiting <review|decision|merge|dispatch|instruction> [--ref <sha|pr>] "<message>"`. The report text carries the handoff id.
- The thread brief the runtime builds (`src/prompt-builder.ts`, Slack thread placement) and the thread-return nudge MUST tell the thread to end a waiting report with `--awaiting`; a wait the thread never declares is invisible to the reconciler.
- A child waits on one thing at a time: a new handoff from the same child MUST supersede its open one.
- The handoff MUST be written only after its report reached the parent: a report that fails to publish leaves the previous wait open and untouched. A blank waiting report is a usage error.
- A handoff MUST close only on an explicit reference to that child or that handoff: the parent sends the thread instructions (`thread-send`, which closes only `instruction` and `decision` waits), closes it (any close path: `close-thread`, the Slack close command, idle close; the acknowledgement lives in the shared close), or runs `ravi sessions handoff-ack <id>`. A `review`, `merge` or `dispatch` wait is an action the parent takes elsewhere: a message to the thread MUST NOT close it. Unrelated activity of the parent MUST NOT close it. A thread MUST NOT acknowledge its own handoff (`HANDOFF_SELF_ACK`).
- An open handoff nobody acted on for 7 days MUST close as expired (`ackReason: expired: no action for 7 days`). `ravi sessions handoffs --all` lists closed handoffs too (newest 100), with how each one ended.
- The reconciler (gateway tick, every 30 s) MUST remind the parent once when a handoff has waited 15 min, with one turn per parent per tick listing the due handoffs and those opened in the last 24 h, and MUST tell the owner once, in one aggregated message per parent, for handoffs that waited 45 min. The owner notice MUST say the parent was reminded only when it was.
- A delivery that was not made MUST NOT be recorded as made: a failed or refused reminder leaves the row as it was, to retry on the next tick. The owner notice is claimed before delivery (a slow delivery or a crash right after it never sends it twice) and the claim is released when the delivery did not happen. Ticks never overlap: a tick that finds the previous one still delivering does nothing.
- Review dispatch: `report --awaiting review --ref <full SHA> --pr <owner/repo#n>` opens the independent review itself when the PR is open, its head is that SHA and the quality gate check-run of that SHA (setting `handoffs.review.gateCheck`, default `Quality Gate`) concluded `success`. The reviewer runs on another model than the author (an Opus model on any runtime → Sonnet; anyone else → Opus; Claude runtime, effort high), its thread is opened from the author's session (also under `report --session`) and keyed by `review:<repo>#<pr>@<sha>` (repository lower-cased): a repeat with another note, another spelling or after a gate rerun returns the review already opened, read from the stored request, instead of rebuilding the brief. Opening it needs the caller's `create-thread` authority; without it the dispatch is skipped with the reason, and its brief pins the SHA, the gate read and how to answer (`--awaiting merge` or `--awaiting instruction`). The dispatch runs before the report is published, so the parent reads that it was dispatched, and the review wait is acknowledged with the reviewer's request as the reason. When a guard fails the report says why and the wait stays on the parent. It never fails the report. Setting `handoffs.review.autoDispatch=off` turns it off.
- A report delivered whose wait could not be written MUST NOT fail: it returns `handoffError`, so the caller does not send the report again.
- The core (`src/handoffs/`) MUST NOT name a channel. Channel adapters register the parent reminder (`registerHandoffDeliveryPorts`); the owner notice uses the owner's direct chat resolved from contacts.
- Events `ravi.handoff.pending`, `ravi.handoff.acknowledged` and `ravi.handoff.stale` carry `{type, handoffId, threadSession, parentSession, kind, sha?, since, ageMin, reason?}`. Observers consume them as a ready condition; they never infer a wait from report text. Publishing is best effort; the table is the source of truth.
- Follow-ups of the #942 review: with `--pr` (allowed with `--awaiting review|merge`) the wait stores `owner/repo#n@<sha>` and a `review` or `merge` wait on a PR closes when the GitHub watch publishes `ravi.watch.github.pull_request.merged|closed` for that PR (`ackReason: PR merged|PR closed`). The daemon never polls GitHub for it (it spawns no child processes) and learns only what a configured watch already reports. Review dispatch runs only for a PR the thread follows (the `gh-follow:<repo>#<n>` trigger `ravi pr publish` arms with the thread as reply session); `.`/`..` are not repository names. A stored review whose thread failed or closed is not replayed as dispatched: the wait stays on the parent. A runtime-default author model is unknown and never dispatches (another model cannot be guaranteed). The author's line enters the brief labelled as an unverified claim, capped at 280 characters. A dispatched review records its wait already closed (one `acknowledged` event, no `pending`). The dispatch result says whether the reviewer's root message is still pending (`publishPending`). The PR follow prompt tells a thread whose gate just passed to report again with `--pr`, so the dispatch happens once the gate closes. Delivery ports time out after 60 s; the handoff reconciler keeps its own try/catch inside the Slack reconciliation job. A skipped dispatch never echoes the PR state or head (`the PR is not open at this SHA`).
- Follow-ups of the #944 review: a wait declared with `--pr` reads the PR once (from the command, never from the daemon) and is recorded already closed (`PR merged`/`PR closed`) when the PR ended before the wait existed, since that event went to nobody; a failed read leaves the wait open. A delivery that times out is treated as possibly delivered: the owner notice keeps its claim and the parent reminder is claimed, so neither is sent twice (at most once). A failed or closed review tells the parent to open a new one by hand or publish a new SHA.
