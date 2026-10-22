---
id: runtime/signals/spike/runbook
title: "Signals Spike Runbook"
kind: runbook
domain: runtime
capability: signals
feature: spike
status: draft
normative: true
---

# Signals Spike Runbook

## Fake a Low Disk in Tests

Use a probe dependency override, not a real full disk:

```ts
setDiskProbeForTests(() => ({
  path: "/",
  free_pct: 9.2,
  free_bytes: 9_200_000_000,
  total_bytes: 100_000_000_000,
  checked_at: "2026-10-21T03:12:00Z",
}));
```

The probe registry MUST expose a test seam that does not require changing production code paths.

## Run the Loop

1. Tick with the fake probe below threshold -> one open signal.
2. Start a turn in the fleet session -> block appears; no extra turn.
3. Run `signals tick --execute` -> one deterministic line and one OOB prompt.
4. Change the fake probe to 25% -> next evaluation resolves.
5. Run `signals tick --execute` -> no further page.

## Manual Verification Without a Real Signal

```bash
ravi signals raise host.disk.free \
  --kind fact --scope fleet --severity page \
  --title "Disk free below 15%" \
  --evidence '{"metric":"free_pct","value":9.2,"threshold":15}' \
  --clear-probe host.disk --clear-expr "free_pct >= 20" \
  --recheck 5m --grace 10m \
  --cooldown 6h --ttl 24h --escalate-after 0 \
  --source signals.watch.disk --json

ravi signals explain host.disk.free --json
ravi signals tick --json
```

## Tick Owner

The implemented default is the daemon leader runner: `SignalsRunner` runs `tickSignals({execute:true})` every five minutes. It is started next to the task checkpoint runner and only by the elected leader.

Do not also install a cron shell for the same tick. Two owners double-deliver.

If the daemon runner must be replaced by a shell job, disable the daemon runner first and then use:

```bash
ravi cron add signals-tick --every 5m --shell "ravi signals tick --execute"
ravi cron show <id>
```

Verify either owner:

- exactly one owner is active;
- it can read the same state DB as the daemon;
- it can resolve the fleet session (`signals.fleet_session`, default agent main).

## Disable

```bash
ravi settings set signals.enabled false
ravi cron disable <signals-tick-id>
```

Disabling the cron stops both evaluation and escalation. Disabling the setting stops block rendering and OOB even if the cron runs.

## Rollback

- disable the cron first;
- set `signals.enabled=false`;
- leave rows in place for audit;
- do not delete the store until the operator has reviewed the incident.

## Known Test Environment Traps

- `statfsSync` on a small CI container may actually be below 15%; always inject the probe in tests.
- A shared state dir across tests causes cross-test rows; use a temp `RAVI_STATE_DIR`.
- Concurrent tests that share the tick lock must use distinct state dirs or an injected clock.
