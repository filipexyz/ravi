import { describe, expect, it } from "bun:test";
import { serve } from "bun";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { buildChannelsPm2StartArgs, buildDaemonPm2StartArgs } from "../../daemon-stdin.js";
import { resolveManagedRuntimeTargetFromPackageRoot } from "../../managed-runtime.js";
import {
  buildManagedRuntimeRebindPlan,
  buildManagedRuntimeRebindSupervisorInvocation,
  decodeManagedRuntimeRebindRequest,
  rebindManagedRuntimeProcesses,
} from "../../managed-runtime-rebind.js";
import type { Pm2Process } from "../../pm2.js";
import { observeRuntimeBoot, writeRuntimeBootReceipt } from "../../runtime-process-identity.js";
import { getRaviStateDir } from "../../utils/paths.js";
import {
  buildSourceUpdateOutcome,
  describePathCli,
  detectFromBinaryPath,
  findPackageRoot,
  nativeChannelRunnerUpdateWarning,
  readNativeChannelRunnerUpdateWarning,
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
function createSourceUpdateScenario(
  options: {
    linkPathToCheckout?: boolean;
    managedProcesses?: boolean;
    supervisor?: "rebind" | "noop";
    failRunnerStart?: boolean;
    failPm2Status?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-update-scenario-")));
  const seed = join(root, "seed");
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const globalRoot = join(root, "global", "node_modules", "ravi.bot");
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  const pm2Calls = join(root, "pm2-calls");
  const pm2Snapshot = join(root, "pm2.json");
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
        scripts: { build: "mkdir -p dist/bundle && cp supervisor.js dist/bundle/index.js" },
      },
      null,
      2,
    );
  writeFileSync(join(seed, "package.json"), packageJson(OLD_VERSION), "utf8");
  writeFileSync(
    join(seed, "supervisor.js"),
    options.supervisor === "noop"
      ? "// Deliberately exits zero without implementing the rebind protocol.\n"
      : `import { decodeManagedRuntimeRebindRequest, rebindManagedRuntimeProcesses } from ${JSON.stringify(join(process.cwd(), "src/managed-runtime-rebind.ts"))};\nconst request = decodeManagedRuntimeRebindRequest(process.env.RAVI_INTERNAL_UPDATE_RUNTIME_REBIND);\ndelete process.env.RAVI_INTERNAL_UPDATE_RUNTIME_REBIND;\nif (!(await rebindManagedRuntimeProcesses(request.previousProcesses, request.target, { pidAlive: () => true }))) throw new Error("Fixture reconciliation failed");\n`,
  );
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
  writeFileSync(
    pm2Snapshot,
    JSON.stringify(
      options.managedProcesses
        ? ["ravi", "ravi-channels"].map((name, index) => ({
            name,
            pm_id: index,
            pid: 700_001 + index,
            pm2_env: {
              status: "online",
              pm_exec_path: name === "ravi" ? join(checkout, "dist", "bundle", "index.js") : process.execPath,
              pm_cwd: checkout,
              args:
                name === "ravi" ? ["daemon", "run"] : [join(checkout, "dist", "bundle", "index.js"), "channels", "run"],
              created_at: 1,
              pm_uptime: 1,
              RAVI_STATE_DIR: stateDir,
            },
          }))
        : [],
    ),
  );
  writeExecutable(
    join(bin, "pm2"),
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { observeRuntimeBoot, writeRuntimeBootReceipt } from ${JSON.stringify(join(process.cwd(), "src/runtime-process-identity.ts"))};
const args = process.argv.slice(2);
const snapshotPath = ${JSON.stringify(pm2Snapshot)};
appendFileSync(${JSON.stringify(pm2Calls)}, args.join(" ") + "\\n");
let entries = JSON.parse(readFileSync(snapshotPath, "utf8"));
if (args[0] === "jlist") {
  if (${Boolean(options.failPm2Status)}) process.exit(1);
  console.log(JSON.stringify(entries)); process.exit(0);
}
if (args[0] === "delete") entries = entries.filter(entry => String(entry.pm_id) !== args[1]);
else if (args[0] === "start") {
  const name = args[args.indexOf("--name") + 1];
  if (${Boolean(options.failRunnerStart)} && name === "ravi-channels") process.exit(1);
  const bundlePath = name === "ravi" ? resolve(args[args.indexOf("--cwd") + 1], args[1]) : args[args.indexOf("--") + 1];
  const startedAt = Date.now();
  const pid = name === "ravi" ? 800001 : 800002;
  const envFile = join(process.env.RAVI_STATE_DIR, ".env");
  const runningVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
  writeRuntimeBootReceipt({ ...observeRuntimeBoot({ bundlePath, runningVersion, envFile }), schemaVersion: 1, name, pid, startedAt });
  if (name === "ravi") writeFileSync(join(process.env.RAVI_STATE_DIR, "runtime-processes", "schema-owner-" + pid + ".json"), JSON.stringify({protocol:1,pid,phase:"ready",observedAt:startedAt}));
  entries.push({ name, pm_id: name === "ravi" ? 0 : 1, pid, pm2_env: {
    status: "online", pm_exec_path: name === "ravi" ? bundlePath : process.env.RAVI_PM2_EXECUTABLE, pm_cwd: process.cwd(),
    args: args.slice(args.indexOf("--") + 1), pm_uptime: startedAt, created_at: startedAt,
  } });
} else if (args[0] !== "save") process.exit(1);
writeFileSync(snapshotPath, JSON.stringify(entries));
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    RAVI_REPO: checkout,
    PM2_HOME: join(root, "pm2-home"),
    RAVI_STATE_DIR: stateDir,
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
  };
  for (const key of ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_BUNDLE", "RAVI_DAEMON_CWD"]) delete env[key];

  return {
    checkout,
    globalRoot,
    pathRavi: join(bin, "ravi"),
    pm2Calls,
    pm2Snapshot,
    run(...args: string[]) {
      return spawnSync("bun", ["src/cli/index.ts", "update", "--next", ...args], {
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

      expect(result.status, result.stdout + result.stderr).toBe(0);
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

  it("restarts and verifies both live siblings by default", () => {
    const scenario = createSourceUpdateScenario({ linkPathToCheckout: true, managedProcesses: true });
    try {
      const result = scenario.run("--json");
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        currentVersion: NEW_VERSION,
        restarted: true,
        runtime: { managed: true, rebound: true, version: NEW_VERSION },
      });
      const calls = readFileSync(scenario.pm2Calls, "utf8").trim().split("\n");
      expect(calls.filter((call) => !call.startsWith("jlist")).map((call) => call.split(" ")[0])).toEqual([
        "delete",
        "delete",
        "start",
        "save",
        "start",
        "save",
      ]);
      expect(JSON.parse(readFileSync(scenario.pm2Snapshot, "utf8")).map((entry: { pid: number }) => entry.pid)).toEqual(
        [800_001, 800_002],
      );
      expect(
        payload.warnings.some((warning: string) => warning.includes("unverified") || warning.includes("stale code")),
      ).toBe(false);
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("fails when the supervisor exits zero without replacing the live siblings", () => {
    const scenario = createSourceUpdateScenario({
      linkPathToCheckout: true,
      managedProcesses: true,
      supervisor: "noop",
    });
    try {
      const result = scenario.run("--json");
      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ success: false, error: { code: "UPDATE_FAILED" } });
      expect(payload.error.message).toContain("ravi daemon restart");
      expect(payload.error.message).toContain("ravi channels restart");
      expect(payload.error.message).toContain("ravi-channels is running stale code");
      expect(
        readFileSync(scenario.pm2Calls, "utf8")
          .trim()
          .split("\n")
          .every((call) => call === "jlist"),
      ).toBe(true);
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("fails if restarting the runner fails after the daemon has restarted", () => {
    const scenario = createSourceUpdateScenario({
      linkPathToCheckout: true,
      managedProcesses: true,
      failRunnerStart: true,
    });
    try {
      const result = scenario.run("--json");
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ success: false, error: { code: "UPDATE_FAILED" } });
      expect(
        JSON.parse(readFileSync(scenario.pm2Snapshot, "utf8")).map((entry: { name: string }) => entry.name),
      ).toEqual(["ravi"]);
      expect(readFileSync(scenario.pm2Calls, "utf8")).toContain("save --force");
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("rejects the removed no-restart bypass", () => {
    const scenario = createSourceUpdateScenario({ managedProcesses: true });
    try {
      const result = scenario.run("--no-restart", "--json");
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("unknown option '--no-restart'");
    } finally {
      scenario.cleanup();
    }
  }, 60_000);

  it("refuses an unreadable PM2 snapshot before updating packages or restarting", () => {
    const scenario = createSourceUpdateScenario({ managedProcesses: true, failPm2Status: true });
    try {
      const result = scenario.run("--json");
      expect(result.status).toBe(1);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({ success: false, error: { code: "UPDATE_FAILED" } });
      expect(payload.error.message).toContain("Could not read PM2 runtime status");
      expect(payload.error.cause).toContain("Unable to read the managed PM2 processes");
      expect(payload.error.cause).toContain("pm2 jlist");
      expect(JSON.parse(readFileSync(join(scenario.checkout, "package.json"), "utf8")).version).toBe(OLD_VERSION);
      expect(readFileSync(scenario.pm2Calls, "utf8").trim().split("\n")).toEqual(["jlist"]);
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
      process.execPath,
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
    expect(plan[2]?.args).toEqual(buildDaemonPm2StartArgs({ bundlePath: target.bundlePath }));
    expect(plan[3]).toMatchObject({ cwd: target.cwd });
    expect(plan[3]?.args).toEqual(
      buildChannelsPm2StartArgs({ bundlePath: target.bundlePath, bunPath: process.execPath }),
    );
  });

  it.each(["name", "namespace"] as const)("rejects a PM2 Bun %s collision before runtime mutations", async (field) => {
    const runtime = createRuntimePackage();
    const services = [
      pm2Process("ravi", runtime.bundlePath, runtime.root, { pid: 10, createdAt: 1 }),
      pm2Process("ravi-channels", runtime.bundlePath, runtime.root, { pid: 20, createdAt: 1 }),
    ];
    const unrelated = { ...services[0]!, name: "unrelated", pm_id: 9, pid: 90, [field]: basename(process.execPath) };
    const mutations: string[][] = [];
    try {
      await expect(
        rebindManagedRuntimeProcesses(
          services.map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null })),
          runtime.target,
          {
            getProcesses: () => [...services, unrelated],
            runnerEnv: () => ({}),
            run: async (_command, args) => {
              mutations.push(args);
              return { success: true, output: "" };
            },
          },
        ),
      ).rejects.toThrow("conflicts with an existing PM2 process or namespace");
      expect(mutations).toEqual([]);
    } finally {
      runtime.cleanup();
    }
  });

  it("removes stopped stale entries without starting them", () => {
    const plan = buildManagedRuntimeRebindPlan(
      [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 },
      ],
      { bundlePath: "/new/dist/bundle/index.js", cwd: "/new", version: "3.2.0" },
      process.execPath,
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
      expect(invocation.env.RAVI_CONTEXT_KEY).toBe("");
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

  it("keeps the managed rebind fixture out of its caller's runtime receipts", () => {
    const callerState = mkdtempSync(join(tmpdir(), "ravi-update-caller-state-"));
    const receiptsDir = join(callerState, "runtime-processes");
    mkdirSync(receiptsDir);
    const receipts = ["ravi.json", "ravi-channels.json"];
    const original = receipts.map((name, index) => JSON.stringify({ name, pid: 1000 + index }));
    try {
      receipts.forEach((name, index) => {
        writeFileSync(join(receiptsDir, name), original[index]!);
      });
      const result = spawnSync(
        process.execPath,
        ["test", import.meta.path, "-t", "^.*deletes, recreates, verifies, and persists the managed runtime$"],
        { env: { ...process.env, RAVI_STATE_DIR: callerState }, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("1 pass");
      receipts.forEach((name, index) => {
        expect(readFileSync(join(receiptsDir, name), "utf8")).toBe(original[index]);
      });
      expect(readdirSync(receiptsDir).sort()).toEqual([...receipts].sort());
      expect(readdirSync(callerState)).toEqual(["runtime-processes"]);
    } finally {
      rmSync(callerState, { recursive: true, force: true });
    }
  });

  it("deletes, recreates, verifies, and persists the managed runtime", async () => {
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-update-rebind-state-"));
    process.env.RAVI_STATE_DIR = stateDir;
    try {
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
              bunPath: process.execPath,
              runnerEnv: () => ({ RAVI_CHANNELS_CONSUME_OUTBOUND: "1" }),
              pidAlive: () => true,
              schemaPhase: (process) => (process.pid === 11 ? "ready" : null),
              getProcesses: () => processes,
              run: async (_command, args, options) => {
                calls.push(args.join(" "));
                if (args[0] === "delete") {
                  processes = processes.filter((process) => String(process.pm_id) !== args[1]);
                } else if (args[0] === "start") {
                  const name = args[args.indexOf("--name") + 1] as "ravi" | "ravi-channels";
                  const startedAt = Date.now();
                  const pid = name === "ravi" ? 11 : 21;
                  processes.push(
                    pm2Process(name, runtime.bundlePath, runtime.root, {
                      pid,
                      createdAt: 2,
                      startedAt,
                    }),
                  );
                  writeRuntimeBootReceipt({
                    ...observeRuntimeBoot({
                      bundlePath: runtime.bundlePath,
                      runningVersion: runtime.target.version,
                      envFile: join(getRaviStateDir(), ".env"),
                    }),
                    schemaVersion: 1,
                    name,
                    pid,
                    startedAt,
                  });
                  if (name === "ravi-channels") {
                    expect(options?.env?.RAVI_CHANNELS_CONSUME_OUTBOUND).toBe("1");
                  }
                  expect(options?.env?.RAVI_PM2_EXECUTABLE).toBe(process.execPath);
                }
                return { success: true, output: "" };
              },
            },
          );

          expect(ok).toBe(true);
          expect(calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
            "delete 2",
            "delete 1",
            buildDaemonPm2StartArgs({ bundlePath: runtime.bundlePath }).slice(0, 2).join(" "),
            "save --force",
            buildChannelsPm2StartArgs({ bundlePath: runtime.bundlePath, bunPath: process.execPath })
              .slice(0, 2)
              .join(" "),
            "save --force",
          ]);
        } finally {
          old.cleanup();
        }
      } finally {
        runtime.cleanup();
      }
    } finally {
      if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
    expect(process.env.RAVI_STATE_DIR).toBe(previousStateDir);
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe("native channel runner update warning", () => {
  const slack = { name: "slack-a", provider: "slack", enabled: true, createdAt: 1, updatedAt: 1 };
  const runner = (status: string) =>
    ({ name: "ravi-channels", pm_id: 1, pid: 10, status, cpu: 0, memory: 0 }) as Pm2Process;

  it("warns when native channels are enabled and the runner was not online", () => {
    expect(nativeChannelRunnerUpdateWarning([], () => [slack])).toContain("ravi channels start");
    expect(nativeChannelRunnerUpdateWarning([runner("stopped")], () => [slack])).toContain(
      "1 native channel(s) are enabled but ravi-channels is not running",
    );
  });

  it("stays quiet when the runner was online, no native channel is enabled, or channels cannot be read", () => {
    expect(nativeChannelRunnerUpdateWarning([runner("online")], () => [slack])).toBeNull();
    expect(nativeChannelRunnerUpdateWarning([], () => [{ ...slack, enabled: false }])).toBeNull();
    expect(
      nativeChannelRunnerUpdateWarning([], () => {
        throw new Error("db unavailable");
      }),
    ).toBeNull();
  });
});

async function exerciseRebind(input: {
  legacy?: boolean;
  failStart?: boolean;
  unverifiedStandby?: boolean;
  neverReady?: boolean;
  failIntakeStop?: boolean;
  wrongVersion?: boolean;
  stoppedDaemon?: boolean;
  stoppedChannels?: boolean;
  replaceDaemon?: "afterSupervision" | "afterChannels" | "duringFinalSave";
  replacementReady?: boolean;
}) {
  const previousStateDir = process.env.RAVI_STATE_DIR;
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-rebind-order-"));
  process.env.RAVI_STATE_DIR = stateDir;
  const old = createRuntimePackage("3.1.0");
  const target = createRuntimePackage("3.2.0");
  let processes = [
    pm2Process("ravi", old.bundlePath, old.root, {
      pid: 10,
      createdAt: 1,
      startedAt: 1,
      status: input.stoppedDaemon ? "stopped" : "online",
    }),
    pm2Process("ravi-channels", old.bundlePath, old.root, {
      pid: 20,
      createdAt: 1,
      startedAt: 1,
      status: input.stoppedChannels ? "stopped" : "online",
    }),
  ];
  const events: string[] = [];
  let time = 0;
  let deletedAt: number | undefined;
  let nextPmId = 3;
  let pendingReplacement = false;
  let replaced = false;
  const replaceDaemon = () => {
    const current = processes.find((process) => process.name === "ravi")!;
    const startedAt = (current.startedAt ?? Date.now()) + 1;
    const replacement = { ...current, pid: current.pid + 1_000, startedAt };
    processes = processes.map((process) => (process === current ? replacement : process));
    writeRuntimeBootReceipt({
      ...observeRuntimeBoot({
        bundlePath: target.bundlePath,
        runningVersion: "3.2.0",
        envFile: join(stateDir, ".env"),
      }),
      schemaVersion: 1,
      name: "ravi",
      pid: replacement.pid,
      startedAt,
    });
    replaced = true;
    pendingReplacement = false;
    events.push("replace:ravi");
  };
  try {
    const ok = await rebindManagedRuntimeProcesses(
      processes.map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null })),
      target.target,
      {
        runnerEnv: () => ({}),
        getProcesses: () => {
          if (pendingReplacement) replaceDaemon();
          return processes;
        },
        pidAlive: (pid) => processes.some((process) => process.pid === pid),
        now: () => time,
        wait: async (ms) => {
          time += ms;
        },
        readyTimeoutMs: 1_000,
        schemaPhase: (process) => {
          if (process.pid === 10) return input.legacy ? null : "ready";
          if (process.pid > 1_000) return input.replacementReady ? "ready" : "owned";
          if (input.unverifiedStandby) return null;
          if (processes.some((entry) => entry.pid === 10)) return "waiting";
          if (input.neverReady || time - (deletedAt ?? 0) < 400) return "owned";
          events.push("ready");
          if (
            input.replaceDaemon === "afterSupervision" &&
            !replaced &&
            events.filter((event) => event === "save").length === 2
          )
            pendingReplacement = true;
          return "ready";
        },
        run: async (_command, args) => {
          if (args[0] === "delete") {
            const current = processes.find((process) => String(process.pm_id) === args[1]);
            events.push(`delete:${current?.name}:${current?.pid}`);
            if (current?.name === "ravi-channels" && input.failIntakeStop)
              return { success: false, output: "stop failed" };
            processes = processes.filter((process) => String(process.pm_id) !== args[1]);
            if (current?.pid === 10) deletedAt = time;
          } else if (args[0] === "start") {
            const name = args[args.indexOf("--name") + 1] as "ravi" | "ravi-channels";
            events.push(`start:${name}`);
            if (name === "ravi" && processes.some((process) => process.pid === 10)) {
              expect(args.indexOf("--force")).toBeGreaterThan(0);
              expect(args.indexOf("--force")).toBeLessThan(args.indexOf("--"));
            }
            if (name === "ravi" && input.failStart) return { success: false, output: "start failed" };
            if (name === "ravi-channels") {
              expect(events).toContain("ready");
              expect(processes.some((process) => process.pid === 10)).toBe(false);
              if (input.replaceDaemon === "afterChannels") pendingReplacement = true;
            }
            const pmId = nextPmId++;
            const pid = 100 + pmId;
            const startedAt = Date.now();
            processes.push(
              pm2Process(name, target.bundlePath, target.root, { pm_id: pmId, pid, startedAt, createdAt: startedAt }),
            );
            writeRuntimeBootReceipt({
              ...observeRuntimeBoot({
                bundlePath: target.bundlePath,
                runningVersion: input.wrongVersion ? "3.1.0" : "3.2.0",
                envFile: join(stateDir, ".env"),
              }),
              schemaVersion: 1,
              name,
              pid,
              startedAt,
            });
          } else if (args[0] === "save") {
            events.push("save");
            if (input.replaceDaemon === "duringFinalSave" && events.filter((event) => event === "save").length === 3)
              replaceDaemon();
          } else throw new Error(`Unexpected PM2 operation: ${args[0]}`);
          return { success: true, output: "" };
        },
      },
    );
    return { ok, events, processes };
  } finally {
    old.cleanup();
    target.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
    else process.env.RAVI_STATE_DIR = previousStateDir;
  }
}

describe("managed update cutover readiness", () => {
  it("preserves the running daemon and intake when the candidate fails to start", async () => {
    const result = await exerciseRebind({ failStart: true });
    expect(result.ok).toBe(false);
    expect(result.processes.map((process) => process.pid)).toEqual([10, 20]);
    expect(result.events).toEqual(["start:ravi"]);
  });

  it("rejects an online candidate with no valid phase before stopping either predecessor", async () => {
    const result = await exerciseRebind({ unverifiedStandby: true });
    expect(result.ok).toBe(false);
    expect(result.processes.map((process) => process.pid)).toEqual([10, 20]);
    expect(result.events).not.toContain("delete:ravi:10");
    expect(result.events).not.toContain("delete:ravi-channels:20");
  });

  it("stops intake at the schema barrier and waits for readiness before restarting channels", async () => {
    const result = await exerciseRebind({});
    expect(result.ok).toBe(true);
    expect(result.events.indexOf("start:ravi")).toBeLessThan(result.events.indexOf("delete:ravi-channels:20"));
    expect(result.events.indexOf("delete:ravi-channels:20")).toBeLessThan(result.events.indexOf("delete:ravi:10"));
    expect(result.events.indexOf("delete:ravi:10")).toBeLessThan(result.events.indexOf("ready"));
    expect(result.events.indexOf("ready")).toBeLessThan(result.events.indexOf("start:ravi-channels"));
  });

  it("keeps the predecessor when native intake cannot stop", async () => {
    const result = await exerciseRebind({ failIntakeStop: true });
    expect(result.ok).toBe(false);
    expect(result.processes.map((process) => process.pid)).toEqual([10, 20]);
    expect(result.events.at(-1)).toBe("save");
  });

  it("does not start channels when ownership never becomes ready", async () => {
    const result = await exerciseRebind({ neverReady: true });
    expect(result.ok).toBe(false);
    expect(result.events).not.toContain("start:ravi-channels");
  });

  it("requires the ready daemon to have the requested release identity", async () => {
    const result = await exerciseRebind({ wrongVersion: true });
    expect(result.ok).toBe(false);
    expect(result.events).not.toContain("start:ravi-channels");
  });

  it("stops legacy writers and consumers before starting the new schema owner", async () => {
    const result = await exerciseRebind({ legacy: true });
    expect(result.ok).toBe(true);
    expect(result.events.slice(0, 3)).toEqual(["delete:ravi-channels:20", "delete:ravi:10", "start:ravi"]);
  });

  it("keeps a previously stopped channel runner stopped after the daemon becomes ready", async () => {
    const result = await exerciseRebind({ stoppedChannels: true });
    expect(result.ok).toBe(true);
    expect(result.events).not.toContain("start:ravi-channels");
    expect(result.processes.map((process) => process.name)).toEqual(["ravi"]);
  });

  it("removes stopped sibling entries without starting either process", async () => {
    const result = await exerciseRebind({ stoppedDaemon: true, stoppedChannels: true });
    expect(result.ok).toBe(true);
    expect(result.processes).toEqual([]);
    expect(result.events).toEqual(["delete:ravi-channels:20", "delete:ravi:10", "save"]);
  });

  it.each([false, true])(
    "rejects a replacement after supervision even with a valid boot receipt (ready=%s)",
    async (replacementReady) => {
      const result = await exerciseRebind({ replaceDaemon: "afterSupervision", replacementReady });
      expect(result.ok).toBe(false);
      expect(result.events).toContain("replace:ravi");
      expect(result.events).not.toContain("start:ravi-channels");
    },
  );

  it.each(["afterChannels", "duringFinalSave"] as const)(
    "does not report success for a replacement %s",
    async (replaceDaemon) => {
      const result = await exerciseRebind({ replaceDaemon });
      expect(result.ok).toBe(false);
      expect(result.events).toContain("start:ravi-channels");
      expect(result.events).toContain("replace:ravi");
    },
  );
});

describe("native update warning gateway lookup", () => {
  it("reads enabled channels through the authenticated gateway across pages", async () => {
    const beforeGateway = process.env.RAVI_GATEWAY_URL;
    const beforeKey = process.env.RAVI_CONTEXT_KEY;
    const offsets: string[] = [];
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/v1/channels/list");
        expect(request.headers.get("authorization")).toBe("Bearer test-update-context");
        const body = (await request.json()) as { offset: string; fields: string };
        expect(body.fields).toBe("enabled");
        offsets.push(body.offset);
        return Response.json(
          body.offset === "0"
            ? { items: [{ enabled: false }], pagination: { nextOffset: 500 } }
            : { items: [{ enabled: true }], pagination: { nextOffset: null } },
        );
      },
    });
    process.env.RAVI_GATEWAY_URL = `http://127.0.0.1:${server.port}`;
    process.env.RAVI_CONTEXT_KEY = "test-update-context";
    try {
      expect(await readNativeChannelRunnerUpdateWarning([])).toContain("ravi channels start");
      expect(offsets).toEqual(["0", "500"]);
    } finally {
      server.stop(true);
      if (beforeGateway === undefined) delete process.env.RAVI_GATEWAY_URL;
      else process.env.RAVI_GATEWAY_URL = beforeGateway;
      if (beforeKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = beforeKey;
    }
  });
});
