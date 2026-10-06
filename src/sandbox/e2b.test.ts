import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxConfigError,
  describeCommandError,
  githubCloneAuth,
  resolveSandboxCredentials,
  runE2bSandboxTask,
  safeFileName,
  shellQuote,
  type CreateSandboxInput,
  type SandboxHandle,
} from "./e2b.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-sandbox-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeOptions {
  daemonLogFails?: boolean;
  statuses?: string[];
  failOn?: RegExp;
  failWith?: unknown;
}

const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n \n-a\n+b\n";

function fakeSandbox(options: FakeOptions = {}) {
  const commands: string[] = [];
  const statuses = [...(options.statuses ?? ["in_progress", "done"])];
  const state = {
    killed: false,
    kills: 0,
    paused: false,
    created: null as CreateSandboxInput | null,
    cloneTimeoutMs: 0 as number | undefined,
    written: {} as Record<string, string>,
    tailDisconnected: false,
  };
  const handle: SandboxHandle = {
    sandboxId: "sbx-test",
    commands: {
      async run(cmd, opts) {
        commands.push(cmd);
        if (cmd.includes(" clone --depth 50 ")) state.cloneTimeoutMs = opts?.timeoutMs;
        if (cmd.startsWith("tail -n +1 -F")) {
          // Two whole lines and a partial one, split across chunks.
          opts?.onStdout?.("daemon line 1\ndaemon ");
          opts?.onStdout?.("line 2 tok-secret-123\npartial");
          return { disconnect: async () => (state.tailDisconnected = true) };
        }
        if (options.failOn?.test(cmd)) throw options.failWith ?? new Error(`boom: ${cmd}`);
        if (cmd.startsWith("ravi tasks create")) return { stdout: JSON.stringify({ task: { id: "task-1" } }) };
        if (cmd.startsWith("ravi tasks show")) {
          const status = statuses.length > 1 ? statuses.shift() : statuses[0];
          return {
            stdout: JSON.stringify({
              task: {
                id: "task-1",
                sessionName: "task-1-work",
                status,
                progress: status === "done" ? 100 : 10,
              },
            }),
          };
        }
        if (cmd.includes("git diff")) return { stdout: PATCH };
        if (cmd.includes("git write-tree")) return { stdout: "tree-base\n" };
        if (cmd.startsWith("cat /home/user/.ravi/daemon.log")) {
          if (options.daemonLogFails) throw new Error("sandbox gone");
          return { stdout: "full daemon log tok-secret-123\n" };
        }
        if (cmd.startsWith("ravi sessions list")) {
          return { stdout: JSON.stringify({ items: [{ name: "worker-task-1" }, { name: "agent:operator:main" }] }) };
        }
        if (cmd.startsWith("ravi sessions trace")) return { stdout: `trace for ${cmd}\n` };
        if (cmd.startsWith("find /home/user/.claude/projects")) {
          return { stdout: "/home/user/.claude/projects/-home-user-work-repo/abc.jsonl\n" };
        }
        if (cmd.startsWith("cat '/home/user/.claude/projects/")) return { stdout: '{"type":"user"}\n' };
        if (cmd.startsWith("cat ")) return { stdout: "# TASK" };
        return { stdout: "" };
      },
    },
    files: {
      async write(path, data) {
        state.written[path] = data;
      },
    },
    async kill() {
      state.killed = true;
      state.kills += 1;
    },
    async pause() {
      state.paused = true;
    },
  };
  return {
    commands,
    state,
    create: async (input: CreateSandboxInput) => {
      state.created = input;
      return handle;
    },
  };
}

const credentials = {
  e2bApiKey: "e2b_test",
  agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-secret-123" },
};

// Never reach the real E2B API from tests.
const noTelemetry = async () => null;

