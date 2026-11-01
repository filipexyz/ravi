import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFakeCloudConsole,
  type FakeCloudConsole,
  fakeCloudApproval,
  fakeCloudRun,
  fakeCloudSchedule,
  fakeCloudSessionOpener,
} from "../../cloud-agents/test-fixtures.js";
import { dbGetActiveCloudThreadByKey } from "../../cloud-agents/chat-db.js";
import type { CloudChatTarget } from "../../cloud-agents/chat-target.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getCliOnlyMetadata, getReturnsMetadata } from "../decorators.js";
import {
  type CloudAgentsCommandDeps,
  type CloudCliChatContext,
  CloudAgentsCommands,
  CloudKeyCommands,
  CloudRunsCommands,
  CloudSchedulesCommands,
  matchCloudAgent,
} from "./cloud-agents.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `call` with console.log captured; returns its result (or error) and the printed lines. */
async function capture<T>(call: () => Promise<T>): Promise<{ result?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await call(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.log = original;
  }
}

function deps(fake: FakeCloudConsole, overrides: CloudAgentsCommandDeps = {}): CloudAgentsCommandDeps {
  return {
    openSession: fakeCloudSessionOpener(fake),
    inAgentRuntime: () => false,
    operatorOwnTurn: () => true,
    sleep: async () => {},
    localTimezone: () => "UTC",
    chatContext: () => null,
    turnPerson: () => ({ contactId: null, name: null }),
    ...overrides,
  };
}

function expectBrake(outcome: { error?: unknown; lines: string[] }, fake: FakeCloudConsole) {
  expect(outcome.error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
  expect(fake.writes()).toHaveLength(0);
  const envelope = JSON.parse(outcome.lines.join("\n"));
  expect(envelope).toMatchObject({ success: false, error: { code: "WRITE_REQUIRES_EXECUTE", dryRun: true } });
  return envelope.error.plan as Record<string, unknown>;
}

function expectSchema(target: Function, method: string, value: unknown) {
  const schema = getReturnsMetadata(target).get(method);
  expect(schema).toBeDefined();
  const parsed = schema!.safeParse(value);
  if (!parsed.success) throw new Error(`${method}: ${parsed.error.message}`);
}

describe("ravi cloud key", () => {
  it("status prints the hint and matches its schema", async () => {
    const fake = createFakeCloudConsole();
    const outcome = await capture(() => new CloudKeyCommands(deps(fake)).status(true));
    expect(JSON.parse(outcome.lines.join("\n")).credential.keyHint).toBe("a1b2");
    expectSchema(CloudKeyCommands, "status", outcome.result);
  });

  it("set is braked, CLI-only, reads the key only with --execute", async () => {
    const fake = createFakeCloudConsole();
    let reads = 0;
    const commands = new CloudKeyCommands(
      deps(fake, {
        readKey: async () => {
          reads += 1;
          return "test-key-9z9z\n";
        },
      }),
    );
    expect(getCliOnlyMetadata(CloudKeyCommands).has("set")).toBe(true);
    const plan = expectBrake(await capture(() => commands.set(true, "100", true, false)), fake);
    expect(plan).toMatchObject({ keyFrom: "stdin", replaces: true, currentKeyHint: "a1b2", monthlyAlertUsd: 100 });
    expect(reads).toBe(0);

    const done = await capture(() => commands.set(true, "100", true, true));
    expect(reads).toBe(1);
    expect(done.result).toMatchObject({ credential: { keyHint: "9z9z", monthlyAlertUsd: 100 } });
    expect(fake.writes()[0]!.body).toMatchObject({ apiKey: "test-key-9z9z" });
    expect(done.lines.join("\n")).not.toContain("test-key-9z9z");
    expectSchema(CloudKeyCommands, "set", done.result);
  });

  it("set refuses without --stdin and inside an agent runtime", async () => {
    const fake = createFakeCloudConsole();
    const usage = await capture(() => new CloudKeyCommands(deps(fake)).set(false, undefined, true, true));
    expect(usage.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const agent = await capture(() =>
      new CloudKeyCommands(deps(fake, { inAgentRuntime: () => true })).set(true, undefined, true, true),
    );
    expect(agent.error).toMatchObject({ code: "CLOUD_AGENT_CANNOT_SET_KEY", exitCode: 3 });
    expect(fake.requests).toHaveLength(0);
  });

  it("remove applies at once", async () => {
    const fake = createFakeCloudConsole();
    const outcome = await capture(() => new CloudKeyCommands(deps(fake)).remove(true));
    expect(outcome.result).toMatchObject({ credential: { configured: false } });
    expect(fake.writes().map((request) => request.path)).toEqual(["/credential/remove"]);
    expectSchema(CloudKeyCommands, "remove", outcome.result);
  });

  it("maps a Console error code to the contract envelope", async () => {
    const fake = createFakeCloudConsole();
    fake.failures.push({
      path: "/credential",
      status: 403,
      body: { error: { code: "cloud_agents_not_enabled", message: "Not enabled" } },
    });
    const outcome = await capture(() => new CloudKeyCommands(deps(fake)).status(true));
    expect(outcome.error).toMatchObject({ code: "CLOUD_AGENTS_NOT_ENABLED", exitCode: 3 });
    expect(JSON.parse(outcome.lines.join("\n"))).toMatchObject({
      success: false,
      error: { code: "CLOUD_AGENTS_NOT_ENABLED" },
    });
  });

  it("fails with AUTH_REQUIRED without a login", async () => {
    const fake = createFakeCloudConsole();
    const outcome = await capture(() =>
      new CloudKeyCommands(deps(fake, { openSession: fakeCloudSessionOpener(fake, { loggedIn: false }) })).status(true),
    );
    expect(outcome.error).toMatchObject({ code: "AUTH_REQUIRED", exitCode: 1 });
  });
});

describe("ravi cloud agents", () => {
  it("list and show match their schemas", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudAgentsCommands(deps(fake));
    const list = await capture(() => commands.list("clinica", undefined, undefined, true));
    expectSchema(CloudAgentsCommands, "list", list.result);
    expect(fake.requests[0]!.query.get("project")).toBe("clinica");
    const show = await capture(() => commands.show("clinica/triage", undefined, true));
    expect(show.result).toMatchObject({ agent: { id: "ca_1" } });
    expectSchema(CloudAgentsCommands, "show", show.result);
    const missing = await capture(() => commands.show("nope", undefined, true));
    expect(missing.error).toMatchObject({ code: "CLOUD_AGENT_NOT_FOUND", exitCode: 1 });
  });

  it("deploy is braked and sends the Library slug", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudAgentsCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.deploy("org/reviewer", "2", undefined, true, false)), fake);
    expect(plan).toMatchObject({ agent: "reviewer", project: "clinica", version: 2, deployed: null });
    const done = await capture(() => commands.deploy("org/reviewer", "2", undefined, true, true));
    expect(fake.writes()[0]).toMatchObject({
      path: "/agents/deploy",
      body: { project: "clinica", agent: "reviewer", version: 2 },
    });
    expect(done.result).toMatchObject({ changed: true, warnings: [], agent: { library: { slug: "reviewer" } } });
    expectSchema(CloudAgentsCommands, "deploy", done.result);
  });

  it("refuses without a project", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudAgentsCommands(
      deps(fake, { openSession: fakeCloudSessionOpener(fake, { defaultProject: null }) }),
    );
    const outcome = await capture(() => commands.list(undefined, undefined, undefined, true));
    expect(outcome.error).toMatchObject({ code: "CLOUD_PROJECT_REQUIRED", exitCode: 2 });
  });

  it("archive applies at once", async () => {
    const fake = createFakeCloudConsole();
    const outcome = await capture(() => new CloudAgentsCommands(deps(fake)).archive("triage", undefined, true));
    expect(fake.writes().map((request) => request.path)).toEqual(["/agents/ca_1/archive"]);
    expectSchema(CloudAgentsCommands, "archive", outcome.result);
  });

  it("matches agents by id, item id, slug and name", () => {
    const agents = [
      {
        id: "ca_9",
        projectId: "",
        name: "Triage Bot",
        library: { itemId: "item-9", slug: "triage", scope: "org", version: 1 },
        provider: "anthropic",
        model: null,
        status: "ready",
        deployedAt: null,
        deployedBy: null,
        lastError: null,
        config: {
          budgetUsd: 5,
          networking: "limited",
          webSearch: false,
          writes: "ask",
          raviMcp: true,
          mcpServers: [],
          repositories: [],
          schedule: null,
        },
      },
    ];
    expect(matchCloudAgent(agents, "ca_9")?.id).toBe("ca_9");
    expect(matchCloudAgent(agents, "item-9")?.id).toBe("ca_9");
    expect(matchCloudAgent(agents, "org/triage")?.id).toBe("ca_9");
    expect(matchCloudAgent(agents, "triage bot")?.id).toBe("ca_9");
    expect(matchCloudAgent(agents, "other")).toBeNull();
  });
});

