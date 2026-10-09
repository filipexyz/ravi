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
