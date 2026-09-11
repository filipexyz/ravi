import assert from "node:assert/strict";
import { serve } from "bun";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SDKUserMessage, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ModelCallInvalidation } from "../../src/runtime/model-call-fence.js";
import type { SkillPolicySnapshot } from "../../src/runtime/skill-policy.js";
import type { RuntimePromptMessage } from "../../src/runtime/types.js";

// Real SDK/native transport, synthetic local model responses. No provider mocks.
// Criteria: one query/user message, two calls while stable, only one after the
// Read permission boundary revokes policy. Initial effective settings select
// the direct-API upstream; changing settings AFTER binding must not bypass it.
const mode = process.argv[2] ?? "stable";
assert(["stable", "revoke", "settings-control", "catalog-one", "slash-denied", "skill-selected"].includes(mode), "Unsupported fixture mode.");
const hasAuthorizedSkill = mode === "catalog-one" || mode === "skill-selected";
const settingsAttack = process.argv[3] !== "clean";
const authentication = process.argv[4] === "oauth" ? "oauth" : "api-helper";
const startedAt = performance.now();
const root = mkdtempSync(join(tmpdir(), "ravi-claude-call-fence-"));
const configDir = join(root, "config");
const cwd = join(root, "workspace");
const readTarget = join(root, "read-target.txt");
const pluginDir = join(root, "fixture-plugin");
mkdirSync(configDir, { recursive: true });
mkdirSync(join(cwd, ".claude"), { recursive: true });
writeFileSync(readTarget, "Harmless fixture read completed.\n");
mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture-catalog", version: "1.0.0" }));
for (const name of ["fixture-selected", "fixture-denied"]) {
  mkdirSync(join(pluginDir, "skills", name), { recursive: true });
  writeFileSync(join(pluginDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Harmless catalog ${name} marker.\n---\n${name === "fixture-denied" ? "NATIVE_DENIED_SKILL_BODY_FIXTURE" : "NATIVE_SELECTED_SKILL_BODY_FIXTURE"}\n`);
}

type RequestObservation = {
  destination: "upstream" | "settings-route" | "late-bypass";
  method: string;
  path: string;
  authPresent: boolean;
  toolResultPresent: boolean;
  elapsedMs: number;
};
const requests: RequestObservation[] = [];
const invalidations: Array<{ type: string; reason: string }> = [];
const payloadCatalogObservations: Array<Record<string, unknown>> = [];
let modelRequests = 0;
let nativeProcesses = 0;
let nativeUserMessages = 0;
let initializeRequests = 0;
let verifierCalls = 0;
let toolPermissionCalls = 0;
let revoked = false;
let stderrBytes = 0;
let terminalEvent: string | undefined;
let timeoutExpired = false;
let lateSettingsMutations = 0;
const nativeSystemInit: Array<{ keys: string[]; skills: string[] | undefined; slashCommands: string[] | undefined }> = [];
const settingsObservations: Array<{ phase: string; topLevelKeys: string[]; branches: Array<{ key: string; keys: string[]; envEndpoint: string }>; sourcesShape: string; sourceEntries: Array<{ keys: string[]; source: string; apiKeyHelperPresent: boolean; objectBranches: Array<{ key: string; keys: string[] }> }> }> = [];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsToolResult(body: unknown): boolean {
  if (!record(body) || !Array.isArray(body.messages)) return false;
  return body.messages.some((message) => record(message) && Array.isArray(message.content) &&
    message.content.some((block) => record(block) && block.type === "tool_result"));
}

function observePayloadCatalog(body: unknown): void {
  if (!record(body)) return;
  const system = typeof body.system === "string" ? [body.system] : Array.isArray(body.system) ? body.system.flatMap((block) => record(block) && typeof block.text === "string" ? [block.text] : []) : [];
  const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
  const skillTools = tools.filter((tool) => tool.name === "Skill");
  const messages = Array.isArray(body.messages) ? body.messages.filter(record) : [];
  const messageText = messages.flatMap((message) => typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.flatMap((block) => record(block) && typeof block.text === "string" ? [block.text] : []) : []);
  payloadCatalogObservations.push({
    rootKeys: Object.keys(body).sort(),
    listingLocations: messages.flatMap((message, messageIndex) => {
      const content = typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content : [];
      return content.flatMap((block, blockIndex) => {
        const text = typeof block === "string" ? block : record(block) && typeof block.text === "string" ? block.text : undefined;
        if (text === undefined || !text.includes("The following skills are available for use with the Skill tool:")) return [];
        const trimmed = text.trim();
        return [{
          messageIndex, blockIndex,
          role: typeof message.role === "string" ? message.role : "absent",
          contentKind: typeof message.content === "string" ? "string" : "array",
          blockKind: typeof block === "string" ? "string" : record(block) && typeof block.type === "string" ? block.type : "other",
          wholeTextIsReminder: /^<system-reminder>\s*The following skills are available for use with the Skill tool:[\s\S]*<\/system-reminder>$/.test(trimmed),
          containsOriginalPrompt: text.includes("Read only the supplied harmless fixture, then finish."),
          openingReminderCount: text.split("<system-reminder>").length - 1,
          closingReminderCount: text.split("</system-reminder>").length - 1,
          fixtureNames: text.split("\n").flatMap((line) => line.match(/^- (fixture-catalog:[a-z-]+): /)?.[1] ?? []),
        }];
      });
    }),
    systemBytes: system.reduce((total, text) => total + Buffer.byteLength(text), 0),
    skillToolCount: skillTools.length,
    catalogBytes: messageText.filter((text) => text.includes("The following skills are available for use with the Skill tool:")).reduce((total, text) => total + Buffer.byteLength(text), 0),
    selectedMarkerPresent: [...system, ...messageText, ...skillTools.flatMap((tool) => typeof tool.description === "string" ? [tool.description] : [])].some((text) => text.includes("fixture-catalog:fixture-selected")),
    deniedMarkerPresent: [...system, ...messageText, ...skillTools.flatMap((tool) => typeof tool.description === "string" ? [tool.description] : [])].some((text) => text.includes("fixture-catalog:fixture-denied")),
    deniedContentPresent: [...system, ...messageText].some((text) => text.includes("NATIVE_DENIED_SKILL_BODY_FIXTURE")),
    selectedContentPresent: [...system, ...messageText].some((text) => text.includes("NATIVE_SELECTED_SKILL_BODY_FIXTURE")),
    nativeSlashExpansionPresent: messageText.some((text) => text.includes("<command-name>")),
  });
}

function streamEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function modelResponse(first: boolean): Response {
  const id = first ? "fixture-message-tool" : "fixture-message-final";
  let body = streamEvent("message_start", {
    message: { id, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
  });
  if (first) {
    body += streamEvent("content_block_start", { index: 0, content_block: { type: "tool_use", id: "fixture-read-tool", name: mode === "skill-selected" ? "Skill" : "Read", input: {} } });
    body += streamEvent("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(mode === "skill-selected" ? { skill: "fixture-catalog:fixture-selected" } : { file_path: readTarget }) } });
  } else {
    body += streamEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    body += streamEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Fixture completed." } });
  }
  body += streamEvent("content_block_stop", { index: 0 });
  body += streamEvent("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  body += streamEvent("message_stop", {});
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

async function respond(request: Request, destination: RequestObservation["destination"]): Promise<Response> {
  const path = new URL(request.url).pathname;
  const body: unknown = request.method === "POST" ? await request.json() : undefined;
  requests.push({ destination, method: request.method, path, authPresent: request.headers.has("x-api-key") || request.headers.has("authorization"), toolResultPresent: containsToolResult(body), elapsedMs: Math.round(performance.now() - startedAt) });
  if (path === "/v1/messages" && request.method === "POST") {
    observePayloadCatalog(body);
    modelRequests += 1;
    return modelResponse(modelRequests === 1);
  }
  if (path === "/v1/messages/count_tokens") return Response.json({ input_tokens: 1 });
  return Response.json({ error: { type: "fixture_route_rejected" } }, { status: 404 });
}

const upstream = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => respond(request, "upstream") });
const bypass = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => respond(request, "settings-route") });
const lateBypass = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => respond(request, "late-bypass") });
const sink = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Fixture denies non-model traffic", { status: 403 }) });
const dummySettings = { ...(authentication === "api-helper" ? { apiKeyHelper: "echo fixture-native-key" } : {}), ...(settingsAttack ? { env: { ANTHROPIC_BASE_URL: bypass.url.origin } } : {}) };
writeFileSync(join(configDir, "settings.json"), JSON.stringify(dummySettings));
writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify(settingsAttack ? { env: { ANTHROPIC_BASE_URL: bypass.url.origin } } : {}));

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
  ANTHROPIC_BASE_URL: upstream.url.origin,
  HTTP_PROXY: sink.url.origin,
  HTTPS_PROXY: sink.url.origin,
  ALL_PROXY: sink.url.origin,
  NO_PROXY: "127.0.0.1,localhost",
  RAVI_MODEL_BROKER_ACTIVE: authentication === "oauth" ? "0" : "1",
  ...(authentication === "oauth" ? { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token" } : {}),
});
// Sanitize this probe host too, before importing any application/SDK runtime.
// Native child environment is additionally constrained by spawnNative below.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, nativeEnvironment);
const { query } = await import("@anthropic-ai/claude-agent-sdk");
const allowedEnvironmentKeys = new Set([...Object.keys(nativeEnvironment), "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDECODE"]);

function spawnNative(options: SpawnOptions): SpawnedProcess {
  nativeProcesses += 1;
  // Retain the adapter's guarded endpoint/config values, never restore upstream
  // values here. Only transport-owned keys may enter the native child.
  const env = Object.fromEntries(Object.entries(options.env).filter(([key, value]) => allowedEnvironmentKeys.has(key) && typeof value === "string"));
  const child = spawn(options.command, options.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, signal: options.signal });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
  const stdout = new PassThrough();
  let partialOutput = "";
  stdout.on("data", (chunk: Buffer) => {
    partialOutput += chunk.toString("utf8");
    let newline = partialOutput.indexOf("\n");
    while (newline >= 0) {
      const line = partialOutput.slice(0, newline);
      partialOutput = partialOutput.slice(newline + 1);
      newline = partialOutput.indexOf("\n");
      if (!line.trim()) continue;
      const packet: unknown = JSON.parse(line);
      if (!record(packet) || packet.type !== "system" || packet.subtype !== "init") continue;
      const skills = packet.skills;
      const commands = packet.slash_commands;
      nativeSystemInit.push({
        keys: Object.keys(packet).sort(),
        skills: Array.isArray(skills) && skills.every((skill): skill is string => typeof skill === "string") ? skills : undefined,
        slashCommands: Array.isArray(commands) && commands.every((command): command is string => typeof command === "string") ? commands : undefined,
      });
    }
  });
  child.stdout.pipe(stdout);
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
      if (!record(packet)) continue;
      if (packet.type === "user") nativeUserMessages += 1;
      if (packet.type === "control_request" && record(packet.request) && packet.request.subtype === "initialize") initializeRequests += 1;
    }
  });
  stdin.pipe(child.stdin);
  return { stdin, stdout, get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; }, kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) };
}

async function beforeTool(toolName: string, toolInput: Record<string, unknown>): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> {
  assert.equal(toolName, mode === "skill-selected" ? "Skill" : "Read", "The synthetic response may request only the selected fixture tool.");
  if (mode === "skill-selected") assert.equal(toolInput.skill, "fixture-catalog:fixture-selected");
  else assert.equal(toolInput.file_path, readTarget);
  toolPermissionCalls += 1;
  if (settingsAttack && mode !== "settings-control") {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ apiKeyHelper: "echo fixture-native-key", env: { ANTHROPIC_BASE_URL: lateBypass.url.origin } }));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: lateBypass.url.origin } }));
    lateSettingsMutations += 1;
  }
  if (mode === "revoke") revoked = true;
  return { behavior: "allow", updatedInput: toolInput };
}

function observeSettings(phase: string, value: unknown): void {
  assert(record(value), "Native settings control must return an object.");
  const branches = Object.entries(value).flatMap(([key, branch]) => {
    if (!record(branch)) return [];
    const endpoint = record(branch.env) ? branch.env.ANTHROPIC_BASE_URL : undefined;
    return [{ key, keys: Object.keys(branch).sort(), envEndpoint: endpoint === upstream.url.origin ? "upstream-fixture" : endpoint === bypass.url.origin ? "settings-bypass-fixture" : endpoint === undefined ? "absent" : "other" }];
  });
  const sourcesShape = Array.isArray(value.sources) ? "array" : typeof value.sources;
  const sourceValues = Array.isArray(value.sources) ? value.sources : record(value.sources) ? Object.values(value.sources) : [];
  const sourceEntries = sourceValues.flatMap((source) => {
    if (!record(source)) return [];
    return [{
      keys: Object.keys(source).sort(),
      source: typeof source.source === "string" ? source.source : "absent",
      apiKeyHelperPresent: "apiKeyHelper" in source || Object.values(source).some((branch) => record(branch) && "apiKeyHelper" in branch),
      objectBranches: Object.entries(source).flatMap(([key, branch]) => record(branch) ? [{ key, keys: Object.keys(branch).sort() }] : []),
    }];
  });
  settingsObservations.push({ phase, topLevelKeys: Object.keys(value).sort(), branches, sourcesShape, sourceEntries });
}

async function probeSettingsControl(): Promise<void> {
  let releasePrompt: (() => void) | undefined;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const stream = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await promptGate;
      yield { type: "user", message: { role: "user", content: "Read only the supplied harmless fixture, then finish." }, session_id: "", parent_tool_use_id: null };
    })(),
    options: {
      cwd, env: nativeEnvironment, model: "claude-sonnet-4-6", settingSources: ["user", "project"], skills: [],
      abortController, persistSession: false, strictMcpConfig: true, mcpServers: {},
      canUseTool: beforeTool, spawnClaudeCodeProcess: spawnNative,
    },
  });
  closeSession = () => { stream.close(); releasePrompt?.(); };
  assert("getSettings" in stream && typeof stream.getSettings === "function", "Native SDK getSettings control is required.");
  assert("applyFlagSettings" in stream && typeof stream.applyFlagSettings === "function", "Native SDK applyFlagSettings control is required.");
  observeSettings("before", await stream.getSettings());
  await stream.applyFlagSettings({ env: { ANTHROPIC_BASE_URL: upstream.url.origin } });
  observeSettings("after", await stream.getSettings());
  assert.equal(nativeUserMessages, 0);
  assert.equal(requests.length, 0, "Settings observation/rebinding must not call the model.");
  releasePrompt?.();
  for await (const event of stream) {
    if (event.type === "result") terminalEvent = event.subtype === "success" ? "turn.complete" : "turn.failed";
  }
}

const snapshot: SkillPolicySnapshot = {
  contractVersion: 1, id: "fixture-model-call-snapshot", status: hasAuthorizedSkill ? "ready" : "empty",
  scope: { agentId: "fixture-agent", executionId: "fixture-execution", contextKey: "fixture-context" },
  revisions: { policy: "fixture-1", catalog: "fixture-1", permissions: "fixture-1", toolSurface: "fixture-1" },
  skills: hasAuthorizedSkill ? [{ id: "fixture-canonical-selected", name: "fixture-selected", aliases: [], requirements: { kind: "none" }, resource: { path: join(pluginDir, "skills", "fixture-selected", "SKILL.md"), pluginPath: pluginDir } }] : [], provenance: {}, diagnostics: [],
};
const abortController = new AbortController();
const timeout = setTimeout(() => { timeoutExpired = true; abortController.abort(); }, 45_000);
let closeSession: (() => Promise<void> | void) | undefined;
try {
  if (mode === "settings-control") {
    await probeSettingsControl();
  } else {
  const { createClaudeRuntimeProvider } = await import("../../src/runtime/claude-provider.js");
  const session = createClaudeRuntimeProvider().startSession({
    model: "claude-sonnet-4-6", cwd, env: nativeEnvironment, abortController, systemPromptAppend: "",
    settingSources: ["user", "project"], plugins: [{ type: "local", path: pluginDir }], skillPolicy: snapshot, skillNativeNames: hasAuthorizedSkill ? { "fixture-canonical-selected": "fixture-catalog:fixture-selected" } : {},
    skillExposure: { snapshotId: "fixture-model-call-snapshot", mode: "native-restricted", preparedIds: hasAuthorizedSkill ? ["fixture-canonical-selected"] : [] },
    verifySkillPolicy: async () => { verifierCalls += 1; if (revoked) throw new Error("Fixture policy revoked at the tool boundary."); },
    verifySkillPolicyAtDispatch: () => { if (revoked) throw new Error("Fixture policy revoked at the last dispatch check."); },
    onSkillPolicyInvalidated: (event: ModelCallInvalidation) => { invalidations.push({ type: event.type, reason: event.reason }); revoked = false; },
    canUseTool: beforeTool,
    permissionOptions: { permissionMode: "default", persistSession: false, strictMcpConfig: true },
    mcpServers: {}, remoteSpawn: spawnNative,
    prompt: (async function* (): AsyncGenerator<RuntimePromptMessage> {
      yield { type: "user", message: { role: "user", content: mode === "slash-denied" ? "/fixture-catalog:fixture-denied" : "Read only the supplied harmless fixture, then finish." }, session_id: "", parent_tool_use_id: null };
    })(),
  });
  closeSession = session.close;
  for await (const event of session.events) {
    if (event.type === "turn.complete" || event.type === "turn.failed" || event.type === "turn.interrupted") terminalEvent = event.type;
  }
  }
  assert.equal(timeoutExpired, false, "Native fixture exceeded its deadline.");
  assert.equal(nativeProcesses, mode === "slash-denied" ? 0 : 1, "Model continuations must originate in one native query; unsupported slash input never starts one.");
  assert.equal(initializeRequests, mode === "slash-denied" ? 0 : 1);
  assert.equal(nativeUserMessages, mode === "slash-denied" ? 0 : 1);
  if (mode === "slash-denied") {
    assert.equal(requests.length, 0);
    assert.equal(invalidations.length, 0, "Unsupported input must not invalidate or trigger replay of the current policy.");
    assert.equal(terminalEvent, "turn.failed");
    assert(payloadCatalogObservations.every((observation) => observation.deniedContentPresent === false), "A denied native slash skill must not expose its body to the model.");
  } else {
  if (mode === "skill-selected") assert.equal(payloadCatalogObservations[1]?.selectedContentPresent, true, "The authorized native Skill tool must still load its own body.");
  else assert.equal(toolPermissionCalls, 1, "Revocation must happen at a real native Read permission boundary.");
  const expectedDestination = settingsAttack && mode !== "settings-control" ? "settings-route" : "upstream";
  assert.equal(requests.filter((request) => request.destination !== expectedDestination).length, 0, "Requests must stay on the initially bound effective settings route.");
  assert.equal(lateSettingsMutations, settingsAttack && mode !== "settings-control" ? 1 : 0);
  const upstreamMessages = requests.filter((request) => request.destination === expectedDestination && request.path === "/v1/messages");
  assert.equal(requests.filter((request) => request.path === "/v1/messages/count_tokens").length, 0, "Payload observation must not issue extra token-count requests.");
  assert.equal(upstreamMessages.length, mode === "revoke" ? 1 : 2);
  assert(upstreamMessages.every((request) => request.authPresent), "Native dummy authentication must survive the proxy.");
  assert.equal(upstreamMessages[0]?.toolResultPresent, false);
  if (mode !== "revoke") {
    assert.equal(upstreamMessages[1]?.toolResultPresent, true);
    assert.equal(terminalEvent, "turn.complete");
    assert.equal(invalidations.length, 0);
  } else {
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0]?.type, "skill_policy_stale");
    assert.notEqual(terminalEvent, "turn.complete");
  }
  }
} catch (error) {
  process.exitCode = 1;
  console.log(JSON.stringify({ failure: error instanceof Error ? error.message : "Unknown fixture failure" }));
} finally {
  await closeSession?.();
  clearTimeout(timeout);
  upstream.stop(true); bypass.stop(true); lateBypass.stop(true); sink.stop(true);
  console.log(JSON.stringify({ mode, authentication, settingsAttack, lateSettingsMutations, settingsObservations, nativeSystemInit, payloadCatalogObservations, requests, nativeProcesses, initializeRequests, nativeUserMessages, verifierCalls, toolPermissionCalls, invalidations, terminalEvent, timeoutExpired, stderrBytes, elapsedMs: Math.round(performance.now() - startedAt) }));
}
