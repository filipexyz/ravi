---
id: plugins/locations
title: "Plugin Locations"
kind: capability
domain: plugins
capability: locations
tags:
  - plugins
  - filesystem
  - discovery
applies_to:
  - src/plugins/index.ts
  - src/plugins/internal-loader.ts
  - src/skills/manager.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Plugin Locations

## Intent

This capability defines the canonical filesystem locations for Ravi plugins, who owns each location, and what the runtime is allowed to do at each path. It is the contract a Ravi build, an operator install, and (later) an agent-local extension all agree on.

## Canonical Paths

### Internal plugins (binary-shipped)

- **Path:** `~/.cache/ravi/plugins/.snapshots/<artifact-digest>/<plugin-name>/`
- **Owner:** Ravi runtime.
- **Lifecycle:** Materialized from the embedded `internal-plugins.json` artifact into an immutable content-addressed snapshot. Identical artifacts reuse the same complete snapshot; changed artifacts publish a new one.
- **Edits:** MUST NOT be edited manually. A process may retain its resolved snapshot path for the lifetime of a session.
- **Examples:** `ravi-system`, `ravi-dev`.

### User plugins (operator-installed)

- **Path:** `~/ravi/plugins/<plugin-name>/`
- **Owner:** Operator.
- **Lifecycle:** Persists across restarts.
- **Edits:** Operator MAY edit at any time. Changes take effect on the next session start (no hot reload contract today).
- **Default container:** `ravi-user-skills` is the reserved plugin name for operator-installed skills with no domain-specific home.

### Per-agent local plugins (PROPOSED)

- **Path:** `<agent-cwd>/.ravi/plugins/<plugin-name>/`
- **Status:** Not implemented in the current discovery code. Specified here as the target for the `runtime-sync` capability.
- **Intent:** Plugin scoped to a single agent's working directory. Active by default for that agent only; invisible to others.
- **Why this path shape:** keeps plugin packaging consistent (`.claude-plugin/plugin.json` + `skills/`) regardless of scope; only the discovery root changes.

## Rules

- Plugin discovery MUST resolve embedded internal plugins from their complete content-addressed snapshot, then scan `~/ravi/plugins/` for user plugins, in that order.
- Discovery MUST require `.claude-plugin/plugin.json` at the plugin root. Directories without a manifest MUST be silently skipped at debug log level.
- The runtime MUST NOT delete user plugins under `~/ravi/plugins/` as part of any automatic operation.
- Internal snapshots MUST be assembled in a private staging directory and exposed only through an atomic publish after all files and the completion marker exist.
- The runtime MUST NOT overwrite or remove a published snapshot in the discovery hot path. Cleanup requires a separate mechanism that can prove no live process or session still references the snapshot.
- Operators MUST NOT use `~/.cache/ravi/plugins/` as durable storage.
- Per-agent local plugin discovery MUST be opt-in and explicit. Until `runtime-sync` is implemented, no code path SHOULD scan `<agent-cwd>/.ravi/plugins/` for plugins.
- Plugin names MUST be slugified consistently across the codebase using the `slugifySkillName` rules (lowercase, alnum, dot, dash, underscore).

## Acceptance Criteria

- `discoverPlugins()` returns internal plugins first, then user plugins, with consistent ordering across runs.
- Two processes publishing the same embedded artifact concurrently MUST return the same complete snapshot path without exposing staging contents.
- A process using snapshot A MUST continue reading it successfully while another process publishes snapshot B.
- An empty `~/ravi/plugins/` MUST cause `getUserPlugins()` to return `[]` without errors and without creating the directory.
- A malformed user plugin (missing manifest, invalid JSON) MUST NOT crash discovery. It MUST be skipped with a logged warning carrying the path.
