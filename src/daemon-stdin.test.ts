import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { which } from "bun";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
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
import { join } from "node:path";
import { buildPm2Env, clearedPm2ContextEnv } from "./pm2.js";
import {
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
  "preserves exact daemon argv, inert stdin and standby ownership through real PM2 package replacement",
  async () => {
    const pm2 = isolatedPm2Executable!;
    const packageRoot = join(stateDir, ".bun", "install", "ravi 'package\" with spaces");
    const bundlePath = join(packageRoot, "dist", "bundle", "index.js");
    const output = join(stateDir, "process.json");
    const bunPath = join(stateDir, "ravi 'bun\" executable");
    symlinkSync(process.execPath, bunPath);
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
      writeFileSync(
        bundlePath,
        `import { readSync, writeFileSync } from "node:fs";
         writeFileSync(${JSON.stringify(output)}, JSON.stringify({
           pid: process.pid, ppid: process.ppid, argv: process.argv,
           stdinBytes: readSync(0, Buffer.alloc(1)),
           context: process.env.RAVI_CONTEXT_KEY,
           gateway: process.env.RAVI_GATEWAY_URL,
           gatewayInternal: process.env.RAVI_GATEWAY_INTERNAL,
           handoff: process.env.RAVI_DAEMON_RESTART_HANDOFF,
         }));
         setInterval(() => {}, 1000);`,
      );
    };
    const waitForProcess = async (previousPid?: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(output)) {
          const processInfo = JSON.parse(readFileSync(output, "utf8"));
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
        pm2Command(["ping"], {
          RAVI_CONTEXT_KEY: "stale-manager-context",
          RAVI_GATEWAY_URL: "unix:///stale-manager-gateway.sock",
          RAVI_GATEWAY_INTERNAL: "1",
          RAVI_DAEMON_RESTART_HANDOFF: "1",
        }).status,
      ).toBe(0);
      const args = buildDaemonPm2StartArgs({ bundlePath });
      const serviceEnv = { ...clearedPm2ContextEnv(), RAVI_PM2_EXECUTABLE: bunPath };
      const started = pm2Command(args, serviceEnv);
      expect(started.status).toBe(0);
      const first = await waitForProcess();
      expect(first).toMatchObject({
        argv: [process.execPath, realpathSync(bundlePath), "daemon", "run"],
        stdinBytes: 0,
        context: "",
        gateway: "",
        gatewayInternal: "",
        handoff: "",
      });
      expect(first.ppid).toBe(Number(readFileSync(join(pm2Home, "pm2.pid"), "utf8")));
      const [registration] = JSON.parse(pm2Command(["jlist"]).stdout);
      expect(registration).toMatchObject({
        name: "ravi",
        pid: first.pid,
        pm2_env: { pm_exec_path: bundlePath, exec_interpreter: "/bin/sh", args: ["daemon", "run"] },
      });

      rmSync(packageRoot, { recursive: true, force: true });
      writePackage();
      expect(pm2Command(["restart", "ravi"]).status).toBe(0);
      const second = await waitForProcess(first.pid);
      expect(second.argv).toEqual(first.argv);
      expect(second.stdinBytes).toBe(0);
      expect(second.context).toBe("");
      expect(second.gateway).toBe("");
      const forcedArgs = [...args];
      forcedArgs.splice(1, 0, "--force");
      expect(pm2Command(forcedArgs, serviceEnv).status).toBe(0);
      const standby = await waitForProcess(second.pid);
      expect(standby.argv).toEqual(second.argv);
      expect(standby.stdinBytes).toBe(0);
      expect(standby.context).toBe("");
      expect(standby.gateway).toBe("");
      const registrations = JSON.parse(pm2Command(["jlist"]).stdout);
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
    } finally {
      pm2Command(["kill"]);
      rmSync(pm2Home, { recursive: true, force: true });
    }
  },
  45_000,
);
