/**
 * Which test files does CI actually run?
 *
 * CI runs curated `bun test <filters>` commands: the `test:shard-N` scripts in package.json and a few steps in
 * .github/workflows/ci.yml. A test file that no command selects never runs, and nothing says so. This module answers
 * "which files does CI run" from the commands themselves, with Bun's own selection rule, so
 * `src/ci/test-discovery.test.ts` can fail the gate when a file is left out.
 *
 * Analysis fails closed: a command it cannot read (a wrapped `bun`, a `$(...)`, an unknown `bun test` flag) throws
 * instead of being skipped, because a skipped command would make files look covered when they are not.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix } from "node:path";

/** File names Bun's test runner picks up by itself: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
export const TEST_FILE_PATTERN = /[._](?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * Scripts that spawn `bun test` themselves, with the test files they run. A `bun <script>` command in CI selects
 * exactly these files; `test-discovery.test.ts` checks that each script still names its files.
 */
export const DEDICATED_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  "scripts/test-direct-interrupted-retention.ts": ["src/runtime/direct-interrupted-retention.test.ts"],
  "scripts/test-retained-preload.ts": ["src/test/retained-preload-contract.fixture.test.ts"],
};

export type PackageScripts = Readonly<Record<string, string>>;
export type WorkflowStep = { name?: string; run?: string; "working-directory"?: string };
export type WorkflowJob = { name?: string; strategy?: { matrix?: Record<string, unknown> }; steps?: WorkflowStep[] };
export type Workflow = { jobs: Record<string, WorkflowJob> };

export type Invocation = {
  /** Job, step and script chain the command comes from, for messages. */
  origin: string;
  /** The command as written, for messages. */
  command: string;
  /** Positional `bun test` filters after the shell expanded globs. Empty selects every test file. */
  filters: string[];
  /** Files a dedicated runner script is known to run. Used instead of filters. */
  files: string[];
};

export type DeadFilter = { origin: string; command: string; filter: string };

export type CiCoverage = {
  invocations: Invocation[];
  /** Test file -> the commands that select it. */
  runBy: Map<string, string[]>;
  /** Filters that select no test file. Bun ignores them as long as another filter of the command matches. */
  deadFilters: DeadFilter[];
};

/** Files of the checkout: tracked plus untracked and not ignored, so build output never counts. */
export function listRepoFiles(root: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\0")
    .filter((path) => path !== "" && existsSync(posix.join(root, path)))
    .sort();
}

/** The files of the checkout that Bun's test runner picks up by name. */
export function listTestFiles(root: string): string[] {
  return listRepoFiles(root).filter((path) => TEST_FILE_PATTERN.test(path));
}

/**
 * Whether `bun test <filter>` selects `file`, a path relative to `root` with `/` separators. Measured with Bun 1.3:
 * a filter that starts with `./`, `../` or `/` is a path (a directory selects every test below it, a file selects
 * itself); any other filter is a substring of the relative path, so `src/pr` also selects `src/prox/...`.
 */
export function filterSelects(filter: string, file: string, root = "/repo"): boolean {
  if (filter.startsWith("./") || filter.startsWith("../") || filter.startsWith("/")) {
    const relative = posix.relative(root, posix.resolve(root, filter));
    if (relative === "" || relative.startsWith("..")) return false;
    return file === relative || file.startsWith(`${relative}/`);
  }
  return file.includes(filter);
}

/** The files one command runs: its dedicated-runner files, every test for no filter, else the filters' matches. */
export function selectedFiles(invocation: Invocation, files: readonly string[], root = "/repo"): string[] {
  if (invocation.files.length > 0) return files.filter((file) => invocation.files.includes(file));
  if (invocation.filters.length === 0) return [...files];
  return files.filter((file) => invocation.filters.some((filter) => filterSelects(filter, file, root)));
}

/** Every `bun test` command CI runs, found from the workflow's `run` steps through `bun run <script>` chains. */
export function collectCiInvocations(
  scripts: PackageScripts,
  workflow: Workflow,
  files: readonly string[],
): Invocation[] {
  const invocations: Invocation[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const binding of matrixBindings(job)) {
      const matrixLabel = Object.keys(binding).length === 0 ? "" : ` (${Object.values(binding).join(", ")})`;
      for (const step of job.steps ?? []) {
        if (!step.run || !/\bbun\b/.test(step.run)) continue;
        const origin = `${jobId}${matrixLabel} › ${step.name ?? "(unnamed step)"}`;
        if (step["working-directory"] && /\btest\b/.test(step.run)) {
          throw new Error(
            `${origin}: a test command in a step with working-directory resolves scripts and paths elsewhere; ` +
              "src/ci/test-discovery.ts does not analyse that. Run it from the repository root.",
          );
        }
        const run = substituteMatrix(step.run, binding, origin);
        invocations.push(...collectCommands(run, { scripts, files, origin, stack: [] }));
      }
    }
  }
  return invocations;
}

