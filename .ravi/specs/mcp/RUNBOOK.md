# MCP Servers / RUNBOOK

Live checks for the runtime facts this domain rests on, and the operational
steps. Run live checks on a development machine or container with isolated
state (`RAVI_STATE_DIR="$(mktemp -d)"`), a separate NATS, and no production
credentials. Never start, restart or stop the installed daemon for them.
Record the runtime version, the date and the result in the pull request that
relies on the fact, and in `WHY.md` when the result changes a rule.

## Live check: Claude Code loads only declared servers

Fact: `strictMcpConfig: true`, `skipMcpDiscovery: true` on every plugin and
`settings.disableClaudeAiConnectors: true` leave `system/init.mcp_servers`
equal to the servers Ravi declared.

1. In a scratch cwd, write a project `.mcp.json` with one stdio server
   (for example a script that serves one `echo` tool), and a plugin directory
   whose `.mcp.json` declares another.
2. Add a user-level server to the scratch HOME's Claude settings.
3. Start an Agent SDK `query()` with the three settings, the plugin, one
   in-process server named `probe`, model `haiku`, a temp HOME,
   `IS_SANDBOX=1` and the OAuth token passed as `CLAUDE_CODE_OAUTH_TOKEN`.
4. Read the `system/init` message: `mcp_servers` must list `probe` only.
5. Ask the model to call each configured server's tool by full name: each
   attempt must fail as unknown, and no configured server process may start
   (check with `ps` or a marker file the script writes on start).
6. Repeat with a managed-settings file that declares a server, and record
   whether it appears. If it does, the init check fails the turn by design;
   note the result.

Recorded result, Claude Code 2.1.323 (Agent SDK 0.3.323), 2026-11-25, steps 1
to 4 and 6, setting sources `user`, `project` and `local`:

- Without the three settings, `system/init.mcp_servers` listed the user,
  project and local servers (sources `user`, `project`, `local`, status
  `pending`) beside the in-process one (`sdk`, `connected`). The plugin's
  `.mcp.json` server did not appear even then.
