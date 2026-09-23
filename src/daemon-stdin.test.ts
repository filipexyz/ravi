import { describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDaemonPm2StartArgs,
  defaultPm2InertStdinWrapperPath,
  ensurePm2InertStdinWrapper,
  isDaemonRunArgv,
  isInertStdinPm2StartArgs,
  maybeNeuterDaemonStdin,
  PM2_INERT_STDIN_WRAPPER_NAME,
  PM2_INERT_STDIN_WRAPPER_SOURCE,
} from "./daemon-stdin.js";

const BUN_FILE_READER_CHUNK = 256 * 1024;

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

async function runWrapperAgainstIdleSocketpair(wrapperPath: string): Promise<{
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
        "wrapper, bun, script = sys.argv[1], sys.argv[2], sys.argv[3]",
        "reader, writer = socket.socketpair()",
        "proc = subprocess.Popen([wrapper, bun, '--eval', script], stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
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
      wrapperPath,
      process.execPath,
      script,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
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
  it("builds start args that exec Bun through the inert-stdin wrapper", () => {
    const args = buildDaemonPm2StartArgs({
      bundlePath: "/opt/ravi/dist/bundle/index.js",
      bunPath: "/usr/bin/bun",
    });
    expect(args).toEqual([
      "start",
      "/opt/ravi/dist/bundle/index.js",
      "--name",
      "ravi",
      "--interpreter",
      "/opt/ravi/dist/bundle/ravi-pm2-stdin",
      "--interpreter-args",
      "/usr/bin/bun",
      "--",
      "daemon",
      "run",
    ]);
    expect(isInertStdinPm2StartArgs(args)).toBe(true);
    expect(isInertStdinPm2StartArgs(["start", "bundle", "--interpreter", "bun", "--", "daemon", "run"])).toBe(false);
  });

  it("writes a shell wrapper that discards PM2 stdin before exec", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-daemon-stdin-wrapper-"));
    try {
      const bundlePath = join(root, "dist", "bundle", "index.js");
      mkdirSync(join(bundlePath, ".."), { recursive: true });
      writeFileSync(bundlePath, "", "utf8");
      const wrapperPath = ensurePm2InertStdinWrapper(bundlePath);
      expect(wrapperPath).toBe(defaultPm2InertStdinWrapperPath(bundlePath));
      expect(wrapperPath.endsWith(PM2_INERT_STDIN_WRAPPER_NAME)).toBe(true);
      expect(readFileSync(wrapperPath, "utf8")).toBe(PM2_INERT_STDIN_WRAPPER_SOURCE);
      expect(PM2_INERT_STDIN_WRAPPER_SOURCE).toContain("< /dev/null");
      expect(PM2_INERT_STDIN_WRAPPER_SOURCE).toContain('exec "$@"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes Bun fd 0 /dev/null when launched through the PM2 wrapper on an idle socketpair", async () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-daemon-stdin-wrapper-exec-"));
    try {
      const bundlePath = join(root, "index.js");
      writeFileSync(bundlePath, "", "utf8");
      const wrapperPath = ensurePm2InertStdinWrapper(bundlePath);
      chmodSync(wrapperPath, 0o755);
      const probe = await runWrapperAgainstIdleSocketpair(wrapperPath);
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
      if (process.platform === "linux") {
        expect(parsed.fd0).toBe("/dev/null");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("daemon CLI boot wiring", () => {
  it("imports the stdin neuter module before any other local module", () => {
    const source = readFileSync(new URL("./cli/index.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .+;$/gm)].map((match) => match[0]);
    expect(imports[0]).toBe('import "../daemon-stdin.js";');
  });
});
