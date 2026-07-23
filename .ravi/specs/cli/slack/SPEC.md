---
id: cli/slack
title: "Slack CLI Agent Actions"
kind: capability
domain: cli
capabilities:
  - slack
tags:
  - cli
  - slack
  - agent-actions
  - channels
applies_to:
  - src/cli/commands/slack.ts
  - src/slack
owners:
  - ravi-dev
status: active
normative: true
---

# Slack CLI Agent Actions

## Intent

`ravi slack` is the agent action surface for managing Slack.

It MUST expose Slack-native management actions for agents and operators. It
MUST NOT become a facade for Ravi routing, Omni diagnostics, canonical chat
inspection, or session trace debugging.

Channel management is the primary capability. The CLI MAY call Slack
`conversations.*` methods internally, but the user-facing command language
SHOULD say `channels` when the target is a Slack public/private channel.

## Invariants

- `ravi slack` commands MUST be actions over Slack resources, not Ravi
  resources.
- The first-class Slack resources are workspace identity, channels, channel
  members, channel messages, threads, reactions, pins, bookmarks, files, users,
  and user groups.
- The CLI MUST NOT include default surfaces named `routes`, `chats`, `sessions`,
  or `events` under `ravi slack`; those belong to Ravi/Omni commands.
- Every agent-consumed command MUST support `--json`.
- Every list command MUST be bounded and paginated.
- Mutating commands MUST default to `--dry-run`.
- Mutating commands MUST require `--apply` before they call Slack write APIs.
- Destructive commands such as archive, delete, kick/remove, and admin deletes
  MUST require explicit target ids and SHOULD require typed confirmation when
  irreversible.
- Commands MUST perform a scope/permission preflight before write APIs when the
  required scope is known.
- Commands MUST NOT print Slack tokens, signing secrets, auth headers, raw
  secret config, Ravi context keys, or provider session ids.
- Slack `ok=false` API responses MUST become actionable errors that explain the
  failed action, likely cause, missing scope/permission when known, and next
  command.
- Slack API raw payloads MAY be available behind an explicit diagnostic flag,
  but MUST be sanitized by default.
- Writes MUST emit standard CLI audit metadata.

## Command Surface

### Workspace

```bash
ravi slack whoami --account <account>
ravi slack auth check --account <account> --json
```

Workspace actions MUST identify the selected Slack workspace/account, bot/user
identity, token class, and available action groups without revealing secrets.

### Channels

Channel management MUST be included in the first implementation slice.

```bash
ravi slack channels list --account <account> --limit 50 --json
ravi slack channels info --account <account> --channel <channel>
ravi slack channels create --account <account> --name <name> [--private] --dry-run
ravi slack channels archive --account <account> --channel <channel> --dry-run
ravi slack channels unarchive --account <account> --channel <channel> --dry-run
ravi slack channels rename --account <account> --channel <channel> --name <name> --dry-run
ravi slack channels set-topic --account <account> --channel <channel> --topic <text> --dry-run
ravi slack channels set-purpose --account <account> --channel <channel> --purpose <text> --dry-run
ravi slack channels join --account <account> --channel <channel> --dry-run
ravi slack channels leave --account <account> --channel <channel> --dry-run
```

Channel commands MUST accept channel ids. They MAY accept names, but name
resolution MUST fail on ambiguity and print the matching channel ids.

### Channel Members

```bash
ravi slack channel-members list --account <account> --channel <channel> --json
ravi slack channel-members invite --account <account> --channel <channel> --user <user> --dry-run
ravi slack channel-members remove --account <account> --channel <channel> --user <user> --dry-run
```

`remove` SHOULD map to the Slack member removal method available for the token
class. It MUST refuse to remove the acting bot/user from its current channel
unless a future `--force` path is explicitly designed.

### Messages And Threads

```bash
ravi slack messages send --account <account> --channel <channel> --text <text> --dry-run
ravi slack messages reply --account <account> --channel <channel> --thread <ts> --text <text> --dry-run
ravi slack messages update --account <account> --channel <channel> --ts <ts> --text <text> --dry-run
ravi slack messages delete --account <account> --channel <channel> --ts <ts> --dry-run
ravi slack messages schedule --account <account> --channel <channel> --at <iso-time> --text <text> --dry-run
ravi slack messages scheduled list --account <account> --channel <channel> --json
ravi slack messages scheduled cancel --account <account> --scheduled-message-id <id> --dry-run
ravi slack threads replies --account <account> --channel <channel> --thread <ts> --limit 20 --json
```

