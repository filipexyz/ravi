import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { CloudContext } from "@/server/console/cloud-agents/access";
import { cloudError } from "@/server/console/cloud-agents/errors";
import type { CloudAgent, CloudRun, CloudRunEvent, CloudSchedule } from "@/server/console/cloud-agents/types";

import {
  CLOUD_AGENTS_GET_OPERATION_ID,
  CLOUD_AGENTS_LIST_OPERATION_ID,
  CLOUD_AGENTS_OPERATIONS,
  CLOUD_APPROVALS_DECIDE_OPERATION_ID,
  CLOUD_RUN_EVENTS_MAX_CHARS,
  CLOUD_RUNS_EVENTS_OPERATION_ID,
  CLOUD_RUNS_LIST_OPERATION_ID,
  CLOUD_RUNS_MESSAGE_OPERATION_ID,
  CLOUD_RUNS_STOP_OPERATION_ID,
  CLOUD_SCHEDULES_LIST_OPERATION_ID,
  cloudAgentsOperations,
  type CloudAgentsOperationDeps,
} from "./cloud-agents";
import type { OperationActor, OperationHandler } from "./types";

const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const AGENT = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function actor(overrides: Partial<OperationActor> = {}): OperationActor {
  return {
    kind: "member",
    organizationId: "org",
    userId: "user-1",
    email: "ana@acme.test",
    orgRole: "developer",
    surface: "mcp",
    requestId: "req",
    site: null,
    pagesSessionId: null,
    ...overrides,
  };
}

const findProject = (async (_workspace: unknown, ref: string) =>
  ref === "prs" || ref === PROJECT ? { id: PROJECT, slug: "prs" } : ref === "other" ? { id: OTHER, slug: "other" } : null) as unknown as CloudAgentsOperationDeps["findProject"];

function agent(overrides: Partial<CloudAgent> = {}): CloudAgent {
  return {
    id: AGENT,
    projectId: PROJECT,
    name: "Triage",
    library: { itemId: "item", slug: "triage", scope: "prs", version: 3 },
    provider: "anthropic",
    model: "claude",
    status: "ready",
    deployedAt: "2026-10-01T00:00:00.000Z",
    deployedBy: { id: "user-1", name: "Ana" },
    lastError: null,
    config: {
      budgetUsd: 5,
      networking: "limited",
      webSearch: false,
      writes: "ask",
      raviMcp: true,
      mcpServers: [],
      repositories: ["acme/app"],
      schedule: null,
    },
    ...overrides,
  };
}

function run(overrides: Partial<CloudRun> = {}): CloudRun {
  return {
    id: RUN,
    agentId: AGENT,
    agentName: "Triage",
    projectId: PROJECT,
    status: "waiting_approval",
    trigger: "manual",
    actor: { id: "user-1", name: "Ana" },
    prompt: "Look at the bugs",
    result: "x".repeat(2000),
    budgetUsd: 5,
    costUsd: 0.4,
    runningSeconds: 30,
    tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    approvals: [
      { id: "ap-1", tool: "ravi_pages_ship", server: "ravi", inputPreview: "{secret}", status: "pending", requestedAt: "t", decidedAt: null, decidedBy: null },
      { id: "ap-0", tool: "x", server: null, inputPreview: null, status: "approved", requestedAt: "t", decidedAt: "t", decidedBy: null },
    ],
    outputs: [],
    startedAt: "2026-10-20T00:00:00.000Z",
    endedAt: null,
    error: null,
    origin: { kind: "console" },
    url: "https://console.ravi.bot/runs/1",
    ...overrides,
  };
}

const schedule: CloudSchedule = {
  id: "sch-1",
  agentId: AGENT,
  agentName: "Triage",
  cron: "0 9 * * 1",
  timezone: "America/Sao_Paulo",
  prompt: "Weekly triage",
  budgetUsd: null,
  enabled: true,
  actor: { id: "user-1", name: "Ana" },
  nextRunAt: null,
  lastRunAt: null,
  lastRunId: null,
};

/** Runs by id: RUN acts for user-1 in PROJECT, OTHERS_RUN for user-2 in PROJECT, anything else is in OTHER. */
const OTHERS_RUN = "99999999-9999-4999-8999-999999999999";
const loadRun: CloudAgentsOperationDeps["loadRun"] = async (_ctx, id) => ({
  run: id === RUN ? { projectId: PROJECT, actorUserId: "user-1" } : id === OTHERS_RUN ? { projectId: PROJECT, actorUserId: "user-2" } : { projectId: OTHER, actorUserId: "user-1" },
});

