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
ravi artifacts create \
  --path /path/to/file.png \
  --session <session> \
  --kind image \
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

## Publish HTML To Ravi Pages

1. Put the page in a local directory. For raw HTML, write `index.html`.

```bash
mkdir -p /tmp/ravi-page
$EDITOR /tmp/ravi-page/index.html
```

2. Ensure the target site exists. This only creates/updates the site record.

```bash
ravi pages create <project-ref> <site-slug> --visibility public
```

3. Publish content through the Pages command.

```bash
ravi pages publish <project-ref> <site-slug> /tmp/ravi-page --route / --visibility public --entrypoint index.html
```

4. If the HTML was already registered as an artifact package, publish the
artifact id instead of the directory.

```bash
ravi pages publish <project-ref> <site-slug> <artifact-id> --route / --visibility public
```

Pages publishing is handled through `ravi pages publish`.
