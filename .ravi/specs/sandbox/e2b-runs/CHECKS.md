# E2B Runs / CHECKS

## Suites

```bash
bun test src/sandbox/ src/cli/commands/sandbox.test.ts src/cli/execute-consumers.test.ts
bun run typecheck
bunx biome check src/sandbox/ src/cli/commands/sandbox.ts src/cli/commands/sandbox.test.ts
```

No check reaches E2B: every run goes through the fake sandbox, fake secret
store and fake telemetry in `src/sandbox/e2b.test.ts`, the template build
through the recording fake builder there, and the reaper through the fake
`list`/`kill` in `src/sandbox/reap.test.ts`.

## Checks

- A created sandbox has `denyOut` = `["0.0.0.0/0"]`, `allowPublicTraffic`
  false, `lifecycle` `{ onTimeout: "kill", autoResume: false }`, and `allowOut`
  holding exactly the repo host and the model host
  (`bun test src/sandbox/e2b.test.ts`, "runs the task to done").
- Exactly one `updateNetwork` call follows the clone; it has no `github.com`
  rule, still has the model rule and adds the `dev-registries` hosts; a
  non-GitHub repo host is in the clone policy and absent from the update; the
  GitHub secret is destroyed right after that update, before the daemon starts
  (lifecycle `updateNetwork, destroy:github, kill, destroy:anthropic`)
  ("injects GITHUB_TOKEN as a clone-only header rule").
- Every transform-rule header value in both phases matches
  `${e2b.secrets.ravi-sbx-<24 hex>-<suffix>}`, in header mode with a GitHub
  token and in broker mode (`expectOnlyPlaceholders`, "injects GITHUB_TOKEN …",
  "keeps the real key out of the sandbox in broker mode").