function handlers(deps: CloudAgentsOperationDeps) {
  const list = cloudAgentsOperations({ findProject, loadRun, ...deps });
  return (id: string): OperationHandler => {
    const handler = list.find((item) => item.definition.id === id);
    if (!handler) throw new Error(`missing ${id}`);
    return handler;
  };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function expectForbidden(error: unknown) {
  expect(error).toBeInstanceOf(ConsoleApiError);
  expect((error as ConsoleApiError).status).toBe(403);
  expect((error as ConsoleApiError).payload.error).toBe("operation_forbidden");
}

function expectPerson(ctx: CloudContext) {
  expect(ctx.workspace).toEqual({ user: { id: "user-1" }, organization: { id: "org" }, membership: { role: "developer" } });
  expect(ctx.surface).toBe("operation");
  expect(ctx.requestId).toBe("req");
}

describe("cloud agents operation definitions", () => {
  test("ids, classes, projectBound and strict schemas", () => {
    const byId = new Map(CLOUD_AGENTS_OPERATIONS.map((handler) => [handler.definition.id, handler]));
    expect([...byId.keys()]).toEqual([
      CLOUD_AGENTS_LIST_OPERATION_ID,
      CLOUD_AGENTS_GET_OPERATION_ID,
      CLOUD_RUNS_LIST_OPERATION_ID,
      CLOUD_RUNS_EVENTS_OPERATION_ID,
      CLOUD_SCHEDULES_LIST_OPERATION_ID,
      CLOUD_RUNS_MESSAGE_OPERATION_ID,
      CLOUD_RUNS_STOP_OPERATION_ID,
      CLOUD_APPROVALS_DECIDE_OPERATION_ID,
    ]);
    for (const handler of CLOUD_AGENTS_OPERATIONS) {
      const { definition } = handler;
      const write = definition.class === "write";
      expect(definition.needsConfirmation).toBe(write);
      expect(handler.projectBound).toBe(!write);
      expect(definition.surfaces).toEqual(["mcp"]);
      expect(definition.guests).toBe(false);
      expect(definition.inputSchema("mcp").additionalProperties).toBe(false);
      if (write) {
        expect(typeof definition.validateInput).toBe("function");
        expect(typeof handler.describeChange).toBe("function");
      }
    }
    expect(byId.get(CLOUD_AGENTS_LIST_OPERATION_ID)!.definition.inputSchema("mcp").required).toEqual(["project"]);
    expect(byId.get(CLOUD_RUNS_STOP_OPERATION_ID)!.definition.description).toContain("cannot be resumed");
    expect(() => byId.get(CLOUD_RUNS_MESSAGE_OPERATION_ID)!.definition.validateInput!({ runId: RUN, text: "" })).toThrow();
    expect(() => byId.get(CLOUD_APPROVALS_DECIDE_OPERATION_ID)!.definition.validateInput!({ runId: RUN, approvalId: "a", decision: "maybe" })).toThrow();
  });
});

describe("cloud agents reads", () => {
  test("agents.list resolves the project and calls the service as the person", async () => {
    const calls: Array<{ ctx: CloudContext; ref: unknown }> = [];
    const get = handlers({
      listAgents: async (ctx, ref) => {
        calls.push({ ctx, ref });
        return { agents: [agent()] };
      },
    });
    const output = (await get(CLOUD_AGENTS_LIST_OPERATION_ID).run({ actor: actor(), input: { project: "prs" } })) as {
      project: string;
      agents: Array<Record<string, unknown>>;
    };
    expectPerson(calls[0]!.ctx);
    expect(calls[0]!.ref).toBe(PROJECT);
    expect(output.project).toBe("prs");
    expect(output.agents[0]).toMatchObject({ id: AGENT, name: "Triage", deployedBy: "Ana", library: { slug: "triage", version: 3 } });
  });

  test("agents.list refuses another project for a cloud run", async () => {
    const get = handlers({ listAgents: async () => ({ agents: [] }) });
    expectForbidden(await rejection(get(CLOUD_AGENTS_LIST_OPERATION_ID).run({ actor: actor({ boundProjectId: PROJECT }), input: { project: "other" } })));
  });

  test("agents.get returns the agent, and refuses one outside a cloud run's project", async () => {
    let seen: CloudContext | null = null;
    const get = handlers({
      getAgent: async (ctx, id) => {
        seen = ctx;
        return { agent: agent({ id, projectId: id === AGENT ? PROJECT : OTHER }) };
      },
    });
    const output = (await get(CLOUD_AGENTS_GET_OPERATION_ID).run({ actor: actor(), input: { agentId: AGENT } })) as { agent: { id: string } };
    expectPerson(seen!);
    expect(output.agent.id).toBe(AGENT);
    expectForbidden(
      await rejection(get(CLOUD_AGENTS_GET_OPERATION_ID).run({ actor: actor({ boundProjectId: PROJECT }), input: { agentId: "other-agent" } })),
    );
  });

  test("runs.list passes the filters, never an origin, and projects runs compactly", async () => {
    const queries: Array<Record<string, unknown>> = [];
    let seen: CloudContext | null = null;
    const get = handlers({
      listRuns: async (ctx, query) => {
        seen = ctx;
        queries.push(query);
        return { runs: [run()], cursor: "next" };
      },
    });
    const output = (await get(CLOUD_RUNS_LIST_OPERATION_ID).run({
      actor: actor(),
      input: { project: "prs", agentId: AGENT, status: ["running", "waiting_approval"], limit: 10 },
    })) as { runs: Array<Record<string, unknown>>; nextCursor: string; contentTrust: string };
    expectPerson(seen!);
    expect(queries[0]).toEqual({ project: PROJECT, agent: AGENT, status: "running,waiting_approval", cursor: null, limit: 10 });
    expect(output.nextCursor).toBe("next");
    expect(output.contentTrust).toBe("untrusted");
    expect(output.runs[0]!.pendingApprovals).toEqual([{ id: "ap-1", tool: "ravi_pages_ship", server: "ravi", requestedAt: "t" }]);
    expect((output.runs[0]!.result as string).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(output)).not.toContain("{secret}");
    expect(await rejection(get(CLOUD_RUNS_LIST_OPERATION_ID).run({ actor: actor(), input: { project: "prs", origin: "installation" } }))).toBeDefined();
  });

  test("runs.list needs a project for a person, defaults to and keeps a cloud run's project", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const get = handlers({
      listRuns: async (_ctx, query) => {
        queries.push(query);
        return { runs: [], cursor: null };
      },
    });
    const missing = await rejection(get(CLOUD_RUNS_LIST_OPERATION_ID).run({ actor: actor(), input: {} }));
    expect((missing as ConsoleApiError).payload.error).toBe("payload_invalid");
    await get(CLOUD_RUNS_LIST_OPERATION_ID).run({ actor: actor({ boundProjectId: PROJECT }), input: {} });
    expect(queries[0]!.project).toBe(PROJECT);
    expectForbidden(await rejection(get(CLOUD_RUNS_LIST_OPERATION_ID).run({ actor: actor({ boundProjectId: PROJECT }), input: { project: "other" } })));
  });

  test("runs.events caps text, marks it untrusted and keeps a cloud run in its project", async () => {
    const events: CloudRunEvent[] = Array.from({ length: 10 }, (_, index) => ({
      seq: index + 1,
      at: "t",
      type: "message",
      role: "agent",
      text: "y".repeat(5000),
    }));
    let afterSeen: string | null = "unset";
    let seen: CloudContext | null = null;
    const get = handlers({
      listRunEvents: async (ctx, _id, after) => {
        seen = ctx;
        afterSeen = after;
        return { events, cursor: "10" };
      },
    });
    const output = (await get(CLOUD_RUNS_EVENTS_OPERATION_ID).run({ actor: actor(), input: { runId: RUN, after: "0" } })) as {
      events: CloudRunEvent[];
      nextCursor: string;
      truncated: boolean;
      contentTrust: string;
    };
    expectPerson(seen!);
    expect(afterSeen).toBe("0");
    expect(output.contentTrust).toBe("untrusted");
    expect(output.truncated).toBe(true);
    expect(output.events.reduce((sum, event) => sum + (event.text?.length ?? 0), 0)).toBeLessThanOrEqual(CLOUD_RUN_EVENTS_MAX_CHARS);
    expect(output.nextCursor).toBe(String(output.events.at(-1)!.seq));

    const bound = actor({ boundProjectId: PROJECT });
    await get(CLOUD_RUNS_EVENTS_OPERATION_ID).run({ actor: bound, input: { runId: RUN } });
    expectForbidden(await rejection(get(CLOUD_RUNS_EVENTS_OPERATION_ID).run({ actor: bound, input: { runId: "other-run" } })));
  });

  test("schedules.list resolves the project and refuses another one for a cloud run", async () => {
    const refs: unknown[] = [];
    const get = handlers({
      listSchedules: async (ctx, ref) => {
        expectPerson(ctx);
        refs.push(ref);
        return { schedules: [schedule] };
      },
    });
    const output = (await get(CLOUD_SCHEDULES_LIST_OPERATION_ID).run({ actor: actor(), input: { project: "prs" } })) as {
      schedules: Array<Record<string, unknown>>;
    };
    expect(refs).toEqual([PROJECT]);
    expect(output.schedules[0]).toMatchObject({ id: "sch-1", cron: "0 9 * * 1", runsAs: "Ana", enabled: true });
    expectForbidden(await rejection(get(CLOUD_SCHEDULES_LIST_OPERATION_ID).run({ actor: actor({ boundProjectId: PROJECT }), input: { project: "other" } })));
  });

  test("cloud agents errors keep their code; a guest or an unknown role is refused", async () => {
    const get = handlers({
      listAgents: async () => {
        throw cloudError("cloud_agents_not_enabled", "Cloud agents are not enabled.");
      },
    });
    const error = (await rejection(get(CLOUD_AGENTS_LIST_OPERATION_ID).run({ actor: actor(), input: { project: "prs" } }))) as ConsoleApiError;
    expect(error.status).toBe(403);
    expect(error.payload).toMatchObject({ error: "cloud_agents_not_enabled", reason: "Cloud agents are not enabled." });
    expectForbidden(await rejection(get(CLOUD_AGENTS_LIST_OPERATION_ID).run({ actor: actor({ kind: "guest", orgRole: null }), input: { project: "prs" } })));
    expectForbidden(await rejection(get(CLOUD_AGENTS_LIST_OPERATION_ID).run({ actor: actor({ orgRole: "superuser" }), input: { project: "prs" } })));
  });
});

