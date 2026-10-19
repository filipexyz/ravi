import { describe, expect, it } from "bun:test";

import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { fakeCredentials } from "../library/test-fixtures.js";
import { CloudAgentsClient } from "./client.js";
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
          origin: { kind: "task", installationId: "inst-1", sessionName: "dev", taskId: "task-1", deliveredAt: null },
        }),
      ],
    });
    const client = fakeCloudClient(fake);
    const page = await client.listRuns({
      project: "clinica",
      agent: "triage",
      status: "running",
      origin: "installation",
    });
    const query = fake.requests[0]!.query;
    expect(query.get("project")).toBe("clinica");
    expect(query.get("agent")).toBe("triage");
    expect(query.get("status")).toBe("running");
    expect(query.get("origin")).toBe("installation");
    expect(query.has("cursor")).toBe(false);
    const run = page.runs[0]!;
    expect(run).not.toHaveProperty("extra");
    expect(run.approvals).toHaveLength(1);
    expect(run.outputs[0]).toEqual({ id: "out_1", name: "report.md", size: 12 });
    expect(run.origin).toMatchObject({ kind: "task", taskId: "task-1", sessionName: "dev" });
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
    expect(decided.approval?.status).toBe("denied");
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
});
