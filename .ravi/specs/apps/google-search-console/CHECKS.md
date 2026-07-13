# Checks

- No `sde`, organization domain, credential path or secret in App sources.
- Manifest operations invoke only `ravi gsc` or built-in App handlers.
- Credential parser rejects malformed and incomplete envelopes.
- API errors redact OAuth fields.
- Analytics limits are bounded to Google's documented maximum.
- Mutations are marked high/destructive and require confirmation.
- Packaged CLI and SDK expose the native commands.
- Real read-only calls succeed using a Ravi credential connection.
