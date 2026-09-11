import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Diagnostic only. Model calls terminate at a synthetic loopback fixture.
// The child receives no real credentials; captured prompt contents stay in memory.
const fixtureRoot = mkdtempSync(join(tmpdir(), "ravi-native-skill-probe-"));
const fixtureHome = join(fixtureRoot, "home");
const fixtureCodexHome = join(fixtureHome, ".codex");
const fixtureRepo = join(fixtureRoot, "repo");
const fixtureCwd = join(fixtureRepo, "nested");
const extraRoot = join(fixtureRoot, "selected");
const codex = Bun.which("codex");
const rtk = Bun.which("rtk");
if (!codex || !rtk) throw new Error("The local Codex and RTK executables are required.");

const env = Object.fromEntries(
  ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(env, {
  HOME: fixtureHome,
  USERPROFILE: fixtureHome,
  CODEX_HOME: fixtureCodexHome,
  APPDATA: join(fixtureHome, "AppData", "Roaming"),
  LOCALAPPDATA: join(fixtureHome, "AppData", "Local"),
  TMP: join(fixtureRoot, "tmp"),
  TEMP: join(fixtureRoot, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(fixtureRoot, "gitconfig"),
  RUST_LOG: "error",
});
for (const dir of [fixtureCodexHome, fixtureCwd, extraRoot, env.TMP, env.APPDATA, env.LOCALAPPDATA]) {
  mkdirSync(dir, { recursive: true });
}

async function createSkill(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Harmless discovery fixture ${name}.\n---\n\nFixture only.\n`);
}

await createSkill(join(fixtureHome, ".agents", "skills"), "fixture-user-agent");
await createSkill(join(fixtureCodexHome, "skills"), "fixture-user-codex");
await createSkill(join(fixtureRepo, ".agents", "skills"), "fixture-ancestor");
await createSkill(join(fixtureCwd, ".agents", "skills"), "fixture-project");
await createSkill(extraRoot, "fixture-selected");

async function runLocal(args) {
  const subprocess = Bun.spawn([rtk, "proxy", ...args], { env, cwd: fixtureCwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Diagnostic command failed (${exitCode}): ${stderr.slice(-1000)}`);
  return stdout.trim();
}

await runLocal(["git", "init", "--quiet", fixtureRepo]);
const version = await runLocal([codex, "--version"]);
const schemaRoot = join(fixtureRoot, "schema");
await runLocal([codex, "app-server", "generate-json-schema", "--experimental", "--out", schemaRoot]);
const schemaFiles = readdirSync(schemaRoot, { recursive: true });
const extraSchemaPath = schemaFiles.find((path) => /SkillsExtraRootsSetParams\.json$/.test(path));
const extraSchema = extraSchemaPath ? await Bun.file(join(schemaRoot, extraSchemaPath)).json() : null;
console.log(JSON.stringify({ version, fixtureRoot, extraRootsSchema: extraSchema?.properties, required: extraSchema?.required }));

const capturedRequests = [];
const fixtureServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/responses")) {
      return new Response("Fixture supports only POST /responses", { status: 404 });
    }
    const body = await request.json();
    capturedRequests.push({ body, authorizationPresent: request.headers.has("authorization") });
    const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] };
    const response = { id: "resp_fixture", object: "response", created_at: 0, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Fixture complete." },
      { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text: "Fixture complete." },
      { type: "response.content_part.done", item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  },
});

const commonConfig = [
  "features.plugins=false", "features.apps=false", "features.remote_plugin=false",
  "check_for_update_on_startup=false", "analytics.enabled=false", "feedback.enabled=false",
  "model_provider=\"fixture\"", "model_providers.fixture.name=\"Fixture\"",
  `model_providers.fixture.base_url=\"http://127.0.0.1:${fixtureServer.port}/v1\"`,
  "model_providers.fixture.wire_api=\"responses\"", "model_providers.fixture.requires_openai_auth=false",
  "model_providers.fixture.supports_websockets=false",
  "features.enable_request_compression=false",
];

