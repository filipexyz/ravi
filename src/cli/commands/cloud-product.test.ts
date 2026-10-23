import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFakeProductConsole,
  type FakeProductConsole,
  fakeCloudWorker,
} from "../../cloud-agents/test-fixtures-product.js";
import { fakeCloudAgent, fakeCloudSessionOpener } from "../../cloud-agents/test-fixtures.js";
import {
  getCloudWorkersDir,
  readCloudWorkerKey,
  readCloudWorkerState,
  writeCloudWorkerKey,
  writeCloudWorkerRuntime,
} from "../../cloud-agents/worker-store.js";
import { WorkerSessionError } from "../../cloud-agents/worker-session.js";
import type { CloudProductCommandDeps } from "../cloud-product-contract.js";
import { getCliOnlyMetadata, getReturnsMetadata } from "../decorators.js";
import { CloudAgentAdminCommands } from "./cloud-agent-admin.js";
import { CloudCatalogCommands, CloudCatalogPacksCommands } from "./cloud-catalog.js";
import { CloudCreditsCommands } from "./cloud-credits.js";
import { CloudSecretsCommands } from "./cloud-secrets.js";
import { CloudSettingsCommands } from "./cloud-settings.js";
import { CloudTriggersCommands } from "./cloud-triggers.js";
import { CloudWebhookCommands } from "./cloud-webhook.js";
import { CloudWorkerCommands, CloudWorkerKeyCommands } from "./cloud-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "ravi-cloud-product-"));
  tempDirs.push(dir);
  return { RAVI_STATE_DIR: dir };
}

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

function deps(fake: FakeProductConsole, overrides: CloudProductCommandDeps = {}): CloudProductCommandDeps {
  return {
    openSession: fakeCloudSessionOpener(fake),
    inAgentRuntime: () => false,
    operatorOwnTurn: () => true,
    currentSessionName: () => null,
    readSecret: async () => {
      throw new Error("stdin read unexpectedly");
    },
    ...overrides,
  };
}

function expectBrake(outcome: { error?: unknown; lines: string[] }, fake: FakeProductConsole) {
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

describe("ravi cloud secrets", () => {
  it("list matches its schema and never shows a value", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => new CloudSecretsCommands(deps(fake)).list(undefined, true));
    expectSchema(CloudSecretsCommands, "list", outcome.result);
    expect(fake.requests[0]!.query.get("project")).toBeNull();
  });

  it("set is CLI-only and braked; stdin is read only with --execute and the value is never printed", async () => {
    const fake = createFakeProductConsole();
    let reads = 0;
    const commands = new CloudSecretsCommands(
      deps(fake, {
        readSecret: async () => {
          reads += 1;
          return "crm-value-7q7q\n";
        },
      }),
    );
    expect(getCliOnlyMetadata(CloudSecretsCommands).has("set")).toBe(true);
    const plan = expectBrake(
      await capture(() => commands.set("CRM_TOKEN", ["api.crm.test"], undefined, true, true, false)),
      fake,
    );
    expect(plan).toMatchObject({
      name: "CRM_TOKEN",
      scope: "organization",
      allowedHosts: ["api.crm.test"],
      replaces: false,
    });
    expect(reads).toBe(0);

    const done = await capture(() => commands.set("CRM_TOKEN", ["api.crm.test"], "clinica", true, false, true));
    expect(reads).toBe(1);
    expect(fake.writes()[0]!.body).toEqual({
      project: "clinica",
      name: "CRM_TOKEN",
      value: "crm-value-7q7q",
      allowedHosts: ["api.crm.test"],
    });
    expect(done.lines.join("\n")).not.toContain("crm-value-7q7q");
    expect(done.lines.join("\n")).toContain("…7q7q");
    expectSchema(CloudSecretsCommands, "set", done.result);
  });

  it("set refuses a bad name, a bad host, no --stdin and an agent's turn", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudSecretsCommands(deps(fake));
    const badName = await capture(() => commands.set("crm token", ["api.crm.test"], undefined, true, true, true));
    expect(badName.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const badHost = await capture(() => commands.set("CRM_TOKEN", ["https://x.test/"], undefined, true, true, true));
    expect(badHost.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const noStdin = await capture(() => commands.set("CRM_TOKEN", ["api.crm.test"], undefined, false, true, true));
    expect(noStdin.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const agent = await capture(() =>
      new CloudSecretsCommands(deps(fake, { inAgentRuntime: () => true })).set(
        "CRM_TOKEN",
        ["api.crm.test"],
        undefined,
        true,
        true,
        true,
      ),
    );
    expect(agent.error).toMatchObject({ code: "CLOUD_AGENT_CANNOT_SET_SECRET", exitCode: 3 });
    expect(fake.requests).toHaveLength(0);
  });

  it("remove applies at once by name, and a missing one is CLOUD_SECRET_NOT_FOUND", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudSecretsCommands(deps(fake));
    const done = await capture(() => commands.remove("STRIPE_API_KEY", undefined, true));
    expect(done.result).toMatchObject({ id: "sec_1", removed: true });
    expect(fake.writes().map((request) => request.path)).toEqual(["/secrets/sec_1/remove"]);
    const missing = await capture(() => commands.remove("NOPE", undefined, true));
    expect(missing.error).toMatchObject({ code: "CLOUD_SECRET_NOT_FOUND", exitCode: 1 });
  });
});

