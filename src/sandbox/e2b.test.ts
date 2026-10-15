import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_TRAFFIC,
  type BuildE2bTemplateOptions,
  type CreateSandboxInput,
  DEV_REGISTRY_HOSTS,
  type E2bTemplateDeps,
  type E2bTemplateRecord,
  MAX_TASK_TEXT_BYTES,
  NATS_LINUX_AMD64_SHA256,
  NATS_VERSION,
  RAVI_REPO,
  type RunSandboxTaskOptions,
  SANDBOX_PLACEHOLDER_API_KEY,
  type SandboxCredentials,
  SandboxConfigError,
  type SandboxHandle,
  type SandboxNetwork,
  TEMPLATE_BUN_LINUX_X64_SHA256,
  TEMPLATE_BUN_VERSION,
  type TemplateBuilderLike,
  buildE2bTemplate,
  describeTemplate,
  buildSandboxNetwork,
  describeCommandError,
  e2bSecretPlaceholder,
  githubCloneAuth,
  pickLsRemoteSha,
  readE2bTemplateRecord,
  repoHostOf,
  resolveCloneSource,
  resolveSandboxCredentials,
  runE2bSandboxTask,
  safeFileName,
  sandboxHostId,
  shellQuote,
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
  /** Secret names whose `put` fails (true: all of them). */
  secretStoreFails?: boolean | RegExp;
  /** What `getInfo` reports as the sandbox's template id (default `tpl_1`, the id the fake build records). */
  templateId?: string;
  getInfoFails?: boolean;
}

const PATCH = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n \n-a\n+b\n";
const TASKS_CREATE_CMD =
  'ravi tasks create --instructions "$(cat /home/user/.ravi-task/instructions.md)" --agent worker --report-to operator --json -- "$(cat /home/user/.ravi-task/title)"';
const SECRET_PLACEHOLDER_RE = /^\$\{e2b\.secrets\.ravi-sbx-[0-9a-f]{24}-[a-z]+\}$/;

/** Every transform-rule header value must be a secret-store placeholder: SandboxInfo shows rules to anyone with the E2B key. */
function expectOnlyPlaceholders(network: SandboxNetwork | undefined): void {
  expect(network).toBeDefined();
  for (const rules of Object.values(network?.rules ?? {})) {
    for (const rule of rules) {
      for (const value of Object.values(rule.transform.headers)) expect(value).toMatch(SECRET_PLACEHOLDER_RE);
    }
  }
}

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
    networkUpdates: [] as SandboxNetwork[],
    // Order of lifecycle calls, to prove the deny-all update lands before pause.
    lifecycle: [] as string[],
    // Every secret ever stored (kept after destroy, so tests can read the values).
    secrets: {} as Record<string, string>,
    destroyedSecrets: [] as string[],
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
    async updateNetwork(network) {
      state.networkUpdates.push(network);
      state.lifecycle.push("updateNetwork");
    },
    async getInfo() {
      if (options.getInfoFails) throw new Error("info api down");
      return { templateId: options.templateId ?? "tpl_1" };
    },
    async kill() {
      state.killed = true;
      state.kills += 1;
      state.lifecycle.push("kill");
    },
    async pause() {
      state.paused = true;
      state.lifecycle.push("pause");
    },
  };
  const secretStore = {
    async put(name: string, value: string) {
      const fails = options.secretStoreFails;
      if (fails === true || (fails instanceof RegExp && fails.test(name))) throw new Error("secrets api down");
      state.secrets[name] = value;
    },
    async destroy(name: string) {
      state.destroyedSecrets.push(name);
      state.lifecycle.push(`destroy:${name.split("-").at(-1)}`);
    },
  };
  return {
    commands,
    state,
    secretStore,
    create: async (input: CreateSandboxInput) => {
      state.created = input;
      return handle;
    },
    /** Options every run needs so nothing reaches E2B or the host's installation key. */
    options(overrides: Partial<RunSandboxTaskOptions> = {}): RunSandboxTaskOptions {
      return {
        repo: "https://github.com/o/r.git",
        instructions: "x",
        credentials,
        outputDir: tempDir(),
        hostId: "host-hash-16chars",
        templateRecord: null,
        createSandbox: this.create,
        secretStore,
        collectTelemetry: noTelemetry,
        sleep: async () => {},
        ...overrides,
      };
    },
  };
}

const credentials: SandboxCredentials = {
  e2bApiKey: "e2b_test",
  modelAuth: { mode: "header", apiKey: "tok-secret-123" },
};

// Never reach the real E2B API from tests.
const noTelemetry = async () => null;

