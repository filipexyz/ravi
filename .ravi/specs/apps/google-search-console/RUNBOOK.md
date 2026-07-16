# Runbook

1. Create an OAuth client with Search Console and Site Verification scopes.
2. Obtain a refresh token using Google's OAuth authorization flow.
3. Store the JSON envelope in a supported Ravi credential backend as provider
   `google-search-console` and connection `default` (or another explicit id).
4. Check access with `ravi gsc sites --json`.
5. Use an explicit property in every property-scoped command.
6. Grant App use/execute permissions only after validating the connection.

Never paste the credential envelope into command arguments, logs or a repo.
