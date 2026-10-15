# E2B Runs / CHECKS

## Suites

```bash
bun test src/sandbox/ src/cli/commands/sandbox.test.ts
bun run typecheck
bunx biome check src/sandbox/ src/cli/commands/sandbox.ts src/cli/commands/sandbox.test.ts
```

No check reaches E2B: every run goes through the fake sandbox, fake secret
store and fake telemetry in `src/sandbox/e2b.test.ts`.

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
- `sandbox run` and `sandbox logs` stay CliOnly, so the new flags change no
  SDK: `bun src/cli/index.ts sdk openapi check --against openapi.json`.
