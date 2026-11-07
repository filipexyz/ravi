---
id: cli/runtime-env
title: "Runtime env agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - runtime-env
tags:
  - cli
  - runtime-env
  - agent-first
  - error-envelope
  - secret-hygiene
  - gateway
applies_to:
  - src/cli/commands/runtime-env.ts
  - src/runtime/ravi-env-file.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Runtime env agent-first CLI contract

## Intent

Give Hub and other closed-box agents a TTY-free way to write the Ravi env
file (`$RAVI_STATE_DIR/.env`, default `~/.ravi/.env`) through the SDK
gateway. This is not `ravi setup` and not `ravi login`.

## Invariants

1. Keys MUST match `^[A-Z][A-Z0-9_]*$` and MUST be in the v1 allowlist.
   Unknown keys fail closed with `ENV_KEY_NOT_ALLOWED` (exit 2).
2. Values MUST NOT contain newlines or NUL. Writes are atomic (temp + rename)
   and the file mode MUST be `0600`.
3. `get` MUST redact secret values (`CLAUDE_CODE_OAUTH_TOKEN`,
   `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) as `[REDACTED]`.
4. `--value` / gateway body `value` MUST be declared in `@CommandAccess.redactions`.
   Tokens, rctx keys, and secret values MUST NEVER appear in envelopes, audit,
   or `--json` output.
5. Mutations are local and reversible (`unset`). They are declared unbraked.
6. `set` and `unset` MUST return `warnings` naming every live managed daemon or
   channel runner whose bundle or env file is newer than its boot observation.
   Text output MUST print the same warnings with explicit restart commands.
   Warning content MUST NOT include env values.
7. Env mutations MUST NOT restart either process. Updating one caller's
   `process.env` does not reconcile its sibling or prove the complete file was
   loaded; the operator follows the reported reconciliation commands.

## Allowlist v1

- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth
- `ANTHROPIC_API_KEY` — Anthropic API key
- `ANTHROPIC_AUTH_TOKEN` — Anthropic auth token
- `CODEX_HOME` — Codex isolated profile home
- `GROK_HOME` — Grok isolated profile home
- `GROK_DISABLE_AUTOUPDATER` — disable grok CLI self-update on closed boxes

Extend only in `src/runtime/ravi-env-file.ts` with a comment naming the consumer.

## Write classification

| op | class | brake |
|---|---|---|
| set | local reversible file write | not braked (declared) |
| unset | local reversible file write | not braked (declared) |
| get | read; secrets redacted | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| unknown key | `ENV_KEY_NOT_ALLOWED` | 2 |
| invalid key shape | `ENV_KEY_INVALID` | 2 |
| empty / newline value | `ENV_VALUE_INVALID` | 2 |
| missing --stdin/--value | `USAGE_ERROR` | 2 |

## Gateway

- `POST /api/v1/runtime/env/set`
- `POST /api/v1/runtime/env/unset`
- `POST /api/v1/runtime/env/get`

## Managed env writer boundary

The supported destination is the fixed local `$RAVI_STATE_DIR/.env` on Linux or
macOS. Arbitrary project files, remote destinations and a general dotenv/shell
serializer are not supported. Both production consumers (`src/daemon.ts` and
`src/cli/env.ts`) read one physical line, trim outside whitespace and remove one
outer quote pair; they do not unescape, expand dollars or interpret inline
comments. The writer MUST round-trip values through this literal dialect without
adding backslash escaping. Unsupported syntax (including multiline, `export`,
invalid UTF-8 and malformed assignments) MUST fail without modifying the file.

- `set`, `unset` and internal `addRaviEnvKey` MUST patch only the target line.
  Untouched bytes, line endings, comments, spacing and sibling duplicates MUST
  remain unchanged. Ambiguous duplicate target assignments MUST be refused;
  add-only MUST reject any target occurrence, including an empty assignment.
- All managed mutations MUST acquire the same per-file exclusive `.env.lock`
  before snapshot, format checks, add-only/preconditions, patch and commit.
  The add-only precondition MUST also refuse an inherited target, even empty.
  A held or orphaned lock MUST fail closed; no timeout/PID-based lock stealing.
- Non-cooperating replacement or byte/metadata changes observed before rename
  MUST return conflict. This check is not atomic CAS against arbitrary external
  editors: every writer/deploy touching the file MUST respect the lock. Same-UID
  hostile processes/root remain trusted, not isolated by this API.
- The absolute state-directory path MUST be normalized and free of symlinks in
  every component. Ancestors MUST be current-user/root owned and not writable
  by others; a root-owned sticky temporary ancestor is permitted. The state
  directory MUST be owned by the current user and not writable by others. No
  existing directory permissions may be repaired with chmod. Noncanonical OS
  aliases (for example macOS `/var`) are refused too; use their canonical path.
- Existing env files MUST be regular, current-user owned, single-link and mode
  0600. Reads MUST use no-follow descriptors and verify identity. Temporary and
  lock files MUST be created exclusively with no-follow and mode 0600. A
  preexisting temp MUST never be followed, overwritten or removed on failure.
- The writer MUST pin and recheck ancestor/directory identities, lock and temp
  identities, sync the complete temp, compare the snapshot, atomically rename,
  then sync the directory. It MUST refuse unsupported paths before secret bytes
  are written. Secret and raw filesystem errors MUST NOT escape, including as
  `cause`. A post-rename failure MUST report `ENV_WRITE_UNCERTAIN`.
- Crashed-process lock/temp recovery is an explicit trusted maintenance action,
  not automatic cleanup. A process crash after rename may require reconciliation;
  the intake keeps pending requests blocked rather than authorizing blind retry.

### Legacy writer register

`src/cli/commands/setup.ts` still appends/initializes `.env` directly. It does not
participate in this module's lock and MUST NOT run concurrently with managed
mutations. External editors/deploys have the same restriction. Migrating the
setup writer to the same boundary is explicit follow-up debt, not a claimed
part of this change; no whole-runtime single-writer or remote safety guarantee
is made. Removal condition: setup/init and every other writer use the same
narrow per-file transaction boundary without broadening the key allowlist.
