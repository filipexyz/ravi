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
- Metadata is `{ purpose: "ravi-task", ravi_run: <24 hex>, ravi_host: sha256(installation key)[:16] }`;
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

## Validation

```bash
bun test src/sandbox/ src/cli/commands/sandbox.test.ts
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
- A paused run's saved E2B logs show the placeholder key
  (`sk-ant-api03-ravi-sandbox-placeholder`) in clear; `redactTelemetry` leaves
  exactly that value readable so a log does not look like a key leak.
