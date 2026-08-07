# Devin agent-first CLI contract / CHECKS

## Checks

- `devin sessions create` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the plan (promptChars, promptPreview, maxAcuLimit,
  sessionSecretCount), and MUST NOT call the Devin API nor construct the
  client.
- The create plan MUST NOT contain session-secret values — only
  `sessionSecretCount`.
- `devin sessions create` with `--execute` MUST create the remote session and
  upsert it into the local cache.
- `devin sessions send` MUST resolve the session BEFORE the brake: an unknown
  id exits 1 with `DEVIN_SESSION_NOT_FOUND` + local suggestions and no
  dry-run is emitted.
- `devin sessions send` without `--execute` on a known session MUST exit 3
  with the plan (devinId, messagePreview) and MUST NOT send anything; with
  `--execute` the message MUST reach the client.
- The `--execute` flag MUST be the last declared option of `create` and
  `send`.
- `devin sessions show <unknown> --json` MUST exit 1 with
  `DEVIN_SESSION_NOT_FOUND` and suggestions from the local cache.
- `devin sessions list --fields a,b --json` MUST narrow `items` and keep the
  `sessions` alias identical to `items`.
- `terminate` and `sync` MUST keep working WITHOUT `--execute`; `archive`
  without `--execute` MUST exit 3 before client, provider or cache effects,
  and `archive --execute` MUST run.
- `insights --generate` without `--execute` MUST exit 3 before client,
  provider or cache effects; plain `insights` MUST keep reading and refreshing
  the local cache without confirmation, and `--generate --execute` MUST run.
- `bun test src/cli/commands/devin.test.ts` SHOULD pass after any change to
  the devin CLI contract surface.
