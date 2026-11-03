import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { runOperation } from "@/server/console/operations";
import { callConsoleMcpTool, CONSOLE_MCP_SCOPES } from "@/server/mcp/console-tools";
import { rotateBridgeUrl } from "@/server/mcp/write";

import { type CloudContext, type CloudDeps, resolveCloudDeps } from "./access";
import { toolInputHash } from "./approvals";
import { handleCloudAgentsCliRequest } from "./cli";
import { getCloudCredential, setCloudCredential } from "./credential";
import { deployCloudAgent } from "./deploy";
import { isCloudAgentsError } from "./errors";
import { mirrorTraceEvents } from "./lifecycle";
import { consumeCloudApproval, resolveCloudRunCaller } from "./mcp";
import { FakeCloudProviderState, fakeCloudProvider, fakeCloudProviderFactory } from "./providers/fake";
import { getCloudRun, listCloudRunEvents, sendCloudRunMessage, startCloudRun, stopCloudRun } from "./runs";
import { decideCloudApproval } from "./service";
import { createCloudSchedule, runDueCloudSchedules, updateCloudSchedule } from "./schedules";
import { syncCloudRun } from "./sync";

// Cloud agents against a migrated Console database and the fake provider:
// run lifecycle, run-token write matching, schedules and authorization.
// Runs only with CLOUD_AGENTS_TEST_DATABASE_URL (and DATABASE_URL) pointing at
// that database. Creates its own organizations, users, project and Library
// agents, and deletes them afterwards. Never reaches a real provider.
const url = process.env.CLOUD_AGENTS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const orgSlug = `cloud-${suffix}`;
const project = { id: randomUUID(), slug: `cloud-p-${suffix}` };
const otherProject = { id: randomUUID(), slug: `cloud-o-${suffix}` };
const users = {
  owner: { id: randomUUID(), role: "owner" },
  dev: { id: randomUUID(), role: "developer" },
  dev2: { id: randomUUID(), role: "developer" },
  viewer: { id: randomUUID(), role: "viewer" },
  outsider: { id: randomUUID(), role: "owner" },
} as const;
// A placeholder shaped like an Anthropic key; the fake provider accepts any key.
const FAKE_API_KEY = `sk-ant-fake-${"0".repeat(32)}`;
const WRITE_TOOL = "ravi_bases_views_rows_create";
const WRITE_INPUT = { project: project.slug, viewId: "view-1", values: { title: "Weekly report" } };

const state = new FakeCloudProviderState();
let clock = Date.now();
const envOf = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const env = envOf({ RAVI_CLOUD_AGENTS_KEY: randomBytes(32).toString("base64"), RAVI_MCP_BASE_URL: "https://mcp.test.invalid" });
const minted: string[] = [];
const cloudDeps: CloudDeps = {
  providerFactory: fakeCloudProviderFactory(state),
  now: () => new Date(clock),
  env,
  mintRepositoryToken: async ({ repo }) => {
    minted.push(repo);
    return { url: `https://github.com/${repo}`, token: "fake-installation-token" };
  },
};

function ctx(user: keyof typeof users, overrides: { organizationId?: string; deps?: CloudDeps } = {}): CloudContext {
  return {
    workspace: {
      user: { id: users[user].id },
      organization: { id: overrides.organizationId ?? (user === "outsider" ? otherOrgId : orgId) },
      membership: { role: users[user].role },
    },
    requestId: `req-${randomUUID()}`,
    surface: "console",
    deps: overrides.deps ?? cloudDeps,
  };
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isCloudAgentsError(error)) return error.code;
    if (error instanceof ConsoleApiError) return error.payload.error;
    if (error instanceof CliApiError) return error.code;
    throw error;
  }
  return "ok";
}

async function runRow(runId: string) {
  const [row] = await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.id, runId)).limit(1);
  if (!row) throw new Error(`run ${runId} missing`);
  return row;
}

async function sessionOf(runId: string) {
  return state.session((await runRow(runId)).providerSessionId!);
}

/** Moves the clock past the read-sync staleness window. */
function later(ms = 15_000) {
  clock += ms;
}

