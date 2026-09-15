# Mail / RUNBOOK

## Agent-first sends

Read `cli` for the global contract and `cli/mail` for mail-specific operation
classification and errors.

```bash
ravi mail send --from <mailbox> --to <address> --subject <subject> --body <body> --execute
ravi mail reply <message> --body <body> --execute
```

Without `--execute`, these commands return the dry-run plan with exit `3` and
must not create local or provider side effects.