describe("runs of other people", () => {
  const theirs = run({ id: OTHERS_RUN, actor: { id: "user-2", name: "Bia" } });

  test("a developer listing runs sees only their own; an admin sees everyone's", async () => {
    const get = handlers({ listRuns: async () => ({ runs: [run(), theirs], cursor: null }) });
    const mine = (await get(CLOUD_RUNS_LIST_OPERATION_ID).run({ actor: actor(), input: { project: "prs" } })) as { runs: Array<{ id: string }> };
    expect(mine.runs.map((item) => item.id)).toEqual([RUN]);
    const all = (await get(CLOUD_RUNS_LIST_OPERATION_ID).run({ actor: actor({ orgRole: "admin" }), input: { project: "prs" } })) as {
      runs: Array<{ id: string }>;
    };
    expect(all.runs.map((item) => item.id)).toEqual([RUN, OTHERS_RUN]);
  });

  test("a developer reading another person's run events is refused before the service runs; an admin can", async () => {
    const read: string[] = [];
    const get = handlers({
      listRunEvents: async (_ctx, id) => {
        read.push(id);
        return { events: [], cursor: null };
      },
    });
    expectForbidden(await rejection(get(CLOUD_RUNS_EVENTS_OPERATION_ID).run({ actor: actor(), input: { runId: OTHERS_RUN } })));
    expect(read).toEqual([]);
    await get(CLOUD_RUNS_EVENTS_OPERATION_ID).run({ actor: actor({ orgRole: "admin" }), input: { runId: OTHERS_RUN } });
    await get(CLOUD_RUNS_EVENTS_OPERATION_ID).run({ actor: actor({ orgRole: "owner" }), input: { runId: OTHERS_RUN } });
    expect(read).toEqual([OTHERS_RUN, OTHERS_RUN]);
  });

  test("a developer cannot message, stop or decide on another person's run; an admin can", async () => {
    const calls: string[] = [];
    const get = handlers({
      sendMessage: async () => {
        calls.push("message");
        return { run: theirs };
      },
      stopRun: async () => {
        calls.push("stop");
        return { run: theirs };
      },
      decideApproval: async (_ctx, runId, approvalId) => {
        calls.push("decide");
        return {
          run: { id: runId, status: "running", projectId: PROJECT },
          approval: { id: approvalId, toolName: "t", serverName: null, status: "denied", decidedAt: null },
          agentName: "Triage",
        };
      },
    });
    const inputs: Array<[string, Record<string, unknown>]> = [
      [CLOUD_RUNS_MESSAGE_OPERATION_ID, { runId: OTHERS_RUN, text: "hi" }],
      [CLOUD_RUNS_STOP_OPERATION_ID, { runId: OTHERS_RUN }],
      [CLOUD_APPROVALS_DECIDE_OPERATION_ID, { runId: OTHERS_RUN, approvalId: "ap-1", decision: "deny" }],
    ];
    for (const [id, input] of inputs) expectForbidden(await rejection(get(id).run({ actor: actor(), input })));
    expect(calls).toEqual([]);
    for (const [id, input] of inputs) await get(id).run({ actor: actor({ orgRole: "admin" }), input });
    expect(calls).toEqual(["message", "stop", "decide"]);
  });
});

