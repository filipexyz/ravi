# Specs native filesystem layer

This directory contains the source for the handle-confined `.ravi/specs`
filesystem operations described by ADR 0003.

## Source and package boundary

The `.cc` and `.h` files are tracked source. `scripts/build-specs-native.ts`,
the TypeScript loader, native tests, and CI configuration are also source.

`native/prebuilds` is generated and ignored. A release package may contain only
one `ravi_specs_safe_fs.node` in each supported platform directory. `.lib`,
`.pdb`, `.obj`, compiler caches, and linker by-products are temporary build
artifacts and must never be committed or packaged.

Use `bun run build:native` for the host platform, `bun run build:native:all` for
both release targets, and `bun run check:native-package` to reject a missing or
contaminated publish set.

## Runtime boundary

The addon supports x64 Windows and Linux through Node-API version 8. A missing
addon or unavailable operating-system primitive is a hard failure; there is no
path-based fallback.

