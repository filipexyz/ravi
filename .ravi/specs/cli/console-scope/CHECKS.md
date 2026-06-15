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

- Resolver order:
  - explicit input wins over all defaults;
  - runtime context wins over session/agent/workspace/global;
  - session wins over agent;
  - agent wins over workspace;
  - workspace wins over global;
  - credentials supply organization only when no richer scope exists.
- Missing project for project-required commands returns `PAYLOAD_INVALID` with a
  next command.
- Remote `PROJECT_ACCESS_DENIED` and `ORG_ACCESS_DENIED` are preserved.
- `RAVI_PROJECT` compatibility works but is lower priority than explicit input
  and runtime context.
- Scope JSON output never includes access tokens, refresh tokens, context keys,
  WorkOS tokens, or provider secrets.

## Runtime Coverage

- Runtime context metadata includes `consoleScope` when a default resolves.
- Child CLI with only `RAVI_CONTEXT_KEY` resolves the same scope.
- Refreshing a reused `agent-runtime` context updates `consoleScope` metadata
  when the session default changes.

## Command Coverage

- `ravi pages list --json` can omit project when a default is set.
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
ravi cloud projects list --json
ravi cloud scope set --project rbbt-lab --session ravi-console
ravi cloud scope show --json
ravi pages list --json
```

The `pages list` result should show `projectRef` matching the default project.
