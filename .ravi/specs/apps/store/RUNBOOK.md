# Ravi Apps Store / RUNBOOK

## Operator flow

```bash
ravi apps search
ravi apps install blog              # plan, exit 3
ravi apps install blog --execute
ravi apps allow blog --agent main --execute
ravi apps verify
```

## Maintainer flow (index repository)

```bash
ravi apps index build
ravi apps index sign index.json --key ~/.ravi-keys/publish.key
ravi apps index verify
```

Rotate publication or block keys: `ravi apps index keys --publish <k> --block <k>`,
then sign `keys.json` with the offline root key. Withdraw a version:
`ravi apps index block --id <id> --version <v> --reason "..."`, sign
`blocklist.json` with the block key. Renew the block list before it expires by
running `ravi apps index block` without `--id`.

## Triage

- `APP_STORE_SOURCE_UNCONFIGURED`: this build has no root key compiled in.
- `APP_STORE_ROLLBACK`: a served file is older than one already accepted;
  suspect a stale mirror or a replay, never delete `state.json` to pass it.
- `APP_TREE_CHANGED`: files under `$RAVI_STATE_DIR/apps/<id>` changed after
  install; reinstall or roll back.
- An app that "disappeared" for an agent: check `ravi apps verify` for
  `visible to` and quarantine.