- `DEV_REGISTRY_HOSTS` holds neither `proxy.golang.org` nor `sum.golang.org`;
  `--allow-host proxy.golang.org` still puts it in the run policy ("swaps the
  repo host for --allow-host and the registry preset").
- `buildSandboxNetwork` is pure: clone phase = repo host + model host (+ the
  GitHub rule only for `github.com`), run phase = model host plus `--allow-host`
  and the preset, `strict` drops the preset, no model headers means no rules
  ("buildSandboxNetwork" suite).
- `resolveSandboxCredentials` refuses `CLAUDE_CODE_OAUTH_TOKEN`,
  `RAVI_CLAUDE_CODE_OAUTH_TOKEN` and an OAuth-shaped `ANTHROPIC_API_KEY`
  with a `SandboxConfigError`; defaults to `header`, or `broker` when
  `RAVI_SANDBOX_ANTHROPIC_BASE_URL` is set; refuses a non-https broker URL
  ("resolveSandboxCredentials" suite).
- In `header` mode the sandbox env holds the placeholder key, the real key is
  absent from every `Sandbox.create` argument, is stored once under
  `ravi-sbx-<runId>-anthropic`, is referenced by its placeholder in the
  `x-api-key` rule and is destroyed after the run; when the store fails the run
  rejects and no sandbox is created ("runs the task to done", "never falls
  back to the env").
- In `broker` mode the env holds the placeholder key and `ANTHROPIC_BASE_URL`,
  the broker host replaces `api.anthropic.com` and carries the caller's
  headers; `--allow-host` and `--egress strict` shape the run policy; in `env`
  mode the real key is in the env and there is no rule ("keeps the real key
  out of the sandbox in broker mode").
- `GITHUB_TOKEN` becomes a `Basic` secret-store placeholder in a `github.com`
  rule during the clone only, with no credential file; when the store refuses
  it, the clone uses the credential file and removes it; the token is in no
  command string; a non-GitHub host gets neither ("injects GITHUB_TOKEN …",
  "falls back to the clone credential file …").
- `githubAuth: "file"` gives no GitHub rule, no GitHub secret (only the
  anthropic one) and the credential-file clone; `"header"` is unchanged
  ("with --github-auth file, clones through the credential file").
- Title and instructions are written to `/home/user/.ravi-task/{title,instructions.md}`
  and no command string contains them, including `$(rm -rf ~)`, backticks and
  quotes; the only `ravi tasks create` command uses `"$(cat …)"` and ends with
  `-- "$(cat /home/user/.ravi-task/title)"`; metadata has no title ("never
  lets task text reach a command string").
- Title plus instructions of 100 KiB reject with a `SandboxConfigError` before
  create, one byte less is accepted, and bytes are counted (two-byte characters
  count twice) ("rejects title and instructions over 100 KiB").
- No command contains `full-access`; the worker gets
  `bootstrap --capabilities 'execute:executable:*' --execute` and the operator
  `chat-only` ("runs the task to done").
- SIGINT or SIGTERM while `Sandbox.create` is pending kills the sandbox as soon
  as it returns, runs no command, destroys the secrets, calls `exit` with 130
  or 143 and leaves no handler behind ("kills a sandbox whose create was still
  pending").
- A second SIGINT (and a SIGTERM) while the first kill is still pending does
  not exit, does not remove the handler and is noted once as `cleanup in
  progress`; once the kill settles the secrets are destroyed exactly once, the
  handlers are gone and `exit(130)` runs ("ignores a second Ctrl-C …").
- A secret store whose `destroy` never resolves does not hold the exit past
  `signalCleanupTimeoutMs` ("exits within the cleanup limit when removing a
  secret hangs").
- `--keep` with `env` model auth rejects before anything is created; with
  `header` auth the lifecycle is `updateNetwork, updateNetwork, pause`, the
  last update is `{ allowOut: [], denyOut: ["0.0.0.0/0"], rules: {} }` and
  the daemon is stopped before the pause with `pkill -f '[r]avi daemon run'`
  (never the self-matching `'ravi daemon run'`), and the anthropic secret is
  destroyed after the pause ("with --keep, denies all egress …", "refuses
  --keep when the real API key sits in the sandbox env").
- `timeoutMin` 0, 56, 1.5 and NaN reject before create; 55 gives a one-hour
  sandbox ("rejects a timeout outside 1..55").
- CLI: `--timeout-min 0|56|1.5|abc`, `--model-auth bogus`, `--model-auth
  broker` with no `RAVI_SANDBOX_ANTHROPIC_BASE_URL`, `--egress bogus` and
  `--github-auth bogus` exit 2 with a `USAGE_ERROR` envelope before any
  credential is read; a 100 KiB `--task-file` exits 2 the same way;
  `--github-auth` defaults to `header` and accepts `file`; `--model-auth env`
  needs `--allow-key-in-env`; `--keep` with `env` is a usage error;
  `--allow-host` rejects URLs, paths, ports and bare `*`
  (`bun test src/cli/commands/sandbox.test.ts`).
- `redactTelemetry` masks real `sk-ant-…` values but leaves
  `sk-ant-api03-ravi-sandbox-placeholder` readable
  (`bun test src/sandbox/observe.test.ts`, "leaves the fixed placeholder key
  readable").
- `sandbox run`, `sandbox logs`, `sandbox reap` and `sandbox template build`
  are CliOnly, so the new command and fields change no SDK:
  `bun src/cli/index.ts sdk openapi check --against openapi.json`.

### Template pinning

- `TEMPLATE_BUN_LINUX_X64_SHA256` and `NATS_LINUX_AMD64_SHA256` are each 64
  lowercase hex and differ; `TEMPLATE_BUN_VERSION` is `1.3.11` and
  `NATS_VERSION` is `2.11.8` (`bun test src/sandbox/e2b.test.ts`, "pins every
  download").
- The recorded builder steps contain no `skipCache`; `gitClone` targets
  `RAVI_REPO` at `/home/user/ravi` with `{ branch: <ref>, depth: 50 }`; the
  checkout step is exactly
  `cd /home/user/ravi && git fetch --depth 1 origin <sha> && git checkout --detach <sha> && test "$(git rev-parse HEAD)" = <sha>`
  and sits after the clone and before `bun run build`; the build step is
  exactly
  `cd /home/user/ravi && test "$(git rev-parse HEAD)" = <sha> && bun install --frozen-lockfile && bun run build`
  ("resolves the ref on the host, checks out that SHA …").
- No command matches `| bash` or `| sh` and none mentions `bun.sh/install`;
  each archive's `sha256sum -c` line precedes its `unzip`/`tar` step; both
  download steps run as root and the Ravi build does not; `Template.build`
  receives `tags: [sha.slice(0, 12)]` (same test).
- The record file is mode 0600, holds `{ version: 1, templates: { <name>: {…} } }`
  with `name, templateId, buildId, ref, sha, bunVersion, natsVersion, builtAt`,
  and `readE2bTemplateRecord` returns it by name and null for another name
  (same test); a second build of the same name replaces its record and a
  different name adds one ("keeps one record per template name").
- An uppercase 40-hex `--ref` is lower-cased, used as the SHA and never passed
  to `resolveRef` ("accepts a 40-hex --ref as the SHA itself").
- A ref that does not resolve rejects with a `SandboxConfigError` naming the
  ref and `https://github.com/filipexyz/ravi.git`; a resolver answer that is
  not 40 hex, and `""`, `"  "`, `"-rf"`, `"a b"` reject as well; no builder
  step and no build happen ("fails clearly when a non-hex ref does not
  resolve").
- `pickLsRemoteSha` prefers `refs/heads/<ref>`, then `refs/tags/<ref>^{}`,
  then `refs/tags/<ref>`, ignores malformed lines and returns null for a
  prefix match ("picks the branch, then the peeled tag").
- A run whose sandbox reports the recorded `templateId` writes
  `Template <name>: ravi <sha> (built <builtAt> on this host)` to run.log and
  sets `templateSha`, `templateId` and `templateNote`; one whose sandbox
  reports another id writes
  `Template <name>: id <id> does not match this host's record (<recorded id>, ravi <sha>) — rebuilt elsewhere?`
  and `templateSha` is null; one whose `getInfo` fails reports the record as
  unverified with `templateSha` and `templateId` null; without a record it
  writes the warning before create, then `id <id>, no build record on this host …`,
  and `templateSha` is null; a corrupt file or a record without a 40-hex `sha`
  reads as missing ("template record in a run" suite, "runs the task to done").
- Created sandboxes carry `ravi_pid: String(process.pid)` next to `purpose`,
  `ravi_run` and `ravi_host` ("runs the task to done").

### Reaper

- `listRaviTaskSandboxes` queries `{ purpose: "ravi-task", ravi_host }` (only
  `purpose` with `allHosts`) and, against a server that returns everything,
  still drops `purpose !== "ravi-task"` (`not-ravi-task`) and other hosts
  (`other-host`) (`bun test src/sandbox/reap.test.ts`, "queries E2B by purpose
  and this host").
- `DEFAULT_REAP_OLDER_THAN_MIN` is `MAX_SANDBOX_TIMEOUT_MIN + 10`; paused,
  overdue (strictly older) and dead-pid sandboxes are candidates with those
  causes; a sandbox exactly at the limit, a live pid, no pid and a non-numeric
  pid are `live` ("flags paused, overdue and dead-pid sandboxes").
- A dead pid on another host's sandbox is not a cause; the same host's paused
  sandbox is ("never reads another host's pid as a local process").
  `processIsAlive(process.pid)` is true and 2^31-1 (above every platform's
  pid range) is false; 0, -1, `-process.pid`, 1.5, NaN and Infinity are false
  without reaching `process.kill` ("never passes a non-positive or fractional
  pid").
- `killCandidates(plan, deps)` kills exactly `plan.candidates`, records a
  failed kill and continues, leaves the plan object untouched and ignores
  anything outside the candidates ("killCandidates kills exactly the plan's
  candidates").
- `reapSandboxes` without `execute` lists candidates and calls no kill; with
  `execute` it kills exactly the candidates, records a failed kill in `failed`
  and continues; `sbx-live`, another host's sandbox, a forged
  `purpose: ravi-task` with another `ravi_host`, and a non-ravi sandbox are
  never killed ("plans without killing", "with execute, kills only the
  candidates").
- With `allHosts`, other hosts' paused or overdue ravi-task sandboxes are
  killed, a non-ravi sandbox is not, and a running other-host sandbox with a
  dead pid is `live` ("includes other hosts' … only with allHosts").
- `olderThanMin` 29 flags a 30-minute sandbox and 30 does not; 0, -1, 1.5 and
  NaN reject before listing ("honours olderThanMin").
- CLI: `executeSandboxReap` without `--execute` throws `WRITE_REQUIRES_EXECUTE`
  with exit 3, the message `Dry-run: nothing was killed. Re-run with --execute to kill.`
  and a plan `{ hostId, allHosts, olderThanMin, kill: [{ sandboxId, cause, … }], skipped }`
  and no kill; `--execute` kills the matches of this host only, through
  `killCandidates`, and a kill E2B refuses lands in `failed` while the others
  are still killed ("with --execute, a failed kill is reported"); `--all-hosts`
  drops the host filter; no candidate returns the empty plan; `--older-than`
  `0|abc|1.5|-3` is a `USAGE_ERROR` (exit 2) before any listing and `" 10 "`
  is accepted (`bun test src/cli/commands/sandbox.test.ts`, "sandbox reap"
  suite). The spawned CLI without `E2B_API_KEY` exits 1 naming the variable.
- The plan field is `cause`, not `reason`: `reason` is a content-redacted key
  in CLI envelopes (`src/cli/redaction.ts`) and would print as `[REDACTED]`.
- `AGENTS.md` documents `ravi sandbox reap --execute`
  (`bun test src/cli/execute-consumers.test.ts`); `sandbox reap` declares
  `requiresConfirmation: true` and reads its `--execute` flag
  (`bun run test:agent-contract`, confirmation-policy suite).
