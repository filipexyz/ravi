# Watch CLI / CHECKS

## CLI Checks

```bash
ravi watch connectors --json
ravi watch list --json
```

Expected:

- output contains no provider tokens;
- connectors list includes placement support;
- npm and GitHub expose supported event types.

## Creation Checks

Create npm and GitHub watches.

Expected:

- watch id is returned;
- connector config is normalized;
- placement is explicit in JSON;
- event subjects are returned;
- no trigger is created unless requested.
- GitHub auto placement calls Console capabilities before choosing placement.
- Missing GitHub App installation returns an actionable install/connect hint,
  not silent local fallback.

## Trigger Helper Checks

Run `ravi watch trigger` from a chat context.

Expected:

- created record is visible in `ravi triggers show`;
- topic is a `ravi.watch...` subject;
- filter scopes to the watch id;
- reply source points at the current chat.
