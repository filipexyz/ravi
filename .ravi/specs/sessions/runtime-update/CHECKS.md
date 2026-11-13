# Runtime Update Checks

## Unit Tests

```bash
bun test src/runtime/model-validation.test.ts src/runtime/runtime-probe.test.ts src/runtime/session-runtime-update.test.ts
```

Validates:

- A model absent from the Claude/Grok catalog or the Codex models cache MUST be refused, naming the valid ids
- Open-space providers (Pi selectors, Codex without a cache) MUST stay permissive beyond cross-vendor rules
- Under `NODE_ENV=test` the default Codex cache path MUST be disabled (tests opt in with `codexCachePath`)
- `parseSessionRuntimeUpdateAxes` MUST refuse invalid provider/model/effort/thinking naming valid values; `clear` clears
- `applySessionRuntimeUpdate` MUST validate the hypothetical effective runtime before any write
- A failed probe MUST restore every touched axis, run no destructive finalization, and report `rolledBack: true`
- A passed probe MUST allow deferred finalization (provider-continuity clear, agent rematerialization)
- The probe MUST settle its credential attempt and report terminal provider errors verbatim

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
