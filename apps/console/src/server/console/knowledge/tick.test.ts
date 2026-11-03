import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleKnowledgeTickHttp, type KnowledgeTickResult } from "./tick";

const ADMIN = "a".repeat(32);
const CRON = "c".repeat(32);

const RESULT: KnowledgeTickResult = {
  jobs: { claimed: 0, completed: 0, failed: 0, deadLettered: 0 },
  meetingRepairs: 0,
  vectorBackfill: 0,
  purged: { queryTexts: 0, runs: 0, meetingSources: 0, archivedDocuments: 0, proposalsExpired: 0, proposalBodies: 0, jobs: 0 },
  budgetExhausted: false,
};

let calls: Array<{ requestId: string; budgetMs: number }> = [];
let previousAdmin: string | undefined;
let ip = 0;

function request(method: "GET" | "POST", authorization?: string) {
  ip += 1;
  const headers: Record<string, string> = { "x-forwarded-for": `10.0.0.${ip}` };
  if (authorization) headers.authorization = authorization;
  return new Request("https://console.ravi.bot/api/internal/admin/knowledge/tick", { method, headers });
}

function deps(cronSecret: string | undefined) {
  return {
    cronSecret: () => cronSecret,
    runTick: async (input: { requestId: string; budgetMs: number }) => {
      calls.push(input);
      return RESULT;
    },
  };
}

beforeEach(() => {
  calls = [];
  previousAdmin = process.env.RAVI_ADMIN_TOKEN;
  process.env.RAVI_ADMIN_TOKEN = ADMIN;
});

afterEach(() => {
  if (previousAdmin === undefined) delete process.env.RAVI_ADMIN_TOKEN;
  else process.env.RAVI_ADMIN_TOKEN = previousAdmin;
});

describe("knowledge tick route", () => {
  test("GET with CRON_SECRET unset or empty answers 503, even with the admin token set and sent", async () => {
    for (const secret of [undefined, "", "   "]) {
      const response = await handleKnowledgeTickHttp(request("GET", `Bearer ${ADMIN}`), deps(secret));
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("cron_secret_not_configured");
    }
    expect(calls).toHaveLength(0);
  });

  test("GET without a bearer, with a wrong one, or with the admin token answers 401", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${CRON}x`, `Bearer ${ADMIN}`, CRON]) {
      const response = await handleKnowledgeTickHttp(request("GET", authorization), deps(CRON));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(calls).toHaveLength(0);
  });

  test("GET with the cron secret runs the tick with a 240 s budget", async () => {
    const response = await handleKnowledgeTickHttp(request("GET", `Bearer ${CRON}`), deps(CRON));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", result: RESULT });
    expect(calls).toEqual([{ requestId: body.requestId, budgetMs: 240_000 }]);
  });

  test("POST takes the admin token and never the cron secret", async () => {
    expect((await handleKnowledgeTickHttp(request("POST", `Bearer ${CRON}`), deps(CRON))).status).toBe(401);
    expect((await handleKnowledgeTickHttp(request("POST"), deps(CRON))).status).toBe(401);
    const ok = await handleKnowledgeTickHttp(request("POST", `Bearer ${ADMIN}`), deps(undefined));
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("unauthorized GETs from one client are rate limited after 10 a minute", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const fixed = new Request("https://console.ravi.bot/api/internal/admin/knowledge/tick", {
        headers: { "x-forwarded-for": "10.9.9.9", "user-agent": "tick-test" },
      });
      statuses.push((await handleKnowledgeTickHttp(fixed, deps(CRON))).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("a failing tick answers 500 without the error text", async () => {
    const response = await handleKnowledgeTickHttp(request("GET", `Bearer ${CRON}`), {
      cronSecret: () => CRON,
      runTick: async () => {
        throw new Error("secret detail");
      },
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
});