describe("resolveSandboxCredentials", () => {
  it("defaults to header mode with the API key, RAVI_-prefixed or not", () => {
    expect(resolveSandboxCredentials({ E2B_API_KEY: "e2b_x", RAVI_ANTHROPIC_API_KEY: "sk-ant-api03-k" })).toEqual({
      e2bApiKey: "e2b_x",
      modelAuth: { mode: "header", apiKey: "sk-ant-api03-k" },
      githubToken: undefined,
    });
    expect(
      resolveSandboxCredentials({ E2B_API_KEY: "e2b_x", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g" }, "env"),
    ).toEqual({
      e2bApiKey: "e2b_x",
      modelAuth: { mode: "env", apiKey: "k" },
      githubToken: "g",
    });
  });

  it("refuses OAuth tokens, including through the RAVI_ prefix and by shape", () => {
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x", CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toThrow(
      /API key only/,
    );
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x", RAVI_CLAUDE_CODE_OAUTH_TOKEN: "tok" })).toThrow(
      SandboxConfigError,
    );
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x", ANTHROPIC_API_KEY: "sk-ant-oat01-x" })).toThrow(
      /subscription token/,
    );
  });

  it("requires the E2B key and an API key", () => {
    expect(() => resolveSandboxCredentials({ ANTHROPIC_API_KEY: "k" })).toThrow(SandboxConfigError);
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("picks broker mode from RAVI_SANDBOX_ANTHROPIC_BASE_URL and needs no API key there", () => {
    const env = { E2B_API_KEY: "e2b_x", RAVI_SANDBOX_ANTHROPIC_BASE_URL: "https://broker.ravi.bot/v1" };
    expect(resolveSandboxCredentials(env).modelAuth).toEqual({ mode: "broker", baseUrl: "https://broker.ravi.bot/v1" });
    expect(() => resolveSandboxCredentials({ E2B_API_KEY: "e2b_x" }, "broker")).toThrow(
      /RAVI_SANDBOX_ANTHROPIC_BASE_URL/,
    );
    expect(() =>
      resolveSandboxCredentials({ E2B_API_KEY: "e2b_x", RAVI_SANDBOX_ANTHROPIC_BASE_URL: "http://broker.local" }),
    ).toThrow(/https/);
  });
});

describe("buildSandboxNetwork", () => {
  const cfg = {
    repoHost: "gitlab.example.com",
    modelHost: "api.anthropic.com",
    modelHeaders: { "x-api-key": e2bSecretPlaceholder("k") },
    githubAuthorization: "Basic abc",
    allowHosts: ["internal.example.com"],
    egress: "dev-registries" as const,
  };

  it("denies everything but the repo and model hosts while cloning", () => {
    const clone = buildSandboxNetwork("clone", cfg);
    expect(clone.denyOut).toEqual([ALL_TRAFFIC]);
    expect(clone.allowOut.sort()).toEqual(["api.anthropic.com", "gitlab.example.com"]);
    expect(clone.rules).toEqual({
      "api.anthropic.com": [{ transform: { headers: { "x-api-key": e2bSecretPlaceholder("k") } } }],
    });
    // The GitHub credential rule only exists for github.com clones.
    const github = buildSandboxNetwork("clone", { ...cfg, repoHost: "github.com" });
    expect(github.rules["github.com"]).toEqual([{ transform: { headers: { Authorization: "Basic abc" } } }]);
  });

  it("swaps the repo host for --allow-host and the registry preset after the clone", () => {
    const run = buildSandboxNetwork("run", cfg);
    expect(run.allowOut).not.toContain("gitlab.example.com");
    expect(run.allowOut).toContain("internal.example.com");
    for (const host of DEV_REGISTRY_HOSTS) expect(run.allowOut).toContain(host);
    // GOPROXY fetches arbitrary origins on demand, so it is not in the preset; it is still allowed by name.
    expect(DEV_REGISTRY_HOSTS).not.toContain("proxy.golang.org");
    expect(DEV_REGISTRY_HOSTS).not.toContain("sum.golang.org");
    expect(run.allowOut).not.toContain("proxy.golang.org");
    expect(buildSandboxNetwork("run", { ...cfg, allowHosts: ["proxy.golang.org"] }).allowOut).toContain(
      "proxy.golang.org",
    );
    expect(run.rules["github.com"]).toBeUndefined();
    expect(run.rules["api.anthropic.com"]).toHaveLength(1);
    expect(run.denyOut).toEqual([ALL_TRAFFIC]);
    const strict = buildSandboxNetwork("run", { ...cfg, egress: "strict" });
    expect(strict.allowOut.sort()).toEqual(["api.anthropic.com", "internal.example.com"]);
    expect(buildSandboxNetwork("run", { ...cfg, modelHeaders: {} }).rules).toEqual({});
  });

  it("finds the host of http, ssh and scp-style repo URLs", () => {
    expect(repoHostOf("https://github.com/o/r.git")).toBe("github.com");
    expect(repoHostOf("ssh://git@gitlab.example.com/o/r.git")).toBe("gitlab.example.com");
    expect(repoHostOf("git@github.com:o/r.git")).toBe("github.com");
    expect(repoHostOf("/local/path")).toBeNull();
  });

  it("formats secret placeholders the way the e2b SDK does and hashes the installation key", async () => {
    const { Secret } = await import("e2b");
    expect(e2bSecretPlaceholder("ravi-sbx-1-anthropic")).toBe(Secret.fill("ravi-sbx-1-anthropic"));
    expect(sandboxHostId("install-key")).toMatch(/^[0-9a-f]{16}$/);
    expect(sandboxHostId("install-key")).not.toContain("install");
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
    const result = await runE2bSandboxTask(
      fake.options({ branch: "dev", instructions: "Fix it's typo", title: "Typo hunt", outputDir }),
    );

    expect(result).toMatchObject({
      sandboxId: "sbx-test",
      taskId: "task-1",
      status: "done",
      kept: false,
      error: null,
    });
    expect(fake.state.killed).toBe(true);
    // Header mode: the real key only exists in E2B's secret store; the sandbox gets a placeholder.
    expect(fake.state.created?.envs).toMatchObject({
      ANTHROPIC_API_KEY: SANDBOX_PLACEHOLDER_API_KEY,
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(JSON.stringify(fake.state.created)).not.toContain("tok-secret-123");
    expect(Object.values(fake.state.secrets)).toEqual(["tok-secret-123"]);
    expect(Object.keys(fake.state.secrets)).toEqual([expect.stringMatching(/^ravi-sbx-[0-9a-f]{24}-anthropic$/)]);
    // The per-run secret is removed from E2B once the sandbox is gone.
    expect(fake.state.destroyedSecrets).toEqual(Object.keys(fake.state.secrets));
    expect(fake.state.created?.metadata).toEqual({
      purpose: "ravi-task",
      ravi_run: expect.stringMatching(/^[0-9a-f]{24}$/),
      ravi_host: "host-hash-16chars",
      // The reaper tells an orphan from a live run by this pid.
      ravi_pid: String(process.pid),
    });
    // No record was passed and none exists in the isolated state dir: the run says so,
    // and still reports the template id E2B booted the sandbox from.
    expect(result.templateSha).toBeNull();
    expect(result.templateId).toBe("tpl_1");
    expect(result.templateNote).toBe(
      "id tpl_1, no build record on this host (warning: run `ravi sandbox template build` to pin a commit)",
    );
    const runLog = readFileSync(join(outputDir, "run.log"), "utf8");
    expect(runLog).toContain("Warning: no build record for template ravi-runner");
    expect(runLog).toContain(`Template ravi-runner: ${result.templateNote}`);
    expect(fake.state.created?.network).toMatchObject({
      allowPublicTraffic: false,
      denyOut: [ALL_TRAFFIC],
    });
    expect(fake.state.created?.network.allowOut.sort()).toEqual(["api.anthropic.com", "github.com"]);
    expect(fake.state.created?.lifecycle).toEqual({ onTimeout: "kill", autoResume: false });
    // Exactly one policy update, after the clone: the model rule again, no github.com, registries added.
    expect(fake.state.networkUpdates).toHaveLength(1);
    const update = fake.state.networkUpdates[0];
    expect(update.rules?.["github.com"]).toBeUndefined();
    expect(update.rules?.["api.anthropic.com"]).toEqual([
      { transform: { headers: { "x-api-key": e2bSecretPlaceholder(Object.keys(fake.state.secrets)[0] ?? "") } } },
    ]);
    expect(update.allowOut).toContain("registry.npmjs.org");
    expect(update.denyOut).toEqual([ALL_TRAFFIC]);
    expect(fake.commands).toContain(
      "GIT_TERMINAL_PROMPT=0 git clone --depth 50 --branch 'dev' --single-branch 'https://github.com/o/r.git' /home/user/work/repo",
    );
    // Task text goes through files, never a command string E2B would log.
    expect(fake.state.written["/home/user/.ravi-task/title"]).toBe("Typo hunt");
    expect(fake.state.written["/home/user/.ravi-task/instructions.md"]).toBe("Fix it's typo");
    const joined = fake.commands.join("\n");
    expect(joined).not.toContain("Typo hunt");
    expect(joined).not.toContain("typo");
    expect(fake.commands).toContain(TASKS_CREATE_CMD);
    expect(joined).not.toContain("full-access");
    expect(fake.commands).toContain(
      "ravi agents permissions worker bootstrap --capabilities 'execute:executable:*' --execute",
    );
    expect(fake.commands).toContain("ravi agents permissions operator chat-only");
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

  it("injects GITHUB_TOKEN as a clone-only header rule, never a command line, env var or file", async () => {
    const github = fakeSandbox();
    await runE2bSandboxTask(github.options({ credentials: { ...credentials, githubToken: "ghp_secret/+" } }));
    // The Basic credential lives in E2B's secret store; the sandbox config only holds the placeholder.
    const githubSecret = Object.entries(github.state.secrets).find(([name]) => name.endsWith("-github"));
    expect(githubSecret?.[1]).toBe(`Basic ${Buffer.from("x-access-token:ghp_secret/+").toString("base64")}`);
    expect(github.state.created?.network.rules["github.com"]).toEqual([
      { transform: { headers: { Authorization: e2bSecretPlaceholder(githubSecret?.[0] ?? "") } } },
    ]);
    expect(JSON.stringify(github.state.created)).not.toContain("ghp_secret");
    expect(github.commands.join("\n")).not.toContain("ghp_secret");
    expect(Object.keys(github.state.written)).not.toContain("/home/user/.ravi-clone-credentials");
    // Gone after the clone, together with the secret: destroyed right after the policy update,
    // before the daemon starts, not at run end.
    expect(github.state.networkUpdates[0]?.rules?.["github.com"]).toBeUndefined();
    expect(github.state.destroyedSecrets).toContain(githubSecret?.[0] ?? "");
    expect(github.state.lifecycle).toEqual(["updateNetwork", "destroy:github", "kill", "destroy:anthropic"]);
    // Both phases hold placeholders only, never a literal credential.
    expectOnlyPlaceholders(github.state.created?.network);
    expectOnlyPlaceholders(github.state.networkUpdates[0]);

    // Not github.com: no token anywhere, and the repo host is reachable only while cloning.
    const gitlab = fakeSandbox();
    await runE2bSandboxTask(
      gitlab.options({
        repo: "https://gitlab.example.com/o/r.git",
        credentials: { ...credentials, githubToken: "ghp_secret" },
      }),
    );
    expect(gitlab.state.created?.network.allowOut.sort()).toEqual(["api.anthropic.com", "gitlab.example.com"]);
    expect(gitlab.state.created?.network.rules["github.com"]).toBeUndefined();
    expect(gitlab.state.networkUpdates[0]?.allowOut).not.toContain("gitlab.example.com");
    expect(Object.keys(gitlab.state.secrets).some((name) => name.endsWith("-github"))).toBe(false);
    expect(Object.keys(gitlab.state.written)).toEqual([
      "/home/user/.ravi-task/title",
      "/home/user/.ravi-task/instructions.md",
    ]);
    expect(gitlab.commands.join("\n")).not.toContain("ghp_secret");
  });

  it("falls back to the clone credential file when the secret store refuses the GitHub rule", async () => {
    // Only the GitHub secret fails; the model key still goes through the store.
    const github = fakeSandbox({ secretStoreFails: /-github$/ });
    await runE2bSandboxTask(github.options({ credentials: { ...credentials, githubToken: "ghp_secret/+" } }));
    expect(github.state.created?.network.rules["github.com"]).toBeUndefined();
    expect(github.state.written).toMatchObject({
      // Built from parts so secret scanners don't flag a fake credential URL.
      "/home/user/.ravi-clone-credentials": [
        "https://x-access-token",
        `${encodeURIComponent("ghp_secret/+")}@github.com\n`,
      ].join(":"),
    });
    expect(github.commands.join("\n")).not.toContain("ghp_secret");
    const clone = github.commands.find((cmd) => cmd.includes(" clone --depth 50 "));
    expect(clone).toContain("credential.helper='store --file=/home/user/.ravi-clone-credentials'");
    expect(clone).toEndWith("rc=$?; rm -f /home/user/.ravi-clone-credentials; exit $rc");

    // Credentials inside the repo URL move to the credential file as well.
    const embedded = fakeSandbox();
    const userinfo = ["someone", "url-secret-123"].join(":");
    const result = await runE2bSandboxTask(embedded.options({ repo: `https://${userinfo}@git.example.com/o/r.git` }));
    expect(result.status).toBe("done");
    expect(embedded.state.written).toMatchObject({
      "/home/user/.ravi-clone-credentials": `https://${userinfo}@git.example.com\n`,
    });
    expect(embedded.commands.join("\n")).not.toContain("url-secret-123");
    expect(embedded.commands.some((cmd) => cmd.includes("'https://git.example.com/o/r.git'"))).toBe(true);
    expect(embedded.state.created?.network.allowOut).toContain("git.example.com");
    expect(resolveCloneSource("ssh://git@github.com/o/r.git", "t")).toEqual({
      url: "ssh://git@github.com/o/r.git",
      credentialLine: null,
      urlPassword: null,
    });

    expect(githubCloneAuth("https://github.com/o/r.git", "t")).toEqual({ username: "x-access-token", password: "t" });
    expect(githubCloneAuth("http://github.com/o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("https://github.com.evil.dev/o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("git@github.com:o/r.git", "t")).toBeNull();
    expect(githubCloneAuth("https://github.com/o/r.git")).toBeNull();
  });

  it("with --github-auth file, clones through the credential file and stores no GitHub secret", async () => {
    const fake = fakeSandbox();
    await runE2bSandboxTask(
      fake.options({ githubAuth: "file", credentials: { ...credentials, githubToken: "ghp_secret/+" } }),
    );
    // No GitHub rule in the clone policy and no GitHub secret in the store; the model key still goes through it.
    expect(fake.state.created?.network.rules["github.com"]).toBeUndefined();
    expect(Object.keys(fake.state.secrets)).toEqual([expect.stringMatching(/-anthropic$/)]);
    expect(fake.state.written).toMatchObject({
      "/home/user/.ravi-clone-credentials": [
        "https://x-access-token",
        `${encodeURIComponent("ghp_secret/+")}@github.com\n`,
      ].join(":"),
    });
    const clone = fake.commands.find((cmd) => cmd.includes(" clone --depth 50 "));
    expect(clone).toContain("credential.helper='store --file=/home/user/.ravi-clone-credentials'");
    expect(fake.commands.join("\n")).not.toContain("ghp_secret");
    expect(fake.state.lifecycle).toEqual(["updateNetwork", "kill", "destroy:anthropic"]);

    // `header` (the default) is unchanged: rule plus secret, no file.
    const header = fakeSandbox();
    await runE2bSandboxTask(
      header.options({ githubAuth: "header", credentials: { ...credentials, githubToken: "ghp_secret/+" } }),
    );
    expect(header.state.created?.network.rules["github.com"]).toHaveLength(1);
    expect(Object.keys(header.state.written)).not.toContain("/home/user/.ravi-clone-credentials");
  });

  it("never falls back to the env when the model key cannot be stored", async () => {
    const fake = fakeSandbox({ secretStoreFails: true });
    await expect(runE2bSandboxTask(fake.options())).rejects.toThrow("secrets api down");
    expect(fake.state.created).toBeNull();
  });

  it("keeps the real key out of the sandbox in broker mode and honours --allow-host and --egress strict", async () => {
    const broker = fakeSandbox();
    await runE2bSandboxTask(
      broker.options({
        credentials: {
          e2bApiKey: "e2b_test",
          modelAuth: {
            mode: "broker",
            baseUrl: "https://broker.ravi.bot/v1",
            // What 06b must pass: a secret-store placeholder, never the grant itself.
            headers: { "X-Ravi-Sandbox-Grant": e2bSecretPlaceholder(`ravi-sbx-${"0".repeat(24)}-grant`) },
          },
        },
        allowHosts: ["internal.example.com"],
        egress: "strict",
      }),
    );
    const created = broker.state.created;
    expect(created?.envs.ANTHROPIC_API_KEY).toBe(SANDBOX_PLACEHOLDER_API_KEY);
    expect(created?.envs.ANTHROPIC_BASE_URL).toBe("https://broker.ravi.bot/v1");
    expect(created?.network.allowOut.sort()).toEqual(["broker.ravi.bot", "github.com"]);
    expect(created?.network.rules).toEqual({
      "broker.ravi.bot": [
        {
          transform: { headers: { "X-Ravi-Sandbox-Grant": e2bSecretPlaceholder(`ravi-sbx-${"0".repeat(24)}-grant`) } },
        },
      ],
    });
    expect(broker.state.secrets).toEqual({});
    const update = broker.state.networkUpdates[0];
    expect(update?.allowOut?.sort()).toEqual(["broker.ravi.bot", "internal.example.com"]);
    expect(update?.rules).toEqual(created?.network.rules ?? {});
    expectOnlyPlaceholders(created?.network);
    expectOnlyPlaceholders(update);

    // env mode is the only one that puts the key itself in the sandbox, and it says so by having no rule.
    const env = fakeSandbox();
    await runE2bSandboxTask(
      env.options({ credentials: { e2bApiKey: "e2b_test", modelAuth: { mode: "env", apiKey: "sk-ant-api03-real" } } }),
    );
    expect(env.state.created?.envs.ANTHROPIC_API_KEY).toBe("sk-ant-api03-real");
    expect(env.state.created?.envs.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.state.created?.network.rules).toEqual({});
    expect(env.state.secrets).toEqual({});
  });

  it("never lets task text reach a command string, so shell syntax in it is inert", async () => {
    const fake = fakeSandbox();
    const rm = ["rm", "-rf", "~"].join(" ");
    const instructions = `Run $(${rm}) and \`id\` with 'single' and "double" quotes; also \\ and $HOME`;
    const title = `Title $(${rm}) \`whoami\``;
    await runE2bSandboxTask(fake.options({ instructions, title }));
    expect(fake.state.written["/home/user/.ravi-task/instructions.md"]).toBe(instructions);
    expect(fake.state.written["/home/user/.ravi-task/title"]).toBe(title);
    const joined = fake.commands.join("\n");
    expect(joined).not.toContain(rm);
    expect(joined).not.toContain("whoami");
    expect(joined).not.toContain("`id`");
    expect(joined).not.toContain("double");
    expect(fake.state.created?.metadata).not.toHaveProperty("title");
    expect(JSON.stringify(fake.state.created)).not.toContain("whoami");
    // The only command that mentions the task text does so through files.
    const create = fake.commands.filter((cmd) => cmd.startsWith("ravi tasks create"));
    expect(create).toEqual([TASKS_CREATE_CMD]);
    // The title is the last argument, after `--`, so a title that starts with `-` is not an option.
    expect(TASKS_CREATE_CMD).toEndWith(' -- "$(cat /home/user/.ravi-task/title)"');
  });

  it("reports which command failed with its stderr", async () => {
    const fake = fakeSandbox({
      failOn: /ravi agents create worker/,
      failWith: Object.assign(new Error("exit status 1"), {
        exitCode: 2,
        stderr: "noise\nprovider claude is not configured\n",
      }),
    });
    const result = await runE2bSandboxTask(fake.options());
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
    await runE2bSandboxTask(
      fake.options({
        exit: (code) => {
          exits.push(code);
        },
        sleep: async () => {
          const handler = process.listeners("SIGINT").find((listener) => !before.includes(listener));
          (handler as (signal: NodeJS.Signals) => void)("SIGINT");
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      }),
    );
    // Once from the signal handler, once from the normal cleanup (exit is stubbed here).
    expect(fake.state.kills).toBe(2);
    expect(exits).toEqual([130]);
    expect(process.listeners("SIGINT")).toEqual(before);
    expect(process.listeners("SIGTERM")).toEqual(termBefore);
  });

  it("kills a sandbox whose create was still pending when SIGINT arrived", async () => {
    const fake = fakeSandbox();
    const before = process.listeners("SIGINT");
    const exits: number[] = [];
    const create = async (input: CreateSandboxInput) => {
      // The handler is registered before create is called, so Ctrl-C here is not lost.
      const handler = process.listeners("SIGINT").find((listener) => !before.includes(listener));
      expect(handler).toBeDefined();
      (handler as (signal: NodeJS.Signals) => void)("SIGINT");
      return fake.create(input);
    };
    const result = await runE2bSandboxTask(
      fake.options({
        createSandbox: create,
        exit: (code) => {
          exits.push(code);
        },
      }),
    );
    expect(result.status).toBe("aborted");
    expect(result.error).toContain("SIGINT");
    expect(fake.state.kills).toBe(1);
    expect(fake.commands).toEqual([]);
    expect(exits).toEqual([130]);
    expect(fake.state.destroyedSecrets).toEqual(Object.keys(fake.state.secrets));
    expect(process.listeners("SIGINT")).toEqual(before);

    // SIGTERM exits 143 and a handler for it exists before create too.
    const term = fakeSandbox();
    const termExits: number[] = [];
    const termBefore = process.listeners("SIGTERM");
    await runE2bSandboxTask(
      term.options({
        createSandbox: async (input) => {
          const handler = process.listeners("SIGTERM").find((listener) => !termBefore.includes(listener));
          (handler as (signal: NodeJS.Signals) => void)("SIGTERM");
          return term.create(input);
        },
        exit: (code) => {
          termExits.push(code);
        },
      }),
    );
    expect(termExits).toEqual([143]);
    expect(term.state.kills).toBe(1);
  });

  it("ignores a second Ctrl-C while the first one's cleanup is still running", async () => {
    const fake = fakeSandbox();
    let releaseKill = () => {};
    let killCalls = 0;
    const create = async (input: CreateSandboxInput) => {
      const handle = await fake.create(input);
      const quickKill = handle.kill;
      handle.kill = async () => {
        killCalls += 1;
        // The first kill (from the signal handler) only resolves when the test says so.
        if (killCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseKill = resolve;
          });
        }
        await quickKill();
      };
      return handle;
    };
    const before = process.listeners("SIGINT");
    const exits: number[] = [];
    const steps: string[] = [];
    const seen: Record<string, unknown> = {};
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await runE2bSandboxTask(
      fake.options({
        createSandbox: create,
        exit: (code) => {
          exits.push(code);
        },
        onStep: (message) => steps.push(message),
        sleep: async () => {
          const handler = process.listeners("SIGINT").find((listener) => !before.includes(listener)) as (
            signal: NodeJS.Signals,
          ) => void;
          handler("SIGINT");
          await tick();
          handler("SIGINT");
          handler("SIGTERM");
          await tick();
          seen.exitsWhilePending = [...exits];
          seen.handlerStillInstalled = process.listeners("SIGINT").includes(handler);
          seen.destroyedWhilePending = [...fake.state.destroyedSecrets];
          releaseKill();
          await tick();
          seen.exitsAfterKill = [...exits];
          seen.handlersAfterKill = process.listeners("SIGINT");
        },
      }),
    );
    // Repeated signals neither removed the handler nor exited with the sandbox still up.
    expect(seen.exitsWhilePending).toEqual([]);
    expect(seen.handlerStillInstalled).toBe(true);
    expect(seen.destroyedWhilePending).toEqual([]);
    expect(steps.filter((line) => line.includes("cleanup in progress"))).toHaveLength(1);
    // Once the kill settled: secrets destroyed, handlers removed, exit 130 for the first signal.
    expect(seen.exitsAfterKill).toEqual([130]);
    expect(seen.handlersAfterKill).toEqual(before);
    expect(fake.state.destroyedSecrets).toEqual(Object.keys(fake.state.secrets));
    expect(fake.state.destroyedSecrets).toHaveLength(1);
    // Once from the handler, once from the normal cleanup (exit is stubbed here).
    expect(fake.state.kills).toBe(2);
  });

  it("exits within the cleanup limit when removing a secret hangs", async () => {
    const fake = fakeSandbox();
    fake.secretStore.destroy = () => new Promise<void>(() => {});
    const before = process.listeners("SIGINT");
    const exits: number[] = [];
    const seen: Record<string, unknown> = {};
    await runE2bSandboxTask(
      fake.options({
        signalCleanupTimeoutMs: 20,
        exit: (code) => {
          exits.push(code);
        },
        sleep: async () => {
          const handler = process.listeners("SIGINT").find((listener) => !before.includes(listener));
          (handler as (signal: NodeJS.Signals) => void)("SIGINT");
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen.exitsBeforeLimit = [...exits];
          await new Promise((resolve) => setTimeout(resolve, 60));
          seen.exitsAfterLimit = [...exits];
        },
      }),
    );
    expect(fake.state.killed).toBe(true);
    expect(seen.exitsBeforeLimit).toEqual([]);
    expect(seen.exitsAfterLimit).toEqual([130]);
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("with --keep, denies all egress and drops every rule before pausing", async () => {
    const fake = fakeSandbox({ failOn: /ravi agents create worker/ });
    const outputDir = tempDir();
    const result = await runE2bSandboxTask(fake.options({ outputDir, keep: true }));

    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
    expect(result.taskId).toBeNull();
    expect(result.kept).toBe(true);
    expect(fake.state.paused).toBe(true);
    expect(fake.state.killed).toBe(false);
    expect(existsSync(join(outputDir, "daemon.log"))).toBe(true);
    expect(result.files).not.toContain("TASK.md");
    // Clone-phase update, then the lock-down right before pause.
    expect(fake.state.lifecycle).toEqual(["updateNetwork", "updateNetwork", "pause", "destroy:anthropic"]);
    expect(fake.state.networkUpdates.at(-1)).toEqual({ allowOut: [], denyOut: [ALL_TRAFFIC], rules: {} });
    // Nothing waits for work in the paused machine.
    const pauseAt = fake.commands.findIndex((cmd) => cmd.includes("ravi daemon run"));
    // `[r]avi` so the pattern does not match the shell running the pkill itself.
    expect(fake.commands.slice(pauseAt + 1).some((cmd) => cmd.startsWith("pkill -f '[r]avi daemon run'"))).toBe(true);
    expect(fake.commands.some((cmd) => cmd.includes("pkill -f 'ravi daemon run'"))).toBe(false);
    // The injected secret is gone from E2B as well.
    expect(fake.state.destroyedSecrets).toEqual(Object.keys(fake.state.secrets));
  });

  it("refuses --keep when the real API key sits in the sandbox env", async () => {
    const fake = fakeSandbox();
    await expect(
      runE2bSandboxTask(
        fake.options({
          keep: true,
          credentials: { e2bApiKey: "e2b_test", modelAuth: { mode: "env", apiKey: "sk-ant-api03-real" } },
        }),
      ),
    ).rejects.toThrow(SandboxConfigError);
    expect(fake.state.created).toBeNull();
  });

  it("rejects a timeout outside 1..55 whole minutes before creating anything", async () => {
    for (const timeoutMin of [0, 56, 1.5, Number.NaN]) {
      const fake = fakeSandbox();
      await expect(runE2bSandboxTask(fake.options({ timeoutMin }))).rejects.toThrow(SandboxConfigError);
      expect(fake.state.created).toBeNull();
    }
    const fake = fakeSandbox();
    await runE2bSandboxTask(fake.options({ timeoutMin: 55 }));
    // The sandbox outlives the task by 5 minutes, which still fits E2B's 1 h cap.
    expect(fake.state.created?.timeoutMs).toBe(60 * 60_000);
  });

  it("rejects title and instructions over 100 KiB together before creating anything", async () => {
    expect(MAX_TASK_TEXT_BYTES).toBe(102_400);
    const tooBig = fakeSandbox();
    await expect(
      runE2bSandboxTask(tooBig.options({ title: "t", instructions: "x".repeat(MAX_TASK_TEXT_BYTES) })),
    ).rejects.toThrow(/100 KiB/);
    expect(tooBig.state.created).toBeNull();
    // Exactly at the limit is fine; bytes count, not characters.
    const atLimit = fakeSandbox();
    await runE2bSandboxTask(atLimit.options({ title: "t", instructions: "x".repeat(MAX_TASK_TEXT_BYTES - 1) }));
    expect(atLimit.state.created).not.toBeNull();
    const multiByte = fakeSandbox();
    await expect(
      runE2bSandboxTask(multiByte.options({ title: "", instructions: "é".repeat(MAX_TASK_TEXT_BYTES / 2 + 1) })),
    ).rejects.toThrow(SandboxConfigError);
  });

  it("times out when the task never reaches a terminal status", async () => {
    const fake = fakeSandbox({ statuses: ["in_progress"] });
    let clock = 0;
    const result = await runE2bSandboxTask(
      fake.options({
        timeoutMin: 1,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    );

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
    const result = await runE2bSandboxTask(fake.options({ createSandbox: create }));

    expect(result.status).toBe("done");
    expect(result.taskId).toBe("task-1");
    expect(result.error).toContain("Failed to kill sandbox: api down");
  });

  it("kills the sandbox when the output directory cannot be created", async () => {
    const fake = fakeSandbox();
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    await expect(runE2bSandboxTask(fake.options({ outputDir: join(blocker, "sub") }))).rejects.toThrow();
    expect(fake.state.killed).toBe(true);
    expect(fake.state.destroyedSecrets).toEqual(Object.keys(fake.state.secrets));
  });
});

describe("sandbox observability", () => {
  it("keeps the live daemon log when the final read fails and streams whole lines", async () => {
    const fake = fakeSandbox({ daemonLogFails: true });
    const outputDir = tempDir();
    const lines: string[] = [];
    await runE2bSandboxTask(fake.options({ outputDir, onDaemonLog: (line) => lines.push(line) }));
    expect(lines).toEqual(["daemon line 1", "daemon line 2 ***"]);
    const log = readFileSync(join(outputDir, "daemon.log"), "utf8");
    expect(log).toStartWith("daemon line 1\ndaemon line 2 ***\npartial\n");
    expect(log).toContain("full read failed: ");
    expect(log).not.toContain("tok-secret-123");
  });

  it("collects E2B telemetry after the sandbox is killed and returns its summary", async () => {
    const fake = fakeSandbox();
    let killedFirst = false;
    const result = await runE2bSandboxTask(
      fake.options({
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
      }),
    );
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

// ---------------------------------------------------------------------------
// Template build

type TemplateStep =
  | { kind: "fromBaseImage" }
  | { kind: "aptInstall"; packages: string[] }
  | { kind: "runCmd"; commands: string[]; user?: string }
  | { kind: "gitClone"; url: string; path: string; options?: { branch?: string; depth?: number } }
  | { kind: "setStartCmd"; command: string }
  | { kind: "skipCache" };

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/** Records every builder call; `build` returns a fixed BuildInfo and records its options. */
function fakeTemplate() {
  const steps: TemplateStep[] = [];
  const state = { built: null as null | { name: string; options: Record<string, unknown> } };
  const builder: TemplateBuilderLike = {
    fromBaseImage() {
      steps.push({ kind: "fromBaseImage" });
      return builder;
    },
    aptInstall(packages) {
      steps.push({ kind: "aptInstall", packages });
      return builder;
    },
    runCmd(commands, options) {
      steps.push({ kind: "runCmd", commands: Array.isArray(commands) ? commands : [commands], user: options?.user });
      return builder;
    },
    gitClone(url, path, options) {
      steps.push({ kind: "gitClone", url, path, options });
      return builder;
    },
    setStartCmd(command) {
      steps.push({ kind: "setStartCmd", command });
      return builder;
    },
    skipCache() {
      steps.push({ kind: "skipCache" });
      return builder;
    },
  };
  const deps: E2bTemplateDeps = {
    Template: () => builder,
    async build(_template, name, options) {
      state.built = { name, options: options as unknown as Record<string, unknown> };
      return { name, templateId: "tpl_1", buildId: "bld_1" };
    },
    waitForPort: (port) => ({ port }),
  };
  const commands = () => steps.flatMap((step) => (step.kind === "runCmd" ? step.commands : []));
  return {
    steps,
    state,
    deps,
    commands,
    options(overrides: Partial<BuildE2bTemplateOptions> = {}): BuildE2bTemplateOptions {
      return {
        apiKey: "e2b_test",
        deps,
        recordPath: join(tempDir(), "sandbox-templates.json"),
        resolveRef: async (_repo, ref) => (ref === "dev" ? SHA : ref === "v1" ? OTHER_SHA : null),
        now: () => 1_700_000_000_000,
        ...overrides,
      };
    },
  };
}

describe("buildE2bTemplate", () => {
  it("pins every download: real 64-hex digests, sha256sum -c on each archive, no curl | bash", () => {
    for (const digest of [TEMPLATE_BUN_LINUX_X64_SHA256, NATS_LINUX_AMD64_SHA256]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(TEMPLATE_BUN_LINUX_X64_SHA256).not.toBe(NATS_LINUX_AMD64_SHA256);
    expect(TEMPLATE_BUN_VERSION).toBe("1.3.11");
    expect(NATS_VERSION).toBe("2.11.8");
  });

  it("resolves the ref on the host, checks out that SHA in the sandbox and never skips the cache", async () => {
    const fake = fakeTemplate();
    const recordPath = join(tempDir(), "sandbox-templates.json");
    const result = await buildE2bTemplate(fake.options({ ref: "dev", recordPath }));

    expect(fake.steps.map((step) => step.kind)).not.toContain("skipCache");
    expect(fake.steps[0]).toEqual({ kind: "fromBaseImage" });
    const clone = fake.steps.find((step) => step.kind === "gitClone");
    expect(clone).toEqual({
      kind: "gitClone",
      url: RAVI_REPO,
      path: "/home/user/ravi",
      options: { branch: "dev", depth: 50 },
    });
    const checkout = fake.commands().find((cmd) => cmd.includes("git checkout --detach"));
    expect(checkout).toBe(
      `cd /home/user/ravi && git fetch --depth 1 origin ${SHA} && git checkout --detach ${SHA} && test "$(git rev-parse HEAD)" = ${SHA}`,
    );
    // The build layer's command string carries the SHA too, so its cache entry cannot
    // outlive a ref change whatever E2B keys the layer on.
    expect(fake.commands().find((cmd) => cmd.includes("bun run build"))).toBe(
      `cd /home/user/ravi && test "$(git rev-parse HEAD)" = ${SHA} && bun install --frozen-lockfile && bun run build`,
    );
    // The checkout comes after the clone and before the build.
    const kinds = fake.steps.map((step) => (step.kind === "runCmd" ? step.commands.join(";") : step.kind));
    const cloneAt = kinds.indexOf("gitClone");
    const checkoutAt = kinds.findIndex((entry) => entry.includes("git checkout --detach"));
    const buildAt = kinds.findIndex((entry) => entry.includes("bun run build"));
    expect(cloneAt).toBeGreaterThan(-1);
    expect(checkoutAt).toBeGreaterThan(cloneAt);
    expect(buildAt).toBeGreaterThan(checkoutAt);

    // Each archive is saved, verified and only then unpacked; nothing is piped into a shell.
    const joined = fake.commands().join("\n");
    expect(joined).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(joined).not.toContain("bun.sh/install");
    expect(joined).toContain(
      `curl -fsSL -o /tmp/bun-linux-x64.zip https://github.com/oven-sh/bun/releases/download/bun-v${TEMPLATE_BUN_VERSION}/bun-linux-x64.zip`,
    );
    expect(joined).toContain(`echo "${TEMPLATE_BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum -c -`);
    expect(joined).toContain(
      `echo "${NATS_LINUX_AMD64_SHA256}  /tmp/nats-server-v${NATS_VERSION}-linux-amd64.tar.gz" | sha256sum -c -`,
    );
    for (const archive of ["/tmp/bun-linux-x64.zip", `/tmp/nats-server-v${NATS_VERSION}-linux-amd64.tar.gz`]) {
      const commands = fake.commands();
      const checkAt = commands.findIndex((cmd) => cmd.includes(`${archive}" | sha256sum -c -`));
      const unpackAt = commands.findIndex((cmd) => /^(unzip|tar) /.test(cmd) && cmd.includes(archive));
      expect(checkAt).toBeGreaterThan(-1);
      expect(unpackAt).toBeGreaterThan(checkAt);
    }
    // Downloads run as root into /usr/local/bin; the Ravi build does not.
    const rootSteps = fake.steps.filter((step) => step.kind === "runCmd" && step.user === "root");
    expect(rootSteps).toHaveLength(2);
    expect(
      fake.steps.find((step) => step.kind === "runCmd" && step.commands[0]?.includes("bun run build")),
    ).toMatchObject({ user: undefined });

    // The build is tagged with the short SHA and the record says which commit the template holds.
    expect(fake.state.built?.name).toBe("ravi-runner");
    expect(fake.state.built?.options).toMatchObject({
      apiKey: "e2b_test",
      cpuCount: 2,
      memoryMB: 4096,
      tags: [SHA.slice(0, 12)],
    });
    expect(result).toEqual({
      name: "ravi-runner",
      templateId: "tpl_1",
      buildId: "bld_1",
      ref: "dev",
      sha: SHA,
      bunVersion: TEMPLATE_BUN_VERSION,
      natsVersion: NATS_VERSION,
      builtAt: "2023-11-14T22:13:20.000Z",
      durationMs: 0,
    });
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    const { durationMs: _durationMs, ...record } = result;
    expect(readE2bTemplateRecord("ravi-runner", recordPath)).toEqual(record);
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({ version: 1, templates: { "ravi-runner": record } });
    expect(readE2bTemplateRecord("other", recordPath)).toBeNull();
  });

  it("accepts a 40-hex --ref as the SHA itself, without resolving it", async () => {
    const fake = fakeTemplate();
    let resolved = 0;
    const result = await buildE2bTemplate(
      fake.options({
        name: "ravi-pinned",
        ref: OTHER_SHA.toUpperCase(),
        resolveRef: async () => {
          resolved += 1;
          return SHA;
        },
      }),
    );
    expect(resolved).toBe(0);
    expect(result.sha).toBe(OTHER_SHA);
    expect(fake.steps.find((step) => step.kind === "gitClone")).toMatchObject({
      options: { branch: "dev", depth: 50 },
    });
    expect(fake.commands().some((cmd) => cmd.includes(`git checkout --detach ${OTHER_SHA}`))).toBe(true);
    expect(fake.state.built?.options.tags).toEqual([OTHER_SHA.slice(0, 12)]);
  });

  it("keeps one record per template name and replaces an older build of the same name", async () => {
    const recordPath = join(tempDir(), "sandbox-templates.json");
    await buildE2bTemplate(fakeTemplate().options({ ref: "dev", recordPath }));
    await buildE2bTemplate(fakeTemplate().options({ name: "ravi-v1", ref: "v1", recordPath }));
    await buildE2bTemplate(fakeTemplate().options({ ref: "v1", recordPath, now: () => 1_700_000_060_000 }));
    const file = JSON.parse(readFileSync(recordPath, "utf8")) as { templates: Record<string, E2bTemplateRecord> };
    expect(Object.keys(file.templates).sort()).toEqual(["ravi-runner", "ravi-v1"]);
    expect(file.templates["ravi-runner"]).toMatchObject({
      ref: "v1",
      sha: OTHER_SHA,
      builtAt: "2023-11-14T22:14:20.000Z",
    });
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  it("fails clearly when a non-hex ref does not resolve, before any build", async () => {
    const fake = fakeTemplate();
    await expect(buildE2bTemplate(fake.options({ ref: "no-such-branch" }))).rejects.toThrow(
      /Cannot resolve --ref "no-such-branch" to a commit on https:\/\/github\.com\/filipexyz\/ravi\.git/,
    );
    await expect(buildE2bTemplate(fake.options({ ref: "no-such-branch" }))).rejects.toThrow(SandboxConfigError);
    // A resolver that answers with something that is not a SHA is refused as well.
    await expect(buildE2bTemplate(fake.options({ ref: "dev", resolveRef: async () => "not-a-sha" }))).rejects.toThrow(
      SandboxConfigError,
    );
    for (const ref of ["", "  ", "-rf", "a b"]) {
      await expect(buildE2bTemplate(fake.options({ ref }))).rejects.toThrow(/Invalid --ref/);
    }
    expect(fake.steps).toEqual([]);
    expect(fake.state.built).toBeNull();
  });

  it("picks the branch, then the peeled tag, from git ls-remote output", () => {
    const output = [
      `${OTHER_SHA}\trefs/tags/dev`,
      `${SHA}\trefs/heads/dev`,
      `${"1".repeat(40)}\trefs/tags/dev^{}`,
      "garbage line",
    ].join("\n");
    expect(pickLsRemoteSha(output, "dev")).toBe(SHA);
    expect(pickLsRemoteSha(`${OTHER_SHA}\trefs/tags/v1\n${SHA}\trefs/tags/v1^{}\n`, "v1")).toBe(SHA);
    expect(pickLsRemoteSha(`${OTHER_SHA}\trefs/tags/v1\n`, "v1")).toBe(OTHER_SHA);
    expect(pickLsRemoteSha(`${SHA}\trefs/heads/dev-2\n`, "dev")).toBeNull();
    expect(pickLsRemoteSha("", "dev")).toBeNull();
  });
});

describe("template record in a run", () => {
  const record: E2bTemplateRecord = {
    name: "ravi-runner",
    templateId: "tpl_1",
    buildId: "bld_1",
    ref: "dev",
    sha: SHA,
    bunVersion: TEMPLATE_BUN_VERSION,
    natsVersion: NATS_VERSION,
    builtAt: "2023-11-14T22:13:20.000Z",
  };

  it("writes the template commit to run.log and the result when E2B's template id is the recorded one", async () => {
    const fake = fakeSandbox();
    const outputDir = tempDir();
    const result = await runE2bSandboxTask(fake.options({ outputDir, templateRecord: record }));
    expect(result.templateSha).toBe(SHA);
    expect(result.templateId).toBe("tpl_1");
    const note = `ravi ${SHA} (built 2023-11-14T22:13:20.000Z on this host)`;
    expect(result.templateNote).toBe(note);
    const log = readFileSync(join(outputDir, "run.log"), "utf8");
    expect(log).toContain(`Template ravi-runner: ${note}`);
    expect(log).not.toContain("Warning: no build record");
  });

  it("reports a template id that is not the recorded one and claims no commit for it", async () => {
    // Same name, another id: the template was rebuilt elsewhere and the record says nothing about this sandbox.
    const fake = fakeSandbox({ templateId: "tpl_elsewhere" });
    const outputDir = tempDir();
    const result = await runE2bSandboxTask(fake.options({ outputDir, templateRecord: record }));
    expect(result.templateSha).toBeNull();
    expect(result.templateId).toBe("tpl_elsewhere");
    expect(result.templateNote).toBe(
      `id tpl_elsewhere does not match this host's record (tpl_1, ravi ${SHA}) — rebuilt elsewhere?`,
    );
    const log = readFileSync(join(outputDir, "run.log"), "utf8");
    expect(log).toContain(`Template ravi-runner: ${result.templateNote}`);
    expect(log).not.toContain("on this host)");
    expect(result.status).toBe("done");

    // When E2B cannot say which template the sandbox booted from, the record is unverified, not trusted.
    const blind = fakeSandbox({ getInfoFails: true });
    const unverified = await runE2bSandboxTask(blind.options({ templateRecord: record }));
    expect(unverified.templateSha).toBeNull();
    expect(unverified.templateId).toBeNull();
    expect(unverified.templateNote).toBe(
      `id could not be read (info api down); this host's record (tpl_1, ravi ${SHA}) is unverified`,
    );
    expect(unverified.status).toBe("done");
    expect(describeTemplate(record, "tpl_1")).toEqual({
      templateSha: SHA,
      templateNote: `ravi ${SHA} (built 2023-11-14T22:13:20.000Z on this host)`,
    });
    expect(describeTemplate(null, null).templateSha).toBeNull();
  });

  it("reads the record file written by the build and ignores a corrupt or SHA-less one", async () => {
    const recordPath = join(tempDir(), "sandbox-templates.json");
    await buildE2bTemplate(fakeTemplate().options({ ref: "dev", recordPath }));
    expect(readE2bTemplateRecord("ravi-runner", recordPath)?.sha).toBe(SHA);
    writeFileSync(recordPath, "{not json");
    expect(readE2bTemplateRecord("ravi-runner", recordPath)).toBeNull();
    writeFileSync(recordPath, JSON.stringify({ version: 1, templates: { "ravi-runner": { sha: "short" } } }));
    expect(readE2bTemplateRecord("ravi-runner", recordPath)).toBeNull();
    expect(readE2bTemplateRecord("ravi-runner", join(tempDir(), "missing.json"))).toBeNull();
  });
});
