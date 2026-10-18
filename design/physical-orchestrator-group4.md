## Physical Orchestrator Group 4

Group 4 proves the substrate end to end with one real smoke CLI and an explicit debug surface.

### Smoke CLI

- File: `src/adapters/fixtures/session-smoke-cli.ts`
- Behavior:
  - emits a strict `event` line on boot with the process PID
  - accepts `ping`
  - accepts `emit-event`, which emits a second stdout event and then returns a command result
  - exits cleanly on `exit-clean`

### Debug surface

- Command group: `ravi adapters`
- Output is read from SQLite debug snapshots, not logs.
- The surface shows:
  - adapter identity and session bind
  - health state and process metadata
  - last stdout event
  - last protocol failure

### Validation

- Focused smoke test: `src/adapters/adapter-smoke.test.ts`
- Debug CLI test: `src/cli/commands/adapters.test.ts`