/** The `bun test` commands of one package.json script, for scripts CI does not run (`test:live`). */
export function collectScriptInvocations(
  name: string,
  scripts: PackageScripts,
  files: readonly string[],
): Invocation[] {
  const script = scripts[name];
  if (script === undefined) throw new Error(`package.json has no script ${name}`);
  return collectCommands(script, { scripts, files, origin: name, stack: [name] });
}

/**
 * Coverage of the test `files` by `invocations`: which command runs each file, and which filters select nothing.
 * `existing` is every file of the checkout: an explicit path may name a file that is not called `*.test.ts`
 * (a type-level test, say), and Bun runs it anyway.
 */
export function ciCoverage(
  invocations: Invocation[],
  files: readonly string[],
  root = "/repo",
  existing: readonly string[] = files,
): CiCoverage {
  const runBy = new Map<string, string[]>();
  const deadFilters: DeadFilter[] = [];
  const isExplicitPath = (filter: string) => /^(\.\.?\/|\/)/.test(filter);
  for (const invocation of invocations) {
    const label = `${invocation.origin}: ${invocation.command}`;
    for (const file of selectedFiles(invocation, files, root)) runBy.set(file, [...(runBy.get(file) ?? []), label]);
    const dead = [
      ...invocation.filters.filter(
        (filter) => !(isExplicitPath(filter) ? existing : files).some((file) => filterSelects(filter, file, root)),
      ),
      ...invocation.files.filter((file) => !existing.includes(file)),
    ];
    for (const filter of dead) deadFilters.push({ origin: invocation.origin, command: invocation.command, filter });
  }
  return { invocations, runBy, deadFilters };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading shell commands
// ---------------------------------------------------------------------------------------------------------------

type Word = { text: string; glob: boolean; unsafe: boolean; redirect: boolean };
type Piece = { word: Word } | { op: string };
type Context = { scripts: PackageScripts; files: readonly string[]; origin: string; stack: string[] };

/** Flags `bun` accepts before its subcommand that take no value. */
const BUN_GLOBAL_FLAGS = new Set(["--no-env-file", "--bun"]);
/** `bun run` flags that take no value. */
const BUN_RUN_FLAGS = new Set(["--no-env-file", "--bun", "--silent"]);
/** `bun test` flags that take no value. A `--flag=value` spelling is accepted for every known flag. */
const TEST_FLAGS_WITHOUT_VALUE = new Set([
  "--bail",
  "--bun",
  "--concurrent",
  "--coverage",
  "--dots",
  "--no-env-file",
  "--only",
  "--only-failures",
  "--randomize",
  "--todo",
  "--update-snapshots",
  "-u",
]);
/** `bun test` flags that take a value. `--cwd` and `--path-ignore-patterns` are deliberately absent: they change which files match. */
const TEST_FLAGS_WITH_VALUE = new Set([
  "--coverage-dir",
  "--coverage-reporter",
  "--max-concurrency",
  "--preload",
  "--reporter",
  "--reporter-outfile",
  "--rerun-each",
  "--seed",
  "--test-name-pattern",
  "--timeout",
  "-t",
]);
/** Words that run another command; a `bun` inside them cannot be analysed. */
const WRAPPERS = new Set([
  "bash",
  "sh",
  "zsh",
  "env",
  "xargs",
  "nice",
  "time",
  "timeout",
  "sudo",
  "exec",
  "command",
  "nohup",
]);
/** `bun` subcommands that win over a package script of the same name. */
const BUN_BUILTINS = new Set([
  "add",
  "audit",
  "build",
  "create",
  "exec",
  "info",
  "init",
  "install",
  "link",
  "outdated",
  "patch",
  "pm",
  "publish",
  "remove",
  "repl",
  "test",
  "run",
  "unlink",
  "update",
  "upgrade",
  "x",
]);

function tokenize(script: string): Piece[] {
  const pieces: Piece[] = [];
  let current: Word | null = null;
  const word = (): Word => {
    current ??= { text: "", glob: false, unsafe: false, redirect: false };
    return current;
  };
  const flush = () => {
    if (current) pieces.push({ word: current });
    current = null;
  };
  let i = 0;
  while (i < script.length) {
    const c = script[i]!;
    const next = script[i + 1];
    if (c === "\\" && next === "\n") {
      i += 2;
    } else if (c === "\\") {
      word().text += next ?? "";
      i += 2;
    } else if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
    } else if (c === "\n") {
      flush();
      pieces.push({ op: ";" });
      i++;
    } else if (c === "#" && !current) {
      while (i < script.length && script[i] !== "\n") i++;
    } else if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      flush();
      pieces.push({ op: c + c });
      i += 2;
    } else if (c === ";" || c === "|" || c === "&") {
      flush();
      pieces.push({ op: c });
      i++;
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      word().text += end < 0 ? script.slice(i + 1) : script.slice(i + 1, end);
      i = end < 0 ? script.length : end + 1;
    } else if (c === '"') {
      const w = word();
      i++;
      while (i < script.length && script[i] !== '"') {
        const inner = script[i]!;
        const after = script[i + 1];
        if (inner === "\\" && after !== undefined && '"\\$`'.includes(after)) {
          w.text += after;
          i += 2;
          continue;
        }
        if (inner === "`" || (inner === "$" && after === "(")) w.unsafe = true;
        w.text += inner;
        i++;
      }
      i++;
    } else if (c === "`" || (c === "$" && next === "(")) {
      const w = word();
      w.unsafe = true;
      w.text += c;
      i++;
    } else if (c === "*" || c === "?" || c === "[") {
      const w = word();
      w.glob = true;
      w.text += c;
      i++;
    } else if (c === "<" || c === ">") {
      const w = word();
      w.redirect = true;
      w.text += c;
      i++;
    } else {
      word().text += c;
      i++;
    }
  }
  flush();
  return pieces;
}

