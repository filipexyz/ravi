# Cloud Auth / RUNBOOK

## Login Debug

```bash
ravi login --console https://console.ravi.bot --json
```

Check:

- Console auth config endpoint is reachable.
- Browser/device verification URL is shown.
- CLI does not require a client secret.
- Exchange endpoint returns Ravi CLI credentials.
- Credentials are stored outside stdout.

## Whoami Debug

```bash
ravi whoami --json
```

Expected:

- user metadata is present;
- organization metadata is present;
- Console URL is present;
- local installation id is present;
- token expiry/scopes are present;
- no token material is printed.

## Refresh Debug

Trigger with an expired access token or server `AUTH_EXPIRED` response.

Expected:

- CLI attempts refresh once;
- refresh rotates credentials when successful;
- original command retries after refresh;
- revoked/invalid refresh deletes local credentials and asks the user to login.

## Publish Debug

```bash
ravi artifacts publish <artifact-id-or-path> --project <project> --json
```

Check:

- local artifact resolves before upload;
- manifest uses relative asset paths;
- absolute paths are not used as cloud identity;
- server safe error codes are preserved in JSON;
- successful response includes cloud artifact id and version id.

