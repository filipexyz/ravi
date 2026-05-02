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

## Local Debt Scan

```bash
rg -n "@Command\\(\\{ name: \"list\"|--last|--limit|--cursor|--sort|--order|--since|--until" src/cli/commands
```

Expected:

- large list commands progressively converge on the common listing contract.
