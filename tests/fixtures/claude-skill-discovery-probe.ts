import assert from "node:assert/strict";
import { serve } from "bun";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Options, SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { SkillPolicySnapshot } from "../../src/runtime/skill-policy.js";
import type { RuntimePromptMessage } from "../../src/runtime/types.js";

// Characterization only: initialize native discovery without releasing a prompt.
// Fixtures are intentionally retained; no personal files or credentials are read.
const root = mkdtempSync(join(tmpdir(), "ravi-claude-native-discovery-"));
const configDir = join(root, "config");
const cwd = join(root, "workspace");
const pluginDir = join(root, "plugin");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0" }));

function createSkill(parent: string, name: string): void {
  const skillDir = join(parent, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Harmless native discovery fixture.\n---\nFixture only.\n`);
}

createSkill(join(configDir, "skills"), "fixture-user-denied");
createSkill(join(cwd, ".claude", "skills"), "fixture-project-denied");
createSkill(join(pluginDir, "skills"), "fixture-allowed");
createSkill(join(pluginDir, "skills"), "fixture-plugin-denied");

let networkRequests = 0;
let tokenCountRequests = 0;
let adapterProbeActive = false;
let nativeUserMessages = 0;
const initializedSkillFilters: Array<string[] | undefined> = [];
const networkSink = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    networkRequests += 1;
    if (new URL(request.url).pathname === "/v1/messages/count_tokens") tokenCountRequests++;
    if (adapterProbeActive && new URL(request.url).pathname === "/v1/messages") {
      const message = { id: "fixture-reply", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
      const events = [
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "Fixture complete." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("Native discovery fixture denies network requests.", { status: 403 });
  },
});

const nativeEnvironment: Record<string, string> = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
  const value = process.env[key];
  if (value !== undefined) nativeEnvironment[key] = value;
}
Object.assign(nativeEnvironment, {
  CLAUDE_CONFIG_DIR: configDir,
  HOME: root,
  USERPROFILE: root,
  APPDATA: join(root, "AppData", "Roaming"),
  LOCALAPPDATA: join(root, "AppData", "Local"),
  CODEX_HOME: join(root, ".codex"),
  RAVI_STATE_DIR: join(root, "ravi-state"),
  CLAUDE_CODE_GIT_BASH_PATH: "C:/Program Files/Git/bin/bash.exe",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  ANTHROPIC_BASE_URL: networkSink.url.origin,
  HTTP_PROXY: networkSink.url.origin,
  HTTPS_PROXY: networkSink.url.origin,
  ALL_PROXY: networkSink.url.origin,
  NO_PROXY: "127.0.0.1,localhost",
  RAVI_MODEL_BROKER_ACTIVE: "1",
});
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, nativeEnvironment);
const { query } = await import("@anthropic-ai/claude-agent-sdk");

function spawnNative(options: SpawnOptions): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: nativeEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    signal: options.signal,
  });
  const stdin = new PassThrough();
  let partialLine = "";
  stdin.on("data", (chunk: Buffer) => {
    partialLine += chunk.toString("utf8");
    let newline = partialLine.indexOf("\n");
    while (newline >= 0) {
      const line = partialLine.slice(0, newline);
      partialLine = partialLine.slice(newline + 1);
      newline = partialLine.indexOf("\n");
      if (!line.trim()) continue;
      const packet: unknown = JSON.parse(line);
      if (typeof packet !== "object" || packet === null || !("type" in packet)) continue;
      if (packet.type === "user") nativeUserMessages += 1;
      if (packet.type !== "control_request" || !("request" in packet)) continue;
      const request = packet.request;
      if (typeof request !== "object" || request === null || !("subtype" in request) || request.subtype !== "initialize") continue;
      if (!("skills" in request)) {
        initializedSkillFilters.push(undefined);
        continue;
      }
      const names = request.skills;
      assert(Array.isArray(names) && names.every((name): name is string => typeof name === "string"));
      initializedSkillFilters.push(names);
    }
  });
  stdin.pipe(child.stdin);
  return {
    stdin,
    stdout: child.stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

async function probeAdapter(name: "adapter-empty" | "adapter-qualified"): Promise<void> {
  // Observe the effective request through the real adapter and a local fake API.
  adapterProbeActive = true;
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ apiKeyHelper: "echo fixture-native-key" }));
  const { createClaudeRuntimeProvider } = await import("../../src/runtime/claude-provider.js");
  const isEmpty = name === "adapter-empty";
  const snapshot: SkillPolicySnapshot = {
    contractVersion: 1,
    id: `fixture-${name}`,
    status: isEmpty ? "empty" : "ready",
    scope: { agentId: "fixture-agent", executionId: name, contextKey: "fixture-context" },
    revisions: { policy: "fixture-1", catalog: "fixture-1", permissions: "fixture-1", toolSurface: "fixture-1" },
    skills: isEmpty ? [] : [{
      id: "fixture-canonical-allowed",
      aliases: [],
      name: "fixture-allowed",
      requirements: { kind: "none" },
      resource: { path: join(pluginDir, "skills", "fixture-allowed", "SKILL.md"), pluginPath: pluginDir },
    }],
    provenance: {},
    diagnostics: [],
  };
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 20_000);
  const session = createClaudeRuntimeProvider().startSession({
    model: "claude-sonnet-4-6",
    cwd,
    env: nativeEnvironment,
    abortController,
    systemPromptAppend: "",
    settingSources: ["user", "project"],
    plugins: [{ type: "local", path: pluginDir }],
    skillPolicy: snapshot,
    skillNativeNames: isEmpty ? {} : { "fixture-canonical-allowed": "fixture-plugin:fixture-allowed" },
    skillExposure: {
      snapshotId: `fixture-${name}`,
      mode: "native-restricted",
      preparedIds: isEmpty ? [] : ["fixture-canonical-allowed"],
    },
    verifySkillPolicy: async () => {},
    verifySkillPolicyAtDispatch: () => {},
    onSkillPolicyInvalidated: () => {},
    permissionOptions: { persistSession: false, strictMcpConfig: true },
    mcpServers: {},
    remoteSpawn: spawnNative,
    prompt: (async function* (): AsyncGenerator<RuntimePromptMessage> {
      yield { type: "user", message: { role: "user", content: "Reply with the harmless fixture response." }, session_id: "", parent_tool_use_id: null };
    })(),
  });
  const events = session.events[Symbol.asyncIterator]();
  try {
    let observed: Record<string, unknown> | undefined;
    for (;;) {
      const next = await events.next();
      if (next.done) break;
      if (next.value.type === "provider.raw" && next.value.rawEvent.type === "skill.exposure.observed") {
        observed = next.value.rawEvent;
        break;
      }
    }
    assert(observed, "The adapter must emit its actual payload observation.");
    assert.equal(observed.type, "skill.exposure.observed");
    assert.equal(observed.snapshotId, `fixture-${name}`);
    assert.equal(observed.mode, "native-restricted");
    assert.equal(observed.evidence, "effective-prompt");
    // Expected IDs are fixture literals, not values copied from the snapshot.
    assert.deepEqual(observed.advertisedIds, isEmpty ? [] : ["fixture-canonical-allowed"]);
    assert.deepEqual(observed.discoverableIds, isEmpty ? [] : ["fixture-canonical-allowed"]);
    assert.deepEqual(initializedSkillFilters, isEmpty ? [[]] : [["fixture-plugin:fixture-allowed"]]);
    assert.equal(nativeUserMessages, 1);
    assert.equal(networkRequests, 1);
    assert.equal(tokenCountRequests, 0);
    console.log(JSON.stringify({ case: name, observed, initializedSkillFilters, nativeUserMessages, networkRequests, tokenCountRequests }));
  } finally {
    await session.close?.();
    await events.return?.();
    clearTimeout(timeout);
  }
  assert.equal(nativeUserMessages, 1);
  assert.equal(networkRequests, 1, "Observation must not issue model/counting requests of its own.");
}

const cases: ReadonlyArray<{ name: string; skills?: Options["skills"] }> = [
  { name: "default" },
  { name: "empty", skills: [] },
  { name: "qualified", skills: ["fixture-plugin:fixture-allowed"] },
  { name: "bare", skills: ["fixture-allowed"] },
  { name: "all", skills: "all" },
];
const selected = process.argv[2];
const chosen = selected ? cases.filter((entry) => entry.name === selected) : cases;
const deadline = performance.now() + 45_000;

try {
  if (selected === "adapter-empty" || selected === "adapter-qualified") {
    await probeAdapter(selected);
  } else {
  if (chosen.length === 0) throw new Error("Unknown probe case");
  for (const entry of chosen) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new Error("Native discovery probe deadline exceeded");
    const abortController = new AbortController();
    let releasePrompt: (() => void) | undefined;
    const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    async function* withheldPrompt(): AsyncGenerator<SDKUserMessage> { await promptGate; }
    let stderrBytes = 0;
    const started = performance.now();
    const stream = query({
      prompt: withheldPrompt(),
      options: {
        cwd,
        env: nativeEnvironment,
        settingSources: ["project", "user"],
        plugins: [{ type: "local", path: pluginDir }],
        ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {},
        abortController,
        stderr: (data) => { stderrBytes += data.length; },
        spawnClaudeCodeProcess: (options) => spawn(options.command, options.args, {
          cwd: options.cwd,
          env: nativeEnvironment,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          signal: options.signal,
        }),
      },
    });
    const timeout = setTimeout(() => abortController.abort(), Math.min(20_000, remainingMs));
    try {
      const commands = await stream.supportedCommands();
      const reloaded = await stream.reloadSkills();
      const refreshed = await stream.supportedCommands();
      const contextUsage = await stream.getContextUsage();
      console.log(JSON.stringify({
        case: entry.name,
        commands: commands.map((command) => command.name),
        commandKeys: [...new Set(commands.flatMap((command) => Object.keys(command)))].sort(),
        reloadKeys: Object.keys(reloaded).sort(),
        reloadCommands: reloaded.skills.map((command) => command.name),
        refreshed: refreshed.map((command) => command.name),
        contextUsage: {
          keys: Object.keys(contextUsage).sort(),
          totalTokens: contextUsage.totalTokens,
          categories: contextUsage.categories?.map((category) => ({ name: category.name, tokens: category.tokens })),
          skills: contextUsage.skills,
          slashCommands: contextUsage.slashCommands,
          systemTools: contextUsage.systemTools?.map((tool) => tool.name),
          deferredBuiltinTools: contextUsage.deferredBuiltinTools?.map((tool) => ({ name: tool.name, isLoaded: tool.isLoaded })),
        },
        elapsedMs: Math.round(performance.now() - started),
        stderrBytes,
        networkRequests,
        promptReleased: false,
      }));
    } catch (error) {
      console.log(JSON.stringify({ case: entry.name, errorType: error instanceof Error ? error.name : typeof error, stderrBytes, networkRequests, elapsedMs: Math.round(performance.now() - started), promptReleased: false }));
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
      stream.close();
      releasePrompt?.();
    }
  }
  }
} finally {
  networkSink.stop(true);
}
