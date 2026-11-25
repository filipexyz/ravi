# MCP Servers / CHECKS

Each block names the test file that proves the rules of one section of
`SPEC.md`. A rule is shipped behaviour only when its check passes.

## Spec

- `RAVI_STATE_DIR="$(mktemp -d)" ./bin/ravi specs sync --json` succeeds and
  lists `mcp`.
- `./bin/ravi specs get mcp --mode full --json` returns `SPEC.md`, `WHY.md`,
  `RUNBOOK.md` and `CHECKS.md`.

## Registry and names (`src/mcp/names.test.ts`, `src/mcp/registry-db.test.ts`)

- Names with an underscore, an upper-case letter, a leading digit or hyphen,
  more than 24 characters, or a reserved name (`ravi`, `spec`, every host
  server name) are refused.
- The reserved list is the host server export of
  `src/runtime/runtime-host-attachments.ts`; adding a host server reserves it.
  `src/runtime/host-hooks.test.ts` checks that every name the session
  attaches as a host server is in that export.
- A grant `use:tool:mcp__a__*` does not cover a tool of server `a-b`.
- A tool name with a dot, a space or more than 64 characters, or whose full
  exposed name exceeds 64 characters, is dropped and reported with a reason;
  it is never renamed.
- The tables are created by the lazy-init block only in isolated state (a
  process without an isolated state is refused and creates no database), and
  every write emits `ravi.config.changed` with `reason: "mcp_servers"`,
  `change` `config` or `status`, and the server names; a write that changes no
  row emits nothing.
- A URL with a long token segment, user info and a query string is stored and
  printed only in display form; the token is in neither `ravi.db` nor its
  WAL; the row records `url_secret` (set again when the URL changes). Plain
  http is refused except on a loopback host, and the URL error does not repeat
  the URL. (Writing the full URL to the credentials store is the
  `ravi mcp add` check in `src/cli/commands/mcp.test.ts`.)
- An env value given as a key, a credentialed stdio row and a duplicate name
  are refused; attaching twice never widens an attachment; removing a server
  removes its attachments; the credential revision swaps only from the
  expected value.
- The schema refuses a row outside the transport and enum grammar and
  cascades attachments (`src/router/router.test.ts`); deleting an agent drops
  its attachments (`src/router/agent-delete.test.ts`).

## Import (`src/mcp/import.test.ts`, `src/cli/commands/doctor.test.ts`)

- Fixtures for every source: agent `.mcp.json`, `~/.claude.json` user and
  project entries (a project no agent uses is not read), plugin `.mcp.json`
  with `${CLAUDE_PLUGIN_ROOT}`, `plugin.json` inline and by a path (a path
  outside the plugin is refused), `$CODEX_HOME/config.toml` and the agent's
  `.codex/config.toml` (with `enabled = false` kept). An entry reaches only
  the agents whose runtime loaded it: Claude files Claude agents (`.mcp.json`
  with `project` in `settingSources`, user entries with `user`), Codex files
  Codex agents, per-directory sources the agents of that directory, Pi and
  Grok agents nothing, local-scope entries nobody; each entry no agent loaded
  says why.
- A `.mcp.json` server listed in `<cwd>/.claude/settings.json`
  `disabledMcpjsonServers`, or in `~/.claude.json` `projects[<cwd>]`
  `disabledMcpServers`, reaches nobody and is skipped, not registered; a user
  entry disabled in one agent's directory still reaches the other agents.
- Unsupported entries (SSE, headers, bearer variable, `env_vars`, `cwd`,
  `${...}`, plain http, a secret-looking argument, unknown transport, no
  command) are listed with a reason that holds no value; an unreadable source
  is listed as invalid without quoting it. A Codex file Bun's TOML parser
  rejects (a date-time, after a BOM) lists the servers the scan names as
  entries that cannot be imported, with no value, and the doctor counts them;
  such a file without servers is read with no entry.
- Names normalize (underscores and upper case); invalid or reserved results
  need `--as`; identical entries merge; different entries colliding on one
  name are refused (exit 2) until `--as` (also `<source kind>:<name>`) or
  `--skip` resolves them; `--as`/`--skip` naming no entry is exit 2.
- A registered server with the same display URL but another token is a
  conflict; one with identical values only gets the missing agents; a second
  import changes nothing and emits no event.
- The dry run exits 3, shows the grant the new name needs
  (`use:tool:mcp__<name>__*`), the former names whose grants are not
  changed, and for an `explicit-only` agent without it the exact
  `ravi agents permissions <agent> --capabilities '...' --execute` that adds
  it (a `chat-only` agent gets a note), and the same in the `--execute`
  result (`src/mcp/import.test.ts`); target agents, a
  stdio server's arguments and env key names (text and `--json` plan), and
  the secrets that move by name; writes nothing, opens no connection, leaves
  the source files byte for byte and mtime unchanged.
- `--execute` registers with audience `operator` and origin `import:<path>`;
  tokens and env values are absent from output, from `ravi.db` and its WAL,
  and present in the credentials store.
- Remote agents are left out by default; a stdio server for a named remote
  agent answers `REMOTE_SPAWN_STDIO`. A stdio import without `admin` on
  `system:*` answers `PERMISSION_DENIED`; an http-only plan still imports. A
  session turn and the gateway answer `CLI_ONLY_COMMAND`.
- At daemon start the discovery logs one warning per file whose servers no
  longer load (path, server names, agents, `ravi mcp import`), never a URL,
  an argument or a value; a remote agent is left out; a discovery that
  throws is one debug line (`src/mcp/import.test.ts`).
- Doctor `mcp.native_unregistered`: warns with paths and names only, never a
  token; it warns when `managed-mcp.json` exists at the platform's path
  (macOS, Windows, Linux), with the RUNBOOK's refusal text; it warns about a
  Codex key that is not bare (file and key, never a value) even once a
  registered server covers it, read from the layers the launch reads (an
  untrusted project file is not warned about; a trusted parent layer and the
  system file are), and names a Codex file the launch cannot use; registered entries (matched on display values) leave it; a remote
  agent's directory is not reported for that agent; an entry no runtime loaded
  (disabled in Claude Code) is not reported, and a Codex file is reported for
  the Codex agents only.

## Authorization (`src/mcp/authorize.test.ts`)

