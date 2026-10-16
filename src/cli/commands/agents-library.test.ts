import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import { dbGetLibraryAgentState } from "../../library/agents-db.js";
import {
  createFakeConsole,
  createFakeRequestConsole,
  fakeAgentDefinition,
  fakeCredentials,
  fakeSkill,
  withFakeAgentLibrary,
  withFakeRequests,
  type FakeConsole,
  type FakeRequestConsole,
} from "../../library/test-fixtures.js";
import { readAcceptsRequests } from "../../library/requests.js";
import { getAgent } from "../../router/config.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { AgentsLibraryCommands, AgentsRequestsCommands } from "./agents-library.js";
import { AgentsCommands } from "./agents.js";

let stateDir: string | null = null;
let workDir: string;
let agents: FakeConsole;
let library: ReturnType<typeof withFakeAgentLibrary>;
let requestState: FakeRequestConsole;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("agents-library-cli-");
  workDir = mkdtempSync(join(tmpdir(), "agents-library-cli-work-"));
  agents = createFakeConsole([
    fakeAgentDefinition({ slug: "plain", description: "Plain helper" }),
    fakeAgentDefinition({ slug: "triage", manifest: { profile: "full-access", skills: ["org/tom-de-voz"] } }),
  ]);
  requestState = createFakeRequestConsole({
    directory: [
      { installation: { id: "11111111-1111-4111-8111-111111111111", name: "macbook-ana" }, agent: { id: "finance" } },
    ],
  });
  library = withFakeAgentLibrary(
    withFakeRequests(createFakeConsole([fakeSkill({ slug: "tom-de-voz" })]), requestState),
    agents,
  );
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

describe("agents directory, ask and requests from the CLI", () => {
  it("brakes opening an agent, closes at once, and refuses both inside an agent", async () => {
    const braked = await contractError(() => runWithContext({}, () => commands.requests("main", "on", true)));
    expect(braked.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(readAcceptsRequests("main")).toBe(false);
    await quietAsync(() => runWithContext({}, () => commands.requests("main", "on", true, true)));
    expect(readAcceptsRequests("main")).toBe(true);
    await quietAsync(() => runWithContext({}, () => commands.requests("main", "off", true)));
    expect(readAcceptsRequests("main")).toBe(false);

    for (const state of ["on", "off"]) {
      const refused = await contractError(() =>
        runWithContext(asAgent, () => commands.requests("main", state, true, true)),
      );
      expect(refused.code).toBe("LIBRARY_AGENT_CANNOT_OPEN_REQUESTS");
      expect(refused.exitCode).toBe(3);
    }
    const shown = await quietAsync(() => runWithContext(asAgent, () => commands.requests("main", undefined, true)));
    expect(shown).toMatchObject({ agent: "main", acceptsRequests: false });
  });

  it("lists the directory and brakes ask", async () => {
    const listed = await quietAsync(() => runWithContext({}, () => commands.directory(undefined, undefined, true)));
    expect(listed.agents.map((entry) => entry.target)).toEqual(["macbook-ana/finance"]);

    const braked = await contractError(() =>
      runWithContext({}, () => commands.ask("macbook-ana/finance", "Close date?", true)),
    );
    expect(braked.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(requestState.requests).toHaveLength(0);

    const sent = await quietAsync(() =>
      runWithContext({}, () => commands.ask("macbook-ana/finance", "Close date?", true, true)),
    );
    expect(sent).toMatchObject({ success: true, target: "macbook-ana/finance", session: null });
    const list = await quietAsync(() =>
      runWithContext({}, () => new AgentsRequestsCommands().list(undefined, undefined, undefined, undefined, true)),
    );
    expect(list.requests.map((request) => request.id)).toEqual([sent.request.id]);
    const cancelled = await quietAsync(() =>
      runWithContext({}, () => new AgentsRequestsCommands().cancel(sent.request.id, true)),
    );
    expect(cancelled.request.status).toBe("cancelled");
  });

  it("maps request conflicts to a next step", async () => {
    requestState.sendConflict = "not_accepting";
    const error = await contractError(() =>
      runWithContext({}, () => commands.ask("macbook-ana/finance", "hi", true, true)),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.details.conflict).toBe("not_accepting");
    expect(String(error.details.suggestedAction)).toContain("ravi agents requests <agent> on --execute");
  });
});