describe("ravi cloud triggers", () => {
  const create = (
    commands: CloudTriggersCommands,
    input: { prompt?: string; disabled?: boolean; deliverTo?: string; execute?: boolean } = {},
  ) =>
    commands.create(
      "triage",
      "bases",
      input.prompt ?? "Triage this request: {{event}}",
      "base_1",
      undefined,
      ["row.created"],
      undefined,
      undefined,
      "10",
      undefined,
      undefined,
      "2",
      input.deliverTo,
      input.disabled,
      "clinica",
      true,
      input.execute,
    );

  it("create is braked when enabled; the plan names the source, caps and delivery", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudTriggersCommands(deps(fake, { currentSessionName: () => "teste-main" }));
    const plan = expectBrake(await capture(() => create(commands)), fake);
    expect(plan).toMatchObject({
      agent: "triage",
      project: "clinica",
      source: "bases",
      filter: { baseId: "base_1", events: ["row.created"] },
      dailyCap: 10,
      budgetUsd: 2,
      delivery: { kind: "session", sessionName: "teste-main" },
      enabled: true,
    });
    const done = await capture(() => create(commands, { execute: true }));
    expect(done.result).toMatchObject({ trigger: { source: "bases", enabled: true } });
    expect(fake.writes()[0]!.body).toMatchObject({
      project: "clinica",
      agent: "triage",
      dailyCap: 10,
      budgetUsd: 2,
      delivery: { kind: "session", sessionName: "teste-main" },
    });
    expectSchema(CloudTriggersCommands, "create", done.result);
  });

  it("create --disabled applies at once; --deliver-to none sends no result", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudTriggersCommands(deps(fake));
    const done = await capture(() => create(commands, { disabled: true, deliverTo: "none" }));
    expect(done.result).toMatchObject({ trigger: { enabled: false } });
    expect(fake.writes()[0]!.body).toMatchObject({ enabled: false, delivery: { kind: "none" } });
  });

  it("create refuses a prompt without {{event}}", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => create(new CloudTriggersCommands(deps(fake)), { prompt: "Triage this" }));
    expect(outcome.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    expect(fake.requests).toHaveLength(0);
  });

  it("update --disable applies at once; a change that leaves it enabled is braked", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudTriggersCommands(deps(fake));
    const update = (input: { dailyCap?: string; enable?: boolean; disable?: boolean; execute?: boolean }) =>
      commands.update(
        "trg_1",
        undefined,
        undefined,
        input.dailyCap,
        undefined,
        undefined,
        undefined,
        undefined,
        input.enable,
        input.disable,
        "clinica",
        true,
        input.execute,
      );
    const plan = expectBrake(await capture(() => update({ dailyCap: "50" })), fake);
    expect(plan).toMatchObject({ trigger: "trg_1", changes: ["dailyCap"], dailyCap: 50, enabled: true });
    const off = await capture(() => update({ disable: true }));
    expect(off.result).toMatchObject({ trigger: { enabled: false } });
    const on = await capture(() => update({ enable: true }));
    expect(on.error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    const missing = await capture(() =>
      commands.update(
        "trg_x",
        "x {{event}}",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        "clinica",
        true,
        true,
      ),
    );
    expect(missing.error).toMatchObject({ code: "CLOUD_TRIGGER_NOT_FOUND" });
  });

  it("test is a read: it prints the prompt and starts no run", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => new CloudTriggersCommands(deps(fake)).test("trg_1", false));
    expect(outcome.lines.join("\n")).toContain("1 pending event(s)");
    expect(outcome.lines.join("\n")).toContain("<event>row 12 created</event>");
    expect(outcome.lines.join("\n")).toContain("No run was started");
    expectSchema(CloudTriggersCommands, "test", outcome.result);
  });

  it("list matches its schema", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => new CloudTriggersCommands(deps(fake)).list("clinica", true));
    expectSchema(CloudTriggersCommands, "list", outcome.result);
  });
});