- Matrix, each with its code: no context (`no_turn`), unregistered
  (`not_registered`), disabled (`disabled`), not attached (`not_attached`),
  operator audience on a contact turn and on an unclassifiable turn
  (`audience`), legacy credentialed row widened to `any` on a contact turn
  (`audience_legacy`; also a row with auth `none` whose URL carries a token or
  a query, and a stdio row with one or more env keys, until the era is known
  to be modern), capability missing (`capability`), `needs_login`.
- A stdio row with no env keys holds no credential: widened to `any`, a
  contact turn passes on a legacy era; on `operator` it answers `audience`.
  Env keys added to a widened row count at once (`audience_legacy`). A stored
  `env_keys_json` that does not parse as key names (not JSON, an object, a
  number, a bad name, `null`) reads as `(damaged)` and counts as credentialed;
  a well-formed empty list does not.
- Checks run in the stated order: a disabled row that is also not attached
  answers `disabled`; a missing capability on a `needs_login` row answers
  `capability`.
- A revoked context and a context of another agent answer `no_turn`.
- A credentialed row whose era is not yet known counts as legacy.
- The heartbeat and the admin bootstrap root are operator turns; a resolved
  contact, an unclassifiable turn and a delivery turn are not.
- `list` returns only granted, exposable catalog tools and records nothing;
  `skill` skips the tool check; the other tool surfaces need a tool name.
- A throwing classifier, capability check or registry read denies; a throwing
  denial recorder still denies.
- Every denial is recorded with `detail.mcpServer.source = "gateway"`; a
  capability denial as `use tool:mcp__<server>__<tool>`, others as
  `use mcp_server:<name>`.
- A delivery turn (`automation:mcp-call:<id>`) is denied on an operator
  audience server.

## Management CLI (`src/cli/commands/mcp.test.ts`, `src/mcp/secrets.test.ts`)

- `add`, `attach`, `enable`, `set --audience any`, `set --uploads on`,
  `set --protocol` exit 3 without `--execute` and write nothing; they exit 3
  (`OPERATOR_TURN_REQUIRED`) on a contact turn even with `--execute`.
- `detach`, `set --audience operator`, `set --uploads off`, `disable`,
  `remove` apply at once, also on a contact turn.
- `remove` deletes the row, the attachments, the credentials-store entry and
  the secret file, and asks the server's open background calls to end
  (`callsCancelled`). `remove` drops the server's skill pins for every agent
  and `detach` that agent's, both reporting `skillPinsDropped` (checked in
  `src/mcp/skills.test.ts`).
- `show` reports open background calls and the last HTTP 429 (time, until,
  method).
- `calls list` shows every call to the terminal and, to a contact turn, only
  the session's own calls on a server and tool that turn may use, never a
  result or the origin person; an unknown `--state` exits 2. `calls cancel`
  applies at once on such a call, reports an already requested or finished
  call without changing it, answers `MCP_CALL_NOT_FOUND` (exit 1) for another
  session's call, exits 2 on a malformed id; a turn with no session is
  refused (exit 3) (`src/cli/commands/mcp.test.ts`).
- Through the daemon's host CLI gateway (`src/cli/commands/mcp-call.test.ts`):
  a contact turn of the session neither lists nor cancels its session's call
  on an operator-audience server or on a tool it holds no grant for, and
  does list and cancel one on a server widened to `any` with the grant; the
  delivery turn (`automation:mcp-call:<id>`) sees its own call and no other;
  the operator's own turn sees and cancels every call.
- The dry run of `add --url-stdin` and `add --env` reads and validates stdin
  (bad values exit 2 without a value), prints the display URL and the names
  of the values read, and stores nothing; `login --token-stdin` checks the
  token in the dry run (a malformed token exits 2 without repeating it) and
  prints no token.
- `show` reports `login`: `not_needed` for stdio and `auth none`,
  `logged_in` with `loginExpiresAt` and `loginRenews` for a stored OAuth
  login, `needs_login` with nothing stored, and never a token.
- `add` keeps the full URL (and stdio env values) only in the credentials
  store, provider `mcp`: the token is absent from `ravi.db` and its WAL, from
  `list`, `show` and every output.
- An inline secret exits 2 (`--env KEY=value`, a token-bearing `--url`, a
  secret-named `--arg`); bad stdin values (missing, undeclared or repeated
  key) exit 2 without echoing a value; stdin under the gateway transport
  exits 2.
- A stdio `add` on the operator's relay without `admin system:*` is refused
  (`PERMISSION_DENIED`); a stdio server on a remote agent answers
  `REMOTE_SPAWN_STDIO`; `set --audience any` on a legacy credentialed row
  answers `AUDIENCE_LEGACY`, and passes once the modern revision is pinned;
  a row added with `--url-stdin` whose URL carries a token is credentialed
  with auth `none` and answers `AUDIENCE_LEGACY` too, and so does a stdio row
  added with one or more `--env` keys (passing once `2026-07-28` is pinned);
  a stdio row without env keys widens to `any` with only the brake.
- An `add` that loses a race for its name (the row appears after its
  duplicate check) fails with `already_registered` and leaves the winner's
  secret as it was; a successful `add` moves the credential revision after
  the secret is stored.
- A dry run opens no connection (no `fetch`) and emits no config event.
- `--json` failures have the shape `{success:false, op, error:{code, message}}`.
- `src/cli/execute-consumers.test.ts` holds the exact braked command strings of
  the `add` and `set` help, and pins every braked `ravi mcp` line (`add`,
  `attach`, `enable`, `login`, `import`, `call`, `skills pin`, and a widening
  `set`) in `docs/guides/mcp.mdx`, `docs/console/mcp.mdx`, the `mcp` system
  skill, the command help and the runtime login hints (`src/mcp/login-options.ts`
  and the modules that print them) to carry `--execute`, with a minimum count
  per file so a moved or renamed file fails; those modules hold no
  hand-written `run ravi mcp login` and build each hint with `mcpLoginCommand`;
  SDK, OpenAPI, Swift and Dart drift checks pass.
