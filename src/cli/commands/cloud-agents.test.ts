import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
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
import { getCliOnlyMetadata, getReturnsMetadata } from "../decorators.js";
import {
  type CloudAgentsCommandDeps,
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
      commands.start("triage", prompt, "2.5", ["acme/api@main"], undefined, undefined, true, false),
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
      commands.start("triage", prompt, "2.5", ["acme/api@main"], undefined, "retry-key-0001", true, true),
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
    await capture(() => commands.start("triage", "go", undefined, undefined, undefined, undefined, true, true));
    expect(fake.writes()[0]!.body).toMatchObject({ trigger: "agent" });
    const badBudget = await capture(() => commands.start("triage", "go", "999", undefined, undefined, undefined, true));
    expect(badBudget.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const badRepo = await capture(() =>
      commands.start("triage", "go", undefined, ["nope"], undefined, undefined, true),
    );
    expect(badRepo.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const empty = await capture(() => commands.start("triage", "  ", undefined, undefined, undefined, undefined, true));
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

  it("approve is braked, refused on another person's agent turn, and checks the approval", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({
          status: "waiting_approval",
          approvals: [fakeCloudApproval(), fakeCloudApproval({ id: "ap_old", status: "approved" })],
        }),
      ],
    });
    const notOperator = await capture(() =>
      new CloudRunsCommands(deps(fake, { inAgentRuntime: () => true, operatorOwnTurn: () => false })).approve(
        "run_1",
        "ap_1",
        true,
        true,
      ),
    );
    expect(notOperator.error).toMatchObject({ code: "CLOUD_APPROVAL_NOT_OPERATOR", exitCode: 3 });

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
        commands.add("triage", "0 9 * * 1-5", "America/Sao_Paulo", undefined, "3", undefined, undefined, true, false),
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
      commands.add("triage", "0 9 * * 1-5", undefined, "Check the queue", undefined, true, undefined, true, false),
    );
    expect(fake.writes()[0]!.body).toMatchObject({ enabled: false, timezone: "UTC", prompt: "Check the queue" });
    expectSchema(CloudSchedulesCommands, "add", disabled.result);

    const bad = await capture(() =>
      commands.add("triage", "nope", undefined, undefined, undefined, true, undefined, true),
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
        true,
        false,
      ),
    );
    expect(fake.writes()[0]).toMatchObject({ path: "/schedules/sch_1" });
    expect(fake.writes()[0]!.body).toEqual({ enabled: false });
    expectSchema(CloudSchedulesCommands, "update", off.result);

    const missing = await capture(() =>
      commands.update("sch_x", undefined, undefined, undefined, undefined, undefined, undefined, true, undefined, true),
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