async function publishAgent(slug: string, files: Record<string, string>) {
  const itemId = randomUUID();
  const versionId = randomUUID();
  const entries = Object.entries(files);
  await db.insert(schema.libraryItems).values({
    id: itemId,
    organizationId: orgId,
    projectId: project.id,
    kind: "agent",
    slug,
    name: slug,
    description: `${slug} agent`,
  });
  await db.insert(schema.libraryVersions).values({
    id: versionId,
    itemId,
    organizationId: orgId,
    versionNumber: 1,
    status: "published",
    contentHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0),
    publishedAt: new Date(),
  });
  await db.insert(schema.libraryFiles).values(
    entries.map(([path, content]) => ({
      versionId,
      path,
      content,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  );
  await db
    .update(schema.libraryItems)
    .set({ currentVersionId: versionId, currentVersionNumber: 1, publishedAt: new Date() })
    .where(eq(schema.libraryItems.id, itemId));
  return itemId;
}

describeDb("cloud agents (db, fake provider)", () => {
  beforeAll(async () => {
    const all = Object.entries(users);
    await db.insert(schema.users).values(all.map(([label, user]) => ({ id: user.id, primaryEmail: `cloud-${suffix}-${label}@example.test`, displayName: label })));
    await db.insert(schema.organizations).values([
      { id: orgId, slug: orgSlug, name: "Cloud agents test" },
      { id: otherOrgId, slug: `cloud-other-${suffix}`, name: "Other org" },
    ]);
    await db.insert(schema.organizationMemberships).values([
      ...all.filter(([label]) => label !== "outsider").map(([, user]) => ({ organizationId: orgId, userId: user.id, role: user.role })),
      { organizationId: otherOrgId, userId: users.outsider.id, role: "owner" },
    ]);
    await db.insert(schema.projects).values([
      { id: project.id, organizationId: orgId, slug: project.slug, name: "Cloud project" },
      { id: otherProject.id, organizationId: otherOrgId, slug: otherProject.slug, name: "Other project" },
    ]);
    await publishAgent("reporter", {
      "AGENTS.md": "# Reporter\n\nWrite the weekly report.\n",
      "HEARTBEAT.md": "Check whether this week's report is due.\n",
      "agent.json": JSON.stringify({ model: "sonnet", cloud: { budgetUsd: 2, repositories: ["acme/site"] } }),
    });
    await publishAgent("autopilot", {
      "AGENTS.md": "# Autopilot\n",
      "agent.json": JSON.stringify({ cloud: { tools: { writes: "auto" } } }),
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`);
    await db.delete(schema.users).where(inArray(schema.users.id, Object.values(users).map((user) => user.id)));
  });

  test("authorization: unconfigured, allowlist, roles and organizations", async () => {
    expect(await errorCode(getCloudCredential(ctx("owner", { deps: { ...cloudDeps, env: envOf({}) } })))).toBe("cloud_agents_unconfigured");
    const blocked = { ...cloudDeps, env: { ...env, RAVI_CLOUD_AGENTS_ORGS: "someone-else" } };
    expect(await errorCode(getCloudCredential(ctx("owner", { deps: blocked })))).toBe("cloud_agents_not_enabled");
    const allowed = { ...cloudDeps, env: { ...env, RAVI_CLOUD_AGENTS_ORGS: `someone-else, ${orgSlug.toUpperCase()}` } };
    expect((await getCloudCredential(ctx("owner", { deps: allowed }))).status).toBe("missing");

    expect(await errorCode(setCloudCredential(ctx("dev"), { provider: "anthropic", apiKey: FAKE_API_KEY }))).toBe("forbidden");
    expect(await errorCode(setCloudCredential(ctx("owner"), { provider: "anthropic", apiKey: "not-a-key" }))).toBe("validation_failed");
    state.rejectedKeys.add(`sk-ant-fake-${"9".repeat(32)}`);
    expect(await errorCode(setCloudCredential(ctx("owner"), { provider: "anthropic", apiKey: `sk-ant-fake-${"9".repeat(32)}` }))).toBe(
      "cloud_credential_invalid",
    );
    expect(await errorCode(startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "x" }))).toBe("cloud_credential_missing");

    const credential = await setCloudCredential(ctx("owner"), { provider: "anthropic", apiKey: FAKE_API_KEY, monthlyAlertUsd: 50 });
    expect(credential).toMatchObject({ configured: true, status: "active", monthlyAlertUsd: 50 });
    expect(JSON.stringify(credential)).not.toContain(FAKE_API_KEY);
    const [stored] = await db.select().from(schema.cloudAgentCredentials).where(eq(schema.cloudAgentCredentials.organizationId, orgId));
    expect(JSON.stringify(stored)).not.toContain(FAKE_API_KEY);

    expect(await errorCode(startCloudRun(ctx("viewer"), { project: project.slug, agent: "reporter", prompt: "x" }))).toBe("forbidden");
    expect(await errorCode(deployCloudAgent(ctx("viewer"), { project: project.slug, agent: "reporter" }))).toBe("forbidden");
    // writes: auto needs an owner or admin.
    expect(await errorCode(deployCloudAgent(ctx("dev"), { project: project.slug, agent: "autopilot" }))).toBe("forbidden");
    // Another organization's member never sees this project.
    expect(await errorCode(startCloudRun(ctx("outsider"), { project: project.id, agent: "reporter", prompt: "x" }))).not.toBe("ok");
  });

  let runId = "";

  test("deploy compiles once and reuses an unchanged deployment", async () => {
    const first = await deployCloudAgent(ctx("dev"), { project: project.slug, agent: "reporter" });
    expect(first.changed).toBe(true);
    expect(first.agent).toMatchObject({ name: "reporter", status: "ready", model: "claude-sonnet-5-5", config: { budgetUsd: 2, writes: "ask" } });
    const second = await deployCloudAgent(ctx("dev"), { project: project.slug, agent: "reporter" });
    expect(second.changed).toBe(false);
    expect(state.calls.filter((call) => call.method === "upsertAgent")).toHaveLength(1);
  });

  test("start: vault, run token, session with budget and repositories, then running", async () => {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Write the weekly report." });
    runId = run.id;
    expect(run).toMatchObject({ status: "running", trigger: "manual", budgetUsd: 2, prompt: "Write the weekly report.", actor: { id: users.dev.id } });
    expect(run.url).toContain(`/cloud/runs/${run.id}`);
    expect(minted).toEqual(["acme/site"]);

    const row = await runRow(run.id);
    const session = state.session(row.providerSessionId!);
    expect(session.budgetCents).toBe(200);
    expect(session.resources).toEqual([{ url: "https://github.com/acme/site", authorizationToken: "fake-installation-token", branch: null }]);
    expect(session.sent[0]).toEqual({ type: "message", text: "Write the weekly report." });
    const vault = state.vaults.get(row.providerVaultId!);
    expect(vault?.credentials.size).toBe(1);
    const [token] = await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, row.mcpTokenId!));
    expect(token).toMatchObject({ subjectUserId: users.dev.id, revokedAt: null });
    expect(token!.refreshTokenExpiresAt.getTime()).toBe(row.hardEndAt.getTime());
    // The prompt is stored encrypted.
    expect(row.promptEncrypted).not.toContain("weekly");
  });

  test("sync: an ask tool use pauses the run for the actor's approval", async () => {
    const session = await sessionOf(runId);
    state.emit(session.id, [
      { kind: "message", role: "agent", text: "Drafting the report." },
      { kind: "tool_use", tool: WRITE_TOOL, server: "ravi", input: WRITE_INPUT, permission: "ask" },
      { kind: "status", status: "idle", stopReason: { type: "requires_action", eventIds: [] } },
    ]);
    later();
    const { run } = await getCloudRun(ctx("dev"), runId);
    expect(run.status).toBe("waiting_approval");
    expect(run.result).toBe("Drafting the report.");
    expect(run.approvals).toHaveLength(1);
    expect(run.approvals[0]).toMatchObject({ tool: WRITE_TOOL, server: "ravi", status: "pending" });
    expect(run.approvals[0]!.inputPreview).toContain("Weekly report");

    const inbox = await db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.category, "cloud_agents")));
    expect(inbox.map((item) => item.eventType)).toContain("cloud_agents.approval.requested");
    expect(inbox.every((item) => item.targetId === users.dev.id)).toBe(true);

    const { events } = await listCloudRunEvents(ctx("dev"), runId, null);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["message", "tool_call", "status", "approval"]));
  });

  test("run token: a write is refused until approved, then runs once", async () => {
    const row = await runRow(runId);
    const [bridge] = await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, row.mcpTokenId!));
    const caller = await resolveCloudRunCaller({ organizationId: orgId, userId: users.dev.id, bridgeId: bridge!.bridgeId, tokenId: row.mcpTokenId });
    expect(caller?.runs).toEqual([{ id: runId, writes: "ask" }]);
    expect(await resolveCloudRunCaller({ organizationId: orgId, userId: users.dev.id, bridgeId: randomUUID() })).toBeNull();

    const runs: unknown[] = [];
    const mcpCall = () =>
      callConsoleMcpTool(
        {
          organizationId: orgId,
          userId: users.dev.id,
          bridgeId: bridge!.bridgeId,
          scopes: [CONSOLE_MCP_SCOPES.read, CONSOLE_MCP_SCOPES.write],
          requestId: `req-${randomUUID()}`,
          tokenId: row.mcpTokenId,
        },
        { operationId: "ravi.bases.views.rows.create", arguments: { ...WRITE_INPUT } },
        {
          validateWriteInput: () => {},
          runOperation: async (input) => {
            runs.push(input);
            return { id: input.id, class: "write", output: { ok: true } };
          },
        },
      );
    expect(await errorCode(mcpCall())).toBe("cloud_run_write_not_approved");

    // Only the actor or an org admin decides; a viewer never does.
    const approvalId = (await getCloudRun(ctx("dev"), runId)).run.approvals[0]!.id;
    expect(await errorCode(decideCloudApproval(ctx("viewer"), runId, approvalId, { decision: "approve" }))).toBe("forbidden");
    await decideCloudApproval(ctx("dev"), runId, approvalId, { decision: "approve" });
    const session = await sessionOf(runId);
    expect(session.sent.at(-1)).toMatchObject({ type: "confirmation", allow: true });
    expect((await runRow(runId)).status).toBe("running");

    const result = await mcpCall();
    expect(result.status).toBe("ok");
    expect(runs).toEqual([
      { id: "ravi.bases.views.rows.create", actor: expect.objectContaining({ userId: users.dev.id }), input: WRITE_INPUT, confirmed: true, idempotencySeed: `cloud:${approvalId}` },
    ]);
    // Consumed once.
    expect(await errorCode(mcpCall())).toBe("cloud_run_write_not_approved");
    expect(await consumeCloudApproval({ runIds: [runId], toolNames: [WRITE_TOOL], inputHash: toolInputHash(WRITE_INPUT), now: new Date(clock) })).toBeNull();
  });

  test("complete: the last agent message is the result; the token is revoked and usage recorded", async () => {
    const session = await sessionOf(runId);
    state.setUsage(session.id, { inputTokens: 1200, outputTokens: 300, listCostCents: 42, activeSeconds: 95 });
    state.emit(session.id, [
      { kind: "tool_result", toolUseId: "x", isError: false, text: "row created" },
      { kind: "message", role: "agent", text: "The report is in the CRM." },
      { kind: "status", status: "idle", stopReason: { type: "end_turn" } },
    ]);
    later();
    const { run } = await getCloudRun(ctx("dev"), runId);
    expect(run).toMatchObject({ status: "completed", result: "The report is in the CRM.", costUsd: 0.42, runningSeconds: 95 });
    expect(run.tokens).toMatchObject({ input: 1200, output: 300 });
    expect(run.endedAt).not.toBeNull();
    const row = await runRow(runId);
    const tokens = await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, row.mcpTokenId!));
    expect(tokens[0]!.revokedAt).not.toBeNull();
    const usage = await db.execute<{ metric_key: string; total: string }>(
      sql`select metric_key, sum(quantity)::text as total from usage_events where organization_id = ${orgId}::uuid and source = 'cloud_agents' group by metric_key`,
    );
    const totals = Object.fromEntries([...usage].map((entry) => [entry.metric_key, Number(entry.total)]));
    expect(totals["cloud_agents.list_cost_usd_micros"]).toBe(420_000);
    expect(totals["cloud_agents.running_seconds"]).toBe(95);
    expect(totals["cloud_agents.runs"]).toBeGreaterThanOrEqual(1);
    // Stopping a finished run is a no-op that returns it as it is.
    expect((await stopCloudRun(ctx("dev"), runId)).run.status).toBe("completed");
  });

  test("budget: a session past the run's budget is interrupted and ends budget_exceeded", async () => {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Big job", budgetUsd: 1 });
    const session = await sessionOf(run.id);
    state.setUsage(session.id, { listCostCents: 101 });
    state.emit(session.id, [{ kind: "status", status: "running", stopReason: null }]);
    later();
    const synced = await getCloudRun(ctx("dev"), run.id);
    expect(synced.run.status).toBe("budget_exceeded");
    expect(session.sent.at(-1)).toMatchObject({ type: "interrupt" });
  });

  test("stop: interrupts the session and ends the run stopped", async () => {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Stop me" });
    const stopped = await stopCloudRun(ctx("dev"), run.id);
    expect(stopped.run.status).toBe("stopped");
    expect((await sessionOf(run.id)).sent.at(-1)).toMatchObject({ type: "interrupt" });
    expect((await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, (await runRow(run.id)).mcpTokenId!)))[0]!.revokedAt).not.toBeNull();
  });

  test("failure: a provider error at session start leaves a failed run and cleans up the vault and token", async () => {
    state.failNext("createSession");
    let failure: unknown;
    try {
      await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Will fail" });
    } catch (error) {
      failure = error;
    }
    expect(isCloudAgentsError(failure, "provider_error")).toBe(true);
    const failedId = (failure as { details: { runId: string } }).details.runId;
    const row = await runRow(failedId);
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("provider_error");
    expect(state.vaults.get(row.providerVaultId!)?.deleted).toBe(true);
    const tokens = await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, row.mcpTokenId!));
    expect(tokens[0]!.revokedAt).not.toBeNull();
  });

  test("idempotency: the same key replays, a different request with it conflicts", async () => {
    const body = { project: project.slug, agent: "reporter", prompt: "Once", idempotencyKey: `idem-${suffix}` };
    const first = await startCloudRun(ctx("dev"), body);
    const again = await startCloudRun(ctx("dev"), body);
    expect(again.run.id).toBe(first.run.id);
    expect(await errorCode(startCloudRun(ctx("dev"), { ...body, prompt: "Twice" }))).toBe("idempotency_conflict");
    await stopCloudRun(ctx("dev"), first.run.id);
  });

  test("schedules: a due slot starts one run as its actor; a lost role disables it", async () => {
    const { schedule } = await createCloudSchedule(ctx("dev"), { project: project.slug, agent: "reporter", cron: "0 9 * * *", timezone: "UTC" });
    expect(schedule).toMatchObject({ prompt: null, enabled: true, actor: { id: users.dev.id } });
    const slot = new Date(schedule.nextRunAt!);
    expect(slot.getUTCHours()).toBe(9);
    expect(slot.getTime()).toBeGreaterThan(clock);

    const resolved = resolveCloudDeps(cloudDeps);
    clock = slot.getTime() + 1000;
    const first = await runDueCloudSchedules(cloudDeps, resolved);
    expect(first.started).toBeGreaterThanOrEqual(1);
    const [afterFirst] = await db.select().from(schema.cloudAgentSchedules).where(eq(schema.cloudAgentSchedules.id, schedule.id));
    expect(afterFirst!.lastRunId).not.toBeNull();
    expect(afterFirst!.nextRunAt!.getTime()).toBe(slot.getTime() + 24 * 60 * 60_000);
    const run = await runRow(afterFirst!.lastRunId!);
    expect(run).toMatchObject({ trigger: "schedule", scheduleId: schedule.id, actorUserId: users.dev.id, idempotencyKey: `schedule:${schedule.id}:${slot.toISOString()}` });
    expect((await sessionOf(run.id)).sent[0]).toEqual({ type: "message", text: "Check whether this week's report is due." });

    // A retried tick for the same slot never starts a second run.
    await db.update(schema.cloudAgentSchedules).set({ nextRunAt: slot }).where(eq(schema.cloudAgentSchedules.id, schedule.id));
    await runDueCloudSchedules(cloudDeps, resolved);
    const [replayed] = await db.select().from(schema.cloudAgentSchedules).where(eq(schema.cloudAgentSchedules.id, schedule.id));
    expect(replayed!.lastRunId).toBe(run.id);
    expect((await db.select().from(schema.cloudAgentRuns).where(eq(schema.cloudAgentRuns.scheduleId, schedule.id))).length).toBe(1);

    // The actor becomes a viewer: the next slot disables the schedule instead of running.
    await db
      .update(schema.organizationMemberships)
      .set({ role: "viewer" })
      .where(and(eq(schema.organizationMemberships.organizationId, orgId), eq(schema.organizationMemberships.userId, users.dev.id)));
    clock = replayed!.nextRunAt!.getTime() + 1000;
    const second = await runDueCloudSchedules(cloudDeps, resolved);
    expect(second.disabled).toBeGreaterThanOrEqual(1);
    const [disabled] = await db.select().from(schema.cloudAgentSchedules).where(eq(schema.cloudAgentSchedules.id, schedule.id));
    expect(disabled).toMatchObject({ enabled: false, nextRunAt: null });
    expect(disabled!.lastRunId).toBe(run.id);
    await db
      .update(schema.organizationMemberships)
      .set({ role: "developer" })
      .where(and(eq(schema.organizationMemberships.organizationId, orgId), eq(schema.organizationMemberships.userId, users.dev.id)));
    await stopCloudRun(ctx("dev"), run.id);
  });

  test("operations: runs.start and runs.get run as the person; cloud errors keep their code", async () => {
    const actor = {
      kind: "member" as const,
      organizationId: orgId,
      userId: users.dev.id,
      email: null,
      orgRole: "developer",
      surface: "mcp" as const,
      requestId: `req-${randomUUID()}`,
      site: null,
      pagesSessionId: null,
    };
    const deps = { cloudAgents: cloudDeps, insertAudit: async () => {} };
    const input = { project: project.slug, agent: "reporter", prompt: "From MCP" };
    expect(await errorCode(runOperation({ id: "ravi.cloud_agents.runs.start", actor, input }, deps))).toBe("operation_confirmation_required");
    const started = await runOperation({ id: "ravi.cloud_agents.runs.start", actor, input, confirmed: true, idempotencySeed: "seed-1" }, deps);
    const run = (started.output as { run: { id: string; trigger: string; origin: { kind: string } } }).run;
    expect(run).toMatchObject({ trigger: "agent", origin: { kind: "agent" } });
    const replay = await runOperation({ id: "ravi.cloud_agents.runs.start", actor, input, confirmed: true, idempotencySeed: "seed-1" }, deps);
    expect((replay.output as { run: { id: string } }).run.id).toBe(run.id);

    const read = await runOperation({ id: "ravi.cloud_agents.runs.get", actor, input: { runId: run.id } }, deps);
    expect((read.output as { run: { id: string; status: string } }).run).toMatchObject({ id: run.id, status: "running" });
    let failure: unknown;
    try {
      await runOperation({ id: "ravi.cloud_agents.runs.get", actor: { ...actor, orgRole: "viewer" }, input: { runId: run.id } }, deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConsoleApiError);
    expect((failure as ConsoleApiError).status).toBe(404);
    expect((failure as ConsoleApiError).payload.error).toBe("not_found");
    await stopCloudRun(ctx("dev"), run.id);
  });

  test("CLI route: scopes, routes and status codes", async () => {
    const auth = (scopes: string[]) => ({
      user: { id: users.owner.id },
      organization: { id: orgId, slug: orgSlug },
      membership: { role: "owner" },
      scopes,
      localInstallation: null,
    });
    const request = (method: string, path: string, scopes: string[], body: unknown = {}, query = "") =>
      handleCloudAgentsCliRequest({
        auth: auth(scopes) as unknown as Parameters<typeof handleCloudAgentsCliRequest>[0]["auth"],
        requestId: `req-${randomUUID()}`,
        method,
        segments: path.split("/").filter(Boolean),
        body,
        searchParams: new URLSearchParams(query),
        deps: cloudDeps,
      });
    const credential = await request("GET", "credential", ["console.projects.read"]);
    expect(credential).toMatchObject({ kind: "json", status: 200, payload: { credential: { configured: true, status: "active" } } });
    expect(await errorCode(request("POST", "credential", ["console.projects.read"], { provider: "anthropic", apiKey: FAKE_API_KEY }))).toBe("PROJECT_ACCESS_DENIED");
    const agents = await request("GET", "agents", ["console.projects.read"], {}, `project=${project.slug}`);
    expect(((agents as { payload: { agents: { name: string }[] } }).payload.agents).map((agent) => agent.name)).toEqual(["reporter"]);
    const deployed = await request("POST", "agents/deploy", ["console.projects.read", "console.projects.link"], { project: project.slug, agent: "reporter" });
    expect(deployed.status).toBe(200);
    const runs = await request("GET", "runs", ["console.projects.read"], {}, `project=${project.slug}&status=completed`);
    expect(((runs as { payload: { runs: { id: string }[] } }).payload.runs).map((run) => run.id)).toContain(runId);
    expect(await errorCode(request("GET", "nothing/here", ["console.projects.read"]))).toBe("not_found");
  });

  /** A run of `reporter` started by dev that ended completed. */
  async function completedRun(prompt: string) {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt });
    const session = await sessionOf(run.id);
    state.emit(session.id, [
      { kind: "message", role: "agent", text: "Done." },
      { kind: "status", status: "idle", stopReason: { type: "end_turn" } },
    ]);
    later();
    expect((await getCloudRun(ctx("dev"), run.id)).run.status).toBe("completed");
    return run.id;
  }

  const liveRunTokens = (id: string) =>
    db
      .select()
      .from(schema.mcpOAuthTokens)
      .where(and(eq(schema.mcpOAuthTokens.deviceLabel, `cloud-run:${id}`), isNull(schema.mcpOAuthTokens.revokedAt)));

  test("follow-ups: only the actor or an admin; a failed reopen puts the run back; one token survives races", async () => {
    const id = await completedRun("Follow me up");
    const before = await runRow(id);
    expect(await errorCode(sendCloudRunMessage(ctx("dev2"), id, { text: "Me too" }))).toBe("forbidden");

    // The vault update fails, then the message fails: the run comes back as it was.
    state.failNext("updateMcpCredential");
    expect(await errorCode(sendCloudRunMessage(ctx("dev"), id, { text: "Again" }))).toBe("provider_error");
    state.failNext("sendMessage");
    expect(await errorCode(sendCloudRunMessage(ctx("dev"), id, { text: "Again" }))).toBe("provider_error");
    const restored = await runRow(id);
    expect(restored).toMatchObject({ status: "completed", actorUserId: users.dev.id, mcpTokenId: before.mcpTokenId, endedAt: before.endedAt });
    expect(await liveRunTokens(id)).toHaveLength(0);

    // Two follow-ups at once reopen the run once and leave one live token.
    const results = await Promise.all([1, 2].map((n) => errorCode(sendCloudRunMessage(ctx("dev"), id, { text: `Race ${n}` }))));
    expect(results).toContain("ok");
    const reopened = await runRow(id);
    expect(reopened.status).toBe("running");
    const live = await liveRunTokens(id);
    expect(live.map((token) => token.id)).toEqual([reopened.mcpTokenId!]);
    expect(live[0]!.subjectUserId).toBe(users.dev.id);
    await stopCloudRun(ctx("dev"), id);
  });

  test("follow-ups: an owner's message takes the run over and the old token stops working", async () => {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Take me over" });
    const before = await runRow(run.id);
    const [oldToken] = await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, before.mcpTokenId!));
    const moved = await sendCloudRunMessage(ctx("owner"), run.id, { text: "I take it from here" });
    expect(moved.run.actor).toMatchObject({ id: users.owner.id });
    const after = await runRow(run.id);
    expect(after.actorUserId).toBe(users.owner.id);
    expect(after.mcpTokenId).not.toBe(before.mcpTokenId);
    const [old] = await db.select().from(schema.mcpOAuthTokens).where(eq(schema.mcpOAuthTokens.id, before.mcpTokenId!));
    expect(old!.revokedAt).not.toBeNull();
    const live = await liveRunTokens(run.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: after.mcpTokenId, subjectUserId: users.owner.id });
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "cloud_agents.run.actor_changed"), eq(schema.auditEvents.targetId, run.id)));
    expect(audits).toHaveLength(1);
    expect((await sessionOf(run.id)).sent.at(-1)).toEqual({ type: "message", text: "I take it from here" });

    // The old token's chain no longer belongs to any run.
    const caller = await resolveCloudRunCaller({ organizationId: orgId, userId: users.dev.id, bridgeId: oldToken!.bridgeId, tokenId: oldToken!.id });
    expect(caller?.runs).toEqual([]);
    // A cloud bridge's URL is never rotated by the generic MCP path.
    expect(await rotateBridgeUrl({ organizationId: orgId, bridgeId: oldToken!.bridgeId })).toBeNull();
    await stopCloudRun(ctx("owner"), run.id);
  });

  test("approvals: a provider failure keeps the approval pending; a lost decision is asked for again", async () => {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Needs approval" });
    const session = await sessionOf(run.id);
    state.emit(session.id, [
      { kind: "tool_use", tool: WRITE_TOOL, server: "ravi", input: WRITE_INPUT, permission: "ask" },
      { kind: "status", status: "idle", stopReason: { type: "requires_action", eventIds: [] } },
    ]);
    later();
    const waiting = (await getCloudRun(ctx("dev"), run.id)).run;
    expect(waiting.status).toBe("waiting_approval");
    const approvalId = waiting.approvals[0]!.id;

    state.failNext("confirmTool");
    expect(await errorCode(decideCloudApproval(ctx("dev"), run.id, approvalId, { decision: "approve" }))).toBe("provider_error");
    const [kept] = await db.select().from(schema.cloudAgentApprovals).where(eq(schema.cloudAgentApprovals.id, approvalId));
    expect(kept).toMatchObject({ status: "pending", decidedAt: null });
    expect((await runRow(run.id)).status).toBe("waiting_approval");

    await decideCloudApproval(ctx("dev"), run.id, approvalId, { decision: "approve" });
    expect((await runRow(run.id)).status).toBe("running");
    // The provider never took it: its running event is lost and the session idles again.
    session.events.pop();
    session.status = "idle";
    clock += 3 * 60_000;
    const resolved = resolveCloudDeps(cloudDeps);
    const lost = await syncCloudRun(run.id, resolved, { minAgeMs: 0 });
    expect(lost.run.status).toBe("waiting_approval");
    expect(lost.run.errorMessage).toContain("approve or deny the tool call again");

    // Approving again resends the decision.
    await decideCloudApproval(ctx("dev"), run.id, approvalId, { decision: "approve" });
    expect(session.sent.filter((sent) => sent.type === "confirmation")).toHaveLength(2);
    expect((await runRow(run.id)).status).toBe("running");
    state.emit(session.id, [{ kind: "status", status: "idle", stopReason: { type: "end_turn" } }]);
    later();
    expect((await syncCloudRun(run.id, resolved, { minAgeMs: 0 })).run.status).toBe("completed");
  });

  test("status guards: a sync never moves or clears a run that ended meanwhile", async () => {
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "Race the stop" });
    const session = await sessionOf(run.id);
    state.emit(session.id, [
      { kind: "tool_use", tool: WRITE_TOOL, server: "ravi", input: WRITE_INPUT, permission: "ask" },
      { kind: "status", status: "idle", stopReason: { type: "requires_action", eventIds: [] } },
    ]);
    // The run is stopped elsewhere while this sync talks to the provider.
    const racing: CloudDeps = {
      ...cloudDeps,
      providerFactory: ({ apiKey }) => {
        const provider = fakeCloudProvider(state, apiKey);
        return {
          ...provider,
          getSession: async (sessionId) => {
            await db
              .update(schema.cloudAgentRuns)
              .set({ status: "stopped", errorCode: "stopped_elsewhere", errorMessage: "Stopped meanwhile.", endedAt: new Date(clock) })
              .where(eq(schema.cloudAgentRuns.id, run.id));
            return provider.getSession(sessionId);
          },
        };
      },
    };
    const synced = await syncCloudRun(run.id, resolveCloudDeps(racing), { minAgeMs: 0 });
    expect(synced.run.status).toBe("stopped");
    expect(await runRow(run.id)).toMatchObject({ status: "stopped", errorCode: "stopped_elsewhere", errorMessage: "Stopped meanwhile." });
    const [approval] = await db.select().from(schema.cloudAgentApprovals).where(eq(schema.cloudAgentApprovals.runId, run.id));
    expect(approval!.status).toBe("pending");
    expect(await errorCode(decideCloudApproval(ctx("dev"), run.id, approval!.id, { decision: "approve" }))).toBe("cloud_run_not_active");
    expect(session.sent.some((sent) => sent.type === "confirmation")).toBe(false);
  });

  test("schedules: changing what a schedule runs makes the editor its actor; disabling does not", async () => {
    const { schedule } = await createCloudSchedule(ctx("dev"), {
      project: project.slug,
      agent: "reporter",
      cron: "0 7 * * 1",
      timezone: "UTC",
      prompt: "Monday report",
    });
    const actorOf = async () =>
      (await db.select().from(schema.cloudAgentSchedules).where(eq(schema.cloudAgentSchedules.id, schedule.id)))[0]!.actorUserId;
    await updateCloudSchedule(ctx("dev2"), schedule.id, { enabled: false });
    expect(await actorOf()).toBe(users.dev.id);
    await updateCloudSchedule(ctx("dev2"), schedule.id, { prompt: "Monday report" });
    expect(await actorOf()).toBe(users.dev.id);
    await updateCloudSchedule(ctx("dev2"), schedule.id, { cron: "0 8 * * 1" });
    expect(await actorOf()).toBe(users.dev2.id);
    await updateCloudSchedule(ctx("owner"), schedule.id, { prompt: "Monday report, short" });
    expect(await actorOf()).toBe(users.owner.id);
    await updateCloudSchedule(ctx("dev"), schedule.id, { enabled: true });
    expect(await actorOf()).toBe(users.dev.id);
    await updateCloudSchedule(ctx("dev"), schedule.id, { enabled: false });
  });

  test("trace: concurrent mirrors never share a sequence", async () => {
    const row = await runRow(runId);
    const batch = (prefix: string) =>
      Array.from({ length: 5 }, (_, index) => ({ sourceEventId: `${prefix}-${suffix}-${index}`, at: new Date(clock), type: "message" as const, text: prefix }));
    await Promise.all([mirrorTraceEvents(row, batch("a")), mirrorTraceEvents(row, batch("b")), mirrorTraceEvents(row, batch("a"))]);
    const events = await db
      .select({ sequence: schema.runtimeTraceEvents.sequence })
      .from(schema.runtimeTraceEvents)
      .where(eq(schema.runtimeTraceEvents.traceSessionId, row.runtimeTraceSessionId!));
    const sequences = events.map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    const mirrored = await db
      .select({ id: schema.runtimeTraceEvents.id })
      .from(schema.runtimeTraceEvents)
      .where(and(eq(schema.runtimeTraceEvents.traceSessionId, row.runtimeTraceSessionId!), sql`${schema.runtimeTraceEvents.sourceEventId} like ${`%-${suffix}-%`}`));
    expect(mirrored).toHaveLength(10);
  });

  test("credential: a different key is a new credential and the next run recreates provider objects", async () => {
    const credentialRow = async () =>
      (
        await db
          .select()
          .from(schema.cloudAgentCredentials)
          .where(and(eq(schema.cloudAgentCredentials.organizationId, orgId), sql`${schema.cloudAgentCredentials.status} <> 'revoked'`))
      )[0]!;
    const before = await credentialRow();
    await setCloudCredential(ctx("owner"), { provider: "anthropic", apiKey: FAKE_API_KEY, monthlyAlertUsd: 50 });
    expect((await credentialRow()).id).toBe(before.id);
    const NEXT_KEY = `sk-ant-fake-${"1".repeat(32)}`;
    await setCloudCredential(ctx("owner"), { provider: "anthropic", apiKey: NEXT_KEY });
    const after = await credentialRow();
    expect(after.id).not.toBe(before.id);

    const upserts = () => state.calls.filter((call) => call.method === "upsertAgent");
    const count = upserts().length;
    const { run } = await startCloudRun(ctx("dev"), { project: project.slug, agent: "reporter", prompt: "New key" });
    const created = upserts().slice(count);
    expect(created).toHaveLength(1);
    expect(created[0]!.apiKey).toBe(NEXT_KEY);
    expect(created[0]!.args[1]).toBeNull();
    await stopCloudRun(ctx("dev"), run.id);
  });

  test("operations: a project-bound caller reads only its own project's runs", async () => {
    const actor = {
      kind: "member" as const,
      organizationId: orgId,
      userId: users.dev.id,
      email: null,
      orgRole: "developer",
      surface: "mcp" as const,
      requestId: `req-${randomUUID()}`,
      site: null,
      pagesSessionId: null,
    };
    const deps = { cloudAgents: cloudDeps, insertAudit: async () => {} };
    const read = (boundProjectId: string) => runOperation({ id: "ravi.cloud_agents.runs.get", actor: { ...actor, boundProjectId }, input: { runId } }, deps);
    expect(((await read(project.id)).output as { run: { id: string } }).run.id).toBe(runId);
    expect(await errorCode(read(randomUUID()))).toBe("operation_forbidden");
  });

});
