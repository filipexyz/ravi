import { describe, expect, it } from "bun:test";
import { YAML } from "bun";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean>;
  env?: Record<string, string>;
};

type Workflow = {
  env?: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string>; env?: Record<string, string>; steps: WorkflowStep[] }>;
};

const releaseWorkflows = [
  { file: "version.yml", job: "version-and-publish", packageName: "ravi.bot", tag: "next" },
  { file: "sdk-release.yml", job: "release", packageName: "@ravi-os/sdk", tag: "latest" },
  { file: "voice-release.yml", job: "release", packageName: "@ravi-os/voice", tag: "latest" },
] as const;
const version = "3.261111.9";
const syntheticToken = "synthetic-release-token-never-log";

function loadWorkflow(file: string): Workflow {
  return YAML.parse(readFileSync(resolve(import.meta.dir, "../../.github/workflows", file), "utf8")) as Workflow;
}

function executePublish(
  release: (typeof releaseWorkflows)[number],
  options: { exists?: boolean; token?: string; exitCode?: number } = {},
) {
  const step = loadWorkflow(release.file).jobs[release.job]!.steps.find(
    (candidate) => candidate.name === "Publish to npm",
  )!;
  expect(step.run).toBeDefined();
  const dir = mkdtempSync(join(tmpdir(), "ravi-npm-workflow with space-"));
  const bin = join(dir, "bin");
  const log = join(dir, "npm-calls.jsonl");
  mkdirSync(bin);
  const npmrc = join(dir, ".npmrc");
  const npmrcContents = "# Existing user config must not be replaced by the publish step.\n";
  writeFileSync(npmrc, npmrcContents);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: release.packageName, version }));
  writeFileSync(join(dir, "runner.npmrc"), `//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`);
  writeFileSync(
    join(bin, "npm"),
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + "\\n");
if (args.includes("view")) {
  if (process.env.VERSION_EXISTS === "true") {
    console.log(process.env.VERSION);
    process.exit(0);
  }
  console.error("npm error code E404");
  process.exit(1);
}
if (!args.includes("publish") && !args.includes("dist-tag")) {
  console.error("Unexpected npm command");
  process.exit(99);
}
if (process.env.MUTATION_EXIT_CODE !== "0") {
  console.error(process.env.NODE_AUTH_TOKEN ? "npm error code EOTP" : "npm error code ENEEDAUTH");
} else {
  console.error("npm verbose oidc Successfully retrieved and set token");
}
process.exit(Number(process.env.MUTATION_EXIT_CODE));
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "jq"),
    `#!${process.execPath}
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "-r" || args[1] !== ".name") process.exit(99);
console.log(JSON.parse(readFileSync(args[2], "utf8")).name);
`,
    { mode: 0o755 },
  );
  // Prevent accidentally executing the old SDK publisher if it regresses.
  writeFileSync(join(bin, "bun"), "#!/bin/sh\necho 'Unexpected bun command' >&2\nexit 99\n", { mode: 0o755 });

  try {
    // Deliberately do not inherit process.env: no operator credentials, config,
    // runtime identity or real registry client can enter this subprocess.
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      TMPDIR: dir,
      RUNNER_TEMP: dir,
      NPM_CONFIG_USERCONFIG: join(dir, "runner.npmrc"),
      NPM_CONFIG_PROVENANCE: "true",
      VERSION: version,
      NPM_TAG: release.tag,
      CALL_LOG: log,
      VERSION_EXISTS: String(options.exists ?? false),
      MUTATION_EXIT_CODE: String(options.exitCode ?? 0),
    };
    if (options.token !== undefined) env.NODE_AUTH_TOKEN = options.token;
    const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", step.run!], {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(readFileSync(npmrc, "utf8")).toBe(npmrcContents);
    const calls = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
    return { status: result.status, output: result.stdout + result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const release of releaseWorkflows) {
  describe(release.file, () => {
    it("supplies OIDC permission and a compatible npm before publication", () => {
      const workflow = loadWorkflow(release.file);
      const job = workflow.jobs[release.job]!;
      expect(job.permissions).toMatchObject({ contents: "write", "id-token": "write" });
      const nodeIndex = job.steps.findIndex((step) => step.uses === "actions/setup-node@v6");
      expect(nodeIndex).toBeGreaterThanOrEqual(0);
      expect(job.steps[nodeIndex]!.with).toMatchObject({
        "node-version": "24",
        "registry-url": "https://registry.npmjs.org",
        "package-manager-cache": false,
      });
      const npmIndex = job.steps.findIndex((step) => step.run?.includes("npm@11.21.1"));
      const publishIndex = job.steps.findIndex((step) => step.name === "Publish to npm");
      expect(npmIndex).toBeGreaterThan(nodeIndex);
      expect(publishIndex).toBeGreaterThan(npmIndex);
      const publish = job.steps[publishIndex]!;
      expect(publish.env?.NODE_AUTH_TOKEN).toBe(`\${{ secrets.NPM_TOKEN }}`);
      expect(publish.env).not.toHaveProperty("NPM_CONFIG_TOKEN");
      expect(publish.env).not.toHaveProperty("NPM_TOKEN");
      expect(workflow.env).not.toHaveProperty("NODE_AUTH_TOKEN");
      expect(job.env).not.toHaveProperty("NODE_AUTH_TOKEN");
      for (const step of job.steps.filter((_, index) => index !== publishIndex)) {
        expect(step.env).not.toHaveProperty("NODE_AUTH_TOKEN");
      }
    });

    for (const exists of [false, true]) {
      const operation = exists ? "dist-tag" : "publish";
      it(`runs ${operation} without a static token`, () => {
        const result = executePublish(release, { exists });
        expect(result.status).toBe(0);
        expect(result.output).toContain("OIDC");
        const mutation = result.calls.filter((args) => args.includes(operation));
        expect(mutation).toHaveLength(1);
        expect(result.calls).toHaveLength(2);
        const args = mutation[0]!;
        expect(args.join(" ")).toMatch(/--loglevel(?:=|\s)verbose/);
        if (exists) {
          expect(args).toContain("add");
          expect(args).toContain(`${release.packageName}@${version}`);
          expect(args).toContain(release.tag);
        } else {
          expect(args).toContain("--provenance");
          expect(args.slice(args.indexOf("--access"), args.indexOf("--access") + 2)).toEqual(["--access", "public"]);
          expect(args.slice(args.indexOf("--tag"), args.indexOf("--tag") + 2)).toEqual(["--tag", release.tag]);
        }
      });

      it(`preserves ${operation} failure when OIDC is not configured and no token exists`, () => {
        const result = executePublish(release, { exists, exitCode: 42 });
        expect(result.status).toBe(42);
        expect(result.output).toContain("ENEEDAUTH");
        expect(result.calls.filter((args) => args.includes(operation))).toHaveLength(1);
      });

      it(`announces the optional token fallback for ${operation} without revealing it`, () => {
        const result = executePublish(release, { exists, token: syntheticToken });
        expect(result.status).toBe(0);
        expect(result.output).toMatch(/NPM_TOKEN.*fallback|fallback.*NPM_TOKEN/);
        expect(result.output).not.toContain(syntheticToken);
        expect(result.calls.filter((args) => args.includes(operation))).toHaveLength(1);
        expect(JSON.stringify(result.calls)).not.toContain(syntheticToken);
      });

      it(`does not hide EOTP from the ${operation} token fallback`, () => {
        const result = executePublish(release, { exists, token: syntheticToken, exitCode: 43 });
        expect(result.status).toBe(43);
        expect(result.output).toContain("EOTP");
        expect(result.output).not.toContain(syntheticToken);
        expect(result.calls.filter((args) => args.includes(operation))).toHaveLength(1);
      });
    }
  });
}

