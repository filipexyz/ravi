import { describe, expect, it } from "bun:test";
import { YAML } from "bun";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import { createReleaseWorkflowFixtureEnvironment, runReleaseWorkflowFixture } from "./release-workflow-fixture.js";

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  secrets?: Record<string, unknown> | "inherit";
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
  };
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    push?: { tags?: string[] };
    workflow_call?: unknown;
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
};

const repositoryRoot = join(import.meta.dir, "../..");
const dollarSign = "$";
const workflowPaths = [
  ".github/workflows/version.yml",
  ".github/workflows/sdk-release.yml",
  ".github/workflows/release.yml",
] as const;

function readWorkflow(relativePath: (typeof workflowPaths)[number]): {
  config: Workflow;
  text: string;
} {
  const text = readFileSync(join(repositoryRoot, relativePath), "utf8");
  return { config: YAML.parse(text) as Workflow, text };
}

function steps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function scripts(workflow: Workflow): string {
  return steps(workflow)
    .map((step) => step.run ?? "")
    .filter(Boolean)
    .join("\n");
}

function namedStep(workflow: Workflow, name: string): WorkflowStep {
  const step = steps(workflow).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

type ReleaseFixture = {
  baseSha: string;
  currentBaseSha: string;
  cwd: string;
  hermeticProcess: HermeticFixtureProcess;
  packageName: string;
  packagePath: string;
  prNumber: string;
  repository: string;
  tarball: string;
  tarballIntegrity: string;
  tarballName: string;
  tarballSha512: string;
  tag: string;
  targetSha: string;
  version: string;
};

const dateCommand = [
  `printf 'date %s\\n' "$*" >> "$FIXTURE_COMMAND_LOG"`,
  `if [ "\${FIXTURE_DATE_FAIL:-0}" = "1" ]; then exit 1; fi`,
  `printf '%s\\n' "$FIXTURE_DATE_RESULT"`,
].join("\n");

const ghCommand = [
  `printf 'gh %s\\n' "$*" >> "$FIXTURE_COMMAND_LOG"`,
  `release_attempted="$RUNNER_TEMP/fixture-release-create-attempted"`,
  `if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "download" ]; then`,
  `  destination=""`,
  `  while [ "$#" -gt 0 ]; do`,
  `    if [ "$1" = "--dir" ]; then destination="$2"; shift 2; else shift; fi`,
  `  done`,
  `  [ -n "$destination" ] || exit 95`,
  `  mkdir -p "$destination"`,
  `  cp "$FIXTURE_PROVENANCE_TARBALL" "$destination/$FIXTURE_TARBALL_NAME"`,
  `  printf '%s\\n' "$FIXTURE_PROVENANCE_METADATA_JSON" > "$destination/metadata.json"`,
  `  exit "\${FIXTURE_RUN_DOWNLOAD_EXIT:-0}"`,
  `fi`,
  `if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "create" ]; then`,
  `  : > "$release_attempted"`,
  `  exit "\${FIXTURE_RELEASE_CREATE_EXIT:-0}"`,
  `fi`,
  `request="\${!#}"`,
  `case "$request" in`,
  `  *"/releases/tags/"*)`,
  `    lookup_mode="\${FIXTURE_RELEASE_LOOKUP_MODE:-existing}"`,
  `    release_json="$FIXTURE_RELEASE_JSON"`,
  `    if [ -f "$release_attempted" ]; then`,
  `      lookup_mode="\${FIXTURE_RELEASE_REREAD_MODE:-existing}"`,
  `      release_json="\${FIXTURE_RELEASE_REREAD_JSON:-$FIXTURE_RELEASE_JSON}"`,
  `    fi`,
  `    if [ "$lookup_mode" = "missing" ]; then`,
  `      echo "HTTP 404: Not Found" >&2`,
  `      exit 22`,
  `    elif [ "$lookup_mode" != "existing" ]; then`,
  `      echo "Unexpected release lookup mode" >&2`,
  `      exit 98`,
  `    fi`,
  `    printf '%s\\n' "$release_json"`,
  `    ;;`,
  `  *"/git/ref/tags/"*)`,
  `    if [ -f "$release_attempted" ] && [ -n "\${FIXTURE_POST_CREATE_TAG_REF_JSON:-}" ]; then`,
  `      printf '%s\\n' "$FIXTURE_POST_CREATE_TAG_REF_JSON"`,
  `    else`,
  `      printf '%s\\n' "$FIXTURE_TAG_REF_JSON"`,
  `    fi`,
  `    ;;`,
  `  *"/git/ref/heads/"*)`,
  `    if [ -f "$release_attempted" ] && [ -n "\${FIXTURE_POST_CREATE_BRANCH_REF_JSON:-}" ]; then`,
  `      printf '%s\\n' "$FIXTURE_POST_CREATE_BRANCH_REF_JSON"`,
  `    else`,
  `      printf '%s\\n' "$FIXTURE_BRANCH_REF_JSON"`,
  `    fi`,
  `    ;;`,
  `  *"/actions/workflows/"*"/runs?"*) printf '%s\\n' "$FIXTURE_WORKFLOW_RUNS_JSON" ;;`,
  `  *"/actions/runs/"*"/artifacts?"*) printf '%s\\n' "$FIXTURE_ARTIFACT_INDEX_JSON" ;;`,
  `  *"/commits/"*"/pulls?per_page=100")`,
  `    if [ -f "$release_attempted" ] && [ -n "\${FIXTURE_POST_CREATE_ASSOCIATED_PRS_JSON:-}" ]; then`,
  `      printf '%s\\n' "$FIXTURE_POST_CREATE_ASSOCIATED_PRS_JSON"`,
  `    else`,
  `      printf '%s\\n' "$FIXTURE_ASSOCIATED_PRS_JSON"`,
  `    fi`,
  `    ;;`,
  `  *"/pulls/"*"/files?per_page=100") printf '%s\\n' "$FIXTURE_PR_FILES_JSON" ;;`,
  `  *"/pulls/"*) printf '%s\\n' "$FIXTURE_PR_JSON" ;;`,
  `  *"/compare/"*)`,
  `    if [ -f "$release_attempted" ] && [ -n "\${FIXTURE_POST_CREATE_REACHABILITY_JSON:-}" ]; then`,
  `      printf '%s\\n' "$FIXTURE_POST_CREATE_REACHABILITY_JSON"`,
  `    else`,
  `      printf '%s\\n' "$FIXTURE_REACHABILITY_JSON"`,
  `    fi`,
  `    ;;`,
  `  *"/contents/"*) printf '%s\\n' "$FIXTURE_CONTENT_JSON" ;;`,
  `  *) echo "Unexpected gh request: $request" >&2; exit 97 ;;`,
  `esac`,
].join("\n");

const npmCommand = [
  `printf 'npm %s\\n' "$*" >> "$FIXTURE_COMMAND_LOG"`,
  `release_attempted="$RUNNER_TEMP/fixture-release-create-attempted"`,
  `if [ "\${1:-}" = "view" ] && [[ "$*" == *" versions --json"* ]]; then`,
  `  printf '%s\\n' "$FIXTURE_REGISTRY_VERSIONS_JSON"`,
  `elif [ "\${1:-}" = "view" ] && [[ "$*" == *" version gitHead dist.integrity --json"* ]]; then`,
  `  if [ -f "$release_attempted" ] && [ -n "\${FIXTURE_POST_CREATE_REGISTRY_METADATA_JSON:-}" ]; then`,
  `    printf '%s\\n' "$FIXTURE_POST_CREATE_REGISTRY_METADATA_JSON"`,
  `  else`,
  `    printf '%s\\n' "$FIXTURE_REGISTRY_METADATA_JSON"`,
  `  fi`,
  `elif [ "\${1:-}" = "view" ] && [[ "$*" == *" dist-tags --json"* ]]; then`,
  `  if [ -f "$release_attempted" ] && [ -n "\${FIXTURE_POST_CREATE_DIST_TAGS_JSON:-}" ]; then`,
  `    printf '%s\\n' "$FIXTURE_POST_CREATE_DIST_TAGS_JSON"`,
  `  else`,
  `    printf '%s\\n' "$FIXTURE_DIST_TAGS_JSON"`,
  `  fi`,
  `elif [ "\${1:-}" = "publish" ]; then`,
  `  exit "\${FIXTURE_PUBLISH_EXIT:-0}"`,
  `else`,
  `  echo "Unexpected npm request: $*" >&2`,
  `  exit 96`,
  `fi`,
].join("\n");

type HermeticFixtureProcess = ReturnType<typeof createReleaseWorkflowFixtureEnvironment> & {
  cwd: string;
};

function createHermeticFixtureProcess(
  cwd: string,
  options: {
    env?: Readonly<NodeJS.ProcessEnv>;
    parentEnvironment?: Readonly<NodeJS.ProcessEnv>;
  } = {},
): HermeticFixtureProcess {
  const fixtureRoot = mkdtempSync(join(cwd, ".ravi-command-environment-"));
  return {
    cwd,
    ...createReleaseWorkflowFixtureEnvironment({
      cwd,
      env: options.env,
      fixtureRoot,
      parentEnvironment: options.parentEnvironment,
    }),
  };
}

function execHermeticFixtureCommand(
  child: HermeticFixtureProcess,
  executable: string,
  args: readonly string[],
  options: { input?: string } = {},
): string {
  return execFileSync(executable, args, {
    cwd: child.cwd,
    encoding: "utf8",
    env: child.environment,
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function createFixtureGit(
  cwd: string,
  options: {
    env?: Readonly<NodeJS.ProcessEnv>;
    parentEnvironment?: Readonly<NodeJS.ProcessEnv>;
  } = {},
) {
  const child = createHermeticFixtureProcess(cwd, options);
  const gitExecutable = child.environment.RAVI_RELEASE_FIXTURE_GIT_BINARY;
  if (!gitExecutable) throw new Error("Hermetic fixture Git executable is unavailable.");
  const git = (...args: string[]): string =>
    execHermeticFixtureCommand(child, gitExecutable, ["-c", `core.hooksPath=${child.context.gitHooksDir}`, ...args]);
  return Object.assign(git, { child });
}

function manifest(name: string, version: string): string {
  return `${JSON.stringify(
    {
      name,
      private: false,
      publishConfig: { access: "public" },
      version,
    },
    null,
    2,
  )}\n`;
}

function sealedManifest(name: string, version: string, gitHead: string): string {
  return `${JSON.stringify(
    {
      gitHead,
      name,
      private: false,
      publishConfig: { access: "public" },
      version,
    },
    null,
    2,
  )}\n`;
}

function sha512(path: string): { integrity: string; hex: string } {
  const digest = createHash("sha512").update(readFileSync(path)).digest();
  return {
    hex: digest.toString("hex"),
    integrity: `sha512-${digest.toString("base64")}`,
  };
}

function contentResponse(name: string, version: string): string {
  return JSON.stringify({
    content: Buffer.from(manifest(name, version)).toString("base64"),
    encoding: "base64",
    type: "file",
  });
}

function createFixture(
  options: {
    gitEnvironment?: NodeJS.ProcessEnv;
    gitParentEnvironment?: NodeJS.ProcessEnv;
    trackedNpmrc?: boolean;
    version?: string;
  } = {},
): ReleaseFixture {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-release-security-"));
  const packageName = "ravi.bot";
  const packagePath = "package.json";
  const version = options.version ?? "3.260723.5";
  const tag = `v${version}`;
  const repository = "filipexyz/ravi";
  const prNumber = "332";
  const git = createFixtureGit(cwd, {
    env: options.gitEnvironment,
    parentEnvironment: options.gitParentEnvironment,
  });

  writeFileSync(join(cwd, packagePath), manifest(packageName, "3.260723.4"));
  git("init", "-q");
  git("config", "user.email", "release-fixture@example.invalid");
  git("config", "user.name", "Release Fixture");
  git("add", packagePath);
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  writeFileSync(join(cwd, packagePath), manifest(packageName, version));
  if (options.trackedNpmrc) {
    writeFileSync(join(cwd, ".npmrc"), "registry=https://attacker.invalid/\n");
    git("add", ".npmrc");
  }
  git("add", packagePath);
  git("commit", "-q", "-m", "release version");
  git("tag", tag);
  const targetSha = git("rev-parse", "HEAD");
  const tarballName = `ravi.bot-${version}.tgz`;
  const tarball = join(cwd, tarballName);
  const tarRoot = join(cwd, ".sealed-tar");
  mkdirSync(join(tarRoot, "package"), { recursive: true });
  writeFileSync(join(tarRoot, "package/package.json"), sealedManifest(packageName, version, targetSha));
  execHermeticFixtureCommand(git.child, "/usr/bin/tar", ["-czf", tarball, "-C", tarRoot, "package"]);
  const tarballDigest = sha512(tarball);

  return {
    baseSha,
    currentBaseSha: targetSha,
    cwd,
    hermeticProcess: git.child,
    packageName,
    packagePath,
    prNumber,
    repository,
    tarball,
    tarballIntegrity: tarballDigest.integrity,
    tarballName,
    tarballSha512: tarballDigest.hex,
    tag,
    targetSha,
    version,
  };
}

function artifactMetadata(fixture: ReleaseFixture, tarball = fixture.tarball): Record<string, unknown> {
  const digest = sha512(tarball);
  return {
    artifactName: "ravi-root-package-42-1",
    base: "main",
    currentBaseSha: fixture.currentBaseSha,
    immutableNpmTag: `stable-v${fixture.version.replaceAll(".", "-")}`,
    packageName: fixture.packageName,
    packagePath: fixture.packagePath,
    prNumber: fixture.prNumber,
    registry: "https://registry.npmjs.org/",
    schema: 2,
    tag: fixture.tag,
    tarball: basename(tarball),
    tarballIntegrity: digest.integrity,
    tarballSha512: digest.hex,
    targetSha: fixture.targetSha,
    version: fixture.version,
  };
}

function createAdversarialTarball(fixture: ReleaseFixture, kind: "duplicate" | "multi-json" | "symlink"): string {
  const root = join(fixture.cwd, `.adversarial-${kind}`);
  const packageDir = join(root, "package");
  const tarball = join(fixture.cwd, `adversarial-${kind}.tgz`);
  mkdirSync(packageDir, { recursive: true });
  const valid = sealedManifest(fixture.packageName, fixture.version, fixture.targetSha);

  if (kind === "symlink") {
    writeFileSync(join(root, "package.json.target"), valid);
    symlinkSync("../package.json.target", join(packageDir, "package.json"));
  } else {
    writeFileSync(join(packageDir, "package.json"), kind === "multi-json" ? `${valid}${valid}` : valid);
  }

  const members = kind === "duplicate" ? ["package/package.json", "package/package.json"] : ["package"];
  execHermeticFixtureCommand(fixture.hermeticProcess, "/usr/bin/tar", ["-czf", tarball, "-C", root, ...members]);
  return tarball;
}

function preparePublishPayload(runnerTemp: string, fixture: ReleaseFixture, tarball: string): void {
  const payloadDir = join(runnerTemp, "release-payload");
  mkdirSync(payloadDir, { recursive: true });
  copyFileSync(tarball, join(payloadDir, basename(tarball)));
  writeFileSync(join(payloadDir, "metadata.json"), `${JSON.stringify(artifactMetadata(fixture, tarball))}\n`);
}

function associatedPullRequest(fixture: ReleaseFixture, options: { base?: "dev" | "main"; number?: number } = {}) {
  return {
    base: {
      ref: options.base ?? "main",
      repo: { full_name: fixture.repository },
      // Deliberately stale: workflows must not use this as a merge base.
      sha: "f".repeat(40),
    },
    head: { repo: { full_name: fixture.repository } },
    merge_commit_sha: fixture.targetSha,
    merged_at: "2026-07-23T20:00:00Z",
    number: options.number ?? Number(fixture.prNumber),
  };
}

function fixtureEnv(fixture: ReleaseFixture, overrides: Record<string, string> = {}): Record<string, string> {
  const immutableTag = `stable-v${fixture.version.replaceAll(".", "-")}`;
  const artifactName = "ravi-root-package-42-1";
  const pr = associatedPullRequest(fixture);

  return {
    EVENT_NAME: "push",
    EVENT_REF: `refs/tags/${fixture.tag}`,
    EVENT_REF_NAME: fixture.tag,
    EVENT_REF_TYPE: "tag",
    EVENT_SHA: fixture.targetSha,
    EXPECTED_BASE: "main",
    EXPECTED_ARTIFACT_NAME: artifactName,
    EXPECTED_CURRENT_BASE_SHA: fixture.currentBaseSha,
    EXPECTED_IMMUTABLE_NPM_TAG: immutableTag,
    EXPECTED_INTEGRITY: fixture.tarballIntegrity,
    EXPECTED_PACKAGE: fixture.packageName,
    EXPECTED_PACKAGE_PATH: fixture.packagePath,
    EXPECTED_PR_NUMBER: fixture.prNumber,
    EXPECTED_TAG: fixture.tag,
    EXPECTED_TARBALL_SHA512: fixture.tarballSha512,
    EXPECTED_TARGET_SHA: fixture.targetSha,
    EXPECTED_VERSION: fixture.version,
    FIXTURE_ASSOCIATED_PRS_JSON: JSON.stringify([[pr]]),
    FIXTURE_ARTIFACT_INDEX_JSON: JSON.stringify([
      {
        artifacts: [{ expired: false, name: artifactName }],
        total_count: 1,
      },
    ]),
    FIXTURE_BASE: "main",
    FIXTURE_BRANCH_REF_JSON: JSON.stringify({
      object: { sha: fixture.currentBaseSha, type: "commit" },
      ref: "refs/heads/main",
    }),
    FIXTURE_CONTENT_JSON: contentResponse(fixture.packageName, fixture.version),
    FIXTURE_DATE_RESULT: "260723",
    FIXTURE_DIST_TAGS_JSON: JSON.stringify({ [immutableTag]: fixture.version }),
    FIXTURE_PR_FILES_JSON: JSON.stringify([
      [{ filename: fixture.packagePath, previous_filename: null, status: "modified" }],
    ]),
    FIXTURE_PR_JSON: JSON.stringify(pr),
    FIXTURE_PROVENANCE_METADATA_JSON: JSON.stringify(artifactMetadata(fixture)),
    FIXTURE_PROVENANCE_TARBALL: fixture.tarball,
    FIXTURE_REACHABILITY_JSON: JSON.stringify({
      base_commit: { sha: fixture.targetSha },
      head_commit: { sha: fixture.currentBaseSha },
      merge_base_commit: { sha: fixture.targetSha },
      status: "identical",
    }),
    FIXTURE_REGISTRY_METADATA_JSON: JSON.stringify({
      "dist.integrity": fixture.tarballIntegrity,
      gitHead: fixture.targetSha,
      version: fixture.version,
    }),
    FIXTURE_REGISTRY_VERSIONS_JSON: JSON.stringify(["3.260723.4"]),
    FIXTURE_RELEASE_JSON: JSON.stringify({
      draft: false,
      name: fixture.tag,
      prerelease: false,
      tag_name: fixture.tag,
      target_commitish: fixture.targetSha,
    }),
    FIXTURE_TAG_REF_JSON: JSON.stringify({
      object: { sha: fixture.targetSha, type: "commit" },
      ref: `refs/tags/${fixture.tag}`,
    }),
    FIXTURE_TARGET_SHA: fixture.targetSha,
    FIXTURE_TARBALL_NAME: fixture.tarballName,
    FIXTURE_WORKFLOW_RUNS_JSON: JSON.stringify([
      {
        workflow_runs: [
          {
            conclusion: "success",
            event: "push",
            head_sha: fixture.targetSha,
            id: 42,
            run_attempt: 1,
            status: "completed",
          },
        ],
      },
    ]),
    GH_TOKEN: "fixture-github-token",
    GITHUB_REPOSITORY: fixture.repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "42",
    GITHUB_WORKSPACE: fixture.cwd,
    IMMUTABLE_NPM_TAG: immutableTag,
    NPM_REGISTRY: "https://registry.npmjs.org/",
    PACKAGE_DIR: ".",
    PACKAGE_PATH: fixture.packagePath,
    PR_NUMBER: fixture.prNumber,
    RELEASE_KIND: "root",
    REQUESTED_TAG: fixture.tag,
    SAFE_HOME: fixture.cwd,
    SAFE_NPMRC: "/dev/null",
    TAG: fixture.tag,
    TARGET_SHA: fixture.targetSha,
    TARBALL: fixture.tarball,
    TRUSTED_NPM: "__FIXTURE_BIN__/npm",
    TRUSTED_PATH: "__FIXTURE_BIN__:__SYSTEM_PATH__",
    VERSION: fixture.version,
    ...overrides,
  };
}

function runFixtureStep(step: WorkflowStep, fixture: ReleaseFixture, overrides: Record<string, string> = {}) {
  return runReleaseWorkflowFixture({
    commands: { date: dateCommand, gh: ghCommand, npm: npmCommand },
    cwd: fixture.cwd,
    env: fixtureEnv(fixture, overrides),
    script: step.run ?? "",
  });
}

function runPublishRevalidation(
  step: WorkflowStep,
  fixture: ReleaseFixture,
  tarball: string,
  overrides: Record<string, string> = {},
) {
  return runReleaseWorkflowFixture({
    commands: { date: dateCommand, gh: ghCommand, npm: npmCommand },
    cwd: fixture.cwd,
    env: fixtureEnv(fixture, overrides),
    prepare: ({ runnerTemp }) => preparePublishPayload(runnerTemp, fixture, tarball),
    script: step.run ?? "",
  });
}

function commandCount(commandLog: string, fragment: string): number {
  return commandLog.split("\n").filter((line) => line.includes(fragment)).length;
}

function runtimeGitLocalEnvironmentVariables(git: (...args: string[]) => string): string[] {
  return git("rev-parse", "--local-env-vars").split("\n").filter(Boolean);
}

function expectPathWithin(root: string, candidate: string): void {
  const relativePath = relative(realpathSync(root), realpathSync(candidate));
  expect(isAbsolute(relativePath), candidate).toBe(false);
  expect(relativePath === ".." || relativePath.startsWith(`..${sep}`), candidate).toBe(false);
}

type ChildProcessAstInventory = {
  calls: Array<{ hasExplicitEnv: boolean; name: string }>;
  imports: string[];
  violations: string[];
};

function inspectChildProcessAst(
  sourcePath: string,
  source = readFileSync(sourcePath, "utf8"),
): ChildProcessAstInventory {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const canonicalChildProcessModule = ["node", ["child", "process"].join("_")].join(":");
  const legacyChildProcessModule = ["child", "process"].join("_");
  const childProcessApis = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);
  const inventory: ChildProcessAstInventory = { calls: [], imports: [], violations: [] };
  const allowedImportIdentifiers = new Set<ts.Identifier>();
  const allowedLocalNames = new Set<string>();
  const location = (node: ts.Node): string => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${sourcePath}:${line + 1}`;
  };
  const isChildProcessModuleText = (text: string): boolean =>
    text === canonicalChildProcessModule || text === legacyChildProcessModule;
  const propertyName = (name: ts.PropertyName): string | undefined =>
    ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
  const hasExplicitEnv = (node: ts.CallExpression): boolean => {
    const options = node.arguments[2];
    return Boolean(
      options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (property) => ts.isPropertyAssignment(property) && propertyName(property.name) === "env",
        ),
    );
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== canonicalChildProcessModule
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (!element.propertyName && childProcessApis.has(element.name.text)) {
        allowedImportIdentifiers.add(element.name);
        allowedLocalNames.add(element.name.text);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isChildProcessModuleText(node.text)) {
      const canonicalImport =
        ts.isStringLiteral(node) &&
        ts.isImportDeclaration(node.parent) &&
        node.parent.moduleSpecifier === node &&
        node.text === canonicalChildProcessModule;
      if (!canonicalImport) {
        inventory.violations.push(`${location(node)} child_process module literal outside canonical import`);
      }
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isChildProcessModuleText(node.moduleSpecifier.text)
    ) {
      if (node.moduleSpecifier.text !== canonicalChildProcessModule) {
        inventory.violations.push(`${location(node)} non-canonical child_process module specifier`);
      }
      const clause = node.importClause;
      if (!clause || clause.name) {
        inventory.violations.push(`${location(node)} child_process default or side-effect import`);
      }
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        inventory.violations.push(`${location(node)} child_process namespace import`);
      } else {
        for (const element of clause.namedBindings.elements) {
          if (element.propertyName) {
            inventory.violations.push(`${location(element)} aliased child_process import`);
          }
          inventory.imports.push((element.propertyName ?? element.name).text);
        }
      }
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "bun"
    ) {
      const clause = node.importClause;
      if (clause?.name || (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
        inventory.violations.push(`${location(node)} Bun default or namespace import`);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (["$", "spawn", "spawnSync"].includes(importedName)) {
            inventory.violations.push(`${location(element)} Bun child-process import`);
          }
        }
      }
    }

    if (ts.isIdentifier(node) && allowedLocalNames.has(node.text)) {
      const directImport = allowedImportIdentifiers.has(node);
      const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!directImport && !directCall) {
        inventory.violations.push(`${location(node)} indirect reference to imported ${node.text}`);
      }
    }

    if (ts.isIdentifier(node) && node.text === "Bun") {
      inventory.violations.push(`${location(node)} Bun reference`);
    }
    if (ts.isIdentifier(node) && node.text === "$") {
      inventory.violations.push(`${location(node)} shell $ reference`);
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && childProcessApis.has(node.expression.text)) {
        if (!allowedLocalNames.has(node.expression.text)) {
          inventory.violations.push(`${location(node)} unimported or forbidden child_process call`);
        }
        inventory.calls.push({
          hasExplicitEnv: hasExplicitEnv(node),
          name: node.expression.text,
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return inventory;
}

describe("release workflow fixture Git isolation", () => {
  it("excludes parent secrets and blocks shell startup injection for bash and its children", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-hermetic-shell-"));
    const poisonMarker = join(cwd, "bash-env-ran");
    const poisonScript = join(cwd, "poison-bash-env.sh");
    writeFileSync(poisonScript, `#!/bin/sh\n: > "${poisonMarker}"\n`);
    chmodSync(poisonScript, 0o755);

    const parentEnvironment: NodeJS.ProcessEnv = {
      BASH_ENV: poisonScript,
      GITHUB_TOKEN: "parent-token-must-not-cross",
      HOME: join(cwd, "hostile-home"),
      NODE_OPTIONS: `--require=${poisonScript}`,
      PATH: join(cwd, "hostile-bin"),
      RELEASE_PARENT_SECRET: "parent-secret-must-not-cross",
    };
    const result = runReleaseWorkflowFixture({
      cwd,
      env: {
        BASH_ENV: poisonScript,
        CDPATH: cwd,
        ENV: poisonScript,
        EXPLICIT_FIXTURE_VAR: "preserved",
        GITHUB_REPOSITORY: "fixture/repository",
        NODE_OPTIONS: `--require=${poisonScript}`,
        POISON_MARKER: poisonMarker,
      },
      parentEnvironment,
      script: [
        `[ "$EXPLICIT_FIXTURE_VAR" = "preserved" ]`,
        `[ "$GITHUB_REPOSITORY" = "fixture/repository" ]`,
        `[ "$LANG" = "C" ] && [ "$LC_ALL" = "C" ] && [ "$TZ" = "UTC" ]`,
        `[ -z "\${RELEASE_PARENT_SECRET+x}" ]`,
        `[ -z "\${GITHUB_TOKEN+x}" ]`,
        `[ -z "\${BASH_ENV+x}" ] && [ -z "\${ENV+x}" ] && [ -z "\${CDPATH+x}" ]`,
        `[ -z "\${NODE_OPTIONS+x}" ]`,
        `[ ! -e "$POISON_MARKER" ]`,
        `/bin/sh -c '[ -z "\${RELEASE_PARENT_SECRET+x}" ] && [ -z "\${GITHUB_TOKEN+x}" ] && [ -z "\${BASH_ENV+x}" ]'`,
      ].join("\n"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(poisonMarker)).toBe(false);
    for (const path of Object.values(result.context)) expectPathWithin(cwd, path);

    const gitRoot = mkdtempSync(join(tmpdir(), "ravi-hermetic-git-child-"));
    const git = createFixtureGit(gitRoot, {
      env: { BASH_ENV: poisonScript, NODE_OPTIONS: `--require=${poisonScript}` },
      parentEnvironment,
    });
    git("init", "-q");
    git(
      "config",
      "alias.assert-hermetic",
      `!f() { test -z "\${RELEASE_PARENT_SECRET+x}" && test -z "\${GITHUB_TOKEN+x}" && test -z "\${BASH_ENV+x}"; }; f`,
    );
    expect(git("assert-hermetic")).toBe("");
    expect(existsSync(poisonMarker)).toBe(false);
  });

  it("drops imported Bash functions for every security-sensitive fixture command", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-bash-function-poison-"));
    const marker = join(cwd, "imported-function-ran");
    const commandNames = ["git", "gh", "npm", "jq", "date", "tar"] as const;
    const functionPoison = Object.fromEntries(
      commandNames.map((name) => [`BASH_FUNC_${name}%%`, `() { : > "${marker}"; }`]),
    );
    const result = runReleaseWorkflowFixture({
      commands: {
        date: "exit 0",
        gh: "exit 0",
        jq: "exit 0",
        npm: "exit 0",
      },
      cwd,
      env: {
        ...functionPoison,
        FUNCTION_MARKER: marker,
      },
      parentEnvironment: functionPoison,
      script: [
        "set -euo pipefail",
        "function_seen=0",
        "for name in git gh npm jq date tar; do",
        '  [ "$(type -t "$name" || true)" != "function" ] || function_seen=1',
        '  "$name" --version >/dev/null 2>&1 || true',
        "done",
        '[ "$function_seen" = "0" ]',
        '[ ! -e "$FUNCTION_MARKER" ]',
      ].join("\n"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("drops explicit native loader poisons from the builder and an executable child", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-loader-poison-"));
    const childScript = join(cwd, "assert-loader-environment.sh");
    const poisonEnvironment = {
      DYLD_INSERT_LIBRARIES: join(cwd, "synthetic-dyld-insert.dylib"),
      DYLD_LIBRARY_PATH: join(cwd, "synthetic-dyld-library-path"),
      EXPLICIT_FIXTURE_VAR: "preserved",
      LD_AUDIT: join(cwd, "synthetic-ld-audit.so"),
      LD_LIBRARY_PATH: join(cwd, "synthetic-ld-library-path"),
      LD_PRELOAD: join(cwd, "synthetic-ld-preload.so"),
    };
    writeFileSync(
      childScript,
      [
        "#!/bin/sh",
        '[ "$EXPLICIT_FIXTURE_VAR" = "preserved" ]',
        `[ -z "\${LD_PRELOAD+x}" ]`,
        `[ -z "\${LD_LIBRARY_PATH+x}" ]`,
        `[ -z "\${LD_AUDIT+x}" ]`,
        `[ -z "\${DYLD_INSERT_LIBRARIES+x}" ]`,
        `[ -z "\${DYLD_LIBRARY_PATH+x}" ]`,
        'printf "loader-env-clean\\n"',
        "",
      ].join("\n"),
    );
    chmodSync(childScript, 0o755);
    const child = createHermeticFixtureProcess(cwd, {
      env: poisonEnvironment,
      parentEnvironment: poisonEnvironment,
    });

    expect(child.environment.EXPLICIT_FIXTURE_VAR).toBe("preserved");
    for (const variable of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
    ]) {
      expect(child.environment[variable], variable).toBeUndefined();
    }
    expect(execHermeticFixtureCommand(child, childScript, [])).toBe("loader-env-clean");
  });

  it("blocks tar startup options from changing an archive", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-tar-options-poison-"));
    const packageDir = join(cwd, "package");
    const tarball = join(cwd, "payload.tgz");
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, "package.json"), '{"name":"hermetic-tar"}\n');
    const poisonEnvironment = {
      BZIP2: "--help",
      GZIP: "--help",
      TAR_OPTIONS: "--exclude=package/package.json",
      XZ_OPT: "--help",
    };
    const child = createHermeticFixtureProcess(cwd, {
      env: poisonEnvironment,
      parentEnvironment: poisonEnvironment,
    });

    expect(child.environment.TAR_OPTIONS).toBeUndefined();
    expect(child.environment.GZIP).toBeUndefined();
    expect(child.environment.BZIP2).toBeUndefined();
    expect(child.environment.XZ_OPT).toBeUndefined();
    execHermeticFixtureCommand(child, "/usr/bin/tar", ["-czf", tarball, "-C", cwd, "package"]);
    const listing = execHermeticFixtureCommand(child, "/usr/bin/tar", ["-tzf", tarball]);
    expect(listing.split("\n")).toContain("package/package.json");
  });

  it("removes every runtime-reported local Git variable without mutating poison inputs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-git-env-"));
    const git = createFixtureGit(cwd);
    git("init", "-q");
    const runtimeVariables = runtimeGitLocalEnvironmentVariables(git);
    expect(new Set(runtimeVariables).size).toBe(15);

    const localPoison = Object.fromEntries(runtimeVariables.map((variable) => [variable, `synthetic-${variable}`]));
    const fixtureEnvironment = {
      ...localPoison,
      BASH_ENV: join(cwd, "poison"),
      PATH: join(cwd, "hostile-bin"),
      RELEASE_FIXTURE_NON_GIT: "preserved",
    };
    const parentEnvironment = {
      ...localPoison,
      RELEASE_PARENT_SECRET: "not-inherited",
    };
    const fixtureSnapshot = { ...fixtureEnvironment };
    const parentSnapshot = { ...parentEnvironment };
    const fixtureRoot = mkdtempSync(join(cwd, ".ravi-environment-builder-"));
    const built = createReleaseWorkflowFixtureEnvironment({
      cwd,
      env: fixtureEnvironment,
      fixtureRoot,
      includeFixtureBin: true,
      parentEnvironment,
    });

    expect(built.environment.RELEASE_FIXTURE_NON_GIT).toBe("preserved");
    expect(built.environment.RELEASE_PARENT_SECRET).toBeUndefined();
    expect(built.environment.BASH_ENV).toBeUndefined();
    expect(built.environment.PATH).not.toContain(join(cwd, "hostile-bin"));
    for (const variable of runtimeVariables) {
      expect(built.environment[variable], variable).toBeUndefined();
    }
    expect(built.environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(built.environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(built.environment.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(built.environment.GIT_TEMPLATE_DIR).toBe(built.context.gitTemplateDir);
    expect(fixtureEnvironment).toEqual(fixtureSnapshot);
    expect(parentEnvironment).toEqual(parentSnapshot);
    for (const path of Object.values(built.context)) expectPathWithin(cwd, path);
  });

  it("ignores hostile home, global Git config, templates, and hooks during fixture creation", () => {
    const poisonRoot = mkdtempSync(join(tmpdir(), "ravi-hostile-git-home-"));
    const poisonHome = join(poisonRoot, "home");
    const poisonHooks = join(poisonRoot, "hooks");
    const poisonTemplate = join(poisonRoot, "template");
    const poisonTemplateHooks = join(poisonTemplate, "hooks");
    const hookMarker = join(poisonRoot, "external-hook-ran");
    const templateMarker = join(poisonRoot, "external-template-hook-ran");
    const globalConfig = join(poisonRoot, "hostile.gitconfig");
    mkdirSync(poisonHome, { recursive: true });
    mkdirSync(poisonHooks, { recursive: true });
    mkdirSync(poisonTemplateHooks, { recursive: true });
    writeFileSync(join(poisonHooks, "post-commit"), `#!/bin/sh\n: > "${hookMarker}"\n`);
    writeFileSync(join(poisonTemplateHooks, "post-commit"), `#!/bin/sh\n: > "${templateMarker}"\n`);
    chmodSync(join(poisonHooks, "post-commit"), 0o755);
    chmodSync(join(poisonTemplateHooks, "post-commit"), 0o755);
    writeFileSync(
      globalConfig,
      [
        "[core]",
        `\thooksPath = ${poisonHooks}`,
        "[init]",
        `\ttemplateDir = ${poisonTemplate}`,
        "[user]",
        "\tname = Hostile Global User",
        "\temail = hostile-global@example.invalid",
        "",
      ].join("\n"),
    );
    copyFileSync(globalConfig, join(poisonHome, ".gitconfig"));
    const poisonEnvironment: NodeJS.ProcessEnv = {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_TEMPLATE_DIR: poisonTemplate,
      HOME: poisonHome,
      XDG_CONFIG_HOME: poisonHome,
    };

    const fixture = createFixture({
      gitEnvironment: poisonEnvironment,
      gitParentEnvironment: poisonEnvironment,
    });
    const fixtureGit = createFixtureGit(fixture.cwd);
    expect(fixtureGit("config", "--local", "user.name")).toBe("Release Fixture");
    expect(fixtureGit("config", "--local", "user.email")).toBe("release-fixture@example.invalid");
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(templateMarker)).toBe(false);
    expect(existsSync(join(fixture.cwd, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("keeps synthetic hook Git context isolated from fixture creation and scripts", () => {
    const sentinelRoot = mkdtempSync(join(tmpdir(), "ravi-git-env-sentinel-"));
    const sentinelGit = createFixtureGit(sentinelRoot);
    sentinelGit("init", "-q");
    sentinelGit("config", "--local", "core.bare", "false");
    sentinelGit("config", "--local", "user.name", "Sentinel Owner");
    sentinelGit("config", "--local", "user.email", "sentinel@example.invalid");
    sentinelGit("config", "--local", "fixture.sentinel", "unchanged");

    const sentinelGitDir = join(sentinelRoot, ".git");
    const sentinelConfig = join(sentinelGitDir, "config");
    const sentinelConfigHash = createHash("sha256").update(readFileSync(sentinelConfig)).digest("hex");
    const runtimeVariables = runtimeGitLocalEnvironmentVariables(sentinelGit);
    const runtimePoison = Object.fromEntries(
      runtimeVariables.map((variable) => [variable, join(sentinelGitDir, `synthetic-${variable}`)]),
    );
    const gitOverrides: Record<string, string> = {
      ...runtimePoison,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sentinelGitDir, "objects"),
      GIT_COMMON_DIR: sentinelGitDir,
      GIT_CONFIG: sentinelConfig,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_PARAMETERS: "'fixture.parameter'='synthetic'",
      GIT_CONFIG_VALUE_0: "Injected Name",
      GIT_DIR: sentinelGitDir,
      GIT_GRAFT_FILE: join(sentinelGitDir, "info", "grafts"),
      GIT_IMPLICIT_WORK_TREE: "0",
      GIT_INDEX_FILE: join(sentinelGitDir, "index"),
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OBJECT_DIRECTORY: join(sentinelGitDir, "objects"),
      GIT_PREFIX: "synthetic/",
      GIT_REPLACE_REF_BASE: "refs/replace/",
      GIT_SHALLOW_FILE: join(sentinelGitDir, "shallow"),
      GIT_WORK_TREE: sentinelRoot,
      RELEASE_FIXTURE_NON_GIT: "preserved",
    };

    const fixture = createFixture({
      gitEnvironment: gitOverrides,
      gitParentEnvironment: gitOverrides,
    });
    const fixtureGit = createFixtureGit(fixture.cwd, {
      env: gitOverrides,
      parentEnvironment: gitOverrides,
    });
    const fixtureTopLevel = realpathSync(fixture.cwd);
    expect(fixtureGit("rev-parse", "--show-toplevel")).toBe(fixtureTopLevel);
    expect(fixtureGit("config", "--local", "user.name")).toBe("Release Fixture");
    expect(fixtureGit("config", "--local", "user.email")).toBe("release-fixture@example.invalid");

    const runner = runReleaseWorkflowFixture({
      cwd: fixture.cwd,
      env: {
        ...gitOverrides,
        FIXTURE_EXPECTED_ROOT: fixtureTopLevel,
      },
      parentEnvironment: gitOverrides,
      script: [
        `[ "$(git rev-parse --show-toplevel)" = "$FIXTURE_EXPECTED_ROOT" ]`,
        `[ "$(git config --local user.name)" = "Release Fixture" ]`,
        `[ "$RELEASE_FIXTURE_NON_GIT" = "preserved" ]`,
      ].join("\n"),
    });
    expect(runner.status, runner.stderr).toBe(0);
    for (const path of Object.values(runner.context)) expectPathWithin(fixture.cwd, path);

    expect(createHash("sha256").update(readFileSync(sentinelConfig)).digest("hex")).toBe(sentinelConfigHash);
    expect(sentinelGit("config", "--local", "core.bare")).toBe("false");
    expect(sentinelGit("config", "--local", "user.name")).toBe("Sentinel Owner");
    expect(sentinelGit("config", "--local", "user.email")).toBe("sentinel@example.invalid");
    expect(sentinelGit("config", "--local", "fixture.sentinel")).toBe("unchanged");
  });

  it("keeps an AST-audited child-process inventory on explicit hermetic environments", () => {
    const expectedInventory = [
      {
        api: "spawnSync",
        sourcePath: join(import.meta.dir, "release-workflow-fixture.ts"),
      },
      {
        api: "execFileSync",
        sourcePath: join(import.meta.dir, "release-workflow-security.test.ts"),
      },
    ] as const;

    for (const expected of expectedInventory) {
      const inventory = inspectChildProcessAst(expected.sourcePath);
      expect(inventory.violations, expected.sourcePath).toEqual([]);
      expect(inventory.imports, expected.sourcePath).toEqual([expected.api]);
      expect(inventory.calls, expected.sourcePath).toEqual([
        {
          hasExplicitEnv: true,
          name: expected.api,
        },
      ]);
    }
  });

  it("rejects AST mutations that alias process launchers or load them dynamically", () => {
    const canonicalModule = ["node", ["child", "process"].join("_")].join(":");
    const canonicalSources = [
      {
        api: "execFileSync",
        name: "security test helper",
        source: `import { execFileSync } from "${canonicalModule}";
execFileSync("git", [], { env: {} });`,
      },
      {
        api: "spawnSync",
        name: "fixture helper",
        source: `import { spawnSync } from "${canonicalModule}";
spawnSync("/bin/bash", [], { env: {} });`,
      },
    ] as const;

    for (const canonical of canonicalSources) {
      const inventory = inspectChildProcessAst(`<canonical:${canonical.name}>`, canonical.source);
      expect(inventory.violations, canonical.name).toEqual([]);
      expect(inventory.imports, canonical.name).toEqual([canonical.api]);
      expect(inventory.calls, canonical.name).toEqual([
        {
          hasExplicitEnv: true,
          name: canonical.api,
        },
      ]);
    }

    const execFileImport = `import { execFileSync } from "${canonicalModule}";`;
    const mutations = [
      {
        name: "bind alias",
        source: `${execFileImport}
const run = execFileSync.bind(undefined);`,
      },
      {
        name: "direct identifier alias",
        source: `${execFileImport}
const run = execFileSync;`,
      },
      {
        name: "Bun.spawn alias",
        source: "const run = Bun.spawn;",
      },
      {
        name: "Bun element access",
        source: 'const run = Bun["spawn"];',
      },
      {
        name: "destructured Bun",
        source: "const { spawn: run } = Bun;",
      },
      {
        name: "Bun.$ tagged alias",
        source: "const shell = Bun.$;\nshell`echo mutation`;",
      },
      {
        name: "assignment after declaration",
        source: `${execFileImport}
let run;
run = execFileSync;`,
      },
      {
        name: "identifier passed as argument",
        source: `${execFileImport}
consume(execFileSync);`,
      },
      {
        name: "identifier returned",
        source: `${execFileImport}
function runner() { return execFileSync; }`,
      },
      {
        name: "identifier stored in array",
        source: `${execFileImport}
const runners = [execFileSync];`,
      },
      {
        name: "identifier stored in object",
        source: `${execFileImport}
const runners = { execFileSync };`,
      },
      {
        name: "comma expression callee",
        source: `${execFileImport}
(0, execFileSync)("git", [], { env: {} });`,
      },
      {
        name: "parenthesized callee",
        source: `${execFileImport}
(execFileSync)("git", [], { env: {} });`,
      },
      {
        name: "aliased require",
        source: `const load = require;
load("${canonicalModule}");`,
      },
      {
        name: "aliased dynamic import string",
        source: `const moduleName = "${canonicalModule}";
import(moduleName);`,
      },
      {
        name: "getBuiltinModule",
        source: `process.getBuiltinModule("${canonicalModule}");`,
      },
      {
        name: "call alias",
        source: `${execFileImport}
execFileSync.call(undefined, "git", [], { env: {} });`,
      },
      {
        name: "apply alias",
        source: `${execFileImport}
execFileSync.apply(undefined, ["git", [], { env: {} }]);`,
      },
      {
        name: "Bun.spawnSync alias",
        source: "const run = Bun.spawnSync;",
      },
      {
        name: "Bun shell import alias",
        source: 'import { $ as shell } from "bun";\nshell`echo mutation`;',
      },
      {
        name: "bare shell alias",
        source: "const $ = () => undefined;\n$`echo mutation`;",
      },
    ] as const;

    for (const mutation of mutations) {
      const inventory = inspectChildProcessAst(`<mutation:${mutation.name}>`, mutation.source);
      expect(inventory.violations.length, mutation.name).toBeGreaterThan(0);
    }
  });
});

describe("release workflow security contract", () => {
  it("keeps tag-only root and SDK entrypoints and never mutates branches or tags", () => {
    const root = readWorkflow(".github/workflows/version.yml");
    const sdk = readWorkflow(".github/workflows/sdk-release.yml");

    expect(root.config.on?.push).toEqual({ tags: ["v*"] });
    expect(root.config.on?.workflow_call).toBeTruthy();
    expect(sdk.config.on?.push).toEqual({ tags: ["ravi-os-sdk-v*"] });
    expect(sdk.config.jobs?.publish?.uses).toBe("./.github/workflows/version.yml");
    expect(sdk.config.jobs?.publish?.with).toEqual({
      release_kind: "sdk",
      expected_package: "@ravi-os/sdk",
      package_path: "packages/ravi-os-sdk/package.json",
      package_dir: "packages/ravi-os-sdk",
    });
    expect(sdk.config.jobs?.publish?.secrets).toEqual({
      NPM_TOKEN: `${dollarSign}{{ secrets.NPM_TOKEN }}`,
    });
    const provenance = namedStep(root.config, "Verify tag, reviewed PR delta, and current base");
    expect(provenance.env?.EVENT_NAME).toBe(`${dollarSign}{{ github.event_name }}`);
    expect(provenance.run).toContain('[ "$EVENT_NAME" != "push" ]');

    for (const { config, text } of [root, sdk]) {
      expect(config.permissions).toEqual({
        contents: "read",
        "pull-requests": "read",
      });
      expect(scripts(config)).not.toMatch(/\bgit\s+(?:commit|push|switch|tag)\b/);
      expect(scripts(config)).not.toMatch(/\bgh\s+pr\s+create\b/);
      expect(text).not.toContain("contents: write");
      expect(text).not.toContain("workflow_run:");
    }
  });

  it("uses per-tag concurrency so three rapid distinct tags retain three runs", () => {
    const root = readWorkflow(".github/workflows/version.yml").config;
    const sdk = readWorkflow(".github/workflows/sdk-release.yml").config;
    const release = readWorkflow(".github/workflows/release.yml").config;

    expect(root.concurrency).toEqual({
      group: `ravi-package-${dollarSign}{{ github.ref_name }}`,
      "cancel-in-progress": false,
    });
    expect(sdk.concurrency).toEqual({
      group: `ravi-sdk-package-${dollarSign}{{ github.ref_name }}`,
      "cancel-in-progress": false,
    });
    expect(release.concurrency).toEqual({
      group: `ravi-github-release-${dollarSign}{{ inputs.tag }}`,
      "cancel-in-progress": false,
    });

    const rapidTags = ["v3.260723.5", "v3.260723.6", "v3.260723.7"];
    const groups = rapidTags.map((tag) => `ravi-package-${tag}`);
    expect(new Set(groups).size).toBe(3);
  });

  it("isolates checkout/build/package from the only npm secret", () => {
    const { config, text } = readWorkflow(".github/workflows/version.yml");
    const verify = config.jobs?.verify;
    const publish = config.jobs?.publish;
    const verifyText = JSON.stringify(verify);
    const publishText = JSON.stringify(publish);

    expect(verify?.steps?.filter((step) => step.uses === "actions/checkout@v5")).toHaveLength(1);
    expect(verifyText).not.toContain("secrets.NPM_TOKEN");
    expect(verifyText).not.toContain("NODE_AUTH_TOKEN");
    expect(publish?.needs).toBe("verify");
    expect(publish?.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(publishText).not.toMatch(/bun (?:install|run)/);
    expect(text.match(/\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/g) ?? []).toHaveLength(1);

    const tokenSteps = publish?.steps?.filter((step) => JSON.stringify(step).includes("secrets.NPM_TOKEN"));
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps?.[0]?.name).toBe("Publish immutable inspected tarball");
    expect(tokenSteps?.[0]?.run).toBe(
      '"$TRUSTED_NPM" publish "$TARBALL" --ignore-scripts --access public --tag "$IMMUTABLE_NPM_TAG" --registry="https://registry.npmjs.org/"',
    );
    expect(tokenSteps?.[0]?.["continue-on-error"]).toBe(true);
  });

  it("uploads a sealed real tarball and revalidates it in a fresh no-checkout job", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const seal = namedStep(config, "Seal immutable inspected tarball and metadata").run ?? "";
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry").run ?? "";
    const upload = namedStep(config, "Upload immutable inspected release payload");
    const download = namedStep(config, "Download exact sealed release payload");

    expect(seal).toContain('"$TRUSTED_NPM" pack "$PACKAGE_DIR"');
    expect(seal).not.toContain("npm pack --dry-run");
    expect(seal).toContain("sha512sum");
    expect(seal).toContain("ssri_sha512");
    expect(seal).toContain("tarballIntegrity");
    expect(seal).toContain("exactly one regular package/package.json");
    expect(seal).toContain("length == 1");
    expect(seal).toContain(".gitHead = $sha");
    expect(upload.uses).toBe("actions/upload-artifact@v4");
    expect(upload.with?.overwrite).toBe(false);
    expect(upload.with?.["retention-days"]).toBe(90);
    expect(download.uses).toBe("actions/download-artifact@v5");
    expect(revalidate).toContain("sha512sum");
    expect(revalidate).toContain("ssri_sha512");
    expect(revalidate).toContain(".schema == 2");
    expect(revalidate).toContain("dist.integrity");
    expect(revalidate).toContain("length == 1");
    expect(revalidate).toContain("package/package.json");
    expect(revalidate).toContain('.publishConfig == {"access":"public"}');
    expect(revalidate).toContain(".gitHead == $sha");
  });

  it("uses PR files plus current branch reachability and never PR base SHA authority", () => {
    const { config, text } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base").run ?? "";
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry").run ?? "";

    expect(text).not.toContain(".base.sha");
    expect(text).not.toMatch(/\bBASE_SHA\b/);
    for (const script of [provenance, revalidate]) {
      expect(script).toContain("--paginate");
      expect(script).toContain("--slurp");
      expect(script).toContain("/files?per_page=100");
      expect(script).toContain("/git/ref/heads/");
      expect(script).toContain("merge_base_commit.sha == $target");
      expect(script).toContain("CURRENT");
      expect(script).toContain("del(.version)");
    }
  });

  it("guards repository npmrc, publishConfig, PATH, registry, and lifecycle scripts", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base").run ?? "";
    const seal = namedStep(config, "Seal immutable inspected tarball and metadata").run ?? "";
    const resolve = namedStep(config, "Resolve trusted npm before repository code").run ?? "";
    const publish = namedStep(config, "Publish immutable inspected tarball").run ?? "";

    expect(provenance).toContain("git ls-files -- '.npmrc' '*/.npmrc'");
    expect(provenance).toContain('(.publishConfig // {}) == {"access":"public"}');
    expect(seal).toContain("-name .npmrc");
    expect(seal).toContain("--ignore-scripts");
    expect(resolve).toContain('NPM_BIN="$(realpath "$(command -v npm)")"');
    expect(resolve).toContain('case "$NPM_BIN"');
    expect(publish).toContain('"$TRUSTED_NPM" publish');
    expect(publish).toContain('--registry="https://registry.npmjs.org/"');
  });

  it("uses only version-qualified immutable dist-tags, preventing inverted-order downgrade", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base").run ?? "";
    const publish = namedStep(config, "Publish immutable inspected tarball");
    const versions = ["3.260723.7", "3.260723.6", "3.260723.5"];
    const commandLogs: string[] = [];

    expect(provenance).toContain(`IMMUTABLE_NPM_TAG="${dollarSign}{CHANNEL_PREFIX}-v${dollarSign}{VERSION//./-}"`);
    expect(publish.run).not.toContain("--tag latest");
    expect(publish.run).not.toContain("--tag next");

    for (const version of versions) {
      const fixture = createFixture();
      try {
        const immutableTag = `stable-v${version.replaceAll(".", "-")}`;
        const result = runReleaseWorkflowFixture({
          commands: { npm: npmCommand },
          cwd: fixture.cwd,
          env: {
            FIXTURE_PUBLISH_EXIT: "0",
            IMMUTABLE_NPM_TAG: immutableTag,
            TARBALL: "/tmp/sealed-fixture.tgz",
            TRUSTED_NPM: "__FIXTURE_BIN__/npm",
          },
          script: publish.run ?? "",
        });
        expect(result.status, result.stderr).toBe(0);
        commandLogs.push(result.commandLog);
      } finally {
        rmSync(fixture.cwd, { force: true, recursive: true });
      }
    }

    const combined = commandLogs.join("");
    for (const version of versions) {
      expect(combined).toContain(`--tag stable-v${version.replaceAll(".", "-")}`);
    }
    expect(combined).not.toMatch(/--tag (?:latest|next)(?:\s|$)/);
  });

  it("makes ambiguous npm publish retry idempotent only for exact SSRI, gitHead, and dist-tag", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const publish = namedStep(config, "Publish immutable inspected tarball");
    const verify = namedStep(config, "Verify exact registry result after publish or retry");
    const fixture = createFixture();
    try {
      expect(publish["continue-on-error"]).toBe(true);
      expect(verify.if).toContain("always()");

      const ambiguousPublish = runFixtureStep(publish, fixture, {
        FIXTURE_PUBLISH_EXIT: "1",
      });
      expect(ambiguousPublish.status).not.toBe(0);
      expect(ambiguousPublish.commandLog).toContain("npm publish");

      // GitHub continues because the real step is continue-on-error. A registry
      // read proving the exact version, sealed SSRI, gitHead, and immutable tag
      // closes the ambiguous outcome as success.
      const matching = runFixtureStep(verify, fixture);
      expect(matching.status, matching.stderr).toBe(0);
      expect(matching.commandLog).toContain("version gitHead dist.integrity --json");
      expect(matching.commandLog).toContain(`/git/ref/tags/${fixture.tag}`);
      expect(matching.commandLog).toContain("/git/ref/heads/main");
      expect(matching.commandLog).toContain(`/pulls/${fixture.prNumber}/files?per_page=100`);

      const mismatched = runFixtureStep(verify, fixture, {
        FIXTURE_REGISTRY_METADATA_JSON: JSON.stringify({
          gitHead: "e".repeat(40),
          version: fixture.version,
        }),
      });
      expect(mismatched.status).not.toBe(0);
      expect(mismatched.stderr).toContain("mismatched integrity, gitHead, or dist-tag");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("recovers sealed publish provenance and keeps GitHub Release reruns exact", () => {
    const { config, text } = readWorkflow(".github/workflows/release.yml");
    const verify = namedStep(config, "Verify full published tag provenance");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const createScript = create.run ?? "";

    expect(steps(config).some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(config.permissions?.actions).toBe("read");
    expect(text).not.toContain(".base.sha");
    expect(verify.run).toContain(`/actions/workflows/${dollarSign}{PUBLISH_WORKFLOW}/runs?`);
    expect(verify.run).toContain("gh api --paginate --slurp");
    expect(verify.run).toContain("artifact totals disagree");
    expect(verify.run).toContain("gh run download");
    expect(verify.run).toContain(".tarballIntegrity");
    expect(verify.run).toContain('.["dist.integrity"] == $integrity');
    expect(createScript).toContain(".tag_name == $tag");
    expect(createScript).toContain(".name == $title");
    expect(createScript).toContain(".draft == false");
    expect(createScript).toContain(".prerelease == $prerelease");
    expect(createScript).toContain(".target_commitish == $target");
    expect(createScript).toContain(".gitHead == $sha");
    expect(createScript).toContain('.["dist.integrity"] == $integrity');
    expect(createScript).toContain('gh release create "$TAG"');
    expect(createScript).toContain("--latest=false");
    expect(createScript).toContain("CREATE_STATUS");
    expect(createScript).toContain('revalidate_published_authorities "after GitHub Release create attempt"');
    expect(createScript).toContain('revalidate_pr_authority "after GitHub Release create attempt"');
    expect(createScript).toContain(`/commits/${dollarSign}{TARGET_SHA}/pulls?per_page=100`);
  });

  it("keeps all embedded workflow scripts bash-syntax valid without startup injection", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-bash-syntax-environment-"));
    const marker = join(cwd, "bash-env-syntax-marker");
    const poisonScript = join(cwd, "bash-env-syntax-poison.sh");
    writeFileSync(poisonScript, `#!/bin/sh\n: > "${marker}"\nif then\n`);
    chmodSync(poisonScript, 0o755);
    const child = createHermeticFixtureProcess(cwd, {
      env: { BASH_ENV: poisonScript },
      parentEnvironment: { BASH_ENV: poisonScript },
    });

    expect(child.environment.BASH_ENV).toBeUndefined();
    expect(() => execHermeticFixtureCommand(child, "/bin/bash", ["-n", poisonScript])).toThrow();
    for (const path of workflowPaths) {
      const { config } = readWorkflow(path);
      for (const step of steps(config)) {
        if (!step.run) continue;
        expect(
          () => execHermeticFixtureCommand(child, "/bin/bash", ["-n"], { input: step.run }),
          `${path}: ${step.name ?? "unnamed"}`,
        ).not.toThrow();
      }
    }
    expect(existsSync(marker)).toBe(false);
  });
});

describe("release workflow executable hostile fixtures", () => {
  it("rejects a workflow_dispatch caller even when it supplies a valid tag ref", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(provenance, fixture, {
        EVENT_NAME: "workflow_dispatch",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("tag push events only");
      expect(result.commandLog).not.toContain("gh ");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("accepts a stale PR base SHA because current branch reachability is authoritative", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(provenance, fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.commandLog).toContain("git/ref/heads/main");
      expect(result.commandLog).toContain(`compare/${fixture.targetSha}...${fixture.currentBaseSha}`);
      expect(result.commandLog).not.toContain(fixture.baseSha);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a second eligible associated PR before and after publication", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry");
    const verify = namedStep(config, "Verify exact registry result after publish or retry");
    const fixture = createFixture();
    const associatedPrPages = JSON.stringify([
      [associatedPullRequest(fixture)],
      [associatedPullRequest(fixture, { number: Number(fixture.prNumber) + 1 })],
    ]);
    try {
      const beforePublish = runPublishRevalidation(revalidate, fixture, fixture.tarball, {
        FIXTURE_ASSOCIATED_PRS_JSON: associatedPrPages,
      });
      expect(beforePublish.status).not.toBe(0);
      expect(beforePublish.stderr).toContain("Associated PR provenance changed after artifact sealing");
      expect(beforePublish.commandLog).toContain("--paginate --slurp");
      expect(beforePublish.commandLog).not.toContain(`/pulls/${fixture.prNumber}/files?per_page=100`);

      const afterPublish = runFixtureStep(verify, fixture, {
        FIXTURE_ASSOCIATED_PRS_JSON: associatedPrPages,
      });
      expect(afterPublish.status).not.toBe(0);
      expect(afterPublish.stderr).toContain("Associated PR provenance diverged during publication");
      expect(afterPublish.commandLog).toContain("--paginate --slurp");
      expect(afterPublish.commandLog).not.toContain("npm view");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a cross-base second eligible PR before publication", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry");
    const fixture = createFixture();
    const associatedPrPages = JSON.stringify([
      [associatedPullRequest(fixture, { base: "main" })],
      [
        associatedPullRequest(fixture, {
          base: "dev",
          number: Number(fixture.prNumber) + 1,
        }),
      ],
    ]);
    try {
      const result = runPublishRevalidation(revalidate, fixture, fixture.tarball, {
        FIXTURE_ASSOCIATED_PRS_JSON: associatedPrPages,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Associated PR provenance changed after artifact sealing");
      expect(result.commandLog).toContain("--paginate --slurp");
      expect(result.commandLog).not.toContain(`/pulls/${fixture.prNumber}/files?per_page=100`);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a cross-base second eligible PR after publication", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const verify = namedStep(config, "Verify exact registry result after publish or retry");
    const fixture = createFixture();
    const associatedPrPages = JSON.stringify([
      [associatedPullRequest(fixture, { base: "main" })],
      [
        associatedPullRequest(fixture, {
          base: "dev",
          number: Number(fixture.prNumber) + 1,
        }),
      ],
    ]);
    try {
      const result = runFixtureStep(verify, fixture, {
        FIXTURE_ASSOCIATED_PRS_JSON: associatedPrPages,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Associated PR provenance diverged during publication");
      expect(result.commandLog).toContain("--paginate --slurp");
      expect(result.commandLog).not.toContain("npm view");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects an extra file hidden on a later paginated PR-files page", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(provenance, fixture, {
        FIXTURE_PR_FILES_JSON: JSON.stringify([
          [{ filename: fixture.packagePath, previous_filename: null, status: "modified" }],
          [{ filename: "src/hidden.ts", previous_filename: null, status: "added" }],
        ]),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("full paginated delta");
      expect(result.commandLog).toContain("--paginate --slurp");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects duplicate, symlinked, and multi-JSON package manifests in a sealed tarball", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry");
    const fixture = createFixture();
    try {
      for (const kind of ["duplicate", "symlink", "multi-json"] as const) {
        const tarball = createAdversarialTarball(fixture, kind);
        const result = runPublishRevalidation(revalidate, fixture, tarball);
        expect(result.status, `${kind}: ${result.stderr}`).not.toBe(0);
        expect(result.commandLog, kind).not.toContain("gh ");
        expect(result.commandLog, kind).not.toContain("npm ");
      }
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects an existing npm version whose dist.integrity differs from the sealed tarball", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry");
    const fixture = createFixture();
    try {
      const result = runPublishRevalidation(revalidate, fixture, fixture.tarball, {
        FIXTURE_REGISTRY_METADATA_JSON: JSON.stringify({
          "dist.integrity": `sha512-${"A".repeat(86)}==`,
          gitHead: fixture.targetSha,
          version: fixture.version,
        }),
        FIXTURE_REGISTRY_VERSIONS_JSON: JSON.stringify(["3.260723.4", fixture.version]),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mismatched gitHead or dist.integrity");
      expect(result.commandLog).toContain("version gitHead dist.integrity --json");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("keeps v7, v6, and v5 publishable when their immutable tags land in inverted order", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const revalidate = namedStep(config, "Revalidate artifact, tag, current base, PR files, and registry");
    const publish = namedStep(config, "Publish immutable inspected tarball");
    const publicationOrder = ["3.260723.7", "3.260723.6", "3.260723.5"];
    const publishedVersions: string[] = ["3.260723.4"];
    const publishedTags: Record<string, string> = {};
    const publishLogs: string[] = [];

    for (const version of publicationOrder) {
      const fixture = createFixture({ version });
      try {
        const revalidation = runPublishRevalidation(revalidate, fixture, fixture.tarball, {
          FIXTURE_DIST_TAGS_JSON: JSON.stringify(publishedTags),
          FIXTURE_REGISTRY_VERSIONS_JSON: JSON.stringify(publishedVersions),
        });
        expect(revalidation.status, `${version}: ${revalidation.stderr}`).toBe(0);
        expect(revalidation.githubOutput).toContain("already_published=false");

        const publication = runFixtureStep(publish, fixture);
        expect(publication.status, `${version}: ${publication.stderr}`).toBe(0);
        publishLogs.push(publication.commandLog);

        publishedVersions.push(version);
        publishedTags[`stable-v${version.replaceAll(".", "-")}`] = version;
      } finally {
        rmSync(fixture.cwd, { force: true, recursive: true });
      }
    }

    const combined = publishLogs.join("");
    for (const version of publicationOrder) {
      expect(combined).toContain(`--tag stable-v${version.replaceAll(".", "-")}`);
    }
    expect(combined).not.toMatch(/--tag (?:latest|next)(?:\s|$)/);
  });

  it("fails after publish when the remote tag diverges before final verification", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const verify = namedStep(config, "Verify exact registry result after publish or retry");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(verify, fixture, {
        FIXTURE_TAG_REF_JSON: JSON.stringify({
          object: { sha: "e".repeat(40), type: "commit" },
          ref: `refs/tags/${fixture.tag}`,
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Remote tag diverged during publication");
      expect(result.commandLog).not.toContain("npm view");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("finds a unique authoritative artifact after page 1 and rejects duplicates across pages", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const verify = namedStep(config, "Verify full published tag provenance");
    const fixture = createFixture();
    const artifact = { expired: false, name: "ravi-root-package-42-1" };
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      expired: false,
      name: `unrelated-${index}`,
    }));
    try {
      const pageTwoMatch = runFixtureStep(verify, fixture, {
        FIXTURE_ARTIFACT_INDEX_JSON: JSON.stringify([
          { artifacts: unrelated, total_count: 101 },
          { artifacts: [artifact], total_count: 101 },
        ]),
      });
      expect(pageTwoMatch.status, pageTwoMatch.stderr).toBe(0);
      expect(pageTwoMatch.commandLog).toContain("gh api --paginate --slurp -H Accept: application/vnd.github+json");
      expect(pageTwoMatch.commandLog).toContain("gh run download 42");

      const inconsistentTotals = runFixtureStep(verify, fixture, {
        FIXTURE_ARTIFACT_INDEX_JSON: JSON.stringify([
          { artifacts: unrelated, total_count: 101 },
          { artifacts: [artifact], total_count: 102 },
        ]),
      });
      expect(inconsistentTotals.status).not.toBe(0);
      expect(inconsistentTotals.stderr).toContain("Publishing artifact pages are incomplete or ambiguous");
      expect(inconsistentTotals.commandLog).not.toContain("gh run download");

      const duplicateAcrossPages = runFixtureStep(verify, fixture, {
        FIXTURE_ARTIFACT_INDEX_JSON: JSON.stringify([
          { artifacts: [...unrelated.slice(0, 99), artifact], total_count: 101 },
          { artifacts: [artifact], total_count: 101 },
        ]),
      });
      expect(duplicateAcrossPages.status).not.toBe(0);
      expect(duplicateAcrossPages.stderr).toContain("Publishing artifact index is ambiguous");
      expect(duplicateAcrossPages.commandLog).not.toContain("gh run download");
      expect(duplicateAcrossPages.commandLog).not.toContain("npm view");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("recovers sealed SSRI from a successful push run without a manual integrity input", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const verify = namedStep(config, "Verify full published tag provenance");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(verify, fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.githubOutput).toContain(`integrity=${fixture.tarballIntegrity}`);
      expect(result.commandLog).toContain("/actions/workflows/version.yml/runs?event=push");
      expect(result.commandLog).toContain("/actions/runs/42/artifacts?per_page=100");
      expect(result.commandLog).toContain("gh run download 42");
      expect(result.commandLog).toContain("version gitHead dist.integrity --json");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("fails GitHub Release verification when sealed publish provenance expired", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const verify = namedStep(config, "Verify full published tag provenance");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(verify, fixture, {
        FIXTURE_ARTIFACT_INDEX_JSON: JSON.stringify([
          {
            artifacts: [{ expired: true, name: "ravi-root-package-42-1" }],
            total_count: 1,
          },
        ]),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("No unexpired successful tag-push artifact");
      expect(result.commandLog).not.toContain("npm view");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("fails closed when the base branch moves after release verification", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_BRANCH_REF_JSON: JSON.stringify({
          object: { sha: "e".repeat(40), type: "commit" },
          ref: "refs/heads/main",
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Base branch moved");
      expect(result.commandLog).not.toContain("gh release create");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a tracked hostile npmrc before any registry or package execution", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base");
    const fixture = createFixture({ trackedNpmrc: true });
    try {
      const result = runFixtureStep(provenance, fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Repository-controlled .npmrc");
      expect(result.commandLog).not.toContain("npm ");
      expect(result.commandLog).not.toContain("gh ");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("fails closed when the controlled fixture PATH shadows npm before trust establishment", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const resolve = namedStep(config, "Resolve trusted npm before repository code");
    const fixture = createFixture();
    try {
      const result = runReleaseWorkflowFixture({
        commands: { npm: "exit 99" },
        cwd: fixture.cwd,
        script: resolve.run ?? "",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("outside the freshly configured Node toolchain");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects impossible calendar dates before GitHub provenance calls", () => {
    const { config } = readWorkflow(".github/workflows/version.yml");
    const provenance = namedStep(config, "Verify tag, reviewed PR delta, and current base");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(provenance, fixture, {
        EVENT_REF: "refs/tags/v3.260231.1",
        EVENT_REF_NAME: "v3.260231.1",
        FIXTURE_DATE_FAIL: "1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a real UTC calendar date");
      expect(result.commandLog).not.toContain("gh ");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a later-page same-base associated PR before release lookup or create", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    const associatedPrPages = JSON.stringify([
      [associatedPullRequest(fixture, { base: "main" })],
      [
        associatedPullRequest(fixture, {
          base: "main",
          number: Number(fixture.prNumber) + 1,
        }),
      ],
    ]);
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_ASSOCIATED_PRS_JSON: associatedPrPages,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Associated PR authority is not unique after verification");
      expect(result.commandLog).toContain("gh api --paginate --slurp");
      expect(commandCount(result.commandLog, `/commits/${fixture.targetSha}/pulls?per_page=100`)).toBe(1);
      expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(0);
      expect(commandCount(result.commandLog, "gh release create")).toBe(0);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects malformed associated PR pages before release lookup or create", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_ASSOCIATED_PRS_JSON: JSON.stringify([{ malformed: true }]),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Associated PR pages became ambiguous after verification");
      expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(0);
      expect(commandCount(result.commandLog, "gh release create")).toBe(0);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a later-page same-base associated PR introduced after release create", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    const postCreatePages = JSON.stringify([
      [associatedPullRequest(fixture, { base: "main" })],
      [
        associatedPullRequest(fixture, {
          base: "main",
          number: Number(fixture.prNumber) + 1,
        }),
      ],
    ]);
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_POST_CREATE_ASSOCIATED_PRS_JSON: postCreatePages,
        FIXTURE_RELEASE_LOOKUP_MODE: "missing",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Associated PR authority is not unique after GitHub Release create attempt");
      expect(commandCount(result.commandLog, "gh release create")).toBe(1);
      expect(commandCount(result.commandLog, `/commits/${fixture.targetSha}/pulls?per_page=100`)).toBe(2);
      expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(2);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a cross-base associated PR introduced after release create", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    const postCreatePages = JSON.stringify([
      [associatedPullRequest(fixture, { base: "main" })],
      [
        associatedPullRequest(fixture, {
          base: "dev",
          number: Number(fixture.prNumber) + 1,
        }),
      ],
    ]);
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_POST_CREATE_ASSOCIATED_PRS_JSON: postCreatePages,
        FIXTURE_RELEASE_LOOKUP_MODE: "missing",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Associated PR authority is not unique after GitHub Release create attempt");
      expect(commandCount(result.commandLog, "gh release create")).toBe(1);
      expect(commandCount(result.commandLog, `/commits/${fixture.targetSha}/pulls?per_page=100`)).toBe(2);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("accepts an existing exactly matching release without creating it again", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.commandLog).toContain(`/releases/tags/${fixture.tag}`);
      expect(result.commandLog).not.toContain("gh release create");
      expect(result.commandLog).toContain(
        `npm view ${fixture.packageName}@${fixture.version} version gitHead dist.integrity --json`,
      );
      expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(1);
      expect(commandCount(result.commandLog, `/commits/${fixture.targetSha}/pulls?per_page=100`)).toBe(1);
      expect(commandCount(result.commandLog, `/pulls/${fixture.prNumber}/files?per_page=100`)).toBe(1);
      expect(commandCount(result.commandLog, "gh release create")).toBe(0);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  for (const createExit of ["0", "1"] as const) {
    it(`accepts an exact canonical reread after a release create exit ${createExit}`, () => {
      const { config } = readWorkflow(".github/workflows/release.yml");
      const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
      const fixture = createFixture();
      try {
        const result = runFixtureStep(create, fixture, {
          FIXTURE_RELEASE_CREATE_EXIT: createExit,
          FIXTURE_RELEASE_LOOKUP_MODE: "missing",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(commandCount(result.commandLog, "gh release create")).toBe(1);
        expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(2);
        expect(commandCount(result.commandLog, `/git/ref/tags/${fixture.tag}`)).toBe(2);
        expect(commandCount(result.commandLog, "/git/ref/heads/main")).toBe(2);
        expect(commandCount(result.commandLog, "/compare/")).toBe(2);
        expect(commandCount(result.commandLog, `/commits/${fixture.targetSha}/pulls?per_page=100`)).toBe(2);
        expect(commandCount(result.commandLog, `/pulls/${fixture.prNumber}/files?per_page=100`)).toBe(1);
        expect(
          commandCount(
            result.commandLog,
            `npm view ${fixture.packageName}@${fixture.version} version gitHead dist.integrity --json`,
          ),
        ).toBe(2);
        expect(commandCount(result.commandLog, `npm view ${fixture.packageName} dist-tags --json`)).toBe(2);
      } finally {
        rmSync(fixture.cwd, { force: true, recursive: true });
      }
    });
  }

  it("creates an exact dev prerelease with two authority reads", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    const immutableTag = `next-v${fixture.version.replaceAll(".", "-")}`;
    const devPr = associatedPullRequest(fixture, { base: "dev" });
    try {
      const result = runFixtureStep(create, fixture, {
        EXPECTED_BASE: "dev",
        EXPECTED_IMMUTABLE_NPM_TAG: immutableTag,
        FIXTURE_ASSOCIATED_PRS_JSON: JSON.stringify([[devPr]]),
        FIXTURE_BRANCH_REF_JSON: JSON.stringify({
          object: { sha: fixture.currentBaseSha, type: "commit" },
          ref: "refs/heads/dev",
        }),
        FIXTURE_DIST_TAGS_JSON: JSON.stringify({ [immutableTag]: fixture.version }),
        FIXTURE_PR_JSON: JSON.stringify(devPr),
        FIXTURE_RELEASE_JSON: JSON.stringify({
          draft: false,
          name: fixture.tag,
          prerelease: true,
          tag_name: fixture.tag,
          target_commitish: fixture.targetSha,
        }),
        FIXTURE_RELEASE_LOOKUP_MODE: "missing",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(commandCount(result.commandLog, "gh release create")).toBe(1);
      expect(result.commandLog).toContain("--prerelease --latest=false");
      expect(commandCount(result.commandLog, `/commits/${fixture.targetSha}/pulls?per_page=100`)).toBe(2);
      expect(commandCount(result.commandLog, "/git/ref/heads/dev")).toBe(2);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a missing canonical reread after a release create attempt", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_RELEASE_LOOKUP_MODE: "missing",
        FIXTURE_RELEASE_REREAD_MODE: "missing",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("GitHub Release is absent after create attempt");
      expect(commandCount(result.commandLog, "gh release create")).toBe(1);
      expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(2);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects a divergent canonical reread after a release create attempt", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_RELEASE_LOOKUP_MODE: "missing",
        FIXTURE_RELEASE_REREAD_JSON: JSON.stringify({
          draft: false,
          name: "divergent title",
          prerelease: false,
          tag_name: fixture.tag,
          target_commitish: fixture.targetSha,
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Created GitHub Release metadata does not exactly match");
      expect(commandCount(result.commandLog, "gh release create")).toBe(1);
      expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`)).toBe(2);
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects every tag, base, reachability, or registry drift after release creation", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    const wrongSha = "e".repeat(40);
    const wrongIntegrity = `sha512-${"A".repeat(86)}==`;
    const cases: Array<{
      expectedError: string;
      name: string;
      overrides: Record<string, string>;
    }> = [
      {
        expectedError: "Tag changed after GitHub Release create attempt",
        name: "tag",
        overrides: {
          FIXTURE_POST_CREATE_TAG_REF_JSON: JSON.stringify({
            object: { sha: wrongSha, type: "commit" },
            ref: `refs/tags/${fixture.tag}`,
          }),
        },
      },
      {
        expectedError: "Base branch moved after GitHub Release create attempt",
        name: "base",
        overrides: {
          FIXTURE_POST_CREATE_BRANCH_REF_JSON: JSON.stringify({
            object: { sha: wrongSha, type: "commit" },
            ref: "refs/heads/main",
          }),
        },
      },
      {
        expectedError: "Target is no longer reachable",
        name: "reachability",
        overrides: {
          FIXTURE_POST_CREATE_REACHABILITY_JSON: JSON.stringify({
            base_commit: { sha: wrongSha },
            head_commit: { sha: fixture.currentBaseSha },
            merge_base_commit: { sha: wrongSha },
            status: "diverged",
          }),
        },
      },
      {
        expectedError: "required integrity, gitHead, or immutable dist-tag",
        name: "registry version",
        overrides: {
          FIXTURE_POST_CREATE_REGISTRY_METADATA_JSON: JSON.stringify({
            "dist.integrity": fixture.tarballIntegrity,
            gitHead: fixture.targetSha,
            version: "3.260723.4",
          }),
        },
      },
      {
        expectedError: "required integrity, gitHead, or immutable dist-tag",
        name: "registry gitHead",
        overrides: {
          FIXTURE_POST_CREATE_REGISTRY_METADATA_JSON: JSON.stringify({
            "dist.integrity": fixture.tarballIntegrity,
            gitHead: wrongSha,
            version: fixture.version,
          }),
        },
      },
      {
        expectedError: "required integrity, gitHead, or immutable dist-tag",
        name: "registry integrity",
        overrides: {
          FIXTURE_POST_CREATE_REGISTRY_METADATA_JSON: JSON.stringify({
            "dist.integrity": wrongIntegrity,
            gitHead: fixture.targetSha,
            version: fixture.version,
          }),
        },
      },
      {
        expectedError: "required integrity, gitHead, or immutable dist-tag",
        name: "registry dist-tag",
        overrides: {
          FIXTURE_POST_CREATE_DIST_TAGS_JSON: JSON.stringify({
            [`stable-v${fixture.version.replaceAll(".", "-")}`]: "3.260723.4",
          }),
        },
      },
    ];

    try {
      for (const drift of cases) {
        const result = runFixtureStep(create, fixture, {
          FIXTURE_RELEASE_LOOKUP_MODE: "missing",
          ...drift.overrides,
        });
        expect(result.status, drift.name).not.toBe(0);
        expect(result.stderr, drift.name).toContain(drift.expectedError);
        expect(commandCount(result.commandLog, "gh release create"), drift.name).toBe(1);
        expect(commandCount(result.commandLog, `/releases/tags/${fixture.tag}`), drift.name).toBe(2);
      }
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects an existing release whose title or target metadata differs", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_RELEASE_JSON: JSON.stringify({
          draft: false,
          name: "wrong title",
          prerelease: false,
          tag_name: fixture.tag,
          target_commitish: "e".repeat(40),
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not exactly match");
      expect(result.commandLog).not.toContain("gh release create");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });

  it("rejects release creation when the exact published version gitHead differs", () => {
    const { config } = readWorkflow(".github/workflows/release.yml");
    const create = namedStep(config, "Revalidate published artifact and create GitHub Release");
    const fixture = createFixture();
    try {
      const result = runFixtureStep(create, fixture, {
        FIXTURE_REGISTRY_METADATA_JSON: JSON.stringify({
          gitHead: "e".repeat(40),
          version: fixture.version,
        }),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("required integrity, gitHead");
      expect(result.commandLog).not.toContain("gh release create");
    } finally {
      rmSync(fixture.cwd, { force: true, recursive: true });
    }
  });
});
