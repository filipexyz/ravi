---
id: cli/listing
title: "CLI Listing Contract"
kind: capability
domain: cli
capability: listing
capabilities:
  - pagination
  - filtering
  - sorting
  - bounded-defaults
tags:
  - cli
  - listing
  - pagination
  - filters
applies_to:
  - src/cli/commands
  - src/tasks
  - src/router
  - src/artifacts
  - src/projects
  - src/contacts.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# CLI Listing Contract

## Intent

Every CLI command that lists potentially large data MUST use one predictable
contract for pagination, filtering, sorting, and JSON shape.

The contract is agent-first: an agent should be able to make a safe first call,
read the page metadata, and request the next page without guessing.

## Default Shape

List commands MUST be bounded by default.

Defaults SHOULD be:

- `--limit 30` for entity lists with rich output.
- maximum `--limit 500` unless a domain spec declares a smaller safe cap.
- newest/recent-first ordering when a timestamp exists.
- a recent time window for history-heavy domains.

For `ravi tasks list`, the default time window MUST be `updated_at >= now - 1d`.

## Common Flags

List commands SHOULD converge on these flags:

```bash
--limit <n>       page size
--cursor <token>  opaque cursor returned by the previous page
--sort <field>    stable sort field, domain-specific allowlist
--order <dir>     asc|desc
--since <time>    lower time bound
--until <time>    upper time bound
--all-time        disable the default time window
--json            machine-readable output
```

Domains MAY keep legacy aliases such as `--last`, but aliases SHOULD resolve to
the common contract internally.

`--all` MUST NOT mean "remove every safety limit" when it already has a domain
meaning such as "include archived". Use `--all-time` for time-window removal.

## Time Filters

Time filter values SHOULD accept:

- duration: `30m`, `1h`, `1d`;
- epoch milliseconds;
- ISO-8601 datetime.

If a command has a default time window, JSON output MUST disclose it.

## Sorting

Every paginated list MUST define an allowlist of sort fields.

Sorts MUST be stable. If multiple rows have the same sort value, commands MUST
add a deterministic tie-breaker such as `id`.

Recommended timestamp sorts:

- `updated`
- `created`

Default order SHOULD be `desc`.

## Cursor Semantics

Cursors MUST be opaque to callers.

Cursor payloads SHOULD encode:

- sort field;
- order;
- last row sort value;
- last row id;
- optional filter fingerprint.

Commands MUST reject cursors that do not match the current sort/order when that
could produce skipped or duplicated rows.

Offset pagination SHOULD NOT be the default for mutable operational data.

## JSON Shape

List JSON SHOULD include:

```json
{
  "total": 30,
  "items": [],
  "page": {
    "limit": 30,
    "count": 30,
    "hasMore": true,
    "nextCursor": "...",
    "sort": "updated",
    "order": "desc",
    "since": 1770000000000,
    "until": null,
    "defaultWindow": "1d"
  },
  "filters": {}
}
```

Domain payloads MAY keep legacy field names such as `tasks`, but SHOULD still
include `page` and `filters`.

`total` SHOULD mean returned count by default. Expensive full matching totals
MUST be opt-in, for example `--count-total`.

## Human Output

Human output SHOULD show:

- number returned;
- active filters;
- active time window;
- sort/order;
- next command when another page exists.

Example:

```text
Tasks (30 returned, updated last 1d, sort updated desc)
...
Next page:
  ravi tasks list --cursor ey...
```

## Acceptance Criteria

- Calling a list command with no filters is safe in a large database.
- JSON output exposes `page.hasMore` and `page.nextCursor`.
- Cursor requests are deterministic and do not duplicate rows from the previous
  page.
- `--all-time` is explicit when removing a default time window.
- `tasks list` defaults to tasks updated in the last day.
