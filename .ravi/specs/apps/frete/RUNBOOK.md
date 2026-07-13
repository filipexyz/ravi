# Frete / RUNBOOK

## Inspect The App

```bash
ravi apps show frete --json
ravi apps check frete --json
ravi frete quote --help
```

Manifest validation is local and MUST NOT resolve credentials or execute a
quote.

## Quote After Credential Onboarding

Credential onboarding is not part of Phase 1. After a supported `tiny`
connection exists, the read-only command shape is:

```bash
ravi frete quote \
  123 \
  01310100 \
  SKU-01 \
  --quantity 2 \
  --json
```

## Failures

- Missing connection: configure the future Ravi credential connection; do not
  read `/home/ravi/sde/.env` or pass a credential on the command line.
- Invalid CEP, integration id, quantity or dimensions: correct the flagged
  option and retry.
- Provider HTTP error: inspect the redacted status/message; never log or return
  the credential.
- Need to contract, buy, dispatch or cancel: stop. Those operations are outside
  Phase 1 and require an official contract plus HITL.

## Legacy Fallback

The existing `sde frete` remains available and unchanged. It is not called by
the Ravi App.
