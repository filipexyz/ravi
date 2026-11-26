---
id: cli/context
title: "Context agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - context
tags:
  - cli
  - context
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - secret-hygiene
applies_to:
  - src/cli/commands/context.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-dev/skills/context-cli/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Context agent-first CLI contract

## Intent

Make `ravi context` and `ravi context credentials` reliable for agent consumers
under the agent-first contract defined by `cli`: typed error envelopes, the
0/1/2/3 exit taxonomy, proportional confirmation, and compact
discovery. This domain is auth substrate: `revoke` kills live runtime auth
(cascading to child contexts by default) and therefore runs immediately as
containment; `credentials remove` drops a working local credential and remains
braked. The domain also carries a security
invariant stronger than most: context keys (`rctx_*`) ARE credentials.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `context info`, `context lineage` and `context revoke` on an unknown id MUST
   exit 1 with `CONTEXT_NOT_FOUND` and up to 3 `suggestions` built from context
   IDs only.
4. `context credentials remove` and `context credentials set-default` on an
   unknown entry MUST exit 1 with `CREDENTIAL_NOT_FOUND`; suggestions carry
   context IDs and labels only.
5. `context revoke` MUST execute immediately because it reduces authority.
   `context credentials remove` MUST default to dry-run and require
   `--execute`; the dry-run MUST report `dryRun: true` and the `plan`, and MUST
   NOT delete anything. Credential removal uses
   `{credentialsPathPresent,contextKeyPresent,contextId,agentId,labelPresent,kind,wasDefault}`.
   The plan carries no path, key, or label text.
6. Secret hygiene: a full `rctx_*` context key MUST NEVER appear in an error
   envelope, dry-run plan, or suggestion list. A credential-removal plan uses
   only `contextKeyPresent`; not-found envelopes may echo the user's queried
   key only as a masked prefix (first 8 characters + `...`).
7. `context list` and `context credentials list` MUST accept `--fields a,b,c`
   for compact JSON output; human output stays complete.
8. `context prune` keeps its pre-existing, STRONGER equivalent brake
   (`--apply` + `--confirm prune-contexts`); the flags MUST NOT be renamed to
   `--execute`.
9. `context cleanup-agent-runtime` keeps its pre-existing local equivalent
   (dry-run by default, opt-in `--revoke`); the flag MUST NOT be renamed.
10. Without `--json`, error output keeps the legacy text path (exit 1).
11. `codex-bash-hook` and its `codex-tool-hook` alias preserve the Codex
    PreToolUse JSON contract. The process CLI reads stdin and forwards it as
    the `payload` string when using the host or explicit remote gateway.
    The gateway MUST evaluate that payload with the authenticated runtime
    context and MUST NOT read daemon stdin. The transported field MUST be
    redacted from command audit.
12. Missing/malformed hook input, denied or invalid credentials, unavailable
    gateways, and invalid gateway replies MUST produce a PreToolUse `deny`.
    Valid inputs still pass through Bash permission checks and skill gates.
13. Hook denials MUST retain the source reason, operation, HTTP status and
    capability when available. Transport exceptions MUST preserve their cause.
    Redact only secret values with `[redacted]`; do not replace a known denial
    with a list of hypothetical causes. The hook remains fail closed.
14. For a verified installed operator using canonical state, `context
    credentials list/add/set-default/remove` MUST keep persistence in the
    client's selected credentials file. `list`, `set-default`, and `remove`
    MUST work without a reachable gateway or a default credential and MUST
    NOT resolve that default through local SQLite. A missing store lists empty.
    `add` MUST validate the candidate key before it writes the client file:
    through authenticated gateway `context whoami`, using that candidate as
    the bearer, when the gateway is reachable; against the state on this
    machine, read-only, when it is not (a stopped daemon must not keep the
    operator from storing a credential). A reachable gateway's
    validation/auth/transport/response failure MUST NOT fall back to local
    state, and no failure may write either credentials file. Existing
    runtime and explicit remote invocations MUST NOT gain a local operator
    fallback. No arbitrary environment or client file path is forwarded.

## Local operator is not a boundary

- A local `cli` invocation without `RAVI_CONTEXT_KEY` and without an explicit
  remote gateway (`RAVI_GATEWAY_URL`) resolves to the local operator. Every agent process runs as the same OS user as the daemon, so any
  agent that can execute code (a script, `bun <file>`, a git hook) can start a
  child without the key and act as the operator. Profiles, the Bash guard and
  approvals decide what is offered to the agent; they are not a boundary
  against code it already runs. Only OS isolation of the agent runtime closes
  this, and until it exists an agent reachable by third parties SHOULD stay
  `chat-only`.
