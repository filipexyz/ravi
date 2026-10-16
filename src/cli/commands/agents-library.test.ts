import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import { dbGetLibraryAgentState } from "../../library/agents-db.js";
import {
  createFakeConsole,
  fakeAgentDefinition,
  fakeCredentials,
  fakeSkill,
  withFakeAgentLibrary,
  type FakeConsole,
} from "../../library/test-fixtures.js";
import { getAgent } from "../../router/config.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { AgentsLibraryCommands } from "./agents-library.js";
import { AgentsCommands } from "./agents.js";

let stateDir: string | null = null;
let workDir: string;
let agents: FakeConsole;
let library: ReturnType<typeof withFakeAgentLibrary>;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("agents-library-cli-");
  workDir = mkdtempSync(join(tmpdir(), "agents-library-cli-work-"));
  agents = createFakeConsole([
    fakeAgentDefinition({ slug: "plain", description: "Plain helper" }),
    fakeAgentDefinition({ slug: "triage", manifest: { profile: "full-access", skills: ["org/tom-de-voz"] } }),
  ]);
  library = withFakeAgentLibrary(createFakeConsole([fakeSkill({ slug: "tom-de-voz" })]), agents);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) =>
    library.fetch(String(input instanceof Request ? input.url : input), init)) as typeof fetch);
  writeCloudCredentials(fakeCredentials());
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  rmSync(workDir, { recursive: true, force: true });
});

async function quietAsync<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function contractError(run: () => unknown): Promise<ContractError> {
  let thrown: unknown;
  try {
    await quietAsync(async () => {
      await run();
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  return thrown as ContractError;
}

const commands = new AgentsLibraryCommands();
const asAgent = { transport: "tool" as const, agentId: "main" };

describe("agents install|update|publish from the CLI", () => {
  it("refuses inside an agent runtime before any request", async () => {
    const install = await contractError(() =>
      runWithContext(asAgent, () => commands.install("org/plain", undefined, undefined, true, true)),
    );
    expect(install.code).toBe("LIBRARY_AGENT_CANNOT_INSTALL");
    expect(install.exitCode).toBe(3);
    const update = await contractError(() =>
      runWithContext(asAgent, () => commands.update("main", undefined, undefined, true, true)),
    );
    expect(update.code).toBe("LIBRARY_AGENT_CANNOT_INSTALL");
    const publish = await contractError(() =>
      runWithContext(asAgent, () => commands.publish("main", "org", undefined, undefined, undefined, true, true, true)),
    );
    expect(publish.code).toBe("LIBRARY_AGENT_CANNOT_PUBLISH");
    expect(publish.exitCode).toBe(3);
    expect(library.paths).toEqual([]);
  });

  it("installs a definition without authority at once and brakes one that raises it", async () => {
    const plainCwd = join(workDir, "plain");
    const installed = await quietAsync(() =>
      runWithContext({}, () => commands.install("org/plain", undefined, plainCwd, true)),
    );
    expect(installed).toMatchObject({ success: true, ref: "org/plain", agent: { id: "plain", cwd: plainCwd } });
    expect(existsSync(join(plainCwd, "AGENTS.md"))).toBe(true);

    const triageCwd = join(workDir, "triage");
    const braked = await contractError(() =>
      runWithContext({}, () => commands.install("org/triage", undefined, triageCwd, true)),
    );
    expect(braked.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(braked.exitCode).toBe(3);
    expect(getAgent("triage")).toBeFalsy();
    await quietAsync(() => runWithContext({}, () => commands.install("org/triage", undefined, triageCwd, true, true)));
    expect(getAgent("triage")).toBeTruthy();
  });

  it("asks for --keep-local or --take-library when the instructions were edited here", async () => {
    const cwd = join(workDir, "plain");
    await quietAsync(() => runWithContext({}, () => commands.install("org/plain", undefined, cwd, true)));
    writeFileSync(join(cwd, "AGENTS.md"), "mine\n");
    agents.skills = [fakeAgentDefinition({ slug: "plain", version: 2, instructions: "theirs\n" })];
    const error = await contractError(() =>
      runWithContext({}, () => commands.update("plain", undefined, undefined, true)),
    );
    expect(error.code).toBe("LIBRARY_AGENT_EDITED_LOCALLY");
    expect(error.exitCode).toBe(2);
    expect(String(error.details.diff)).toContain("+ theirs");
  });

  it("publish is braked", async () => {
    const cwd = join(workDir, "plain");
    await quietAsync(() => runWithContext({}, () => commands.install("org/plain", undefined, cwd, true)));
    const error = await contractError(() =>
      runWithContext({}, () => commands.publish("plain", "org", "plain-copy", undefined, undefined, undefined, true)),
    );
    expect(error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(library.paths.some((path) => path.startsWith("POST "))).toBe(false);
  });
});

describe("agents show and set for the Library", () => {
  it("shows a Library ref and the local agent's Library state", async () => {
    const shown = (await quietAsync(() =>
      runWithContext({}, async () => new AgentsCommands().show("org/plain", true)),
    )) as { source: string; ref: string; next: string };
    expect(shown).toMatchObject({ source: "library", ref: "org/plain", next: "ravi agents install org/plain" });

    const cwd = join(workDir, "plain");
    await quietAsync(() => runWithContext({}, () => commands.install("org/plain", undefined, cwd, true)));
    await quietAsync(() =>
      runWithContext({}, () => new AgentsCommands().set("plain", "description", "Answers plainly", true)),
    );
    expect(dbGetLibraryAgentState("plain")?.description).toBe("Answers plainly");
    const local = (await quietAsync(() =>
      runWithContext({}, async () => new AgentsCommands().show("plain", true)),
    )) as {
      library?: unknown;
    };
    expect(local.library).toEqual({
      description: "Answers plainly",
      acceptsRequests: false,
      origin: { ref: "org/plain", version: 1, installedAt: expect.any(Number) },
    });

    const tooLong = await contractError(() =>
      runWithContext({}, () => new AgentsCommands().set("plain", "description", "x".repeat(301), true)),
    );
    expect(tooLong.exitCode).toBe(2);
  });
});
