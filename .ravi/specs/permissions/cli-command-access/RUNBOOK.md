# CLI Command Access / RUNBOOK

## Resolve A Command Denial

Apply the canonical capability printed by the denial to the intended agent,
then retry the same command:

```bash
ravi permissions allow <profile-name> \
  --to agent:<agent-id> \
  --capabilities <permission>:<object-type>:<object-id> \
  --apply
```

The retry MUST NOT require a follow-up `execute:group:*` capability for the
same operation. A second group-level denial indicates a runtime regression,
not an operator action item.

## Diagnose A Repeated Denial

1. Confirm that the denial recommends a semantic capability.
2. Confirm that the capability is present in the agent's effective authority.
3. Retry the exact command on the next turn.
4. If Ravi asks for `execute:group:*`, capture the command, source surface, and
   denial text and report a command-authorization regression.

Do not work around the regression by widening the agent to the whole command
group. Legacy group grants remain compatibility inputs for old profiles, but
they are not a required second authorization step.

## Validate The Shared Pipeline

```bash
bun test src/cli/command-access.test.ts \
  src/cli/tools-export.test.ts \
  src/cli/registry.test.ts \
  src/sdk/gateway/dispatcher.test.ts \
  src/permissions/scope.test.ts
```

The suite must prove that semantic-only authority works across CLI, exported
tools, and SDK Gateway; neighboring actions stay denied; and `superadmin`
retains its explicit hard boundary.
