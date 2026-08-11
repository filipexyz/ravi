# Kimi Code Provider Merge Blockers — Design

## Goal

Remove the four merge blockers found after the first Kimi Code hardening wave:
empty assistant tool-call content, an unresumable state/request size mismatch,
unbounded durable reasoning retention, and valid macOS workspace identities
rejected because their device number is signed.

## Decisions

### Assistant tool-call content

The outbound native assistant-message shape permits an omitted `content` field
only when the message contains one or more `tool_calls` and the public text is
empty. It must never serialize `content: ""`. Assistant messages without tool
calls still require non-empty content. This preserves the tool-call payload
without inventing model-visible placeholder text.

### State and request budgets

Kimi Code request bodies have a hard 2 MiB serialized limit. Durable native
history is limited to 1 MiB, measured as UTF-8 JSON for the snapshot. This
leaves a conservative 1 MiB request headroom for the next prompt, tools,
system prompt, and JSON framing. The adapter does not summarize or silently
drop preserved reasoning. A history that exceeds the durable budget fails
before publication; a later oversized prompt still fails as a bounded request
error and never corrupts existing state.

### Retention and lifecycle cleanup

The currently published revision is the only revision required for a resume.
After an atomic publish succeeds, cleanup removes older immutable revisions and
unpublished temporary files in that session directory, never the revision named
by the returned locator. Cleanup is idempotent and failures leave the current
locator valid.

Provider-owned state is removed when Ravi explicitly resets, deletes, or
expires a Kimi-backed session. The deletion boundary receives only a validated
Kimi locator and removes its UUID session directory beneath the provider state
root after reparse and containment checks. It must not follow links or delete
an unvalidated path. Existing generic sessions/providers retain their present
behavior.

### macOS workspace identity

Workspace device values are opaque signed integers. A negative `stat().dev`
is valid when it is returned by the platform and is compared byte-for-byte with
the saved identity. The parser accepts an optional leading minus sign. Inode
remains strictly positive. This supports normal Darwin realpaths such as
`/private/var/...` while retaining the existing `realpath`, inode, containment,
and reparse checks.

## Failure behavior

- Empty content outside a tool-call assistant message is invalid.
- State over 1 MiB fails before publication and preserves the last locator.
- Cleanup failure is reported internally but never invalidates a published
  snapshot or broadens deletion scope.
- Invalid, foreign, traversal, symlink, or reparse locators fail closed during
  cleanup.

## Validation

Each blocker receives a focused RED-to-GREEN regression. The final gate runs
Kimi provider, transport, state, lifecycle and affected session tests; then
typecheck, build, quality/spec checks, public-contribution sanitization, and
upstream CI. Private live checks remain mandatory before merge/release with a
new privately managed credential.