describe("cloud agents writes", () => {
  test("runs.message sends the text as the person and describes the change", async () => {
    const sent: Array<{ ctx: CloudContext; id: string; body: unknown }> = [];
    const get = handlers({
      sendMessage: async (ctx, id, body) => {
        sent.push({ ctx, id, body });
        return { run: run({ status: "running" }) };
      },
    });
    const handler = get(CLOUD_RUNS_MESSAGE_OPERATION_ID);
    const output = (await handler.run({ actor: actor(), input: { runId: RUN, text: "Also check PR 12" } })) as { run: { status: string } };
    expectPerson(sent[0]!.ctx);
    expect(sent[0]!.id).toBe(RUN);
    expect(sent[0]!.body).toEqual({ text: "Also check PR 12" });
    expect(output.run.status).toBe("running");
    expect(handler.describeChange!({ runId: RUN, text: "Also check PR 12" })).toEqual([
      { label: "ação", value: "enviar uma mensagem para a execução do agente na nuvem" },
      { label: "execução", value: RUN },
      { label: "mensagem", value: "Also check PR 12" },
    ]);
  });

  test("runs.stop stops the run as the person and says it cannot be resumed", async () => {
    const stopped: Array<{ ctx: CloudContext; id: string }> = [];
    const get = handlers({
      stopRun: async (ctx, id) => {
        stopped.push({ ctx, id });
        return { run: run({ status: "stopped" }) };
      },
    });
    const handler = get(CLOUD_RUNS_STOP_OPERATION_ID);
    const output = (await handler.run({ actor: actor(), input: { runId: RUN } })) as { run: { status: string } };
    expectPerson(stopped[0]!.ctx);
    expect(stopped[0]!.id).toBe(RUN);
    expect(output.run.status).toBe("stopped");
    const lines = handler.describeChange!({ runId: RUN });
    expect(lines[0]).toEqual({ label: "ação", value: "parar a execução do agente na nuvem (não dá para retomar)" });
    expect(lines[1]).toEqual({ label: "execução", value: RUN });
  });

  test("approvals.decide sends the decision as the person and names run, approval and decision", async () => {
    const decided: Array<{ ctx: CloudContext; runId: string; approvalId: string; body: unknown }> = [];
    const get = handlers({
      decideApproval: async (ctx, runId, approvalId, body) => {
        decided.push({ ctx, runId, approvalId, body });
        return {
          run: { id: runId, status: "running", projectId: PROJECT },
          approval: { id: approvalId, toolName: "ravi_pages_ship", serverName: "ravi", status: "approved", decidedAt: new Date("2026-10-20T00:00:00Z") },
          agentName: "Triage",
        };
      },
    });
    const handler = get(CLOUD_APPROVALS_DECIDE_OPERATION_ID);
    const output = (await handler.run({ actor: actor(), input: { runId: RUN, approvalId: "ap-1", decision: "approve", reason: "ok" } })) as Record<
      string,
      unknown
    >;
    expectPerson(decided[0]!.ctx);
    expect(decided[0]).toMatchObject({ runId: RUN, approvalId: "ap-1", body: { decision: "approve", reason: "ok" } });
    expect(output).toEqual({
      run: { id: RUN, status: "running", agentName: "Triage" },
      approval: { id: "ap-1", tool: "ravi_pages_ship", server: "ravi", status: "approved", decidedAt: "2026-10-20T00:00:00.000Z" },
    });
    expect(handler.describeChange!({ runId: RUN, approvalId: "ap-1", decision: "deny", reason: "não" })).toEqual([
      { label: "ação", value: "negar uma chamada de ferramenta da execução do agente na nuvem" },
      { label: "execução", value: RUN },
      { label: "aprovação", value: "ap-1" },
      { label: "decisão", value: "negar" },
      { label: "motivo", value: "não" },
    ]);
  });
});
