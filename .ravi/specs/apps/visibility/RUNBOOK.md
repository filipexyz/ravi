# App Visibility / RUNBOOK

## Debug Flow

1. Resolve whether the command is running under runtime context or direct local
   operator CLI.
2. For runtime context, check whether the principal has `use app:<app-id>`.
3. For broad listings, compare `ravi apps list --json` with the expected visible
   set. Hidden apps should be filtered, not annotated.
4. For direct lookup, `apps show/check <app-id>` should return a not-found-like
   result when the app is hidden.
5. For dynamic aliases, verify root alias resolution checks visibility before
   revealing manifest or operation metadata.

## Triage

- `execute app:<app-id>` does not imply discovery by itself. Verify `use` first.
- Manifest permission declarations are requirements, not grants.