describe("ravi cloud runs", () => {
  it("start is braked without the prompt in the plan, then starts a manual run", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudRunsCommands(deps(fake));
    const prompt = "Summarize yesterday's open tickets";
    const braked = await capture(() =>
      commands.start(
        "triage",
        prompt,
        "2.5",
        ["acme/api@main"],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        false,
      ),
    );
    const plan = expectBrake(braked, fake);
    expect(plan).toMatchObject({
      agent: "triage",
      budgetUsd: 2.5,
      repositories: ["acme/api"],
      promptChars: prompt.length,
    });
    expect(braked.lines.join("\n")).not.toContain(prompt);

    const done = await capture(() =>
      commands.start(
        "triage",
        prompt,
        "2.5",
        ["acme/api@main"],
        undefined,
        "retry-key-0001",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );
    expect(fake.writes()[0]!.body).toMatchObject({
      project: "clinica",
      agent: "triage",
      prompt,
      trigger: "manual",
      budgetUsd: 2.5,
      repositories: [{ repo: "acme/api", branch: "main" }],
      idempotencyKey: "retry-key-0001",
    });
    expectSchema(CloudRunsCommands, "start", done.result);
  });

  it("start marks runs from an agent runtime and validates input", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudRunsCommands(deps(fake, { inAgentRuntime: () => true }));
    await capture(() =>
      commands.start(
        "triage",
        "go",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );
    expect(fake.writes()[0]!.body).toMatchObject({ trigger: "agent" });
    const badBudget = await capture(() =>
      commands.start(
        "triage",
        "go",
        "999",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect(badBudget.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const badRepo = await capture(() =>
      commands.start(
        "triage",
        "go",
        undefined,
        ["nope"],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect(badRepo.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const empty = await capture(() =>
      commands.start(
        "triage",
        "  ",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect(empty.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });

  it("list, show and stop match their schemas; a missing run is CLOUD_RUN_NOT_FOUND", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun()] });
    const commands = new CloudRunsCommands(deps(fake));
    expectSchema(
      CloudRunsCommands,
      "list",
      (await capture(() => commands.list("triage", "running", undefined, "10", undefined, true))).result,
    );
    // The agent filter goes to the Console as the cloud agent id.
    expect(fake.requests[1]!.query.get("agent")).toBe("ca_1");
    expect(fake.requests[1]!.query.get("limit")).toBe("10");
    expectSchema(CloudRunsCommands, "show", (await capture(() => commands.show("run_1", true))).result);
    const stopped = await capture(() => commands.stop("run_1", true));
    expect(stopped.result).toMatchObject({ run: { status: "stopped" } });
    expectSchema(CloudRunsCommands, "stop", stopped.result);
    const missing = await capture(() => commands.show("run_x", true));
    expect(missing.error).toMatchObject({ code: "CLOUD_RUN_NOT_FOUND", exitCode: 1 });
  });

  it("reply is braked", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun()] });
    const commands = new CloudRunsCommands(deps(fake));
    expectBrake(await capture(() => commands.reply("run_1", "also check billing", true, false)), fake);
    const done = await capture(() => commands.reply("run_1", "also check billing", true, true));
    expect(fake.writes()[0]).toMatchObject({ path: "/runs/run_1/messages", body: { text: "also check billing" } });
    expectSchema(CloudRunsCommands, "reply", done.result);
  });

  it("approve is braked, names the run's person, and checks the approval", async () => {
    const runWithApprovals = () =>
      fakeCloudRun({
        status: "waiting_approval",
        approvals: [fakeCloudApproval(), fakeCloudApproval({ id: "ap_old", status: "approved" })],
      });
    // Another person's turn is no longer refused locally: the Console decides who the run's person is.
    const othersFake = createFakeCloudConsole({ runs: [runWithApprovals()] });
    const othersTurn = new CloudRunsCommands(
      deps(othersFake, { inAgentRuntime: () => true, operatorOwnTurn: () => false }),
    );
    const othersPlan = expectBrake(await capture(() => othersTurn.approve("run_1", "ap_1", true, false)), othersFake);
    expect(othersPlan).toMatchObject({ person: "Op" });
    expect(String(othersPlan.effect)).toContain("only the run's person can approve it");
    othersFake.failures.push({
      path: "/runs/run_1/approvals/ap_1",
      method: "POST",
      status: 403,
      body: { error: { code: "forbidden", message: "Only the run's person decides this approval." } },
    });
    const refused = await capture(() => othersTurn.approve("run_1", "ap_1", true, true));
    expect(refused.error).toMatchObject({ code: "CLOUD_AGENTS_FORBIDDEN", exitCode: 1 });
    expect(JSON.parse(refused.lines.join("\n")).error.message).toBe("Only the run's person decides this approval.");

    const fake = createFakeCloudConsole({ runs: [runWithApprovals()] });
    const commands = new CloudRunsCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.approve("run_1", "ap_1", true, false)), fake);
    expect(plan).toMatchObject({ run: "run_1", approval: "ap_1", tool: "create_issue", server: "github" });
    const missing = await capture(() => commands.approve("run_1", "ap_x", true, true));
    expect(missing.error).toMatchObject({ code: "CLOUD_APPROVAL_NOT_FOUND", exitCode: 1 });
    const decided = await capture(() => commands.approve("run_1", "ap_old", true, true));
    expect(decided.error).toMatchObject({ code: "CLOUD_APPROVAL_NOT_PENDING", exitCode: 1 });

    const done = await capture(() => commands.approve("run_1", "ap_1", true, true));
    expect(fake.writes()[0]).toMatchObject({ path: "/runs/run_1/approvals/ap_1", body: { decision: "approve" } });
    expect(done.result).toMatchObject({ approval: { status: "approved" } });
    expectSchema(CloudRunsCommands, "approve", done.result);
  });

  it("approve and answer refuse a turn Ravi cannot attribute, before any Console call", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({
          status: "waiting_approval",
          approvals: [fakeCloudApproval()],
        }),
      ],
    });
    // Another agent's turn, or an unresolved speaker: no person goes to the Console, so the call would act as the operator.
    const commands = new CloudRunsCommands(
      deps(fake, { inAgentRuntime: () => true, operatorOwnTurn: () => false, unattributedTurn: () => true }),
    );
    const approve = await capture(() => commands.approve("run_1", "ap_1", true, true));
    expect(approve.error).toMatchObject({ code: "ACTOR_UNKNOWN", exitCode: 3 });
    expect((approve.error as Error).message).toContain("Next: ask the run's person");
    const answer = await capture(() => commands.answer("run_1", "q_1", "Suporte", true, true));
    expect(answer.error).toMatchObject({ code: "ACTOR_UNKNOWN", exitCode: 3 });
    expect(fake.writes()).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("deny applies at once with a reason", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ approvals: [fakeCloudApproval()] })] });
    const outcome = await capture(() => new CloudRunsCommands(deps(fake)).deny("run_1", "ap_1", "not today", true));
    expect(fake.writes()[0]!.body).toEqual({ decision: "deny", reason: "not today" });
    expectSchema(CloudRunsCommands, "deny", outcome.result);
  });

  it("follow prints NDJSON events and ends with the run", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun()] });
    fake.events.set("run_1", [{ seq: 1, type: "message", role: "agent", text: "working" }]);
    let polls = 0;
    const commands = new CloudRunsCommands(
      deps(fake, {
        sleep: async () => {
          polls += 1;
          fake.events.get("run_1")!.push({ seq: 2, type: "status", status: "completed" });
          const run = fake.runs.get("run_1")!;
          run.status = "completed";
          run.result = "Done.";
        },
      }),
    );
    const outcome = await capture(() => commands.follow("run_1", "1", true));
    expect(polls).toBe(1);
    const lines = outcome.lines.map((line) => JSON.parse(line));
    expect(lines.map((line) => line.seq ?? line.type)).toEqual([1, 2, "run"]);
    expect(lines.at(-1)).toMatchObject({ type: "run", run: { status: "completed", result: "Done." } });
    expect(outcome.result).toMatchObject({ status: "completed", events: 2 });
  });

  it("outputs lists, downloads, and refuses to overwrite", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({
          outputs: [
            { id: "out_1", name: "report.md", size: 5 },
            { id: "out_2", name: "data/rows.csv", size: 3 },
          ],
        }),
      ],
    });
    fake.outputs.set("run_1/out_1", new TextEncoder().encode("# Hi\n"));
    fake.outputs.set("run_1/out_2", new TextEncoder().encode("a,b"));
    const commands = new CloudRunsCommands(deps(fake));
    const listed = await capture(() => commands.outputs("run_1", undefined, true));
    expect(listed.result).toMatchObject({ directory: null, downloaded: [] });
    expectSchema(CloudRunsCommands, "outputs", listed.result);

    const dir = mkdtempSync(join(tmpdir(), "ravi-cloud-outputs-"));
    tempDirs.push(dir);
    const downloaded = await capture(() => commands.outputs("run_1", dir, true));
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("# Hi\n");
    expect(readFileSync(join(dir, "data", "rows.csv"), "utf8")).toBe("a,b");
    expectSchema(CloudRunsCommands, "outputs", downloaded.result);

    writeFileSync(join(dir, "report.md"), "mine");
    const again = await capture(() => commands.outputs("run_1", dir, true));
    expect(again.error).toMatchObject({ code: "CLOUD_OUTPUT_EXISTS", exitCode: 1 });
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("mine");
  });

  it("outputs refuse names that would land on one path, and write nothing", async () => {
    const cases: Array<Array<{ id: string; name: string; size: number }>> = [
      [
        { id: "out_1", name: "report.md", size: 1 },
        { id: "out_2", name: "report.md", size: 1 },
      ],
      [
        { id: "out_1", name: "Report.md", size: 1 },
        { id: "out_2", name: "report.MD", size: 1 },
      ],
      [
        { id: "out_1", name: "a", size: 1 },
        { id: "out_2", name: "a/b", size: 1 },
      ],
    ];
    for (const outputs of cases) {
      const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ outputs })] });
      for (const output of outputs) fake.outputs.set(`run_1/${output.id}`, new TextEncoder().encode("x"));
      const dir = mkdtempSync(join(tmpdir(), "ravi-cloud-outputs-"));
      tempDirs.push(dir);
      const outcome = await capture(() => new CloudRunsCommands(deps(fake)).outputs("run_1", join(dir, "out"), true));
      expect(outcome.error).toMatchObject({ code: "CLOUD_OUTPUT_NAME_CONFLICT", exitCode: 1 });
      expect(existsSync(join(dir, "out"))).toBe(false);
      expect(fake.requests.some((request) => request.path.startsWith("/runs/run_1/outputs"))).toBe(false);
    }
  });

  it("outputs map a folder in the way to CLOUD_OUTPUT_EXISTS", async () => {
    const fake = createFakeCloudConsole({
      runs: [fakeCloudRun({ outputs: [{ id: "out_1", name: "a/b.txt", size: 1 }] })],
    });
    fake.outputs.set("run_1/out_1", new TextEncoder().encode("x"));
    const dir = mkdtempSync(join(tmpdir(), "ravi-cloud-outputs-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "a"), "a file where a folder is needed");
    const outcome = await capture(() => new CloudRunsCommands(deps(fake)).outputs("run_1", dir, true));
    expect(outcome.error).toMatchObject({ code: "CLOUD_OUTPUT_EXISTS", exitCode: 1 });
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("a file where a folder is needed");
  });

  it("outputs keep downloads inside the folder", async () => {
    const fake = createFakeCloudConsole({
      runs: [fakeCloudRun({ outputs: [{ id: "out_1", name: "../escape.txt", size: 1 }] })],
    });
    fake.outputs.set("run_1/out_1", new TextEncoder().encode("x"));
    const dir = mkdtempSync(join(tmpdir(), "ravi-cloud-outputs-"));
    tempDirs.push(dir);
    await capture(() => new CloudRunsCommands(deps(fake)).outputs("run_1", join(dir, "inner"), true));
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
  });
});

