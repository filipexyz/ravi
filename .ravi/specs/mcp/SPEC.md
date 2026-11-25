---
id: mcp
title: "MCP Servers"
kind: domain
domain: mcp
capabilities:
  - registry
  - authorization
  - gateway
  - elicitation
  - tasks
  - skills
  - files
tags:
  - mcp
  - permissions
  - runtime
  - security
applies_to:
  - src/mcp
  - src/daemon.ts
  - src/cli/commands/mcp.ts
  - src/router/router-db.ts
  - src/runtime/runtime-host-attachments.ts
  - src/runtime/claude-provider.ts
  - src/runtime/codex-provider.ts
  - src/runtime/codex-mcp-isolation.ts
  - src/runtime/grok-provider.ts
  - src/runtime/pi-tool-permissions.ts
  - src/runtime/tool-liveness.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/delivery-queue.ts
  - src/runtime/daemon-restart-resume.ts
  - src/runtime/message-types.ts
  - src/knowledge/turn/audience.ts
  - src/permissions/runtime-bootstrap-provider.ts
  - src/bash/hook.ts
  - src/library/session-plugins.ts
  - src/library/pins.ts
  - src/library/pins-db.ts
  - src/library/plugin.ts
  - src/library/refs.ts
  - src/approval
  - src/channels/slack/mcp-elicitation.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# MCP Servers

## Intent

Ravi decides which MCP servers an agent can reach. A server is usable only when
it is registered in Ravi, attached to the agent, and allowed for the turn by
the same capability check every other tool passes. Runtimes do not load MCP
servers from their own configuration.

Ravi is an MCP client of revision `2026-07-28` and of the legacy revision. One
gateway inside the daemon holds the connections. Claude Code reaches it
through in-process forwarding servers; Pi, Codex and Grok reach it through the
CLI pair `ravi mcp tools` and `ravi mcp call`.

The rules in this spec are written before the code (spec first). Each rule
names the check in `CHECKS.md` that proves it; a rule without a passing check
is not yet shipped behaviour.

## Registry

- Registered servers MUST live in `ravi.db`, in tables created by the lazy-init
  block of `src/router/router-db.ts` (opened through `openStateDatabase`). No
  other database file and no other listener is added for MCP.
- `mcp_servers` holds one row per server: `name` (primary key), `transport`
  (`http` or `stdio`), the display URL, `url_secret` (1 when the full URL
  carries a secret: a token-like segment, user info, a query or a fragment),
  `command`, `args_json`,
  `env_keys_json` (names only), `auth_kind` (`none`, `bearer`, `oauth`),
  `credential_rev`, `protocol` (`auto`, `2026-07-28`, `legacy`; default
  `auto`), `enabled`, `origin` (`manual` or `import:<path>`), `status`
  (`unknown`, `ok`, `needs_login`, `error`), `status_detail`, `era`
  (`modern`, `legacy`), `discover_json` (the era verdict, Gateway),
  `extensions_json`, `catalog_json`,
  `catalog_fingerprint`, `files_catalog_json`, `catalog_expires_at` (when
  the listed catalog stops being fresh, Gateway), `checked_at`, `created_by`, `created_at`,
  `updated_at`.
- `mcp_agent_servers(agent_id, server, audience, uploads, created_by,
  created_at)` attaches a server to an agent. `audience` is `operator` by
  default; `uploads` is 0 by default. A server with no attachment row is
  reachable by no agent. Removing a server removes its attachments; deleting an
  agent removes the agent's attachments, so a new agent with the same id
  reaches no server.
- Every write to either table MUST emit `ravi.config.changed` with
  `reason: "mcp_servers"`, the names of the changed servers in `servers`, and
  `change`: `config` for a registration or attachment change, `status` for the
  daemon's own status, era and catalog cache. On `config` the daemon drops its
  connections to those servers and refreshes status, era, extensions and
  catalog; `status` needs no refresh, so the cache write cannot loop. A write
  that changes no row emits nothing. A write needs no restart.
- An unknown stored `audience` is read as `operator`, an unknown stored
  `auth_kind` as credentialed, and any stored `url_secret` other than 0 as a
  secret URL: a damaged row never widens access. A catalog
  that does not parse is no catalog.
- The CLI process only reads these tables, except for writes made by `ravi mcp`
  management commands and by `ravi mcp login`.

## Names

- A server name MUST match `^[a-z][a-z0-9-]{0,23}$`. Names hold no underscore,
  so a grant on the prefix `mcp__<a>__` can never reach a server whose name
  is `<a>__<b>` (`permissions/provider-runtime`, Runtime Tool Calls).
- `ravi` and every name Ravi uses for an in-process host server (today `spec`,
  `SPEC_MCP_SERVER_NAME`) are reserved. The list MUST come from one export of
  `src/runtime/runtime-host-attachments.ts`, so a new host server is reserved
  by the same change that adds it.
- A remote tool is exposed as `mcp__<server>__<tool>` only when the tool name
  matches `^[A-Za-z0-9_-]{1,64}$` and the full name is at most 64 characters.
  Any other tool is dropped from every exposure and listed by `ravi mcp show`
  with the reason. A dropped tool MUST NOT be renamed, aliased or truncated.
- Tool order is stable: the catalog is sorted by exposed name.

## Secrets And Display Forms

- Secrets MUST live in the credentials store (`src/credentials/backends.ts`),
  provider `mcp`, one entry per server (connection = server name): OAuth
  tokens and client information, the bearer token, stdio environment values,
  and the full server URL. The entry holds one JSON document
  (`src/mcp/secrets.ts`); every http server stores its full URL there, with
  or without a token in it, so the gateway reads the URL from one place.
- A server URL can carry a secret (a bridge URL may embed a token). `ravi.db`
  MUST keep only a display form: the origin plus the path, with every path
  segment that holds a run of 16 or more characters from `[A-Za-z0-9_-]` (raw
  or percent-decoded) replaced by `…`, and no user info, query string or
  fragment.
- A server URL MUST use https; plain http is accepted only on a loopback host
  (`127.0.0.1`, `[::1]`, `localhost`). A URL error never repeats the URL. `list`, `show`, `--json` output, the trace,
  errors and `import` MUST print only the display form.
- Secret values MUST NOT reach argv, a process environment other than the stdio
  child's own declared keys, `ravi.db`, a log, a trace, JSON output, a
  remote-spawn host or the model.
- `ravi mcp add` MUST refuse a secret value given inline on the command line
  (exit 2, `INLINE_SECRET`): `--env KEY=value`; a `--url` whose display form
  hides or drops anything (an elided segment, user info, a query or a
  fragment), which is read with `--url-stdin` instead; and a stdio `--arg`
  that sets a secret-named flag or variable (token, secret, password, api key,
  bearer, credential, private key) or is a URL that carries a secret.
- Environment values are read from stdin as `KEY=value` lines (blank lines and
  `#` comments skipped); every `--env` key needs exactly one non-empty value
  and stdin may set no other key. stdin is read and validated in the dry run
  as well, so a dry run that passes is one `--execute` can carry out: the plan
  shows the display URL and the names of the values read (`url`, `env <KEY>`),
  never a value, and stores nothing. stdin is refused (exit 2) where the
  daemon's gateway runs the command, since only the operator's own terminal
  has it. Errors never repeat a value.

## Management CLI

Every `ravi mcp` command has `@CommandAccess`, `--json`, and the exit codes of
`.ravi/specs/cli/SPEC.md`.

- Braked (dry run and exit 3 without `--execute`), and refused unless
  `resolveOperatorTurn` (`src/link/connector-turn.ts`) passes (exit 3,
  `OPERATOR_TURN_REQUIRED`, whatever `--execute` says; a classifier that throws
  refuses too):
  - `add <name> (--url <https-url> | --url-stdin | --command <cmd> [--arg ..] [--env KEY ..]) [--auth none|bearer|oauth] [--protocol <mode>] [--agent <id> ..]`;
  - `attach <name> <agent>` (always audience `operator`, uploads off);
  - `enable <name>`, since it gives a disabled server back to its agents;
  - `set <name> --audience any`, `set <name> --uploads on --agent <id>`,
    `set <name> --protocol <mode>`;
  - `import`, `login`, `skills pin`.
- `call` is braked too (an external effect; its dry run prints server, tool
  and the argument keys, never values), but it is not an operator-only
  command: who may call is decided by `authorizeMcpUse` (Authorization), so a
  server widened to `any` serves other people's turns on every runtime alike
  (CLI Pair).
- Immediate, because they only reduce authority: `detach`,
  `set --audience operator`, `set --uploads off`, `disable`, `remove`,
  `logout`, `skills unpin`, `calls cancel`. They need no operator turn.
  `remove` deletes the row and its attachments first (from then on no agent
  reaches the server), then the server's secrets, and reports a secret it
  could not delete; it also asks the server's open background calls to end
  (the follower discards their results; `tasks/cancel` is not sent, as the
  registration and its login are gone) and drops its skill pins for every
  agent (Background Calls, Remote Skills). `detach` drops that agent's pins of
  the server. Both report `skillPinsDropped` and rebuild the Library plugin
  when a pin went.
- `calls list [--state open|<state>] [--server s] [--session s]` and
  `calls cancel <id>`: the operator's own turn and the terminal see and
  cancel every call. Any other turn sees and cancels only the calls of its
  own agent and session whose server and tool that turn may use now
  (`authorizeMcpUse`, surface `list`: the audience check and the tool grant;
  a call that waits only for a login stays visible), plus, on a delivery turn
  (principal `automation:mcp-call:<id>`), its own call. Anything else is
  `MCP_CALL_NOT_FOUND` (exit 1) for `cancel` and absent from `list`; a turn
  with no agent or session is refused (`OPERATOR_TURN_REQUIRED`, exit 3).
  These checks run where the command runs, in the daemon for a turn. The
  listing never shows a result, arguments or the origin person.
- A `set` that both widens and narrows is braked as a whole; a `set` or
  `attach` that changes nothing applies nothing and is not braked.
  `set --audience` without `--agent` changes every attachment of the server;
  `--uploads on` needs `--agent`, and is refused for a stdio server (uploads
  exist only for http servers). A `set --protocol` change forgets the probed
  era and status, as any change of registration does.
- Every validation (name, URL, values, agents, duplicates, a stdio server on a
  remote agent) runs before the operator check and the brake, so a dry run
  shows only a plan that `--execute` can carry out.
- `add` and `import` write the row before the secret: the insert itself claims
  the name, so of two concurrent registrations of one name exactly one wins
  and the other fails (`already_registered`) without writing, replacing or
  deleting the winner's secret. When the secret cannot be stored, the command
  removes the row it has just written. Storing the secret then moves the
  row's credential revision, which emits a `config` change.
- Reads: `list`, `show <name>`, `tools [server] [--query q]`, `calls list`,
  `skills list <server>`, `skills read <id> [--file p]`. `skills list` reads
  the organization's catalog through the operator's login, so it is for the
  operator's own turn only (`OPERATOR_TURN_REQUIRED`, exit 3, before anything
  is sent; Remote Skills).
- `login` and `import` are CLI-only: they use host paths and the operator's
  browser, and are absent from the HTTP gateway and the generated SDKs.
- A dry run MUST NOT connect to a server, with one exception: the dry run of
  `skills pin` reads that one skill's manifest (`skills/get`, never a file),
  because the plan it prints is that manifest and its digest (Remote Skills).
- Registering, attaching or enabling a `stdio` server needs the superadmin
  scope (`admin` on `system:*`; `PERMISSION_DENIED`, exit 1), since its
  command runs as the daemon's user outside any agent sandbox. The operator's
  relay without that scope can register http servers only.
- A `stdio` server MUST NOT be attached to an agent with `remote` set (code
  `remote_spawn_stdio`).
- `set --audience any` MUST be refused for a legacy credentialed row (see
  Authorization, check 4; `AUDIENCE_LEGACY`, exit 3), judged on the row as it
  will be after the command: pinning `2026-07-28` in the same command counts
  (the pin forgets the probed era, and the gateway then speaks only the modern
  revision to that row).