async function discover(skipHost, pathOverrideMode = null) {
  const args = commonConfig.flatMap((value) => ["-c", value]);
  args.push("-c", `features.skip_host_skill_discovery=${skipHost}`, "app-server", "--stdio");
  const subprocess = Bun.spawn([rtk, "proxy", codex, ...args], { env, cwd: fixtureCwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map();
  let requestId = 0;
  let completeTurn;
  const completedTurn = new Promise((resolve) => { completeTurn = resolve; });
  const readOutput = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of subprocess.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        const message = JSON.parse(line);
        if (message.method === "turn/completed") completeTurn(message.params.turn.status);
        const deferred = pending.get(message.id);
        if (!deferred) continue;
        pending.delete(message.id);
        clearTimeout(deferred.timer);
        if (message.error) deferred.reject(new Error(JSON.stringify(message.error)));
        else deferred.resolve(message.result);
      }
    }
  })();
  const stderrPromise = new Response(subprocess.stderr).text();
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      subprocess.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      subprocess.stdin.flush();
    });
  }
  function project(result) {
    return result.data.flatMap((row) => row.skills.map((skill) => ({ name: skill.name, enabled: skill.enabled, scope: skill.scope, path: skill.path })));
  }
  function instructionSummary(result) {
    const sources = result.instructionSources ?? [];
    return {
      total: sources.length,
      fixtureSources: sources.filter((path) => path.includes("fixture-")).map((path) => path.split(/[\\/]/).slice(-2).join("/")),
      skills: sources.filter((path) => /SKILL\.md$/i.test(path)).length,
    };
  }
  try {
    await request("initialize", { clientInfo: { name: "ravi-skill-probe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    subprocess.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const config = await request("config/read", { includeLayers: false });
    const initial = project(await request("skills/list", { cwds: [fixtureCwd], forceReload: true }));
    const perRequestExtra = project(await request("skills/list", {
      cwds: [fixtureCwd], forceReload: true,
      perCwdExtraUserRoots: [{ cwd: fixtureCwd, extraUserRoots: [extraRoot] }],
    }));
    const extraKey = Object.keys(extraSchema?.properties ?? {}).find((key) => /root/i.test(key));
    if (!extraKey) throw new Error("The generated protocol did not expose the extra-roots parameter.");
    await request("skills/extraRoots/set", { [extraKey]: [extraRoot] });
    const persistentExtra = project(await request("skills/list", { cwds: [fixtureCwd], forceReload: true }));
    const disabledSkills = pathOverrideMode ? persistentExtra
      .filter((skill) => pathOverrideMode === "empty" || skill.name !== "fixture-selected")
      .map((skill) => ({ path: skill.path, enabled: false })) : [];
    if (disabledSkills.some((skill) => typeof skill.path !== "string" || skill.path.length === 0)) {
      throw new Error("Native discovery returned a skill without a path; cannot prepare path overrides.");
    }
    const thread = await request("thread/start", {
      cwd: fixtureCwd, model: "gpt-5.4", modelProvider: "fixture", ephemeral: true,
      config: {
        "features.skip_host_skill_discovery": skipHost,
        ...(pathOverrideMode ? { "skills.config": disabledSkills } : {}),
      },
    });
    const requestStart = capturedRequests.length;
    await request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Return the fixture's fixed response without using tools." }] });
    let turnTimer;
    const turnStatus = await Promise.race([
      completedTurn,
      new Promise((_, reject) => { turnTimer = setTimeout(() => reject(new Error("Fixture turn did not complete")), 15000); }),
    ]);
    clearTimeout(turnTimer);
    const captured = capturedRequests.slice(requestStart);
    const requestSummary = captured.map(({ body, authorizationPresent }) => {
      const serialized = JSON.stringify(body);
      const listedSkillNames = persistentExtra.map((skill) => skill.name);
      const matchingNames = listedSkillNames.filter((name) => serialized.includes(name));
      const inputText = (body.input ?? []).flatMap((item) => Array.isArray(item.content)
        ? item.content.filter((part) => typeof part.text === "string").map((part) => part.text)
        : typeof item.content === "string" ? [item.content] : []).join("\n");
      const catalogLines = inputText.split("\n").filter((line) => line.startsWith("- ") && line.includes("SKILL.md"));
      const catalogNames = listedSkillNames.filter((name) => catalogLines.some((line) => line.startsWith(`- ${name}:`)));
      return {
        authorizationPresent,
        fixtureNames: matchingNames.filter((name) => name.startsWith("fixture-")).sort(),
        matchingNonFixtureNames: matchingNames.filter((name) => !name.startsWith("fixture-")).length,
        bodyCharacters: serialized.length,
        inputItems: body.input?.length,
        skillsHeadingPresent: /Available skills|## Skills/.test(serialized),
        catalogCount: catalogNames.length,
        catalogFixtureNames: catalogNames.filter((name) => name.startsWith("fixture-")).sort(),
        catalogNonFixtureCount: catalogNames.filter((name) => !name.startsWith("fixture-")).length,
      };
    });
    await request("skills/extraRoots/set", { [extraKey]: [] });
    const clearedExtra = project(await request("skills/list", { cwds: [fixtureCwd], forceReload: true }));
    return { skipHost, pathOverrideMode, disabledPaths: disabledSkills.length, configFlag: config.config?.features?.skip_host_skill_discovery, initial, perRequestExtra, persistentExtra, clearedExtra, threadInstructions: instructionSummary(thread), turnStatus, requestSummary };
  } finally {
    subprocess.stdin.end();
    const stopTimer = setTimeout(() => subprocess.kill(), 5000);
    await subprocess.exited;
    clearTimeout(stopTimer);
    await readOutput;
    const stderr = await stderrPromise;
    if (/https?:\/\/(?!127\.0\.0\.1)/i.test(stderr)) {
      console.log(JSON.stringify({ skipHost, externalUrlReported: true, warning: "Inspect isolated stderr before claiming network-free startup." }));
    }
  }
}

const names = (skills) => skills.filter((skill) => skill.enabled !== false).map((skill) => skill.name).sort();
const summarize = (result) => Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Array.isArray(value) && key !== "requestSummary" ? {
  count: value.length,
  fixtureNames: names(value).filter((name) => name.startsWith("fixture-")),
  nonFixtureCount: value.filter((skill) => !skill.name.startsWith("fixture-")).length,
} : value]));
if (process.argv.includes("--path-overrides")) {
  const selected = await discover(false, "selected");
  const empty = await discover(false, "empty");
  fixtureServer.stop(true);
  console.log(JSON.stringify({ selected: summarize(selected) }));
  console.log(JSON.stringify({ empty: summarize(empty) }));
  const pathVerdict = {
    selectedCompleted: selected.turnStatus === "completed",
    emptyCompleted: empty.turnStatus === "completed",
    selectedExactCatalog: selected.requestSummary.length === 1 && selected.requestSummary.every((request) => request.catalogCount === 1 && request.catalogFixtureNames[0] === "fixture-selected"),
    emptyExactCatalog: empty.requestSummary.length === 1 && empty.requestSummary.every((request) => request.catalogCount === 0 && request.fixtureNames.length === 0),
    noAuthorization: [...selected.requestSummary, ...empty.requestSummary].every((request) => !request.authorizationPresent),
  };
  console.log(JSON.stringify({ pathVerdict }));
  if (!Object.values(pathVerdict).every(Boolean)) process.exitCode = 2;
} else {
const baseline = await discover(false);
const restricted = await discover(true);
fixtureServer.stop(true);
console.log(JSON.stringify({ baseline: summarize(baseline) }));
console.log(JSON.stringify({ restricted: summarize(restricted) }));
const expectedHost = ["fixture-user-codex", "fixture-ancestor", "fixture-project"];
const baselineNames = names(baseline.initial);
const verdict = {
  baselineCoversAllRoots: expectedHost.every((name) => baselineNames.includes(name)),
  restrictedNativeEmpty: names(restricted.initial).length === 0,
  restrictedPerRequestExtraExact: JSON.stringify(names(restricted.perRequestExtra)) === '["fixture-selected"]',
  restrictedPersistentExtraExact: JSON.stringify(names(restricted.persistentExtra)) === '["fixture-selected"]',
  restrictedClearedEmpty: names(restricted.clearedExtra).length === 0,
  restrictedPromptHasNoHostFixture: restricted.requestSummary.every((request) => !request.fixtureNames.some((name) => expectedHost.includes(name))),
  restrictedPromptHasSelectedFixture: restricted.requestSummary.some((request) => request.fixtureNames.includes("fixture-selected")),
};
console.log(JSON.stringify({ verdict }));
if (!Object.values(verdict).every(Boolean)) process.exitCode = 2;
}