function splitCommands(pieces: Piece[]): Word[][] {
  const commands: Word[][] = [];
  let current: Word[] = [];
  for (const piece of pieces) {
    if ("word" in piece) {
      current.push(piece.word);
    } else {
      if (current.length > 0) commands.push(current);
      current = [];
    }
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function globToRegExp(glob: string): RegExp {
  if (/[[\]{}]/.test(glob)) throw new Error(`unsupported glob ${JSON.stringify(glob)}: only * and ? are expanded`);
  const source = glob
    .replace(/[.+^$()|\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${source}$`);
}

/** What the shell would do with an unquoted glob: the matching test files, sorted. */
function expandGlob(glob: string, files: readonly string[]): string[] {
  const pattern = globToRegExp(glob);
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length === 0) {
    throw new Error(
      `the glob ${JSON.stringify(glob)} matches no test file; globs are expanded against test files only`,
    );
  }
  return matches;
}

const FOR_LOOP = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+?)\s*;\s*do\s+([\s\S]*?)\s*;\s*done\b/g;

/** Unrolls `for f in <globs>; do <body>; done` into one body per file, so the commands inside are read as plain ones. */
function expandForLoops(script: string, files: readonly string[]): string {
  return script.replace(FOR_LOOP, (_match, name: string, list: string, body: string) => {
    if (!/\bbun\b/.test(body)) return "";
    if (/\bfor\s/.test(body)) throw new Error("nested for loops are not supported");
    const items = splitCommands(tokenize(list))
      .flat()
      .flatMap((word) => (word.glob ? expandGlob(word.text, files) : [word.text]));
    const variable = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, "g");
    return items.map((item) => body.replace(variable, () => item)).join("; ");
  });
}

function collectCommands(script: string, context: Context): Invocation[] {
  const flat = expandForLoops(script, context.files);
  return splitCommands(tokenize(flat)).flatMap((words) => analyzeCommand(words, context));
}

function describe(words: readonly Word[]): string {
  const text = words.map((word) => word.text).join(" ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function analyzeCommand(allWords: Word[], context: Context): Invocation[] {
  let start = 0;
  while (start < allWords.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(allWords[start]!.text)) start++;
  const words = allWords.slice(start);
  const head = words[0]?.text;
  if (head === undefined) return [];
  if (head !== "bun") {
    const rest = words.slice(1);
    if (WRAPPERS.has(posix.basename(head)) && rest.some((word) => /(^|[\s/;&|"'])bun(\s|$)/.test(word.text))) {
      throw new Error(
        `${context.origin}: cannot analyse a bun command wrapped in \`${posix.basename(head)}\`: ${describe(words)}`,
      );
    }
    return [];
  }

  const args = words.slice(1);
  let index = 0;
  while (index < args.length && BUN_GLOBAL_FLAGS.has(args[index]!.text)) index++;
  const subcommand = args[index]?.text;
  if (subcommand === undefined) return [];
  if (subcommand.startsWith("-")) {
    throw new Error(`${context.origin}: unknown bun flag ${subcommand}: teach src/ci/test-discovery.ts about it`);
  }
  const tail = args.slice(index + 1);
  if (subcommand === "test") return [testInvocation(tail, words, context)];
  if (subcommand === "run") return runScript(tail, context);
  if (!BUN_BUILTINS.has(subcommand) && context.scripts[subcommand] !== undefined) {
    return runScript(args.slice(index), context);
  }
  const runner = DEDICATED_RUNNERS[posix.normalize(subcommand)];
  if (runner) return [{ origin: context.origin, command: describe(words), filters: [], files: [...runner] }];
  return [];
}

function testInvocation(tail: Word[], words: Word[], context: Context): Invocation {
  const command = describe(words);
  const filters: string[] = [];
  let positionalOnly = false;
  for (let i = 0; i < tail.length; i++) {
    const word = tail[i]!;
    if (word.unsafe || word.redirect) {
      throw new Error(
        `${context.origin}: cannot analyse this bun test command (substitution or redirection): ${command}`,
      );
    }
    const text = word.text;
    if (!positionalOnly && text === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && text.startsWith("-") && text !== "-") {
      const name = text.includes("=") ? text.slice(0, text.indexOf("=")) : text;
      if (TEST_FLAGS_WITHOUT_VALUE.has(name)) continue;
      if (TEST_FLAGS_WITH_VALUE.has(name)) {
        if (!text.includes("=")) i++;
        continue;
      }
      throw new Error(
        `${context.origin}: unknown bun test flag ${text}: teach src/ci/test-discovery.ts about it (${command})`,
      );
    } else if (word.glob) {
      filters.push(...expandGlob(text, context.files));
    } else {
      filters.push(text);
    }
  }
  return { origin: context.origin, command, filters, files: [] };
}

function runScript(tail: Word[], context: Context): Invocation[] {
  let index = 0;
  while (index < tail.length && BUN_RUN_FLAGS.has(tail[index]!.text)) index++;
  const name = tail[index]?.text;
  if (name === undefined) return [];
  const script = context.scripts[name];
  if (script === undefined) {
    const runner = DEDICATED_RUNNERS[posix.normalize(name)];
    if (runner) return [{ origin: context.origin, command: `bun run ${name}`, filters: [], files: [...runner] }];
    if (/[./]/.test(name)) return [];
    throw new Error(`${context.origin}: \`bun run ${name}\` is not a package.json script`);
  }
  if (context.stack.includes(name))
    throw new Error(`${context.origin}: script ${name} runs itself (${[...context.stack, name].join(" › ")})`);
  return collectCommands(script, {
    ...context,
    origin: `${context.origin} › ${name}`,
    stack: [...context.stack, name],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub Actions matrices
// ---------------------------------------------------------------------------------------------------------------

function matrixBindings(job: WorkflowJob): Record<string, string>[] {
  const axes = Object.entries(job.strategy?.matrix ?? {}).filter(
    ([key, values]) => key !== "include" && key !== "exclude" && Array.isArray(values),
  ) as Array<[string, unknown[]]>;
  let bindings: Record<string, string>[] = [{}];
  for (const [key, values] of axes) {
    bindings = bindings.flatMap((binding) => values.map((value) => ({ ...binding, [key]: String(value) })));
  }
  return bindings;
}

function substituteMatrix(run: string, binding: Record<string, string>, origin: string): string {
  const substituted = run.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key: string) => {
    const value = binding[key];
    if (value === undefined) throw new Error(`${origin}: matrix.${key} has no value in this job`);
    return value;
  });
  if (/\$\{\{/.test(substituted)) {
    throw new Error(`${origin}: a GitHub expression other than matrix.* in a run step that calls bun is not analysed`);
  }
  return substituted;
}
