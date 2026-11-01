import { describe, expect, it } from "bun:test";

import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { fakeCredentials } from "../library/test-fixtures.js";
import { CloudAgentsClient, normalizeDelivery, normalizeQuestion } from "./client.js";
import {
  createFakeCloudConsole,
  FAKE_CONSOLE_URL,
  fakeCloudApproval,
  fakeCloudClient,
  fakeCloudRun,
} from "./test-fixtures.js";

describe("cloud agents client", () => {
  it("reads the credential hint and sends a new key in the body only", async () => {
    const fake = createFakeCloudConsole();
    const client = fakeCloudClient(fake);
    expect((await client.getCredential()).keyHint).toBe("a1b2");
    const credential = await client.setCredential({
      provider: "anthropic",
      apiKey: "test-key-zz99",
      monthlyAlertUsd: 50,
    });
    expect(credential).toMatchObject({ configured: true, keyHint: "zz99", monthlyAlertUsd: 50 });
    const post = fake.writes()[0]!;
    expect(post.path).toBe("/credential");
    expect(post.body).toEqual({ provider: "anthropic", apiKey: "test-key-zz99", monthlyAlertUsd: 50 });
    expect(post.authorization).toBe("Bearer access-1");
    expect((await client.removeCredential()).configured).toBe(false);
  });

  it("builds list queries and normalizes runs to the contract's fields", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({
          extra: "dropped",
          approvals: [fakeCloudApproval(), { nope: true }],
          outputs: [{ id: "out_1", name: "report.md", size: 12 }],
          origin: {
            kind: "task",
            installationId: "inst-1",
            sessionName: "dev",
            taskId: "task-1",
            delivery: "pending",
          },
        }),
      ],
    });
    const client = fakeCloudClient(fake);
    const page = await client.listRuns({
      project: "clinica",
      agent: "ca_1",
      status: "running",
      limit: 10,
      origin: "installation",
    });
    const query = fake.requests[0]!.query;
    expect(query.get("project")).toBe("clinica");
    expect(query.get("agent")).toBe("ca_1");
    expect(query.get("limit")).toBe("10");
    expect(query.get("status")).toBe("running");
    expect(query.get("origin")).toBe("installation");
    expect(query.has("cursor")).toBe(false);
    const run = page.runs[0]!;
    expect(run).not.toHaveProperty("extra");
    expect(run.approvals).toHaveLength(1);
    expect(run.outputs[0]).toEqual({ id: "out_1", name: "report.md", size: 12 });
    expect(run.origin).toMatchObject({ kind: "task", taskId: "task-1", sessionName: "dev", delivery: "pending" });
    expect(run.url).toBe(`${FAKE_CONSOLE_URL}/acme/p/p-clinica/cloud/runs/run_1`);
    expect(page.cursor).toBeNull();
  });

  it("keeps run links on the Console's origin only", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({ id: "run_a", url: "https://evil.example/x" }),
        fakeCloudRun({ id: "run_b", url: "//evil.example/x" }),
      ],
    });
    const client = fakeCloudClient(fake);
    expect((await client.getRun("run_a")).url).toBeNull();
    expect((await client.getRun("run_b")).url).toBeNull();
  });

  it("encodes path segments and posts approval decisions", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ approvals: [fakeCloudApproval()] })] });
    const client = fakeCloudClient(fake);
    const decided = await client.decideApproval("run_1", "ap_1", { decision: "deny", reason: "not now" });
    // The Console answers with the run only; the decided approval is in it.
    expect(decided.approval).toBeNull();
    expect(decided.run?.approvals[0]?.status).toBe("denied");
    expect(fake.writes()[0]).toMatchObject({
      path: "/runs/run_1/approvals/ap_1",
      body: { decision: "deny", reason: "not now" },
    });
    await expect(client.getRun("../credential")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.requests.at(-1)!.path).toBe("/runs/..%2Fcredential");
  });

  it("maps the Console's lowercase error codes and keeps the original", async () => {
    const fake = createFakeCloudConsole();
    fake.failures.push({
      path: "/runs",
      method: "POST",
      status: 409,
      body: { error: { code: "cloud_credential_missing", message: "No key" } },
    });
    const client = fakeCloudClient(fake);
    const error = await client
      .startRun({ project: "clinica", agent: "triage", prompt: "x" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as CloudAuthError).consoleCode).toBe("CLOUD_CREDENTIAL_MISSING");
    expect((error as CloudAuthError).status).toBe(409);
  });

  it("refreshes an expired login once and retries", async () => {
    const fake = createFakeCloudConsole();
    fake.validToken = "access-2";
    const stored: { current: CloudCredentials | null } = { current: fakeCredentials() };
    const baseFetch = fake.fetch;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/cli/auth/refresh")) {
        return new Response(JSON.stringify({ accessToken: "access-2", refreshToken: "refresh-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return baseFetch(url, init);
    }) as typeof globalThis.fetch;
    const client = new CloudAgentsClient({
      client: new ConsoleApiClient({ consoleUrl: FAKE_CONSOLE_URL, fetch, actorContact: () => null }),
      credentials: stored.current!,
      write: (credentials) => {
        stored.current = credentials;
      },
      delete: () => {
        stored.current = null;
      },
      read: () => stored.current,
    });
    expect(await client.listAgents("clinica")).toHaveLength(1);
    expect(stored.current?.accessToken).toBe("access-2");
    expect(fake.requests.map((request) => request.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("downloads output bytes through the Console", async () => {
    const fake = createFakeCloudConsole({
      runs: [fakeCloudRun({ outputs: [{ id: "out_1", name: "a.txt", size: 2 }] })],
    });
    fake.outputs.set("run_1/out_1", new TextEncoder().encode("hi"));
    const client = fakeCloudClient(fake);
    const file = await client.downloadOutput("run_1", "out_1");
    expect(new TextDecoder().decode(file.bytes)).toBe("hi");
    expect(file.contentType).toBe("application/octet-stream");
    await expect(client.downloadOutput("run_1", "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a payload without the contract's wrapper", async () => {
    const fake = createFakeCloudConsole();
    const fetch = (async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const client = new CloudAgentsClient({
      client: new ConsoleApiClient({ consoleUrl: FAKE_CONSOLE_URL, fetch, actorContact: () => null }),
      credentials: fakeCredentials(),
      write: () => {},
      delete: () => {},
    });
    await expect(client.listAgents("clinica")).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(fake.requests).toHaveLength(0);
  });

  it("normalizes events and schedule calls", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun()] });
    fake.events.set("run_1", [
      { seq: 1, at: "2026-10-18T10:00:01.000Z", type: "message", role: "agent", text: "hello" },
      { seq: 2, type: "status", status: "completed" },
      { nope: true },
    ]);
    const client = fakeCloudClient(fake);
    const page = await client.listEvents("run_1", "1");
    expect(page.events.map((event) => event.seq)).toEqual([2]);
    expect(page.cursor).toBe("2");
    const schedule = await client.createSchedule({
      project: "clinica",
      agent: "triage",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      enabled: false,
    });
    expect(schedule.enabled).toBe(false);
    const updated = await client.updateSchedule(schedule.id, { enabled: true });
    expect(updated.enabled).toBe(true);
    await client.deleteSchedule(schedule.id);
    expect(await client.listSchedules("clinica")).toHaveLength(0);
  });

  it("reads 201 answers and the deploy result as the Console sends them", async () => {
    const fake = createFakeCloudConsole();
    const client = fakeCloudClient(fake);
    const deployed = await client.deployAgent({ project: "clinica", agent: "reviewer" });
    expect(deployed).toMatchObject({ changed: true, warnings: [] });
    const again = await client.deployAgent({ project: "clinica", agent: "reviewer" });
    expect(again.changed).toBe(false);
    const run = await client.startRun({ project: "clinica", agent: "triage", prompt: "x" });
    expect(run.status).toBe("starting");
    const schedule = await client.createSchedule({
      project: "clinica",
      agent: "triage",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    expect(schedule.id).toBe("sch_1");
    await client.deleteSchedule(schedule.id);
  });

  it("keeps the Console's access and role codes", async () => {
    const fake = createFakeCloudConsole();
    fake.failures.push({
      path: "/agents",
      status: 403,
      body: {
        error: { code: "PROJECT_ACCESS_DENIED", message: "This CLI session lacks the console.projects.read scope." },
      },
      times: 1,
    });
    fake.failures.push({
      path: "/agents",
      status: 403,
      body: { error: { code: "forbidden", message: "Admins only." } },
    });
    const client = fakeCloudClient(fake);
    await expect(client.listAgents("clinica")).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    const forbidden = (await client.listAgents("clinica").catch((caught: unknown) => caught)) as CloudAuthError;
    expect(forbidden.consoleCode ?? forbidden.code).toBe("FORBIDDEN");
  });
});

describe("cloud agents client: chat delivery and thread = run", () => {
  it("normalizes delivery, questions, files, outcome and BRL cost", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({
          delivery: {
            kind: "session",
            installationId: "inst-1",
            sessionName: "dev",
            chat: { channel: "slack", chatId: "C1" },
          },
          deliveredAt: "2026-10-18T10:09:00.000Z",
          questions: [
            { id: "q_1", question: "Qual fila?", options: ["a", "b", 3], status: "pending" },
            { question: "no id" },
          ],
          files: [{ fileId: "f_1", name: "data.csv", size: 3 }, { name: "no id" }],
          outcome: { rubric: "Tem 3 itens", maxIterations: 3, iterations: 1, lastResult: "needs_revision" },
          threadKey: "slack:slack-main:C1:1712345678.1",
          billingMode: "credits",
          chargedBrl: 1.5,
          costBrl: 0.42,
        }),
      ],
    });
    const run = await fakeCloudClient(fake).getRun("run_1");
    expect(run.delivery).toEqual({
      kind: "session",
      installationId: "inst-1",
      sessionName: "dev",
      chat: { channel: "slack", chatId: "C1", threadId: null, instanceId: null },
    });
    expect(run.deliveredAt).toBe("2026-10-18T10:09:00.000Z");
    expect(run.questions).toEqual([
      {
        id: "q_1",
        question: "Qual fila?",
        options: ["a", "b"],
        status: "pending",
        answer: null,
        askedAt: null,
        answeredAt: null,
        answeredBy: null,
      },
    ]);
    expect(run.files).toEqual([{ fileId: "f_1", name: "data.csv", size: 3 }]);
    expect(run.outcome).toEqual({
      rubric: "Tem 3 itens",
      maxIterations: 3,
      iterations: 1,
      lastResult: "needs_revision",
      feedback: null,
    });
    expect(run).toMatchObject({ threadKey: "slack:slack-main:C1:1712345678.1", billingMode: "credits", costBrl: 0.42 });

    const bare = await fakeCloudClient(createFakeCloudConsole({ runs: [fakeCloudRun()] })).getRun("run_1");
    expect(bare).toMatchObject({
      questions: [],
      delivery: null,
      files: [],
      outcome: null,
      threadKey: null,
      costBrl: null,
    });
    expect(bare.billingMode).toBe("byok");
  });

  it("drops delivery kinds and question states the contract does not name", () => {
    expect(normalizeDelivery({ kind: "email", sessionName: "x" })).toBeNull();
    expect(normalizeDelivery({ kind: "none", extra: 1 })).toEqual({ kind: "none" });
    expect(normalizeDelivery({ kind: "page_room", roomId: "r_1", siteId: "" })).toEqual({
      kind: "page_room",
      roomId: "r_1",
    });
    expect(normalizeQuestion({ id: "q", status: "weird" })?.status).toBe("pending");
    expect(normalizeQuestion({ id: "q", options: Array.from({ length: 9 }, (_, i) => `o${i}`) })?.options).toHaveLength(
      6,
    );
    expect(normalizeQuestion(null)).toBeNull();
  });

  it("acks a session delivery with kind result and a task run with an empty body", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun()] });
    const client = fakeCloudClient(fake);
    await client.markDelivered("run_1", "result");
    await client.markDelivered("run_1");
    expect(fake.writes().map((write) => [write.path, write.body])).toEqual([
      ["/runs/run_1/delivered", { kind: "result" }],
      ["/runs/run_1/delivered", {}],
    ]);
  });

  it("answers a question, and a question no longer pending is a conflict", async () => {
    const fake = createFakeCloudConsole({
      runs: [
        fakeCloudRun({ status: "waiting_input", questions: [{ id: "q_1", question: "Qual?", status: "pending" }] }),
      ],
    });
    const client = fakeCloudClient(fake);
    const run = await client.answerQuestion("run_1", "q_1", "Suporte");
    expect(run?.questions?.[0]).toMatchObject({ status: "answered", answer: "Suporte" });
    expect(fake.writes()[0]).toMatchObject({ path: "/runs/run_1/questions/q_1", body: { answer: "Suporte" } });
    await expect(client.answerQuestion("run_1", "q_1", "de novo")).rejects.toMatchObject({ status: 409 });
  });

  it("finds a run by its conversation key, null when none is bound, and posts thread messages", async () => {
    const key = "whatsapp:inst-wa:120363012345678901@g.us";
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ threadKey: key })] });
    const client = fakeCloudClient(fake);
    expect((await client.getRunByThread(key))?.id).toBe("run_1");
    expect(fake.requests[0]!.query.get("key")).toBe(key);
    expect(await client.getRunByThread("whatsapp:inst-wa:other@g.us")).toBeNull();
    expect((await client.sendThreadMessage(key, "olha isso"))?.id).toBe("run_1");
    expect(fake.writes().at(-1)).toMatchObject({ path: "/runs/by-thread/messages", body: { key, text: "olha isso" } });
    await expect(client.sendThreadMessage("whatsapp:inst-wa:other@g.us", "x")).rejects.toMatchObject({ status: 404 });
  });

  it("acts for a chat contact through the actor header", async () => {
    const fake = createFakeCloudConsole({ runs: [fakeCloudRun({ approvals: [fakeCloudApproval()] })] });
    await fakeCloudClient(fake, undefined, "contact-ana").decideApproval("run_1", "ap_1", { decision: "approve" });
    await fakeCloudClient(fake).getRun("run_1");
    expect(fake.requests.map((request) => request.actorContact)).toEqual(["contact-ana", null]);
  });
});
