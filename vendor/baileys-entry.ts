/**
 * Entry of the vendored Baileys bundle (`build:vendor` → `dist/vendor/baileys.js`).
 *
 * ravi never imports Baileys as a value from its own bundle: the runner loads this
 * bundle at run time through `src/channels/whatsapp/baileys-loader.ts`, which
 * resolves it next to the running `dist/bundle/index.js`. `baileys` is a
 * devDependency, so everything it needs is bundled here except the optional
 * natives `sharp`, `jimp` and `link-preview-js`.
 */
export * from "baileys";