Message text SHOULD support stdin for longer content. Commands MUST NOT print
auth headers or unsanitized raw Slack request/response payloads by default.

### Reactions, Pins, And Bookmarks

```bash
ravi slack reactions add --account <account> --channel <channel> --ts <ts> --name <emoji> --dry-run
ravi slack reactions remove --account <account> --channel <channel> --ts <ts> --name <emoji> --dry-run
ravi slack reactions list --account <account> --channel <channel> --ts <ts> --json

ravi slack pins list --account <account> --channel <channel> --json
ravi slack pins add --account <account> --channel <channel> --ts <ts> --dry-run
ravi slack pins remove --account <account> --channel <channel> --ts <ts> --dry-run

ravi slack bookmarks list --account <account> --channel <channel> --json
ravi slack bookmarks add --account <account> --channel <channel> --title <title> --link <url> --dry-run
ravi slack bookmarks edit --account <account> --channel <channel> --bookmark <id> --title <title> --dry-run
ravi slack bookmarks remove --account <account> --channel <channel> --bookmark <id> --dry-run
```

### Files

```bash
ravi slack files upload --account <account> --channel <channel> --path <path> --dry-run
ravi slack files share --account <account> --channel <channel> --file <file-id> --dry-run
ravi slack files list --account <account> --channel <channel> --json
ravi slack files info --account <account> --file <file-id> --json
ravi slack files delete --account <account> --file <file-id> --dry-run
```

New file upload implementations SHOULD use Slack's external upload flow.

### Users And User Groups

```bash
ravi slack users list --account <account> --limit 100 --json
ravi slack users info --account <account> --user <user> --json
ravi slack users lookup --account <account> --email <email> --json
ravi slack users profile get --account <account> --user <user> --json
ravi slack users profile set --account <account> --user <user> --field <field> --value <value> --dry-run

ravi slack usergroups list --account <account> --json
ravi slack usergroups create --account <account> --handle <handle> --name <name> --dry-run
ravi slack usergroups update --account <account> --usergroup <id> --name <name> --dry-run
ravi slack usergroups enable --account <account> --usergroup <id> --dry-run
ravi slack usergroups disable --account <account> --usergroup <id> --dry-run
ravi slack usergroups users set --account <account> --usergroup <id> --users <ids> --dry-run
```

Profile writes and user-group writes may require user tokens or elevated
workspace permissions. They MUST NOT silently run under a bot-only account if
Slack will reject or reinterpret the action.

### Admin Tier

Admin and Enterprise Grid APIs MUST NOT be part of the default MVP.

If added later, admin commands MUST live under `ravi slack admin ...`, require
an explicit admin token profile, and use stricter approval than normal channel
management.

## Output Contract

JSON output for list commands MUST include:

- `total` when the total is known or cheaply computable;
- `pagination.limit`;
- `pagination.offset` or Slack cursor provenance;
- `pagination.returned`;
- `pagination.hasMore`;
- `pagination.nextCommand`;
- `items`.

Write dry-runs MUST include:

- selected account;
- Slack method that would be called;
- target channel/user/message/file ids;
- required scopes when known;
- expected effect;
- whether `--apply` is required.

## First Build Slice

The first implementation SHOULD include:

1. `ravi slack whoami`
2. `ravi slack channels list`
3. `ravi slack channels info`
4. `ravi slack messages send`
5. `ravi slack messages reply`
6. `ravi slack reactions add`
7. `ravi slack pins add`
8. `ravi slack users list`

## Known Failure Modes

- A Slack CLI that primarily wraps Ravi routes/chats/traces instead of Slack
  actions.
- Channel management hidden behind generic `conversations` naming that is
  unclear to agents/operators.
- Message sends that happen during a planning/dry-run step.
- A failed Slack API call that prints only `invalid_auth` or `missing_scope`
  without the next corrective action.
- Logging or printing tokens, signing secrets, auth headers, or raw config.
- Adding admin APIs to the default MVP and accidentally broadening required
  permissions.