const packageReleaseWorkflows = [
  {
    file: "sdk-release.yml",
    bumpStep: "Commit SDK version bump",
    packagePathEnv: "SDK_PACKAGE_PATH",
    packageName: "@ravi-os/sdk",
  },
  {
    file: "voice-release.yml",
    bumpStep: "Commit voice version bump",
    packagePathEnv: "VOICE_PACKAGE_PATH",
    packageName: "@ravi-os/voice",
  },
] as const;

for (const release of packageReleaseWorkflows) describe(`${release.file}: the push of the version bump and the major prefix`, () => {
  const jqDir =
    ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin"].find((dir) => existsSync(join(dir, "jq"))) ??
    "/usr/bin";
  // A GitHub Actions expression, written so the source does not hold a template-looking string.
  const expression = (body: string) => `$${"{{"} ${body} }}`;

  function findStep(name: string): string {
    const step = loadWorkflow(release.file).jobs.release!.steps.find((candidate) => candidate.name === name);
    expect(step?.run, name).toBeDefined();
    return step!.run!;
  }

  function execute(run: string, options: { env: Record<string, string>; fakes: Record<string, string> }) {
    const dir = mkdtempSync(join(tmpdir(), "ravi-sdk-release-step with space-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    try {
      for (const [name, body] of Object.entries(options.fakes)) {
        writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
      }
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: release.packageName, version: "0.261009.1" }));
      writeFileSync(join(dir, "github-output"), "");
      // Deliberately not inheriting process.env: no operator credential, runtime identity or real git/npm client.
      const result = spawnSync("bash", ["-e", "-c", run], {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          PATH: `${bin}:${jqDir}:/usr/bin:/bin`,
          HOME: dir,
          TMPDIR: dir,
          [release.packagePathEnv]: join(dir, "package.json"),
          GITHUB_OUTPUT: join(dir, "github-output"),
          ...options.env,
        },
      });
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        githubOutput: readFileSync(join(dir, "github-output"), "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const fakeGit = `
const args = process.argv.slice(2);
if (args[0] === "diff") process.exit(1);
if (args[0] === "push") {
  console.log(process.env.FAKE_PUSH_OUTPUT ?? "");
  process.exit(Number(process.env.FAKE_PUSH_STATUS ?? 0));
}
process.exit(0);
`;

  function bumpStep(push: { status: number; output: string }) {
    const run = findStep(release.bumpStep)
      .replaceAll(expression("steps.version.outputs.version"), "0.261125.1")
      .replaceAll(expression("github.event.inputs.branch"), "dev");
    return execute(run, {
      env: {
        FAKE_PUSH_STATUS: String(push.status),
        FAKE_PUSH_OUTPUT: push.output,
      },
      fakes: { git: fakeGit },
    });
  }

  const ruleRejection = [
    "remote: error: GH013: Repository rule violations found for refs/heads/dev.",
    'remote: - Required status check "Quality Gate" is expected.',
    " ! [remote rejected] HEAD -> dev (push declined due to repository rule violations)",
    "error: failed to push some refs to 'https://github.com/filipexyz/ravi'",
  ].join("\n");

  it("turns a rejection by the repository rules into a warning and lets the release go on", () => {
    const result = bumpStep({ status: 1, output: ruleRejection });
    expect(result.status).toBe(0);
    expect(result.output).toContain("::warning::");
    expect(result.output).not.toContain("::error::");
  });

  it("fails the job when the pre-push suite fails", () => {
    const result = bumpStep({
      status: 1,
      output: "Pre-push checks failed.\n(fail) some test [3.00ms]\nerror: failed to push some refs",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::");
    expect(result.output).not.toContain("::warning::");
  });

  it("does not take the words of a test log for a rejection by the repository rules", () => {
    const result = bumpStep({
      status: 1,
      output: [
        "(fail) GH013 Repository rule violations are reported > protected branch is explained [2.00ms]",
        "error: failed to push some refs",
      ].join("\n"),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("::error::");
  });

  it("accepts the older protected-branch rejection of the server as a rule rejection", () => {
    const result = bumpStep({
      status: 1,
      output: "remote: error: GH006: Protected branch update failed for refs/heads/dev.",
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("::warning::");
  });

  it("passes a clean push without a warning", () => {
    const result = bumpStep({ status: 0, output: "" });
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("::warning::");
    expect(result.output).not.toContain("::error::");
  });

  function resolvePrefix(input: string, registry: string) {
    const run = findStep("Resolve prefix").replaceAll(expression("github.event.inputs.prefix"), input);
    const result = execute(run, {
      env: { FAKE_REGISTRY: registry },
      fakes: {
        npm: `
if (!process.argv.includes("view") || !process.env.FAKE_REGISTRY) process.exit(1);
console.log(process.env.FAKE_REGISTRY);
`,
      },
    });
    return { status: result.status, prefix: /^prefix=(.*)$/m.exec(result.githubOutput)?.[1] };
  }

  it("follows the registry's major when it is ahead of the manifest's and no prefix was given", () => {
    expect(resolvePrefix("", "1.261125.1")).toEqual({ status: 0, prefix: "1" });
  });

  it("keeps the manifest's major when the registry has the same one or cannot be reached", () => {
    expect(resolvePrefix("", "0.261125.1")).toEqual({ status: 0, prefix: "0" });
    expect(resolvePrefix("", "")).toEqual({ status: 0, prefix: "0" });
  });

  it("keeps an explicit prefix even when the registry is ahead", () => {
    expect(resolvePrefix("2", "1.261125.1")).toEqual({ status: 0, prefix: "2" });
  });
});
