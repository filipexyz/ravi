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
ravi cloud auth profiles list --json
ravi cloud projects list --json
```

Confirm the selected Console organization and the accessible project refs.

The organization shown by `ravi whoami --json` is the remote Console
organization encoded in the current credentials. It is not the same thing as a
local Ravi Project.

If `profiles list` shows only one organization, the local runtime has only one
approved credential profile. To use another organization, run `ravi login` and
select that organization in the Console browser approval flow. Once a profile
exists, use:

```bash
ravi cloud auth profiles switch rbbt --json
ravi whoami --json
```

If the desired organization does not appear during browser approval, debug
Console membership/picker state. Do not look for `ravi login --org`; normal
login organization selection belongs in Console.

## Compare Remote Console Projects And Local Projects

When an agent says a project/site does not exist, compare both namespaces:

```bash
ravi whoami --json
ravi cloud projects list --json
ravi projects list --json
```

Read them as separate inventories:

- `ravi cloud projects list` returns remote Console Projects in the selected
  Console organization.
- `ravi projects list` returns local OSS Projects for alignment/workflow
  context.

Do not create a Pages site just because `ravi pages list <local-project-slug>`
returns `total: 0`. First verify that the argument is a remote Console project
ref from `ravi cloud projects list`.

## RBBT Wrong-Scope Debug

Known bad pattern:

```bash
ravi projects list --json        # local Project exists: rbbt
ravi cloud projects list --json  # remote project is: rbbt-ravi
ravi pages list rbbt --json      # wrong namespace
```

Immediate fix:

```bash
ravi pages list rbbt-ravi --json
```

If the site belongs in another Console organization, run `ravi login` and
select that organization in the Console approval flow. Do not look for or pass a
local `--org` flag.

After profile support lands, if RBBT was previously approved:

```bash
ravi cloud auth profiles switch rbbt
ravi cloud projects list --json
ravi cloud scope explain --json
```

Once scope defaults exist, inspect why a command selected a project:

```bash
ravi cloud scope explain --json
```

The output should identify whether the project came from explicit input,
runtime context, local Project mapping, session, agent, workspace, global, or
single-project fallback.

## Inspect Effective Scope

```bash
ravi cloud auth profiles list --json
ravi cloud scope show --json
ravi cloud scope explain --json
```

`show` should report one effective scope. `explain` should show candidate layers
and why each one did or did not apply.

The active credential profile should match the organization shown in scope
output. A project default from another organization should appear as unavailable
or absent, never selected.

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

Use local Project mappings only when a local Project is intentionally connected
to a remote Console project. The mapping must be visible in `scope explain`; a
matching slug is not a mapping.

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

Legacy `~/.ravi/cloud-auth/credentials.json` should be migrated as the active
credential profile. After migration:

- file permissions remain `0600` or stricter;
- profile listing is redacted;
- refresh updates only the active/profile-matched credentials;
- deleting one profile does not delete another organization's profile.
