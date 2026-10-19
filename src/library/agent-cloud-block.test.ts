import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CloudAgentBlock } from "../cloud-agents/definition.js";
import { createAgent } from "../router/config.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  executeLibraryAgentInstall,
  executeLibraryAgentPublish,
  prepareLibraryAgentInstall,
  prepareLibraryAgentPublish,
  showLibraryAgent,
  type LibraryAgentServiceDeps,
} from "./agent-definitions.js";
import { parseLibraryRef } from "./refs.js";
import { LibraryCommandError } from "./service.js";
import { createFakeConsole, fakeAgentDefinition, fakeSession, withFakeAgentLibrary } from "./test-fixtures.js";

let stateDir: string | null = null;
let home: string;
let library: ReturnType<typeof withFakeAgentLibrary>;

const CLOUD: CloudAgentBlock = {
  model: "sonnet",
  budgetUsd: 8,
  environment: { networking: "limited", allowedHosts: ["api.github.com"] },
  tools: { writes: "ask" },
};

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-agent-cloud-");
  home = mkdtempSync(join(tmpdir(), "ravi-library-agent-cloud-home-"));
  library = withFakeAgentLibrary(
    createFakeConsole([]),
    createFakeConsole([
      fakeAgentDefinition({ slug: "cloudy", description: "Runs in the cloud", manifest: { cloud: CLOUD } }),
      fakeAgentDefinition({ slug: "broken", description: "Bad block", manifest: { cloud: { model: "gpt-x" } } }),
    ]),
  );
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function deps(): LibraryAgentServiceDeps {
  return {
    openSession: async () => fakeSession(library),
    cache: { stateDir: stateDir! },
    turn: { operatorOwnTurn: true },
    home,
  };
}

function localAgent(id: string, manifest?: unknown): string {
  const cwd = join(home, id);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), `# ${id}\n`);
  if (manifest !== undefined) {
    writeFileSync(join(cwd, "agent.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  createAgent({ id, cwd });
  return cwd;
}

describe("library agents: cloud block", () => {
  it("publish validates the block and puts it in the generated agent.json", async () => {
    localAgent("helper", { cloud: CLOUD });
    const prepared = await prepareLibraryAgentPublish(
      { agentId: "helper", scope: "org", description: "Helps" },
      deps(),
    );
    expect(prepared.plan.cloud).toEqual(CLOUD);
    const manifest = JSON.parse(prepared.files.find((file) => file.path === "agent.json")!.content);
    expect(manifest.cloud).toEqual(CLOUD);
    await executeLibraryAgentPublish(prepared);
  });

  it("publish refuses an invalid block with every issue", async () => {
    localAgent("bad", { cloud: { model: "gpt-x", environment: { apiKey: "x" } } });
    const error = await prepareLibraryAgentPublish({ agentId: "bad", scope: "org", description: "Bad" }, deps()).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LibraryCommandError);
    const failure = error as LibraryCommandError;
    expect(failure.code).toBe("CLOUD_AGENT_DEFINITION_INVALID");
    expect(failure.exitCode).toBe(2);
    expect(failure.message).not.toContain(home);
    const issues = (failure.details as { issues: Array<{ code: string }> }).issues;
    expect(issues.map((issue) => issue.code)).toContain("credential_refused");
  });

  it("publish refuses an agent.json that is not JSON, and works without one", async () => {
    localAgent("garbled", "{nope");
    const error = await prepareLibraryAgentPublish(
      { agentId: "garbled", scope: "org", description: "x" },
      deps(),
    ).catch((caught: unknown) => caught);
    expect((error as LibraryCommandError).code).toBe("CLOUD_AGENT_DEFINITION_INVALID");

    localAgent("plain");
    const prepared = await prepareLibraryAgentPublish({ agentId: "plain", scope: "org", description: "x" }, deps());
    expect(prepared.plan.cloud).toBeNull();
  });

  it("install keeps the block in the new agent's agent.json, so a republish carries it", async () => {
    const shown = await showLibraryAgent(parseLibraryRef("org/cloudy")!, deps());
    expect(shown.cloud).toEqual(CLOUD);
    const prepared = await prepareLibraryAgentInstall({ ref: parseLibraryRef("org/cloudy")! }, deps());
    expect(prepared.plan.effect.join("\n")).toContain("cloud block");
    const result = executeLibraryAgentInstall(prepared);
    const written = JSON.parse(readFileSync(join(result.agent.cwd, "agent.json"), "utf8"));
    expect(written).toEqual({ cloud: CLOUD });

    const again = await prepareLibraryAgentPublish(
      { agentId: result.agent.id, scope: "org", description: "Runs in the cloud" },
      deps(),
    );
    expect(again.plan.cloud).toEqual(CLOUD);
  });

  it("install leaves an invalid published block out", async () => {
    const prepared = await prepareLibraryAgentInstall({ ref: parseLibraryRef("org/broken")! }, deps());
    const result = executeLibraryAgentInstall(prepared);
    expect(existsSync(join(result.agent.cwd, "agent.json"))).toBe(false);
  });
});
