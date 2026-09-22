import { describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { buildCliInvocationMetadata, hashForAudit, sanitizeCliArgv, standardStreamIsTty } from "./provenance.js";

function provenanceIdleStdinScript(): string {
  const provenanceUrl = new URL("./provenance.ts", import.meta.url).href;
  return `
      import { buildCliInvocationMetadata } from ${JSON.stringify(provenanceUrl)};
      const started = Date.now();
      const metadata = buildCliInvocationMetadata({ group: "tasks", name: "list", tool: "tasks_list" });
      process.stdout.write(JSON.stringify({
        elapsedMs: Date.now() - started,
        stdinIsTTY: metadata.terminal.stdinIsTTY,
        stdoutIsTTY: metadata.terminal.stdoutIsTTY,
        stderrIsTTY: metadata.terminal.stderrIsTTY,
      }));
    `;
}

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

async function runProvenanceAgainstIdleStdin(mode: "pipe" | "socketpair"): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}> {
  const script = provenanceIdleStdinScript();
  const child =
    mode === "pipe"
      ? spawn(process.execPath, ["--eval", script], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(
          "python3",
          [
            "-c",
            [
              "import socket, subprocess, sys",
              "bun, script = sys.argv[1], sys.argv[2]",
              "reader, writer = socket.socketpair()",
              "proc = subprocess.Popen([bun, '--eval', script], stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE)",
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
    const result = await completed;
    return { ...result, timedOut };
  } finally {
    clearTimeout(timeout);
    child.stdin?.destroy();
  }
}

function withForbiddenStdinAccess<T>(fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  let accessed = 0;
  Object.defineProperty(process, "stdin", {
    configurable: true,
    enumerable: true,
    get() {
      accessed += 1;
      throw new Error("process.stdin must not be opened for audit TTY detection");
    },
  });
  try {
    const result = fn();
    expect(accessed).toBe(0);
    return result;
  } finally {
    if (original) Object.defineProperty(process, "stdin", original);
  }
}

describe("CLI provenance", () => {
  it("summarizes argv without persisting values", () => {
    expect(
      sanitizeCliArgv([
        "ravi",
        "sessions",
        "reset",
        "--api-key",
        "secret-value",
        "--token=abc123",
        "--reason",
        "manual",
      ]),
    ).toEqual(["[REDACTED:argv count=8]"]);
  });

  it("summarizes values that resemble flags", () => {
    expect(sanitizeCliArgv(["--api-key", "-secret-value"])).toEqual(["[REDACTED:argv count=2]"]);
    expect(sanitizeCliArgv(["--api-key", "--json"])).toEqual(["[REDACTED:argv count=2]"]);
    expect(sanitizeCliArgv(["--output-path", "-private-file"])).toEqual(["[REDACTED:argv count=2]"]);
  });

  it("does not persist long option names or URL values", () => {
    const option = `--${"x".repeat(250)}url`;

    expect(sanitizeCliArgv([option, "https://user:password@example.test/private?token=secret#fragment"])).toEqual([
      "[REDACTED:argv count=2]",
    ]);
  });

  it("does not reconstruct long path options", () => {
    const option = `--${"x".repeat(250)}path=/x`;
    const [projected] = sanitizeCliArgv([option]);

    expect(projected).toBe("[REDACTED:argv count=1]");
  });

  it("does not persist negative numeric values", () => {
    expect(sanitizeCliArgv(["--url", "-1"])).toEqual(["[REDACTED:argv count=2]"]);
  });

  it("does not special-case boolean flags", () => {
    expect(sanitizeCliArgv(["ravi", "daemon", "logs", "--path", "--json"], { group: "daemon", name: "logs" })).toEqual([
      "[REDACTED:argv count=5]",
    ]);
  });

  it("builds process metadata for direct CLI invocations", () => {
    const metadata = buildCliInvocationMetadata({
      group: "sessions",
      name: "reset",
      tool: "sessions_reset",
    });

    expect(metadata.invocationId).toBeTruthy();
    expect(metadata.command?.tool).toBe("sessions_reset");
    expect(metadata.process.pid).toBe(process.pid);
    expect(metadata.process.ppid).toBe(process.ppid);
    expect(metadata.process.cwd).toBe("[REDACTED:path]");
    expect(metadata.process.execPath).toBe("[REDACTED:path]");
    expect(metadata.process.argv.length).toBeGreaterThan(0);
    expect(metadata.host.hostname).toBeTruthy();
    expect(metadata.runtime.nodeVersion).toBe(process.versions.node);
    expect(typeof metadata.raviContext.hasContextKey).toBe("boolean");
    expect(typeof metadata.terminal.stdinIsTTY).toBe("boolean");
    expect(typeof metadata.terminal.stdoutIsTTY).toBe("boolean");
    expect(typeof metadata.terminal.stderrIsTTY).toBe("boolean");
    expect(JSON.stringify(metadata)).not.toContain(process.cwd());
    expect(JSON.stringify(metadata)).not.toContain(process.execPath);
  });

  it("detects TTY state without opening process.stdin", () => {
    const metadata = withForbiddenStdinAccess(() =>
      buildCliInvocationMetadata({
        group: "tasks",
        name: "list",
        tool: "tasks_list",
      }),
    );

    expect(withForbiddenStdinAccess(() => standardStreamIsTty(0))).toBe(metadata.terminal.stdinIsTTY);
    expect(metadata.terminal.stdinIsTTY).toBe(standardStreamIsTty(0));
    expect(metadata.terminal.stdoutIsTTY).toBe(standardStreamIsTty(1));
    expect(metadata.terminal.stderrIsTTY).toBe(standardStreamIsTty(2));
  });

  it.each([
    ["idle open pipe", "pipe"],
    ["idle socketpair", "socketpair"],
  ] as const)("does not hang when fd 0 is an %s", async (_label, mode) => {
    const result = await runProvenanceAgainstIdleStdin(mode);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      elapsedMs: number;
      stdinIsTTY: boolean;
      stdoutIsTTY: boolean;
      stderrIsTTY: boolean;
    };
    expect(parsed.stdinIsTTY).toBe(false);
    expect(typeof parsed.stdoutIsTTY).toBe("boolean");
    expect(typeof parsed.stderrIsTTY).toBe("boolean");
    expect(parsed.elapsedMs).toBeLessThan(1000);
  });

  it("hashes audit identifiers without exposing raw values", () => {
    const hash = hashForAudit("120363424772797713@g.us");

    expect(hash).toHaveLength(16);
    expect(hash).not.toContain("120363");
  });
});
