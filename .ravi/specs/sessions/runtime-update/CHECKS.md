# Runtime Update Checks

## Unit Tests

```bash
bun test src/runtime/model-validation.test.ts src/runtime/runtime-probe.test.ts src/runtime/session-runtime-update.test.ts
```

Validates:

- A model from a family the provider does not run MUST be refused, naming the known families and listed models; a KNOWN family with an UNKNOWN version MUST pass through (the probe arbitrates it); Codex slugs absent from the installation's models cache MUST be refused
- Open-space providers (Pi selectors, Codex without a cache) MUST stay permissive beyond cross-vendor rules
- Under `NODE_ENV=test` the default Codex cache path MUST be disabled (tests opt in with `codexCachePath`)
- `parseSessionRuntimeUpdateAxes` MUST refuse invalid provider/model/effort/thinking naming valid values; `clear` clears
- `applySessionRuntimeUpdate` MUST validate the hypothetical effective runtime before any write
- A failed probe MUST restore every touched axis, run no destructive finalization, and report `rolledBack: true`
- A passed probe MUST allow deferred finalization (provider-continuity clear, agent rematerialization)
- The probe MUST settle its credential attempt and report terminal provider errors verbatim
- A concurrent update landing during the probe MUST supersede this one: failed probe restores nothing (`superseded: true`, the newer values survive), successful probe skips continuity clear/rematerialization, and no model-changed notification is emitted for a superseded update
- The conditional restore MUST be a single statement gated on revision + all four persisted values (`restoreSessionRuntimeConfigIfOwned`)
- When the restore throws, the stored configuration MUST be read back and the revision MUST stay authoritative: values equal to `before` under a revision this update did not write MUST report `superseded: true` (both for a newer update that wrote them and for this restore committing before it threw)

## Failure Envelope

```bash
bun test src/cli/agent-contract.test.ts src/cli/commands/sessions-update-failure.test.ts
```

Validates:

- `error.runtimeUpdate` MUST carry only flags, a redacted `rollbackError` and the four override ids; an id outside the accepted format MUST turn that snapshot into `null` while the flags stay in the envelope, and the raw id MUST NOT appear anywhere in it
- With the unproven configuration still stored, `suggestedAction` MUST start with `Check first: ravi sessions info <session> --json` and carry the probe-free restore command; with a non-representable previous id it MUST carry no restore command
- A stored state equal to `before` under a moved revision MUST say nothing is left to restore from this update and MUST NOT claim that a newer update owns the session

## Write-path Enforcement

```bash
bun test --timeout 20000 --preload ./src/test/isolated-runtime-preload.ts src/runtime/thread-provider-config.test.ts
bun test --timeout 20000 src/cli/commands/sessions.test.ts
```

Validates:

- `create-thread` and `sessions set-*` inherit catalog enforcement through the shared validator

## Integration Smoke

```bash
ravi sessions update <session> --model not-a-real-model       # MUST refuse naming valid models, nothing written
ravi sessions update <session> --effort low                   # MUST apply, probe, and print the probe duration
ravi sessions update <session> --provider claude --model opus # probe failure MUST restore prior state, exit RUNTIME_PROBE_FAILED
```

## Acceptance

- An invalid model is refused at write time with the valid ids in the message
- A valid update only survives after a real provider turn proved it
- A probe failure leaves the session byte-identical on the four axes
- `--skip-probe` output MUST say the change is unproven
