# Cloud Auth / CHECKS

## Static Checks

- CLI code contains no WorkOS client secret.
- CLI code contains no Ravi Cloud server secret.
- JSON output does not print access tokens or refresh tokens.
- File credential fallback is written with current-user-only permissions
  (`0600` file, `0700` directories) under
  `~/.ravi/cloud-auth/users/<consoleUserId>/`.
- `active.json` points at the active `consoleUserId`.
- `ravi logout` deletes only the active user's credentials.
- `ravi login --help` exposes `--console <url>` with
  `https://console.ravi.bot` as the default.
- `ravi login --help` does not expose `--endpoint`.
- Root help exposes ambient `ravi link` / `ravi unlink` (the message author
  approves a Console link in the browser; see `cli/ravi-link`) and MUST NOT
  expose product-specific installation enrollment or `--endpoint`.
- Stored credentials carry the Console's `localInstallation.id` as
  `installationId`; a stored local id is replaced after the next `/me`.
- Default secret backend is the portable file store. Keychain is optional
  and never required.
- The Keychain backend runs `security -i` and passes the payload only
  hex-encoded on stdin: no argv element contains it, quotes/newlines/
  `"; delete-keychain` in the payload cannot add a command, and an oversized
  payload is refused before `security` runs
  (`bun test src/cloud-auth/secret-backends.test.ts`).
- After a Keychain write falls back to the file store, `readCloudCredentials()`
  MUST return the file copy (never a stale Keychain item), the stale item MUST
  be deleted, one warning names the `0600` file store without token material,
  and logout removes the file copy (`bun test src/cloud-auth/storage.test.ts`).
- Logout with another user stored MUST write the pointer with the store that
  holds the promoted user's credentials: with a fallback file copy present
  (locked Keychain, stale item left behind) `readCloudCredentials()` returns
  the file copy's token, and with the file copy as the only store it returns
  that token rather than `null`; promoting the `_legacy` slot leaves no
  `users/_legacy/` directory (`bun test src/cloud-auth/storage.test.ts`).
- Logout clears both stores: after a locked-Keychain fallback left a stale item,
  `deleteCloudCredentials()` and `deleteCloudCredentialsForUser()` remove the
  Keychain item and the file copy, `readCloudCredentialsForUser()` returns
  `null`, promoting `_legacy` removes both, a locked Keychain at logout warns
  instead of throwing, and the fallback warning names the surviving item when
  its delete failed (`bun test src/cloud-auth/storage.test.ts`).
- The Keychain backend reads with `find-generic-password -g` (argv contains
  `-g`, never `-w`) and returns an all-digit or hex-shaped payload such as
  `123456` or `c3a9` as text, a non-ASCII item written by an older Ravi
  decoded, and fails closed on an unparseable `password:` line
  (`bun test src/cloud-auth/secret-backends.test.ts`).
- No remote-login discovery, post-login provider, or remote installation
  credential module is present in the root auth implementation.
- Login polling retries `AUTH_PENDING`, `RATE_LIMITED`, and `SERVER_UNAVAILABLE`
  on the same device code until the timeout, and does not retry other auth
  errors or auth misconfiguration (`invalid_client`, missing client/endpoint).
- In provider mode, a Console exchange retry reuses the provider token and does
  not poll the provider again with the consumed device code.

## Login Smoke

```bash
ravi login --console https://console.ravi.bot
ravi whoami --json
```

Expected:

- auth completes through browser/device flow;
- the printed Verification URL and JSON `auth.authorizationUrl` /
  `auth.verificationUriComplete` include `?user_code=<issued-code>`;
- the bare `/cli/authorize` URL is never presented as the link to open;
- `whoami` returns user, organization, installation, scopes, and expiry;
- no raw token appears in stdout/stderr.

## Offline Artifact Smoke

```bash
ravi artifacts create --path /tmp/example.txt --json
ravi artifacts versions <artifact-id> --json
```

Expected:

- local artifact commands continue to work without cloud login.

## Publish Smoke

```bash
ravi artifacts publish <artifact-id> --project <project> --visibility private --json
```

Expected:

- CLI refreshes credentials if needed;
- manifest is sent with relative asset paths;
- response includes cloud artifact id and version id;
- safe server errors retain stable codes.
