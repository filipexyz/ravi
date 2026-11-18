import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync, YAML } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ciCoverage,
  collectCiInvocations,
  collectScriptInvocations,
  DEDICATED_RUNNERS,
  type Invocation,
  listRepoFiles,
  TEST_FILE_PATTERN,
  selectedFiles,
  type Workflow,
  type WorkflowStep,
} from "./test-discovery.js";
import { TEST_EXCLUSIONS } from "./test-discovery-exclusions.js";

const root = resolve(import.meta.dir, "../..");

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

/** A workflow with one job per script, in the shape the helper reads. */
function workflowOf(steps: Array<{ name: string; run: string }>, matrix?: Record<string, unknown[]>): Workflow {
  return { jobs: { tests: { ...(matrix ? { strategy: { matrix } } : {}), steps } } };
}

/** A GitHub Actions expression, written without a template placeholder in the source. */
const expr = (expression: string) => "$" + "{{ " + expression + " }}";

function filtersOf(invocations: Invocation[]): string[][] {
  return invocations.map((invocation) => invocation.filters);
}

describe("filter selection", () => {
  const files = [
    "src/pr/service.test.ts",
    "src/pr/journal.test.ts",
    "src/prox/calls.test.ts",
    "src/cli/media-send.test.ts",
    "src/cli/media-send-auth.test.ts",
    "src/runtime/deep/nested/turn.test.ts",
    "packages/sdk/src/pr/inner.test.ts",
  ];
  const select = (...filters: string[]) =>
    selectedFiles({ origin: "t", command: "bun test", filters, files: [] }, files, "/repo");

  it("treats a filter without ./ as a substring of the path", () => {
    // A directory-looking filter is still a substring: it also selects the same path inside a nested package.
    expect(select("src/pr/")).toEqual([
      "src/pr/service.test.ts",
      "src/pr/journal.test.ts",
      "packages/sdk/src/pr/inner.test.ts",
    ]);
    // Without the trailing slash it also selects src/prox.
    expect(select("src/pr")).toEqual([
      "src/pr/service.test.ts",
      "src/pr/journal.test.ts",
      "src/prox/calls.test.ts",
      "packages/sdk/src/pr/inner.test.ts",
    ]);
    expect(select("media-send-")).toEqual(["src/cli/media-send-auth.test.ts"]);
    expect(select("src/cli/media-send")).toEqual(["src/cli/media-send.test.ts", "src/cli/media-send-auth.test.ts"]);
  });

  it("treats a filter with ./, ../ or / as a path: a directory selects what is below it, a file selects itself", () => {
    expect(select("./src/pr")).toEqual(["src/pr/service.test.ts", "src/pr/journal.test.ts"]);
    expect(select("./src/pr/")).toEqual(["src/pr/service.test.ts", "src/pr/journal.test.ts"]);
    expect(select("./src/runtime")).toEqual(["src/runtime/deep/nested/turn.test.ts"]);
    expect(select("./src/cli/media-send.test.ts")).toEqual(["src/cli/media-send.test.ts"]);
    expect(select("/repo/src/cli/media-send.test.ts")).toEqual(["src/cli/media-send.test.ts"]);
    // A path that names neither a file nor a directory selects nothing: it is not a prefix.
    expect(select("./src/cli/media-send")).toEqual([]);
    expect(select("../elsewhere/src/pr/service.test.ts")).toEqual([]);
  });

  it("selects the union of the filters, and every file for no filter", () => {
    expect(select("nothing-matches", "src/cli/media-send.test.ts")).toEqual(["src/cli/media-send.test.ts"]);
    expect(select()).toEqual(files);
  });

  it("agrees with the real bun on every filter shape", () => {
    // The helper is a model of how Bun selects files. Run the real `bun test` over stub files and compare, so a
    // change in Bun's selection rule breaks this test instead of silently changing what the gate believes CI runs.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-test-discovery-")));
    cleanup.push(dir);
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(
        join(dir, file),
        `import { test } from "bun:test";\nconsole.log("@@RAN ${file}");\ntest("ran", () => {});\n`,
      );
    }
    const shapes: string[][] = [
      ["src/pr/"],
      ["src/pr"],
      ["pr/"],
      ["media-send-"],
      ["src/cli/media-send"],
      ["./src/pr"],
      ["./src/pr/"],
      ["./src/runtime"],
      ["./src/cli/media-send.test.ts"],
      ["./src/cli/media-send"],
      [join(dir, "src/cli/media-send.test.ts")],
      ["nothing-matches", "src/cli/media-send.test.ts"],
      ["./src/missing.test.ts", "src/pr/journal.test.ts"],
      ["src/pr/service.test.ts", "src/pr/service.test.ts"],
    ];
    for (const filters of shapes) {
      const result = spawnSync([process.execPath, "test", ...filters], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
      const ran = [...output.matchAll(/@@RAN (\S+)/g)].map((match) => match[1]!).sort();
      const modelled = selectedFiles({ origin: "t", command: "bun test", filters, files: [] }, files, dir).sort();
      expect(modelled, `bun test ${filters.join(" ")}`).toEqual(ran);
    }
  });
});

