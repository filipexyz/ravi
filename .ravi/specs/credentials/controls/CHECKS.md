# Credential Controls Checks

## Spec Checks

```bash
ravi specs get credentials/controls --mode full --json
ravi specs get credentials/broker --mode full --json
```

## Control Checklist

For credentials implementation changes, verify:

- `CRED-ID`: caller context is resolved when required.
- `CRED-AUTH`: credential and action capabilities are checked before read.
- `CRED-APPROVAL`: sensitive approval happens before read.
- `CRED-STORE`: no secret value persists in SQLite or markdown.
- `CRED-USE`: provider adapter receives secret only inside broker path.
- `CRED-OUTPUT`: CLI/SDK/log/audit outputs are redacted.
- `CRED-LIFE`: lifecycle fields are maintained.
- `CRED-AUDIT`: intent, decision and result are recorded.
- `CRED-BACKEND`: backend errors fail closed and are redacted.
- `CRED-CHANGE`: tests cover the changed control.
- `CRED-INCIDENT`: leak response is documented.

## Search Checks

Run targeted searches around changed files:

```bash
rg -n "console\\.(log|error|warn).*secret|secret.*console\\.(log|error|warn)" src/credentials src/cli/commands/credentials.ts pocs/credential-broker
rg -n "authorization|x-vault-token|bearer|access[_-]?token|refresh[_-]?token" src/credentials src/cli/commands/credentials.ts pocs/credential-broker
```

If a match contains a real secret, do not paste it into chat.

## Test Checks

PoC:

```bash
bun test pocs/credential-broker/broker.test.ts
```

Production when implemented:

```bash
bun test src/credentials/**/*.test.ts src/cli/commands/credentials.test.ts
```

Tests SHOULD prove:

- no backend read on authorization denial;
- no backend read on approval denial;
- `--dry-run` does not read secrets;
- public output redacts secret refs;
- audit rows contain no secret material;
- lifecycle timestamps update on use/rotation/disable.
