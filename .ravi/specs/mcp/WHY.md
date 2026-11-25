# MCP Servers / WHY

## One registry instead of runtime configuration

Before this domain, each runtime loaded MCP servers from its own files:
Claude Code from `.mcp.json`, plugins, user settings and claude.ai connectors;
Codex from `~/.codex/config.toml`; Grok and Pi from whatever they support. The
tool gate of `permissions/provider-runtime` checks every call by name, but a
name is only as good as the configuration that chose it: a second server could
take a granted name, and Codex calls reached no Ravi decision at all. Choosing
which servers exist has to belong to Ravi, so a grant names something Ravi
registered.

## Names without underscores

A grant is a prefix on the tool name (`use:tool:mcp__github__*`). With
underscores allowed, a server `github__admin` would sit under that prefix.
Forbidding underscores in registered names closes this without changing the
grant grammar.

## Forwarding servers are not host servers

The `spec` server is exempt from the tool check because the agent setting that
attaches it is the grant and it runs inside Ravi. A facade forwards to a server
outside Ravi, so it gets the name check like any other tool, and its name is
kept apart from the host list. Mixing them would exempt every remote tool.

## One authorization function

Lists, calls, late task input, elicitation, skill reads and uploads are six
ways to reach the same server with the same credential. One function with one
order of checks gives one place to audit, one denial record shape, and the
same answer on every runtime.

## Operator audience by default

There is one credential per server and it is the operator's. A turn from
another person acting with that credential is acting as the operator, so
servers start as `operator` audience and widening is braked. On the legacy
protocol a server may let the model confirm its own writes with a token, with
nobody asked; legacy credentialed rows therefore stay operator-only even after
being widened. A stdio server started with the operator's stored env values (a
token in `GITHUB_TOKEN`, say) holds that credential just as a login does, so
it counts the same; a stdio server with no stored values holds none.

## The CLI pair for Pi, Codex and Grok

Native per-tool lists on those runtimes would need a new listener in the
daemon and rest on runtime behaviour nobody could verify. The CLI pair reuses
the CLI gateway, `enforceCliCommandAccess` and the rule that Codex runs Ravi
operations through its shell. The model pays one extra step and sees text and
structured content only.

## Elicitation only to the credential holder

A Console write confirmation is an accepted form. If anyone in a group could
answer it, the confirmation would no longer mean the operator agreed. Asking
only the person who holds the credential, on a private surface, keeps the
confirmation bound to the operator; automations and unknown speakers decline.

## Hand-written raw dispatch

SDK 2.4.0 has no tasks or files runtime and its client rejects `task` and
`upload_required` results even with a passthrough schema. The pre-1.0 tasks
extension package needs a newer zod and still needs a raw dispatch. A small
hand-written dispatch, used only for servers that declare those extensions,
is less code to trust.

Both call paths share one `input_required` loop. Two loops would drift, and a
Console write on the raw path would then be confirmed under other rules than
the same write on the SDK path.

A `tasks/cancel` acknowledgement is read as "asked", not "stopped": the
Console acknowledges a cancel that arrives after a publish committed, and that
task still completes. Reading the task once more is the only honest record.

A 429 says nothing ran, but a `tools/call` is still never resent by the
dispatch: the caller owns the back-off, and a resend after an unknown outcome
could apply a write twice.

## No skill fetch at pin time

The skills extension says hosts must not fetch files ahead of need, not on
connect, listing or approval. A pin binds to the manifest digest; the content
is fetched and verified when the model reads it.

The pin's dry run still reads the one manifest (`skills/get`): the plan an
operator approves is that manifest, and `--digest` lets `--execute` refuse a
manifest that changed in between. No file is read either way.

## Remote skills as stubs in the Library plugin

A pinned remote skill rides the plugin and the per-turn gate the Library
already has, so one decision says who may load a skill whatever its source.
The stub carries only the approved name and description and the read command:
remote instructions reach the model when it asks, after the gate, the pin and
the digest, and never sit in a skills directory where a runtime would load
them without those checks. Each read asks the server for the manifest again,
so a skill the server changed or withdrew stops at the next read, and the
cache, named by digest and re-checked on every access, never serves bytes the
approval did not cover.

Pins sit in their own table because a Console sync replaces `library_pins`
wholesale; plugin names are unique on the installation because some runtimes
share one skills directory between agents.

## URLs kept out of the database

A Console bridge URL embeds its token. Storing only a display form in
`ravi.db` keeps that token out of every listing, trace and error.

## The gateway spawns its own stdio children

The SDK's `StdioClientTransport` merges the daemon's HOME, LOGNAME, SHELL,
TERM and USER into every child's environment, whatever environment it is
given. A registered server is meant to see PATH and the keys the operator
declared for it, nothing else, so the gateway spawns the child itself
(`src/mcp/stdio-transport.ts`). A custom transport also makes the SDK probe
on the child itself instead of spawning a second, short-lived sibling on
every `auto` connect. The child gets its own process group so that a
launcher such as `npx` cannot leave the real server running after the
connection closes, and its stderr is discarded because a server may print
the values it was given.

## Era verdicts with a date

A stored legacy verdict is silently wrong forever once the server upgrades
(the SDK says freshness is the host's job), so the verdict carries the time
it was decided and an HTTP legacy verdict is trusted for 24 hours. A stale
modern verdict fails loudly instead, so the gateway reacts to the failure: it
negotiates again, and it never resends a call whose outcome it could not
read.

## Background calls are delivered, not awaited

A long tool call (a cloud run, a publish) would otherwise hold the turn until
a timeout that says only "outcome unknown", and the model would be tempted to
call the tool again. Detaching hands the model a handle and delivers the
outcome later through the same durable session queue as other background
work, so the session wakes even when idle and a delivery repeated by a retry
is one turn. The delivery runs as its own automation principal because the
origin turn has ended: carrying the origin person's or the operator's
authority into a later, unattended turn would let remote text drive actions
nobody is present to confirm. For the same reason a late question is asked
only while the origin turn still names that person, and a cancel
acknowledgement is checked with one more read instead of being believed.