- With them, it listed the in-process server only.
- With `/etc/claude-code/managed-mcp.json` present, Claude Code refused to
  start with `--strict-mcp-config` ("You cannot use --strict-mcp-config when an
  enterprise MCP config is present"); without the strict flag the managed
  server is listed with source `enterprise`. Ravi's Claude sessions therefore
  cannot run on such a host, which fails closed.
- The SDK passes the settings as `--strict-mcp-config`,
  `--plugin-dir-no-mcp=<path>` and `--settings '{"disableClaudeAiConnectors":true}'`.
  Step 5 and the worker-host check were not run.

## Live check: a forwarding facade on Claude Code

Fact: a v1 `McpServer` whose tools are served by low-level `tools/list` and
`tools/call` handlers works as `{type:'sdk', name, instance}`, and its calls
reach PreToolUse with `mcp_server: {name, source:'sdk'}`.

1. Build one facade with one tool that returns a fixed marker string.
2. Run a `query()` as above with the facade declared and a PreToolUse hook that
   logs `tool_name` and `mcp_server`.
3. Ask the model to call `mcp__<facade>__<tool>` (it may first need
   `ToolSearch`). The hook must log `source: "sdk"` and the facade name; the
   reply must hold the marker.
4. Remote spawn: repeat with the agent's remote spawn over SSH and over NATS
   (the in-process server is carried over the control channel). The call must
   reach the local facade, and `--strict-mcp-config` must be on the remote
   command line. Record the Claude Code version on the worker; a worker too old
   to honour `--strict-mcp-config` fails the init check, which is the intended
   result.

Recorded result, Claude Code 2.1.323 (Agent SDK 0.3.323), 2026-11-25, steps 1
to 3, local only, with a facade built by `buildGatewayMcpServers` (server
`probe-remote`, one tool, a stub gateway) and `strictMcpConfig` plus
`disableClaudeAiConnectors`:

- `system/init.mcp_servers` listed `probe-remote` only, status `connected`,
  source `sdk`.
- The model loaded the tool through `ToolSearch` first; the PreToolUse hook
  then saw `mcp__probe-remote__marker` with
  `mcp_server: {name: "probe-remote", source: "sdk"}`.
- The facade handed the call to the gateway as tool `marker`, surface
  `claude`, budget 240000 ms, and the reply held the marker text.
- Step 4 (remote spawn over SSH and NATS) was not run: no worker host was
  available. It remains open.

## Live check: Codex launch overrides

Fact: `-c mcp_servers.<key>.enabled=false` disables each server, and
`-c mcp_servers={}` does not clear the table.

1. Make a scratch `CODEX_HOME` with `config.toml` holding two `[mcp_servers.*]`
   entries (one with a key that needs quoting, such as `"my.server"`) and a
   trusted project with `<cwd>/.codex/config.toml` holding a third.
2. Start `codex app-server` with the arguments Ravi builds (the overrides plus
   the apps/connectors switch) and call `thread/start`, then
   `mcpServerStatus/list` with the thread id.
3. Every entry must be `runtimeStatus: "disabled"` with no tools. Repeat with
   only `-c mcp_servers={}` and record whether the servers stay (expected:
   they stay).
4. Enable a plugin that brings its own MCP server and record whether the
   overrides cover it. If not, the status check fails the session closed;
   note the result.
5. Record the exact configuration key that turns apps/connectors off for the
   Codex version under test (`codex features list`).

Result on Codex 0.172.0 (2026-11-25, scratch `CODEX_HOME`, no login):
- `-c mcp_servers={}` leaves every server listed and starting.
- `-c mcp_servers.<key>.enabled=false` leaves the server listed with
  `runtimeStatus: "disabled"` and an empty tool list; the list is not empty.
- The `-c` key path is split on every dot and quotes are not read:
  `-c 'mcp_servers."my.server".enabled=false'` and even
  `-c 'mcp_servers."foo".enabled=false'` make Codex exit with
  `invalid transport in mcp_servers."...`. Ravi refuses such keys before
  launch.
- An override for a key that no loaded layer defines makes Codex exit with
  `invalid transport`. An untrusted project layer is not loaded, so its keys
  must not be overridden.
- Project layers: with a git root, every folder from the root to the cwd is a
  layer, trusted by its own `projects` entry or else the root's; an explicit
  `untrusted` entry on a subfolder wins. Without a git root, only the cwd is a
  layer and an ancestor's trust is not inherited.
- `mcpServerStatus/list` without `threadId` reloads the configuration without
  the project layers and answers `-32603 failed to reload config: invalid
  transport` when a project key is overridden; with `threadId` it answers.
- Overriding `command` on a URL server makes Codex drop the whole
  configuration ("Invalid configuration; using defaults"); Ravi only sets
  `enabled`.
- Apps switch: `features.apps=false` (`codex features list` shows `apps`
  stable, true by default, false with the override).
- Not checked: plugin-provided servers (step 4) and the apps server of a
  signed-in account; the status check covers both by failing closed.

## Live check: Grok configuration

Fact: `grok agent stdio` with `mcpServers: []` on `session/new` and
`--deny MCPTool` loads no MCP server of its own.

1. Put an MCP server in every Grok configuration location the installed
   version documents (user and project).
2. Start a session the way Ravi does and ask the model to use that server.
3. No `session/request_permission` for MCPTool may be allowed (Ravi refuses
   the class), and the server process must not start. Record whether Grok
   started it despite the empty list.

Result (2026-11-25): not run. The Grok Build CLI binary
(`@xai-official/grok` 1.0.92 on npm) was not executed in the development
session. Ravi does not rely on it: MCPTool is denied at spawn and refused at
every permission request, and `.grok` writes need an executable or admin
grant.

## Live check: Pi has no native MCP loader

1. Check the installed `pi-coding-agent` version for any MCP configuration file
   or extension directory it reads on start.
2. If one exists, place a server there, start a Ravi Pi session and confirm the
   gate denies every `mcp__*` tool name.

Result (2026-11-25, `@mariozechner/pi-coding-agent` 0.73.1, package read, not
run): the README states "No MCP" and that MCP support comes only from an
extension; no file in the package other than a vendored syntax highlighter
mentions MCP. An extension that adds MCP tools is the remaining path: its tool
names start with `mcp__` by convention and the gate denies them, and `.pi`
writes need an executable or admin grant. A tool such an extension registers
under another name is checked like any other Pi tool, as `use:tool:<name>`.

## Live check: modern response framing

Fact: a real `2026-07-28` server answers the raw dispatch with plain JSON or
with SSE, and the dispatch takes the first message with the request id.

1. Against the Console MCP Worker on its development deployment (deploy the
   Worker first, then register it), send `tools/list` through the raw dispatch
   with `accept: application/json, text/event-stream`.
2. Record the response content type, and repeat for a `tools/call` that returns
   a task and for `tasks/get`.

## Live check: the elicitation modal on Slack

Fact: Slack opens the modal this flow builds, returns its values in the shapes
`handleMcpElicitationEnvelope` reads, and accepts the answers it sends back
(`response_action: errors` per block, `response_action: update`,
`view_closed` with `notify_on_close`).

1. On a development workspace, with `ravi channels start` for that workspace,
   register a stdio fixture server whose tool asks a form with one string, one
   integer, one boolean and one enum field, and attach it to an agent the
   operator talks to in Slack.
2. From the operator's own Slack turn, call the tool. Only the operator must
   see the card; another member in the same conversation must see nothing.
3. Press the button: the modal must open with four inputs in the planned
   order. Submit an out-of-range number and confirm Slack shows the error
   under that field and the request stays open
   (`SELECT status FROM mcp_elicitation_requests`).
4. Submit valid answers: the modal must be replaced by "Resposta enviada", the
   row must read `answered`, and the server must receive exactly those values.
5. Call again and close the modal with Recusar: the call must answer `decline`
   and the row must read `declined`.
6. Call again and leave the card untouched past the call's budget: the call
   must answer `cancel`, the row must read `expired`, and a late press of the
   button must open nothing.
7. Repeat step 2 from a thread, and from a contact's turn on a server with no
   credential, and confirm the card lands in the thread and goes to that
   person only.

Not run yet: no development Slack workspace was available for the pull request
that added the modal. The Block Kit shapes above come from the Slack
documentation, and the handler is covered by
`src/channels/slack/mcp-elicitation.test.ts` against hand-written payloads.

## Operate: a server shows `needs_login`

```bash
ravi mcp show <name> --json
ravi mcp login <name> --execute
```

`login` runs only from the operator's terminal. Over SSH without a browser,
use `--paste` and open the printed URL locally; the browser then ends on
`http://127.0.0.1:33418/callback?...`, which does not load: paste that whole
URL back. If port 33418 is taken, pick another with `--port`; the client then
registers again for the new redirect. A bearer server takes its token on
stdin: `ravi mcp login <name> --token-stdin --execute < token.txt`. The daemon
picks up the new credential on its own (the login moves the credential
revision); no restart. A server that asks for a wider scope (step-up) also
shows `needs_login`: log in again.

A login that hangs on "credentials are locked by another process" waits for a
token refresh in the daemon; a lock left by a dead process is broken
automatically, and one older than 2 minutes too.

## Operate: a background call's result has not arrived

```bash
ravi mcp calls list --state open --json
ravi mcp show <name> --json
ravi mcp calls cancel <id> --json
```

`state: task` with a `taskStatus` of `working` is still being followed;
`lastError` says why a poll failed (a login, a rate limit) and `show` gives
the last HTTP 429 and until when Ravi waits. A row in `delivering` waits for
the session queue; `failed` means the queue refused every retry (check NATS
with `ravi daemon status`). The result is never re-sent and the tool is never
called again by Ravi: after `failed` or `lost`, ask the person whether to run
it again. A cancel is recorded at once and acted on at the follower's next
tick; its outcome arrives in the session like any other.

## Operate: a tool is denied

1. In the agent's turn,
   `ravi permissions check --permission use --object-type tool --object-id mcp__<server>__<tool> --json`
   tells whether the capability is missing; `ravi mcp show <name> --json`
   tells whether the server is enabled, attached and logged in.
2. The denial record's `detail.mcpServer.source` says who reported it:
   `gateway` for Ravi's own check; anything else on Claude Code means the
   runtime loaded a server Ravi did not register.
3. For a server loaded outside Ravi, register it with `ravi mcp import`
   (dry run first) and remove it from the runtime's configuration.

## Operate: a Claude turn fails on an undeclared server

The error names the server and the source the runtime reported. Find the file
that declares it (managed settings, a plugin, a connector) and remove it, or
register it with `ravi mcp import`. Do not turn the check off.

When every Claude query fails at start with "You cannot use
--strict-mcp-config when an enterprise MCP config is present", the host has an
enterprise `managed-mcp.json`. Ravi does not run Claude sessions there; remove
that file on the host or move the agent to another runtime. Claude Code reads
it at `/Library/Application Support/ClaudeCode/managed-mcp.json` on macOS,
`C:\Program Files\ClaudeCode\managed-mcp.json` on Windows and
`/etc/claude-code/managed-mcp.json` on Linux and WSL; `ravi doctor` checks
the path of the host's platform.

## Operate: migrate servers a runtime loaded on its own

```bash
ravi doctor --domain mcp --json
ravi mcp import --json
ravi mcp import --as <native>=<name> --skip <native> --execute
```

1. `ravi doctor --domain mcp` lists the native entries that no longer load.
2. `ravi mcp import` (dry run) shows each server it would register, the agents
   and the secrets that move by name, and the `grant` block: the capability
   under the registered name, the former names, `grantsChanged: false`, and
   for each agent whose ceiling lacks it the exact
   `ravi agents permissions <agent> --capabilities '...' --execute` command
   (a `chat-only` agent gets a note instead). Import never changes a grant;
   run the commands you accept. Agents on the default profile need none.
3. Resolve every conflict with `--as` (`<source kind>:<native>=<name>` when two
   sources share a name) or `--skip`, then rerun with `--execute`.
4. Entries listed as not imported (headers, bearer variables, `${...}`
   expansion, a working directory) are registered by hand with `ravi mcp add`.
5. The source files are left as they are. Claude Code entries and Codex
   entries with a bare key (`^[A-Za-z0-9_-]+$`) may stay: Ravi turns them off
   at each launch. A Codex `[mcp_servers]` key that is not bare (a dot, or a
   key that needs quotes) cannot be turned off, and every Codex session on the
   host refuses to start, even after the import registered the server, until
   the entry is deleted by hand from `$CODEX_HOME/config.toml` (default
   `~/.codex`) or the trusted project's `.codex/config.toml`. The session
   fails with:

   ```text
   Codex MCP server "my.server" in /home/you/.codex/config.toml cannot be turned off at launch (Codex overrides take bare keys only), so the session was not started. Codex reaches MCP servers only through Ravi: register the server with `ravi mcp import` (or `ravi mcp add`) and remove it from the Codex configuration.
   ```

   `ravi doctor` (`mcp.native_unregistered`) warns about such an entry by
   file and key, and says it must be removed, whether or not the import
   registered it. It reads the files the launch reads for each Codex agent
   (`/etc/codex/config.toml`, `/etc/codex/managed_config.toml`,
   `$CODEX_HOME/config.toml` and the trusted project layers from the project
   root down to the cwd), so an untrusted project's file is not reported.

## Operate: pin a remote skill of a server

```bash
ravi mcp skills list <server> --json
ravi mcp skills pin <server> <id> --agent <agent> --json
ravi mcp skills pin <server> <id> --agent <agent> --digest <manifestDigest> --execute
ravi mcp skills read <id> --agent <agent> --json
```

1. `skills list` shows each skill's id, file count and pins; a skill whose
   files are `dynamic` cannot be pinned.
2. The dry run of `pin` prints the plan with the manifest digest; pass it as
   `--digest` so `--execute` pins exactly that manifest. Add `--external` only
   when the skill may serve other people's turns.
3. A pin reported `stale` (the server changed the skill, its bytes missed the
   manifest, or it is gone) is not read until it is pinned again after a new
   review. `ravi mcp skills unpin <id> --agent <agent>` removes it at once.

## Operate: a file upload is refused

```bash
ravi mcp show <server> --json
ravi mcp set <server> --uploads on --agent <agent> --execute
```

1. `show` lists `uploadCatalog`: the tools an attachment with uploads on
   sees, with their file arguments. `null` means the server does not offer
   uploads, is not a modern HTTP server, or its files listing failed (the
   next refresh tries again).
2. `MCP_FILE_REFUSED` names the gate: `uploads_off` (turn uploads on for that
   agent), `remote_agent` (never possible), `server_kind`, or a gate A code
   such as `outside_workspace`, `provider_config`, `state_dir`, `hard_link`,
   `too_large`, `artifact_handle`. Nothing was sent to the server.
3. A refused or failed upload ran nothing on the server: call the tool again.
   A failure after the upload, when the call was sent once more, has an
   unknown outcome: check on the server before calling again.

## Operate: turn MCP off, or go back

There is deliberately no switch that turns the MCP client off as a whole or
lets runtimes load their own servers again. The controls are:

```bash
ravi mcp disable <server>
ravi mcp detach <server> <agent>
ravi update --rollback
```

1. `disable` stops a server for every agent at once; `detach` takes it from one
   agent. Both apply at once and keep the registration and its secret.
2. `ravi mcp remove <server>` also deletes the stored address, environment
   values and login at once. They cannot be shown again: keep a copy of a
   bridge URL elsewhere before removing it.
3. If the checks misfire on a host, `ravi update --rollback` (a dry run; add
   `--execute`) goes back to the release before the last update, with its
   state as of that update's snapshot.

## Operate: facts an operator asks about

- On the default profile, `ravi mcp attach` gives the agent every tool of the
  server at once (`use:tool:*` is in the floor); a per-tool grant narrows only
  `explicit-only` agents.
- The daemon looks for due catalog refreshes every 15 minutes
  (`MCP_REFRESH_TICK_MS`), so a server's shorter freshness time is honoured at
  the next tick.
- `ravi mcp call` needs the running daemon even for a dry run
  (`MCP_DAEMON_REQUIRED`, exit 1).
- On Claude, reading a pinned remote skill needs the shell tool: the stub
  names `ravi mcp skills read`.
- Cancelling a publish almost never stops it (the Console commits within
  milliseconds); cancelling a cloud run only stops following it.
- One file is at most 25 MB. Uploads need a storage host name that resolves
  only to public addresses with a publicly trusted certificate.
- With uploads on, a turn that may read files can send any regular file under
  the system temp directories (`os.tmpdir()`, `/tmp`, `/private/tmp`) as well
  as its workspace.
