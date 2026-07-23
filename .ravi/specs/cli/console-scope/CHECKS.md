---
id: cli/console-scope
title: "Console Scope Defaults - Checks"
kind: capability
domain: cli
capability: console-scope
status: draft
normative: false
owners:
  - ravi-dev
---

# Checks

## Unit Coverage

- Cloud-auth profile store:
  - migrates legacy `credentials.json` into one active profile;
  - stores at most one active profile per Console URL;
  - keeps profiles isolated by organization id/slug;
  - refresh writes only the selected profile;
  - logout deletes only the selected profile unless `--all` is requested;
  - profile list JSON redacts access tokens and refresh tokens.
- Resolver order:
  - explicit input wins over all defaults;
  - runtime context wins over session/agent/workspace/global;
  - runtime context organization can select only an already-approved profile;
  - explicit local Project Console mapping can be used only when runtime
    context identifies the active local Project;
  - session wins over agent;
  - agent wins over workspace;
  - workspace wins over global;
  - credentials supply organization only when no richer scope exists.
- Missing project for project-required commands returns `PAYLOAD_INVALID` with a
  next command.
- Remote `PROJECT_ACCESS_DENIED` and `ORG_ACCESS_DENIED` are preserved.
- A local Project slug is never accepted as a Console project ref unless an
  explicit Console mapping exists.
- A local Project mapping reports `source="local_project_mapping"` in explain
  output.
- `RAVI_PROJECT` compatibility works but is lower priority than explicit input
  and runtime context.
- Scope JSON output never includes access tokens, refresh tokens, context keys,
  WorkOS tokens, or provider secrets.
- Scope defaults are keyed by organization. The same session key can have one
  default for org `luis` and a different default for org `rbbt`.

## Runtime Coverage

- Runtime context metadata includes `consoleScope` when a default resolves.
- Child CLI with only `RAVI_CONTEXT_KEY` resolves the same scope.
- Refreshing a reused `agent-runtime` context updates `consoleScope` metadata
  when the session default changes.
- A runtime context with local Project `rbbt` and no Console mapping fails
  project resolution instead of guessing remote project `rbbt`.
- A runtime context with local Project `rbbt` and an explicit Console mapping to
  `rbbt-ravi` resolves `project.ref="rbbt-ravi"`.

## Command Coverage

- `ravi cloud auth profiles list --json` shows safe metadata for all stored
  profiles.
- `ravi cloud auth profiles switch rbbt --json` changes active credentials only
  when the profile already exists.
- `ravi whoami --json` changes selected organization after profile switch.
- `ravi pages list --json` can omit project when a default is set.
- `ravi pages list --json` fails with a clear missing project message when no
  project default exists and more than one remote project is visible.
- `ravi pages create <slug> --json` uses the default project when project is
  omitted and explicit project when provided.
- `ravi pages publish <site> <target> --json` uses the default
  project when `--project` is omitted.
- `ravi bridges create --json` uses the default project when `--project` is
  omitted.
- `ravi connectors connect google --json --no-open` fails with a clear project
  message when no project default exists and multiple projects are visible.
- `ravi sync push --json` keeps organization scope by default unless a project
  is explicitly supplied or the command opts into project defaulting.

## Manual Smoke

```bash
ravi whoami --json
ravi cloud auth profiles list --json
ravi cloud projects list --json
ravi projects list --json
ravi cloud scope set --project rbbt-lab --session ravi-console
ravi cloud scope show --json
ravi pages list --json
```

The `pages list` result should show `projectRef` matching the default project.

## Regression Smoke For RBBT Case

With current credentials selected to the personal org where `rbbt-ravi` exists
and local Project `rbbt` also exists:

```bash
ravi cloud projects list --json
ravi projects list --json
ravi cloud scope explain --json
```

Expected:

- explain does not select local `rbbt` by slug equality;
- if no default/mapping exists, project-scoped commands fail before publish;
- after setting a session default to `rbbt-ravi`, Pages commands report
  `projectRef: "rbbt-ravi"`.

## Regression Smoke For Multi-Org Profiles

With the same local installation approved for `luis` and `rbbt`:

```bash
ravi cloud auth profiles list --json
ravi cloud auth profiles switch luis --json
ravi cloud scope set --project filipe-ai --session ravi-console
ravi cloud auth profiles switch rbbt --json
ravi cloud scope set --project rbbt-ravi --session ravi-console
ravi cloud scope show --json
```

Expected:

- active profile after switch is `rbbt`;
- scope project is `rbbt-ravi`;
- switching back to `luis` returns `filipe-ai`;
- no command output includes token values.
