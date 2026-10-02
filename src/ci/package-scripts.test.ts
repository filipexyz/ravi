import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Repo-relative path prefixes whose explicit mentions in a script must exist on disk. */
const CHECKED_PATH = /^(\.\/)?(src|packages|tests|scripts|vendor|docs)\//;

/**
 * Explicit repo paths named by a script (test files, test directories, entry points).
 * Flags (`--path-ignore-patterns=…`), globs and shell variables are skipped: they are
 * patterns, not paths.
 */
function explicitScriptPaths(script: string): string[] {
  const paths: string[] = [];
  for (const raw of script.split(/\s+/)) {
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (!CHECKED_PATH.test(token) || /[*$?{}]/.test(token)) continue;
    paths.push(token);
  }
  return paths;
}

describe("package.json scripts", () => {
  it("extracts explicit paths and skips flags, globs and variables", () => {
    expect(
      explicitScriptPaths(
        "bun test src/channels/ --path-ignore-patterns='src/channels/inbound/**' ./src/a.test.ts && " +
          'for f in src/cli/commands/*.test.ts; do bun test "$f"; done && bun build vendor/x.ts --outfile dist/x.js',
      ),
    ).toEqual(["src/channels/", "./src/a.test.ts", "vendor/x.ts"]);
  });

  // Bun silently ignores an explicit test path that matches nothing when other paths
  // in the same invocation do match, so a renamed or deleted test would stop running.
  it("names only paths that exist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const missing: string[] = [];
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const path of explicitScriptPaths(script)) {
        if (!existsSync(join(REPO_ROOT, path))) missing.push(`${name}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
