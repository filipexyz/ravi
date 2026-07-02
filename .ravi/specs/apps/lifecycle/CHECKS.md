# Ravi App Lifecycle / CHECKS

## Checks

- Delete dry-run check
  - `ravi apps delete demo-app --dry-run --json`
  - Must not remove files.
  - Must return planned file paths, kinds, and actions.

- Delete execution check
  - `ravi apps delete demo-app --json`
  - Must remove only scaffold-owned files.
  - Must not remove implementation files, runtime storage, or credentials.
  - Must report deleted file paths, kinds, and actions.

- Delete absent app check
  - `ravi apps delete nonexistent --json`
  - Must return typed `not_found` error with status 404.

- Scaffold collision check
  - `ravi apps scaffold demo-app --json` when files exist
  - Without `--force`: must return typed `already_exists` error with status 409.
  - With `--force`: must overwrite and succeed.

- Show absent app check
  - `ravi apps show nonexistent --json`
  - Must return typed `not_found` error.

- Gateway status code check
  - Scaffold duplicate via gateway must return HTTP 409.
  - Delete/show absent app via gateway must return HTTP 404.

- SDK stability check
  - `bun run sdk:generate` and `bun run sdk:check` must pass after changes.
  - `ravi sdk returns validate --json` must pass.
