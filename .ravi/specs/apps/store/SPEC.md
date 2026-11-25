---
id: apps/store
title: "Ravi Apps Store"
kind: capability
domain: apps
capability: store
capabilities:
  - install
  - signed-index
  - receipts
  - exposure
  - blocking
tags:
  - apps
  - store
  - marketplace
  - supply-chain
applies_to:
  - src/apps/store/
  - src/apps/service.ts
  - src/apps/router.ts
  - src/apps/permissions.ts
  - src/permissions/provider-config-paths.ts
  - src/cli/commands/apps-store.ts
  - src/daemon.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi Apps Store

## Intent

Let the operator install Ravi apps from one trusted source, the official index
at `filipexyz/ravi-apps`, so that installing an app never widens what an agent
can do without the operator's explicit, per-agent decision.

## Invariants

### Trust

- The official source's root public keys MUST be compiled into Ravi. Nothing in
  the environment, state or the index MAY add a trusted root.
- `keys.json` MUST verify against a root key; `index.json` against a
  publication key it lists; `blocklist.json` against a block key it lists (or a
  publication key when it lists none). Signatures are detached Ed25519 over the
  exact file bytes.
- Every signed file MUST carry a serial and an expiry. A refresh MUST refuse a
  serial lower than one already accepted, a changed file with the same serial,
  and an expired file. `index.issuedAt` more than a day ahead MUST be refused.
- Fetches MUST be HTTPS (loopback HTTP only for tests), refuse redirects, send
  no credentials and cap sizes. The cache MUST be verified again when read.

### Package and classes

- A package is UTF-8 text files only: no dot files, no symlinks, at most 100
  files, 256 KiB each and 1 MiB in all, with `ravi.app.json` at the root. Its
  tree hash is the Library content hash.
- The class MUST be derived from the manifest, never declared. `compose`: every
  executable command is `ravi`, its target (resolved from the static tokens
  before `{args}`) is a registry command that is not `@CliOnly`, has an access
  contract and is outside the administration groups; a target that mutates, or
  a literal `--execute`/`--apply`, requires `mutating: true`; builtins are
  limited to the manifest readers. Anything else is `code`.
- The official index MUST list only `compose` apps. A local `code` app needs
  `--allow-code`.
- A published version MUST NOT change: a rebuild with other files for the same
  version MUST fail.

### Install

- `install`, `update`, `rollback`, `allow` MUST be `@CliOnly`, dry-run by
  default (exit 3) and act only with `--execute`. `uninstall` and `revoke`
  reduce authority and act immediately. All of them, and `apps index *`, MUST
  refuse a runtime context (agent turn, gateway, or `RAVI_*` session env) with
  `APP_STORE_OPERATOR_ONLY`, exit 3.
- Installing MUST check the bundle's size and SHA-256 against the index, the
  tree hash, the manifest id and version, and that the derived class and grants
  equal the ones the index shows.
- An id that another source already declares MUST NOT be installed.
- An update MUST wait 24 hours after `publishedAt` unless the version is marked
  `security` or the operator passes `--now`. When the grants change, exposure
  MUST be cleared.
- The store keeps the current and two previous package trees; rollback MUST
  refuse a blocked version.

### Exposure

- Installing MUST expose the app to no agent. Only `ravi apps allow <id>
  --agent <agent> --execute` exposes it.
- For an agent caller, a store app that is not exposed to that agent, or is
  quarantined, MUST be denied before any grant is consulted, including
  `full-access` and `use:app:*`.

### Discovery and run

- Once the store has written (its `sideloaded.json` baseline exists), a state
  app without a receipt that was not in the baseline MUST be invalid.
- A store app MUST live at `$RAVI_STATE_DIR/apps/<id>/`; a quarantined one is
  invalid.
- Before every run of a store app the router MUST check the tree hash against
  the receipt and the cached block list, and refuse on any mismatch.
- Agent file-write tools MUST NOT write `$RAVI_STATE_DIR/apps` or
  `$RAVI_STATE_DIR/app-store` without break-glass.

### Blocking

- The daemon MUST refresh the official source every 6 hours while an official
  app is installed and quarantine every installed version the block list names.
  A failed refresh keeps the last verified list.

## Boundaries

- Third-party sources, private sources and the Console mirror are out of scope.
- `connector` apps (core HTTP executor holding the secret) are reserved and
  refused in this release.
- Shell writes by an agent with a free shell are not covered; that needs an OS
  sandbox (see apps/router).