describe("resolveSandboxCredentials", () => {
  it("accepts RAVI_-prefixed Claude credentials and maps them to the standard names", () => {
    const resolved = resolveSandboxCredentials({
      E2B_API_KEY: "e2b_x",
      RAVI_CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(resolved.agentEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(resolved.githubToken).toBeUndefined();
  });

  it("requires the E2B key and some Claude credential", () => {
    expect(() => resolveSandboxCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toThrow(SandboxConfigError);
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x" })).toThrow(SandboxConfigError);
  });
});

describe("shellQuote", () => {
  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("runE2bSandboxTask", () => {
  it("runs the task to done, collects outputs and kills the sandbox", async () => {
    const fake = fakeSandbox();
    const outputDir = tempDir();
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      branch: "dev",
      instructions: "Fix it's typo",
      credentials,
      outputDir,
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      sandboxId: "sbx-test",
      taskId: "task-1",
      status: "done",
      kept: false,
      error: null,
    });
    expect(fake.state.killed).toBe(true);
    expect(fake.state.created?.envs).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "tok-secret-123",
    });
    expect(fake.commands).toContain(
      "GIT_TERMINAL_PROMPT=0 git clone --depth 50 --branch 'dev' --single-branch 'https://github.com/o/r.git' /home/user/work/repo",
    );
    expect(fake.commands.some((cmd) => cmd.includes(`--instructions 'Fix it'\\''s typo'`))).toBe(true);
    expect(fake.commands.some((cmd) => cmd.includes(".git/info/exclude"))).toBe(true);
    expect(result.files.sort()).toEqual([
      "TASK.md",
      "changes.patch",
      "daemon.log",
      "run.log",
      "sessions/agent_operator_main.trace.jsonl",
      "sessions/agent_operator_main.trace.txt",
      "sessions/task-1-work.trace.jsonl",
      "sessions/task-1-work.trace.txt",
      "sessions/worker-task-1.trace.jsonl",
      "sessions/worker-task-1.trace.txt",
      "task.json",
      "transcripts/-home-user-work-repo/abc.jsonl",
    ]);
    // The full log replaces the live copy, with credentials masked.
    expect(readFileSync(join(outputDir, "daemon.log"), "utf8")).toBe("full daemon log ***\n");
    expect(fake.state.tailDisconnected).toBe(true);
    expect(readFileSync(join(outputDir, "run.log"), "utf8")).toContain("Creating sandbox from ravi-runner");
    expect(readFileSync(join(outputDir, "sessions/worker-task-1.trace.txt"), "utf8")).toContain("--explain");
    expect(readFileSync(join(outputDir, "transcripts/-home-user-work-repo/abc.jsonl"), "utf8")).toBe(
      '{"type":"user"}\n',
    );
    // Written byte for byte: trimming would drop the blank context line and the final newline.
    expect(readFileSync(join(outputDir, "changes.patch"), "utf8")).toBe(PATCH);
    // The patch is taken against the tree captured after Ravi scaffolded the worker's cwd.
    const baselineAt = fake.commands.findIndex((cmd) => cmd.includes("git write-tree"));
    const permissionsAt = fake.commands.findIndex((cmd) => cmd.startsWith("ravi agents permissions worker"));
    const tasksAt = fake.commands.findIndex((cmd) => cmd.startsWith("ravi tasks create"));
    expect(baselineAt).toBeGreaterThan(permissionsAt);
    expect(baselineAt).toBeLessThan(tasksAt);
    expect(fake.commands.some((cmd) => cmd.includes("git diff --binary tree-base"))).toBe(true);
    // `$((` would make bash parse the tree command as arithmetic.
    expect(fake.commands.some((cmd) => cmd.includes("$(("))).toBe(false);
    expect(fake.state.cloneTimeoutMs).toBe(600_000);
  });

  it("sends GITHUB_TOKEN only when cloning from github.com over https", async () => {
    const fake = fakeSandbox();
    await runE2bSandboxTask({
      repo: "https://gitlab.example.com/o/r.git",
      instructions: "x",
      credentials: { ...credentials, githubToken: "ghp_secret" },
      outputDir: tempDir(),
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      sleep: async () => {},
    });
    expect(fake.state.written).toEqual({});
    expect(fake.commands.join("\n")).not.toContain("ghp_secret");

    // github.com: the token goes through a credential file, never a command line or env var,
    // because E2B logs every command's args and envs.
    const github = fakeSandbox();
    await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials: { ...credentials, githubToken: "ghp_secret/+" },
      outputDir: tempDir(),
      createSandbox: github.create,
      collectTelemetry: noTelemetry,
      sleep: async () => {},
    });
    expect(github.state.written).toEqual({
      "/home/user/.ravi-clone-credentials": "https://x-access-token:ghp_secret%2F%2B@github.com\n",
    });
    expect(github.commands.join("\n")).not.toContain("ghp_secret");
    const clone = github.commands.find((cmd) => cmd.includes(" clone --depth 50 "));
    expect(clone).toContain("credential.helper='store --file=/home/user/.ravi-clone-credentials'");
    expect(clone).toEndWith("rc=$?; rm -f /home/user/.ravi-clone-credentials; exit $rc");

    expect(githubCloneAuth("https://github.com/o/r.git", "t")).toEqual({ username: "x-access-token", password: "t" });
    expect(githubCloneAuth("http://github.com/o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("https://github.com.evil.dev/o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("git@github.com:o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("https://github.com/o/r.git")).toBeNull();
  });

  it("reports which command failed with its stderr", async () => {
    const fake = fakeSandbox({
      failOn: /ravi agents create worker/,
      failWith: Object.assign(new Error("exit status 1"), {
        exitCode: 2,
        stderr: "noise\nprovider claude is not configured\n",
      }),
    });
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      sleep: async () => {},
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("ravi agents create worker");
    expect(result.error).toContain("exited with code 2");
    expect(result.error).toContain("provider claude is not configured");
    expect(describeCommandError("x", new Error("plain")).message).toBe("plain");
  });

  it("kills the sandbox on Ctrl-C and removes its signal handlers afterwards", async () => {
    const fake = fakeSandbox({ statuses: ["in_progress", "done"] });
    const before = process.listeners("SIGINT");
    const termBefore = process.listeners("SIGTERM");
    const exits: number[] = [];
    await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      exit: (code) => {
        exits.push(code);
      },
      sleep: async () => {
        const handler = process.listeners("SIGINT").find((listener) => !before.includes(listener));
        (handler as (signal: NodeJS.Signals) => void)("SIGINT");
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    // Once from the signal handler, once from the normal cleanup (exit is stubbed here).
    expect(fake.state.kills).toBe(2);
    expect(exits).toEqual([130]);
    expect(process.listeners("SIGINT")).toEqual(before);
    expect(process.listeners("SIGTERM")).toEqual(termBefore);
  });

  it("reports the error, still collects logs and pauses when keep is set", async () => {
    const fake = fakeSandbox({ failOn: /ravi agents create worker/ });
    const outputDir = tempDir();
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir,
      keep: true,
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      sleep: async () => {},
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
    expect(result.taskId).toBeNull();
    expect(fake.state.paused).toBe(true);
    expect(fake.state.killed).toBe(false);
    expect(existsSync(join(outputDir, "daemon.log"))).toBe(true);
    expect(result.files).not.toContain("TASK.md");
  });

  it("times out when the task never reaches a terminal status", async () => {
    const fake = fakeSandbox({ statuses: ["in_progress"] });
    let clock = 0;
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      timeoutMin: 1,
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result.status).toBe("timeout");
    expect(fake.state.killed).toBe(true);
  });

  it("records a kill failure in the result instead of rejecting", async () => {
    const fake = fakeSandbox();
    const create = async (input: CreateSandboxInput) => {
      const handle = await fake.create(input);
      handle.kill = async () => {
        throw new Error("api down");
      };
      return handle;
    };
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: create,
      collectTelemetry: noTelemetry,
      sleep: async () => {},
    });

    expect(result.status).toBe("done");
    expect(result.taskId).toBe("task-1");
    expect(result.error).toContain("Failed to kill sandbox: api down");
  });

  it("kills the sandbox when the output directory cannot be created", async () => {
    const fake = fakeSandbox();
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    await expect(
      runE2bSandboxTask({
        repo: "https://github.com/o/r.git",
        instructions: "x",
        credentials,
        outputDir: join(blocker, "sub"),
        createSandbox: fake.create,
        collectTelemetry: noTelemetry,
        sleep: async () => {},
      }),
    ).rejects.toThrow();
    expect(fake.state.killed).toBe(true);
  });
});

