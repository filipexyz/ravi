# Devin Runbook

## Prerequisites

- `DEVIN_API_KEY` (service-user `cog_` prefix) in `~/.ravi/.env` or env.
- `DEVIN_ORG_ID` (`org_` prefix) in `~/.ravi/.env` or env.
- Optional: `DEVIN_DEFAULT_MAX_ACU_LIMIT`, `DEVIN_DEFAULT_TAGS`,
  `DEVIN_DEFAULT_MODE`, `DEVIN_DEFAULT_PLATFORM`, `DEVIN_DEFAULT_REPOS`,
  `DEVIN_DEFAULT_CREATE_AS_USER_ID`.

## Validate Credentials

```bash
ravi devin auth check --json
```

Confirm `ok: true`, `principalType`, and `orgId` match expectations.

## Create a Session

```bash
ravi devin sessions create \
  --prompt "Fix issue #42" \
  --max-acu 500 \
  --tag ravi \
  --json
```

ACU limit resolution: `--max-acu` flag > `DEVIN_DEFAULT_MAX_ACU_LIMIT` env > fail.
Use `--no-max-acu-limit` to intentionally omit.

## Monitor Progress

```bash
ravi devin sessions show <id> --sync --json
ravi devin sessions messages <id> --json
ravi devin sessions insights <id> --json
ravi devin sessions sync <id> --insights --artifacts --json
```

## Terminate / Archive

```bash
ravi devin sessions terminate <id> --archive --json
ravi devin sessions archive <id> --execute --json
```

## Troubleshooting

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| `devin.auth.invalid` | Bad/expired key | Rotate `DEVIN_API_KEY` |
| `devin.auth.forbidden` | Missing permission | Check service-user role |
| `devin.rate_limited` | 429 from API | Back off, retry later |
| ACU "not configured" error | Missing env default | Set `DEVIN_DEFAULT_MAX_ACU_LIMIT` or use `--max-acu` |
| Session stuck `suspended` | Usage/quota limit | Check `status_detail`, add credits or raise limit |

## Experiment: create_as_user_id and Authorship

Hypothesis: using `create_as_user_id` attributes the session to that user and may
change PR author/committer to the impersonated user.

To test:
1. Create session without `--as-user` (service-user identity).
2. Create session with `--as-user <user_id>`.
3. Compare PR author/committer in both cases.

Result: Document findings here after validation. Treat authorship as a hypothesis,
not a guarantee, until observed empirically.
