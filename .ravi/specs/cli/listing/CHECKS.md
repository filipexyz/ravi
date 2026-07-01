# CLI Listing Contract / CHECKS

## Tasks Default Safety

```bash
ravi tasks list --json
```

Expected:

- output is bounded;
- `page.limit` is present;
- `page.defaultWindow` is `1d`;
- `page.since` is present;
- no full-history scan is performed by default.

## Tasks Full History Is Explicit

```bash
ravi tasks list --all-time --limit 30 --json
```

Expected:

- default time window is disabled;
- output is still bounded by `--limit`.

## Pagination Smoke

```bash
first="$(ravi tasks list --limit 2 --json)"
cursor="$(printf '%s' "$first" | jq -r '.page.nextCursor')"
ravi tasks list --limit 2 --cursor "$cursor" --json
```

Expected:

- second page does not repeat the first page's last item;
- `page.hasMore` is boolean;
- cursor preserves sort/order.

## Cron List Agent-Scoped Default

```bash
RAVI_AGENT_ID=ravi-refinamento ravi cron list --json
```

Expected:

- only jobs whose effective owner is `ravi-refinamento` are returned;
- `filters.scope` is `"agent"`;
- `filters.agentId` is `"ravi-refinamento"`;
- jobs from other agents are excluded.

## Cron List Explicit Global Scope

```bash
RAVI_AGENT_ID=ravi-refinamento ravi cron list --all-agents --json
```

Expected:

- jobs from all visible agents are returned;
- `filters.scope` is `"all-agents"`;
- `--limit` and `--offset` still apply.

## Cron List Tag + Pagination With Scope

```bash
RAVI_AGENT_ID=ravi-refinamento ravi cron list --tag etl --limit 2 --json
```

Expected:

- only jobs matching both the agent scope and the tag filter are returned;
- pagination metadata is present.

## Cron List No Agent Context

```bash
ravi cron list --json
```

Expected:

- without `RAVI_AGENT_ID` or session context, all accessible jobs are listed;
- `filters.scope` is `"all"`.

## Local Debt Scan

```bash
rg -n "@Command\\(\\{ name: \"list\"|--last|--limit|--cursor|--sort|--order|--since|--until" src/cli/commands
```

Expected:

- large list commands progressively converge on the common listing contract.
