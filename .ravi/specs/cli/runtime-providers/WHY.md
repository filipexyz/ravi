# Runtime provider auth agent-first CLI contract / WHY

Hub already knows how to auth providers: write `~/.ravi/.env`, spawn
`codex|grok login --device-auth`, then call `runtime credentials
import/add`. That logic lived only in the Hub connector, so a closed OSS
box could not be driven through `POST /api/v1/...` + `rctx_*`.

OSS already had `runtime.credentials.*` and `agents.set` on the gateway.
The missing piece was a non-interactive env writer plus a device-login
lifecycle that returns `verificationUrl` + `userCode` for the Hub UI.

`ravi setup` stays the human wizard. `ravi login` stays Ravi Console. This
domain is only model-provider auth.

Cancel exists because a pending helper would otherwise keep polling after
the operator abandons the Hub flow. Start replaces any previous pending
login for the same provider so Hub retries do not leak processes.

`--set-provider` is opt-in. The credential allowlist (`agents main`) is the
required wiring; flipping `agents.set provider` is a Hub choice, not a
silent side effect.
