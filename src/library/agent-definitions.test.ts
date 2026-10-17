import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAgentRuntimePermissionsConfigFromDefaults } from "../permissions/agent-default-capabilities-provider.js";
import { createAgent, getAgent, updateAgent } from "../router/config.js";
import { dbListSkillGrantsForAgent, dbUpsertSkillGrant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  executeLibraryAgentInstall,
  executeLibraryAgentPublish,
  executeLibraryAgentUpdate,
  LIBRARY_AGENT_EDITED_LOCALLY,
  LIBRARY_AGENT_NO_ORIGIN,
  lineDiff,
  prepareLibraryAgentInstall,
  prepareLibraryAgentPublish,
  prepareLibraryAgentUpdate,
  searchLibraryAgents,
  showLibraryAgent,
  type LibraryAgentServiceDeps,
} from "./agent-definitions.js";
import { dbGetLibraryAgentState, dbSetLibraryAgentAcceptsRequests, dbSetLibraryAgentDescription } from "./agents-db.js";
import { parseLibraryRef } from "./refs.js";
import { LibraryCommandError } from "./service.js";
import {
  createFakeConsole,
  fakeAgentDefinition,
  fakeSession,
  fakeSkill,
  withFakeAgentLibrary,
  type FakeConsole,
} from "./test-fixtures.js";

let stateDir: string | null = null;
let home: string;
let skills: FakeConsole;
let agents: FakeConsole;
let library: ReturnType<typeof withFakeAgentLibrary>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-agents-");
  home = mkdtempSync(join(tmpdir(), "ravi-library-agents-home-"));
  skills = createFakeConsole([fakeSkill({ slug: "tom-de-voz" }), fakeSkill({ slug: "triagem", project: "clinica" })]);
  agents = createFakeConsole([
    fakeAgentDefinition({ slug: "plain", description: "Plain helper", externalAllowed: true }),
    fakeAgentDefinition({
      slug: "triage",
      version: 2,
      description: "Sorts incoming requests",
      heartbeat: "# Heartbeat\n\n- check the queue\n",
      manifest: {
        provider: "claude",
        model: "sonnet",
        profile: "full-access",
        skills: ["org/tom-de-voz", "org/missing"],
      },
    }),
  ]);
  library = withFakeAgentLibrary(skills, agents);
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function deps(extra: Partial<LibraryAgentServiceDeps> = {}): LibraryAgentServiceDeps {
  return {
    openSession: async () => fakeSession(library),
    cache: { stateDir: stateDir! },
    turn: { operatorOwnTurn: true },
    home,
    ...extra,
  };
}

