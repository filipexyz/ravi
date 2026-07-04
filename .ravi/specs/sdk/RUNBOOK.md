---
id: sdk
title: "Ravi SDK - Runbook"
kind: runbook
domain: sdk
owners:
  - dev
status: draft
---

# Runbook

## SDK drift detected

When `ravi sdk client check` or the pre-push hook reports drift:

1. Regenerate: `ravi sdk client generate`
2. Review the diff in `packages/ravi-os-sdk/src/`
3. Commit the regenerated files
4. Run `ravi sdk openapi check` and `ravi sdk swift check` for other
   artifact drift

## Adding a new public command

1. Decorate with `@Command`, `@Arg`, `@Option` as usual
2. Add `@Returns(zod)` with a concrete return schema
3. Run `ravi sdk returns validate --json` to verify no weak schemas
4. Regenerate SDK artifacts
5. Run `bun run typecheck && bun run build`

## Marking a command CLI-only

1. Add `@CliOnly()` decorator with justification
2. Verify the command is excluded from `ravi sdk client generate` output
3. Document the reason in the PR

## Debugging gateway dispatch errors

1. Check `ravi daemon logs` for `ReturnShapeError` or `ValidationError`
2. Verify the command's `@Returns` schema matches actual handler output
3. For binary commands, verify the handler returns a `Response` instance
