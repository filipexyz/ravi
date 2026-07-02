---
id: sdk/schema
title: "SDK schema contract - Runbook"
kind: runbook
domain: sdk
capability: schema
owners:
  - dev
status: draft
---

# Runbook

## Return schema validation failure

When `ravi sdk returns validate --json` fails:

1. Run `ravi sdk returns status --json` to identify weak or missing schemas
2. Fix the command's `@Returns` decorator with a concrete Zod schema
3. For dynamic payloads, use `jsonObjectSchema` or `jsonValueSchema`
4. Re-validate and regenerate artifacts

See `sdk/schema/returns-coverage/RUNBOOK.md` for detailed steps.

## Binary command not working

1. Verify `@Returns.binary()` is on the command (not `@Returns(zod)`)
2. Verify the handler returns a `Response` instance
3. Check gateway logs for `ReturnShapeError`
4. Verify the SDK transport sends `binary: true`

## Schema mismatch at runtime

When a gateway dispatch returns unexpected shapes:

1. Check the command's `@Returns` schema matches the actual return
2. Run `bun test src/sdk/gateway/dispatcher.test.ts`
3. Verify the OpenAPI spec reflects the current schema