describe("ravi cloud credits", () => {
  it("show prints the balance in BRL and matches its schema", async () => {
    const fake = createFakeProductConsole();
    const text = await capture(() => new CloudCreditsCommands(deps(fake)).show(false));
    expect(text.lines.join("\n")).toContain("R$ 120.50");
    const json = await capture(() => new CloudCreditsCommands(deps(fake)).show(true));
    expectSchema(CloudCreditsCommands, "show", json.result);
  });

  it("topup is braked; with --execute it prints the Pix link and the copy-paste code", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudCreditsCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.topup("R$ 100,00", true, false)), fake);
    expect(plan).toMatchObject({ amountBrl: 100, balanceBrl: 120.5, mode: "credits" });
    const done = await capture(() => commands.topup("100", false, true));
    const text = done.lines.join("\n");
    expect(text).toContain("Pay with Pix: https://pay.example.test/pix/abc");
    expect(text).toContain("Pix copy-paste code: 00020126580014br.gov.bcb.pix0136fake");
    expect(fake.writes()[0]!.body).toEqual({ amountBrl: 100 });
    expectSchema(CloudCreditsCommands, "topup", done.result);
  });

  it("topup refuses an amount outside R$ 20 - R$ 5000", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => new CloudCreditsCommands(deps(fake)).topup("10", true, true));
    expect(outcome.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("ravi cloud settings", () => {
  it("lowering the monthly cap applies at once", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() =>
      new CloudSettingsCommands(deps(fake)).set(undefined, "50", undefined, true, false),
    );
    expect(outcome.result).toMatchObject({ settings: { monthlyCapUsd: 50 } });
    expectSchema(CloudSettingsCommands, "set", outcome.result);
  });

  it("raising or removing the cap, raising the daily cap or switching the mode is braked", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudSettingsCommands(deps(fake));
    const raise = expectBrake(await capture(() => commands.set(undefined, "500", undefined, true, false)), fake);
    expect(raise).toMatchObject({ raisesSpending: ["monthlyCapUsd"] });
    const remove = expectBrake(await capture(() => commands.set(undefined, "none", undefined, true, false)), fake);
    expect(remove).toMatchObject({ raisesSpending: ["monthlyCapUsd"] });
    const daily = expectBrake(await capture(() => commands.set(undefined, undefined, "500", true, false)), fake);
    expect(daily).toMatchObject({ raisesSpending: ["dailyEventRunsCap"] });
    const mode = expectBrake(await capture(() => commands.set("credits", undefined, undefined, true, false)), fake);
    expect(mode).toMatchObject({ raisesSpending: ["billingMode"] });
    const done = await capture(() => commands.set("credits", undefined, undefined, true, true));
    expect(done.result).toMatchObject({ settings: { billingMode: "credits" } });
  });

  it("show matches its schema", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => new CloudSettingsCommands(deps(fake)).show(true));
    expectSchema(CloudSettingsCommands, "show", outcome.result);
  });
});