- The documented `explicit-only` examples (`src/cli/commands/mcp.test.ts`):
  `docs/guides/permissions.mdx` and `docs/guides/mcp.mdx` print the same
  three lines (Claude Code; Codex or Grok; Pi). Each line, applied with the
  real `ravi agents permissions`, lets the permission engine allow exactly
  what the page says: on Codex and Grok the Bash tool, `ravi mcp tools`,
  `call`, `calls list` and `calls cancel` through the Bash check and the
  command access check, and `use:tool:mcp__github__*`, but not another shell
  command, `mcp skills read`, `mcp attach` or another server's tools; on Pi
  the four dynamic tools and their command access and no Bash; on Claude
  `ToolSearch` and the `github` tools, and with the printed shell addition
  `calls cancel` and `skills read`. Without the command actions a Codex
  agent is refused at the command gate.

## Runtime loading

Listed in the provider CHECKS: `runtime/providers/claude-code`,
`runtime/providers/codex`, `runtime/providers/grok`,
`runtime/providers/pi`, and `permissions/provider-runtime` (Runtime tool call
regressions).

## Gateway (`src/mcp/gateway.test.ts`)

Against fixtures built with server 2.4.0 (`src/mcp/test-fixtures/`): a
dual-era server over HTTP (`createMcpHandler` on `Bun.serve`) and a stdio
server that is legacy only or dual-era.

- Catalog freshness: with `tools/list` `ttlMs` 60 s, a refresh after an
  attachment change is served from the row's cache (no `tools/list` on the
  wire, the catalog and `catalog_expires_at` unchanged) and the row is due
  once `catalog_expires_at` passes; with `ttlMs` 0 every refresh fetches; a
  changed registration (protocol) fetches at once; a legacy row stores no
  expiry and keeps the 24-hour check.
- HTTP: the refresh stores era `modern`, the verdict and the catalog sorted by
  exposed name, with `bad.name` dropped and reported; an unchanged catalog
  emits no `catalog.changed`, a changed one emits it with the old fingerprint.
- The stored discover result is reused: a new gateway's call sends only
  `tools/call`, no `server/discover`. A stdio row spawns once per connect.
- list and call work; text and structured content pass, upstream `_meta` does
  not; the trace event holds no argument.
- `input_required` declined by a gateway without a handler reaches the server
  as `decline` (modern era, and legacy era through the server's
  `elicitation/create` request), and the result starts with Ravi's note
  (`[Ravi note, not from the MCP server]`, nobody was asked) before the
  server's text; a handler that accepts completes the call.