- `list` and `show` print the display URL, the env key names, the
  attachments, status, era, extension names, exposed and dropped tools,
  and whether a secret is stored; never a secret value, the full URL or a
  secret reference. `show` also reports the login state (`login`):
  `not_needed` (stdio or `auth none`), `logged_in` with `loginExpiresAt` (the
  access token's expiry, epoch ms, null when none is known) and
  `loginRenews` (a refresh token is stored), `needs_login` (the row is
  `needs_login` or nothing is stored), or `unknown` (the credentials store
  cannot be read); never the token. `list` pages with `--limit`/`--offset` and filters by
  `--agent`. `show` also reports the server's open background calls and the
  last HTTP 429 it answered (when, until when, on which method), every
  remote skill pinned from it with its state and stale reason (`skills`:
  agent, id, plugin name, `state`, `staleReason`, `externalAllowed`), the catalog an attachment with uploads
  sees (`uploadCatalog`: tools with their file argument names, and dropped
  tools) and `warnings` (an attached agent on Claude whose materialized
  ceiling does not allow `use tool:ToolSearch`: a default agent holds it
  through the bootstrap floor; an `explicit-only` or `chat-only` agent
  without the grant does not). `attach` returns the same warning for its agent,
  in the dry run too.
- `set --uploads on` is refused for a remote-spawn agent
  (`REMOTE_SPAWN_UPLOADS`, exit 3).

## Import

`ravi mcp import [--agent <id> ..] [--as <old>=<new> ..] [--skip <name> ..] [--execute]`
moves the servers runtimes used to load from their own configuration into the
registry (`src/mcp/import.ts`).

- Sources, read and never written: `<agent cwd>/.mcp.json`; `~/.claude.json`
  user entries (`mcpServers`) and project entries (`projects[<agent
  cwd>].mcpServers`); `.mcp.json` and `plugin.json` `mcpServers` (inline, or a
  path inside the plugin) of each plugin under `~/ravi/plugins`;
  `$CODEX_HOME/config.toml` (default `~/.codex`) and
  `<agent cwd>/.codex/config.toml` (`[mcp_servers.<name>]`). A source that
  cannot be read or parsed is reported without quoting it. A Codex file is
  read the way the Codex isolation reads it (`runtime/providers/codex`): a
  BOM is dropped, and a file Bun's TOML parser rejects is scanned; the
  servers the scan names are listed (the doctor check counts them) as
  entries that cannot be imported, because their values were not read.
- Target agents: an entry goes only to the agents whose runtime loaded it, so
  the import moves what each runtime used and widens nothing. An agent's
  runtime is the provider its sessions start on (model preset, the agent's
  `provider`, then the global default); one that cannot be resolved loads no
  source. Claude Code files reach Claude agents only and Codex files Codex
  agents only; Pi and Grok agents load none. Within that:
  - `<cwd>/.mcp.json` reaches the Claude agents of that directory whose
    `settingSources` hold `project` (Ravi's default), unless Claude Code has
    the server disabled there: `disabledMcpjsonServers` in
    `<cwd>/.claude/settings.json`, or `disabledMcpServers` in `~/.claude.json`
    `projects[<cwd>]`. Approval lists do not gate a headless session: an
    unlisted server loads (Claude Code 2.1.323, live probe).
  - `~/.claude.json` user entries reach the Claude agents whose
    `settingSources` hold `user`, except an agent whose directory lists the
    server in `disabledMcpServers`.
  - Local-scope entries (`projects[<cwd>].mcpServers`) reach nobody: Claude
    Code does not load them in a Ravi session.
  - Plugin entries reach every Claude agent; `$CODEX_HOME/config.toml` every
    Codex agent; `<cwd>/.codex/config.toml` the Codex agents of that directory.
  An entry no agent loaded is never registered; the plan lists it as skipped
  with the reason. Without `--agent`, every agent without `remote` is
  considered (a remote agent loads its own host's files); `--agent` narrows
  the set and never gives an entry to an agent of another runtime. A stdio
  server for a named remote agent is refused (`REMOTE_SPAWN_STDIO`).
- Names: lower case, every character outside `[a-z0-9-]` (underscore
  included) becomes a hyphen, repeats collapse, edge hyphens go. A result
  outside the name grammar, or reserved, needs `--as`. Entries that end up with
  one name merge when their values are identical and otherwise collide
  (`IMPORT_CONFLICT`, exit 2) until `--as` or `--skip` separates them. `--as`
  and `--skip` take a native name, or `<source kind>:<native name>` when two
  sources share a native name; a name that matches no entry is a usage error.
- An entry identical to a registered server, secrets included, only attaches
  the missing agents to that server; a registered name with other values is a
  conflict. Running the import again changes nothing.
- Not imported, and listed with a reason that holds no value: the legacy SSE
  transport and other unknown transports, HTTP headers or a bearer token
  (Codex `bearer_token_env_var`, `http_headers`, `env_http_headers`), Codex
  `env_vars` and `cwd`, `${...}` expansion in a URL, command, argument or env
  value (`${CLAUDE_PLUGIN_ROOT}` in a plugin file is replaced by the plugin
  root), a URL that is not https (plain http only on loopback), and an argument
  that looks like a secret. A Codex tool filter is not kept (a note says so).
- The dry run (exit 3) prints, per server: the grant an agent needs to see
  its tools under the new name (`use:tool:mcp__<name>__*`, or a grant per
  tool), the former names (`mcp__<native>__*`) whose grants are not changed
  and do not match the new name, and for each target agent whose ceiling
  does not allow that grant the exact command that adds it
  (`ravi agents permissions <agent> --capabilities '<current explicit
  capabilities>,use:tool:mcp__<name>__*' --execute`; a `chat-only` agent gets
  a note instead, since its profile takes no capabilities); the `--execute`
  result reports the same. Then the agents it attaches, the
  arguments and env key names of a stdio server (what runs as the daemon's
  user; arguments were screened for inline secrets), and the secret values
  that move to the credentials store by name (`url`, `env <KEY>`), never their
  values. It connects to nothing.
- `--execute` registers each server with origin `import:<path>` of its first
  source, the native `enabled` state, its full URL or env values in the
  credentials store only, and attaches the target agents with audience
  `operator` and uploads off.
- It is braked and needs the operator's own turn; a stdio server in the plan
  needs `admin` on `system:*` (`PERMISSION_DENIED`). It is CLI-only: inside a
  session turn, in a process that carries a runtime marker (a session's, a
  trigger's, or a shell cron's, shell trigger's or job's principal) or under
  the gateway it answers `CLI_ONLY_COMMAND` (exit 2).
- `ravi doctor` check `mcp.native_unregistered` lists the native entries a
  runtime loaded that no registered server covers (`doctor/check-catalog`);
  an entry no runtime loaded is not listed, since it never ran. It matches by
  transport and address, not by native key. A Codex entry whose key the
  launch overrides cannot address (`isCodexOverridableMcpKey`,
  `runtime/providers/codex`: every Codex session refuses to start until it
  is deleted from the file) is a warning of its own that names the file and
  the key and says the entry must be removed, whether or not a registered
  server covers it; it reads the layers the launch reads for each Codex
  agent's directory (`collectCodexMcpConfigSources`: system, managed,
  `$CODEX_HOME`, trusted project layers), and names a file among them that
  the launch cannot use. It also warns when Claude Code's enterprise MCP
  configuration exists where Claude Code reads it on the host's platform
  (`/Library/Application Support/ClaudeCode/managed-mcp.json` on macOS,
  `C:\Program Files\ClaudeCode\managed-mcp.json` on Windows,
  `/etc/claude-code/managed-mcp.json` on Linux and WSL), quoting the refusal
  the RUNBOOK recorded (Claude Code refuses `--strict-mcp-config` while an
  enterprise MCP configuration is present).
- Once per daemon start, off the start path
  (`src/mcp/native-startup-warning.ts`), the same discovery writes one
  warning to the daemon log per configuration file that still declares
  servers no registered server covers, naming the file, the servers and the
  agents, and `ravi mcp import`: names and paths only, never a URL, a command
  line or a value. A discovery that fails is a debug line and never blocks
  the start. Nothing is sent to the operator and nothing is added to a
  prompt.

## Authorization

Every MCP surface passes one function, `authorizeMcpUse` in
`src/mcp/authorize.ts`:

```
authorizeMcpUse({ context, agentId, server, tool?, surface })
  surface: 'list' | 'call' | 'task-input' | 'elicitation' | 'skill' | 'upload'
  -> { allowed: true } | { allowed: false, code, reason }
```

The checks MUST run in this order, and the first failure decides:

1. No context record: `no_turn`. A revoked or expired record, or one issued
   for another agent, counts as no context.
2. The row exists (`not_registered`) and is enabled (`disabled`).
3. An attachment row for the agent exists: `not_attached`.
4. Audience. `any` passes. `operator` passes only when the turn is the
   operator's own turn, as decided by `isOperatorOwnTurn`
   (`src/library/turn.ts`), which is `resolveConnectorTurn(...).ok` and fails
   closed: `audience`. A legacy credentialed row passes only on the
   operator's own turn, whatever its audience says: `audience_legacy`. A row
   is credentialed when its `auth_kind` is `oauth` or `bearer`, or its stored
   URL carries a secret (`url_secret`; a bridge URL with a token in it is the
   operator's credential even with `auth_kind` `none`), or it declares one or
   more stdio env keys (their values sit in the credentials store and are the
   operator's; the values are not read for this). A stored key list that
   does not parse as key names is read as damaged (`(damaged)`), not as
   empty: it counts as credentialed, shows in `show`, and never connects. The one predicate is
   `mcpServerHoldsCredential` (`src/mcp/authorize.ts`); every "who holds the
   credential" decision uses it, never `auth_kind` alone. It is legacy
   credentialed when it is credentialed and it is, or may be, on the legacy
   leg: `protocol` is `legacy`, or `protocol` is
   `auto` and the era is not known to be `modern`, or the era is `legacy`.
5. For the tool surfaces (`list`, `call`, `task-input`, `elicitation`,
   `upload`), `use tool:mcp__<server>__<tool>`, decided by the same function
   the Claude tool hook uses (`canUseToolInContext`, `src/bash/hook.ts`):
   `capability`. A tool name that cannot be exposed (Names) is denied with
   the same code. `list` with no tool checks each tool of the cached catalog,
   with the exposed name recomputed from the tool name, and returns only the
   allowed ones; no allowed tool is `capability`.
6. `status` `needs_login`: `needs_login`, with the text
   `run ravi mcp login <name> --execute` (the login hint, Credentials And
   Login).

- The operator's own turn means, in code: the terminal and operator relays, the
  owner's own linked direct chat, heartbeat, and routines the operator owns.
  Any other speaker, and any speaker Ravi cannot classify, fails closed.
- A turn that delivers a background MCP result is an automation turn
  (`automation:mcp-call:<id>`), never an operator turn.
- Denials MUST be recorded through `recordAndEmitPermissionDenial` with
  `detail.mcpServer = { name, source: "gateway" }`, as the tool hook does. A
  `capability` denial is recorded as `use tool:mcp__<server>__<tool>`, so a
  grant of that tool resolves it; every other denial as
  `use mcp_server:<name>`, with the code and surface in the detail. The
  `list` surface is a filter of what a turn sees, not a use, and records no
  denial. A failure to record never turns a denial into an allow.
- A surface that is unknown, or a tool surface other than `list` without a
  tool name, is denied: `invalid_request`.
- `authorizeMcpUse` MUST run before any network call or child process start
  for that use, and again at call time even when the list was filtered by it.
- A thrown error inside `authorizeMcpUse` MUST become a denial (`error`; a
  throwing turn classifier answers `audience`).

## Registered-Only Loading Per Runtime

| Runtime | How registered servers reach the model | Native MCP of the runtime |
|---|---|---|
| Claude Code | In-process forwarding servers, one per listable attachment, tools named `mcp__<server>__<tool>` | Off: `strictMcpConfig`, `skipMcpDiscovery` per plugin, `disableClaudeAiConnectors`; the hook denies unregistered provenance; an undeclared server in `system/init` fails the turn |
| Pi | Dynamic tools `mcp_tools` / `mcp_call` (the CLI pair) | None; any `mcp__*` tool name is denied |
| Codex | `ravi mcp tools` / `ravi mcp call --execute` in its shell tool | Off: `-c mcp_servers.<key>.enabled=false` per key of every loaded layer, `-c features.apps=false`; a server in `mcpServerStatus/list` not reported disabled, a key `-c` cannot address, or an `item/mcpToolCall/*` event fails closed |
| Grok | `ravi mcp tools` / `ravi mcp call --execute` in its shell tool | Off: `mcpServers: []`, `--deny MCPTool`, `search_tool` and `use_tool` disallowed, the MCPTool class always refused |

- The per-runtime rules are normative in the provider specs:
  `runtime/providers/claude-code`, `runtime/providers/codex`,
  `runtime/providers/grok`, `runtime/providers/pi`. The tool-name rule is in
  `permissions/provider-runtime`.
- Every path checks the same capability, `use:tool:mcp__<server>__<tool>`.
  The CLI pair runs `enforceCliCommandAccess` first and then
  `authorizeMcpUse`.
- `use:tool:mcp_*`, written to grant Pi's `mcp_tools` and `mcp_call`, is a
  name prefix that also covers every `mcp__<server>__<tool>`. Docs and the
  permissions skill MUST say so.

## Claude Facade

- The facade servers MUST be built per turn from the cached catalog (no network
  at turn start), one per attachment the turn may list (checks 1 to 4 pass and
  at least one tool is granted).
- A facade is a forwarding server, not a host server. Its name MUST NOT enter
  `hostMcpServers`; it goes only to the hook's gateway list. Facade names and
  host names MUST be disjoint. When the records are merged and a name is in
  both, the host server wins: the gateway server is dropped for that query
  (a warning and a `runtime.mcp_name_overlap` trace event), and the turn
  goes on; it never throws.
- Claude Code defers MCP tools behind its `ToolSearch` tool, and Ravi keeps
  that deferral. An agent on Claude without `use tool:ToolSearch` may never
  reach a facade's tools: `ravi mcp show` and `ravi mcp attach` warn about
  each such attached agent (`warnings`).
- A facade serves tools only (no resources, no prompts). `tools/list` returns
  the cached catalog filtered by `authorizeMcpUse`. `tools/call` runs
  `authorizeMcpUse` again with the context record of the current turn and
  forwards to the gateway under an inline budget of 240 seconds.
- The tool watchdog MUST ignore a declared `timeout` argument for `mcp__`
  names that are not host tools.
- Per turn means per query: the host builds the facades (`prepareTurn`,
  `src/mcp/claude-facade.ts`) after it refreshes the turn's context record
  and before it hands the turn to Claude Code; the provider registers that
  turn's facades on the query, and the tool hook reads the facade names of
  the current turn on every call. A server the current turn does not declare
  is not a gateway server for the hook, even if an earlier turn declared it.
  A build that fails leaves the turn with no facade.
- Listing and calling read the context record of the current turn (the record
  the host refreshes in place), never a copy taken when the facade was built.
- A catalog tool whose input schema is not an object schema (a `type` other
  than `object`, `properties` that is not an object, `required` that is not a
  list of strings) is left out of the facade listing, because Claude Code
  rejects the whole list for one such tool; a schema without `type` is sent
  as an object schema. Titles, annotations and `_meta` are not passed on, and
  a result's `_meta` is dropped. A result with structured content and no text
  also carries that content as JSON text.
- A facade registers Claude Code's own per-call limit at the budget plus 30
  seconds, so the gateway's timeout answer always comes first. A call while
  the gateway is not running, or a failure inside the facade, answers a tool
  error and runs nothing.
- The runtime trace event `runtime.mcp_servers` records, per query, the
  declared names, the list Claude Code reported in `system/init` (names,
  sources, statuses), the extra and missing names, and a status: `match`,
  `mismatch` or `unreported`.

## CLI Pair

Code: `src/cli/commands/mcp.ts` (`tools`, `call`), `src/mcp/cli-pair.ts`.

- `ravi mcp tools [server] [--query q] --json` lists what this turn may call,
  from the cached catalogs only (no network): for each attached server that
  passes `authorizeMcpUse` (surface `list`, checks 1 to 6), the granted tools
  with their full name `mcp__<server>__<tool>`, remote name, description cut
  to 1 KB and input schema, sorted by server and then full name. `--query`
  keeps tools whose full name or description holds the text (case
  insensitive). An attached server that does not pass is listed under
  `unavailable` with its denial code and reason; a named server that does not
  pass fails with that code (Exit codes below).
- One answer is cut to a listing budget: at most 100 tools and 96 KB of tool
  entries (JSON). Servers take turns in name order, each tool in full-name
  order, so a large server cannot crowd out the others; an entry that does
  not fit the bytes left is left out and the next is tried. The cut is
  deterministic. `total` counts every tool that matched, `omitted` counts
  what was left out per server, and `note` says how many and how to see them
  (list one server, or narrow with `--query`); `note` is null when nothing
  was left out. There is no gateway search tool: it would hide the real tool
  name from the name check.
- `ravi mcp call <server> <tool> [--input <json>] [--wait <s>] --execute`
  calls one tool. The tool is the remote name or the full name of that same
  server. `--input` is one JSON object (default `{}`, at most 1 MB); an
  invalid value is a usage error that never quotes it. `--wait` is whole
  seconds from 1 to 110, default 45, and the gateway's inline budget; as a
  runtime dynamic tool it is capped at 55 s, below the 60 s after which the
  host stops a dynamic tool. The CLI waits 120 s for the daemon's answer.
- `call` runs `authorizeMcpUse` (surface `call`) before the brake, so a dry
  run (exit 3) shows only a call `--execute` can make; its plan holds the
  server, tool, full name, the sorted top-level argument keys (at most 64)
  and the wait, never an argument value, and nothing is sent. With
  `--execute` the gateway authorizes the call again before any network use.
  Argument values are redacted from the command audit.
- Both commands have `@CommandAccess` (`read mcp.tools:list`,
  `mutate mcp.tools:call`) and run `enforceCliCommandAccess` first, then
  `authorizeMcpUse`. Their scope is `open`, so Pi advertises `mcp_tools` and
  `mcp_call` exactly when `use:tool:mcp_tools` / `use:tool:mcp_call` grants
  them. The runtime bootstrap floor (`src/permissions/runtime-bootstrap-provider.ts`)
  grants the two command actions, `read mcp.skills:read` (the command a
  pinned skill's stub names, Remote Skills), and `read mcp.calls:list` and
  `mutate mcp.calls:cancel` (the commands a background call's acknowledgement
  names; what they show and cancel is narrowed per turn, Management CLI), and
  no other `ravi mcp` command:
  the door is the operator's attachment and `use:tool:mcp__<server>__<tool>`,
  the same as on Claude, and for a skill the operator's pin.
  An `explicit-only` agent has no floor, so it needs these command actions
  listed with its tool grants, plus its runtime's way in: on Codex and Grok
  `use:tool:Bash` and `execute:executable:ravi`; on Pi the dynamic tool names
  (`use:tool:mcp_tools`, `mcp_call`, `mcp_calls_list`, `mcp_calls_cancel`,
  `mcp_skills_read`); on Claude `use:tool:ToolSearch`, and the Bash pair for
  `calls` and `skills read`. The user docs (guides/permissions and
  guides/mcp) print one complete `explicit-only` line per runtime family,
  and a test applies each line with `ravi agents permissions` and checks it
  with the permission engine (Validation).
- The turn is the context record the daemon resolved for the caller's
  context key, and its agent. `--agent <id>` only names the agent of a
  context that has none, and only on the operator's own turn (else exit 3,
  `OPERATOR_TURN_REQUIRED`); a turn of one agent naming another is refused
  (`MCP_NO_TURN`, exit 3).
- Both run in the daemon: through the CLI gateway under `RAVI_CONTEXT_KEY`
  (Codex and Grok from their shell, every remote CLI), or in the daemon's
  own process as Pi's dynamic tools. From a terminal they go to the daemon's
  CLI gateway socket with the terminal's context credential; with no
  reachable daemon they MUST fail with `MCP_DAEMON_REQUIRED` (exit 1), whose
  message says the daemon is needed, and without a credential with
  `MCP_CONTEXT_REQUIRED`. A daemon whose MCP gateway is not running answers
  `MCP_GATEWAY_UNAVAILABLE` and sends nothing. Only a failure before the
  request is sent (the socket is missing or refuses) is retryable; when the
  connection ends after a `call` was sent (a reset, the CLI's own timeout, a
  daemon that stopped mid-call) the CLI MUST answer
  `MCP_CALL_OUTCOME_UNKNOWN` (exit 1, `retryable: false`) and say not to call
  again blindly, because the tool may have run. Only `ravi mcp login`
  connects from the CLI process. Only a terminal forwards: a process that
  holds a context of its own without a transport, or that carries a
  runtime's markers without `RAVI_CONTEXT_KEY`, MUST be refused with
  `MCP_NO_TURN` (exit 3) and never reach the gateway with the operator's
  default credential. The markers are one list shared with the connector
  turn classifier (`RAVI_RUNTIME_ENV_MARKERS`, `src/runtime/turn-origin.ts`):
  a session's (`RAVI_SESSION_KEY`, `RAVI_SESSION_NAME`, `RAVI_AGENT_ID`),
  a trigger's id (`RAVI_TRIGGER_ID`) and the principal the daemon sets on a
  shell cron, a shell trigger or a job (`RAVI_AUTOMATION_PRINCIPAL`, even a
  malformed one). A marker counts once it is set, whatever its value: an
  empty or blank one too (fail closed). `ravi mcp login` and `ravi mcp
  import` are refused (`CLI_ONLY_COMMAND`) in such a process too. The shell
  guard of every runtime (Claude's Bash hook, Codex's PreToolUse hook, the
  Grok and Pi command approvals, all `evaluateBashPermission`) refuses an
  agent without system admin any command that sets, blanks or drops a
  `RAVI_*` variable before running `ravi`; an agent that can run any
  program or any code, including the bootstrap floor through `bun <file>`
  on a file its file tools wrote, can still start `ravi` without the
  markers, the same authority that reads the credential files.
- Output carries text and structured content; other content (an image) is
  reported by type, MIME type and size, never its bytes. A tool error is a
  result (`outcome: "tool_error"`, exit 0), so the model reads it. A call
  that leaves its turn (Background Calls And Tasks) is a result too:
  `outcome: "detached"`, exit 0, with `callId` and the handle text.
- Exit codes: a denial is exit 3 with `MCP_<CODE>` (`MCP_AUDIENCE`,
  `MCP_CAPABILITY`, `MCP_NOT_ATTACHED`, `MCP_DISABLED`, `MCP_NO_TURN`, ...),
  except `not_registered` (`MCP_SERVER_NOT_FOUND`, exit 1), `needs_login`
  (`MCP_NEEDS_LOGIN`, exit 1, naming `ravi mcp login`) and `error` (exit 1).
  A gateway timeout or cancellation is `MCP_CALL_TIMEOUT` /
  `MCP_CALL_CANCELLED` (exit 1; the outcome on the server is unknown and the
  call is not sent again), any other failure `MCP_CALL_FAILED` (exit 1).

## Gateway

Code: `src/mcp/gateway.ts` (calls, refresh), `src/mcp/list-cache.ts` (catalog freshness), `src/mcp/connections.ts`
(clients, transports, era verdicts), `src/mcp/stdio-transport.ts`,
`src/mcp/catalog.ts`, `src/mcp/trace.ts`; client
`@modelcontextprotocol/client` 2.4.0, pinned exactly.

- One MCP client per server row, in the daemon, shared by all agents. The
  daemon starts the gateway with its other runners and stops it (closing every
  connection) on shutdown. Stopping aborts the gateway's own refreshes (their
  listings) and closes the transport of every connect still opening, so a
  stdio child that was starting is stopped with its whole group and never
  outlives the daemon; a close is awaited in full before a failed connect
  settles. Every stdio child the stop closes, opening or live, goes on the
  shutdown path: no stdin-EOF grace, SIGTERM to the group at once and SIGKILL
  `MCP_STDIO_SHUTDOWN_KILL_MS` (500 ms) later, so a child that ignores EOF and
  SIGTERM is gone before `stop` returns, with the default close grace. `stop`
  then waits for refreshes in flight at most
  `MCP_GATEWAY_STOP_WAIT_MS` (2 s), so a server that never answers cannot
  hold up the components the daemon stops after it. A refresh cut short by
  the stop records nothing on the row.
- Version negotiation MUST be passed explicitly from the `protocol` column
  (`auto`, `legacy`, or a pin of `2026-07-28`); the SDK default is legacy.
- The era verdict is stored in `discover_json` as
  `{kind: 'modern', discover, decidedAt}` or `{kind: 'legacy', decidedAt}`,
  and only when it matches the row's `era`. It is passed back as the `prior`
  of the next connect, so a server is not probed on every connect: a modern
  verdict on `auto` and pinned rows, a legacy verdict on `auto` rows only. A
  `legacy` row never probes.
- A `legacy` verdict on an HTTP row expires 24 hours after it was decided; the
  next connect probes again and the refresh timer probes it. A stdio legacy
  verdict does not expire (the child is local).
- A stored modern verdict that turns out stale probes again at once, on the
  signals of addendum A6 only: a refusal (`-32022`, or no common revision),
  and, from a connection that adopted the stored verdict, an unreadable
  result or a `-32601` on a method only the modern era has (`server/discover`,
  `skills/list`, `skills/get`, `tasks/*`). This holds on a refresh and on a
  server use (`withServer`, the skills commands). A use that sends several
  methods in turn is labelled with all of them (a skill read: `skills/get,
  resources/read`), and a `-32601` counts when any of them is modern-only. Any other server error
  (`-32602` not found or a bad cursor, `-32603` the Console unreachable,
  `-32003`) is the server's answer in the era it speaks: it is never a reason
  to probe again or to send the request again. A legacy answer from a row
  whose stored verdict was modern is probed once more before it is believed. A call refused with `-32022` is
  sent once more after a new negotiation (the server ran nothing). A call
  whose result is unreadable on an adopted modern verdict is NOT sent again
  (the tool may have run): the connection is dropped and a refresh negotiates
  afresh.
- A call is authorized again once its connection is open, with the row read
  as speaking the era that connection negotiated, before anything is sent on
  it. A credentialed row widened to `any` that answers the legacy way (a
  `-32022` retry, a stored modern verdict refused at connect, a legacy answer
  on reconnect) is therefore refused on a non-operator turn
  (`audience_legacy`) without a request on the legacy leg.
- Automatic fulfilment of `input_required` MUST be off. The gateway loops
  itself (at most 4 rounds) with the call scope in hand, in one loop
  (`src/mcp/input-loop.ts`) that both call paths use (the SDK client and the
  raw dispatch), so a write confirmation is asked the same way on either
  path. Every embedded request is checked before anyone is asked; each
  elicitation is answered under the rules below. The retry carries
  `inputResponses` and the byte-exact `requestState`. An embedded request
  other than `elicitation/create` stops the call. Each embedded request is
  answered by the elicitation handler (Elicitation); a handler that fails or
  answers anything but `accept`, `decline` or `cancel` answers `cancel`, never
  content. The handler is raced against the call's deadline and its abort
  signal: a handler that has not answered by then answers `cancel` (reason
  `timeout` or `cancelled`), so a hanging handler never holds the call. The
  questions of one `input_required` round share one answer window of 4
  minutes from the start of the round (`MCP_INPUT_ROUND_ANSWER_MS`), never
  past the call's deadline; a question asked after the window has closed
  answers `cancel` (`timeout`). A gateway built without a handler declines
  every request and sends nothing to anyone; the daemon's gateway uses
  `requestMcpElicitation`. A legacy-era `elicitation/create` server request on
  the connection reaches the same handler only under the attribution rule
  below.
- When Ravi answered a question `decline` or `cancel` without the person's
  explicit decision (nobody could be asked, the person did not answer in
  time, the question could not be delivered, the call was cancelled, no
  handler), the model's result starts with Ravi's own line, prefixed
  `[Ravi note, not from the MCP server]`, before anything the server sent (a
  failed call gets it at the start of its reason). The line is a fixed text
  per reason, never the server's message, a field or an answer, so server
  text cannot hide it. Server text cannot stand in for it either: when the
  gateway reads a result, every imitation of the marker in what the server
  sent (`[Ravi note` in any case or spacing, also behind compatibility forms
  such as full-width brackets or invisible format characters), in text items,
  embedded resource text, content type names and the strings and keys of
  structured content, becomes `[text from the MCP server]`, and so does one in
  a failed call's reason or a task's error or status message, whether or not
  Ravi adds its own line. A person's own Recusar adds no line. A result that
  had only structured content keeps its JSON as a text item after the line,
  so a reader that shows text still sees it. A confirmed write the server answers as expired (a tool error
  whose structured content is `{error: "confirmation_expired"}`) gets the
  line that the confirmation reached the server after it expired, that
  nothing changed, and that the tool is to be called again only if the
  person still wants it.
- A call that may detach (Background Calls And Tasks) to a row
  `mcpUsesRawDispatch` selects goes through the raw dispatch, which declares
  the tasks extension; every other call goes through the SDK client, which
  declares neither tasks nor files, so a compliant server answers inline. A
  call that sends files always goes through the raw dispatch; when it cannot
  detach (no follower, no detach asked, or a turn without a session) no
  request of it declares tasks (not the first, not the retries after
  `input_required` or `upload_required`), so a compliant server answers it
  inline too.
- HTTP uses Streamable HTTP with `onInsufficientScope: 'throw'` and
  same-origin redirects only. The full URL is read from the credentials store
  on every connect and MUST match the row's display form; a missing or
  mismatched URL fails the connect. A bearer or OAuth row connects only with
  a stored login; without one the row is `needs_login` and no request is
  made.
- A stdio child gets exactly PATH plus that server's declared keys (each
  key's value must be stored) and cwd `$RAVI_STATE_DIR/mcp/servers/<name>`
  (mode 0700). The gateway spawns the child itself, because the SDK's stdio
  transport adds the daemon's HOME, LOGNAME, SHELL, TERM and USER. The child
  runs in its own process group, without a shell; closing the connection ends
  stdin, then signals the whole group (TERM, then KILL), each after a grace of
  2 s (a gateway stop skips the grace, above). stderr is discarded.
  An `auto` stdio row probes on the child itself; a child that exits on the
  probe, or does not answer it within 5 seconds, is connected as a legacy
  server on a fresh child (the SDK reads a silent probe as legacy only on its
  own stdio transport).
- Connections open lazily, close when idle (5 minutes; a stdio child is
  stopped), are dropped on a `config` event of their server, when the row or
  its secret document changed since they opened, and on daemon stop. There is
  no reconnect loop: the next use connects again.
- The daemon refreshes a server (connect, list tools, write status, era,
  verdict, extensions and catalog) on every `config` change of it, at start,
  and on a 15-minute timer for rows that are due: status `unknown`, an expired
  legacy verdict, an error older than 15 minutes, or a check older than 24
  hours, or a modern row whose catalog is no longer fresh (below). Each
  timer run (and the one at start) then reconciles the remote skill pins of
  servers that have them (Remote Skills, `refreshMcpSkillPins`).
  `needs_login` rows wait for a login. Only a row with a login to give
  (auth `bearer` or `oauth`) becomes `needs_login`; a 401 or 403 on an `auth
  none` row, and a plain 403 (not `insufficient_scope`) on any row, is
  `error` with the detail `refused (HTTP <status>)`, and is probed again like
  any error, since a login cannot fix it. A refresh is the daemon's own
  probe of a registered, enabled row, not an agent's use, so it does not pass
  `authorizeMcpUse`; a result whose registration changed while it ran is not
  written.
- A row's status moves to `ok` only when a refresh lists its tools or a use
  of the server succeeds (a call or a server use; a row in `error` then
  becomes `ok` with its detail cleared). Opening a connection only stores
  the era verdict it negotiated (era, `discover_json`, checked time), never a
  status or a detail.
- One back-off per server (addendum A7): an HTTP 429 on either call path, on
  a refresh, on a connect (the era negotiation included: a 429 on
  `server/discover` is a back-off, never a legacy verdict, and the rest of
  that connect is not sent) or on a server use records `limited_until` from
  its `Retry-After` (seconds or a date, clamped to 1 s .. 1 h; 60 s when
  absent) in `mcp_server_rate_limits`. On the SDK path the `Retry-After` is
  read by the transport's fetch, since the SDK's error does not carry it.
  While it holds, every request to that server is answered locally without
  being sent: an inline call and a server use answer that the server asked
  Ravi to slow down and to try again in N s; a refresh keeps the row as it
  is and runs again once the back-off ends; the follower's polls and cancels
  wait for it. A 429 never marks a row `error` or `needs_login`, and a
  request that got a 429 is never sent again.
- Catalog freshness: the gateway keeps one SDK response cache per row and
  registration, handed to every client of that row, so the `ttlMs` a modern
  server sends with `tools/list` is honoured across connections: a refresh
  within it (an attachment change, for example) is served from the cache
  with no round trip, and keeps the files catalog listed with it. A refresh
  of a row with no catalog or a status other than `ok`, and a renegotiation,
  always fetch. A cache never serves another row (a server reports its own
  identity) nor a changed registration (URL, command, protocol, credential
  revision), which gets an empty one. `catalog_expires_at` is the fetch time
  plus `ttlMs` (capped at 24 hours); past it the row is due for the timer
  (`ttlMs` 0 means a list fetched on every refresh). A legacy server sends no
  `ttlMs`: its row keeps the 24-hour check. A changed registration clears
  it.
- Status details and error texts never carry a URL, a known secret value or a
  token-like run of characters.
- Results: text and structured content pass through; images (`image/*`, at
  most 5 MB each and 10 MB per result) are kept for the surfaces that show
  them; resource links are shown as text and never fetched; embedded text
  resources are shown as text; other content is reported by type and size;
  text is capped at 256 KB and structured content at 256 KB. Upstream `_meta`,
  annotations and unknown fields are dropped and MUST NOT drive any decision.
- Catalog: tools sorted by exposed name, description capped at 8 KB, input
  schema kept as raw JSON Schema (a tool whose schema is not an object or is
  larger than 64 KB, or whose name appears twice, is dropped with the reason),
  at most 512 tools. The fingerprint is the sha256 of the stored catalog. A
  changed fingerprint publishes `ravi.mcp.catalog.changed` (server,
  fingerprints, counts). Changes are traced, not blocked.

## Elicitation

- A server's question goes only to the person of the turn, and only when that
  person holds the credential: for a credentialed row (Authorization, check
  4: a login, a secret URL or stored env values), the operator's own turn;
  for a row that holds no credential, any resolved person on an `audience
  any` server.
- A turn with no person (cron, trigger, heartbeat, agent relay, unknown
  speaker, a delivery turn), or with no private surface, answers `decline`
  without sending anything. A timeout or a send failure answers `cancel`,
  never content.
- The question goes to a private surface: on Slack an ephemeral card for that
  Slack user whose button opens a private modal, elsewhere that person's own
  direct chat on the same instance. An answer counts only when it comes from
  that person: in a chat the sender of the reply, on Slack the one Slack user
  the request is bound to. In a chat a final accept or decline review follows
  the fields, except for a consent form (one required boolean field and
  nothing else, the shape of a write confirmation), which is one question
  whose yes sends it and whose no declines; in the modal the form itself is
  that review.
- Form fields that look like secrets (password, token, secret, otp, code,
  card, cvv, or `format: password`) are declined. Forms with more than 8
  fields or non-primitive fields are declined. An accepted answer MUST
  validate against `requestedSchema` before it is sent; an invalid answer is
  asked again or declined, never sent.
- URL mode shows the full URL with its host on its own line and waits for
  explicit consent. Ravi MUST NOT fetch or open the URL. A non-https URL or
  one with userinfo is declined.
- The approval row of an elicitation holds server, tool, mode, field names and
  the action, never values.

### The handler (`src/mcp/elicitation.ts`)

`requestMcpElicitation` answers each request in this order; the first step
that fails decides, and nothing is sent before step 6.

1. Plan the request. A form needs a flat object schema of at most 8 fields,
   each a string (`minLength`, `maxLength`, `format` email, uri, date or
   date-time), a number or integer (`minimum`, `maximum`), a boolean, or a
   single-choice string enum (`enum` with optional `enumNames`, or `oneOf`
   with `const` and `title`), at most 12 choices. Any other shape (nested
   objects, arrays, multi-select, a `pattern`, an unknown format, a field name
   that is not a plain name) declines (`unsupported_form`); more than 8 fields
   declines (`too_many_fields`); a secret-looking field name or title
   (password, passwd, passphrase, passcode, token, secret, otp, cvv, cvc as
   part of a word; code, card, pin, senha as a word), `format: password` or
   `writeOnly` declines (`secret_field`). URL mode needs an https URL of at
   most 2048 characters, as given and as parsed, without userinfo
   (`unsafe_url`). Any other mode declines (`unsupported_request`). Texts are
   cut to fixed limits with the ellipsis counted inside the limit (message
   1500, a title or choice label 100, a description 300 characters), so every
   choice label fits the 100 characters a person-bound question takes.
2. `authorizeMcpUse` on surface `elicitation` for the call's tool
   (`not_authorized`).
3. The person of the turn, from the connector turn classification with the
   operator's login as owner: the speaker of an operator's own turn in a
   direct chat or group, or the resolved contact or owner a refused turn names
   as its candidate in a direct chat or group. A routine (cron, heartbeat,
   trigger), the terminal or an operator relay (no contact), an agent relay
   or forwarded request, an ended or unknown turn, and a delivery turn have
   no person (`no_person`).
4. The credential principal: when `mcpServerHoldsCredential` is true, only
   the operator's own turn is asked (`not_credential_principal`).
5. The private surface. On a Slack turn it is the Slack user that person owns
   in the turn's workspace and the turn's own conversation, where the card is
   posted privately to them (`resolveSlackMcpElicitationSurface`). On any
   other channel the source channel must deliver attributed quote-replies
   (WhatsApp, Telegram, Discord) and the question goes to
   `resolvePersonDirectChatTarget` for that person on the turn's instance. A
   turn with no source, a Slack person who owns no Slack user in that
   workspace or whose turn names no Slack conversation, and a person with no
   proven direct chat decline (`no_private_surface`).
6. Time: 10 seconds of the call's budget are kept for the retry; with less
   than 5 seconds left to answer, the request declines (`no_time`). The
   questions of one `input_required` round share the round's answer window
   (`answerBy`: 4 minutes from the start of the round by default, under the
   Console's 5-minute confirmation, and never past the call's budget); each
   question waits at most what is left of it. With less than 5 seconds of
   it left, a request's first question is not sent (`no_time`, `decline`),
   and a later question of the same form is not sent either (`timeout`,
   `cancel`).
7. The approval row is written (type `elicitation`, the person's direct chat,
   field names only, expiring with the budget); if it cannot be written the
   request declines (`audit_failed`) and nobody is asked.
8. Asking, while the call's approval wait lease is held (`scope.approvalWait`;
   on Claude the session's `externalApprovalWait`, so the tool watchdog waits
   too). A Slack turn asks once, through the modal (Slack Modal). In a chat a
   form asks each field in order (the first question carries the
   server, the tool and the server's message): booleans (Sim, Não) and enums
   as choices, strings and numbers as quote-replies; an optional field can be
   skipped (a `Pular esta pergunta` choice, or `-` as a reply). Then a review
   lists the answers with the choices Enviar and Recusar. A consent form (one
   required boolean field and nothing else) is one question instead: the
   server's message, the field's label and description, and the line that
   Sim sends this confirmation to the server and Não sends nothing; Sim
   answers `accept` with that field `true`, Não answers `decline`, and there
   is no review. URL mode sends one
   question with the full URL and, on their own lines, the URL and its host,
   and the choices Aceitar and Recusar; when the whole text would pass the
   4000 characters of one question, the server's message is cut, never the
   URL or the host. A choice answer is read as a label first (any case) and
   as a position only when no label matches, so a numeric label such as "1"
   names that label. An invalid answer is asked again once with a hint; a
   second invalid answer cancels (`invalid_answer`).
9. The content is validated against the planned schema once more (required
   fields present, no extra field, types and bounds) before `accept` is
   returned, whichever surface answered; a failure cancels. Recusar answers `decline`. A timeout,
   `send_failed`, `wrong_actor`, a cancelled call or a call out of time
   answers `cancel`. URL consent answers `{action: 'accept'}` with no content.
10. The row is settled with the action (`accept` and `decline` name the
    person), and one `mcp.elicitation` trace event is recorded (Trace). The
    action and its reason code are reported back to the gateway
    (`request.report`), which uses them for Ravi's note and the
    `mcp.call` trace (Gateway).

The question texts are in Portuguese, like the rest of the person-bound
questions. A cancelled call stops waiting at once; the person's chat may still
show the question.

Server text can never pass for Ravi's own lines, on every surface (chat
questions, the Slack card and modal). Every break a renderer may draw (CR,
vertical tab, form feed, U+0085 NEXT LINE, U+2028 LINE SEPARATOR, U+2029
PARAGRAPH SEPARATOR) counts as a newline, and the other C0 and C1 controls,
DEL and the bidi marks, embeddings, overrides and isolates are removed. A title or choice label is one line
(every run of whitespace, newlines included, is one space) and sits in
quotation marks (“…”) inside Ravi's lines. The server's message and a field's
description are quotations: every line starts with `> ` (an empty line is
`>`), blank runs collapse to one, and at most 12 lines of a message and 4 of a
description or consent label are kept (an ellipsis line marks the cut), on
top of the character limits. Ravi's own lines never start with `>`; its
opening line (server and tool) comes first and says the server's text is on
the lines with `>`, and the line that says what each answer does always
comes after the server's text. In the Slack card and modal the server's
message is a plain-text block of its own under Ravi's heading, quoted the
same way, apart from Ravi's blocks; a field's description in a hint is one
line in quotation marks before Ravi's own hint. What the model reads keeps
its own guard (an imitation of `[Ravi note, ...]` is replaced, Gateway).

### The Slack modal (`src/channels/slack/mcp-elicitation.ts`)

Slack quote-replies never reach the daemon, so a Slack turn is asked in a
private modal instead. The daemon and `ravi-channels` are different processes;
the row in `mcp_elicitation_requests` is what they share, and the daemon trusts
that row, never a payload.

- The daemon (`askSlackMcpElicitation`) writes one row (the Slack account,
  instance, conversation and thread, the bound Slack user, the person, the
  agent, the session, the `elicitation` approval row, the server, the tool, the
  mode, and the planned form or URL), starts listening, and sends the bound
  user one ephemeral card through `ravi.outbound.deliver` with `privateTo`.
  The row holds what the person is asked, never an answer, a value or a
  secret.
- A card that Slack does not confirm cancels the request (`send_failed`) and
  the row is closed; nobody is asked twice.
- In `ravi-channels` (`handleMcpElicitationEnvelope`) only the bound Slack
  user of that account may open the card, and only while the row is open and
  unexpired; the first open binds the one view of the request and a second
  open is refused. Another user gets a private notice and nothing is opened.
- The modal is built from the stored fields: a string is a
  `plain_text_input`, a number or integer a `number_input` with its bounds, a
  boolean a `radio_buttons` (Sim, Não), and an enum a `static_select` whose
  option values are positions, so a long schema value never travels in a
  Slack value. An optional field is `optional: true`. A URL request shows the
  full URL and its host and offers Aceitar or Recusar, and Ravi still never
  fetches or opens it. `Enviar` submits a form, `Recusar` closes it.
- A submission is read against the stored fields only: a value outside the
  schema answers Slack with `response_action: errors` per field, and the
  request stays open. A valid submission claims the row (one answer per
  request, `answered` or `declined`) and then publishes it once on
  `ravi.mcp.elicitation.answer`; a replay publishes nothing and says the
  request is closed. A publish that fails tells the person nothing was sent.
  The subject is internal: no trigger is created on `ravi.mcp.elicitation.*`,
  and a wildcard trigger (`ravi.mcp.>`, `ravi.>`) never fires on it.
- The waiting daemon accepts an event only when the row proves it: the same
  request, the bound Slack user, the same account, and the status
  `ravi-channels` claimed. A decline is the person's own refusal; a timeout,
  a cancelled call, a failed delivery or content that does not fit the plan
  is `cancel`, never content.
- The answer leaves no trace of its values: the row, the approval row and the
  `mcp.elicitation` trace event hold names, counts and the action only, and
  nothing in this flow logs a value.
- Rows settled, or expired, more than a day ago are deleted
  (`pruneMcpElicitationRequests`, the same rule in both places): by
  `ravi-channels` each time it inserts a request, and by the daemon's MCP
  status refresh. A row is kept until then, also once it has expired.

### Person-bound answers (approval service)

The questions of an elicitation are asked through
`requestPersonAnswer({target, expectedActor, kind, text, options?})` in
`src/approval/service.ts`. The existing `requestPollAnswer` is unchanged for
its callers.

- The outcome is typed: `answered` (with the person's contact id and either a
  `choice` label or a `text`), `timeout`, `send_failed` or `wrong_actor`. A
  send failure or a delivery without a message id is `send_failed` with a
  fixed reason; it never becomes an answer and never carries the error text.
- `wrong_actor` is returned before anything is sent when the expected contact
  does not exist or is blocked, or when the target is not that contact's own
  direct chat (a group, a thread, or a direct chat another contact shares or
  whose peer identity the contact no longer owns).
- Only channels whose quote-replies reach the daemon as `ravi.inbound.reply`
  with the quoted message id and the platform sender (WhatsApp, Telegram,
  Discord through Omni) are served; any other channel (Slack) is
  `send_failed` (`unsupported_channel`) with nothing sent. Slack uses its own
  private modal (The Slack modal).
- An answer counts only when it quotes the question's message, comes through
  the target's account, and its platform sender (with the WhatsApp LID form)
  resolves to the expected contact through the same identity lookup the
  grantor gate uses. Answers from anyone else are ignored and counted.
- `poll` sends a native poll only on a channel whose `ravi.inbound.pollVote`
  events name each voter; a vote counts only when its voter resolves to the
  expected contact. No inbound source publishes poll votes today, so the
  options go as numbered text and the person answers by quote-reply with the
  label (any case) or the number; an exact label wins over a position, so
  with options "5", "10" and "1" the reply "1" is the option "1". Any other
  text comes back as `text`. A question longer than 4000 characters or an
  option longer than 100 is `send_failed` (`invalid_request`).
- The question and the answers are never logged.
- `resolvePersonDirectChatTarget({channel, accountId, instanceId?,
  contactId})` (`src/approval/direct-chat-target.ts`) finds that person's
  direct chat on the turn's own instance (Slack: the workspace's configured
  aliases; other channels: the instance's name and id), the most recently seen
  one, or null. It sends nothing.
- Rows of type `elicitation` must carry their detail (server, tool, mode, field
  names; a URL-mode row has no fields) and only that row type may carry one.
  Field names are plain names (letters, digits, `_ . : / -`, at most 128
  characters); any other key a caller passes is dropped. The row is settled
  with `settleElicitationApprovalRequest`: `accept` and `decline` record the
  action and who answered, `cancel` expires the row. A reaction, reply or
  click on such a row never decides it through the approval path, and
  `claimApprovalDecision` never claims it.
- On a legacy-era connection an `elicitation/create` request is attributed
  only when exactly one call is in flight on that connection; otherwise it is
  declined. The SDK hands the client's request handler no id of the call the
  request belongs to (its context has the request's own id, method and
  `_meta` only), so each call binds itself to its connection lease, and the
  request is answered for that call only when the connection has exactly one
  use in flight and it is a bound call. A refresh probe or a second call in
  flight makes it ambiguous; it is declined without asking anyone.

## Background Calls And Tasks

Code: `src/mcp/call-follower.ts` (the follower), `src/mcp/calls-db.ts` (the
`mcp_calls` table), `src/mcp/gateway.ts` (`callDetachable`).

- Which calls may detach: the Claude facade (budget 240 s) and the CLI pair
  (`--wait`, default 45 s, 55 s as a runtime tool) ask for it; the gateway
  honours it only with a follower attached (the daemon's) and a turn context
  that names its session. Otherwise the budget is a timeout as before.
- Such a call goes through the raw dispatch when its row qualifies
  (`mcpUsesRawDispatch`: a tasks-declaring modern HTTP server), else through
  the SDK client. It runs under its own cancellation and a 30-minute ceiling;
  the caller waits only for the inline budget. It detaches:
  - on a `task` result that is not already terminal (a terminal one is
    answered inline), with reason `task`;
  - when the budget ends first, with reason `budget`: the request is kept in
    the daemon's memory (state `running`) and its late outcome is handed to
    the follower.
  The model then gets outcome `detached`, the call id, and a handle text that
  says the result arrives in this session as a new message, that the tool must
  not be called again for this request, and what `ravi mcp calls cancel <id>`
  does: for a task it asks the server to stop, and the server decides whether
  its work stops (a cloud run only stops being followed, addendum A8); the
  delivered answer, with the server's own status message, says what
  happened. For a budget overrun it stops waiting, and whether the server ran
  the request is unknown. The handle never promises that the work stops.
  After detaching, the caller's abort no longer
  reaches the call, and the approval wait lease of the turn is let go. A call
  that cannot be recorded does not detach: a task answers an error that says
  its result cannot arrive; a budget overrun is aborted and answers `timeout`.
- `mcp_calls` (lazy-init block of `router-db.ts`, no foreign key, so a
  removed server's calls keep their row) stores id (`mc_` + 26 base-32
  characters), server, tool, agent, session name and key, origin (context id,
  the origin person's contact id, whether it was the operator's own turn),
  surface, era, detach reason, state, outcome, remote task id and status, poll
  interval and next poll time, expiry, cancel request and cancel sent times,
  the capped delivery text, input rounds, poll failures, delivery attempts,
  last error, the last 429 times, owner (the daemon run of a kept request) and
  times. Arguments, answers and secrets MUST NOT be stored; the delivery text
  is cleared once delivered.
- States: `running` (kept request), `task` (polled), `delivering`,
  `delivered`, `failed` (the session queue refused every retry). Outcomes:
  `ok`, `tool_error`, `error`, `cancelled`, `expired`, `lost`, `discarded`.
  Every move is a compare-and-swap on state and next poll time, so two
  followers never act on one row twice; a follower claims a due row by moving
  its next poll time to a short lease.
- The follower polls `tasks/get` on the raw dispatch at the task's poll
  interval clamped to 2 s .. 5 min (10 s when it names none), under a budget
  of 30 polls and cancels per server per minute (the Console allows 60 per
  bridge and client). The task's `ttlMs` (capped at 7 days, else 24 h) is the
  backstop: past it the call ends `expired` without another poll. A `-32602`
  answer (the server no longer knows the task) is `expired` too.
- HTTP 429 (`{"error":"mcp_rate_limited"}`) is the server's one back-off
  (Gateway): it holds until `Retry-After` for every request to that server,
  the follower's polls and cancels included, and is recorded for `ravi mcp
  show` with its method (`tasks` for a poll, `tools/call` on either call
  path, `connect` when opening the connection, `tools/list` on a refresh,
  the skills methods); it never fails a call. The follower reads the same
  record the gateway writes, so a 429 an inline call got also holds the
  polls, and a poll's 429 holds the inline calls. An inline call that got a
  429 ran nothing and answers that it may be made again in N s
  (`MCP_SKILLS_RATE_LIMITED` for a skills command). A login the server asks
  for (a refused refresh, a 401 after it) marks the row `needs_login` and
  polls again after 5 minutes; a step-up answer (403 `insufficient_scope`)
  concerns that request only: the row keeps its status and the task is
  polled again after 5 minutes. A `-32022` answer probes the row again (its
  stored modern verdict is stale); other failures back off exponentially.
  None of these fails the call: the TTL ends it. `ping` is never sent.
- Each poll re-runs checks 2 and 3 of `authorizeMcpUse` (registered and
  enabled, attached to the agent). Check 1 (a live turn) is not re-run, since
  the origin turn has ended by design; the delivery turn carries its own
  authority. A server that fails them ends the call `discarded`. The row
  records the registration it went to (the server row's creation time): a
  server removed and registered again under the same name is another server,
  so the call is discarded and nothing of it (no `tasks/get`, no
  `tasks/cancel`, no task id) is sent to the new registration. Deleting an
  agent ends its open calls at once (`failed`, outcome `discarded`, nothing
  sent and nothing delivered), so an agent created again with that id never
  receives them.
- Late input (`input_required` on a task; the Console never sends it, other
  servers may) is answered through `tasks/update` with the same answer step as
  inline input (Elicitation), at most 4 rounds per task (then Ravi cancels the
  task and the call ends `error`). Its context is the origin turn's record,
  read again by id for each question, and only while the turn classifier
  still names the origin person (same contact, same operator verdict).
  Otherwise the handler gets no context and declines without asking anyone.
  The classifier names nobody for an ended turn, and a turn's context is
  revoked when the turn completes, so in practice a late question is asked
  only while the origin turn is still running; once it has ended the
  question is declined. Asking the origin person after their turn ended
  would need a binding captured at detach and is not done. The same rule
  covers a kept request's question after it detached. A key already answered
  is not asked again while the server catches up. A task's question runs
  beside the follower's loop: its row is held for the answer window (6
  minutes), and every other call goes on being polled, cancelled and
  delivered meanwhile.
- Cancel: `ravi mcp calls cancel <id>` records a cancel request. A kept
  request is aborted (its outcome on the server is unknown). A task gets
  `tasks/cancel`, then exactly one more `tasks/get`, and the call records what
  that answers: `completed` (delivered with its result and a note that the
  server had already committed the work), `cancelled` or `failed`, or a
  status still running (delivered `cancelled` with a note that it may still
  finish). A cancel the server cannot take yet is tried again until the TTL.
  The acknowledgement is stored first (the cancel is never sent twice); the
  read then waits for the poll budget and a 429 back-off like any poll, and a
  read that fails is tried again: the call settles only on what the read
  answers, or at the TTL (delivered with a note that the task may still have
  finished). The cancel Ravi sends itself (a task that asks for input too
  often, or asks what cannot be answered) takes the same read, and its
  reason goes first in the note; the call ends `error` unless the task
  completed.
- Stop: the daemon's shutdown aborts every request the follower has in
  flight (polls, cancels, updates, a person's question) and waits for it at
  most 2 seconds. Rows keep their lease and the next run picks them up; a
  question cut short sends nothing and is asked again.
- Restart: at boot every `running` row of another daemon run becomes `lost`
  and is delivered as "outcome unknown", with a warning not to call the tool
  again blindly. A `tools/call` whose outcome is unknown MUST NOT be sent
  again. Tasks resume from their row. One daemon per state directory is
  assumed for `running` rows.
- Delivery publishes on the session prompt queue (`publishSessionPrompt`)
  with barrier `after_response`, message id `mcp-call:<id>` and the marker
  `_mcpCall` (id, server, tool, outcome), retried on
  `BACKGROUND_WAKE_RETRY_DELAYS_MS` with the same id. The row moves to
  `delivered` once, so a repeat is suppressed; after the last retry it is
  `failed`. No new event subject carries call content.
- The delivery turn's principal is `automation:mcp-call:<id>`
  (`resolveAutomationPromptPrincipal`; a malformed id is
  `automation:mcp-call:invalid`), never the person who started the call nor
  the operator: the turn classifier refuses it as an operator turn, so an
  operator-audience server and the legacy credentialed leg are denied to it,
  and it has no person to ask. It is never resumed after a restart, keeps its
  marker on continuations, does not merge with other queued messages, and has
  knowledge audience `none`.
- The prompt is a fixed header Ravi writes (call id, server, tool, outcome),
  Ravi's notes, then the remote text inside `<mcp-result call="<id>">`, said to
  be data and not instructions, capped at 64 KB, with any closing tag inside
  it neutralized. Images and other content are named by type and size. If the
  server was removed, disabled or detached before delivery, the content is
  discarded and only a note is delivered.
- `mcp.call` trace events of a detached call: one at detach (outcome
  `detached`, surface of the caller) and one when it ends (surface
  `background`, its outcome, the call id), on the call's session.

## Raw Dispatch

Code: `src/mcp/raw-dispatch.ts`; the shared loop in `src/mcp/input-loop.ts`.

- Results the SDK client rejects (`task`, `upload_required`) and the
  `tasks/get|update|cancel` methods go through one hand-written dispatch, used
  only for HTTP rows in the modern era, not pinned to `legacy`, whose server
  declares the tasks extension or the files extension with `upload`
  (`mcpUsesRawDispatch`). The full URL comes from the credentials store and
  MUST match the row's display form; a bearer or OAuth row needs its stored
  login (else `needs_login`, nothing sent).
- Each request is one JSON-RPC POST (no session) with
  `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, `Mcp-Name` (`params.name`
  for `tools/call`, `params.uri` for `resources/read`, `params.taskId` for
  `tasks/*`), the bearer, and the `_meta` envelope (protocol version, client
  info, client capabilities) under the SDK's key constants. A name or task id
  that is not a printable header value is refused before sending. The
  capabilities are fixed for one dispatcher, so every request of one logical
  call declares the same set: `elicitation: {form, url}`,
  `io.modelcontextprotocol/tasks: {}` when the server advertises tasks and
  the call may detach, and
  `io.modelcontextprotocol/files: { upload: {} }` only for an attachment with
  uploads on whose server advertises `files.upload` (never a bare `{}`).
- `ping` and `initialize` are never sent on a modern row (the server answers
  404 `-32601`); the dispatch refuses them locally.
- The answer is plain JSON or an SSE stream; the first message carrying the
  request id is the answer (comments, notifications and other ids are
  skipped). Answers over 8 MB are unreadable. Redirects are never followed.
- `tools/call` results `complete`, `input_required`, `task` and
  `upload_required` are read whether or not they carry `content`; any other
  result type is unreadable. A task carries id, status (`working`,
  `input_required`, `completed`, `failed`, `cancelled`), status message,
  times, `ttlMs` (a number or null), `pollIntervalMs`, the inner result of a
  completed task (its own `resultType` `complete`; a tool error is
  `completed` with `isError`), the error of a failed one, and the embedded
  requests of one that asks for input. `input_required` on a call is answered
  only through the shared loop; a task's late input is answered with the same
  answer step through `tasks/update`.
- A `tasks/cancel` acknowledgement does not mean the task stopped: the server
  may finish work it already committed. The caller reads the task once more
  and records what that answers.
- Failures carry a kind and whether the outcome is unknown. Known (nothing
  ran): `-32020` header mismatch, `-32021` missing capability (with the
  extension names it requires), `-32022` unsupported version, `-32601`,
  `-32602` (unknown tool or task, invalid `requestState`; a plain identifier
  in `data.reason` or `data.error` is kept, nothing else of `data`), 401, 403
  (`insufficient_scope` apart from a plain refusal), 429, a 3xx and other
  4xx. Unknown (the server may have run it): a transport failure after the
  request left, a timeout, a cancel after sending, a 5xx, any other JSON-RPC
  error (the Console's `-32603` `console_unreachable` among them), and an
  unreadable answer. A `tools/call` whose outcome is unknown MUST NOT be sent
  again.
- On 401 the dispatch asks the row's stored login to refresh (OAuth refreshes
  under the credential lock; a bearer row has nothing to refresh and is
  `needs_login` at once) and sends once more; a second 401 is `needs_login`.
  A 403 `insufficient_scope` is a step-up: the failure carries the scopes the
  challenge names (plain scope tokens, at most 8) and the gateway answers it
  as a step-up for that request only (Credentials And Login), never by
  marking the row.
- HTTP 429 is not JSON-RPC (`{"error":"mcp_rate_limited"}`): it is a back-off
  until `Retry-After` (seconds or a date, clamped to 1 s .. 1 h; 60 s when
  absent), never a failure, and the dispatch never resends on it.
- Error texts never carry the URL, a header, the bearer or the body; they pass
  the same redaction as the gateway's.

## Credentials And Login

Code: `src/mcp/oauth-provider.ts` (stored login, refresh, lock),
`src/mcp/login.ts` and `src/mcp/login-options.ts` (the commands).

- One credential per server: the operator's. It lives in the server's secret
  document (Secrets And Display Forms): the bearer token of an `auth bearer`
  row, or the OAuth state of an `auth oauth` row (tokens with the time they
  were obtained, the client registration and how it was made, the redirect
  URI it was made for, the authorization server's URL and metadata, and the
  resource the tokens are bound to). The credentials inventory lists the
  entry with the granted scopes and the time of the last login or refresh,
  never a value.
- `ravi mcp login <name> [--client-id id] [--port n] [--token-stdin] [--paste] --execute`
  is CLI-only and braked: refused (exit 2, `CLI_ONLY_COMMAND`) inside a
  runtime turn (`RAVI_CONTEXT_KEY`), in a process that carries a runtime
  marker (a session's, a trigger's, or the principal of a shell cron, shell
  trigger or job) or through the gateway, and refused unless
  `resolveOperatorTurn` passes. Flags are checked against the row before the
  brake: a stdio row or an `auth none` row has no login (exit 2); a bearer row
  needs `--token-stdin` and takes no OAuth flag; an OAuth row refuses
  `--token-stdin`. The dry run connects to nothing and listens on nothing.
- OAuth: the code flow with PKCE (S256) and the RFC 8707 `resource`. The
  redirect is the fixed loopback URI `http://127.0.0.1:33418/callback`
  (`--port` picks another port). A stored client registration is reused only
  when it was made for the same redirect URI and the same kind of client id;
  otherwise the client registers again. The client id comes from `--client-id`,
  else from the client metadata document named by the setting
  `RAVI_MCP_CLIENT_METADATA_URL` (an https URL with a path; an invalid value
  is a usage error) when the authorization server supports such documents,
  else from dynamic registration. A login never reuses stored tokens: it
  always runs a full authorization.
- The authorization URL comes from the authorization server's metadata, so it
  is checked before it is shown: only https (plain http only on a loopback
  host) is printed or opened; any other scheme (`file:`, `smb:`, a custom
  handler) fails the login (`LOGIN_FAILED`) with nothing opened or stored.
  The authorization server's host is printed on its own line. The
  authorization URL holds the server's secret address (the bridge URL rides
  in its `resource` parameter), so it is printed only for a person at a
  terminal (stderr is a TTY), with the warning not to paste it into a chat or
  a ticket; elsewhere it is only opened in the browser, and `--paste`, which
  needs the URL shown, is refused before anything is sent
  (`INVALID_OPTION`). The URL never reaches `--json` output, a log, a trace or
  an error text. The browser is opened unless `--paste`. Ravi does not
  change the server's URLs. The loopback listener
  binds 127.0.0.1 only, answers one path, and counts only a redirect that
  carries this login's state; any other request is answered and ignored. With
  `--paste` nothing listens and the pasted URL must be this login's redirect
  URI. Ravi checks the state itself (constant time; the SDK's `finishAuth`
  does not), then the SDK checks the issuer (`iss`, RFC 9207) and exchanges the
  code. A state or issuer mismatch, an `error` answer, a refused code or a
  timeout (5 minutes) stores nothing.
- Bearer: the token is read from stdin (one line, at most 8 KB, no spaces).
- Nothing is stored until a new connection with the new credential has listed
  the server's tools; a credential the server refuses is not stored
  (`TOKEN_REFUSED`, exit 3). The login is then written under the credential
  lock, unless the row's URL or auth kind changed meanwhile; the row's status
  goes to `unknown` and then `credential_rev` moves, which emits a `config`
  change: the daemon reconnects and refreshes the row on its own.
- `ravi mcp logout <name>` applies at once and needs no operator turn. It
  forgets the stored login (the URL and env values stay), marks a credentialed
  row `needs_login`, and moves `credential_rev`.
- Revocation (RFC 7009): a logout of an OAuth login, and a login that
  replaces a stored OAuth grant, revoke that grant at the authorization
  server's `revocation_endpoint` (from its stored metadata), best effort:
  the refresh token first, then the access token, each in its own
  form-encoded POST with `token`, `token_type_hint` and the stored
  `client_id`, a 5-second timeout and no redirect followed. The endpoint
  must be https (plain http only on a loopback host), carry no userinfo and
  share the origin of the stored authorization server; otherwise, or without
  a stored client id, nothing is sent. A logout revokes before it forgets,
  and revokes again any token a refresh stored meanwhile; a login revokes
  the replaced tokens only after the new login is stored, and never a token
  the new login kept. A revocation that fails, times out or is not offered
  never blocks the logout or the login: the result says `revoked` (the
  server answered 200 for every token), `not_confirmed` or `not_offered`
  (logout `revocation`, login `previousGrant`, null when no OAuth grant was
  replaced). No token, endpoint or answer body reaches the output, a log or
  an error text.
- In the daemon, the gateway connects a bearer or OAuth row only with a stored
  login, and never starts an authorization or opens a browser. A missing
  login, an expired token without a refresh token, a refresh the
  authorization server refuses, and a 401 after a refresh set `status` to
  `needs_login` with the text `run <login command>` (the login hint below);
  so does a step-up answer (403 `insufficient_scope`) to a refresh or a
  connect, since a login that cannot list the tools is unusable.
- The login hint: every text that tells the operator to sign in (a
  `needs_login` status detail or refusal, a follower's `lastError`, a raw
  dispatch error, a refused file upload) names the exact command, built by
  one helper (`mcpLoginCommand`): `ravi mcp login <name> --execute`, and for
  a bearer row `ravi mcp login <name> --token-stdin --execute < token.txt`.
  `ravi mcp login` is braked, so a hint without `--execute` would only show
  the plan. Where only the name is known, the hint takes the first form.
- A step-up answer to a use (a tool call on either call path, a file-upload
  retry, a server use such as a skills method, a follower's poll) concerns
  that one request: the login is valid but lacks a scope this request needs.
  The row keeps its status and its connection, and the server's other tools
  go on working. One helper (`mcpStepUpScopes`) reads the scopes on both
  paths. A tool call answers `error` with a text that names the missing
  scope and the operator's remedy: log in again and allow it (`ravi mcp
  login <name> --execute`), or, for a Ravi Console server, turn "Allow
  changes" on for that bridge. A skills command fails
  `MCP_SKILLS_SCOPE_MISSING` (exit 1, telling the operator to log in again
  with that scope).
- A token within 60 seconds of its expiry is refreshed before use; a 401
  refreshes once and retries once. A refresh holds the lock file
  `$RAVI_STATE_DIR/mcp/locks/<name>` (shared by the daemon and the CLI; a lock
  whose holder is gone or that is older than 2 minutes is broken), re-reads
  the stored login, and uses a token another process already replaced instead
  of refreshing it again. Breaking a stale lock is atomic: the file judged
  stale is moved aside and discarded only when it is that same file (inode and
  content); a live lock that replaced it is put back. The token request is
  aborted after 30 seconds, well under the stale limit. The refreshed tokens
  are stored only when, after the request, the row is still registered with
  auth `oauth`, the process still holds the lock, and the stored document is
  the one the refresh read; otherwise the removal, logout or new login that
  happened meanwhile stands and the refresh is dropped. `remove` deletes the
  secret under the same lock. A refresh does not move `credential_rev` and does
  not drop the connection; a login and a logout do.
- Tokens, codes, verifiers and client secrets MUST NOT reach argv, an
  environment, `ravi.db`, a log, a trace, command output, an error text or a
  remote-spawn host.

## Remote Skills

Code: `src/mcp/skills.ts` (service), `src/mcp/skill-ids.ts` (ids, names,
manifests, stubs; pure), `src/mcp/skill-pins-db.ts` (`mcp_skill_pins`),
`src/mcp/skill-plugin.ts` (Library plugin entries), `McpSkillsCommands` in
`src/cli/commands/mcp.ts`. Servers expose skills through the skills extension
(`skills/list`, `skills/get`, `resources/read`), read with the SDK's
`SkillsClient`.

### Ids and names

- Id `mcp:<server>:<path>`, where `<path>` is the skill URI without `skill://`
  and without the trailing `/SKILL.md`; never the frontmatter name, which the
  server chooses and two skills may share. Path segments are
  `[A-Za-z0-9._~-]{1,100}`, never `.` or `..`, at most 200 characters in all.
  `pin` also takes the URI or the bare path. One normalization
  (`normalizeMcpSkillPath`) serves `pin`, `read` and `unpin`: a trailing
  `/SKILL.md` names the skill's own entry file and is dropped, so
  `mcp:<server>:org/x/SKILL.md` is the id of skill `org/x`, never of another
  skill. `src/library/refs.ts` knows the
  `mcp:` prefix: such an id never names a local or Library skill.
- The plugin skill name is `mcp-<server>-<slug>` (slug of the last path
  segment), at most 64 characters. A longer name, or one another pin or a
  Library pin already uses anywhere on the installation, is cut and followed
  by 8 hex of sha256 of server and URI. Another agent's pin of the same skill
  keeps the name it has. Names are unique per installation, not per agent,
  because some runtimes share one skills directory.

### Pins (`mcp_skill_pins`)

- One row per (agent, server, skill URI): id, plugin name, cleaned
  description (at most 1024 characters), the canonical manifest (URI, name,
  description, files sorted by URI with digest and size) and its digest
  (`sha256:` of a fixed JSON form), the entry's Library reference, whether it
  is allowed on other people's turns (`external_allowed`), state `active` or
  `stale` with a reason (`manifest_changed`, `digest_mismatch`, `dynamic`,
  `gone`), who approved it and when. It lives apart from `library_pins`,
  which a Console sync replaces wholesale; a sync never touches it. Deleting
  an agent deletes its pins.
- `skills pin <server> <skill> [--agent a] [--external] [--digest d]
  [--execute]` is braked and operator-only (Management CLI). It runs in the
  daemon and sends `skills/get` for that one skill, never `resources/read`:
  no skill file is fetched on connect, listing, dry run or approval. The plan
  shows id, plugin name, description, file count, the manifest digest,
  whether the skill is already pinned and `fetchesFiles: false`.
  `--digest` binds `--execute` to the manifest the dry run showed; a server
  that answers another one fails `MCP_SKILL_MANIFEST_CHANGED` (exit 1) and
  pins nothing. A pin of an existing row approves it again (state `active`).
  `--external` on an attachment whose audience is `operator` is not refused,
  but the plan and the result carry `warnings`: the stub then loads on other
  people's turns, where every read fails `MCP_AUDIENCE`, and the warning names
  `ravi mcp set <server> --audience any --agent <id> --execute`.
- `pin` refuses: a skill whose files are `"dynamic"` (`MCP_SKILL_DYNAMIC`); a
  manifest that does not list its own `SKILL.md` (`MCP_SKILL_MANIFEST_INVALID`);
  an entry whose `_meta["bot.ravi/library"].ref` matches a Library pin of that
  agent (`MCP_SKILL_LIBRARY_DUPLICATE`; the agent already loads that skill
  from the Console sync); an unknown skill (`MCP_SKILL_NOT_FOUND`); a server
  without the extension (`MCP_SKILLS_UNSUPPORTED`).
- `skills unpin <id> [--agent a]` deletes the pin at once (it only reduces
  authority). A turn of one agent may unpin its own agent's pins; naming
  another agent needs the operator's own turn (`OPERATOR_TURN_REQUIRED`,
  exit 3).
- `skills list <server> [--agent a] [--limit n] [--offset n]` is for the
  operator's own turn only (`OPERATOR_TURN_REQUIRED`, exit 3, before any
  network use; the classification of `isOperatorOwnTurn`): the listing is the
  organization's catalog, read through the operator's login. It reads
  manifests only (`skills/list`, every page): id, name, description, file
  count, whether the list is dynamic, the Library reference and every agent's
  pins of each skill. `--limit` (1 to 500, default 50) and `--offset` page
  what is returned; `total` counts every listed skill, and `pagination`
  carries the next command. Pins of skills the listing does not show (any
  state) are returned apart, as `unlistedPins`.
- `scopeMissing`: the stored OAuth grant names its scopes and holds none of
  the scopes the server's authorization metadata (kept from discovery)
  advertises with a `skills` segment (a Console's `mcp.console.skills.read`).
  A Console answers `skills/list` without that scope with an empty list, so
  the listing does not fail: it says `scopeMissing: true` with a
  `suggestedAction` naming the scope and `ravi mcp login <server> --execute`.
  A grant that names no scope, a bearer row or a server that advertises no
  such scope is never reported missing.
- Reconciliation (`reconcileMcpSkillPins`, `pinCheck`), on every `skills
  list` and on the refresh tick, against a complete listing only, for every
  agent's pins of that server:
  - an active pin whose skill is listed on another manifest goes stale
    (`manifest_changed`; `dynamic` for a dynamic list);
  - an active pin whose skill is not listed goes stale (`gone`), and its stub
    leaves the plugin before any model reads it;
  - a pin stale only as `gone` becomes `active` again when the skill is
    listed with exactly the approved manifest digest (the digest is what the
    operator approved; nothing else restores a pin). Listed on another
    manifest it becomes `manifest_changed` (or `dynamic`). `manifest_changed`,
    `digest_mismatch` and `dynamic` are cleared only by a new `skills pin`;
  - an entry the client refused as invalid changes nothing;
  - an empty listing changes nothing (`pinCheck: "empty_listing"`): a server
    answers it for no skills, for an organization whose skills are off, for a
    login without the skills scope and for an agent bridge, and a Console's
    `skills/get` and `resources/read` answer a switched-off organization
    exactly as an unpublished skill, so the client cannot tell these apart.
    No pin is marked gone for an empty listing; a read in the meantime still
    finds the skill gone (`skills/get`), and the pin is restored by the next
    listing that shows the approved manifest, so a switch turned off and on
    costs no new pin and never loads an unapproved manifest;
  - with `scopeMissing` nothing is reconciled (`pinCheck: "scope_missing"`).
  The result reports `stalePins` and `restoredPins`. Each change is logged
  and traced (`mcp.skill`, `op: "pin_state"`, with the pin's agent and the
  reason) and rebuilds the plugin.
- The refresh tick (`refreshMcpSkillPins`, after the servers due are
  refreshed): for each enabled server that declares the skills extension,
  is not `needs_login` and has a pin that is active or stale only as `gone`,
  at most one `skills/list` walk per server per tick, through
  `withServerUnattended` (the daemon's own use, for no turn: it honours the
  server's back-off and records a 429, and its result never reaches a
  model), then the reconciliation above. A server whose grant lacks the
  skills scope (`scopeMissing`) is not walked.

### The generated plugin and the gate

- Each active pin of a registered server is a stub skill in the generated
  `ravi-library` plugin, in the agent's `all` variant and, when
  `externalAllowed`, also in its `external` one. The stub holds no remote
  instructions: the plugin name, the cleaned approved name and description,
  and the command `ravi mcp skills read <id>` (with `--file <relative path>`
  for a file the instructions name). It says the content is remote and grants
  no tool or permission (frontmatter such as `allowed-tools` is ignored).
- A stub whose plugin name a Library pin of that generation uses is left out:
  the Library pin wins.
- Every pin change (pin, unpin, a pin marked stale, detach, remove) rebuilds
  the generation from the current `library_pins` rows (from the Library cache)
  plus the MCP pins, without a Console call. A Console sync adds the MCP
  pins' stubs to the generation it writes.
- The per-turn Library gate (`isLibraryPluginSkillAllowedForTurn`), the
  session plugin resolution and the skill allowlist (`readAgentLibraryPins`)
  count a pin only while it is active, its server is registered and enabled,
  and the server is attached to that agent. The gate admits it on the
  operator's own turn, or on any turn when `externalAllowed`; every failure
  to read the pins denies.

### Read

- `skills read <id> [--file p] [--agent a]` runs in the daemon. Its checks,
  in order: the id and `--file` (exit 2, before any network use); a pin of
  the turn's agent (`MCP_SKILL_NOT_PINNED`); the pin is active
  (`MCP_SKILL_STALE`, worded by the stale reason: a `gone` pin says it comes
  back by itself when the server lists the skill again on the approved
  manifest; the others say the operator pins it again); the per-turn gate (`MCP_SKILL_EXTERNAL_DENIED`,
  exit 3), since the model may run the command without loading the stub; the
  file is in the approved manifest (`MCP_SKILL_FILE_NOT_FOUND`); then
  `authorizeMcpUse` (surface `skill`; its denials map as in CLI Pair).
- `--file` is a path relative to the skill root: no empty, `.` or `..`
  segment, no leading slash, scheme, backslash, percent escape or control
  character, at most 300 characters (`MCP_SKILL_FILE_INVALID`). Without it
  the read returns `SKILL.md`.
- Each read sends `skills/get` first: a manifest whose digest differs from
  the pin's marks the pin stale (`manifest_changed`) and fails
  `MCP_SKILL_STALE`; a skill the server no longer has marks it stale
  (`gone`). Revocation on the server therefore takes effect on the next read,
  or on the next listing or refresh tick, whichever comes first.
- The file comes from the cache `<state>/mcp/skills/cache/<sha256 hex>`
  (directory 0700, file 0600, written atomically, with the media type the
  server gave beside it in `<sha256 hex>.type`, so a cached read returns the
  same `mimeType` as a fetched one), whose bytes are checked
  against the size and digest on every access, or else from `resources/read`
  for that one file through `SkillsClient.read`, which checks the raw bytes
  against the manifest; Ravi checks size and digest again before caching.
  The cache is named by digest only and is never a skill directory.
- Bytes that do not match fail `MCP_SKILL_DIGEST_MISMATCH`, are not returned
  or cached, and mark the pin stale (`digest_mismatch`) for every agent.
- The result is the file decoded as UTF-8 (at most 256 KB, `truncated`
  otherwise); a file that is not UTF-8 is reported as binary with its size,
  never its bytes. The text is remote content: it grants nothing, is never
  logged, and a turn's permissions still apply to what the model does next.
- Every read, refused or not, writes an `mcp.skill` trace event (`op:
  "read"`; Trace).
- Gateway failures: `MCP_NEEDS_LOGIN`, `MCP_SKILLS_TIMEOUT`,
  `MCP_SKILLS_FAILED` (exit 1). Without a daemon or a context the commands
  fail as `call` does (`MCP_DAEMON_REQUIRED`, `MCP_CONTEXT_REQUIRED`,
  `MCP_GATEWAY_UNAVAILABLE`).

### Error codes

`MCP_SKILL_ID_INVALID` (2), `MCP_SKILL_FILE_INVALID` (2),
`MCP_SKILL_NOT_PINNED` (1), `MCP_SKILL_STALE` (1),
`MCP_SKILL_EXTERNAL_DENIED` (3), `MCP_SKILL_FILE_NOT_FOUND` (1),
`MCP_SKILL_DIGEST_MISMATCH` (1), `MCP_SKILL_DYNAMIC` (1),
`MCP_SKILL_LIBRARY_DUPLICATE` (1), `MCP_SKILL_MANIFEST_INVALID` (1),
`MCP_SKILL_MANIFEST_CHANGED` (1), `MCP_SKILL_NOT_FOUND` (1),
`MCP_SKILLS_UNSUPPORTED` (1), `MCP_SKILLS_SCOPE_MISSING` (1),
`MCP_SKILLS_RATE_LIMITED` (1), `MCP_SKILLS_TIMEOUT` (1), `MCP_SKILLS_FAILED` (1),
plus the shared `OPERATOR_TURN_REQUIRED` (3) and the `authorizeMcpUse`
denials.

## File Uploads

Uploads are for HTTP servers in the modern era that declare
`io.modelcontextprotocol/files` with `upload`. They are off per attachment
by default (`ravi mcp set <name> --uploads on --agent <id> --execute`).

- Two catalogs per server (`src/mcp/gateway.ts`, `refreshFilesCatalog`): the
  plain one, listed without the extension, and the files one, listed on the
  raw dispatch with `{"upload": {}}` declared (column `files_catalog_json`).
  An attachment with uploads on sees the files catalog when the server
  declares uploads and the listing succeeded; any other attachment, and any
  stdio, legacy or failed listing, sees the plain catalog. A files listing
  that fails clears the files catalog, and a changed one emits
  `ravi.mcp.catalog.changed` with `variant: "files"`.
- An argument marked `x-mcp-file` (on the property, on array items, or on
  `anyOf`/`oneOf` branches of those) becomes a string path handle (a list of
  them for an array) in the schema the runtime sees, with the server's own
  description after Ravi's; `maxItems` is capped at 10. A marker at the
  root, inside a nested object, or mixing one file and a list drops the tool
  with a reason. The marker, the `FileInput` shape and any URL never reach
  the runtime.
- Gate B (send), first: the attachment has `uploads=1`, the server is a
  modern HTTP server that declares uploads, the agent is not a remote-spawn
  agent, and `authorizeMcpUse` passes for that tool with surface `upload`
  (a denial is recorded). Refusals: `uploads_off`, `server_kind`,
  `remote_agent`.
- Gate A (read), per handle (`src/mcp/files.ts`): the turn may use
  `tool:Read`; the real path after symlink resolution is not a runtime
  provider's configuration and not inside the Ravi state directory
  (`RAVI_STATE_DIR` and `~/.ravi`); unless the turn may run any executable,
  it lies in the agent's workspace (not when that workspace is `/` or
  `$HOME`) or a temp directory; it is a regular file with one name (a hard
  link is refused); at most 25 MB (or the argument's `maxSize`), 100 MB and
  10 files per call, of an accepted type. The file is opened without
  following a final link and checked again by device and inode before it is
  read, and the path of the open file (on Linux from `/proc/self/fd`,
  elsewhere the path resolved again, with the same device and inode) MUST be
  the path the decisions ran on: a directory swapped for a symlink between
  the decision and the open is refused (`unreadable`). An `art_*` artifact id is refused (`artifact_handle`): save the
  artifact as a workspace file first. Refusals name the handle as given,
  never a resolved location.
- Both gates MUST pass before any network call: a refused call sends no
  request at all (outcome `file_refused`, CLI code `MCP_FILE_REFUSED`,
  exit 3).
- Each handle becomes a `FileInput` `{id, mimeType, size, name, digest:
  {algorithm: "sha-256", value}}` (ids `f1`, `f2`, ...; the digest is 43
  base64url characters). A size-0 file needs no upload.
- The call then runs on the raw dispatch with the files extension declared:
  preview, the confirmation through the one shared input loop, then
  `upload_required` with `uploads[{fileId, url, method, headers,
  credentials, expiresAt}]` and a top-level `requestState`.
- An upload target (`src/mcp/upload-target.ts`) is accepted only when its
  `fileId` names one file of this call once; it is an absolute https URL
  without userinfo whose host is a name, not an IP literal; `credentials` is
  `omit`; the method is `PUT` (raw bytes) or `POST` with a `form`
  (multipart); it lists no credential or routing header (`authorization`,
  `cookie`, `proxy-authorization`, `forwarded`, `x-forwarded-*`, method
  overrides); and its `expiresAt` is ahead. The host is resolved and every
  address must be public (no private, loopback, link-local, CGNAT, NAT64,
  documentation or multicast range); the connection is pinned to the checked
  address, the TLS name is checked against the host, no proxy or pooled
  connection is used, and a redirect is never followed (anything but 2xx
  fails). What is sent is the listed headers (minus those the HTTP client
  owns: `host`, `content-length`, connection headers) plus exactly what the
  client needs: `host`, `content-length`, `accept: */*` and a fixed
  `user-agent: Ravi` that names no runtime or version (a target that lists
  `accept` or `user-agent` sends its own value); never the server's bearer,
  a credential, cookies or any other Ravi header.
- A refused target or a failed upload sends no retry; the server runs
  nothing. After the uploads, the call is sent once more with the same name
  and arguments plus `requestState` and nothing else. That retry is never
  sent again: a retry whose outcome is unknown, or that the server refuses
  (a used state is -32602 `invalid_request_state`), is the call's outcome.
  A retry answered before the server handled it (HTTP 429, a login or a
  step-up scope it asks for, -32021, -32022) reports that nothing ran, with
  the back-off, the login to run or the missing scope (a step-up leaves the
  row's status as it is); Ravi keeps no upload between calls, so calling the tool
  again uploads the files again.
  With tasks declared (only a call that may detach declares them) the retry
  may answer a task, which the follower takes over; its polls declare the
  files extension too (`mcp_calls.files_upload`).
- A server that needs the extension when it was not declared answers -32021
  with `data.requiredCapabilities`; Ravi reports it with the hint to turn
  uploads on.
- Targets, headers, `requestState` and file bytes MUST NOT reach the model,
  the trace or the logs.
- Uploads never work for remote-spawn agents, stdio servers or legacy
  servers. `ravi mcp set --uploads on` refuses a remote-spawn agent
  (`REMOTE_SPAWN_UPLOADS`, exit 3).

## Trace

- `mcp.call` events carry server, tool, surface, era, duration, outcome,
  byte counts and, for a background call, its call id. Outcomes include
  `detached`, `expired`, `lost` and `discarded`; surface `background` is the
  follower's. They MUST NOT carry arguments, results, answers, URLs or
  headers. They are session trace events (group `tool`) of the turn's
  session; a call without a session is logged with the same fields. Every
  call outcome is traced, denials included. A call that sent files also
  carries `upload: {files, bytes, outcome}` (`sent`, `failed`, `refused`),
  never a name, path, target or digest. A call also carries `elicitation:
  {outcome, reason}`: `accepted`, `declined`, `cancelled` (the first answer
  that was not an accept decides) or `none` (nobody was asked anything), and
  the fixed reason code of that answer (the `mcp.elicitation` codes, plus
  `no_handler` and `unreported`), never an answer, a field or the server's
  message.
- `mcp.skill` events (`src/mcp/trace.ts`): `op: "read"` for each `ravi mcp
  skills read`, refused or not: server, skill id, file path, bytes, `source`
  (`cached` or `fetched`, for a read that returned a file), `outcome` (`ok`,
  `denied` for an exit-3 refusal such as `MCP_SKILL_EXTERNAL_DENIED` or
  `MCP_AUDIENCE`, `error`) and the fixed reason code (the error code, with
  the stale reason for `MCP_SKILL_STALE`, e.g.
  `MCP_SKILL_STALE:manifest_changed`). `op: "pin_state"` for a pin the client
  changed by itself: `outcome` `stale` or `restored`, the reason and the
  pin's agent. They MUST NOT carry the skill's content. They are session
  trace events (group `tool`) of the turn's session; without one (the
  refresh tick, a terminal) they are logged with the same fields.
- `mcp.elicitation` events carry server, tool, era, mode, field count, the
  number of questions sent, the action and a fixed reason code (`accepted`,
  `declined`, `timeout`, `send_failed`, `wrong_actor`, `cancelled`,
  `invalid_answer`, `no_time`, `not_authorized`, `no_person`,
  `not_credential_principal`, `no_private_surface`, `secret_field`,
  `unsupported_form`, `too_many_fields`, `unsafe_url`, `unsupported_request`,
  `audit_failed`, `error`). They MUST NOT carry the server's message, field
  values, the URL or who was asked. They are session trace events (group
  `tool`) of the turn's session, logged with the same fields when there is
  none.
- The runtime trace lists host and gateway servers (`name`, `kind`,
  `transport`, `era`, tool count, status) and the list the runtime itself
  reported. A mismatch is recorded as an event. A gateway server left out of
  a query because a host server holds its name is recorded as
  `runtime.mcp_name_overlap` (status `degraded`, the dropped names).
- Chat presentation (`src/runtime/tool-presentation.ts`): a tool named
  `mcp__<server>__<tool>`, and the CLI pair's `mcp_call` dynamic tool, are
  shown as `MCP <server>: <tool>` with category `mcp`. Argument names are
  shown, never their values (the rule `ravi mcp call --input` follows). A
  shell tool call is shown that way only when its command is provably one
  `ravi mcp call <server> <tool>` and nothing else: the repository's bash
  analyzer finds exactly that one command, and a strict lexer accepts the
  line (plain words and quotes only; no `$`, backquote, redirection, `&`,
  `;`, `|`, comment, grouping, glob or brace, at most one `sh|bash|zsh -c`
  wrapper), the word is exactly `ravi`, and the only flags are `--input`,
  `--wait`, `--agent`, `--json` and `--execute`, each at most once. Any other
  line keeps the shell presentation. What the native call lacks is shown as
  names only: a line without `--execute` has the title
  `MCP <server>: <tool> (dry run)`, and `--agent` and `--wait`, when present,
  lead the summary by name, never with their values.

## Fail-Closed Cases

Each of these denies or fails, never allows:

- no context, unregistered, disabled, not attached, wrong audience, legacy
  credentialed row on a non-operator turn, missing capability, `needs_login`;
- an exception in `authorizeMcpUse`, in the Claude tool hook, or in the
  facade handler;
- a Claude tool whose reported provenance is not `sdk` plus a gateway name,
  and an unattributed `mcp__` name whose prefix is neither a host nor a
  gateway server;
- a Claude `system/init` server list with an entry Ravi did not declare;
- a Codex `mcpServerStatus/list` entry that is not reported disabled, a
  Codex server key that `-c` cannot address, an unreadable Codex
  configuration file, and any `item/mcpToolCall/*` event;
- any Grok MCPTool decision, and any Pi `mcp__*` tool;
- a login whose state or issuer does not match, whose code is refused, or
  whose new credential the server refuses (nothing is stored); a daemon
  connection that would need an authorization (`needs_login`, never a
  browser);
- an elicitation with no person, a person who is not the credential principal,
  no private surface, a secret-looking field, an unsafe URL, or an ambiguous
  legacy attribution;
- an upload that fails gate A, gate B or target validation, an upload that
  fails, and a retry after an upload whose outcome is unknown (never resent);
- a skill read whose digest does not match its pin, whose live manifest
  differs from the pin, or whose pin is stale, absent, or not allowed on this
  turn; a pin of a dynamic skill; an unreadable pin table (no stub counts);
- a background call whose server was removed, disabled or detached (content
  discarded), a late question whose origin turn no longer names the origin
  person (declined), a delivery turn on an operator-audience server, and a
  call that cannot be recorded (it does not detach).

## Validation

- `RAVI_STATE_DIR="$(mktemp -d)" ./bin/ravi specs sync --json`
- `bun test src/mcp/`
- `bun test src/bash/hook.test.ts src/runtime/host-hooks.test.ts`
- `bun test src/runtime/claude-provider.test.ts src/runtime/codex-provider.test.ts src/runtime/grok-provider.test.ts src/runtime/pi-tool-permissions.test.ts`
- `bun test src/cli/commands/mcp.test.ts src/cli/commands/mcp-call.test.ts src/cli/execute-consumers.test.ts`
- `bun test src/runtime/runtime-request-context.test.ts src/runtime/delivery-queue.test.ts src/runtime/daemon-restart-resume.test.ts src/knowledge/turn/audience.test.ts`
- `bun test src/cli/commands/doctor.test.ts`
- `bun test src/mcp/oauth-provider.test.ts`
- `bun test src/mcp/skills.test.ts src/library/ src/runtime/library-turn-skills.test.ts src/permissions/runtime-bootstrap-provider.test.ts`

## Known Failure Modes

- A server name with an underscore lets one grant prefix reach two servers.
- An upload client that sends the MCP server's bearer, follows a redirect or
  resolves the storage name a second time would hand storage the server's
  credential or reach a private address.
- A facade name added to `hostMcpServers` turns a forwarding server into an
  exempt host server: every remote tool would run without the name check.
- A runtime that still loads servers from its own configuration makes the
  registry advisory.
- A host with an enterprise MCP configuration stops every Claude session:
  Claude Code refuses `--strict-mcp-config` there (`runtime/providers/claude-code`).
- The SDK's default `legacy` negotiation silently keeps a modern server on the
  legacy leg, where elicitation is not available.
- Auto-fulfilled `input_required` answers a server's question without knowing
  who is asking.
- A full server URL stored in `ravi.db` leaks the bridge token to every reader
  of the database.
- An import that matched registered servers on display values alone would
  attach agents to a server holding another token behind the same display
  URL; the import compares full values from the credentials store.
- Fetching skill files at pin time breaks the skills extension and caches
  content that was never read.
