# ADR 0003: Confine specs operations with native filesystem handles

**Date:** 2026-08-21  
**Status:** accepted

## Context

ADR 0002 required the complete `.ravi/specs` tree to reject symbolic links,
junctions, and unsafe entries. The first implementation checked paths before
using path-based `readdir`, `readFile`, and rename calls. An independent review
showed that another process could replace an entry after the check and before
the later operation reopened the same name. Repeating `lstat` or `realpath`
would only make that race less likely; it would not remove it.

The runtime must support Bun and Node on x64 Windows and Linux. It must fail
closed when the platform primitive or native addon is unavailable, preserve the
legacy CLI contracts, and keep facade creation atomic and idempotent.

## Decision

Use a small C++ Node-API addon to perform each sensitive filesystem operation
as one handle-confined unit. TypeScript may prepare inputs and parse returned
bytes, but it does not reopen specs paths for traversal, reads, staging, or
promotion.

- A snapshot opens the workspace, `.ravi`, `specs`, every descendant, and every
  readable spec file relative to an already pinned parent. It returns contents,
  metadata, and stable filesystem identities gathered from those handles.
- Creation validates the expected workspace and specs binding, scans the whole
  tree, opens or creates ancestors relative to pinned parents, writes a private
  sibling staging directory, rescans the tree while excluding only that exact
  pinned staging identity, verifies the staging contents, and promotes without
  replacement. A second creator fails closed while the first staging directory
  is pinned; a fresh retry observes the completed target and returns `noop`.
- Windows uses `NtCreateFile` with `RootDirectory`,
  `FILE_OPEN_REPARSE_POINT`, and sharing modes that deny later delete/rename
  access to pinned public entries. Reparse points and file hard links are
  rejected. `NtSetInformationFile(FileRenameInformation)` promotes the pinned
  staging handle relative to its pinned parent without replacement, followed by
  identity readback.
- Linux uses `openat2` with `RESOLVE_BENEATH`, `RESOLVE_NO_SYMLINKS`,
  `RESOLVE_NO_MAGICLINKS`, and `RESOLVE_NO_XDEV`. Reads and traversal remain
  descriptor-relative. `renameat2(RENAME_NOREPLACE)` performs promotion and the
  target identity is compared with the staging identity.
- Unsupported operating systems, non-x64 architectures, missing kernel
  primitives, missing prebuilds, or addon contract mismatches are hard errors.
  There is no path-based fallback.
- The addon targets Node-API version 8. On Windows it resolves Node-API symbols
  from the Bun or Node host process because a Zig-linked import of `node.exe`
  crashes Bun. This compatibility shim does not alter filesystem guarantees.
- Zig, Node-API headers, and the C++ wrapper are build-only dependencies. The
  release workflow cross-compiles both targets and CI executes the native specs
  suite independently on Windows and Linux.

## Publication boundary

Tracked source consists of the C++ and header files under
`native/specs-safe-fs`, the TypeScript loader and build script, tests,
documentation, and workflow configuration. Generated prebuild directories are
ignored by Git.

The only generated native files allowed in a package are:

- `native/prebuilds/linux-x64/ravi_specs_safe_fs.node`
- `native/prebuilds/win32-x64/ravi_specs_safe_fs.node`

Import libraries, PDB files, object files, compiler caches, and other linker
outputs are intermediates. The build places them under ignored `.tmp`, removes
that directory after linking, copies only the `.node`, and rejects any
unexpected file in `native/prebuilds`. Windows PE timestamps are normalized
after linking so repeated clean builds are byte-for-byte reproducible.

## Alternatives considered

- **Repeat `lstat` or `realpath` immediately before every use.** Rejected
  because the name can still be replaced after the final check.
- **Use only Node or Bun filesystem APIs.** Rejected because they do not expose
  the complete `openat2`, NT relative-open, sharing, and no-replace operations
  needed to keep the whole sequence on pinned handles.
- **Accept a probabilistic retry loop.** Rejected because reduced race
  likelihood is not confinement.
- **Ship separate runtime-specific addons.** Rejected because Node-API plus the
  Windows host-symbol shim gives one auditable contract for Bun and Node.
- **Publish compiler debug and import artifacts.** Rejected because they are
  not runtime inputs, expand the package, expose local build details, and can
  make candidate contents accidental.

## Consequences

- A link or junction introduced between enumeration and open is rejected
  without reading, promoting, or indexing its target.
- File contents and identities refer to the same opened objects; successful
  reads do not depend on a second path lookup.
- Windows prevents rename/delete replacement while public handles are open.
  Linux pins inode authority: renaming a pinned directory may change its visible
  namespace name, but it cannot redirect an existing descriptor to a newly
  inserted link. Facade readback still reopens the bound namespace and rejects
  a divergent or unsafe result.
- Filesystems or kernels that do not honor the required primitives are not
  supported for specs effects and fail closed.
- Windows can build and execute its addon and cross-compile the Linux addon,
  but only Linux CI can execute the Linux binary. Both CI jobs are required
  before release.

## Revision note: 2026-08-21, promotion and SQLite identity closure

Independent review rejected commit
`7ded59741deb6451f98cd39d77763543719f28af`. Linux promotion still selected
the staging directory by name after checking its pinned handle, SQLite still
opened a mutable textual path after `lstat`, the facade hash omitted the real
specs-root identity, and an `openat2` failure could leave empty directories.
The canonical Ravi Spec also lacked these native invariants.

The correction keeps the original decision and tightens its effect boundaries:

- Linux verifies staging before `renameat2`, verifies the published inode, and
  moves a divergent target to a reserved private name with
  `RENAME_NOREPLACE`; target absence and moved identity are checked, and
  rollback errors are explicit.
- Database planning records the native parent/file identity. The addon keeps
  those handles alive through SQLite access. On Linux it snapshots open process
  descriptors, gives SQLite a descriptor-relative parent path, and requires a
  newly opened descriptor for the pinned inode before any pragma or SQL. On
  Windows it denies delete/rename sharing without requesting delete access that
  would block SQLite itself.
- The facade hash includes `rootBinding` and `dbBinding`; only a confirmed
  absent-to-created effect can reuse the original hash as an exact no-op.
- Linux creation removes operation-created `.ravi` and `.ravi/specs`
  directories when `openat2` becomes unavailable after `mkdirat`, provided the
  directory remains empty and identity-matched.

The alternative of another path recheck was rejected for the same reason as in
the original ADR: it narrows but does not remove the race. Ignoring a failed
post-promotion `rmdir` was also rejected because non-empty substituted content
could remain publicly visible.