describe("ravi cloud schedules", () => {
  it("add is braked when enabled and immediate when disabled", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudSchedulesCommands(deps(fake));
    const plan = expectBrake(
      await capture(() =>
        commands.add(
          "triage",
          "0 9 * * 1-5",
          "America/Sao_Paulo",
          undefined,
          "3",
          undefined,
          undefined,
          undefined,
          true,
          false,
        ),
      ),
      fake,
    );
    expect(plan).toMatchObject({
      cron: "0 9 * * 1-5",
      timezone: "America/Sao_Paulo",
      promptSource: "HEARTBEAT.md",
      enabled: true,
    });

    const disabled = await capture(() =>
      commands.add(
        "triage",
        "0 9 * * 1-5",
        undefined,
        "Check the queue",
        undefined,
        true,
        undefined,
        undefined,
        true,
        false,
      ),
    );
    expect(fake.writes()[0]!.body).toMatchObject({ enabled: false, timezone: "UTC", prompt: "Check the queue" });
    expectSchema(CloudSchedulesCommands, "add", disabled.result);

    const bad = await capture(() =>
      commands.add("triage", "nope", undefined, undefined, undefined, true, undefined, undefined, true),
    );
    expect(bad.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });

  it("update brakes when the schedule stays enabled; disabling applies at once", async () => {
    const fake = createFakeCloudConsole({ schedules: [fakeCloudSchedule()] });
    const commands = new CloudSchedulesCommands(deps(fake));
    const plan = expectBrake(
      await capture(() =>
        commands.update(
          "sch_1",
          "0 10 * * *",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          false,
        ),
      ),
      fake,
    );
    expect(plan).toMatchObject({ schedule: "sch_1", cron: "0 10 * * *", enabled: true });

    const off = await capture(() =>
      commands.update(
        "sch_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
        false,
      ),
    );
    expect(fake.writes()[0]).toMatchObject({ path: "/schedules/sch_1" });
    expect(fake.writes()[0]!.body).toEqual({ enabled: false });
    expectSchema(CloudSchedulesCommands, "update", off.result);

    const missing = await capture(() =>
      commands.update(
        "sch_x",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );
    expect(missing.error).toMatchObject({ code: "CLOUD_SCHEDULE_NOT_FOUND", exitCode: 1 });
    const nothing = await capture(() =>
      commands.update(
        "sch_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect(nothing.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });

  it("list and remove", async () => {
    const fake = createFakeCloudConsole({ schedules: [fakeCloudSchedule()] });
    const commands = new CloudSchedulesCommands(deps(fake));
    expectSchema(
      CloudSchedulesCommands,
      "list",
      (await capture(() => commands.list(undefined, undefined, undefined, true))).result,
    );
    const removed = await capture(() => commands.remove("sch_1", true));
    expect(fake.writes().map((request) => request.path)).toEqual(["/schedules/sch_1/delete"]);
    expectSchema(CloudSchedulesCommands, "remove", removed.result);
  });
  it("list pages locally with --limit and --offset", async () => {
    const fake = createFakeCloudConsole({
      schedules: [fakeCloudSchedule(), fakeCloudSchedule({ id: "sch_2" }), fakeCloudSchedule({ id: "sch_3" })],
    });
    const commands = new CloudSchedulesCommands(deps(fake));
    const first = await capture(() => commands.list(undefined, "2", undefined, true));
    expect(first.result).toMatchObject({
      schedules: [{ id: "sch_1" }, { id: "sch_2" }],
      pagination: { total: 3, hasMore: true, nextOffset: 2 },
    });
    expect(first.result?.pagination.nextCommand).toContain("--offset 2");
    const last = await capture(() => commands.list(undefined, "2", "2", true));
    expect(last.result).toMatchObject({
      schedules: [{ id: "sch_3" }],
      pagination: { hasMore: false, nextOffset: null },
    });
    const bad = await capture(() => commands.list(undefined, "0", undefined, true));
    expect(bad.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });
});

describe("ravi cloud runs: conversations, files and questions", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-cloud-cli-chat-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const SLACK_THREAD = {
    channel: "slack",
    accountId: "slack-main",
    instanceId: "slack-main",
    chatId: "C0ABC123",
    threadId: "1712345678.123456",
  };

  function chatIn(source: CloudCliChatContext["source"], cwd: string | null = null) {
    return (): CloudCliChatContext => ({ sessionName: "dev-main", source, cwd });
  }

  function chatRecorder(
    reply: (index: number) => { messageId: string | null } | Error = () => ({ messageId: "1712345679.000100" }),
  ) {
    const sent: Array<{ target: CloudChatTarget; text: string; blocks?: readonly Record<string, unknown>[] }> = [];
    const edits: Array<{ request: { content: Record<string, unknown> } }> = [];
    return {
      sent,
      edits,
      threadDeps: {
        deliverToChat: async (
          target: CloudChatTarget,
          message: { text: string; blocks?: readonly Record<string, unknown>[] },
        ) => {
          sent.push({ target, ...message });
          const result = reply(sent.length - 1);
          if (result instanceof Error) throw result;
          return { messageId: result.messageId, deliveries: [] };
        },
        publishCardEdit: async (job: unknown) => {
          edits.push(job as { request: { content: Record<string, unknown> } });
        },
      },
    };
  }

  // start(agent, prompt, budget, repos, project, key, json, execute, files, outcome, maxIterations, rowsView, rowsLimit, bindThread, noDeliver)
  type StartExtras = {
    files?: string[];
    outcome?: string;
    maxIterations?: string;
    rowsView?: string;
    rowsLimit?: string;
    bindThread?: boolean;
    noDeliver?: boolean;
    budget?: string;
  };
  function start(commands: CloudRunsCommands, execute: boolean, extras: StartExtras = {}) {
    return capture(() =>
      commands.start(
        "triage",
        "Resume os tickets",
        extras.budget,
        undefined,
        undefined,
        undefined,
        extras.files,
        extras.outcome,
        extras.maxIterations,
        extras.rowsView,
        extras.rowsLimit,
        extras.bindThread,
        extras.noDeliver,
        true,
        execute,
      ),
    );
  }

  it("start inside a session delivers the result back to it; --no-deliver opts out", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudRunsCommands(deps(fake, { chatContext: chatIn(SLACK_THREAD) }));
    const plan = expectBrake(await start(commands, false), fake);
    expect(plan.delivery).toEqual({ kind: "session", sessionName: "dev-main" });
    const done = await start(commands, true);
    expect(fake.writes()[0]!.body).toMatchObject({
      delivery: {
        kind: "session",
        sessionName: "dev-main",
        chat: { channel: "slack", chatId: "C0ABC123", threadId: "1712345678.123456", instanceId: "slack-main" },
      },
    });
    expect(done.result).toMatchObject({ run: { delivery: { kind: "session", sessionName: "dev-main" } } });
    expectSchema(CloudRunsCommands, "start", done.result);

    await start(commands, true, { noDeliver: true });
    expect(fake.writes()[1]!.body).toMatchObject({ delivery: { kind: "none" } });

    // A terminal has no session: no delivery field at all.
    const terminal = createFakeCloudConsole();
    await start(new CloudRunsCommands(deps(terminal)), true);
    expect(terminal.writes()[0]!.body).not.toHaveProperty("delivery");
  });

  it("start sends --file, --outcome and --rows; the plan lists names and sizes, never contents", async () => {
    const fake = createFakeCloudConsole();
    const files: Record<string, string> = { "/agents/dev/notes.md": "segredo do conteudo" };
    const commands = new CloudRunsCommands(
      deps(fake, {
        chatContext: chatIn(null, "/agents/dev"),
        fileSize: (path) => (files[path] === undefined ? null : Buffer.byteLength(files[path]!)),
        readFile: (path) => new TextEncoder().encode(files[path] ?? ""),
      }),
    );
    const extras = {
      files: ["notes.md"],
      outcome: "Lista com 3 itens",
      maxIterations: "3",
      rowsView: "vw_leads",
      rowsLimit: "50",
      budget: "5",
    };
    const braked = await start(commands, false, extras);
    const plan = expectBrake(braked, fake);
    expect(plan).toMatchObject({
      files: [{ name: "notes.md", size: 19 }],
      outcome: { rubricChars: 17, maxIterations: 3 },
      rows: { viewId: "vw_leads", limit: 50 },
    });
    expect(braked.lines.join("\n")).not.toContain("segredo");
    await start(commands, true, extras);
    expect(fake.writes()[0]!.body).toMatchObject({
      files: [
        {
          name: "notes.md",
          contentBase64: Buffer.from("segredo do conteudo").toString("base64"),
          mimeType: "text/markdown",
        },
      ],
      outcome: { rubric: "Lista com 3 itens", maxIterations: 3 },
      rows: { viewId: "vw_leads", limit: 50 },
    });
  });

  it("start refuses bad file, outcome and rows input as usage errors", async () => {
    const fake = createFakeCloudConsole();
    const commands = new CloudRunsCommands(
      deps(fake, { chatContext: chatIn(null, "/agents/dev"), fileSize: () => null }),
    );
    for (const extras of [
      { files: ["missing.txt"] },
      { files: [".env"] },
      { maxIterations: "2" },
      { outcome: "ok", maxIterations: "9" },
      { outcome: "   " },
      { rowsLimit: "5" },
      { rowsView: "bad view!" },
      { rowsView: "vw_1", rowsLimit: "1000" },
      { bindThread: true, noDeliver: true },
    ] satisfies StartExtras[]) {
      const outcome = await start(commands, true, extras);
      expect(outcome.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("--bind-thread in a Slack thread posts the run card there and binds the thread", async () => {
    const fake = createFakeCloudConsole();
    const chat = chatRecorder();
    const commands = new CloudRunsCommands(
      deps(fake, {
        chatContext: chatIn(SLACK_THREAD),
        turnPerson: () => ({ contactId: "contact-ana", name: "Ana" }),
        threadDeps: chat.threadDeps,
      }),
    );
    const plan = expectBrake(await start(commands, false, { bindThread: true }), fake);
    expect(plan.thread).toEqual({ channel: "slack", threadKey: "slack:slack-main:C0ABC123:1712345678.123456" });
    expect(chat.sent).toHaveLength(0);

    const done = await start(commands, true, { bindThread: true });
    expect(fake.writes()[0]!.body).toMatchObject({ threadKey: "slack:slack-main:C0ABC123:1712345678.123456" });
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]!.target.threadId).toBe("1712345678.123456");
    expect(done.result).toMatchObject({
      thread: {
        threadKey: "slack:slack-main:C0ABC123:1712345678.123456",
        channel: "slack",
        cardMessageId: "1712345679.000100",
      },
    });
    expectSchema(CloudRunsCommands, "start", done.result);
    expect(dbGetActiveCloudThreadByKey("slack:slack-main:C0ABC123:1712345678.123456")).toMatchObject({
      runId: "run_1",
      actorContactId: "contact-ana",
      actorName: "Ana",
      sessionName: "dev-main",
    });
  });

  it("--bind-thread at a Slack top level opens the thread with the run card, then edits it", async () => {
    const fake = createFakeCloudConsole();
    const chat = chatRecorder(() => ({ messageId: "1712345680.000200" }));
    const { threadId: _thread, ...topLevel } = SLACK_THREAD;
    const commands = new CloudRunsCommands(deps(fake, { chatContext: chatIn(topLevel), threadDeps: chat.threadDeps }));
    const done = await start(commands, true, { bindThread: true });
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]!.target.threadId).toBeUndefined();
    expect(fake.writes()[0]!.body).toMatchObject({ threadKey: "slack:slack-main:C0ABC123:1712345680.000200" });
    expect(chat.edits[0]!.request.content).toMatchObject({
      actionId: "message.edit",
      providerMessageId: "1712345680.000200",
    });
    expect(done.result).toMatchObject({ thread: { cardMessageId: "1712345680.000200" } });
  });

  it("--bind-thread: a card Slack refuses stops the run; a start that fails marks the card failed", async () => {
    const { threadId: _thread, ...topLevel } = SLACK_THREAD;
    const refusedFake = createFakeCloudConsole();
    const refused = chatRecorder(() => new Error("not_in_channel"));
    const blocked = await start(
      new CloudRunsCommands(deps(refusedFake, { chatContext: chatIn(topLevel), threadDeps: refused.threadDeps })),
      true,
      { bindThread: true },
    );
    expect(blocked.error).toMatchObject({ code: "CLOUD_THREAD_CARD_FAILED", exitCode: 1 });
    expect(refusedFake.writes()).toHaveLength(0);

    const failingFake = createFakeCloudConsole();
    failingFake.failures.push({
      path: "/runs",
      method: "POST",
      status: 409,
      body: { error: { code: "cloud_credential_missing", message: "No key" } },
    });
    const chat = chatRecorder(() => ({ messageId: "1712345680.000300" }));
    const failed = await start(
      new CloudRunsCommands(deps(failingFake, { chatContext: chatIn(topLevel), threadDeps: chat.threadDeps })),
      true,
      { bindThread: true },
    );
    expect(failed.error).toMatchObject({ code: "CLOUD_CREDENTIAL_MISSING" });
    expect(chat.edits[0]!.request.content).toMatchObject({
      providerMessageId: "1712345680.000300",
      threadCard: { status: "closed" },
    });
  });

  it("--bind-thread works in WhatsApp groups and refuses private chats", async () => {
    const fake = createFakeCloudConsole();
    const chat = chatRecorder(() => ({ messageId: "wa-card-1" }));
    const group = {
      channel: "whatsapp",
      accountId: "wa-main",
      instanceId: "inst-wa",
      chatId: "120363012345678901@g.us",
    };
    const done = await start(
      new CloudRunsCommands(deps(fake, { chatContext: chatIn(group), threadDeps: chat.threadDeps })),
      true,
      { bindThread: true },
    );
    expect(fake.writes()[0]!.body).toMatchObject({ threadKey: "whatsapp:inst-wa:120363012345678901@g.us" });
    expect(chat.sent[0]!.text).toContain("@run");
    expect(done.result).toMatchObject({ thread: { channel: "whatsapp", cardMessageId: "wa-card-1" } });

    const dm = await start(
      new CloudRunsCommands(deps(fake, { chatContext: chatIn({ ...group, chatId: "5511999999999@s.whatsapp.net" }) })),
      true,
      { bindThread: true },
    );
    expect(dm.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const terminal = await start(new CloudRunsCommands(deps(fake)), true, { bindThread: true });
    expect(terminal.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });

  const QUESTION_RUN = () =>
    fakeCloudRun({
      status: "waiting_input",
      costBrl: 2.1,
      delivery: { kind: "session", sessionName: "dev-main" },
      questions: [
        { id: "q_1", question: "Qual fila?", options: ["Suporte", "Vendas"], status: "pending" },
        { id: "q_0", question: "Antes?", status: "answered", answer: "Sim" },
      ],
    });

  it("answer is braked, checks the question, and sends the person's answer", async () => {
    const fake = createFakeCloudConsole({ runs: [QUESTION_RUN()] });
    const commands = new CloudRunsCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.answer("run_1", "q_1", "Suporte", true, false)), fake);
    expect(plan).toMatchObject({ run: "run_1", question: "q_1", asked: "Qual fila?", answerChars: 7, person: "Op" });
    const missing = await capture(() => commands.answer("run_1", "q_x", "Suporte", true, true));
    expect(missing.error).toMatchObject({ code: "CLOUD_QUESTION_NOT_FOUND", exitCode: 1 });
    const answered = await capture(() => commands.answer("run_1", "q_0", "Suporte", true, true));
    expect(answered.error).toMatchObject({ code: "CLOUD_QUESTION_NOT_PENDING", exitCode: 1 });
    const empty = await capture(() => commands.answer("run_1", "q_1", "  ", true, true));
    expect(empty.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const unknownRun = await capture(() => commands.answer("run_x", "q_1", "Suporte", true, true));
    expect(unknownRun.error).toMatchObject({ code: "CLOUD_RUN_NOT_FOUND" });

    const done = await capture(() => commands.answer("run_1", "q_1", "Suporte", true, true));
    expect(fake.writes()[0]).toMatchObject({ path: "/runs/run_1/questions/q_1", body: { answer: "Suporte" } });
    expect(done.result).toMatchObject({ question: { id: "q_1", status: "answered", answer: "Suporte" } });
    expectSchema(CloudRunsCommands, "answer", done.result);
  });

  it("show prints questions with the answer command, the BRL cost and the delivery", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        {
          ...QUESTION_RUN(),
          threadKey: "slack:slack-main:C0ABC123:1712345678.123456",
          outcome: {
            rubric: "x",
            maxIterations: 3,
            iterations: 1,
            lastResult: "needs_revision",
            feedback: "Falta um item",
          },
        },
      ],
    });
    const shown = await capture(() => new CloudRunsCommands(deps(fake)).show("run_1", false));
    const text = shown.lines.join("\n");
    expect(text).toContain("  In BRL:  R$ 2.10");
    expect(text).toContain("  Delivery: session dev-main");
    expect(text).toContain("  Thread:  slack:slack-main:C0ABC123:1712345678.123456");
    expect(text).toContain("  Outcome: needs_revision after 1 of 3 iterations");
    expect(text).toContain("  Question q_1: pending Qual fila?");
    expect(text).toContain("    1. Suporte");
    expect(text).toContain('    Answer:  ravi cloud runs answer run_1 q_1 "<answer>" --execute');
    expect(text).toContain("    Answered: Sim");
    expectSchema(
      CloudRunsCommands,
      "show",
      (await capture(() => new CloudRunsCommands(deps(fake)).show("run_1", true))).result,
    );
  });

  it("follow prints a pending question once", async () => {
    const fake = createFakeCloudConsole({ runs: [QUESTION_RUN()] });
    let polls = 0;
    const commands = new CloudRunsCommands(
      deps(fake, {
        sleep: async () => {
          polls += 1;
          if (polls === 2) fake.runs.get("run_1")!.status = "completed";
        },
      }),
    );
    const outcome = await capture(() => commands.follow("run_1", "1", false));
    expect(outcome.lines.filter((line) => line.includes("Question q_1"))).toHaveLength(1);
    expect(outcome.lines.filter((line) => line.includes("ravi cloud runs answer run_1 q_1"))).toHaveLength(1);
  });

  it("schedules made in a session deliver there; --no-deliver turns it off", async () => {
    const fake = createFakeCloudConsole({ schedules: [fakeCloudSchedule()] });
    const commands = new CloudSchedulesCommands(deps(fake, { chatContext: chatIn(SLACK_THREAD) }));
    // add(agent, cron, tz, prompt, budget, disabled, project, noDeliver, json, execute)
    const plan = expectBrake(
      await capture(() =>
        commands.add(
          "triage",
          "0 9 * * 1-5",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          false,
        ),
      ),
      fake,
    );
    expect(plan.delivery).toEqual({ kind: "session", sessionName: "dev-main" });
    const added = await capture(() =>
      commands.add("triage", "0 9 * * 1-5", undefined, undefined, undefined, true, undefined, undefined, true, false),
    );
    expect(fake.writes()[0]!.body).toMatchObject({ delivery: { kind: "session", sessionName: "dev-main" } });
    expectSchema(CloudSchedulesCommands, "add", added.result);
    await capture(() =>
      commands.add("triage", "0 9 * * 1-5", undefined, undefined, undefined, true, undefined, true, true, false),
    );
    expect(fake.writes()[1]!.body).toMatchObject({ delivery: { kind: "none" } });

    // update(id, cron, tz, prompt, heartbeat, budget, enable, disable, project, noDeliver, json, execute)
    const updated = await capture(() =>
      commands.update(
        "sch_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );
    expect(fake.writes()[2]!.body).toEqual({
      enabled: false,
      delivery: {
        kind: "session",
        sessionName: "dev-main",
        chat: { channel: "slack", chatId: "C0ABC123", threadId: "1712345678.123456", instanceId: "slack-main" },
      },
    });
    expectSchema(CloudSchedulesCommands, "update", updated.result);
    await capture(() =>
      commands.update(
        "sch_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
        true,
      ),
    );
    expect(fake.writes()[3]!.body).toEqual({ delivery: { kind: "none" } });
    // Inside a session, a call with nothing else to change is still a usage error.
    const nothing = await capture(() =>
      commands.update(
        "sch_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect(nothing.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });
});
