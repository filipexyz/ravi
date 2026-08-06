# Prox Calls agent-first CLI contract / WHY

A misfired `prox calls request` is not a local mistake: a real phone rings in
a real person's pocket, with a voice agent speaking on the operator's behalf.
That is the single most human-facing write in the CLI, so it got the brake
with the plan exposing exactly who would be called, why, and through which
provider mode (stub vs live).

`cancel` went the OPPOSITE way on purpose. Cancel is how you stop a call that
should not happen — quiet hours misjudged, person already replied, wrong
target. Gating the stop behind `--execute` would delay exactly the action that
prevents harm. The workflows-cancel precedent applies verbatim.

Two ops already had their own protection and were documented instead of
re-braked, because renaming shipped flags breaks callers for zero safety gain:
`voice-agents sync` is dry-run BY DEFAULT (the CLI cannot even reach the live
push today), and `tools run` pairs `--dry-run` with a hard
`execution_not_implemented` block on the live path.

`profiles configure` stays unbraked by the enumerated mandate, but it is the
one unbraked op that can touch a provider (ElevenLabs prompt/first-message
sync). The spec records `--skip-provider-sync` as the mitigation and flags the
op for the next wave if the principle hardens.

Also reported, untouched: `request` is mislabeled `kind:"read"` in
`@CommandAccess`. Changing it flows into REBAC command authorization, which is
out of scope for a contract wave.
