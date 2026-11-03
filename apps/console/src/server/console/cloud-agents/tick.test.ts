import { describe, expect, test } from "bun:test";

import { handleCloudAgentsTickHttp, runCloudAgentsTick } from "./tick";

const okTick = async () => ({ skipped: "unconfigured" as const });

function get(authorization?: string) {
  return new Request("https://console.ravi.bot/api/internal/cloud-agents/tick", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  });
}

describe("cloud agents tick", () => {
  test("does nothing without the encryption key", async () => {
    expect(await runCloudAgentsTick({ env: {} as unknown as NodeJS.ProcessEnv })).toEqual({ skipped: "unconfigured" });
  });

  test("Vercel Cron needs CRON_SECRET as a bearer token", async () => {
    const deps = { cronSecret: () => "cron-test-secret", runTick: okTick };
    expect((await handleCloudAgentsTickHttp(get(), deps)).status).toBe(401);
    expect((await handleCloudAgentsTickHttp(get("Bearer wrong-secret-value"), deps)).status).toBe(401);
    const ok = await handleCloudAgentsTickHttp(get("Bearer cron-test-secret"), deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", result: { skipped: "unconfigured" } });
    const unset = await handleCloudAgentsTickHttp(get("Bearer cron-test-secret"), { cronSecret: () => undefined, runTick: okTick });
    expect(unset.status).toBe(503);
  });

  test("a failing tick answers 500 without details", async () => {
    const response = await handleCloudAgentsTickHttp(get("Bearer cron-test-secret"), {
      cronSecret: () => "cron-test-secret",
      runTick: async () => {
        throw new Error("database exploded with secrets");
      },
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secrets");
  });
});
