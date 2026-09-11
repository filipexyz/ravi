import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { SkillPolicySnapshot } from "../../../src/runtime/skill-policy.js";
import type { RuntimeStartRequest, RuntimeSessionState, RuntimePlugin } from "../../../src/runtime/types.js";

const inputSchema = z.object({ input: z.array(z.object({ content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }).passthrough())]).optional() }).passthrough()) });

type FixtureMode = "between-turns" | "after-tool-result" | "after-tool-revocation" | "retry-revocation" | "retry-success" | "native-oauth" | "native-apikey" | "resume" | "selected" | "native-mention";

async function runAdapterFixture(mode: FixtureMode) {
  const { createCodexRuntimeProvider } = await import("../../../src/runtime/codex-provider.js");
  const { ensureCodexBashHookConfig } = await import("../../../src/runtime/codex-hooks.js");
  const { buildSkillExposureText, inspectSkillExposureText } = await import("../../../src/runtime/skill-exposure-text.js");
  const { buildSkillPolicySessionBinding } = await import("../../../src/runtime/skill-policy-lifecycle.js");
  const command = Bun.which("codex");
  if (!command) throw new Error("Local Codex is required for the isolated adapter fixture.");
  const root = mkdtempSync(join(tmpdir(), "ravi-codex-adapter-fence-"));
  const cwd = join(root, "repo");
  const codexHome = join(root, "home", ".codex");
  const deniedDir = join(codexHome, "skills", "fixture-denied");
  const selectedPlugin = join(root, "materialized");
  const selectedPath = join(selectedPlugin, "skills", "fixture-selected", "SKILL.md");
  mkdirSync(cwd, { recursive: true }); mkdirSync(deniedDir, { recursive: true });
  writeFileSync(join(deniedDir, "SKILL.md"), "---\nname: fixture-denied\ndescription: Denied fixture.\n---\nRAVI_DENIED_SKILL_BODY_FIXTURE_92841\n");
  ensureCodexBashHookConfig(codexHome);
  let requests = 0;
  let nativeCatalogCount = -1;
  let verifierCalls = 0;
  let invalidations = 0;
  let policyCurrent = true;
  let websocketUpgrades = 0;
  let authorizationPresent = false;
  let accountPresent = false;
  let advertisedCount = -1;
  let deniedBodyPresent = false;
  const nativeAuth = mode === "native-oauth" || mode === "native-apikey";
  const retry = mode === "retry-revocation" || mode === "retry-success";
  const toolResult = mode === "after-tool-result" || mode === "after-tool-revocation";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.has("upgrade")) { websocketUpgrades++; return new Response("Fixture refuses WebSocket", { status: 426 }); }
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models")) return Response.json({ models: [] });
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) return new Response("Fixture", { status: 404 });
    requests++;
    authorizationPresent = request.headers.has("authorization");
    accountPresent = request.headers.has("chatgpt-account-id");
    const body = await request.text();
    const parsed = inputSchema.parse(JSON.parse(body));
    const inputText = parsed.input.flatMap((item) => typeof item.content === "string" ? [item.content] : (item.content ?? []).flatMap((part) => part.text ? [part.text] : [])).join("\n");
    nativeCatalogCount = inputText.split("\n").filter((line) => line.startsWith("- ") && line.includes("SKILL.md")).length;
    deniedBodyPresent = inputText.includes("RAVI_DENIED_SKILL_BODY_FIXTURE_92841");
    advertisedCount = inspectSkillExposureText(inputText, policy).advertisedIds.length;
    const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] };
    if (mode === "after-tool-revocation" || mode === "retry-revocation") policyCurrent = false;
    if (retry && requests === 1) return Response.json({ error: { message: "Synthetic retry" } }, { status: 500 });
    const item = toolResult ? { id: "fc_fixture", type: "function_call", call_id: "fixture-call", name: "fixture_unavailable_tool", arguments: "{}", status: "completed" } : message;
    if (mode === "after-tool-result") writeFileSync(join(deniedDir, "SKILL.md"), "---\nname: fixture-denied\ndescription: Denied fixture.\n---\nChanged fixture.\n");
    const response = { id: "resp_fixture", object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const providerConfig = nativeAuth ? [
    'model_provider="openai"', `openai_base_url="http://127.0.0.1:${server.port}/v1"`, `chatgpt_base_url="http://127.0.0.1:${server.port}/chatgpt"`, 'cli_auth_credentials_store="file"', 'model="gpt-5.4"', 'check_for_update_on_startup=false',
  ] : [
    'model_provider="fixture"', 'model="gpt-5.4"', 'check_for_update_on_startup=false',
    '[model_providers.fixture]', 'name="Fixture"', `base_url="http://127.0.0.1:${server.port}/v1"`, 'wire_api="responses"',
    'requires_openai_auth=false', 'supports_websockets=false', `request_max_retries=${retry ? 1 : 0}`, 'stream_max_retries=0',
  ];
  writeFileSync(join(codexHome, "config.toml"), [...providerConfig,
    '[features]', 'plugins=false', 'apps=false', 'remote_plugin=false', 'enable_request_compression=false',
    '[analytics]', 'enabled=false', '[feedback]', 'enabled=false',
  ].join("\n"));
  if (nativeAuth) {
    const claims = { sub: "fixture-user", exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture-user" } };
    const dummyJwt = [Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url"), "fixture"].join(".");
    const auth = mode === "native-oauth" ? { auth_mode: "chatgpt", tokens: { id_token: dummyJwt, access_token: dummyJwt, refresh_token: "fixture-not-a-token", account_id: "fixture-account" }, last_refresh: new Date().toISOString() } : { auth_mode: "apikey", OPENAI_API_KEY: "fixture-not-a-key" };
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify(auth));
  }
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = process.env[key]; if (value !== undefined) env[key] = value;
  }
  Object.assign(env, { CODEX_HOME: codexHome, HOME: join(root, "home"), USERPROFILE: join(root, "home"), RAVI_CODEX_TRANSPORT: "stdio", RUST_LOG: "error", TMP: root, TEMP: root, HTTP_PROXY: server.url.origin, HTTPS_PROXY: server.url.origin, ALL_PROXY: server.url.origin, NO_PROXY: "127.0.0.1,localhost", CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${server.url.origin}/oauth/token` });
  let policy: SkillPolicySnapshot = { contractVersion: 1, id: "fixture-policy", status: "empty", scope: { agentId: "fixture", executionId: "fixture-execution", contextKey: "fixture-context" }, revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" }, skills: [], provenance: {}, diagnostics: [] };
  const plugins: RuntimePlugin[] = [];
  if (mode === "selected") {
    mkdirSync(join(selectedPlugin, "skills", "fixture-selected"), { recursive: true });
    writeFileSync(selectedPath, "---\nname: fixture-selected\ndescription: Authorized fixture.\n---\nAuthorized fixture content.\n");
    plugins.push({ type: "local", path: selectedPlugin });
    policy = { ...policy, status: "ready", skills: [{ id: "fixture:selected", name: "fixture-selected", description: "Authorized fixture.", aliases: [], resource: { path: selectedPath } }] };
  }
  const provider = createCodexRuntimeProvider({ command });
  let prepared = await provider.prepareSession?.({ agentId: "fixture", cwd, skillPolicy: policy, skillExposureMode: "textual", plugins, skillNativeNames: {} });
  const prompt: RuntimeStartRequest["prompt"] = (async function* () {
    yield { type: "user", message: { role: "user", content: mode === "native-mention" ? "$fixture-denied Return the fixed fixture response without tools." : "Return the fixed fixture response without tools." }, session_id: "", parent_tool_use_id: null };
    if (mode !== "between-turns" && !nativeAuth) return;
    writeFileSync(join(deniedDir, "SKILL.md"), "---\nname: fixture-denied\ndescription: Denied fixture.\n---\nChanged fixture.\n");
    yield { type: "user", message: { role: "user", content: "Return the fixed fixture response again." }, session_id: "", parent_tool_use_id: null };
  })();
  const makeRequest = (nextPrompt: RuntimeStartRequest["prompt"]): RuntimeStartRequest => ({ cwd, model: "gpt-5.4", env, prompt: nextPrompt, abortController: new AbortController(), systemPromptAppend: buildSkillExposureText(policy), skillPolicy: policy, skillExposure: prepared?.skillExposure, plugins, skillNativeNames: {}, verifySkillPolicy: async () => { verifierCalls++; if (!policyCurrent) throw new Error("Fixture policy revoked"); }, verifySkillPolicyAtDispatch: () => { if (!policyCurrent) throw new Error("Fixture policy revoked"); }, onSkillPolicyInvalidated: () => { invalidations++; } });
  const handle = provider.startSession(makeRequest(prompt));
  let terminalFailures = 0;
  const failureCodes: string[] = [];
  let session: RuntimeSessionState | undefined;
  let completed = 0;
  try {
    for await (const event of handle.events) {
      if (event.type === "turn.failed") { terminalFailures++; failureCodes.push(event.error); }
      if (event.type === "turn.complete") { session = event.session; completed++; }
    }
    if (mode === "resume" && session) {
      await handle.close?.();
      policy = { ...policy, id: "fixture-policy-next", scope: { ...policy.scope, executionId: "fixture-execution-next" } };
      prepared = await provider.prepareSession?.({ agentId: "fixture", cwd, skillPolicy: policy, skillExposureMode: "textual", plugins, skillNativeNames: {} });
      session = { ...session, params: { ...session.params, skillPolicySession: buildSkillPolicySessionBinding(policy, policy.scope.contextKey) } };
      const resumed = provider.startSession({ ...makeRequest((async function* () { yield { type: "user", message: { role: "user", content: "Return the fixed fixture response after resuming." }, session_id: "", parent_tool_use_id: null }; })()), resumeSession: session });
      try {
        for await (const event of resumed.events) {
          if (event.type === "turn.failed") { terminalFailures++; failureCodes.push(event.error); }
          if (event.type === "turn.complete") completed++;
        }
      } finally { await resumed.close?.(); }
    }
    if (requests === 0) throw new Error(`No fixture request: ${failureCodes.join("; ")}`);
    expect(requests).toBe(mode === "retry-success" || mode === "resume" ? 2 : 1);
    expect(nativeCatalogCount).toBe(0);
    expect(deniedBodyPresent).toBe(false);
    expect(advertisedCount).toBe(mode === "selected" ? 1 : 0);
    expect(verifierCalls).toBeGreaterThanOrEqual(2);
    expect(terminalFailures).toBe(mode === "retry-success" || mode === "resume" || mode === "selected" || mode === "native-mention" ? 0 : 1);
    expect(invalidations).toBe(mode === "retry-success" || mode === "resume" || mode === "selected" || mode === "native-mention" ? 0 : 1);
    expect(websocketUpgrades).toBe(0);
    if (nativeAuth) { expect(authorizationPresent).toBe(true); expect(accountPresent).toBe(mode === "native-oauth"); }
    if (mode === "resume") expect(completed).toBe(2);
    if (mode === "selected") expect(readFileSync(selectedPath, "utf8")).toContain("Authorized fixture content.");
  } finally {
    await handle.close?.(); await server.stop(true);
    console.log(`RAVI_CODEX_FIXTURE_SUMMARY ${JSON.stringify({ mode, requests, nativeCatalogCount, advertisedCount, deniedBodyPresent, verifierCalls, terminalFailures, invalidations, completed, websocketUpgrades, authorizationPresent, accountPresent })}`);
  }
}

if (process.env.RAVI_CODEX_ADAPTER_TEST_CHILD !== "1") {
  test("real Codex adapter fixture runs with isolated hook, manifest and skill homes", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-codex-adapter-child-"));
    const env: Record<string, string> = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
      const value = process.env[key]; if (value !== undefined) env[key] = value;
    }
    Object.assign(env, { HOME: root, USERPROFILE: root, CODEX_HOME: join(root, ".codex"), TMP: root, TEMP: root, RAVI_CODEX_ADAPTER_TEST_CHILD: "1", RAVI_CODEX_ADAPTER_FIXTURE_ROOT: root });
    const rtk = Bun.which("rtk");
    if (!rtk) throw new Error("RTK is required for the isolated adapter test child.");
    const child = Bun.spawnSync([rtk, "proxy", process.execPath, "--no-env-file", "test", import.meta.path], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    const summaries = new TextDecoder().decode(child.stdout).split("\n").filter((line) => /^RAVI_CODEX_FIXTURE_SUMMARY \{/.test(line));
    for (const summary of summaries) console.log(summary);
    if (child.exitCode !== 0) {
      const codes = new TextDecoder().decode(child.stderr).match(/Protected Codex [a-z-]+ failed(?: \([a-z-]+\))?\./g) ?? [];
      throw new Error(`Isolated Codex adapter contract failed (${[...new Set(codes)].join("; ") || "fixture-assertion"}).`);
    }
  }, 95000);
} else {
  const root = process.env.RAVI_CODEX_ADAPTER_FIXTURE_ROOT;
  if (!root || resolve(homedir()) !== resolve(root) || process.env.HOME !== root || process.cwd() !== root) {
    throw new Error("Refusing to import the provider outside the isolated fixture home.");
  }
  test("real Codex removes native catalogs and fences a changed skill before the next turn's HTTP request", () => runAdapterFixture("between-turns"), 45000);
  test("real Codex fences same-turn HTTP continuation after a synthetic tool result", () => runAdapterFixture("after-tool-result"), 45000);
  test("real Codex fences a core policy revocation after a synthetic tool result in the same turn", () => runAdapterFixture("after-tool-revocation"), 45000);
  test("real Codex retries cannot bypass a revoked policy", () => runAdapterFixture("retry-revocation"), 45000);
  test("real Codex authorized retries remain routed through the fence", () => runAdapterFixture("retry-success"), 45000);
  test("real Codex preserves managed OAuth on the guarded native Responses route", () => runAdapterFixture("native-oauth"), 45000);
  test("real Codex preserves managed API-key auth on the guarded native Responses route", () => runAdapterFixture("native-apikey"), 45000);
  test("real Codex resumes only a snapshot-bound session on a newly guarded route", () => runAdapterFixture("resume"), 45000);
  test("real Codex advertises only the selected textual skill with its local reference preserved", () => runAdapterFixture("selected"), 45000);
  test("real Codex does not load a disabled native skill through a textual mention", () => runAdapterFixture("native-mention"), 45000);
}
