import { describe, expect, it } from "bun:test";

import {
  approveCloudAgent,
  createCloudTrigger,
  getCloudCredits,
  getCloudProductAgentDetail,
  getCloudSettings,
  getCloudWebhook,
  heartbeatCloudWorker,
  installCloudCatalogEntry,
  installCloudCatalogPack,
  listCloudCatalog,
  listCloudSecrets,
  listCloudTriggers,
  listCloudWorkers,
  removeCloudSecret,
  requireProductAgent,
  resetCloudAgentMemory,
  setCloudAgentCap,
  setCloudSecret,
  setCloudWebhook,
  testCloudTrigger,
  topupCloudCredits,
  updateCloudSettings,
} from "./client-product.js";
import { createFakeProductConsole, fakeCloudWorker } from "./test-fixtures-product.js";
import { fakeCloudAgent, fakeCloudClient } from "./test-fixtures.js";

describe("cloud agents product client", () => {
  it("secrets: lists names and hints, sends the value once, removes by id", async () => {
    const fake = createFakeProductConsole();
    const client = fakeCloudClient(fake);
    const secrets = await listCloudSecrets(client, "clinica");
    expect(secrets[0]).toEqual({
      id: "sec_1",
      projectId: null,
      name: "STRIPE_API_KEY",
      valueHint: "9z9z",
      allowedHosts: ["api.stripe.com"],
      updatedAt: "2026-10-18T10:00:00.000Z",
      updatedBy: { id: "user-1", name: "Op" },
      lastUsedAt: null,
    });
    expect(fake.requests[0]!.query.get("project")).toBe("clinica");
    const set = await setCloudSecret(client, {
      name: "CRM_TOKEN",
      value: "value-abcd",
      allowedHosts: ["api.crm.test"],
    });
    expect(set).toMatchObject({ name: "CRM_TOKEN", valueHint: "abcd", allowedHosts: ["api.crm.test"] });
    expect(JSON.stringify(set)).not.toContain("value-abcd");
    await removeCloudSecret(client, set.id);
    expect(fake.writes().map((request) => request.path)).toEqual(["/secrets", `/secrets/${set.id}/remove`]);
  });

  it("triggers: normalizes the list, creates, and reads the dry run", async () => {
    const fake = createFakeProductConsole();
    const client = fakeCloudClient(fake);
    const [trigger] = await listCloudTriggers(client, "clinica");
    expect(trigger).toMatchObject({
      id: "trg_1",
      source: "bases",
      filter: { baseId: "base_1", events: ["row.created"] },
    });
    expect(trigger!.pendingEvents).toBe(1);
    const created = await createCloudTrigger(client, {
      project: "clinica",
      agent: "triage",
      source: "mail",
      prompt: "Answer: {{event}}",
      delivery: { kind: "session", sessionName: "main" },
    });
    expect(created).toMatchObject({ source: "mail", delivery: { kind: "session", sessionName: "main" } });
    expect(await testCloudTrigger(client, "trg_1")).toEqual({
      prompt: "Triage this request: <event>row 12 created</event>",
      eventCount: 1,
      sample: false,
      blockedBy: null,
    });
  });

  it("credits: BRL balance, Pix top-up with link and code", async () => {
    const fake = createFakeProductConsole();
    const client = fakeCloudClient(fake);
    const credits = await getCloudCredits(client);
    expect(credits).toMatchObject({ mode: "credits", balanceBrl: 120.5, fxRate: "5.40", monthSpentBrl: 30.25 });
    expect(credits.entries[0]).toMatchObject({ kind: "run", amountBrl: -2.27, usd: 0.42, status: "posted" });
    const topup = await topupCloudCredits(client, 50);
    expect(topup.entry).toMatchObject({
      kind: "topup",
      amountBrl: 50,
      status: "pending",
      paymentUrl: "https://pay.example.test/pix/abc",
    });
    expect(topup.entry.pixCopyPaste).toContain("br.gov.bcb.pix");
    expect(topup.credits?.balanceBrl).toBe(120.5);
  });

  it("credits: a payment link that is not https is dropped", async () => {
    const fake = createFakeProductConsole();
    (fake.credits.entries as Array<Record<string, unknown>>)[0]!.paymentUrl = "javascript:alert(1)";
    const credits = await getCloudCredits(fakeCloudClient(fake));
    expect(credits.entries[0]!.paymentUrl).toBeNull();
  });

  it("settings: reads and updates", async () => {
    const fake = createFakeProductConsole();
    const client = fakeCloudClient(fake);
    expect(await getCloudSettings(client)).toMatchObject({
      billingMode: "byok",
      monthlyCapUsd: 100,
      dailyEventRunsCap: 200,
    });
    const updated = await updateCloudSettings(client, { monthlyCapUsd: null });
    expect(updated.monthlyCapUsd).toBeNull();
    expect(fake.writes()[0]!.body).toEqual({ monthlyCapUsd: null });
  });

  it("catalog: entries and packs; installs return the created agents", async () => {
    const fake = createFakeProductConsole();
    const client = fakeCloudClient(fake);
    const catalog = await listCloudCatalog(client);
    expect(catalog.entries[0]).toMatchObject({
      id: "cat_1",
      slug: "clinic-triage",
      manifestHash: "h1",
      installed: false,
    });
    expect(catalog.packs[0]).toMatchObject({
      slug: "clinic",
      revenueShareBps: 1500,
      entries: [{ slug: "clinic-triage" }],
    });
    const entry = await installCloudCatalogEntry(client, "cat_1", "clinica");
    expect(entry.agents[0]).toMatchObject({ status: "awaiting_approval", catalogEntryId: "cat_1" });
    expect(entry.agents[0]!.manifest).toMatchObject({ hash: "h1", approved: false });
    const pack = await installCloudCatalogPack(client, "pack_1", "clinica");
    expect(pack.agents).toHaveLength(1);
    expect(fake.writes().map((request) => request.body)).toEqual([{ project: "clinica" }, { project: "clinica" }]);
  });

  it("workers: lists assignments and heartbeats", async () => {
    const fake = createFakeProductConsole({
      workers: [fakeCloudWorker(), fakeCloudWorker({ id: "wrk_2", status: "bogus" })],
    });
    const client = fakeCloudClient(fake);
    const workers = await listCloudWorkers(client);
    expect(workers.map((worker) => worker.status)).toEqual(["waiting_key", "offline"]);
    const worker = await heartbeatCloudWorker(client, "wrk_1", { status: "online" });
    expect(worker?.status).toBe("online");
    expect(fake.heartbeats).toEqual([{ id: "wrk_1", body: { status: "online" } }]);
  });

  it("webhook: URL and state only; the secret goes up and never comes back", async () => {
    const fake = createFakeProductConsole();
    const client = fakeCloudClient(fake);
    expect(await getCloudWebhook(client)).toMatchObject({ configured: false });
    const set = await setCloudWebhook(client, "whsec_test_1");
    expect(set.configured).toBe(true);
    expect(JSON.stringify(set)).not.toContain("whsec_test_1");
  });

  it("webhook: a URL that is not https is dropped", async () => {
    const fake = createFakeProductConsole();
    fake.webhook = { url: "http://evil.test/hook", configured: true, lastEventAt: null };
    expect((await getCloudWebhook(fakeCloudClient(fake))).url).toBeNull();
  });

  it("agents: product fields, approval, cap and memory reset", async () => {
    const agent = fakeCloudAgent({
      status: "awaiting_approval",
      config: { ...(fakeCloudAgent().config as Record<string, unknown>), memory: "person", secrets: ["CRM_TOKEN"] },
      manifest: { hash: "h1", approved: false, approvedAt: null, value: { writes: "auto" } },
      cap: { monthlyCapUsd: 20, monthSpentUsd: 3, pausedAt: null, pausedReason: null },
      memory: { scope: "person", storeCount: 4 },
    });
    const fake = createFakeProductConsole({ agents: [agent] });
    const client = fakeCloudClient(fake);
    const detail = await getCloudProductAgentDetail(client, "ca_1");
    expect(detail.memory).toEqual({ scope: "person", storeCount: 4 });
    expect(detail.agent.config).toMatchObject({ memory: "person", secrets: ["CRM_TOKEN"], placement: "cloud" });
    expect(detail.agent.manifest).toMatchObject({ hash: "h1", approved: false, approvedAt: null });
    // A partial manifest takes the safe defaults for what it leaves out.
    expect(detail.agent.manifest?.value).toMatchObject({
      writes: "auto",
      networking: "limited",
      provider: "anthropic",
      secrets: [],
      web: { search: false, fetch: false, allowedDomains: [], blockedDomains: [] },
      askHuman: true,
    });
    expect((await approveCloudAgent(client, "ca_1")).status).toBe("ready");
    expect((await setCloudAgentCap(client, "ca_1", null)).cap?.monthlyCapUsd).toBeNull();
    expect(await resetCloudAgentMemory(client, "ca_1")).toEqual({
      agentId: "ca_1",
      archivedStores: null,
      memory: { scope: "agent", storeCount: 0 },
    });
  });

  it("requireProductAgent defaults the product fields of an older Console", () => {
    const agent = requireProductAgent(fakeCloudAgent());
    expect(agent.config).toMatchObject({ askHuman: true, workflows: false, placement: "cloud", provider: "anthropic" });
    expect(agent.manifest).toBeNull();
    expect(agent.cap).toBeNull();
  });
});