describe("reading CI commands", () => {
  const files = [
    "src/a/one.test.ts",
    "src/a/two.test.ts",
    "src/b/three.test.ts",
    "src/cmds/x.test.ts",
    "src/cmds/y.test.ts",
    "src/runtime/direct-interrupted-retention.test.ts",
  ];

  it("follows matrix values and bun run chains, and skips flags, flag values and env prefixes", () => {
    const scripts = {
      "test:shard-1": "bun run test:a && bun --no-env-file test --timeout 20000 --preload ./pre.ts src/b/ -t name",
      "test:shard-2": "RAVI_X=1 bun test --bail=1 ./src/cmds src/a/one.test.ts",
      "test:a": "bun test src/a/",
    };
    const workflow = workflowOf([{ name: "Test", run: `bun run test:shard-${expr("matrix.shard")}` }], {
      shard: [1, 2],
    });
    const invocations = collectCiInvocations(scripts, workflow, files);
    expect(filtersOf(invocations)).toEqual([["src/a/"], ["src/b/"], ["./src/cmds", "src/a/one.test.ts"]]);
    expect(invocations.map((invocation) => invocation.origin)).toEqual([
      "tests (1) › Test › test:shard-1 › test:a",
      "tests (1) › Test › test:shard-1",
      "tests (2) › Test › test:shard-2",
    ]);
  });

  it("unrolls a for loop over a glob and drops loops that run no bun", () => {
    const scripts = {
      "test:cmds": 'for f in src/cmds/*.test.ts; do bun test --timeout 20000 "$f" || exit 1; done && bun test src/b/',
      other: "for f in scripts/*.sh; do bash $f; done",
    };
    const workflow = workflowOf([
      { name: "Cmds", run: "bun run test:cmds" },
      { name: "Other", run: "bun run other" },
    ]);
    expect(filtersOf(collectCiInvocations(scripts, workflow, files))).toEqual([
      ["src/cmds/x.test.ts"],
      ["src/cmds/y.test.ts"],
      ["src/b/"],
    ]);
  });

  it("expands an unquoted glob in a bun test argument like the shell does", () => {
    const scripts = { "test:live": "RAVI_LIVE_TESTS=1 bun test src/cmds/*.test.ts" };
    expect(filtersOf(collectScriptInvocations("test:live", scripts, files))).toEqual([
      ["src/cmds/x.test.ts", "src/cmds/y.test.ts"],
    ]);
  });

  it("reads multi-line run steps and ignores commands that are not bun", () => {
    const run = [
      "echo hello >> $GITHUB_ENV",
      "bun install --frozen-lockfile",
      "bun test src/a/one.test.ts",
      "swift test",
    ].join("\n");
    const invocations = collectCiInvocations({}, workflowOf([{ name: "Mixed", run }]), files);
    expect(filtersOf(invocations)).toEqual([["src/a/one.test.ts"]]);
  });

  it("maps a script that spawns bun test itself to the files it runs", () => {
    const scripts = { "test:direct": "bun --no-env-file scripts/test-direct-interrupted-retention.ts" };
    const workflow = workflowOf([{ name: "Direct", run: "bun --no-env-file run test:direct" }]);
    const [invocation] = collectCiInvocations(scripts, workflow, files);
    expect(invocation?.files).toEqual(["src/runtime/direct-interrupted-retention.test.ts"]);
    expect(selectedFiles(invocation!, files)).toEqual(["src/runtime/direct-interrupted-retention.test.ts"]);
  });

  it("fails closed on commands it cannot read instead of skipping them", () => {
    const read = (run: string, scripts: Record<string, string> = {}, step: Partial<WorkflowStep> = {}) =>
      collectCiInvocations(scripts, { jobs: { tests: { steps: [{ name: "Test", run, ...step }] } } }, files);
    expect(() => read('bash -c "bun test src/a/"')).toThrow("wrapped");
    expect(() => read("xargs bun test < list.txt")).toThrow("wrapped");
    expect(() => read("bun test --path-ignore-patterns src/a src/b/")).toThrow("unknown bun test flag");
    expect(() => read("bun test --cwd packages src/b/")).toThrow("unknown bun test flag");
    expect(() => read("bun test $(ls src/a)")).toThrow("substitution");
    expect(() => read("bun test src/b/ 2>&1")).toThrow("redirection");
    expect(() => read("bun test src/zzz/*.test.ts")).toThrow("matches no test file");
    expect(() => read("bun run nope")).toThrow("not a package.json script");
    expect(() => read("bun run a", { a: "bun run b", b: "bun run a" })).toThrow("runs itself");
    expect(() => read(`bun test src/b/${expr("github.sha")}`)).toThrow("GitHub expression");
    expect(() => read(`bun run test:shard-${expr("matrix.shard")}`, { "test:shard-1": "bun test src/a/" })).toThrow(
      "matrix.shard has no value",
    );
    expect(() => read("bun test src/b/", {}, { "working-directory": "pkg" })).toThrow("working-directory");
  });

  it("reports filters that select no file, which Bun ignores while another filter of the command matches", () => {
    const scripts = { "test:a": "bun test src/a/ src/gone/ ./src/also-gone.test.ts" };
    const invocations = collectCiInvocations(scripts, workflowOf([{ name: "A", run: "bun run test:a" }]), files);
    const coverage = ciCoverage(invocations, files);
    expect(coverage.deadFilters.map((dead) => dead.filter)).toEqual(["src/gone/", "./src/also-gone.test.ts"]);
    expect([...coverage.runBy.keys()].sort()).toEqual(["src/a/one.test.ts", "src/a/two.test.ts"]);
  });
});

