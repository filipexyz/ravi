# Artifacts agent-first CLI contract / WHY

Artifacts are the durable-output ledger agents write to constantly: register,
tag, snapshot, attach, archive. Braking that local loop would put exit-3
friction inside routine bookkeeping, so every local write stays immediate. The
line is drawn where bytes leave the machine: `artifacts publish` uploads
content to Console and — by default — activates a hosted Pages release on a
public URL, and `artifacts release activate` flips which content is live on an
existing site. Both are external exposure with no local undo, so both got the
write brake. `archive`/`restore` illustrate the opposite rule: archive is a
soft-delete that stays listable with `--include-deleted`, and restore always
records a new immutable version before touching content, so the pair is
declared unbraked.

Findings from this wave worth carrying forward:

- The artifact store throws (`Artifact not found: <id>`, `Artifact version not
  found: <id> vN`) instead of returning null on almost every op — only
  `getArtifactDetails` returns null. A single `withArtifactContract` wrapper
  around the store call was cheaper and safer than per-op null checks, and it
  distinguishes the version-miss from the artifact-miss so the envelope can
  point at the right listing.
- `publish` and `release activate` already had a legacy CloudAuthError funnel
  ending in `process.exit(cloudError.exitCode)` — with CloudAuthError's OWN
  exit scheme (e.g. PAYLOAD_INVALID → 3), which collides with the Manual v2
  taxonomy. The brake therefore fires BEFORE the try block, and the catch
  rethrows ContractError first (mail.ts model) so a dry-run can never be
  flattened into `SERVER_UNAVAILABLE` + exit 5 in agent context.
- Suggestions come from `listArtifactsPage({limit: 40})` — the ledger is local
  SQLite, so candidates are cheap; version numbers are dense integers where
  similarity would be noise, hence suggestedAction-only on version misses.

Parser-level usage errors use the shared exit-2 `USAGE_ERROR` envelope because
`artifacts` is registered in the global contract domain list.
