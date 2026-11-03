// Builds the two scripts the page kit inlines in shipped pages into
// `src/server/console/pages/kit/runtime.generated.ts`:
// - the Pages runtime (`src/pages-runtime/index.ts`), for files with tags;
// - the theme-live script (`src/pages-runtime/theme-live.ts`), for files of a
//   private route with a live theme and no tags.
// Bun.build, browser target, IIFE, minified, no source map. The generated
// file carries each script as a JSON string with its sha256 (hex), and one
// source hash over every file either bundle includes (from the builds'
// metafiles) plus this script and tsconfig.json, so a test can tell when the
// generated file is stale.
//
//   bun run pages:runtime:build

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { RUNTIME_VERSION } from "../src/pages-runtime/version";

export const REPO_ROOT = join(import.meta.dir, "..");
export const PAGES_RUNTIME_ENTRY = "src/pages-runtime/index.ts";
export const PAGES_THEME_LIVE_ENTRY = "src/pages-runtime/theme-live.ts";
export const PAGES_RUNTIME_OUTPUT = "src/server/console/pages/kit/runtime.generated.ts";
/** Build inputs outside the bundles that change their output: the build options here and the compiler options. */
export const PAGES_RUNTIME_BUILD_INPUTS = ["scripts/build-pages-runtime.ts", "tsconfig.json"] as const;
/**
 * Minified size budget of the runtime. CONTRACT section 6 asks for 60 KB,
 * but the shared renderer the runtime must embed
 * (`src/shared/widgets/render/**`) is already about 44 KB minified, so the
 * full runtime is about 79 KB (29 KB gzip). Widget code (`widget.js`,
 * JS-CONTRACT J5) raised the line from 80 KB to 96 KB. Bases H2 (the chart
 * renderer, the calendar and form layouts, inline editors for every type,
 * approval and agent cells, search and near-live refresh, about 22 KB with
 * their PT-BR and English text) raised it to 112 KB (114688 bytes).
 */
export const PAGES_RUNTIME_MAX_BYTES = 112 * 1024;
/** Minified size budget of the theme-live script. */
export const PAGES_THEME_LIVE_MAX_BYTES = 4 * 1024;

export type PagesRuntimeBuild = {
  version: string;
  js: string;
  sha256: string;
  themeLiveJs: string;
  themeLiveSha256: string;
  sourceSha256: string;
  /** Repo-relative paths of the source files of both bundles, sorted. */
  inputs: string[];
  /** The same, per bundle. */
  runtimeInputs: string[];
  themeLiveInputs: string[];
};

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

/** sha256 over each input's path and content, in path order. */
export function pagesRuntimeSourceHash(inputs: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...inputs].sort()) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(join(REPO_ROOT, path), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** One entry as a minified IIFE, with the repo files it bundles. */
async function bundle(entry: string): Promise<{ js: string; inputs: string[] }> {
  const result = await Bun.build({
    entrypoints: [join(REPO_ROOT, entry)],
    root: REPO_ROOT,
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "none",
    metafile: true,
    tsconfig: join(REPO_ROOT, "tsconfig.json"),
  } as Parameters<typeof Bun.build>[0] & { metafile: boolean });
  if (!result.success || !result.outputs[0]) {
    throw new Error(`Pages runtime build failed (${entry}):\n${result.logs.map((log) => String(log)).join("\n")}`);
  }
  const js = (await result.outputs[0].text()).trim();
  const metafile = (result as unknown as { metafile?: { inputs?: Record<string, unknown> } }).metafile;
  const inputs = Object.keys(metafile?.inputs ?? {})
    .map((path) => relative(REPO_ROOT, join(REPO_ROOT, path)).split("\\").join("/"))
    .sort();
  if (!inputs.includes(entry)) throw new Error(`Pages runtime build: the metafile does not list ${entry}.`);
  // No dependencies (CONTRACT section 6), so the source hash covers every byte that goes in.
  const dependency = inputs.find((path) => path.startsWith("node_modules/"));
  if (dependency) throw new Error(`Pages runtime build: ${entry} bundles a dependency (${dependency}).`);
  // The kit inlines the bundle in a <script>: it must not be able to close it or open a comment.
  if (/<\/script|<!--/i.test(js)) throw new Error(`Pages runtime build: the ${entry} bundle contains </script or <!--.`);
  return { js, inputs };
}

export async function buildPagesRuntime(): Promise<PagesRuntimeBuild> {
  const [runtime, themeLive] = await Promise.all([bundle(PAGES_RUNTIME_ENTRY), bundle(PAGES_THEME_LIVE_ENTRY)]);
  const inputs = [...new Set([...runtime.inputs, ...themeLive.inputs])].sort();
  return {
    version: RUNTIME_VERSION,
    js: runtime.js,
    sha256: sha256(runtime.js),
    themeLiveJs: themeLive.js,
    themeLiveSha256: sha256(themeLive.js),
    sourceSha256: pagesRuntimeSourceHash([...inputs, ...PAGES_RUNTIME_BUILD_INPUTS]),
    inputs,
    runtimeInputs: runtime.inputs,
    themeLiveInputs: themeLive.inputs,
  };
}

/** Budget overruns, as messages; empty when both scripts fit. */
export function pagesRuntimeBudgetErrors(build: Pick<PagesRuntimeBuild, "js" | "themeLiveJs">): string[] {
  const errors: string[] = [];
  const check = (name: string, js: string, max: number) => {
    const bytes = Buffer.byteLength(js, "utf8");
    if (bytes > max) errors.push(`The ${name} is ${bytes} bytes, over its ${max}-byte budget.`);
  };
  check("Pages runtime", build.js, PAGES_RUNTIME_MAX_BYTES);
  check("theme-live script", build.themeLiveJs, PAGES_THEME_LIVE_MAX_BYTES);
  return errors;
}

export function generatedPagesRuntimeModule(build: PagesRuntimeBuild): string {
  return [
    "// Generated by scripts/build-pages-runtime.ts. Do not edit by hand; run `bun run pages:runtime:build`.",
    `// Runtime bundled from: ${build.runtimeInputs.join(", ")}`,
    `// Theme-live script bundled from: ${build.themeLiveInputs.join(", ")}`,
    `// The source hash also covers: ${PAGES_RUNTIME_BUILD_INPUTS.join(", ")}`,
    "",
    `export const PAGES_RUNTIME_VERSION = ${JSON.stringify(build.version)};`,
    `export const PAGES_RUNTIME_SHA256 = ${JSON.stringify(build.sha256)};`,
    `export const PAGES_RUNTIME_SOURCE_SHA256 = ${JSON.stringify(build.sourceSha256)};`,
    `export const PAGES_THEME_LIVE_SHA256 = ${JSON.stringify(build.themeLiveSha256)};`,
    `export const PAGES_THEME_LIVE_JS = ${JSON.stringify(build.themeLiveJs)};`,
    `export const PAGES_RUNTIME_JS = ${JSON.stringify(build.js)};`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const build = await buildPagesRuntime();
  const errors = pagesRuntimeBudgetErrors(build);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  writeFileSync(join(REPO_ROOT, PAGES_RUNTIME_OUTPUT), generatedPagesRuntimeModule(build));
  console.log(
    `Wrote ${PAGES_RUNTIME_OUTPUT}: runtime ${Buffer.byteLength(build.js, "utf8")} bytes (sha256 ${build.sha256}), ` +
      `theme-live ${Buffer.byteLength(build.themeLiveJs, "utf8")} bytes (sha256 ${build.themeLiveSha256}), ${build.inputs.length} source files.`,
  );
}
