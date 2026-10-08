---
id: routines/composition
title: "Routine Composition Runbook"
kind: capability
domain: routines
capability: composition
status: draft
---

# Routine Composition Runbook

## Design A Routine

1. Classify every person the routine touches: org member (signed in, can read the project) or outsider. If unsure, outsider.
2. Load the sheet and fill it before the first command that creates or changes anything:

```bash
ravi skills show solucoes
```

3. Map each sheet line onto the contract: REAGIR or RELATAR is the trigger, GUARDAR is the context and the durable state write, AGIR or MOSTRAR is the output, the eight rules are the quality check.
4. Use one primitive per verb. A trigger that serves two outcomes becomes two sheets.
5. Load the skill of each piece before using its commands, for example `ravi skills show triggers`.
6. Decide the default: silent or speaking. A `ravi cron add --shell` job runs without an agent and, with `--on-error notify-session:<session>`, speaks only when it fails.

## Approval By Reaction

1. Send the request to a group and keep the `messageId` from the JSON result (without `--execute` it is a dry run):

```bash
ravi whatsapp group send <group> "<request>" --json --execute
```

2. Store the `messageId` on the domain row before anyone can react, with a versioned, keyed write:

```bash
ravi bases rows update <base> <row> --set approval_message=<messageId> --expected-version <n> --idempotency-key <base>:<row>:ask
```

3. Trigger on `ravi.inbound.reaction`, find the row by `messageId`, and only then act.

## Side Effects

- Every agent write carries an `--idempotency-key` derived from its origin, such as `<base>:<row>:<step>` or `wa:<messageId>:<step>`, so a retried turn reuses the same key.
- Every update carries `--expected-version`. A `VERSION_CONFLICT` means someone else changed the row first: read it again and decide.
- A trigger whose agent writes to the same base filters `data.actor.type == "user"`, so the routine does not wake itself.

## Outsiders

- Outsiders get channel messages or a snapshot page, never a page with `ravi.bases.*` in `--uses`.
- `ravi pages ship` refuses `ravi.bases.*` in `--uses` on a public route. Pass `--members-best-effort` only when every reader is a signed-in org member.

## Measure

The eval kit in `examples/eval/solucoes/` checks whether agents follow this contract: item R1 is people classified before the first command, and item P2 is the sheet shown before the first mutation.
