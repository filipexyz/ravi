/**
 * The only place ravi loads Baileys as a value.
 *
 * ravi source never has a value import from `"baileys"` (type imports are fine):
 * every module that needs a Baileys runtime value calls `baileys()` at call time,
 * after the channel driver (or a test) has awaited `loadBaileys()`. That keeps
 * Baileys out of the CLI bundle and out of every process that never opens a
 * WhatsApp socket.
 *
 * Resolution, in order:
 * 1. The vendored bundle next to the running ravi bundle: `dist/bundle/index.js`
 *    loads `dist/vendor/baileys.js` (built by `build:vendor` from
 *    `vendor/baileys-entry.ts`). It is imported by absolute file URL.
 * 2. Otherwise (source checkout, tests) the bare `baileys` package, imported through
 *    a specifier the bundler cannot resolve statically, so a bundle never inlines it.
 *
 * A failed load is not cached: the next `loadBaileys()` tries again (the driver
 * retries on the next connect instead of treating it as terminal).
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export type BaileysModule = typeof import("baileys");

export interface LoadBaileysOptions {
  /** Path of the vendored bundle. Default: `bundledBaileysPath()`. */
  readonly bundledPath?: string;
  /** Module importer. Default: dynamic `import()`. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
  /** File existence probe. Default: `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/** Relative location of the vendored bundle from the running bundle file (`dist/bundle/*.js`). */
export const BUNDLED_BAILEYS_RELATIVE_PATH = "../vendor/baileys.js";

let loaded: BaileysModule | null = null;
let loading: Promise<BaileysModule> | null = null;

/**
 * Where the vendored Baileys bundle lives for the module at `moduleUrl`
 * (default: this module, i.e. the running bundle once built): `dist/bundle/index.js`
 * → `dist/vendor/baileys.js`. In a source checkout it points at a path that does not exist.
 */
export function bundledBaileysPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL(BUNDLED_BAILEYS_RELATIVE_PATH, moduleUrl));
}

/**
 * The bare package specifier, built at run time so `bun build` cannot inline the
 * package into the bundle (a literal `import("baileys")` would be bundled).
 */
export function bareBaileysSpecifier(): string {
  return ["bail", "eys"].join("");
}

const defaultImport = (specifier: string): Promise<unknown> => import(specifier);

function asBaileysModule(value: unknown, source: string): BaileysModule {
  const candidate = value as Partial<BaileysModule> | null;
  if (!candidate || typeof candidate.makeWASocket !== "function" || typeof candidate.BufferJSON !== "object") {
    throw new Error(`${source} is not a Baileys module (makeWASocket/BufferJSON missing)`);
  }
  return candidate as BaileysModule;
}

/** Load (once) and return the Baileys module. Concurrent callers share one load; a failure is retried next call. */
export function loadBaileys(options: LoadBaileysOptions = {}): Promise<BaileysModule> {
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;
  const importModule = options.importModule ?? defaultImport;
  const exists = options.exists ?? existsSync;
  const bundled = options.bundledPath ?? bundledBaileysPath();
  const attempt = (async () => {
    const useBundled = exists(bundled);
    const specifier = useBundled ? pathToFileURL(bundled).href : bareBaileysSpecifier();
    const module = asBaileysModule(await importModule(specifier), useBundled ? bundled : "the baileys package");
    loaded = module;
    return module;
  })();
  loading = attempt;
  attempt.then(
    () => {
      if (loading === attempt) loading = null;
    },
    () => {
      if (loading === attempt) loading = null;
    },
  );
  return attempt;
}

/** The loaded Baileys module. Throws when `loadBaileys()` has not completed yet. */
export function baileys(): BaileysModule {
  if (!loaded) {
    throw new Error("Baileys is not loaded yet: await loadBaileys() before using the WhatsApp library");
  }
  return loaded;
}

export function isBaileysLoaded(): boolean {
  return loaded !== null;
}

/** Test-only: forget the loaded module so the next `loadBaileys()` resolves again. */
export function resetBaileysLoaderForTests(): void {
  loaded = null;
  loading = null;
}
