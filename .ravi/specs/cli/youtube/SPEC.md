---
id: cli/youtube
title: "YouTube agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - youtube
tags:
  - cli
  - youtube
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/youtube.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# YouTube agent-first CLI contract

## Intent

Make `ravi yt` reliable for agent consumers under the agent-first contract
defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit taxonomy, a
write brake on every provider mutation, and compact discovery. Every `yt`
write hits the EXTERNAL Google/YouTube API — comment replies and metadata
changes are publicly visible, deletes are irreversible — so all seven
mutations are braked.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `yt video <unknown-id>` MUST exit 1 with `VIDEO_NOT_FOUND`. There is no
   cheap local video cache (listing is an external Data API call), so the
   envelope carries `suggestedAction` pointing at `yt videos`/`yt search`
   instead of `suggestions`.
4. All seven mutations (`reply`, `video-update`, `video-delete`,
   `playlist-create`, `playlist-delete`, `playlist-add`, `playlist-remove`)
   MUST default to dry-run and require `--execute`; the dry-run MUST report
   `dryRun: true` and the `plan`, and MUST NOT reach the provider client.
5. `--execute` MUST be the LAST declared option of every braked op.
6. Listings (`videos`, `search`, `comments`, `unanswered`, `playlists`,
   `playlist`, `subscriptions`) MUST accept `--fields a,b,c` for compact
   output.
7. A thrown `ContractError` MUST NOT be swallowed by the `yt` provider-error
   funnel (`execute` wrapper rethrows it) so the registry dispatcher preserves
   the exit taxonomy.
8. Analytics ops stay read-only; no monetary scope is ever declared.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| reply | public external write (comment on YouTube) | dry-run + `--execute` |
| video-update | public external metadata write | dry-run + `--execute` |
| video-delete | irreversible external delete | dry-run + `--execute` |
| playlist-create | external non-idempotent write (blind retries duplicate; may be public) | dry-run + `--execute` (by principle, documented) |
| playlist-add | external non-idempotent curation write (by principle, documented) | dry-run + `--execute` |
| playlist-delete | irreversible external delete | dry-run + `--execute` |
| playlist-remove | destructive curation change | dry-run + `--execute` |
| all reads / analytics | read-only | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| video not found | `VIDEO_NOT_FOUND` + suggestedAction (no cheap local source) | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| provider/credential error | legacy text + `ravi yt health` hint | 1 |

## Internal consumers

No shipped skill teaches the `yt` surface — **skill gap registered**: when a
`youtube` skill is created it MUST document `--execute` on all seven braked
ops and the `VIDEO_NOT_FOUND` envelope. The per-op `helpAfter` (mutationHelp)
already teaches the brake inline (`REGRAS HARD` block) and every mutation
example carries `--execute`.

## Validation

- `bun test src/cli/commands/youtube.test.ts` green (contract block included).
- Live checks (fake/injected client or a scratch channel): `yt video nope
  --json` → `VIDEO_NOT_FOUND`, exit 1; `yt reply <id> "x" --json` → exit 3 and
  no reply published; with `--execute` → published; `yt videos --fields
  videoId,title --json` narrows items.

## Known Failure Modes

- The `yt` `execute` wrapper funnels every throw into
  `fail(youtubeError(...))`; without the explicit `ContractError` rethrow the
  envelope collapses into a generic exit-1 provider message.
- Option metadata order is by decorator `index`, not array order — asserting
  "last option" requires sorting by `index` first (decorators register in
  reverse).
