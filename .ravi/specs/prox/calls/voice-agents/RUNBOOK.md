# Runbook

## Create A Voice Agent

1. Choose a stable id, for example `ravi-interviewer`.
2. Define provider and provider mapping.
3. Write or point to a system prompt.
4. Define first-message template.
5. Define dynamic variables schema.
6. Bind allowed tools through the tooling contract.
7. Attach the voice agent to one or more call profiles.
8. Dry-run provider sync before mutating remote config.

## Inspect Which Agent Was Used

```bash
ravi prox calls show <call_request_id> --json
ravi prox calls events <call_request_id> --json
```

The output should expose or link:

- `voice_agent_id`;
- `voice_agent_version`;
- provider id/pipeline id;
- effective profile;
- effective tools.

## Provider Drift Check

If provider behavior differs from Ravi config:

1. Show the local voice agent.
2. Show the call profile.
3. Check provider id/pipeline id.
4. Run `voice-agents sync --dry-run`.
5. If using Agora Studio, confirm Studio tools call Ravi's bridge.
