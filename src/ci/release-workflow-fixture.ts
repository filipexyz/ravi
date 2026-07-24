import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

export type ReleaseWorkflowFixtureResult = {
  commandLog: string;
  context: ReleaseWorkflowFixtureContext;
  githubOutput: string;
  status: number;
  stderr: string;
  stdout: string;
};

export type ReleaseWorkflowFixtureContext = {
  binDir: string;
  fixtureRoot: string;
  gitHooksDir: string;
  gitTemplateDir: string;
  homeDir: string;
  runnerTemp: string;
  temporaryDir: string;
  xdgCacheDir: string;
  xdgConfigDir: string;
  xdgDataDir: string;
};

/**
 * Repository-local variables reported by `git rev-parse --local-env-vars`.
 * Keep this static so sanitizing a child Git process never recursively invokes
 * Git under the potentially hostile repository context it is meant to remove.
 */
const gitRepositoryLocalEnvironmentVariables = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const);

const allowedParentEnvironmentVariables = Object.freeze([] as const);
const safeSystemPathEntries = Object.freeze([
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
]);
const safeSystemPath = safeSystemPathEntries.join(delimiter);

export type ReleaseWorkflowFixtureEnvironment = {
  context: ReleaseWorkflowFixtureContext;
  environment: NodeJS.ProcessEnv;
};

export function createReleaseWorkflowFixtureEnvironment(options: {
  cwd: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  fixtureRoot: string;
  includeFixtureBin?: boolean;
  parentEnvironment?: Readonly<NodeJS.ProcessEnv>;
}): ReleaseWorkflowFixtureEnvironment {
  assertPathWithin(options.cwd, options.fixtureRoot);
  const context: ReleaseWorkflowFixtureContext = {
    binDir: join(options.fixtureRoot, "bin"),
    fixtureRoot: options.fixtureRoot,
    gitHooksDir: join(options.fixtureRoot, "git-hooks"),
    gitTemplateDir: join(options.fixtureRoot, "git-template"),
    homeDir: join(options.fixtureRoot, "home"),
    runnerTemp: join(options.fixtureRoot, "runner-temp"),
    temporaryDir: join(options.fixtureRoot, "tmp"),
    xdgCacheDir: join(options.fixtureRoot, "xdg-cache"),
    xdgConfigDir: join(options.fixtureRoot, "xdg-config"),
    xdgDataDir: join(options.fixtureRoot, "xdg-data"),
  };
  for (const directory of Object.values(context)) {
    mkdirSync(directory, { recursive: true });
  }
  chmodSync(context.homeDir, 0o700);

  const environment: NodeJS.ProcessEnv = {};
  const parentEnvironment = options.parentEnvironment ?? {};
  for (const variable of allowedParentEnvironmentVariables) {
    const value = parentEnvironment[variable];
    if (value !== undefined) environment[variable] = value;
  }
  for (const [variable, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined && !isBlockedFixtureEnvironmentVariable(variable)) environment[variable] = value;
  }

  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.TZ = "UTC";
  environment.PATH = [options.includeFixtureBin ? context.binDir : undefined, safeSystemPath]
    .filter(Boolean)
    .join(delimiter);
  environment.HOME = context.homeDir;
  environment.XDG_CACHE_HOME = context.xdgCacheDir;
  environment.XDG_CONFIG_HOME = context.xdgConfigDir;
  environment.XDG_DATA_HOME = context.xdgDataDir;
  environment.TMPDIR = context.temporaryDir;
  environment.TMP = context.temporaryDir;
  environment.TEMP = context.temporaryDir;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_SYSTEM = "/dev/null";
  environment.GIT_TEMPLATE_DIR = context.gitTemplateDir;
  environment.NPM_CONFIG_USERCONFIG = "/dev/null";
  environment.NPM_CONFIG_GLOBALCONFIG = "/dev/null";
  environment.RAVI_RELEASE_FIXTURE_GIT_BINARY = findSafeExecutable("git");
  environment.RAVI_RELEASE_FIXTURE_GIT_HOOKS_DIR = context.gitHooksDir;

  return { context, environment };
}

