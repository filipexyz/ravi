---
id: sandbox/e2b-runs
title: "E2B Runs"
kind: capability
domain: sandbox
capabilities:
  - e2b-runs
tags:
  - sandbox
  - e2b
  - egress
  - credentials
  - security
applies_to:
  - src/sandbox/**
  - src/cli/commands/sandbox.ts
owners:
  - rbbt-sandbox
status: active
normative: true
---

# E2B Runs

## Intent

`ravi sandbox run` executes one task in a disposable E2B microVM that holds a
clone of someone's repository, a Claude worker and whatever credentials the run
needs. This spec bounds what that machine can reach, what it can see and how
long it lives, so that a prompt-injected or simply wrong worker cannot
exfiltrate the repository or the credentials, and so that a credential never
reaches a place E2B records (command logs, sandbox info, snapshots).

## Vocabulary

- Clone phase: from `Sandbox.create` until `git clone` returns.
- Run phase: from the first `updateNetwork` after the clone until the sandbox
  is killed or paused.
- Model host: `api.anthropic.com`, or the host of
  `RAVI_SANDBOX_ANTHROPIC_BASE_URL` in `broker` mode.
- Model auth mode: `broker`, `header` or `env` (`SandboxModelAuth`).
- Placeholder key: `sk-ant-api03-ravi-sandbox-placeholder`, the value of
  `ANTHROPIC_API_KEY` inside the sandbox in `broker` and `header` modes.
- Transform rule: an E2B egress-proxy rule that adds headers to HTTPS requests
  for one host (`network.rules[host]`).

## Invariants

### Egress

- Every sandbox is created with `denyOut: ["0.0.0.0/0"]` and
  `allowPublicTraffic: false`; a host is reachable only while it is in
  `allowOut`.
- In the clone phase `allowOut` holds exactly the repo host and the model host.
- The run phase starts with exactly one `updateNetwork` call, made after the
  clone returns, whose policy is `buildSandboxNetwork("run", …)`: the model
  host, `--allow-host` entries and, unless `--egress strict`, the
  `dev-registries` preset. The repo host is not in it unless the preset or
  `--allow-host` names it. An update replaces the whole policy, so it carries
  the model rule again and never the GitHub rule.
- The `dev-registries` preset (`DEV_REGISTRY_HOSTS`) holds fixed-content package
  registries only. `proxy.golang.org` and `sum.golang.org` are not in it: GOPROXY
  fetches arbitrary module origins on demand, so it would relay to any host. Go
  users add it with `--allow-host proxy.golang.org`.
- `--allow-host` accepts host names (optionally `*.suffix`), lower-cased; a
  URL, path, port or bare `*` is a usage error (exit 2). `--egress` accepts
  `dev-registries` (default) or `strict`.

### Lifecycle

- Sandboxes are created with `lifecycle: { onTimeout: "kill", autoResume: false }`
  and a lifetime of task timeout + 5 min.
- `--timeout-min` is a whole number from 1 to 55 (`MAX_SANDBOX_TIMEOUT_MIN`);
  anything else is a usage error (exit 2) before any network call.
  `runE2bSandboxTask` enforces the same bound with a `SandboxConfigError`.
- SIGINT and SIGTERM handlers are installed (`process.on`) before
  `Sandbox.create`. A signal during a pending create kills the sandbox as soon
  as E2B returns it and exits 130 (SIGINT) or 143 (SIGTERM); afterwards a
  signal kills (or, with `--keep`, pauses) the live sandbox with the same exit
  codes. The kill (or pause) and the secret removal run under one time limit
  (`SIGNAL_CLEANUP_TIMEOUT_MS`, 15 s); the process exits when they settle or
  when the limit passes, whichever is first. A repeat signal while that cleanup
  runs is ignored and noted once (`cleanup in progress`); it neither removes
  the handlers nor exits early. The handlers are removed only after the cleanup
  settles, or before the function returns on the normal path.
- `--keep` is refused (usage error, exit 2 in the CLI; `SandboxConfigError`
  in the library) when any secret is in the sandbox env (`env` model auth).
  Otherwise, before `pause()`, the policy becomes
  `{ allowOut: [], denyOut: ["0.0.0.0/0"], rules: {} }` and the daemon is
  stopped, so a resumed sandbox has no egress, no injected credential and no
  process waiting for work.

### Credentials

- Sandboxes take an Anthropic API key only. `CLAUDE_CODE_OAUTH_TOKEN` and
  `RAVI_CLAUDE_CODE_OAUTH_TOKEN` are refused with a `SandboxConfigError`, as is
  an `ANTHROPIC_API_KEY` whose shape is an OAuth token (`sk-ant-oat…`).
- Model auth defaults to `broker` when `RAVI_SANDBOX_ANTHROPIC_BASE_URL` is set
  (it must be an https URL) and to `header` otherwise. `env` is never chosen
  implicitly and the CLI requires `--allow-key-in-env` for it.
- In `header` mode the real key is stored in E2B's secret store under a
  per-run name (`ravi-sbx-<runId>-anthropic`) and referenced by its
  `${e2b.secrets.<name>}` placeholder in the `x-api-key` rule for the model
  host; the sandbox env holds the placeholder key and the real key appears in
  no `Sandbox.create` argument. If the secret cannot be stored the run fails;
  it never falls back to the env.
- In `broker` mode the sandbox env holds the placeholder key and
  `ANTHROPIC_BASE_URL`; the broker host is the model host and its rule carries
  the `headers` the caller passes (the grant, from connected runs).
- Every header value in `network.rules`, in both phases, is a
  `${e2b.secrets.<name>}` placeholder: the model key in `header` mode, the
  GitHub credential, and the broker grant that slice 06b supplies (06b stores
  the grant and passes its placeholder in `headers`, never the value).
- Per-run secrets are destroyed when the run ends, whatever the outcome
  (success, error, signal, create failure). The GitHub secret is destroyed
  earlier, right after the post-clone `updateNetwork`, since nothing references
  it from then on.
- `GITHUB_TOKEN` is used only for `https://github.com/...` clones. With
  `--github-auth header` (default) it is an
  `Authorization: Basic base64(x-access-token:TOKEN)` transform rule on
  `github.com` that exists in the clone phase only; the value is a secret-store
  placeholder. With `--github-auth file`, or when the store refuses the secret,
  the clone uses git's credential file (`/home/user/.ravi-clone-credentials`,
  removed after the clone) and no GitHub rule or secret exists. Any other
  `--github-auth` value is a usage error (exit 2). The token is in no command
  string and no env var in either mode.
- `--model-auth broker` without `RAVI_SANDBOX_ANTHROPIC_BASE_URL` is a usage
  error (exit 2) before any credential is read.
- Metadata is `{ purpose: "ravi-task", ravi_run: <24 hex>, ravi_host: sha256(installation key)[:16], ravi_pid: <host pid> }`;
  it never holds the task title.

### Least privilege inside the sandbox

- The worker agent gets `ravi agents permissions worker bootstrap --capabilities 'execute:executable:*' --execute`,
  never `full-access`. The operator helper is `chat-only`.
- The sandbox env sets `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### No task text in argv

- Task title and instructions are written with `files.write` to
  `/home/user/.ravi-task/title` and `/home/user/.ravi-task/instructions.md`
  and passed to `ravi tasks create` as `"$(cat …)"`; the title comes last,
  after `--`, so a title that starts with `-` is not parsed as an option. No
  command string sent to the sandbox contains the title or the instructions;
  shell syntax inside them (`$(…)`, backticks, quotes) is data.
- Title and instructions together are at most `MAX_TASK_TEXT_BYTES` (100 KiB).
  The CLI rejects more as a usage error (exit 2) before any credential is read;
  `runE2bSandboxTask` throws a `SandboxConfigError` before creating anything.

### Template pinning (`ravi sandbox template build`)

- `--ref` (default `dev`) is resolved to a 40-hex commit SHA on the host before
  any build, through `git ls-remote` against the public repository
  (`RAVI_REPO`): the branch head first, then the peeled tag, then the tag. A
  40-hex `--ref` is the SHA itself and is not resolved or checked against any
  branch: GitHub serves any object in the repository network (forks and
  unreferenced commits included), so such a ref may name a commit that was
  never on a `filipexyz/ravi` branch. It is operator-trusted input, like the
  E2B key the same operator holds. A ref that resolves to nothing, or an
  empty, whitespace- or `-`-prefixed ref, is a `SandboxConfigError` before any
  builder call.
- The sandbox checks out that SHA and proves it: after `gitClone`, one step runs
  `git fetch --depth 1 origin <sha> && git checkout --detach <sha> && test "$(git rev-parse HEAD)" = <sha>`,
  and the build step is
  `test "$(git rev-parse HEAD)" = <sha> && bun install --frozen-lockfile && bun run build`.
  The SHA in both command strings is what invalidates E2B's layer cache for the
  checkout and the build, so the template never calls `skipCache()`.
- Bun (`TEMPLATE_BUN_VERSION`, the CI version) and nats-server (`NATS_VERSION`)
  are installed from pinned release archives saved to disk, verified with
  `sha256sum -c` against `TEMPLATE_BUN_LINUX_X64_SHA256` and
  `NATS_LINUX_AMD64_SHA256`, and only then unpacked. No download is piped into
  a shell (`curl … | bash` does not appear). Each constant is 64 lowercase hex
  copied from the publisher's checksum file (provenance in RUNBOOK).
- The build is tagged with `sha.slice(0, 12)` and recorded in
  `~/.ravi/sandbox-templates.json` (mode 0600, written with
  `writeUserOnlyFile`) as `{ name, templateId, buildId, ref, sha, bunVersion, natsVersion, builtAt }`
  under `templates[<name>]`; a rebuild of the same name replaces its record.
- `sandbox run` reads the record for its template and, once the sandbox is up,
  asks E2B which template it booted from (`Sandbox.getInfo().templateId`). The
  record is "last built from this host", not a fact about the sandbox, so the
  commit is claimed only when the two ids agree: run.log and the text result
  then say `Template <name>: ravi <sha> (built <builtAt> on this host)` and
  `templateSha` is the record's sha. When the ids differ they say
  `Template <name>: id <templateId> does not match this host's record (<recordTemplateId>, ravi <sha>) — rebuilt elsewhere?`
  and `templateSha` is null; when `getInfo` fails the record is reported as
  unverified and `templateSha` is null. Without a record the run warns before
  creating the sandbox and `templateSha` is null. The JSON result carries
  `templateId` (E2B's answer, null when unread) and `templateNote` (the text
  after `Template <name>: `). A record whose `sha` is not 40 hex counts as
  missing.

### Reaper (`ravi sandbox reap`)

- Candidates come from `Sandbox.list` filtered by metadata
  `{ purpose: "ravi-task", ravi_host: <this host> }` (without `ravi_host` under
  `--all-hosts`), and the same filter is applied again client-side: an item
  without `purpose: "ravi-task"` is never a candidate, and without `--all-hosts`
  neither is one whose `ravi_host` differs, whatever the server returned.
- A listed sandbox is a candidate when it is `paused` (a `--keep` sandbox of
  this host included), or running for more than `--older-than` minutes (default
  `MAX_SANDBOX_TIMEOUT_MIN + 10`), or running on this host with a `ravi_pid`
  that is not alive here (`process.kill(pid, 0)`; `EPERM` counts as alive;
  `processIsAlive` itself returns false for anything that is not a positive
  integer, so pid 0 and negative pids are never passed to `process.kill`).
  Another host's `ravi_pid` is never tested against this host's process table,
  so under `--all-hosts` other hosts' sandboxes qualify only as paused or
  overdue.
- Killing is irreversible and external: with at least one candidate and no
  `--execute` the command prints the plan and exits 3 (`contractDryRun`, worded
  `nothing was killed … --execute to kill`) without calling `kill`; with no
  candidate it returns the empty plan (exit 0). `--execute` kills each
  candidate through `killCandidates`, the one kill loop the library
  (`reapSandboxes({ execute: true })`) and the CLI share; it continues past a
  failed kill and exits 1 when any kill failed. `--older-than` must be a whole number of minutes, at
  least 1 (usage error, exit 2, before any listing).
- The command is CliOnly with
  `@CommandAccess({ kind: "mutate", resource: "sandbox", action: "reap", risk: "high", requiresConfirmation: true })`,
  the confirmation metadata every `--execute` brake declares
  (`src/cli/confirmation-policy.test.ts`).

### Outputs (everything returned from the sandbox is untrusted data)

The worker follows instructions it did not write and may be prompt-injected,
so every byte read back from the sandbox (task status, task id, `task.json`,
the patch, the daemon log, traces, transcripts, session names, command
stderr) is data from an untrusted machine. The worker also owns the clone's
`.git/config` and every binary it can write to, so `changes.patch` is
attacker-authored: `git diff` (or `head`, `wc`, the shell) can print anything.

- Files: the output directory, a custom `--output` included, is created or
  made `0700`; every file in it, `e2b/` telemetry included, is written `0600`
  through `writePrivate` (a fresh `O_EXCL|O_NOFOLLOW` temp file renamed over
  the path, so a link there is replaced, not followed) or `appendPrivate`
  (`O_NOFOLLOW|O_NONBLOCK` open: a symbolic link, dangling or not, or a FIFO is
  refused and its target left untouched) (`src/sandbox/outputs.ts`).
  `mkdirPrivate` refuses a directory that is a symbolic link; the run passes
  the output directory as `root`, so every directory from there down is
  checked. No output write uses `writeFileSync` or `appendFileSync` directly.
- Size, inside the sandbox: every read goes through `cappedCommand` (stdout to
  a temp file and `head -c <cap+1>`, stderr to another temp file and
  `head -c 65536`, the command in a subshell so its exit code is kept, then the
  stdout size on a line of its own as `ravi-bytes=<n>`, last on stderr).
  Caps: daemon log 50 MiB (the live copy too), `changes.patch` 20 MiB, each
  transcript, trace and `TASK.md` 10 MiB, JSON the run parses 1 MiB. Text over
  its cap is cut on a character boundary and ends with
  `[ravi: output truncated at <cap> bytes; the sandbox reported <n> bytes]`.
- Size, on the host: the wrapper only holds if the sandbox runs it as written,
  so every command runs as a background handle whose `onStdout`/`onStderr`
  bytes are counted as they arrive. A capped read that streams more than
  cap + 1 MiB (`STREAM_MARGIN`), or any other command more than 4 MiB, is
  disconnected and killed and fails with `sent more than <limit>`; the host
  therefore holds at most that limit plus one SDK event per command. The live
  daemon tail holds a line without its newline up to 64 Ki characters (the
  rest of that line is dropped, the kept part ends with
  `[ravi: line cut at 65536 characters]`) and is disconnected once 50 MiB have
  arrived. Collection stops reading once it has received 200 MiB (`MAX_TOTAL`,
  counted in received bytes, not saved bytes); the file that crosses it is not
  saved and later files are not read (one step line).
- All or nothing: a patch over its cap is not saved in part; the run writes
  `changes.patch.TOO_LARGE.txt` with the size instead, and no `review.json`.
  `task.json` over 1 MiB gets the same treatment and is never parsed;
  `ravi sessions list` over 1 MiB is rejected.
- Status: `ravi tasks show --json` is parsed with a zod schema; only a
  `TaskStatus` (`open`, `dispatched`, `in_progress`, `blocked`, `done`,
  `failed`) counts, anything else (escape sequences included, or JSON over
  1 MiB) ends polling as `invalid`. The result carries `reportedStatus`
  (unverified) and the same value in `status` for older scripts; the text
  output says "reported by the sandbox, unverified". The exit code is 0 only
  for `done` (`sandboxRunExitCode`).
- Task id: the id `ravi tasks create` returns must match `TASK_ID_RE`
  (`task-` and 8 lower-case hex digits, the format `dbCreateTask` makes) before
  it is used in a command, a path or a printed line; anything else fails the
  run (`error`, `taskId: null`).
- Names: session names and transcript path segments become file names through
  `safeFileName`: a plain lower-case name of at most 120 bytes is kept; any
  other is cleaned, cut to 120 bytes and suffixed `~<10 hex of sha256>` (before
  a short extension), so `a b` and `a_b`, or `Worker` and `worker`, never share
  a file and `../../x` is saved as `sessions/x~<hash>.*`. Transcript paths must
  start with the Claude projects directory.
- Collection never aborts on a sandbox-chosen name: each file write is
  isolated (a name clash, a too-long name, a full disk becomes a
  `Could not save <name>: …` step line and collection goes on), and a failure
  of collection as a whole is added to `error`; the run still kills the
  sandbox and returns, so the status lines and the patch review box print.
- Terminal: `onStep` and `onDaemonLog` lines and every line of the `sandbox
  run` text summary (`formatSandboxRunSummary`: `Task:`, `Sandbox:`,
  `Template`, `Error:`, the E2B telemetry lines of `formatTelemetry`, the patch
  review box) are printed through `stripTerminalControls` (CSI, OSC incl.
  OSC 52 clipboard and OSC 8 hyperlinks, BEL- or ST-terminated, DCS/PM/APC
  strings, other C0 except `\n` and `\t`, DEL, C1 `U+0080`–`U+009F`, bidi
  overrides `U+202A`–`U+202E` and isolates `U+2066`–`U+2069`); paths in the
  review box and its suggestions show any control character left (`\n`,
  `\t`, C1, bidi) as an escape. Saved files keep the raw bytes, still
  redacted.
- `--json` (`run`, `logs`, `reap`, `template build`) prints `terminalSafeJson`:
  `JSON.stringify` escapes C0 controls, and C1 controls, bidi marks
  (`U+061C`, `U+200E`, `U+200F`), overrides, isolates and `U+2028`/`U+2029`
  are written as `\uXXXX` too. The JSON value is unchanged: a consumer that
  decodes it and prints a string raw gets the raw characters back.
- Patch review (`src/sandbox/patch-review.ts`, ADR 0002 #9): `changes.patch`
  is read the way `git apply` reads it and never applied. A file starts at a
  `diff --git` line or, between files, at a `--- `/`+++ ` pair with no
  `diff --git` (a plain unified diff); `---`, `+++`, `rename from`/`rename old`,
  `rename to`/`rename new`, `copy to`, mode and `index` lines count only in the extended header; hunk
  bodies are consumed by the `@@ -a,b +c,d @@` counts, so a `+++ b/x` or
  `diff --git` line inside a hunk is content; lines between files are skipped,
  as git skips them. The path a flag is shown under follows `-p1` (the first
  component is dropped whatever it is). Modes are parsed like git (`strtoul` base 8, then
  whitespace): `0120000` and `120000 ` are symlinks, any mode with `0o100` is
  executable, `160000` is a gitlink. Paths are matched lower-cased and with
  `//` and `.` collapsed. The reviewer classifies every name git could write
  for a file: each raw `diff --git`, `---`, `+++`, `rename from`, `rename to`
  and `copy to` name as written (`-p0`) and with one component stripped, whole
  and cut before a space, tab or CR (timestamps, CR terminators) and at and
  just after the last tab of the last few whitespace runs (git's timestamp and
  whitespace-damage cuts), with the union of their flags shown under the
  best-guess path, so an ordinary `foo.txt 2010-…` header also classifies
  `foo.txt`, and a rename that moves `CLAUDE.md` away is flagged under its new
  name. Unquoted `diff --git` names are split in linear time (only the middle
  blank can split `-p0` halves, and at most one blank has `-p1` halves of
  equal length), so a sandbox-written header of megabytes of blanks cannot
  stall the host.
  Flags: `agent-config` (`.claude/**`, `.cursor/**`, `.gemini/**`,
  `.codex/**`, `.agents/**`, `.windsurf/**`, `.mcp.json`,
  `.vscode/{settings,tasks,launch}.json`, `AGENTS.md`, `CLAUDE.md`,
  `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`,
  `.github/copilot-instructions.md`), `env-config` (`.envrc`, `.env*`,
  `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.tool-versions`,
  `.mise.toml`, `mise.toml`), `hooks-ci` (`.husky/**`, `.githooks/**`,
  `lefthook.y{a,}ml`, `.pre-commit-config.yaml`, `.lintstagedrc*`,
  `lint-staged.config.*`, `.simple-git-hooks.*`, `.github/workflows/**`,
  `.gitlab-ci.yml`, `.circleci/**`, `.devcontainer/**`), `build` (`Makefile`,
  `GNUmakefile`, `flake.nix`, `build.rs`, `conftest.py`, `justfile`,
  `Taskfile.y{a,}ml`, `.pnpmfile.{c,m}js`), `dependency` (lockfiles:
  `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `bun.lock{,b}`, `deno.lock`, `Cargo.lock`, `poetry.lock`, `uv.lock`,
  `Pipfile.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`), `git-config`
  (`.gitattributes`, `.gitmodules`, gitlinks), `executable`, `symlink`,
  `binary`, `path-escape` (`..`, a leading `/`, or a symlink whose target has
  either). `package.json` hunks are tokenised as JSON (escapes decoded) on
  each side; every changed key or value is placed under its top-level key,
  known when the hunk starts at line 1 or its context opens `"scripts"`,
  `"dependencies"` or `"devDependencies"` in the container. Flagged:
  `scripts`, `bin`, `directories`, `config`, `gypfile` (`build`);
  `lint-staged`, `simple-git-hooks`, `husky`, `pre-commit` (`hooks-ci`);
  `trustedDependencies`, `overrides`, `resolutions`, `pnpm`,
  `patchedDependencies`, `packageManager`, `workspaces`, a dependency added to
  any `*dependencies` section, a dependency spec that is not a registry
  version, range or tag (`git+…`, `github:`, URLs, `file:`, `link:`, `npm:`,
  paths, tarballs) and a restructured dependency section (`dependency`); a
  changed token whose top-level key the hunk does not show is
  `package-json-unknown-section` (`build` when it is a lifecycle script name
  such as `postinstall`). Only a registry-version change to an existing
  dependency or a change to another top-level key (`version`,
  `description` …) passes. The review is saved as `review.json` (`0600`),
  returned as `review` (`{ files, flags[], suggestions[] }`, null when no
  patch was saved), printed as a boxed warning in text mode, and suggests
  `git apply --check changes.patch` and one `git apply --exclude=<path>` per
  flagged path and per flagged candidate name (`x`, `a/x`, `b/x`), plus, when
  an `executable`, `symlink`, `binary` or gitlink flag fires, every raw name of
  that file whole as written and after `-p1`, all to be run from the
  repository root (as the box says), with `[`, `]`, `*`, `?` and `\` escaped for git's wildmatch
  and the word shell-quoted (`$'…'` when it holds control characters). Flags
  never change the exit code.

## Validation

```bash
bun test src/sandbox/ src/cli/commands/sandbox.test.ts src/cli/execute-consumers.test.ts
```

See `CHECKS.md`.

## Known Failure Modes

- E2B's `updateNetwork` clears omitted fields: an update that only adds hosts
  silently drops every transform rule, so the model rule must be resent.
- `SandboxInfo.network.rules` shows literal header values to anyone holding the
  E2B key; only secret-store placeholders are safe there.
- `allowPublicTraffic: false` protects inbound sandbox URLs only; egress is
  `denyOut`.
- E2B logs every command string and per-command env for days; anything secret
  or customer-provided must travel through files or the proxy.
- E2B's transform rules are beta and need the sandbox to trust the proxy's CA
  (see RUNBOOK, open checks). `header` mode is the default but is not trusted
  until that check is recorded there.
- `pkill -f 'ravi daemon run'` would match the shell running the pkill itself;
  the pattern is `'[r]avi daemon run'`.
- E2B serves the `gitClone` layer from its cache when the command string is
  unchanged, so a `--ref dev` rebuild would keep an old checkout; the SHA in the
  checkout step is what makes that layer stale, and the build layer re-checks
  the SHA (`test "$(git rev-parse HEAD)" = <sha> && …`) so its own cache key
  changes with the commit as well; either `rev-parse` test fails the build if
  a cached layer ever slips through.
- The build record names the template this host built last, not the template
  a sandbox booted from: the same name can be rebuilt from another host or
  the dashboard. The run compares E2B's `templateId` with the record and
  claims the commit only on a match.
- `Sandbox.list` metadata matching is an open live check (RUNBOOK 5); the reaper
  does not rely on it and re-filters every item.
- A paused run's saved E2B logs show the placeholder key
  (`sk-ant-api03-ravi-sandbox-placeholder`) in clear; `redactTelemetry` leaves
  exactly that value readable so a log does not look like a key leak.
- A pipe (`cmd | head -c`) would report `head`'s exit code and `{ cmd; }`
  would let an `exit` in `cmd` end the wrapper; `cappedCommand` writes to a
  temp file from a subshell instead.
- The patch review reads `package.json` hunks only: a hunk deep inside a long
  `"scripts"` block whose context does not show the `"scripts"` key is not
  flagged. The review is a reading aid, not a gate; read the patch.
