---
id: plugins/external-cli
title: "Plugin External CLI"
kind: capability
domain: plugins
capability: external-cli
tags:
  - plugins
  - cli
  - subcommand
  - integration
  - context-keys
applies_to:
  - src/plugins/index.ts
  - src/cli/commands
  - src/runtime/runtime-request-context.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Plugin External CLI

## Intent

`external-cli` defines how a plugin can ship an executable that the Ravi top-level CLI exposes as a first-class subcommand. The capability turns the Ravi CLI into an extension surface: any plugin — written in Bun, Python, Go, Rust, bash — can register a binary and become available as `ravi <name> ...` without modifying the core.

The capability exists because today every domain CLI in Ravi (sde tools, ads tools, sampaio CLI, etc.) lives outside the core and is invoked indirectly. Operators have to remember separate binary names, agents must learn each one, and there is no canonical contract for how a third-party CLI receives session context. Formalizing the contract turns the plugin system into the same kind of extension surface that `kubectl` plugins or `git` extensions provide, while reusing the existing `RAVI_CONTEXT_KEY` mechanism.

## Model

A plugin opting into this capability declares a `cli` block in its manifest (`.claude-plugin/plugin.json` for embedded plugins, `plugin.json` for user-installed plugins). Schema:

```json
{
  "name": "ravi-music",
  "version": "0.1.0",
  "cli": {
    "name": "music",
    "binary": "./bin/ravi-music",
    "language": "bun",
    "description": "Plays music and manages playlists",
    "subcommands_help": "ravi-music --help"
  }
}
```

- **`cli.name`** — the subcommand the user types after `ravi` (e.g. `ravi music play "track"`). MUST be unique across associated plugins; collisions are rejected at plugin load.
- **`cli.binary`** — relative path to the executable inside the plugin directory. The runtime MUST resolve this to an absolute path at registration time and reject if not executable.
- **`cli.language`** — informational tag (`bun`, `python`, `go`, `rust`, `bash`, etc.) used for diagnostics and tooling. Not used for execution.
- **`cli.description`** — one-line description shown in `ravi --help`. MUST be ≤120 chars.
- **`cli.subcommands_help`** — optional command the runtime invokes to list subcommands when the user runs `ravi <name> --help` without further args. If absent, the runtime spawns the binary with `--help` directly.

The Ravi CLI MUST discover all `cli` declarations from associated plugins (see `plugins/locations`, `plugins/runtime-sync`) at startup and register them as dispatchers. Invocation flow:

```
ravi music play "track"
    ↓
Ravi CLI resolves "music" → plugin "ravi-music" → binary path
    ↓
Ravi runtime issues a child context (RAVI_CONTEXT_KEY)
    ↓
Spawn binary with: argv = ["play", "track"], env = { RAVI_CONTEXT_KEY: ..., PATH: ... }
    ↓
Binary runs, exit code propagates back to Ravi CLI
```

## Spawn Protocol

- The runtime MUST spawn the plugin binary as a child process. Direct stdio passthrough (stdin, stdout, stderr) is mandatory unless the plugin opts into a captured mode for telemetry.
- The runtime MUST inject `RAVI_CONTEXT_KEY` into the child env. The plugin binary uses the canonical sub-CLI surface (`ravi context whoami`, `ravi context check`, `ravi context authorize`) to resolve identity and capabilities (see `runtime/context-keys`).
- The runtime MUST NOT inject `RAVI_AGENT_ID`, `RAVI_SESSION_KEY`, or `RAVI_SESSION_NAME` into the child env. Identity is resolved through the context key, never through ambient env. (This rule mirrors `AGENTS.md` guidance for CLIs externos integrados ao Ravi.)
- The runtime MUST forward the parent process exit code from the child. Non-zero exits MUST surface a structured error event with the plugin name, subcommand, and argv (with sensitive args redacted per plugin manifest if declared).
- Working directory of the spawned process MUST default to the caller's CWD, not the plugin directory, so plugin binaries operate on operator artifacts (modelo do gh/git plugins).
- Signal forwarding (SIGINT, SIGTERM) from parent to child MUST be implemented so Ctrl-C works as expected.

## Naming and Resolution