describe("sandbox observability", () => {
  it("keeps the live daemon log when the final read fails and streams whole lines", async () => {
    const fake = fakeSandbox({ daemonLogFails: true });
    const outputDir = tempDir();
    const lines: string[] = [];
    await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir,
      createSandbox: fake.create,
      collectTelemetry: noTelemetry,
      onDaemonLog: (line) => lines.push(line),
      sleep: async () => {},
    });
    expect(lines).toEqual(["daemon line 1", "daemon line 2 ***"]);
    const log = readFileSync(join(outputDir, "daemon.log"), "utf8");
    expect(log).toStartWith("daemon line 1\ndaemon line 2 ***\n");
    expect(log).toContain("full read failed: ");
    expect(log).not.toContain("tok-secret-123");
  });

  it("collects E2B telemetry after the sandbox is killed and returns its summary", async () => {
    const fake = fakeSandbox();
    let killedFirst = false;
    const result = await runE2bSandboxTask({
      repo: "https://github.com/o/r.git",
      instructions: "x",
      credentials,
      outputDir: tempDir(),
      createSandbox: fake.create,
      collectTelemetry: async (input) => {
        killedFirst = fake.state.killed;
        expect(input).toMatchObject({ sandboxId: "sbx-test", apiKey: "e2b_test", waitForEnd: true });
        expect(input.secrets).toContain("tok-secret-123");
        return {
          files: ["e2b/summary.json"],
          summary: {
            logLines: 3,
            processes: 1,
            failedProcesses: 0,
            events: ["created", "killed"],
            killReason: "request",
            executionMs: 1000,
            metricSamples: 1,
            peakCpuPct: 5,
            peakMemMB: 50,
            memTotalMB: 512,
            peakDiskMB: 100,
            errors: [],
          },
        };
      },
      sleep: async () => {},
    });
    expect(killedFirst).toBe(true);
    expect(result.e2b?.killReason).toBe("request");
    expect(result.files).toContain("e2b/summary.json");
  });

  it("makes session names safe file names", () => {
    expect(safeFileName("agent:main:dm:+5511")).toBe("agent_main_dm_5511");
    expect(safeFileName("../..")).toBe("unnamed");
    expect(safeFileName("..")).toBe("unnamed");
    expect(safeFileName("///")).toBe("unnamed");
  });
});
