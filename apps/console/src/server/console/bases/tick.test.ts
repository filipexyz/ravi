import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";

import { decodeActivityCursor } from "./activity";
import { handleBasesTickHttp } from "./tick";

const ADMIN = "a".repeat(32);
const CRON = "c".repeat(32);

let runs = 0;
let previousAdmin: string | undefined;
let ip = 0;

function request(method: "GET" | "POST", authorization?: string) {
  ip += 1;
  const headers: Record<string, string> = { "x-forwarded-for": `10.1.0.${ip}` };
  if (authorization) headers.authorization = authorization;
  return new Request("https://console.ravi.bot/api/internal/admin/bases/tick", { method, headers });
}

function deps(cronSecret: string | undefined) {
  return {
    cronSecret: () => cronSecret,
    runTick: async () => {
      runs += 1;
      return { expiredOperations: 3 };
    },
  };
}

beforeEach(() => {
  runs = 0;
  previousAdmin = process.env.RAVI_ADMIN_TOKEN;
  process.env.RAVI_ADMIN_TOKEN = ADMIN;
});

afterEach(() => {
  if (previousAdmin === undefined) delete process.env.RAVI_ADMIN_TOKEN;
  else process.env.RAVI_ADMIN_TOKEN = previousAdmin;
});

describe("bases tick route", () => {
  test("GET needs CRON_SECRET: 503 when unset, 401 for any other bearer", async () => {
    expect((await handleBasesTickHttp(request("GET", `Bearer ${CRON}`), deps(undefined))).status).toBe(503);
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${ADMIN}`]) {
      expect((await handleBasesTickHttp(request("GET", authorization), deps(CRON))).status).toBe(401);
    }
    expect(runs).toBe(0);
  });

  test("GET with the cron secret and POST with the admin token run the cleanup", async () => {
    const cron = await handleBasesTickHttp(request("GET", `Bearer ${CRON}`), deps(CRON));
    expect(cron.status).toBe(200);
    expect((await cron.json()).result).toEqual({ expiredOperations: 3 });
    expect((await handleBasesTickHttp(request("POST", `Bearer ${ADMIN}`), deps(CRON))).status).toBe(200);
    expect((await handleBasesTickHttp(request("POST", `Bearer ${CRON}`), deps(CRON))).status).toBe(401);
    expect(runs).toBe(2);
  });
});

describe("activity cursor", () => {
  test("round-trips exact timestamps and refuses anything else", () => {
    const cursor = { t: "2026-10-06T12:00:00.123456Z", id: "0e0e0e0e-0000-4000-8000-000000000001" };
    expect(decodeActivityCursor(Buffer.from(JSON.stringify(cursor)).toString("base64url"))).toEqual(cursor);
    expect(decodeActivityCursor(null)).toBeNull();
    expect(decodeActivityCursor("")).toBeNull();
    for (const bad of ["nope", Buffer.from(JSON.stringify({ ...cursor, t: "2026-10-06" })).toString("base64url"), Buffer.from(JSON.stringify({ ...cursor, id: "x" })).toString("base64url")]) {
      let error: unknown = null;
      try {
        decodeActivityCursor(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).payload.error).toBe("validation_failed");
    }
  });
});
