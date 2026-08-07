# Prox Calls agent-first CLI contract / WHY

A misfired `prox calls request` is not a local mistake: a real phone rings in
a real person's pocket, with a voice agent speaking on the operator's behalf.
That is the single most human-facing write in the CLI, so it got the brake.
The plan identifies the semantic person/profile and provider mode, but exposes
only whether a phone/reason was supplied and the dynamic-variable keys; it
never copies the phone, reason or variable values into an error or audit path.

`cancel` went the OPPOSITE way on purpose. Cancel is how you stop a call that
should not happen — quiet hours misjudged, person already replied, wrong
target. Gating the stop behind `--execute` would delay exactly the action that
prevents harm. The workflows-cancel precedent applies verbatim.

Two ops already had their own protection and were documented instead of
re-braked, because renaming shipped flags breaks callers for zero safety gain:
`voice-agents sync` is dry-run BY DEFAULT (the CLI cannot even reach the live
push today), and `tools run` pairs `--dry-run` with a hard
`execution_not_implemented` block on the live path.

`profiles configure` has two materially different paths. A local config update
is reversible and executes immediately. When the effective provider is
ElevenLabs, a provider agent exists and prompt/first-message/dynamic fields
would be synchronized, the command requires confirmation before either local
persistence or HTTP. `--skip-provider-sync` is the explicit low-friction local
path.

Authorization is separate: `request`, transcript sync and effectful config
operations are declared `mutate`. Exact legacy read grants receive matching
mutate grants; broad read wildcards are not expanded automatically.