- A process the daemon spawned for `ravi jobs run` (`RAVI_AUTOMATION_PRINCIPAL`
  = `automation:job:*`) MUST NOT resolve to the local operator: jobs are open to
  agents. A present marker (including a blank one) that is not a well-formed
  cron or trigger principal MUST also be denied. Shell cron and shell triggers keep the local operator
  because they run only when their owner acts as the operator
  (`CRON_SHELL_NOT_OPERATOR`, `TRIGGER_SHELL_NOT_OPERATOR`). This check closes
  the easy path only; a process can drop the marker.

## The daemon does not trust the agent's workspace

- The daemon MUST NOT run, in an agent's workspace, a command that reads the
  index or the work tree or runs repository hooks or filters (`git status`,
  `git diff`, `git add`, checkout). Those honour repository config the agent
  writes (`core.fsmonitor`, clean filters, submodules); the message-edit notice
  tells the agent to check its workspace itself. Resolving the repository from
  its remote (`gh repo view` in `gh-watch`, `gh pr view` in `gh-follow-sweep`)
  reads only `.git/config` and `HEAD` and stays allowed. `ravi doctor` runs git
  in the operator's terminal directory, not in an agent's.
- Writes the daemon makes in a workspace (`AGENTS.md`, `CLAUDE.md`, imported
  rules) MUST NOT follow a symlink at the target, and an imported rule MUST NOT
  land (or create directories) outside the workspace through a symlinked
  directory. `.ravi/rules` is read only when its real path stays inside the
  workspace; the daemon then reads and writes through the resolved directory,
  not the name, and re-checks after creating directories. Node has no
  per-component no-follow open, so a race on an intermediate directory stays
  possible until the OS sandbox; the agent can already read those files itself.
- CLAUDE.md becomes a pointer to AGENTS.md only when AGENTS.md holds real
  instructions; a skipped (symlinked) legacy bridge leaves CLAUDE.md intact.
- File arguments the daemon reads for a person held below break-glass stay in
  the session workspace and the temp directory, like their writes. The temp
  directory is shared by every session on the host, so such a person who names
  a path there can read another session's temp files through a command that
  reads files (`pages ship --html`). This is an accepted limit until the OS
  sandbox; a per-session temp directory is the follow-up.
- A Codex turn of a person held below the agent (no grant in the chat, or a
  held relay) runs in Codex's `read-only` sandbox, sent on every `turn/start`
  and on the thread it opens, never in `danger-full-access`. The Bash hook
  gates `shell`, but `apply_patch` and the sandbox are Codex's own, so the
  sandbox is what stops that person from writing files or reaching the network.
  The daemon marks such a turn with `RAVI_TURN_HELD_BELOW_AGENT` in the runtime
  env it refreshes before the turn; the provider reads it in the daemon. A
  person granted full access in the chat is not held and keeps the agent's
  sandbox.
- Shell cron and shell triggers run as the operator. `ravi doctor` warns
  (`permissions.shell_automation_in_agent_workspace`) when one runs code from
  an agent's workspace, because that agent can change what the operator runs.
  It does not refuse them: existing workflows rely on it.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| revoke | emergency containment (kills live runtime auth, cascades) | immediate |
| credentials remove | destructive (drops a working local credential) | dry-run + `--execute` |
| prune | destructive (deletes inactive context rows) | pre-existing `--apply` + `--confirm prune-contexts` (stronger equivalent, documented) |
| cleanup-agent-runtime | destructive (revokes stale contexts) | pre-existing dry-run default + `--revoke` (equivalent, documented) |
| credentials add / set-default | reversible local-store writes | not braked (declared) |
| issue | mints a revocable child context (reverse path: revoke) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| context not found (info / lineage / revoke) | `CONTEXT_NOT_FOUND` + id suggestions | 1 |
| credential entry not found (remove / set-default) | `CREDENTIAL_NOT_FOUND` + id/label suggestions | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid flag/arg (once the domain is registered in the usage-contract list) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

- `src/plugins/internal/ravi-dev/skills/context-cli/SKILL.md` teaches this
  surface and documents immediate `context revoke` containment.
- `src/cli/commands/daemon.ts` prints an operator hint pointing at
  `ravi context revoke <id>`; the command executes in one call.
- `.ravi/specs/wa-overlay/auth/SPEC.md` references `ravi context revoke` as the
  immediate daemon-side key-kill path.

## Validation

- `bun test src/cli/commands/context.test.ts` green (contract blocks included),
  no new failures vs the `dev` baseline.
- Live checks (isolated `RAVI_STATE_DIR`): `context info ctx-nope --json` →
  `CONTEXT_NOT_FOUND`, exit 1; `context revoke <id> --json` → revoked; `context
  credentials remove <key> --json` → exit 3 and the entry still stored; the
  dry-run plan shows key/path/label presence only; `context list --json --fields
  contextId,kind` narrows items.

## Known Failure Modes

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- `context.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  (returning true) or the contract helpers call `process.exit` in tests.
- The local credentials store lists full keys in its own `credentials list`
  output (the operator's own store); the secret-hygiene invariant applies to
  error envelopes, plans and suggestions — not to that explicit listing.