- Subcommand names MUST match `^[a-z][a-z0-9-]*$` and be ≤32 chars. The Ravi CLI MUST reject manifests with invalid names.
- The Ravi core reserves a stop-list of names that plugins MUST NOT use: `agents`, `contacts`, `context`, `cron`, `events`, `permissions`, `plugins`, `routes`, `sessions`, `skills`, `specs`, `tasks`, `triggers`, and any future top-level core surface. The stop-list is canonical; updating it is a spec change.
- Two plugins declaring the same `cli.name` is a hard conflict. Resolution: the runtime MUST refuse to load the second plugin and report the conflict to the operator.
- A subcommand registered by an external CLI plugin MUST NOT shadow a core Ravi command. The stop-list enforces this at registration; the runtime MUST also re-check at dispatch time so a core update that adds a new top-level command displaces a stale plugin name with a clear error.

## Lifecycle

- **Install** — plugin arrival (via `plugins/runtime-sync` or operator copy) triggers manifest parsing. If `cli` block is valid, the subcommand is registered for the next Ravi CLI invocation. No process restart required for plugins under user-installed paths; embedded plugins are static.
- **Upgrade** — newer plugin version with same `cli.name` replaces the prior registration. The runtime MUST emit a structured event citing old and new versions.
- **Uninstall** — removing the plugin removes the subcommand from registration. Calls to the now-absent subcommand MUST return a structured error suggesting the plugin was uninstalled.
- **Health check** — `ravi plugins doctor` (or equivalent) MUST execute `<binary> --version` (or another declared health check) per plugin and report binaries that are missing, non-executable, or returning non-zero on the health probe.

## Rules

- A plugin without a `cli` block is unaffected by this capability. The capability is opt-in.
- The runtime MUST NOT execute plugin binaries during discovery — only during user invocation. Discovery MUST be metadata-only (parse manifest, resolve path, check permission, no spawn).
- The runtime MUST audit each external CLI invocation as a structured event: plugin, subcommand, argv hash, duration, exit code. Argv content MUST be redacted by default unless the plugin manifest opts in to argv logging.
- A plugin manifest with a `cli` block but no `binary` file at the declared path MUST fail to register and surface a clear error citing the missing file.
- Versions of the plugin protocol are tracked via a `cli.protocol_version` field (current: `1`). Plugins targeting a future protocol MUST be loadable at older versions in degraded mode (subcommand registered, capabilities the runtime does not understand are ignored with warnings).

## Interaction with Other Capabilities

- `runtime/context-keys` — the spawn protocol depends on the context-key surface. Any change to context-key semantics ripples to plugin authors.
- `plugins/runtime-sync` — sync resolves which plugins are associated with the agent and triggers external-CLI registration. A plugin not in the active set is not registered as a subcommand.
- `runtime/transforms` — a plugin can ship transforms AND an external CLI in the same manifest. Both register independently. A subcommand invocation does NOT pass through the transform pipeline (it is a direct user/operator invocation, not a tool call); transforms only apply to in-session tool calls.
- `permissions` — the runtime MUST verify the agent has permission to invoke the subcommand before dispatching. The default permission key is `cli:<plugin-name>:<subcommand>`; plugins MAY declare more granular keys in the manifest.

## Failure Modes

- **Binary missing at dispatch time** — race between manifest registration and uninstall. Runtime MUST report a structured error and suggest `ravi plugins doctor`.
- **Binary panics or returns nonsense** — captured by exit code propagation and event emission. Operator can audit via `ravi events errors`.
- **Long-running subcommand blocks the CLI** — plugins are spawned in the foreground; this is by design (operator/agent waits for completion). Plugins that need background execution MUST implement their own daemonization and document it.
- **Plugin tries to use ambient env vars** — runtime MUST NOT silently provide `RAVI_AGENT_ID` or other agent-scoped env. If a plugin reads them anyway, it gets undefined; documentation MUST state this explicitly.
- **Stop-list collision** — plugin tries to register a name in the reserved stop-list. Runtime MUST refuse load and emit a hint with the canonical alternative name pattern.

## Acceptance Criteria

- A plugin declaring `cli.name = "music"` and a valid binary becomes invocable as `ravi music ...` after sync, without restarting the Ravi daemon.
- The spawned binary receives `RAVI_CONTEXT_KEY` in env and resolves identity via `ravi context whoami` successfully.
- The spawned binary does NOT receive `RAVI_AGENT_ID`, `RAVI_SESSION_KEY`, or `RAVI_SESSION_NAME`.
- A second plugin attempting to register the same `cli.name` fails to load with a structured conflict error citing the first plugin.
- Stop-list violation (plugin trying `cli.name = "sessions"`) fails to load with a clear error.
- `ravi plugins doctor` reports broken binaries (missing, non-executable, non-zero health probe) without affecting unrelated plugins.
- Each external CLI invocation appears in `ravi events` with plugin name, subcommand, and exit code.