describe("ravi cloud catalog", () => {
  it("install is braked with the manifest in the plan; --execute installs by slug", async () => {
    const fake = createFakeProductConsole();
    const commands = new CloudCatalogCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.install("clinic-triage", "clinica", true, false)), fake);
    expect(plan).toMatchObject({ entry: { id: "cat_1", slug: "clinic-triage" }, project: "clinica" });
    const done = await capture(() => commands.install("clinic-triage", "clinica", false, true));
    expect(done.lines.join("\n")).toContain("awaiting_approval");
    expect(fake.writes().map((request) => request.path)).toEqual(["/catalog/cat_1/install"]);
  });

  it("packs install is braked and a missing entry is CLOUD_CATALOG_NOT_FOUND", async () => {
    const fake = createFakeProductConsole();
    expectBrake(
      await capture(() => new CloudCatalogPacksCommands(deps(fake)).install("clinic", "clinica", true, false)),
      fake,
    );
    const done = await capture(() =>
      new CloudCatalogPacksCommands(deps(fake)).install("clinic", "clinica", true, true),
    );
    expectSchema(CloudCatalogPacksCommands, "install", done.result);
    const missing = await capture(() => new CloudCatalogCommands(deps(fake)).install("nope", "clinica", true, true));
    expect(missing.error).toMatchObject({ code: "CLOUD_CATALOG_NOT_FOUND" });
  });

  it("list filters by sector and matches its schema", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() => new CloudCatalogCommands(deps(fake)).list("retail", true));
    expect(outcome.result).toMatchObject({ entries: [], packs: [] });
    expectSchema(CloudCatalogCommands, "list", outcome.result);
  });
});

describe("ravi cloud webhook", () => {
  it("set is CLI-only and braked; stdin is read only with --execute", async () => {
    const fake = createFakeProductConsole();
    let reads = 0;
    const commands = new CloudWebhookCommands(
      deps(fake, {
        readSecret: async () => {
          reads += 1;
          return "whsec_test_123\n";
        },
      }),
    );
    expect(getCliOnlyMetadata(CloudWebhookCommands).has("set")).toBe(true);
    expectBrake(await capture(() => commands.set(true, true, false)), fake);
    expect(reads).toBe(0);
    const done = await capture(() => commands.set(true, false, true));
    expect(reads).toBe(1);
    expect(fake.writes()[0]!.body).toEqual({ secret: "whsec_test_123" });
    expect(done.lines.join("\n")).not.toContain("whsec_test_123");
    const removed = await capture(() => commands.remove(true));
    expect(removed.result).toMatchObject({ webhook: { configured: false } });
  });
});