/**
 * What CI runs, read from this checkout. Loaded inside the tests rather than while the file is collected, so a
 * command the helper refuses to read fails the test that needs it, with its message, and not the whole file.
 */
let repoCache: ReturnType<typeof loadRepo> | undefined;
function loadRepo() {
  const existing = listRepoFiles(root);
  const files = existing.filter((path) => TEST_FILE_PATTERN.test(path));
  const scripts = (
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
  const workflow = YAML.parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const coverage = ciCoverage(collectCiInvocations(scripts, workflow, files), files, root, existing);
  return { files, scripts, coverage };
}
const repo = () => {
  repoCache ??= loadRepo();
  return repoCache;
};

describe("the repository's test files", () => {
  it("every test file runs in a CI job or is excluded with a reason", () => {
    const { files, coverage } = repo();
    const unrun = files.filter((file) => !coverage.runBy.has(file) && !Object.hasOwn(TEST_EXCLUSIONS, file));
    expect(
      unrun,
      [
        "These test files are selected by no CI command, so CI never runs them:",
        ...unrun.map((file) => `  ${file}`),
        "Add each to a test:shard-N script in package.json (a directory filter such as `src/foo/` also picks up",
        "files added later), or list it in src/ci/test-discovery-exclusions.ts with the reason it is not run in CI.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("every exclusion names a test file CI does not run, with a reason", () => {
    const { files, scripts, coverage } = repo();
    for (const [file, exclusion] of Object.entries(TEST_EXCLUSIONS)) {
      expect(files, `${file} is excluded but is not a test file in the checkout: delete the exclusion`).toContain(file);
      expect(coverage.runBy.get(file) ?? [], `${file} is excluded but CI runs it: delete the exclusion`).toEqual([]);
      expect(exclusion.reason.trim().length, `${file}: say why CI does not run it`).toBeGreaterThanOrEqual(40);
      if (exclusion.runBy === undefined) continue;
      const runByScript = collectScriptInvocations(exclusion.runBy, scripts, files);
      const selected = runByScript.some((invocation) => selectedFiles(invocation, files, root).includes(file));
      expect(selected, `${file} says it is run by \`bun run ${exclusion.runBy}\`, which does not select it`).toBe(true);
    }
  });

  it("no filter of a CI command points at nothing", () => {
    // Bun only fails when no filter of a command matches, so a renamed or deleted path in a mixed command is
    // dropped without a word and the tests it used to name stop running.
    const { coverage } = repo();
    expect(
      coverage.deadFilters.map((dead) => `${dead.origin}: ${dead.filter}`),
      "These filters select no test file; fix the path or delete the filter:",
    ).toEqual([]);
  });

  it("each script that spawns bun test itself still names the files it runs", () => {
    const { files } = repo();
    for (const [script, runnerFiles] of Object.entries(DEDICATED_RUNNERS)) {
      const source = readFileSync(resolve(root, script), "utf8");
      for (const file of runnerFiles) {
        expect(files, `${file} is listed for ${script} but is not a test file`).toContain(file);
        expect(
          source,
          `${script} no longer mentions ${file}: update DEDICATED_RUNNERS in src/ci/test-discovery.ts`,
        ).toContain(file);
      }
    }
  });
});
