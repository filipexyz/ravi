# Runbook

1. Inspect contact tags.
2. Confirm the tag is permission-scoped.
3. Materialize the contact subject:

```bash
ravi permissions materialize --subject-type contact --subject-id <contact-id> --json
```

4. If no capability appears, fix the provider config or the tag namespace.
