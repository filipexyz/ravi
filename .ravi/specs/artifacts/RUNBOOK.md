# Artifacts / RUNBOOK

## Debug Flow

When generated output is missing, stuck, or not announced:

1. Check whether an artifact exists.

```bash
ravi artifacts list --kind image --json
```

2. Inspect the artifact.

```bash
ravi artifacts show <artifact_id> --json
```

3. Inspect the event timeline.

```bash
ravi artifacts events <artifact_id> --json
```

4. If the output file exists but no artifact exists, register it manually as a
   recovery action.

```bash
ravi artifacts create image \
  --path /path/to/file.png \
  --session <session> \
  --tags generated,image,recovered \
  --title "Recovered generated image" \
  --summary "Manually registered after generation completed outside the artifact lifecycle."
```

5. If the artifact exists but has no terminal status, check the producer process
   or provider logs, then repair status with `ravi artifacts event`.

## Expected Async Image Flow

1. `ravi image generate "..."` creates artifact with `pending`.
2. Worker marks artifact `running`.
3. Worker appends provider request/processing events.
4. Worker saves file and ingests blob.
5. Worker sends generated media to the origin chat when channel context exists.
6. Worker marks artifact `completed` or `failed`.
7. Runtime informs the owner session with artifact id and final status.

## Manual Recovery Rule

Manual artifact creation is acceptable for recovery, but it SHOULD be tagged
`recovered` and SHOULD include enough summary/metadata to explain why the normal
lifecycle was bypassed.
