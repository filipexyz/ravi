# Artifacts / CHECKS

## Current Ledger

```bash
ravi artifacts list --kind image --json
```

Expected:
- recent generated images appear in the ledger
- `filePath`, `blobPath`, `sha256`, `provider`, `model`, `sessionName`, and
  `createdAt` are populated when known

## Manual Registration Smoke

```bash
ravi artifacts create \
  --path /tmp/example.png \
  --session main \
  --tags generated,image,test \
  --title "Artifact smoke test" \
  --summary "Smoke test artifact"
```

Expected:
- artifact id is returned
- artifact kind defaults internally without requiring a positional type
- file is copied into artifact blob storage
- `ravi artifacts show <id> --json` resolves the record

Optional semantic classification remains available:

```bash
ravi artifacts create --kind image --path /tmp/example.png --json
```

Expected:
- returned artifact has `kind=image`

## Isolated CLI Relative Path Regression

Run from an isolated agent CLI (host socket or `RAVI_GATEWAY_URL`) whose cwd
differs from the daemon cwd:

```bash
cd "$(mktemp -d)" && mkdir out && printf 'ok\n' > out/evidence.md
ravi artifacts create --path ./out/evidence.md --task task-1 --json
ravi artifacts attach <id> task task-1 --relation output --json
ravi artifacts create --path ./out/missing.md --json
ravi artifacts create --path ./out/evidence.md --kind "Bad Kind" --json
```

Expected:
- create succeeds and `filePath` points inside the caller directory
- attach links the artifact to the task
- the missing path and bad kind return `USAGE_ERROR`, exit 2, with issue paths
  `["path"]` and `["kind"]`; never `UNHANDLED_ERROR` / HTTP 500
- automated coverage: `src/sdk/gateway/artifacts-create.integration.test.ts`

## Pages boundary

Hosting HTML is `ravi pages ship` (skill `pages`). The artifacts skill and
this ledger MUST NOT teach `create` + `publish` choreography or treat
`artifacts publish` as the Pages happy path.

## Async Regression

```bash
ravi image generate "small test image" --provider openai --model gpt-image-2 --json
```

Expected:
- command returns in under 5 seconds with `artifact_id`
- returned hint says polling is unnecessary and whether auto-send is enabled
- initial artifact status is `pending` or `running`
- `ravi artifacts watch <artifact_id>` eventually reports `completed` or `failed`
- `ravi artifacts events <artifact_id> --json` contains at least:
  `created`, `started`, provider event, and terminal event

## Failure Regression

Force a provider failure with invalid credentials or invalid provider config.

Expected:
- artifact remains inspectable
- status becomes `failed`
- error reason is persisted in artifact events
- requesting session receives or can retrieve the failure status
