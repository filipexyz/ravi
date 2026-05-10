# Cloud Auth / CHECKS

## Static Checks

- CLI code contains no WorkOS client secret.
- CLI code contains no Ravi Cloud server secret.
- JSON output does not print access tokens or refresh tokens.
- File credential fallback is written with current-user-only permissions.
- `ravi logout` deletes local credentials.

## Login Smoke

```bash
ravi login --console https://console.ravi.bot
ravi whoami --json
```

Expected:

- auth completes through browser/device flow;
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
