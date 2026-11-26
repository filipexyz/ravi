---
id: apps/store/checks
title: "Ravi Apps Store Checks"
kind: checks
domain: apps
capability: store
---

# Ravi Apps Store Checks

## Regression Tests

- An app whose commands are all exposed `ravi` commands MUST classify as `compose`; a shell, an admin group, an unmarked write or the Omie builtin MUST classify as `code` (`src/apps/store/store.test.ts`).
- A refresh MUST fail with `APP_STORE_SIGNATURE_INVALID` when `index.json` or `keys.json` is signed by the wrong key.
- A refresh MUST fail with `APP_STORE_ROLLBACK` for an older serial, and with `APP_STORE_SOURCE_EXPIRED` for an expired file.
- An install MUST leave the app hidden from every agent until `allow`; the agent run fails with `not_found` before and passes after (`src/apps/router.test.ts`).
- A run MUST fail with `APP_TREE_CHANGED` after a file under the installed app changes.
- A folder added to the state apps directory after the store started MUST be invalid; one present before MUST stay valid.
- A blocked version MUST be quarantined and hidden after a refresh.
- An update MUST fail with `APP_UPDATE_COOLDOWN` inside 24 hours; rollback MUST return the previous version.
- `apps index build` MUST fail when a published version is rebuilt with other files.
- A local `code` app MUST fail without `--allow-code`; an id another source declares MUST fail with `APP_ID_CONFLICT`.
- Agent file writes under `apps/` and `app-store/` of the state directory MUST be refused.

## Manual Checks

```bash
RAVI_STATE_DIR="$(mktemp -d)" ravi apps install --from <app-dir>            # exit 3, plan
RAVI_STATE_DIR="$(mktemp -d)" ravi apps index build <repo> --check
ravi apps index verify <repo> --root <root-pubkey>
```
