// Codex parity fixture (contract §13.10). A codex agent on `chat-only`, or on
// `explicit-only` without exec, must use no native tool beyond the allowed
// set: not `apply_patch`, `web_search` or `view_image`. The fixture runs the
// real provider against a fake app-server and reads what Ravi sends at all
// five sites (`thread/start`, `thread/resume`, `thread/fork`, the control
// `thread.fork`, and the `codex exec` arguments).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent } from "../router/router-db.js";
import { buildCodexExecArgs, createCodexRuntimeProvider } from "../runtime/codex-provider.js";
import { RAVI_CODEX_BASH_HOOK_MATCHER } from "../runtime/codex-hooks.js";
import type { RuntimeStartRequest } from "../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { buildAgentRuntimePermissionsDefaults } from "./agent-default-capabilities-provider.js";
import {
  CODEX_KNOWLEDGE_ALLOWED_TOOLS,
  CODEX_NATIVE_TOOLS,
  codexKnowledgeParityHolds,
  codexUsableNativeTools,
} from "./codex-knowledge-parity.js";

type LoggedRequest = { method: string; params: Record<string, unknown> };
type SiteConfig = { site: string; sandbox: unknown; config: Record<string, unknown> | null };

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-codex-native-parity-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const FAKE_APP_SERVER = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const logPath = process.env.RAVI_CODEX_TEST_LOG;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && message.method) {
    appendFileSync(logPath, JSON.stringify({ method: message.method, params: message.params ?? {} }) + "\\n");
  }
  if (message.id && message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "initialized") return;
  if (message.id && ["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
    const id = message.method === "thread/start" ? "thread_new" : message.method === "thread/resume" ? message.params.threadId : "thread_forked";
    return send({ id: message.id, result: { thread: { id }, model: "gpt-5", modelProvider: "openai" } });
  }
  if (message.id && message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn_1", status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn_1", status: "completed" } } });
    return;
  }
  if (message.id) send({ id: message.id, result: {} });
});
`;

function setProfile(agentId: string, runtimePermissions: { profile: string; capabilities?: string[] } | null): void {
  if (!dbGetAgent(agentId)) dbCreateAgent({ id: agentId, cwd: `/tmp/${agentId}` });
  const agent = dbGetAgent(agentId);
  dbUpdateAgent(agentId, {
    defaults: buildAgentRuntimePermissionsDefaults(
      agent?.defaults,
      runtimePermissions as Parameters<typeof buildAgentRuntimePermissionsDefaults>[1],
    ),
  });
}

function prompt(content: string, hold?: Promise<void>): RuntimeStartRequest["prompt"] {
  return (async function* () {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content },
      session_id: "",
      parent_tool_use_id: null,
    };
    if (hold) await hold;
  })();
}

function readLog(path: string): LoggedRequest[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest);
}

/** Runs the provider through the four app-server sites and returns what each one sent. */
async function captureAppServerSites(agentId: string): Promise<SiteConfig[]> {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-native-parity-"));
  const command = join(cwd, "fake-codex-app-server.mjs");
  writeFileSync(command, FAKE_APP_SERVER);
  chmodSync(command, 0o755);
  const sites: SiteConfig[] = [];
  const env = (log: string) => ({
    PATH: process.env.PATH ?? "",
    RAVI_CODEX_TEST_LOG: log,
    RAVI_CODEX_TRANSPORT: "stdio",
  });

  // thread/start, then the control thread.fork on the live session.
  {
    const log = join(cwd, "start.jsonl");
    writeFileSync(log, "");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abortController = new AbortController();
    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession({
      prompt: prompt("hello", hold),
      model: "gpt-5",
      cwd,
      agentId,
      abortController,
      systemPromptAppend: "",
      env: env(log),
    });
    const iterator = session.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("codex session ended before the turn completed");
        if (next.value.type === "turn.complete") break;
      }
      const fork = await session.control?.({ operation: "thread.fork", cwd });
      expect(fork?.ok).toBe(true);
    } finally {
      abortController.abort();
      release();
      await iterator.return?.();
      await session.close?.();
    }
    const requests = readLog(log);
    const start = requests.find((request) => request.method === "thread/start");
    const controlFork = requests.find((request) => request.method === "thread/fork");
    expect(start).toBeDefined();
    expect(controlFork).toBeDefined();
    sites.push(siteOf("thread/start", start));
    sites.push(siteOf("control thread.fork", controlFork));
  }

  // thread/resume and thread/fork (forkSession).
  for (const variant of [
    { site: "thread/resume", method: "thread/resume", forkSession: false },
    { site: "thread/fork", method: "thread/fork", forkSession: true },
  ]) {
    const log = join(cwd, `${variant.method.replace("/", "-")}.jsonl`);
    writeFileSync(log, "");
    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession({
      prompt: prompt("again"),
      model: "gpt-5",
      cwd,
      agentId,
      resume: "thread_parent",
      forkSession: variant.forkSession,
      abortController: new AbortController(),
      systemPromptAppend: "",
      env: env(log),
    });
    for await (const _event of session.events) {
      // drain
    }
    await session.close?.();
    const request = readLog(log).find((entry) => entry.method === variant.method);
    expect(request).toBeDefined();
    sites.push(siteOf(variant.site, request));
  }
  return sites;
}

function siteOf(site: string, request: LoggedRequest | undefined): SiteConfig {
  return {
    site,
    sandbox: request?.params.sandbox,
    config: (request?.params.config as Record<string, unknown> | null | undefined) ?? null,
  };
}

/** Reads `codex exec` arguments the way codex does: `--sandbox`, the bypass flag and `-c key=value` (`sandbox_mode` included). */
function execSite(args: string[]): SiteConfig {
  let sandbox: string | null = null;
  const config: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dangerously-bypass-approvals-and-sandbox") sandbox = "danger-full-access";
    if (arg === "--sandbox" || arg === "-s") sandbox = args[index + 1] ?? null;
    if (arg === "-c") {
      const pair = args[index + 1] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const raw = pair.slice(eq + 1);
        let value: unknown = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
        config[pair.slice(0, eq)] = value;
      }
    }
  }
  if (typeof config.sandbox_mode === "string") sandbox = config.sandbox_mode;
  return { site: "codex exec", sandbox, config };
}

function usable(site: SiteConfig): string[] {
  return codexUsableNativeTools({ sandbox: site.sandbox as string, config: site.config }).sort();
}

const ALLOWED = [...CODEX_KNOWLEDGE_ALLOWED_TOOLS].sort();

describe("codex native tools parity (Knowledge)", () => {
  for (const profile of [
    { label: "chat-only", runtimePermissions: { profile: "chat-only" } },
    {
      label: "explicit-only without exec",
      runtimePermissions: { profile: "explicit-only", capabilities: ["read:knowledge:*"] },
    },
  ]) {
    it(`${profile.label}: every site advertises exactly the allowed tools`, async () => {
      setProfile("reception", profile.runtimePermissions);
      const sites = [
        ...(await captureAppServerSites("reception")),
        execSite(buildCodexExecArgs(undefined, "gpt-5", undefined, "reception")),
      ];
      expect(sites.map((site) => site.site)).toEqual([
        "thread/start",
        "control thread.fork",
        "thread/resume",
        "thread/fork",
        "codex exec",
      ]);
      for (const site of sites) {
        expect({ site: site.site, tools: usable(site) }).toEqual({ site: site.site, tools: ALLOWED });
        expect({ site: site.site, sandbox: site.sandbox }).toEqual({ site: site.site, sandbox: "read-only" });
      }
      expect(execSite(buildCodexExecArgs("thread_parent", "gpt-5", undefined, "reception")).sandbox).toBe("read-only");
    }, 30_000);
  }

  it("other profiles keep danger-full-access and every native tool", async () => {
    for (const runtimePermissions of [
      null,
      { profile: "full-access" },
      { profile: "bootstrap" },
      { profile: "explicit-only", capabilities: ["use:tool:Bash", "execute:executable:ravi", "read:knowledge:*"] },
    ]) {
      setProfile("operator", runtimePermissions);
      const sites = [
        ...(await captureAppServerSites("operator")),
        execSite(buildCodexExecArgs(undefined, "gpt-5", undefined, "operator")),
      ];
      for (const site of sites) {
        expect({ site: site.site, sandbox: site.sandbox }).toEqual({ site: site.site, sandbox: "danger-full-access" });
        expect(usable(site)).toEqual([...CODEX_NATIVE_TOOLS].sort());
      }
    }
  }, 60_000);

  it("codexKnowledgeParityHolds checks the builder and the hook matcher stays global", () => {
    expect(codexKnowledgeParityHolds()).toBe(true);
    expect(RAVI_CODEX_BASH_HOOK_MATCHER).toBe("^(Bash|shell)$");
  });
});
