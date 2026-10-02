# Vendored Baileys build

`baileys-v7.0.0-rc14.tgz` is built from the upstream `7.0.0-rc14` npm release and kept at the same package version so the local-file dependency remains reproducible. It was taken as a byte-identical copy of Omni's `packages/channel-whatsapp/vendor/baileys-v7.0.0-rc14.tgz`; ravi now owns it and no longer depends on Omni for WhatsApp.

In ravi it is a build-time `devDependency` (`file:vendor/baileys/...`, next to the `audio-decode` shim in `vendor/audio-decode-shim/`). It is never inlined into the CLI bundle: `build:vendor` bundles `vendor/baileys-entry.ts` (`export * from "baileys"`) into `dist/vendor/baileys.js` (`--target bun --minify --external sharp --external jimp --external link-preview-js`), and the single-file `dist/bundle/index.js` loads it at run time through `src/channels/whatsapp/baileys-loader.ts` (`loadBaileys()` resolves `../vendor/baileys.js` relative to the running bundle and prefers it whenever it exists; code run from `src/` has no such file and imports the bare `baileys` package instead). `./bin/ravi` rebuilds `dist/vendor/baileys.js` together with the bundle whenever `src/` or `package.json` is newer than the bundle, so a pulled Baileys bump is never left behind in a source checkout. No ravi source file imports a runtime value from `"baileys"`; code that needs one calls `baileys()` after `loadBaileys()` resolved. So the published package declares no `file:` dependency and needs nothing from `vendor/` at runtime, and processes that never open a WhatsApp socket (the CLI, the daemon) never load Baileys. The tarball is committed despite the global `*.tgz` ignore rule (see the `!vendor/**/*.tgz` exception in `.gitignore`): `bun install --frozen-lockfile` needs it.

The artifact carries four focused patches over the stock release (they were first written in Omni):

- support for WhatsApp's passkey companion-pairing ceremony (`passkey_prologue_request` / `crsc_continuation`);
- removal of WebSocket events that Bun does not implement;
- transient pre-key failures use the existing retry path without error-level log noise;
- `generateRegistrationNode` reads `supportGroupHistory` from the socket config instead of hardcoding `false` (#1126).

The passkey implementation validates the WhatsApp relying party, never logs the WebAuthn assertion or derived keys, and exposes the ceremony through typed socket methods and `connection.update` states.

SHA-256: `e363f7146d83897241eaf10432fbdeafbbf7cb2845a592c93bf3fc8386e72a82`

## Refreshing the vendored copy

A pinned tarball has no update signal, so check `npm view baileys dist-tags` when touching the channel (rc10 drifted four RCs silently). Ravi maintains the patch set itself; an Omni refresh of its own copy can be a useful reference for resolving rejects, but it is not required.

1. Download the stock releases for the current and the target version from the npm registry and verify the target against `dist.integrity` (`curl -sO https://registry.npmjs.org/baileys/-/baileys-<ver>.tgz`, then compare `sha512-$(openssl dgst -sha512 -binary <tgz> | base64 -w0)`).
2. Extract the patch set: `diff -ruN -x '*.map' <stock-current>/package <vendored-current>/package > baileys.patch`.
3. Apply it to the target (`patch -p2` inside the extracted `package/`) and hand-resolve any rejects; then repack as `vendor/baileys/baileys-v<ver>.tgz` with a top-level `package/` directory.
4. Point the `baileys` devDependency in `package.json` at the new file, delete the old tarball, and run:

   ```bash
   bun install
   bun install --frozen-lockfile
   bunx tsc --noEmit -p .
   bun test src/channels/whatsapp/
   bun run build
   ```

   `grep -l 'web.whatsapp.com' dist/bundle/*.js dist/vendor/*.js` must list only `dist/vendor/baileys.js`: Baileys belongs in the vendored bundle the runner loads when a WhatsApp runtime starts, never in `dist/bundle/index.js`.
5. Update the SHA-256 above, commit the tarball, `package.json` and `bun.lock` together, and restart the daemon and then the runner (`ravi daemon restart -m "baileys upgrade" && ravi channels restart`) to pick up the new bundle; the runner refuses a bundle that differs from the daemon's.
