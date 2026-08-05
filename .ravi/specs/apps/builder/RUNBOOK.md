# Ravi App Builder / RUNBOOK

## Build From API Documentation

1. Load `ravi-dev-app-creator`.
2. Read `apps/builder`, `apps/manifest`, `apps/cli`, `apps/router`, and
   `apps/permission-providers`.
3. Capture the official source contract and operation matrix.
4. Run scaffold in dry-run mode.
5. Implement the provider client and real CLI with injected fake HTTP.
6. Declare the smallest permissions and child-context ceiling.
7. Review storage, events, artifacts, UI, and the domain skill explicitly.
8. Validate the manifest and run the alias through the App Router.
9. Exercise missing auth, provider failures, pagination, and mutations.
10. Run the drift eval, generated-contract checks, and full suite.

## Build From an Existing CLI

1. Inspect machine metadata before human help.
2. Run import in dry-run mode.
3. Review public and debug candidates separately.
4. Remove unsafe, interactive, streaming, or rare commands from the app
   surface.
5. Complete every remaining builder gate; do not stop at a valid manifest.

## Inspect Builder Guidance

```bash
ravi skills show ravi-dev-app-creator --json
ravi specs get apps/builder --mode full --json
ravi apps guide --json
ravi apps scaffold demo --dry-run --json
```

The scaffold result and import result include the canonical builder skill,
spec, and review checklist.

## Diagnose Runtime Skill Visibility

```bash
ravi skills inspect <agent-id> --json
ravi skills show ravi-dev-app-creator --json
```

Claude uses plugin discovery, Codex uses managed skill synchronization, and Pi
receives the allowlist-filtered catalog in its appended system prompt. An
advertised Pi skill remains non-loaded until the instructions are explicitly
read.

## Diagnose Drift

Run:

```bash
bun test src/cli/commands/apps.test.ts
```

The contract eval reports which command or builder reference is missing from
the registry, guide, system skill, root spec, builder spec, or acceptance-case
brief.