export function runReleaseWorkflowFixture(options: {
  commands?: Record<string, string>;
  cwd: string;
  env?: Record<string, string>;
  parentEnvironment?: Readonly<NodeJS.ProcessEnv>;
  prepare?: (context: ReleaseWorkflowFixtureContext) => void;
  script: string;
}): ReleaseWorkflowFixtureResult {
  const fixtureRoot = mkdtempSync(join(options.cwd, ".ravi-release-workflow-"));
  const { context, environment } = createReleaseWorkflowFixtureEnvironment({
    cwd: options.cwd,
    env: Object.fromEntries(
      Object.entries(options.env ?? {}).map(([key, value]) => [
        key,
        value.replaceAll("__FIXTURE_BIN__", join(fixtureRoot, "bin")).replaceAll("__SYSTEM_PATH__", safeSystemPath),
      ]),
    ),
    fixtureRoot,
    includeFixtureBin: true,
    parentEnvironment: options.parentEnvironment,
  });
  const { binDir, runnerTemp } = context;
  const commandLogPath = join(fixtureRoot, "commands.log");
  const githubOutputPath = join(fixtureRoot, "github-output");
  writeFileSync(commandLogPath, "");
  writeFileSync(githubOutputPath, "");

  if (Object.hasOwn(options.commands ?? {}, "git")) {
    throw new Error("The fixture Git wrapper is reserved by the hermetic harness.");
  }
  for (const [name, body] of Object.entries(options.commands ?? {})) {
    const commandPath = join(binDir, name);
    writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(commandPath, 0o755);
  }
  const gitWrapperPath = join(binDir, "git");
  writeFileSync(
    gitWrapperPath,
    [
      "#!/bin/sh",
      'exec "$RAVI_RELEASE_FIXTURE_GIT_BINARY" \\',
      '  -c "core.hooksPath=$RAVI_RELEASE_FIXTURE_GIT_HOOKS_DIR" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(gitWrapperPath, 0o755);
  options.prepare?.(context);

  environment.FIXTURE_COMMAND_LOG = commandLogPath;
  environment.GITHUB_OUTPUT = githubOutputPath;
  environment.RUNNER_TEMP = runnerTemp;
  const result = spawnSync("/bin/bash", ["-c", options.script], {
    cwd: options.cwd,
    encoding: "utf8",
    env: environment,
  });

  return {
    commandLog: readFileSync(commandLogPath, "utf8"),
    context,
    githubOutput: readFileSync(githubOutputPath, "utf8"),
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function isBlockedFixtureEnvironmentVariable(variable: string): boolean {
  const upperVariable = variable.toUpperCase();
  return (
    gitRepositoryLocalEnvironmentVariables.includes(
      variable as (typeof gitRepositoryLocalEnvironmentVariables)[number],
    ) ||
    upperVariable.startsWith("GIT_") ||
    upperVariable.startsWith("BASH_FUNC_") ||
    upperVariable.startsWith("DYLD_") ||
    upperVariable.startsWith("LD_") ||
    upperVariable === "BASH_ENV" ||
    upperVariable === "ENV" ||
    upperVariable === "CDPATH" ||
    upperVariable === "SHELLOPTS" ||
    upperVariable === "BASHOPTS" ||
    upperVariable === "PROMPT_COMMAND" ||
    upperVariable === "PS4" ||
    upperVariable === "PATH" ||
    upperVariable === "HOME" ||
    upperVariable === "XDG_CONFIG_HOME" ||
    upperVariable === "XDG_CACHE_HOME" ||
    upperVariable === "XDG_DATA_HOME" ||
    upperVariable === "TMPDIR" ||
    upperVariable === "TMP" ||
    upperVariable === "TEMP" ||
    upperVariable === "NPM_CONFIG_USERCONFIG" ||
    upperVariable === "NPM_CONFIG_GLOBALCONFIG" ||
    upperVariable === "NODE_OPTIONS" ||
    upperVariable === "NODE_PATH" ||
    upperVariable === "TAR_OPTIONS" ||
    upperVariable === "GZIP" ||
    upperVariable === "GZIP_OPT" ||
    upperVariable === "BZIP" ||
    upperVariable === "BZIP2" ||
    upperVariable === "XZ_DEFAULTS" ||
    upperVariable === "XZ_OPT"
  );
}

function findSafeExecutable(name: string): string {
  for (const directory of safeSystemPathEntries) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed, parent-independent path.
    }
  }
  throw new Error(`Required executable is absent from the safe system path: ${name}`);
}

function assertPathWithin(root: string, candidate: string): void {
  const relativePath = relative(realpathSync(root), realpathSync(candidate));
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Fixture environment path must remain within its cwd: ${candidate}`);
  }
}
