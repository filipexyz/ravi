import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveManagedRuntimeTargetFromPackageRoot } from "../../managed-runtime.js";
import {
  buildManagedRuntimeRebindPlan,
  buildManagedRuntimeRebindSupervisorInvocation,
  decodeManagedRuntimeRebindRequest,
  rebindManagedRuntimeProcesses,
} from "../../managed-runtime-rebind.js";
import type { Pm2Process } from "../../pm2.js";
import {
  buildSourceUpdateOutcome,
  describePathCli,
  detectFromBinaryPath,
  findPackageRoot,
  packageTagForChannel,
  packageTagForVersion,
  parseGlobalInstallListing,
  resolveUpdatedManagedRuntimeTarget,
  resolveUpdateChannel,
  validateExpectedIntegrity,
} from "./update.js";

const MANAGED_RUNTIME_REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";
const OLD_VERSION = "3.260918.1";
const NEW_VERSION = "3.260918.4";

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/**
 * The bug scenario: a source checkout one release behind `origin/dev`, plus a
 * separate global install that `ravi` on PATH resolves to. Bun, npm, and pm2 are
 * shimmed so the run never reads the developer's real global packages or PM2.
 */
function createSourceUpdateScenario(options: { linkPathToCheckout?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-update-scenario-")));
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const globalRoot = join(root, "global", "node_modules", "ravi.bot");
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  mkdirSync(seed, { recursive: true });
  mkdirSync(join(seed, "bin"), { recursive: true });
  mkdirSync(join(globalRoot, "bin"), { recursive: true });
  mkdirSync(join(globalRoot, "dist", "bundle"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  const packageJson = (version: string) =>
    JSON.stringify(
      {
        name: "ravi.bot",
        version,
        scripts: { build: "mkdir -p dist/bundle && printf 'console.log(1)\\n' > dist/bundle/index.js" },
      },
      null,
      2,
    );
  writeFileSync(join(seed, "package.json"), packageJson(OLD_VERSION), "utf8");
  writeFileSync(join(seed, ".gitignore"), "dist/\nnode_modules/\nbun.lock\n", "utf8");
  writeExecutable(join(seed, "bin", "ravi"), "#!/usr/bin/env bash\necho checkout\n");
  git(seed, "init", "-q", "-b", "dev");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", OLD_VERSION);
  git(seed, "clone", "-q", "--bare", seed, origin);
  git(root, "clone", "-q", "-b", "dev", origin, checkout);
  mkdirSync(join(checkout, "dist", "bundle"), { recursive: true });
  writeFileSync(join(checkout, "dist", "bundle", "index.js"), "", "utf8");

  writeFileSync(join(seed, "package.json"), packageJson(NEW_VERSION), "utf8");
  git(seed, "commit", "-qam", NEW_VERSION);
  git(seed, "push", "-q", origin, "dev");

  writeFileSync(join(globalRoot, "package.json"), JSON.stringify({ name: "ravi.bot", version: OLD_VERSION }), "utf8");
  writeExecutable(join(globalRoot, "bin", "ravi"), "#!/usr/bin/env bash\necho global\n");
  writeFileSync(join(globalRoot, "dist", "bundle", "index.js"), "", "utf8");
  symlinkSync(
    options.linkPathToCheckout ? join(checkout, "bin", "ravi") : join(globalRoot, "bin", "ravi"),
    join(bin, "ravi"),
  );

  writeExecutable(
    join(bin, "bun"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "pm" ] && [ "$2" = "ls" ] && [ "$3" = "-g" ]; then',
      `  echo "${join(root, "global")} node_modules (1)"`,
      `  echo "└── ravi.bot@${OLD_VERSION}"`,
      "  exit 0",
      "fi",
      `exec "${process.execPath}" "$@"`,
      "",
    ].join("\n"),
  );
  writeExecutable(join(bin, "npm"), "#!/usr/bin/env bash\nexit 1\n");
  writeExecutable(join(bin, "pm2"), '#!/usr/bin/env bash\n[ "$1" = "jlist" ] && echo "[]" && exit 0\nexit 1\n');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    RAVI_REPO: checkout,
    RAVI_STATE_DIR: stateDir,
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
  };
  for (const key of ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_BUNDLE", "RAVI_DAEMON_CWD"]) delete env[key];

  return {
    checkout,
    globalRoot,
    pathRavi: join(bin, "ravi"),
    run(...args: string[]) {
      return spawnSync("bun", ["src/cli/index.ts", "update", "--next", "--no-restart", ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
        timeout: 30_000,
      });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createRuntimePackage(version = "3.260812.2") {
  const root = mkdtempSync(join(tmpdir(), "ravi-update-runtime-"));
  const bundlePath = join(root, "dist", "bundle", "index.js");
  mkdirSync(join(bundlePath, ".."), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot", version }), "utf8");
  writeFileSync(bundlePath, "", "utf8");
  return {
    root: realpathSync(root),
    bundlePath: realpathSync(bundlePath),
    target: resolveManagedRuntimeTargetFromPackageRoot(root)!,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function pm2Process(
  name: "ravi" | "ravi-channels",
  bundlePath: string,
  cwd: string,
  overrides: Partial<Pm2Process> = {},
): Pm2Process {
  return {
    name,
    pm_id: name === "ravi" ? 1 : 2,
    pid: name === "ravi" ? 101 : 202,
    status: "online",
    cpu: 0,
    memory: 0,
    execPath: name === "ravi" ? bundlePath : "/usr/local/bin/bun",
    cwd,
    args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
    createdAt: 2,
    ...overrides,
  };
}

describe("update command helpers", () => {
  it("resolves explicit channel flags before persisted config", () => {
    expect(resolveUpdateChannel({ next: true }, { updateChannel: "latest" })).toBe("next");
    expect(resolveUpdateChannel({ stable: true }, { updateChannel: "next" })).toBe("latest");
  });

  it("uses persisted channel and falls back to latest", () => {
    expect(resolveUpdateChannel({}, { updateChannel: "next" })).toBe("next");
    expect(resolveUpdateChannel({}, {})).toBe("latest");
  });

  it("formats package tags for npm channels", () => {
    expect(packageTagForChannel("next")).toBe("ravi.bot@next");
    expect(packageTagForChannel("latest")).toBe("ravi.bot@latest");
  });

  it("normalizes and pins exact package versions", () => {
    expect(packageTagForVersion("v3.260811.2")).toBe("ravi.bot@3.260811.2");
    expect(() => packageTagForVersion("next")).toThrow("exact version");
    expect(() => packageTagForVersion("3.260811.2 || latest")).toThrow("exact version");
  });

  it("accepts only sha512 SRI values for release verification", () => {
    const integrity = `sha512-${"A".repeat(86)}==`;
    expect(validateExpectedIntegrity(integrity)).toBe(integrity);
    expect(() => validateExpectedIntegrity("sha256-not-enough")).toThrow("sha512");
    expect(() => validateExpectedIntegrity("sha512-A")).toThrow("sha512");
  });

  // This smoke check boots the complete CLI in a child process.
  it("returns one machine-readable usage error for an invalid exact version", () => {
    const stateDir = join(tmpdir(), `ravi-update-contract-${process.pid}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RAVI_STATE_DIR: stateDir,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    };
    delete env.RAVI_CONTEXT_KEY;
    delete env.RAVI_SESSION_KEY;
    const result = spawnSync("bun", ["src/cli/index.ts", "update", "--version", "latest", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
    rmSync(stateDir, { recursive: true, force: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "ravi update",
      error: { code: "USAGE_ERROR", retryable: false },
    });
  }, 20_000);

  it("detects common global install paths", () => {
    expect(detectFromBinaryPath("/home/tester/.bun/bin/ravi")).toBe("bun");
    expect(detectFromBinaryPath("/opt/node/lib/node_modules/ravi.bot/bin/ravi")).toBe("npm");
  });

  it("reads global install listings from bun and npm", () => {
    expect(
      parseGlobalInstallListing(
        "bun",
        "/home/tester/.bun/install/global node_modules (2)\n├── pm2@5.4.3\n└── ravi.bot@3.260918.1\n",
      ),
    ).toEqual({
      method: "bun",
      version: "3.260918.1",
      packageRoot: "/home/tester/.bun/install/global/node_modules/ravi.bot",
    });
    expect(parseGlobalInstallListing("npm", "/opt/homebrew/lib\n└── ravi.bot@3.260918.4\n")).toEqual({
      method: "npm",
      version: "3.260918.4",
      packageRoot: "/opt/homebrew/lib/node_modules/ravi.bot",
    });
    expect(parseGlobalInstallListing("npm", "/lib -> ./\n└── (empty)\n")).toBeNull();
    expect(parseGlobalInstallListing("bun", 'error: No package.json was found for directory "/x"\n')).toBeNull();
  });

  it("resolves `ravi` on PATH through symlinks to its package", () => {
    const runtime = createRuntimePackage("3.260918.1");
    const binDir = mkdtempSync(join(tmpdir(), "ravi-update-path-"));
    try {
      mkdirSync(join(runtime.root, "bin"), { recursive: true });
      writeFileSync(join(runtime.root, "bin", "ravi"), "", "utf8");
      symlinkSync(join(runtime.root, "bin", "ravi"), join(binDir, "ravi"));

      expect(describePathCli(join(binDir, "ravi"))).toEqual({
        path: join(binDir, "ravi"),
        packageRoot: runtime.root,
        version: "3.260918.1",
      });
      expect(describePathCli("")).toBeNull();
      expect(describePathCli(join(binDir, "missing"))).toMatchObject({ packageRoot: null, version: null });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      runtime.cleanup();
    }
  });

  it("marks the PATH CLI updated only when it resolves into the updated checkout", () => {
    const linked = buildSourceUpdateOutcome({
      sourceRoot: "/srv/ravi",
      channel: "next",
      pathCli: { path: "/home/tester/.bun/bin/ravi", packageRoot: "/srv/ravi", version: "3.260918.4" },
      globalInstalls: [{ method: "bun", version: "3.260918.4", packageRoot: "/srv/ravi" }],
    });
    expect(linked).toEqual({
      cliUpdated: true,
      pathCli: { path: "/home/tester/.bun/bin/ravi", packageRoot: "/srv/ravi", version: "3.260918.4", updated: true },
      staleInstalls: [],
      warnings: [],
    });

    const separate = buildSourceUpdateOutcome({
      sourceRoot: "/srv/ravi",
      channel: "next",
      pathCli: {
        path: "/home/tester/.bun/bin/ravi",
        packageRoot: "/home/tester/.bun/install/global/node_modules/ravi.bot",
        version: "3.260918.1",
      },
      globalInstalls: [
        { method: "bun", version: "3.260918.1", packageRoot: "/home/tester/.bun/install/global/node_modules/ravi.bot" },
      ],
    });
    expect(separate.cliUpdated).toBe(false);
    expect(separate.pathCli?.updated).toBe(false);
    expect(separate.staleInstalls).toHaveLength(1);
    expect(separate.warnings).toEqual([
      "ravi on PATH (/home/tester/.bun/bin/ravi) is a bun global install at 3.260918.1, not this checkout; " +
        "it was not updated. Fix: ravi update --next  (or: bun install -g ravi.bot@next)",
    ]);
  });

  it("lists every stale global install once and points at the matching channel", () => {
    const outcome = buildSourceUpdateOutcome({
      sourceRoot: "/srv/ravi",
      channel: "latest",
      pathCli: { path: "/usr/local/bin/ravi", packageRoot: "/opt/other-ravi", version: "3.260901.2" },
      globalInstalls: [
        { method: "npm", version: "3.260901.2", packageRoot: "/opt/homebrew/lib/node_modules/ravi.bot" },
        { method: "bun", version: null, packageRoot: null },
      ],
    });
    expect(outcome.cliUpdated).toBe(false);
    expect(outcome.staleInstalls.map((install) => install.method)).toEqual(["npm", "bun"]);
    expect(outcome.warnings).toEqual([
      "ravi on PATH (/usr/local/bin/ravi) is a separate install (/opt/other-ravi) at 3.260901.2, not this checkout; " +
        "it was not updated. Fix: ravi update --stable",
      "npm global install at 3.260901.2 (/opt/homebrew/lib/node_modules/ravi.bot) was not updated. " +
        "Fix: npm install -g ravi.bot@latest",
      "bun global install was not updated. Fix: bun install -g ravi.bot@latest",
    ]);

    expect(
      buildSourceUpdateOutcome({ sourceRoot: "/srv/ravi", channel: "next", pathCli: null, globalInstalls: [] }),
    ).toEqual({ cliUpdated: false, pathCli: null, staleInstalls: [], warnings: [] });
  });

  // Runs the real CLI against a git fixture: this is the scenario from the bug
  // report, where only the checkout moves and `ravi` on PATH stays behind.
  it("does not claim the CLI was updated when only the source checkout changed", () => {
    const scenario = createSourceUpdateScenario();
    try {
      const result = scenario.run();

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("Ravi CLI updated");
      expect(result.stdout).toContain(`Install: source (${scenario.checkout})`);
      expect(result.stdout).toContain(
        `✓ Source checkout updated from dev: Ravi ${OLD_VERSION} → ${NEW_VERSION} (${scenario.checkout})`,
      );
      expect(result.stderr).toContain("Not updated by this run:");
      expect(result.stderr).toContain(
        `ravi on PATH (${scenario.pathRavi}) is a bun global install at ${OLD_VERSION}, not this checkout; ` +
          "it was not updated. Fix: ravi update --next  (or: bun install -g ravi.bot@next)",
      );
      expect(result.stdout).toContain("No managed Ravi processes in PM2; nothing to rebind.");
      expect(readFileSync(join(scenario.globalRoot, "package.json"), "utf8")).toContain(OLD_VERSION);
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("reports the checkout, PATH CLI, stale installs, and runtime in the JSON result", () => {
    const scenario = createSourceUpdateScenario();
    try {
      const result = scenario.run("--json");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        success: true,
        package: "ravi.bot",
        requested: "next",
        channel: "next",
        previousVersion: OLD_VERSION,
        currentVersion: NEW_VERSION,
        installMethod: "source",
        restarted: false,
        integrityVerified: false,
        updated: { kind: "source", sourceRoot: scenario.checkout, branch: "dev" },
        cliUpdated: false,
        pathCli: { path: scenario.pathRavi, packageRoot: scenario.globalRoot, version: OLD_VERSION, updated: false },
        staleInstalls: [{ method: "bun", version: OLD_VERSION, packageRoot: scenario.globalRoot }],
        runtime: { managed: false, rebound: false, bundlePath: null, cwd: null, version: null },
        warnings: [
          `ravi on PATH (${scenario.pathRavi}) is a bun global install at ${OLD_VERSION}, not this checkout; ` +
            "it was not updated. Fix: ravi update --next  (or: bun install -g ravi.bot@next)",
        ],
      });
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("confirms the PATH CLI when it is linked into the updated checkout", () => {
    const scenario = createSourceUpdateScenario({ linkPathToCheckout: true });
    try {
      const result = scenario.run("--json");

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        cliUpdated: true,
        pathCli: { path: scenario.pathRavi, packageRoot: scenario.checkout, version: NEW_VERSION, updated: true },
        staleInstalls: [{ method: "bun", version: OLD_VERSION, packageRoot: scenario.globalRoot }],
        warnings: [
          `bun global install at ${OLD_VERSION} (${scenario.globalRoot}) was not updated. Fix: bun install -g ravi.bot@next`,
        ],
      });
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("finds the package root from this test file", () => {
    const root = findPackageRoot(import.meta.path);
    expect(root).toBeTruthy();
    const pkg = JSON.parse(readFileSync(join(root!, "package.json"), "utf8")) as { name?: string };
    expect(pkg.name).toBe("ravi.bot");
  });

  it("resolves the explicitly updated package before the currently executing bundle", () => {
    const runtime = createRuntimePackage();
    try {
      expect(resolveUpdatedManagedRuntimeTarget(runtime.root)).toEqual(runtime.target);
    } finally {
      runtime.cleanup();
    }
  });

  it("recreates managed processes from the updated bundle and saves PM2", () => {
    const target = { bundlePath: "/new/dist/bundle/index.js", cwd: "/new", version: "3.2.0" };
    const plan = buildManagedRuntimeRebindPlan(
      [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
      ],
      target,
      "/usr/bin/bun",
    );

    expect(
      plan.map(({ action, ...step }) => ({
        action,
        ...("processName" in step ? { processName: step.processName } : {}),
      })),
    ).toEqual([
      { action: "delete", processName: "ravi-channels" },
      { action: "delete", processName: "ravi" },
      { action: "start", processName: "ravi" },
      { action: "start", processName: "ravi-channels" },
      { action: "save" },
    ]);
    expect(plan[2]).toMatchObject({ cwd: target.cwd });
    expect(plan[2]?.args.slice(0, 2)).toEqual(["start", target.bundlePath]);
    expect(plan[3]).toMatchObject({ cwd: target.cwd });
    expect(plan[3]?.args.slice(0, 2)).toEqual(["start", "/usr/bin/bun"]);
  });

  it("removes stopped stale entries without starting them", () => {
    const plan = buildManagedRuntimeRebindPlan(
      [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 },
      ],
      { bundlePath: "/new/dist/bundle/index.js", cwd: "/new", version: "3.2.0" },
      "/usr/bin/bun",
    );
    expect(plan.filter((step) => step.action === "start").map((step) => step.processName)).toEqual(["ravi"]);
    expect(plan.map((step) => step.action)).toEqual(["delete", "delete", "start", "save"]);
    expect(buildManagedRuntimeRebindPlan([], { bundlePath: "/new", cwd: "/new", version: "3.2.0" })).toEqual([]);
  });

  it("launches the supervisor from the updated bundle with a sanitized request", () => {
    const runtime = createRuntimePackage();
    try {
      const invocation = buildManagedRuntimeRebindSupervisorInvocation(
        runtime.target,
        [pm2Process("ravi", "/old/index.js", "/old", { pid: 10, createdAt: 1 })],
        { ...process.env, RAVI_CONTEXT_KEY: "secret", RAVI_REPO: "/old" },
      );
      expect(invocation).toMatchObject({
        command: process.execPath,
        args: [runtime.bundlePath],
        cwd: runtime.root,
      });
      expect(invocation.env).not.toHaveProperty("RAVI_CONTEXT_KEY");
      expect(invocation.env.RAVI_BUNDLE).toBe(runtime.bundlePath);
      const request = decodeManagedRuntimeRebindRequest(invocation.env[MANAGED_RUNTIME_REBIND_ENV]!);
      expect(request).toEqual({
        schemaVersion: 1,
        target: runtime.target,
        previousProcesses: [{ name: "ravi", status: "online", pid: 10, createdAt: 1 }],
      });
    } finally {
      runtime.cleanup();
    }
  });

  it("deletes, recreates, verifies, and persists the managed runtime", async () => {
    const runtime = createRuntimePackage();
    try {
      const old = createRuntimePackage("3.260730.3");
      try {
        let processes: Pm2Process[] = [
          pm2Process("ravi", old.bundlePath, old.root, { pid: 10, createdAt: 1 }),
          pm2Process("ravi-channels", old.bundlePath, old.root, { pid: 20, createdAt: 1 }),
        ];
        const calls: string[] = [];
        const ok = await rebindManagedRuntimeProcesses(
          processes.map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null })),
          runtime.target,
          {
            bunPath: "/usr/bin/bun",
            runnerEnv: () => ({ RAVI_CHANNELS_CONSUME_OUTBOUND: "1" }),
            getProcesses: () => processes,
            run: async (_command, args, options) => {
              calls.push(args.join(" "));
              if (args[0] === "delete") {
                processes = processes.filter((process) => process.name !== args[1]);
              } else if (args[0] === "start") {
                const name = args[args.indexOf("--name") + 1] as "ravi" | "ravi-channels";
                processes.push(
                  pm2Process(name, runtime.bundlePath, runtime.root, {
                    pid: name === "ravi" ? 11 : 21,
                    createdAt: 2,
                  }),
                );
                if (name === "ravi-channels") {
                  expect(options?.env?.RAVI_CHANNELS_CONSUME_OUTBOUND).toBe("1");
                }
              }
              return { success: true, output: "" };
            },
          },
        );

        expect(ok).toBe(true);
        expect(calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
          "delete ravi-channels",
          "delete ravi",
          `start ${runtime.bundlePath}`,
          "start /usr/bin/bun",
          "save --force",
        ]);
      } finally {
        old.cleanup();
      }
    } finally {
      runtime.cleanup();
    }
  });
});