describe("ravi cloud agents approve|cap|memory-reset", () => {
  const agent = () =>
    fakeCloudAgent({
      status: "awaiting_approval",
      manifest: { hash: "h1", approved: false, approvedAt: null, value: { writes: "auto", secrets: ["CRM_TOKEN"] } },
      cap: { monthlyCapUsd: 20, monthSpentUsd: 3, pausedAt: null, pausedReason: null },
      memory: { scope: "agent", storeCount: 2 },
    });

  it("approve is braked with the manifest in the plan", async () => {
    const fake = createFakeProductConsole({ agents: [agent()] });
    const commands = new CloudAgentAdminCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.approve("triage", "clinica", true, false)), fake);
    expect(plan).toMatchObject({ manifestHash: "h1", alreadyApproved: false, manifest: { writes: "auto" } });
    const done = await capture(() => commands.approve("triage", "clinica", true, true));
    expect(done.result).toMatchObject({ agent: { status: "ready" } });
    expectSchema(CloudAgentAdminCommands, "approve", done.result);
  });

  it("cap: lowering applies at once, raising or removing is braked", async () => {
    const fake = createFakeProductConsole({ agents: [agent()] });
    const commands = new CloudAgentAdminCommands(deps(fake));
    const lower = await capture(() => commands.cap("triage", "10", "clinica", true, false));
    expect(lower.result).toMatchObject({ agent: { cap: { monthlyCapUsd: 10 } } });
    expectSchema(CloudAgentAdminCommands, "cap", lower.result);
    const fresh = createFakeProductConsole({ agents: [agent()] });
    const raise = expectBrake(
      await capture(() => new CloudAgentAdminCommands(deps(fresh)).cap("triage", "100", "clinica", true, false)),
      fresh,
    );
    expect(raise).toMatchObject({ monthlyCapUsd: { from: 20, to: 100 } });
    expectBrake(
      await capture(() => new CloudAgentAdminCommands(deps(fresh)).cap("triage", "none", "clinica", true, false)),
      fresh,
    );
  });

  it("memory-reset is braked and reports the stores it archived", async () => {
    const fake = createFakeProductConsole({ agents: [agent()] });
    const commands = new CloudAgentAdminCommands(deps(fake));
    const plan = expectBrake(await capture(() => commands.memoryReset("triage", "clinica", true, false)), fake);
    expect(plan).toMatchObject({ stores: 2 });
    const done = await capture(() => commands.memoryReset("triage", "clinica", true, true));
    expect(done.result).toEqual({ success: true, agentId: "ca_1", name: "triage", archivedStores: 2 });
    expectSchema(CloudAgentAdminCommands, "memoryReset", done.result);
  });

  it("an unknown agent is CLOUD_AGENT_NOT_FOUND", async () => {
    const fake = createFakeProductConsole({ agents: [agent()] });
    const outcome = await capture(() => new CloudAgentAdminCommands(deps(fake)).approve("nope", "clinica", true, true));
    expect(outcome.error).toMatchObject({ code: "CLOUD_AGENT_NOT_FOUND", exitCode: 1 });
  });
});