function ref(value: string) {
  return parseLibraryRef(value)!;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<LibraryCommandError> {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(LibraryCommandError);
  expect((error as LibraryCommandError).code).toBe(code);
  return error as LibraryCommandError;
}

describe("library agents: search and show", () => {
  it("reads agent definitions on the agents routes and hides internal ones from other turns", async () => {
    const found = await searchLibraryAgents({ query: "" }, deps());
    expect(found.items.map((item) => item.ref)).toEqual(["org/plain", "org/triage"]);
    expect(found.items[1]?.next).toBe("ravi agents show org/triage");
    expect(library.paths[0]).toStartWith("GET /api/cli/library/agents?");

    const external = await searchLibraryAgents({ query: "" }, deps({ turn: { operatorOwnTurn: false } }));
    expect(external.items.map((item) => item.ref)).toEqual(["org/plain"]);

    const shown = await showLibraryAgent(ref("org/triage"), deps());
    expect(shown.agent).toEqual({
      provider: "claude",
      model: "sonnet",
      profile: "full-access",
      skills: ["org/tom-de-voz", "org/missing"],
    });
    expect(shown.instructions).toContain("Be helpful.");
    expect(shown.heartbeat).toContain("check the queue");
    expect(library.paths.at(-1)).toBe("GET /api/cli/library/agents/org/triage");

    await expectCode(
      showLibraryAgent(ref("org/triage"), deps({ turn: { operatorOwnTurn: false } })),
      "LIBRARY_SKILL_EXTERNAL_DENIED",
    );
  });

  it("answers show from the cache when the Console is offline", async () => {
    await showLibraryAgent(ref("org/plain"), deps());
    skills.offline = true;
    agents.offline = true;
    const cached = await showLibraryAgent(ref("org/plain"), deps());
    expect(cached.stale).toBe(true);
    expect(cached.instructions).toContain("# plain");
  });
});

describe("library agents: install", () => {
  it("applies immediately when the definition adds no authority", async () => {
    const prepared = await prepareLibraryAgentInstall({ ref: ref("org/plain") }, deps());
    expect(prepared.plan.requiresExecute).toBe(false);
    expect(prepared.plan.agent.cwd).toBe(join(home, "ravi", "plain"));
    const result = executeLibraryAgentInstall(prepared);
    expect(result.agent.id).toBe("plain");
    expect(readFileSync(join(home, "ravi", "plain", "AGENTS.md"), "utf8")).toContain("Be helpful.");
    expect(getAgent("plain")?.cwd).toBe(join(home, "ravi", "plain"));
    const state = dbGetLibraryAgentState("plain")!;
    expect(state.origin?.ref).toBe("org/plain");
    expect(state.origin?.version).toBe(1);
    expect(state.origin?.agentsMdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.description).toBe("Plain helper");
    expect(state.acceptsRequests).toBe(false);
  });

  it("brakes a profile above the floor and skill grants, and stores grants like skills grant", async () => {
    const prepared = await prepareLibraryAgentInstall({ ref: ref("org/triage"), id: "sorter" }, deps());
    expect(prepared.plan.requiresExecute).toBe(true);
    expect(prepared.plan.profile).toMatchObject({ suggested: "full-access", apply: "full-access", raises: true });
    expect(prepared.plan.skills).toEqual([
      { ref: "org/tom-de-voz", kind: "library", grant: "org:tom-de-voz", status: "grant" },
      { ref: "org/missing", kind: "library", grant: null, status: "missing", reason: "NOT_FOUND" },
    ]);
    expect(getAgent("sorter")).toBeFalsy();

    const result = executeLibraryAgentInstall(prepared);
    expect(result.granted).toEqual(["org:tom-de-voz"]);
    expect(result.skipped).toEqual([{ ref: "org/missing", reason: "NOT_FOUND" }]);
    const agent = getAgent("sorter")!;
    expect(agent.provider).toBe("claude");
    expect(agent.model).toBe("sonnet");
    expect(getAgentRuntimePermissionsConfigFromDefaults(agent.defaults)?.profile).toBe("full-access");
    expect(dbListSkillGrantsForAgent("sorter").map((grant) => grant.skillName)).toEqual(["org:tom-de-voz"]);
    expect(existsSync(join(home, "ravi", "sorter", "HEARTBEAT.md"))).toBe(true);
  });

  it("refuses an existing id and an occupied cwd", async () => {
    mkdirSync(join(home, "taken"), { recursive: true });
    createAgent({ id: "plain", cwd: join(home, "taken") });
    await expectCode(prepareLibraryAgentInstall({ ref: ref("org/plain") }, deps()), "AGENT_ALREADY_EXISTS");

    mkdirSync(join(home, "busy"), { recursive: true });
    writeFileSync(join(home, "busy", "AGENTS.md"), "mine\n");
    await expectCode(
      prepareLibraryAgentInstall({ ref: ref("org/plain"), id: "other", cwd: join(home, "busy") }, deps()),
      "AGENT_CWD_IN_USE",
    );
  });
});

describe("library agents: update", () => {
  async function install(id = "plain", definition = "org/plain") {
    executeLibraryAgentInstall(await prepareLibraryAgentInstall({ ref: ref(definition), id }, deps()));
    return join(home, "ravi", id);
  }

  function republish(definition: Parameters<typeof fakeAgentDefinition>[0]) {
    const next = fakeAgentDefinition(definition);
    agents.skills = [...agents.skills.filter((entry) => entry.item.slug !== definition.slug), next];
  }

  it("overwrites untouched files and records the new version", async () => {
    const cwd = await install();
    republish({ slug: "plain", version: 2, instructions: "# plain\n\nBe brief.\n" });
    const prepared = await prepareLibraryAgentUpdate({ agentId: "plain" }, deps());
    expect(prepared.plan.requiresExecute).toBe(false);
    expect(prepared.plan.files[0]).toMatchObject({ file: "AGENTS.md", action: "write", editedLocally: false });
    const result = executeLibraryAgentUpdate(prepared);
    expect(result).toMatchObject({ version: 2, previousVersion: 1, written: ["AGENTS.md"] });
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("Be brief.");
    expect(dbGetLibraryAgentState("plain")?.origin?.version).toBe(2);
  });

  it("stops on a local edit with the diff, then keeps or replaces it", async () => {
    const cwd = await install();
    writeFileSync(join(cwd, "AGENTS.md"), "# plain\n\nBe helpful.\nMy own rule.\n");
    republish({ slug: "plain", version: 2, instructions: "# plain\n\nBe brief.\n" });

    const error = await expectCode(
      prepareLibraryAgentUpdate({ agentId: "plain" }, deps()),
      LIBRARY_AGENT_EDITED_LOCALLY,
    );
    expect(error.exitCode).toBe(2);
    expect(String(error.details.diff)).toContain("- My own rule.");
    expect(String(error.details.diff)).toContain("+ Be brief.");

    const kept = executeLibraryAgentUpdate(
      await prepareLibraryAgentUpdate({ agentId: "plain", keepLocal: true }, deps()),
    );
    expect(kept.kept).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("My own rule.");

    // The edit is still an edit for the next update.
    republish({ slug: "plain", version: 3, instructions: "# plain\n\nBe kind.\n" });
    await expectCode(prepareLibraryAgentUpdate({ agentId: "plain" }, deps()), LIBRARY_AGENT_EDITED_LOCALLY);
    const taken = executeLibraryAgentUpdate(
      await prepareLibraryAgentUpdate({ agentId: "plain", takeLibrary: true }, deps()),
    );
    expect(taken.written).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("Be kind.");
  });

  it("brakes a new profile or skills, and does not revert a profile set here", async () => {
    await install();
    republish({ slug: "plain", version: 2, manifest: { profile: "full-access", skills: ["org/tom-de-voz"] } });
    const raised = await prepareLibraryAgentUpdate({ agentId: "plain" }, deps());
    expect(raised.plan.requiresExecute).toBe(true);
    expect(raised.plan.profile.apply).toBe("full-access");
    executeLibraryAgentUpdate(raised);
    expect(dbListSkillGrantsForAgent("plain").map((grant) => grant.skillName)).toEqual(["org:tom-de-voz"]);

    // The operator lowers it; an update that did not change the suggestion leaves it.
    updateAgent("plain", { defaults: { runtimePermissions: { profile: "bootstrap" } } });
    republish({
      slug: "plain",
      version: 3,
      instructions: "# plain\n\nv3\n",
      manifest: { profile: "full-access", skills: ["org/tom-de-voz"] },
    });
    const next = await prepareLibraryAgentUpdate({ agentId: "plain" }, deps());
    expect(next.plan.profile.apply).toBeNull();
    expect(next.plan.requiresExecute).toBe(false);
  });

  it("refuses an agent that was not installed from the Library", async () => {
    mkdirSync(join(home, "own"), { recursive: true });
    createAgent({ id: "own", cwd: join(home, "own") });
    await expectCode(prepareLibraryAgentUpdate({ agentId: "own" }, deps()), LIBRARY_AGENT_NO_ORIGIN);
  });
});

describe("library agents: publish", () => {
  it("packages AGENTS.md, HEARTBEAT.md and agent.json with Library skills only", async () => {
    const cwd = join(home, "helper");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "# Helper\n\nAnswer politely.\n");
    writeFileSync(join(cwd, "HEARTBEAT.md"), "# Heartbeat\n");
    createAgent({ id: "helper", cwd, provider: "codex", model: "gpt-x" });
    updateAgent("helper", { defaults: { runtimePermissions: { profile: "full-access" } } });
    dbUpsertSkillGrant({ agentId: "helper", skillName: "org:tom-de-voz" });
    dbUpsertSkillGrant({ agentId: "helper", skillName: "project:clinica:triagem" });
    dbUpsertSkillGrant({ agentId: "helper", skillName: "pages" });
    dbSetLibraryAgentDescription("helper", "Answers politely");
    dbSetLibraryAgentAcceptsRequests("helper", true);

    const prepared = await prepareLibraryAgentPublish({ agentId: "helper", scope: "org" }, deps());
    expect(prepared.plan.manifest).toEqual({
      provider: "codex",
      model: "gpt-x",
      profile: "full-access",
      skills: ["org/tom-de-voz"],
    });
    expect(prepared.plan.leftOut).toHaveLength(2);
    expect(prepared.plan.leftOut).toContainEqual({
      skill: "clinica/triagem",
      reason: "outside the organization's view",
    });
    expect(prepared.plan.leftOut).toContainEqual({ skill: "pages", reason: "not a Library skill" });
    expect(prepared.files.map((file) => file.path)).toEqual(["AGENTS.md", "HEARTBEAT.md", "agent.json"]);
    const manifest = JSON.parse(prepared.files[2]!.content) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["model", "profile", "provider", "skills"]);
    const serialized = JSON.stringify(prepared.files);
    expect(serialized).not.toContain(cwd);

    const result = await executeLibraryAgentPublish(prepared);
    expect(result.ref).toBe("org/helper");
    const posted = agents.requests.at(-1)!;
    expect(library.paths.at(-1)).toBe("POST /api/cli/library/agents");
    expect(posted.body).toMatchObject({ scope: "org", slug: "helper", description: "Answers politely" });
    expect((posted.body as { externalAllowed: boolean }).externalAllowed).toBe(false);
  });

  it("proposes with submit, and requires a description", async () => {
    const cwd = join(home, "quiet");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "# Quiet\n");
    createAgent({ id: "quiet", cwd });
    await expectCode(prepareLibraryAgentPublish({ agentId: "quiet", scope: "org" }, deps()), "USAGE_ERROR");

    const prepared = await prepareLibraryAgentPublish(
      { agentId: "quiet", scope: "clinica", description: "Stays quiet", propose: true },
      deps(),
    );
    expect(prepared.plan.manifest.profile).toBeNull();
    const result = await executeLibraryAgentPublish(prepared);
    expect(result.proposal?.status).toBe("proposed");
    expect(library.paths.at(-1)).toBe("POST /api/cli/library/agents/proposals");
    expect(agents.requests.at(-1)?.body).toMatchObject({ scope: "project", project: "clinica", submit: true });
  });
});

describe("lineDiff", () => {
  it("marks local lines with - and Library lines with +", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc", "local", "lib")).toBe("--- local\n+++ lib\n  a\n+ x\n- b\n  c");
  });
});
