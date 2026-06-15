---
id: cli/console-scope
title: "Console Scope Defaults - Runbook"
kind: capability
domain: cli
capability: console-scope
status: draft
normative: false
owners:
  - ravi-dev
---

# Runbook

## Inspect Current Cloud Auth

```bash
ravi whoami --json
ravi cloud projects list --json
```

Confirm the selected Console organization and the accessible project refs.

## Inspect Effective Scope

```bash
ravi cloud scope show --json
ravi cloud scope explain --json
```

`show` should report one effective scope. `explain` should show candidate layers
and why each one did or did not apply.

## Set Defaults

For the current operational session:

```bash
ravi cloud scope set --project rbbt-lab --session ravi-console
```

For an agent:

```bash
ravi cloud scope set --project rbbt-lab --agent ravi-console
```

For a workspace:

```bash
ravi cloud scope set --project rbbt-lab --workspace /Users/luis/dev/rbbt
```

Global fallback:

```bash
ravi cloud scope set --project rbbt-lab --global
```

Prefer session or workspace scope over global scope for customer/project work.

## Debug A Wrong Project

1. Run the command again with `--json` when supported.
2. Check whether the output includes `projectRef` and scope source.
3. Run `ravi cloud scope explain --json`.
4. If explicit CLI args were used, remember they always win.
5. If a stale session default wins, clear it:

```bash
ravi cloud scope clear --session <session>
```

6. If the remote API denies access, run `ravi whoami --json` and verify the
   selected Console organization.

## Runtime Context Debug

Inside an agent/runtime process:

```bash
ravi context whoami --json
```

Expected metadata should include `consoleScope` once this capability is wired.
Do not debug by printing `RAVI_CONTEXT_KEY`.

## Migration Notes

During migration, command-specific fallbacks such as `RAVI_PROJECT` may still
work. They should be treated as compatibility sources and reported as such by
`scope explain`.
