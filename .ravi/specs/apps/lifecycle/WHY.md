# Ravi App Lifecycle / WHY

## Rationale

Scaffolded apps leave behind files that have no automated cleanup path. Without
a delete command, removing an app requires manual discovery of which files are
scaffold-owned vs. implementation-owned.

Scaffold id collisions currently throw a free-text error or HTTP 500. Consumers
of the JSON, SDK, and gateway surfaces need a stable error code to branch on
without parsing English messages.

Absent app operations (show, check, delete) similarly throw unstructured errors
that gateway consumers cannot reliably distinguish from transport failures.

## Decisions

- Delete only touches files the scaffold itself would create. Implementation
  files, runtime storage, and credentials are preserved.
- Delete supports dry-run so agents and operators can preview side effects.
- Typed errors use a shared class with `code`, `message`, `status`, and
  `evidence` so all surfaces (CLI, JSON, gateway) can render them consistently.
- The gateway dispatcher maps typed error codes to HTTP status codes (409, 404)
  rather than returning 500 for domain errors.
- Empty directories are removed after file deletion only when they are clearly
  within scaffold-owned paths and contain no other files.

## Rejected Alternatives

- Full app uninstall including runtime state: rejected because runtime storage
  and credentials may be shared or valuable beyond the scaffold contract.
- Returning free-text errors from scaffold collision: rejected because SDK and
  gateway consumers cannot reliably branch on prose.
- Deleting implementation files alongside scaffold files: rejected because
  implementation files are authored content, not generated boilerplate.