describe("ravi cloud worker", () => {
  it("enable is CLI-only and braked: the plan says bash runs here and nothing is written", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    const commands = new CloudWorkerCommands(deps(fake, { env }));
    expect(getCliOnlyMetadata(CloudWorkerCommands).has("enable")).toBe(true);
    const outcome = await capture(() => commands.enable(true, false));
    const plan = expectBrake(outcome, fake);
    expect(String(plan.effect)).toContain("bash commands");
    expect(readCloudWorkerState(env).enabled).toBe(false);
    const done = await capture(() => commands.enable(true, true));
    expect(done.result).toMatchObject({ enabled: true, changed: true });
    expect(readCloudWorkerState(env).enabled).toBe(true);
    expectSchema(CloudWorkerCommands, "enable", done.result);
    const disabled = await capture(() => commands.disable(true));
    expect(disabled.result).toMatchObject({ enabled: false, changed: true });
    expect(readCloudWorkerState(env).enabled).toBe(false);
  });

  it("enable refuses inside an agent's turn", async () => {
    const fake = createFakeProductConsole();
    const outcome = await capture(() =>
      new CloudWorkerCommands(deps(fake, { env: stateEnv(), inAgentRuntime: () => true })).enable(true, true),
    );
    expect(outcome.error).toMatchObject({ code: "CLOUD_AGENT_CANNOT_ENABLE_WORKER", exitCode: 3 });
  });

  it("key set stores the key 0600 and never sends it to the Console", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    const commands = new CloudWorkerKeyCommands(deps(fake, { env, readSecret: async () => "env-key-abc123\n" }));
    expect(getCliOnlyMetadata(CloudWorkerKeyCommands).has("set")).toBe(true);
    const done = await capture(() => commands.set("wrk_1", true, true));
    expect(done.result).toMatchObject({ workerId: "wrk_1", stored: true, replaced: false, runnerEnabled: false });
    expect(readCloudWorkerKey("wrk_1", env)).toBe("env-key-abc123");
    expect(statSync(join(getCloudWorkersDir(env), "keys", "wrk_1.key")).mode & 0o777).toBe(0o600);
    expect(fake.writes()).toHaveLength(0);
    expect(JSON.stringify(fake.requests)).not.toContain("env-key-abc123");
    expect(done.lines.join("\n")).not.toContain("env-key-abc123");
    expectSchema(CloudWorkerKeyCommands, "set", done.result);
  });

  it("key set refuses an unknown worker, no --stdin and an agent's turn", async () => {
    const fake = createFakeProductConsole();
    const env = stateEnv();
    const unknown = await capture(() =>
      new CloudWorkerKeyCommands(deps(fake, { env, readSecret: async () => "k" })).set("wrk_9", true, true),
    );
    expect(unknown.error).toMatchObject({ code: "CLOUD_WORKER_NOT_FOUND" });
    const noStdin = await capture(() => new CloudWorkerKeyCommands(deps(fake, { env })).set("wrk_1", false, true));
    expect(noStdin.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const agent = await capture(() =>
      new CloudWorkerKeyCommands(deps(fake, { env, inAgentRuntime: () => true })).set("wrk_1", true, true),
    );
    expect(agent.error).toMatchObject({ code: "CLOUD_AGENT_CANNOT_SET_SECRET", exitCode: 3 });
    expect(readCloudWorkerKey("wrk_1", env)).toBeNull();
  });

  it("list shows the Console status, the local key and the daemon's state", async () => {
    const fake = createFakeProductConsole({
      workers: [fakeCloudWorker(), fakeCloudWorker({ id: "wrk_2", agentId: "ca_2" })],
    });
    const env = stateEnv();
    writeCloudWorkerKey("wrk_1", "env-key-1", env);
    writeCloudWorkerKey("wrk_gone", "env-key-2", env);
    writeCloudWorkerRuntime(
      {
        updatedAt: new Date().toISOString(),
        workers: { wrk_1: { state: "backoff", error: "401 from provider", restartAt: "2026-10-23T10:00:30.000Z" } },
      },
      env,
    );
    const outcome = await capture(() => new CloudWorkerCommands(deps(fake, { env })).list(true));
    expect(outcome.result).toMatchObject({
      enabled: false,
      orphanKeys: ["wrk_gone"],
      workers: [
        { id: "wrk_1", localKey: true, local: { state: "backoff", error: "401 from provider" } },
        { id: "wrk_2", localKey: false, local: null },
      ],
    });
    expectSchema(CloudWorkerCommands, "list", outcome.result);
    const text = await capture(() => new CloudWorkerCommands(deps(fake, { env })).list(false));
    expect(text.lines.join("\n")).toContain("ravi cloud worker key set wrk_2 --stdin");
    expect(text.lines.join("\n")).not.toContain("env-key-1");
  });

  it("session maps a missing environment to a usage error and runs otherwise", async () => {
    const fake = createFakeProductConsole();
    expect(getCliOnlyMetadata(CloudWorkerCommands).has("session")).toBe(true);
    const missing = await capture(() =>
      new CloudWorkerCommands({
        ...deps(fake, { env: {} }),
        runSession: async () => {
          throw new WorkerSessionError("SESSION_ENV_MISSING", "set by the Console");
        },
      }).session(true),
    );
    expect(missing.error).toMatchObject({ code: "SESSION_ENV_MISSING", exitCode: 2 });
    const done = await capture(() =>
      new CloudWorkerCommands({
        ...deps(fake, { env: {} }),
        runSession: async () => ({ status: "terminated", turns: 2, eventsPosted: 9, outputsUploaded: 1 }),
      }).session(true),
    );
    expectSchema(CloudWorkerCommands, "session", done.result);
  });
});