- Ravi's note and the trace (`MCP gateway: back-off, stale verdicts, status
  and questions`): with no handler the note is the first content item and the
  `mcp.call` trace carries `elicitation: {outcome: "declined", reason:
  "no_handler"}` and no argument value; a person's own decline adds no note
  (`declined`/`declined`); a confirmed write the server answers
  `confirmation_expired` starts with the note that nothing changed (trace
  `accepted`).
- No imitation of the note: a server whose text starts with `[Ravi note, not
  from the MCP server]` after the person's own decline (no note added)
  reaches the model as `[text from the MCP server] ...`, in the text item and
  in structured content; `[ravi note`, full-width brackets and a zero-width
  character inside are neutralized too, and plain text that only mentions
  Ravi passes unchanged. A failed call's reason and a failed task's message
  are neutralized with or without Ravi's own line in front, and Ravi's own
  line stays as written.
- A structured-only result with a note: the note is the first item and the
  structured content's JSON the second, so Claude still reads it as text.
- A handler that never answers: the call returns within the call's budget
  with `cancel` (trace `cancelled`/`timeout`, the note that the person did not
  answer in time); an abort while the handler waits returns at once (trace
  `cancelled`).
- Back-off: after a 429 with `Retry-After: 7` on the SDK path the call
  answers "try again in 7 s", the `tools/call` was sent once, the record
  holds about 7 s (not 60 s) and the row stays `ok`; while it holds, a call,
  a refresh and a server use answer locally with nothing sent. A refresh
  answered 429 keeps the row's status and detail.
- Stale verdicts (addendum A6): a refresh and a server use answered `-32603`
  on a stored modern verdict send no `server/discover` and one `tools/list`;
  a `-32601` on a modern-only method negotiates again, also on a use
  labelled with several methods (`skills/get, resources/read`, a skill read).
- Status: a row in `error` stays `error` (its detail kept) when a call's
  connection negotiates but the call fails; a later call that succeeds makes
  it `ok` with the detail cleared.
- Text is capped at 256 KB; images pass; resource links become text, are not
  fetched; audio is reported by type and size; unknown content and a
  non-image MIME type are reported, not passed.
- A tool error is an outcome; a call past its budget is `timeout` and says it
  was not sent again.
- A denial (no turn, missing grant, not attached) happens before any network
  call or child start, and is traced.
- A bearer row without a login is `needs_login` with no request made, and its
  calls are denied.
- An `auth none` row answered 401 or 403 is `error` with `refused (HTTP
  <status>)` and no login remedy, is due again after 15 minutes, and its call
  fails as `error`; it returns to `ok` once the server accepts it.
- A credentialed row widened to `any` whose server refuses the stored modern
  revision and serves the legacy leg: a non-operator turn is denied
  `audience_legacy` after the reconnect and before any legacy request (only
  the refused modern `tools/call` went out); the operator's turn is served on
  the legacy leg.
- A stored modern verdict the server refuses is probed again; a legacy-only
  stdio child behind a stale modern verdict ends `legacy` after one more
  probe; a call answered outside the stored revision is not sent again and the
  server is probed again.
- A legacy verdict older than 24 hours is due and is probed again.
- A legacy-only stdio child that never answers `server/discover` is connected
  as legacy on a fresh child after the probe timeout, and the stored legacy
  verdict is reused without a probe.
- A stdio row whose stored env key list is damaged starts no child and is
  `error` naming the damage.
- `stop` while a refresh waits on an HTTP server that never answers, and
  while a stdio child is still starting (a command that never answers the
  probe), returns within 2 s with the default close grace, kills that child
  (also one that ignores SIGTERM) before it returns, and leaves the row's
  status as it was. A live stdio child whose launcher ignores stdin EOF and
  SIGTERM is gone when `stop` returns, too.
- The stdio child environment holds only PATH and the declared keys, cwd is
  `$RAVI_STATE_DIR/mcp/servers/<name>`; idle close stops the child; a
  `config` event stops it, a `status` event does not; a missing env value is
  an error that names the key, not the values.
- No secret (URL token, env value) appears in logs, trace events, status
  details, rows or results.
- Unit: negotiation mode per `protocol`, verdict reuse per protocol and
  transport, the refresh timer policy, error-text redaction, catalog
  duplicates, long names and bad schemas, the authorized tool listing, result
  normalization.

## Credentials and login (`src/mcp/oauth-provider.test.ts`, `src/cli/commands/mcp.test.ts`)

Against a fake authorization server and an OAuth-protected MCP server built
with server 2.4.0 (`src/mcp/test-fixtures/oauth-server.ts`, after SDK probe d1).

- Dynamic registration over the loopback redirect: S256, the state, the
  redirect URI and the `resource` reach the authorization server; the login
  is stored with its client registration; the row goes to `unknown` and
  `credential_rev` moves (a `config` event).
- A client metadata document with `--paste`: no registration, the URL is the
  client id; `--client-id` never registers.
- An issuer mismatch and a pasted answer with another state store nothing and
  make no token request; a loopback request with another state is ignored
  (400) and the login times out; a pasted URL that is not the redirect is
  refused without repeating it; a taken port fails clearly.
- The same redirect reuses the registration; a changed redirect registers
  again.
- The daemon connects with the stored token; after a 401 it refreshes once and
  keeps `credential_rev`; an expiring token is refreshed before use; two
  sessions (two processes) on the same expired token refresh it once under the
  lock; a refused refresh and an expired token without refresh token give
  `needs_login`; a row without a login has no provider and starts no
  authorization.
- A step-up (403 `insufficient_scope`) on a tool call answers `error` naming
  the missing scope (`mcp:admin`), `ravi mcp login <name>` and "Allow
  changes"; the row is not `needs_login` and another tool of the server still
  works (SDK path here; the raw path in `src/mcp/call-follower.test.ts`).
- A bearer token is stored only when the server accepts it.
- `logout` forgets the login, keeps the URL, marks the row `needs_login`.
- The login hint is the exact command: `mcpLoginCommand` gives
  `ravi mcp login <name> --execute`, and for a bearer row
  `ravi mcp login <name> --token-stdin --execute < token.txt`; a bearer row's
  logout leaves that second form as its status detail.
- Revocation (the fixture's RFC 7009 endpoint): `logout` revokes the refresh
  token, then the access token, form encoded with the client id
  (`revocation: "revoked"`); a login that replaces a grant revokes the old
  tokens (`previousGrant: "revoked"`) and the new login keeps working; a
  first login has `previousGrant: null`; a refused or hanging revocation
  does not block the logout (`not_confirmed`); an endpoint on another origin
  receives nothing; without an endpoint the result is `not_offered`. No
  token appears in the results or prompts.
- The authorization URL is printed only when it is shown to a person, with
  the warning not to paste it into a chat or a ticket; otherwise no prompt
  carries it (nor the result), and `--paste` is refused (`invalid_option`)
  before any registration, authorization or token request.
- An authorization endpoint with a `file:`, `smb:` or plain remote `http:` URL
  fails the login (`login_failed`): nothing is opened, printed or stored.
- A refresh in flight when the row is removed stores nothing (`closed`), and a
  removal under the lock waits for it; a refresh whose lock was broken as
  stale by a logout stores nothing and the logout stands; a token request that
  hangs is aborted at its timeout and stores nothing.
- The lock serializes holders, breaks a lock of a dead process and an old one,
  and times out on a live one. A waiter that judged a lock stale never takes
  away a live lock that replaced it, and leaves no file behind.
- No issued token appears in command output, prompts, the row, `ravi.db`, the
  credentials inventory, the environment or argv.
- CLI: the dry run connects to nothing; login inside a runtime turn or through
  the gateway is `CLI_ONLY_COMMAND`; flags are checked against the auth kind;
  an invalid `RAVI_MCP_CLIENT_METADATA_URL` is a usage error; a bearer login
  from stdin never prints the token; `logout` applies at once on a contact
  turn.

## Claude facade (`src/mcp/claude-facade.test.ts`)

- Tool names are exactly `mcp__<server>__<tool>`; `hostMcpServers` never holds
  a facade name; an overlapping name drops the gateway server for the query
  (the host wins), reports it to the session and records
  `runtime.mcp_name_overlap`; a throwing reporter does not fail the turn.
- An operator audience server is absent on a contact turn and denied at call
  time when the context changed after listing.
- A `timeout` argument does not extend the watchdog for facade tools; host
  and built-in tools keep it.
- Listing reads the cache only (no request reaches the server); calls go
  through the gateway with surface `claude`, the 240 s budget and the
  request's abort signal, and are traced; upstream annotations and `_meta`
  never reach the runtime; a tool error stays a tool error.
- No facade is built without a turn context or without a granted tool, or
  under a host server name; a gateway that is not running or a facade
  failure answers a tool error.
- The session holds no facade before the host prepares a turn; a turn that
  no longer grants a server drops it, and the hook then refuses its tools as
  unregistered. A granted facade tool passes the hook, an ungranted one is
  denied by name, and the same name from a configured source is refused.
- A schema that is not an object schema leaves the tool out of the listing.
- The adapter request lists host and gateway servers (`mcp_servers`), and
  `runtime.mcp_servers` records `match`, `mismatch` and `unreported`
  (`src/mcp/claude-facade.test.ts`,
  `src/runtime/runtime-request-builder.crash-recovery.test.ts`).
- The provider registers the turn's facades beside the host servers,
  reports the init list to the session, and fails a turn whose init lists an
  undeclared gateway name (`src/runtime/claude-provider.test.ts`).

## CLI pair (`src/cli/commands/mcp-call.test.ts`, `src/permissions/runtime-bootstrap-provider.test.ts`)

- Listing budget: servers take turns and the kept tools stay in stable order;
  the same tools in any order give the same cut; an entry larger than the
  bytes left is skipped and the next is kept; `omitted` counts per server and
  the note names the narrowing (`ravi mcp tools <server>`, `--query`) and is
  null when nothing was left out.
- Presentation (`src/runtime/tool-presentation.test.ts`): `mcp__docs__search_pages`
  is shown as `MCP docs: search_pages`, category `mcp`, argument names
  redacted and no value; the `mcp_call` dynamic tool names server and tool and
  keeps `--input` redacted; a name that only looks like an MCP tool takes the
  generic path. A shell call (`Bash`, `exec_command`, `command_execution`)
  whose command is provably one `ravi mcp call <server> <tool>`, bare or in
  one `zsh -lc '...'`, is shown the same way; without `--execute` its title
  ends in `(dry run)`, and `--agent` and `--wait` are named in the summary
  without their values; hostile lines keep the shell
  presentation: `;`, `&&`, `||`, `|`, `&`, redirections, `$(...)`,
  backquotes, variables, assignments, comments, newlines, globs, braces,
  subshells, a second wrapper, a word other than `ravi` (`./ravi`,
  `FOO=1 ravi`), an unknown or repeated flag, an invalid server or tool
  name.

- The authorization matrix through a real host CLI gateway socket, with
  `--execute` and without: audience on a contact's turn and on an
  unclassifiable turn, an ungranted tool, a tool name that cannot be exposed,
  not attached, not registered (exit 1), another agent named with `--agent`,
  disabled, and `needs_login` (exit 1, naming `ravi mcp login`); no denied
  call reaches the server.
- A context without the command grant is refused (`PERMISSION_DENIED`) before
  any MCP check; the bootstrap floor holds exactly `read:mcp.tools:list`,
  `mutate:mcp.tools:call`, `read:mcp.skills:read`, `read:mcp.calls:list` and
  `mutate:mcp.calls:cancel`, and no other `ravi mcp` command
  (`src/permissions/runtime-bootstrap-provider.test.ts`).
- A call on the operator's own turn returns text and structured content, and
  the `mcp.call` trace has surface `cli`; the full tool name is accepted; an
  image is reported by type and size, never its bytes; a tool error is a
  result (exit 0); a contact's turn calls a server widened to `any`.
- The `call` dry run (exit 3) prints argument keys, never values, and sends
  nothing; an invalid `--input` is exit 2 without quoting it; `--wait` is
  bounded and capped at 55 s as a runtime tool.
- `tools` lists granted tools in stable order with schemas, shows a contact's
  turn only what it may call with the unavailable servers and their codes,
  filters with `--query` and cuts descriptions at 1 KB.
- Pi's dynamic tool catalog holds `mcp_tools` and `mcp_call` only when
  `use:tool` grants them (never by an `mcp__` grant alone), and `mcp_call`
  runs in the daemon's gateway under the same check.
- From a terminal without a daemon both commands fail with
  `MCP_DAEMON_REQUIRED` and a message naming the daemon, and connect to
  nothing; with the daemon's socket and no credential they fail with
  `MCP_CONTEXT_REQUIRED`; with a credential they list, dry-run and call
  through the socket.
- A process with its own context and no transport, or with a runtime's
  env markers and no context key (a session's, `RAVI_TRIGGER_ID`, and the
  `RAVI_AUTOMATION_PRINCIPAL` of a shell cron, shell trigger or job), is
  refused with `MCP_NO_TURN` (exit 3) and forwards nothing; an empty or
  blank marker counts as one (`src/runtime/turn-origin.test.ts`); `ravi mcp
  login` in such a process is `CLI_ONLY_COMMAND`.
- The Bash guard refuses a default (bootstrap) agent and an agent that may
  run only `ravi` the shell forms that run `ravi mcp` without the markers: an
  assignment prefix that blanks them, `env -u`, `env -i`, `unset`, `sh -c` and
  `bash -c` wrappers, `exec -c`, `sh <script>`, an interpreter's inline code
  (`src/bash/hook.test.ts`). The bootstrap floor still runs `bun <file>` and
  `bun run <file|script>` (and git hooks) on what its file tools wrote, which
  can start `ravi mcp` without the markers; the test pins that as allowed for
  default and refused for the agent that may run only `ravi`, the one closed
  profile among the two.
- A daemon whose MCP gateway is stopped answers `MCP_GATEWAY_UNAVAILABLE`.
- A daemon socket that takes a `call` and drops the connection before
  answering gives `MCP_CALL_OUTCOME_UNKNOWN` with `retryable: false`, never a
  retryable `MCP_DAEMON_REQUIRED`; `tools` stays retryable.

## Elicitation (`src/mcp/elicitation.test.ts`, `src/channels/slack/mcp-elicitation.test.ts`, `src/mcp/claude-facade.test.ts`, `src/runtime/host-hooks.test.ts`, `src/approval/service.test.ts`)

- Accept (fields one by one, then the review), decline at the review, cancel
  on a timeout, a send failure, a wrong actor and a cancelled call; never
  content on any of them.
- A consent form (one required boolean) is one question with Sim and Não and
  no review: Sim accepts with the field `true`, Não declines; in the gateway
  the fixture's `deploy` confirmation asks one question.
- The questions of one round share its answer window: with the clock moving
  100 s per answer, the timeouts are 240 s, 140 s and 40 s and the next
  question is not sent (`cancel`).
- Cron, trigger, heartbeat, agent relay, operator relay, terminal, unknown,
  ended and delivery turns decline with nothing sent and no row.
- A contact turn on an oauth server, and on a stdio server with stored env
  keys, declines (`not_credential_principal`); a contact on an audience-any
  server with no credential is asked.
- A turn without a source, a Slack person who owns no Slack user in the
  workspace and a person without a direct chat decline
  (`no_private_surface`); a turn not authorized on the elicitation surface
  declines.
- Secret-looking fields, more than 8 fields, nested or array fields, a
  `pattern`, a non-https URL and a URL with userinfo decline before the turn
  is classified.
- An answer from another sender is ignored (through `requestPersonAnswer`
  with the operator's real direct chat).
- An ambiguous legacy request (two calls in flight on one stdio connection)
  declines without asking; one call in flight is answered.
- Answers are validated against `requestedSchema` (lengths, formats, ranges,
  integers, choices, required fields, no extra field); an invalid answer is
  asked again once, a second one cancels.
- Not enough budget left declines with nothing sent; each wait is bounded by
  the call's budget.
- URL mode shows the URL and its host on their own lines, accepts on consent
  with no content, and never fetches. A long message with a 2048-character
  URL is cut to fit one question and is sent; a URL whose parsed form passes
  2048 characters declines (`unsafe_url`).
- Through the real `requestPersonAnswer`, an enum choice longer than 100
  characters is cut to a label that is sent (never `send_failed`), and
  numeric labels ("5", "10", "1") are read by label before position.
- Approval rows and trace events hold field names, never values.
- A server message, title and description that imitate Ravi's lines (its
  opening line, the review line, the answer line) reach the person only as
  quoted lines (`> `) or one-line labels in quotation marks: Ravi's opening
  line is first, its answer line last, blank runs collapse, and a long
  message is cut with an ellipsis line while the consent label still shows.
  This holds when the server separates lines with U+2028, U+2029 or U+0085
  (in the message, a description or the consent label): split at every such
  break, each line is still quoted, and no bidi control reaches the person.
  The Slack card and modal keep the server's message in its own plain-text
  block, quoted, and no other block has a line starting with `>`.
- The Claude facade hands the session's approval wait lease to the gateway
  (read at call time), and a server's question answered through the daemon
  gateway on a turn's facade holds the streaming session's
  `externalApprovalWait` (begin, then end).

### The Slack modal

- A Slack turn asks once, through the modal, and never as chat; a turn on
  another channel never asks the modal.
- The stored row carries the bound user, the person, the approval row and the
  planned fields, and no value of an answer.
- The daemon refuses a surface Slack never issues (a user or chat id outside
  the grammar) with nothing stored and nothing sent.
- Only the bound Slack user opens the card; another user gets a private
  notice, an expired or unknown request opens nothing, and a second open is
  refused.
- Block mapping for string, number, boolean and enum fields (bounds, options
  by position, optional fields), and a URL modal that shows the URL and its
  host and offers no input.
- A submission is typed and bounded by the stored plan; an invalid field
  answers `response_action: errors`, publishes nothing and leaves the request
  open.
- A submission from anyone but the bound user publishes nothing, leaves the
  request opened and answers with the closed-request view; the store's claim
  refuses another user (`BINDING_MISMATCH`).
- One answer per request: the row is claimed before the publish, a replay
  publishes nothing, a closed modal publishes a decline, and a failed publish
  tells the person nothing was sent.
- The daemon ignores an event the row does not prove (another user, another
  request, a status nobody claimed) and then times out; a timeout, a
  cancelled call, an undelivered card and content outside the plan answer
  `cancel`, never content.
- The Socket Mode service routes an MCP elicitation envelope to this handler
  before the generic interaction pipeline.
- A trigger on `ravi.mcp.>` or `ravi.>` never fires on
  `ravi.mcp.elicitation.answer`, and a trigger on a `ravi.mcp.elicitation.*`
  topic is a blocked topic (`src/triggers/__tests__/runner-owner.test.ts`).

## Person-bound answers (`src/approval/service.test.ts`, `src/approval/store.test.ts`)

- A reply or a poll vote from another sender is ignored and counted; the
  person's own reply answers; a reply through another account is ignored.
- A send failure is `send_failed` (`delivery_failed`, or `no_message_id`) and
  carries no error text; nothing is subscribed.
- Timeout with nothing received, and timeout when only others answered.
- A poll is numbered text on channels without attributed votes (answered by
  label or number, an exact label first), and a native poll only on a channel
  listed as delivering attributed votes.
- An option longer than 100 characters or a question longer than 4000 is
  `send_failed` (`invalid_request`) with nothing sent; an option of exactly
  100 is sent.
- A group, a thread, another person's chat, an unknown or a blocked contact is
  `wrong_actor` with nothing sent; Slack and malformed requests are
  `send_failed` with nothing sent.
- Direct-chat target resolution for WhatsApp (instance name and instance id,
  never another instance, never a group or a shared chat) and Slack (same
  workspace only).
- An `elicitation` row needs its detail, drops any extra key, refuses a field
  name that is not a plain name and a URL-mode row with fields, is settled
  with the action only, and is never decided by a reply or claimed by
  `claimApprovalDecision`.

## Background calls (`src/mcp/call-follower.test.ts`)

Against the task fixture with a fake clock and direct ticks:

- A task call detaches (outcome `detached`, a `mc_` id, the handle text names
  `ravi mcp calls cancel`, says the server decides whether its work stops and
  never promises a stop), is not polled before its interval, then is polled
  and delivered once on the session queue: message id `mcp-call:<id>`, barrier
  `after_response`, marker `_mcpCall`, the result inside the data block. Later
  ticks, a second follower and a late settle deliver nothing more.
- A failed task, a tool error (`isError`) and a task the server cancelled are
  delivered with outcomes `error`, `tool_error` and `cancelled`.
- TTL expiry ends the call `expired` without another poll; a task the server
  no longer knows (`-32602`) is `expired`.
- HTTP 429 backs off until `Retry-After`, never fails the call, and is
  reported by `mcpServerCallSummary`; the per-server poll budget defers the
  extra polls; a `-32022` poll probes the row again.
- One back-off per server on the raw dispatch: a 429 on a call answers "30 s"
  with the call sent once and the row `ok`; 10 s later a call answers "20 s"
  with nothing sent; after it a call goes through. A 429 an inline call got
  holds the follower's polls until it ends. A 429 on `server/discover` is a
  back-off (nothing more sent in that connect, the row stays `modern` and
  `ok`), never a legacy verdict.
- A step-up (403 `insufficient_scope`) on a raw call answers `error` naming
  the scope and the remedy, the row stays `ok` and the next call works; on a
  poll the call stays `task` with "lacks a scope" and the row stays `ok`.
- Cancel sends `tasks/cancel` then exactly one `tasks/get` and records
  `cancelled`; with a server that completes anyway it records the result and
  the note. With the poll budget spent by the cancel, the call stays `task`
  with the acknowledgement stored; a 429 on the read backs off; the read then
  records `completed` with the result, and `tasks/cancel` was sent once.
- A task that asked for input more than 4 times gets `tasks/cancel` and one
  more `tasks/get`, and is delivered `error` with that reason.
- A server removed and registered again under the same name receives nothing
  of the old call (discarded); a deleted agent's open call ends `failed`
  (`discarded`) at once, and an agent created again with that id gets no
  request sent and no delivery.
- A removed server: no request is sent and the delivery holds a note, no
  content; a server detached after the result was stored: the content is
  discarded at delivery.
- Late input reaches the elicitation handler with the origin context and is
  answered through `tasks/update`; when the origin turn names another person,
  had no person, or its context is gone, the handler gets no context and the
  server receives a decline. With the real turn classifier, a live origin
  context names the origin person and a revoked one (the turn ended) names
  nobody, so the question is declined.
- While one task waits for a person's answer, another due task is polled and
  delivered. `stop` during that question, and during a hanging poll, returns
  within a second: the request is aborted, nothing is sent, and the row is
  given back (the round is not counted).
- A kept request (budget detach) whose server asks after the detach: the
  question carries the origin context while the origin turn still names the
  person, and no context (declined) when the person changed or the context is
  gone. The approval wait lease is ended once at detach; the handler's later
  `begin` and `end` do not reach it.
- An HTTP 429 on the SDK call path answers an error that names it and is
  recorded with method `tools/call`.
- Restart: a task resumes on a new follower; a `running` row of the old run is
  delivered `lost` ("outcome unknown").
- A refused delivery is retried on its schedule with the same message id, and
  ends `failed` after the last retry.
- Budget: a slow non-task call detaches at its budget and its late result is
  delivered; a cancel request aborts a kept request (`cancelled`); without a
  follower or a session the budget is a timeout.
- The delivery prompt keeps remote text in one capped block that cannot be
  closed early.
- A delivery-turn context (`automation:mcp-call:<id>`) is denied an
  operator-audience server (`audience`), while a heartbeat context on the same
  row passes.

Elsewhere: `src/runtime/runtime-request-context.test.ts` (the delivery turn's
principal is `automation:mcp-call:<id>` even when the session's source names
a person; a malformed id is `automation:mcp-call:invalid`),
`src/runtime/delivery-queue.test.ts` (the marker survives a continuation),
`src/runtime/daemon-restart-resume.test.ts` (never resumed),
`src/knowledge/turn/audience.test.ts` (audience `none`),
`src/mcp/claude-facade.test.ts` and `src/cli/commands/mcp-call.test.ts`
(both surfaces ask to detach and pass the handle and call id on),
`src/mcp/registry-db.test.ts` (the `mcp_calls` and `mcp_server_rate_limits`
tables).

## Raw dispatch (`src/mcp/raw-dispatch.test.ts`, `src/mcp/input-loop.test.ts`)

Against `src/mcp/test-fixtures/task-server.ts`: hand-written tasks on server
2.4.0 (as SDK probe b4), answering like the Console as built (no `content` on
`task` and `upload_required`, a cancel that may still complete).

- Every request carries the modern headers and the envelope from the SDK
  constants; the capabilities hold `tasks: {}` and `files: {upload: {}}` only
  for an uploads attachment of a server that advertises it.
- `Mcp-Name` mismatch is `-32020`, a missing tasks capability `-32021` (no
  task created), a foreign revision `-32022`, all with the outcome known.
- `ping`, `initialize` and a name that is not a header value are refused with
  nothing sent.
- Task results are read with and without `content`; `tasks/get` is polled
  until `completed`; a tool error is `completed` with `isError`; a failed task
  carries its error; an unknown task is `-32602`; `upload_required` is read
  without `content`; an unknown result type is unreadable with the outcome
  unknown.
- A task's late input is answered through `tasks/update`; a cancel is
  acknowledged and the next `tasks/get` reports `cancelled`, or `completed`
  when the server had committed the work.
- SSE: the answer is read past comments and notifications, split across
  chunks with CRLF line ends; a stream without the answer is unreadable.
- 401 refreshes once and the call is sent again; a second 401 and a bearer
  row's 401 are `needs_login` with no further send; 429 is `rate_limited`
  with `Retry-After` (60 s when absent) and is sent once; `insufficient_scope`
  is apart from a plain 403; 5xx and `-32603` are outcome unknown and keep
  only an identifier data code; a redirect is not followed; an oversized
  answer, a timeout and a cancel after sending are outcome unknown, a cancel
  before sending is not; no error text carries the URL token or the bearer.
- The shared loop: an accepted form retries with the byte-exact
  `requestState` and the same capabilities and ends in a task; a decline
  changes nothing; the gateway's answer step reaches its elicitation handler
  with the call scope; the round limit, an unsupported embedded request
  (refused before anyone is asked) and a spent budget stop the call.
- Selection: only modern HTTP rows not pinned to legacy whose server declares
  tasks or `files.upload`; a dispatcher for a row is built from the stored URL
  (a mismatch refused) and login (none: `McpLoginRequired`).

## Skills (`src/mcp/skills.test.ts`)

Against a skills fixture server (SDK 2.4.0 skills extension), through a real
host CLI gateway socket:

- `skills list` returns manifests and ids and sends no `resources/read`.
- `pin` without `--execute` exits 3 with the plan (`fetchesFiles: false`) and
  stores nothing; with `--execute` it pins; neither sends `resources/read`.
  The stub is in the agent's `all` plugin, not its `external` one, and holds
  no remote instruction text.
- `pin` is refused on a contact turn without the grant (`PERMISSION_DENIED`)
  and with it (`OPERATOR_TURN_REQUIRED`, exit 3); a stale `--digest`
  (`MCP_SKILL_MANIFEST_CHANGED`), a dynamic resource list
  (`MCP_SKILL_DYNAMIC`) and an entry whose Library reference matches a
  Library pin of the agent (`MCP_SKILL_LIBRARY_DUPLICATE`) are refused.
- `read` returns `SKILL.md` and a named file, the second read from the cache;
  a `--file` with traversal exits 2 with no network call.
- On a bearer row, a 403 `insufficient_scope` to `skills/get` and
  `resources/read` fails `pin` and `read` with `MCP_SKILLS_SCOPE_MISSING`; the
  row stays `ok` and a tool call on it succeeds. A 429 to `skills/get` fails
  with `MCP_SKILLS_RATE_LIMITED` and is recorded with that method.
- Bytes that miss the manifest refuse the read
  (`MCP_SKILL_DIGEST_MISMATCH`) and mark the pin stale; a changed manifest
  marks the pins of both agents stale, `list` reports them, and a new pin
  restores the state.
- `read` of a pin for the operator's own turns is refused on a contact turn
  (`MCP_SKILL_EXTERNAL_DENIED`, exit 3) and allowed once `--external`; an
  operator-audience server is refused by `authorizeMcpUse` (`MCP_AUDIENCE`); an
  unpinned id is `MCP_SKILL_NOT_PINNED`.
- The Library gate admits a pin on the operator's turn, denies it on a contact
  turn unless external, to another agent, and once its server is disabled; an
  external pin reaches the allowlist and the session plugins.
- A Console Library sync keeps the MCP pins and their stubs; `unpin` rebuilds
  the plugin without the stub; a Library pin with the same plugin name keeps
  the stub out.
- `detach` and `remove` drop pins; `unpin` from the agent's own contact turn
  applies, naming another agent is refused.
- Pure checks: ids from the URI path, traversal refused, plugin names at most
  64 characters with a hash on a collision, a manifest digest independent of
  file order, and a stub with a cleaned, quoted description.
- Reconciliation with the listing: an unpublished skill's pins (two agents)
  go stale `gone` on `skills list`, the stub leaves the plugin, the pins are
  shown in `unlistedPins` and by `ravi mcp show` with state and reason, and
  publishing the approved bytes again restores both (`restoredPins`) with no
  new pin.
- The skills switch off then on: the empty listing changes no pin
  (`pinCheck: "empty_listing"`); a read in between finds the skill gone
  (the message says gone, not changed) and marks both pins gone; the
  daemon's refresh (`refreshSkillPins`) restores them once the approved
  manifest is listed again, and a read works; each automatic change is traced
  (`mcp.skill`, `op: "pin_state"`) with its reason.
- A manifest changed then restored to the approved bytes stays
  `manifest_changed`; a gone pin listed on another manifest becomes
  `manifest_changed` and is not restored by the approved bytes either.
- An empty first page with a cursor: the walk reads both pages and marks
  nothing; the refresh does the same.
- The refresh sends no `skills/list` while the server's back-off holds or
  while the stored grant lacks the advertised skills scope, and one walk per
  server for the pins of two agents.
- `skills list --limit 1 --offset 0` returns one skill, `total` 2 and the
  next command; `--limit 0` exits 2; from a terminal the paging goes through
  the forwarding to the daemon.
- A stored grant without the advertised skills scope: the listing succeeds
  with `scopeMissing: true`, `pinCheck: "scope_missing"` and a
  `suggestedAction` naming the scope and `ravi mcp login docs --execute`, and
  no pin changes. `mcpSkillsScopeStatus` reports missing only for a grant
  that names its scopes and a server that advertises a skills scope.
- `skills list` on a contact's turn (audience `any`) is
  `OPERATOR_TURN_REQUIRED`, exit 3, and sends nothing.
- `pin --external` on an operator-audience attachment: the plan and the
  result carry one warning naming `MCP_AUDIENCE` and `ravi mcp set docs
  --audience any --agent main --execute`; without `--external`, none.
- `mcp:<server>:<path>/SKILL.md` is the id of `<path>` for `parseMcpSkillId`,
  `mcpSkillUriFromArg` (id and bare path) and `read`.
- A cached read returns the same `mimeType` as the fetched one.
- `mcp.skill` read events: fetched and cached reads with file, bytes and
  source; `MCP_SKILL_EXTERNAL_DENIED` and `MCP_AUDIENCE` as `denied`; a
  changed manifest as `MCP_SKILL_STALE:manifest_changed`; no skill text in
  any event.

## Uploads (`src/mcp/files.test.ts`)

- Against a draft-shaped fixture (`src/mcp/test-fixtures/files-server.ts`):
  the files catalog lists `files` only for an attachment with uploads on, and
  neither variant shows `x-mcp-file`; preview, form confirmation,
  `upload_required`, uploads with exactly the listed headers to the pinned
  address, and one retry with the same arguments and `requestState` only.
  A size-0 file is not uploaded. A retry that answers a task detaches, and
  the follower's polls declare the files extension. A file call that cannot
  detach (no follower, or detach not asked) against a tasks-declaring server
  declares no tasks on any of its requests and gets the result inline.
- Unsupported marker shapes drop the tool; the rewritten schema carries no
  marker.
- Targets refused: non-https, userinfo, IP literal, `credentials` other than
  `omit`, a credential or routing header, a path, an unknown file, an
  expired target; a name resolving to any private address; a redirect fails
  the upload. Signed `x-amz-meta-*` headers pass. No retry follows a refused
  or failed upload.
- `isPublicMcpUploadAddress` refuses private, loopback, link-local, CGNAT,
  NAT64, documentation and mapped private addresses.
- The default transport pins the checked address, checks TLS by name and
  returns a redirect as is (when `openssl` is present); storage sees exactly
  the listed headers plus `accept`, `content-length`, `host` and
  `user-agent: Ravi`, and no authorization or cookie.
- Gate A: outside the workspace (a path, a symlink, `..`), a provider
  configuration, a hard link, the state directory (also for a turn that may
  read anywhere), Read denied, too large, an artifact id, not a file, too
  many files, a directory swapped for a symlink between the decision and the
  open; refusals never echo a resolved outside location. Gate B: flag
  off, remote agent; a legacy server gets no files catalog. No request
  reaches the server when a gate refuses.
- A retry with an unknown outcome, and one refused with -32602, are never
  sent again. A retry answered 429 says nothing ran, with the back-off, and
  never that the upload is used up (`src/mcp/files.test.ts`). -32021 with `requiredCapabilities` is reported with the
  uploads hint.
- The trace has counts and sizes only; nothing of the target, state, bytes
  or paths reaches the trace or the result.
- `mcp_elicitation_requests` rows settled or expired more than a day ago are
  pruned (`src/mcp/registry-db.test.ts`), also by the Slack insert, which
  keeps younger ones (`src/channels/slack/mcp-elicitation.test.ts`).
- `ravi mcp show` reports `uploadCatalog`, `skills` and `warnings`; `attach`
  warns about an agent on Claude whose materialized ceiling lacks
  `use tool:ToolSearch` (an `explicit-only` agent without the grant), and not
  about a default agent, with no injected checker;
  `set --uploads on` refuses a remote-spawn agent
  (`src/cli/commands/mcp.test.ts`).
- The Library plugin write lock serializes the Console sync and the MCP pin
  rebuild, waits for a live holder, and breaks a dead or stale one
  (`src/library/pins.test.ts`).

## Commands

```bash
RAVI_STATE_DIR="$(mktemp -d)" ./bin/ravi specs sync --json
bun test src/mcp/
bun test src/events/topic-registry.test.ts
bun test src/cli/commands/mcp.test.ts src/cli/commands/mcp-call.test.ts src/cli/execute-consumers.test.ts
bun test src/permissions/runtime-bootstrap-provider.test.ts
bun test src/cli/commands/doctor.test.ts
bun test src/mcp/oauth-provider.test.ts
bun test src/mcp/skills.test.ts src/library/ src/runtime/library-turn-skills.test.ts
```
