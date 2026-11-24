# Session Observe Runbook

- Watch a client agent and hear about problems here: `ravi sessions observe xone-setup` (from `main`) or `ravi sessions observe xone-setup --to main`.
- Only some conditions: `ravi sessions observe <source> --when turn.no_final_reply,turn.failed`.
- Every turn, compact: `ravi sessions observe <source> --follow`. This wakes the receiver once per finished source turn; use it for a short supervision window, then go back to alerts.
- See what is being watched: `ravi sessions observing`. Stop: `ravi sessions unobserve <source> [--to <session>]`.
- Nothing arrives: `ravi observers list --session <source> --json` shows the binding (rule id `observe:…`); a turn that matched no condition is skipped with reason `no_condition`, which is the healthy case.
