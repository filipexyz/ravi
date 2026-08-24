# Session Recap Runbook

```bash
ravi sessions recap <nameOrKey>
ravi sessions recap <nameOrKey> --json
ravi sessions recap <nameOrKey> -n 12 --json
ravi sessions actions --json
```

When the recap looks empty:

1. confirm the caller can `access` the session (`ravi sessions info <name> --json`);
2. confirm `sessions read <name> --json` also has no user/assistant tail;
3. do not fall back to another session, `MEMORY.md`, or Knowledge.

When another agent needs context:

- prefer `sessions recap --json` for a bounded brief;
- use `sessions read --json` only when the tail itself is the question;
- use `sessions trace` for operational incidents, not conversation recap.
