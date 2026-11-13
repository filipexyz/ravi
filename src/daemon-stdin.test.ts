import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { which } from "bun";
import { Database } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
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
import { basename, join } from "node:path";
import { buildPm2Env, clearedPm2ContextEnv, parsePm2Processes } from "./pm2.js";
import {
  buildChannelsPm2Env,
  buildChannelsPm2StartArgs,
  buildDaemonPm2StartArgs,
  isDaemonRunArgv,
  maybeNeuterDaemonStdin,
  PM2_INERT_STDIN_SHELL_COMMAND,
} from "./daemon-stdin.js";

const BUN_FILE_READER_CHUNK = 256 * 1024;
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "ravi-bun-state-'quoted\" path-"));
  process.env.RAVI_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

function collectChildOutput(child: ChildProcess): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (!stdoutStream || !stderrStream) {
    return Promise.reject(new Error("child stdio missing"));
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function stdinProbeScript(mode: "neuter" | "maybe" | "raw"): string {
  const moduleUrl = new URL("./daemon-stdin.ts", import.meta.url).href;
  return `
      import { readSync, readlinkSync } from "node:fs";
      import { maybeNeuterDaemonStdin, neuterDaemonStdin } from ${JSON.stringify(moduleUrl)};
      const mode = ${JSON.stringify(mode)};
      const result = mode === "raw"
        ? { replaced: false, reason: "raw" }
        : mode === "maybe"
          ? maybeNeuterDaemonStdin()
          : neuterDaemonStdin();
      const started = Date.now();
      const buf = Buffer.alloc(${BUN_FILE_READER_CHUNK});
      const bytesRead = readSync(0, buf);
      let fd0 = null;
      try { fd0 = readlinkSync("/proc/self/fd/0"); } catch {}
      process.stdout.write(JSON.stringify({
        result,
        bytesRead,
        elapsedMs: Date.now() - started,
        fd0,
      }));
    `;
}

async function runStdinProbe(input: {
  mode: "neuter" | "maybe" | "raw";
  stdin: "pipe" | "socketpair";
  extraArgs?: string[];
  timeoutMs?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}> {
  const script = stdinProbeScript(input.mode);
  const extraArgs = input.extraArgs ?? [];
  const child =
    input.stdin === "pipe"
      ? spawn(process.execPath, ["--eval", script, ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(
          "python3",
          [
            "-c",
            [
              "import socket, subprocess, sys",
              "bun, script, *extra = sys.argv[1], sys.argv[2], *sys.argv[3:]",
              "reader, writer = socket.socketpair()",
              "proc = subprocess.Popen([bun, '--eval', script, *extra], stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
              "reader.close()",
              "try:",
              "    out, err = proc.communicate(timeout=2.5)",
              "except subprocess.TimeoutExpired:",
              "    proc.kill()",
              "    sys.exit(99)",
              "sys.stdout.buffer.write(out or b'')",
              "sys.stderr.buffer.write(err or b'')",
              "sys.exit(proc.returncode or 0)",
            ].join("\n"),
            process.execPath,
            script,
            ...extraArgs,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );

  const completed = collectChildOutput(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, input.timeoutMs ?? 2500);

  try {
    const result = await completed;
    return { ...result, timedOut };
  } finally {
    clearTimeout(timeout);
    child.stdin?.destroy();
  }
}

async function runShellAgainstIdleSocketpair(): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}> {
  const script = stdinProbeScript("raw");
  const child = spawn(
    "python3",
    [
      "-c",
      [
        "import socket, subprocess, sys",
        "command, script = sys.argv[1], sys.argv[2]",
        "reader, writer = socket.socketpair()",
        "proc = subprocess.Popen(['/bin/sh', '-c', command, '--eval', script], stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
        "reader.close()",
        "try:",
        "    out, err = proc.communicate(timeout=2.5)",
        "except subprocess.TimeoutExpired:",
        "    proc.kill()",
        "    sys.exit(99)",
        "sys.stdout.buffer.write(out or b'')",
        "sys.stderr.buffer.write(err or b'')",
        "sys.exit(proc.returncode or 0)",
      ].join("\n"),
      PM2_INERT_STDIN_SHELL_COMMAND,
      script,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: buildPm2Env() },
  );

  const completed = collectChildOutput(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 2500);

  try {
    return { ...(await completed), timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

describe("daemon stdin argv gating", () => {
  it("matches only the daemon run invocation", () => {
    expect(isDaemonRunArgv(["bun", "dist/bundle/index.js", "daemon", "run"])).toBe(true);
    expect(isDaemonRunArgv(["bun", "src/cli/index.ts", "daemon", "run", "--json"])).toBe(true);
    expect(isDaemonRunArgv(["bun", "src/cli/index.ts", "daemon", "status"])).toBe(false);
    expect(isDaemonRunArgv(["bun", "src/cli/index.ts", "daemon", "dev"])).toBe(false);
    expect(isDaemonRunArgv(["bun", "src/cli/index.ts", "contacts", "list"])).toBe(false);
  });

  it("does not replace stdin for non-daemon argv in this process", () => {
    expect(maybeNeuterDaemonStdin(["bun", "contacts", "list"])).toEqual({
      replaced: false,
      reason: "not-daemon-run",
    });
  });
});

describe("daemon stdin neuter", () => {
  it.each([
    ["idle open pipe", "pipe"],
    ["idle socketpair", "socketpair"],
  ] as const)("makes a 256KiB read(0) return immediately on an %s", async (_label, stdin) => {
    const probe = await runStdinProbe({ mode: "neuter", stdin });
    expect(probe.timedOut).toBe(false);
    expect(probe.code).toBe(0);
    expect(probe.stderr).toBe("");
    const parsed = JSON.parse(probe.stdout) as {
      result: { replaced: boolean; path?: string };
      bytesRead: number;
      elapsedMs: number;
      fd0: string | null;
    };
    expect(parsed.result.replaced).toBe(true);
    expect(parsed.result.path).toBe("/dev/null");
    expect(parsed.bytesRead).toBe(0);
    expect(parsed.elapsedMs).toBeLessThan(1000);
    if (process.platform === "linux") {
      expect(parsed.fd0).toBe("/dev/null");
    }
  });

  it("auto-neuters when the child argv is daemon run", async () => {
    const probe = await runStdinProbe({ mode: "maybe", stdin: "socketpair", extraArgs: ["daemon", "run"] });
    expect(probe.timedOut).toBe(false);
    expect(probe.code).toBe(0);
    const parsed = JSON.parse(probe.stdout) as {
      result: { replaced: boolean };
      bytesRead: number;
      elapsedMs: number;
      fd0: string | null;
    };
    expect(parsed.result.replaced).toBe(true);
    expect(parsed.bytesRead).toBe(0);
    expect(parsed.elapsedMs).toBeLessThan(1000);
    if (process.platform === "linux") {
      expect(parsed.fd0).toBe("/dev/null");
    }
  });

  it("leaves an idle socketpair hanging without the helper", async () => {
    const probe = await runStdinProbe({ mode: "raw", stdin: "socketpair", timeoutMs: 1500 });
    expect(probe.timedOut || probe.code === 99).toBe(true);
  });
});

describe("daemon PM2 inert-stdin launch", () => {
  it("uses a fixed shell command independently of package/state paths", () => {
    const args = buildDaemonPm2StartArgs({ bundlePath: "/opt/.bun/ravi 'package\"/dist/bundle/index.js" });
    expect(args).toEqual([
      "start",
      "dist/bundle/index.js",
      "--cwd",
      "/opt/.bun/ravi 'package\"",
      "--name",
      "ravi",
      "--interpreter",
      "/bin/sh",
      "--interpreter-args",
      `-c '${PM2_INERT_STDIN_SHELL_COMMAND}'`,
      "--",
      "daemon",
      "run",
    ]);
    expect(PM2_INERT_STDIN_SHELL_COMMAND).not.toContain(stateDir);
  });

  it("rejects a local Bun-name collision and unsupported canonical binary names before PM2 starts", () => {
    const bundlePath = join(stateDir, "dist", "bundle", "index.js");
    writeFileSync(join(stateDir, basename(process.execPath)), "conflicting package file");
    expect(() => buildChannelsPm2StartArgs({ bundlePath })).toThrow("shadows the selected Bun executable");
    for (const filename of ["unsupported bun", "all"]) {
      const unsupported = join(stateDir, filename);
      writeFileSync(unsupported, "fixture");
      expect(() => buildChannelsPm2StartArgs({ bundlePath, bunPath: unsupported })).toThrow(
        "unsupported Bun executable filename",
      );
    }
  });

  it("makes Bun fd 0 /dev/null when launched through the shell on an idle socketpair", async () => {
    const probe = await runShellAgainstIdleSocketpair();
    expect(probe.timedOut).toBe(false);
    expect(probe.code).toBe(0);
    expect(probe.stderr).toBe("");
    const parsed = JSON.parse(probe.stdout) as {
      bytesRead: number;
      elapsedMs: number;
      fd0: string | null;
    };
    expect(parsed.bytesRead).toBe(0);
    expect(parsed.elapsedMs).toBeLessThan(1000);
    if (process.platform === "linux") expect(parsed.fd0).toBe("/dev/null");
  });
});

describe("daemon CLI boot wiring", () => {
  it("imports the stdin neuter module before any other local module", () => {
    const source = readFileSync(new URL("./cli/index.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .+;$/gm)].map((match) => match[0]);
    expect(imports[0]).toBe('import "../daemon-stdin.js";');
  });
});

const isolatedPm2Executable = which("pm2");
if (process.env.RAVI_REQUIRE_PM2_TEST === "1" && !isolatedPm2Executable) {
  throw new Error(
    "RAVI_REQUIRE_PM2_TEST requires PM2 on PATH; install the pinned CI version before running this suite",
  );
}

it.skipIf(!isolatedPm2Executable)(
  "preserves daemon and channels identity without context through real PM2 package replacement",
  async () => {
    const pm2 = isolatedPm2Executable!;
    const packageRoot = join(stateDir, ".bun", "install", "ravi 'package\" with spaces");
    const bundlePath = join(packageRoot, "dist", "bundle", "index.js");
    const fixtureHome = join(stateDir, "account");
    const fixtureDatabase = join(fixtureHome, ".ravi", "ravi.db");
    mkdirSync(join(fixtureHome, ".ravi"), { recursive: true });
    const seed = new Database(fixtureDatabase);
    seed.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('existing-installation')");
    seed.close();
    const output = (role: string) => join(stateDir, `${role}.json`);
    const contextKeys = Object.keys(clearedPm2ContextEnv());
    const bunDir = join(stateDir, "ravi 'bun\" executable");
    mkdirSync(bunDir);
    const executable = join(bunDir, basename(process.execPath));
    copyFileSync(process.execPath, executable);
    const bunPath = join(stateDir, "ravi 'bun\" alias");
    symlinkSync(executable, bunPath);
    const pm2Home = mkdtempSync("/tmp/ravi-pm2-");
    const env = {
      PATH: process.env.PATH,
      PM2_HOME: pm2Home,
      PM2_SILENT: "true",
      NO_COLOR: "1",
    };
    const pm2Command = (args: string[], overrides: Record<string, string> = {}) =>
      spawnSync(pm2, args, { env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000 });
    const writePackage = () => {
      mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "ravi.bot", type: "module" }));
      copyFileSync(
        new URL("./db/state-boundary.ts", import.meta.url),
        join(packageRoot, "dist", "bundle", "state-boundary.ts"),
      );
      copyFileSync(new URL("./pm2-output.ts", import.meta.url), join(packageRoot, "dist", "pm2-output.ts"));
      writeFileSync(
        bundlePath,
        `import { readSync, writeFileSync } from "node:fs";
         import { openStateDatabase } from "./state-boundary.ts";
         const db = openStateDatabase(${JSON.stringify(fixtureDatabase)}, undefined, { homeDir: ${JSON.stringify(fixtureHome)} });
         const sentinel = db.query("SELECT value FROM sentinel").get();
         db.close();
         writeFileSync(${JSON.stringify(stateDir)} + "/" + process.argv[2] + ".json", JSON.stringify({
           pid: process.pid, ppid: process.ppid, argv: process.argv, cwd: process.cwd(),
           sentinel,
           stdinBytes: readSync(0, Buffer.alloc(1)),
           contextKeys: ${JSON.stringify(contextKeys)}.filter(key => Object.hasOwn(process.env, key)),
         }));
         setInterval(() => {}, 1000);`,
      );
    };
    const waitForProcess = async (role: "daemon" | "channels", previousPid?: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(output(role))) {
          const processInfo = JSON.parse(readFileSync(output(role), "utf8"));
          if (processInfo.pid !== previousPid) return processInfo;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const errorLog = join(pm2Home, "logs", "ravi-error.log");
      const registration = JSON.parse(pm2Command(["jlist"]).stdout).map((p: { pm2_env: Record<string, unknown> }) => ({
        script: p.pm2_env.pm_exec_path,
        interpreter: p.pm2_env.exec_interpreter,
        nodeArgs: p.pm2_env.node_args,
        args: p.pm2_env.args,
      }));
      throw new Error(
        `Isolated PM2 fixture did not start: ${JSON.stringify(registration)} ${existsSync(errorLog) ? readFileSync(errorLog, "utf8").slice(-300) : "no error log"}`,
      );
    };
    try {
      writePackage();
      expect(
        pm2Command(["ping"], Object.fromEntries(contextKeys.map((key) => [key, "stale-manager-context"]))).status,
      ).toBe(0);
      const managerPid = Number(readFileSync(join(pm2Home, "pm2.pid"), "utf8"));
      // Existing hosts can have a live PM2 with no default manager PID file.
      // Keep the actual manager and its registry; only remove fixture metadata.
      rmSync(join(pm2Home, "pm2.pid"));
      const args = buildDaemonPm2StartArgs({ bundlePath });
      const serviceEnv = { ...clearedPm2ContextEnv(), RAVI_PM2_EXECUTABLE: bunPath };
      const started = pm2Command(args, serviceEnv);
      expect(started.status).toBe(0);
      const first = await waitForProcess("daemon");
      expect(first).toMatchObject({
        argv: [realpathSync(executable), realpathSync(bundlePath), "daemon", "run"],
        stdinBytes: 0,
        cwd: realpathSync(packageRoot),
        contextKeys: [],
        sentinel: { value: "existing-installation" },
      });
      expect(first.ppid).toBe(managerPid);
      const [registration] = JSON.parse(pm2Command(["jlist"]).stdout);
      expect(registration).toMatchObject({
        name: "ravi",
        pid: first.pid,
        pm2_env: {
          pm_exec_path: bundlePath,
          pm_cwd: packageRoot,
          exec_interpreter: "/bin/sh",
          args: ["daemon", "run"],
        },
      });

      for (const key of contextKeys) expect(registration.pm2_env[key]).toBe("");
      const channelArgs = buildChannelsPm2StartArgs({ bundlePath, bunPath });
      expect(pm2Command(channelArgs, { ...serviceEnv, ...buildChannelsPm2Env(bunPath) }).status).toBe(0);
      const firstChannels = await waitForProcess("channels");
      expect(firstChannels).toMatchObject({
        argv: [realpathSync(executable), realpathSync(bundlePath), "channels", "run"],
        stdinBytes: 0,
        cwd: realpathSync(packageRoot),
        contextKeys: [],
      });
      const channelRegistration = JSON.parse(pm2Command(["jlist"]).stdout).find(
        (p: { name: string }) => p.name === "ravi-channels",
      );
      expect(channelRegistration).toMatchObject({
        pid: firstChannels.pid,
        pm2_env: {
          pm_exec_path: realpathSync(executable),
          pm_cwd: packageRoot,
          exec_interpreter: "/bin/sh",
          args: [bundlePath, "channels", "run"],
        },
      });
      for (const key of contextKeys) expect(channelRegistration.pm2_env[key]).toBe("");

      for (const collision of ["name", "namespace"] as const) {
        const name = collision === "name" ? basename(executable) : "unrelated-sleeper";
        const namespace = collision === "namespace" ? basename(executable) : "default";
        expect(
          pm2Command([
            "start",
            "/bin/sleep",
            "--name",
            name,
            "--namespace",
            namespace,
            "--interpreter",
            "none",
            "--",
            "120",
          ]).status,
        ).toBe(0);
        const snapshot = parsePm2Processes(pm2Command(["jlist"]).stdout);
        const sleeper = snapshot.find((process) => process.name === name)!;
        expect(sleeper.pid).toBeGreaterThan(0);
        expect(() => buildChannelsPm2StartArgs({ bundlePath, bunPath, processes: snapshot })).toThrow(
          "conflicts with an existing PM2 process or namespace",
        );
        expect(parsePm2Processes(pm2Command(["jlist"]).stdout).map((process) => process.pid)).toEqual(
          snapshot.map((process) => process.pid),
        );
        expect(pm2Command(["delete", String(sleeper.pm_id)]).status).toBe(0);
      }

      rmSync(packageRoot, { recursive: true, force: true });
      writePackage();
      expect(pm2Command(["restart", "ravi"]).status).toBe(0);
      const second = await waitForProcess("daemon", first.pid);
      expect(second.argv).toEqual(first.argv);
      expect(second.sentinel).toEqual({ value: "existing-installation" });
      expect(second.stdinBytes).toBe(0);
      expect(second.contextKeys).toEqual([]);
      expect(pm2Command(["restart", "ravi-channels"]).status).toBe(0);
      const secondChannels = await waitForProcess("channels", firstChannels.pid);
      expect(secondChannels.argv).toEqual(firstChannels.argv);
      expect(secondChannels.sentinel).toEqual({ value: "existing-installation" });
      expect(secondChannels.stdinBytes).toBe(0);
      expect(secondChannels.contextKeys).toEqual([]);
      const forcedArgs = [...args];
      forcedArgs.splice(1, 0, "--force");
      expect(pm2Command(forcedArgs, serviceEnv).status).toBe(0);
      const standby = await waitForProcess("daemon", second.pid);
      expect(standby.argv).toEqual(second.argv);
      expect(standby.stdinBytes).toBe(0);
      expect(standby.contextKeys).toEqual([]);
      const registrations = JSON.parse(pm2Command(["jlist"]).stdout).filter((p: { name: string }) => p.name === "ravi");
      expect(registrations).toHaveLength(2);
      expect(registrations.map((p: { pid: number }) => p.pid).sort()).toEqual([second.pid, standby.pid].sort());
      expect(
        registrations.every(
          (p: { name: string; pm2_env: { status: string; pm_exec_path: string; args: string[] } }) =>
            p.name === "ravi" &&
            p.pm2_env.status === "online" &&
            p.pm2_env.pm_exec_path === bundlePath &&
            JSON.stringify(p.pm2_env.args) === JSON.stringify(["daemon", "run"]),
        ),
      ).toBe(true);
      expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
      expect(existsSync(join(pm2Home, "pm2.pid"))).toBe(false);
    } finally {
      pm2Command(["kill"]);
      rmSync(pm2Home, { recursive: true, force: true });
    }
  },
  45_000,
);
