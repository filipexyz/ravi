import { describe, expect, test } from "bun:test";

import { NextRequest } from "next/server";

import { POST } from "./route";

// The Console cloud agents envelope signs in with the session cookie, so every
// POST (key, deploy, run, approve, stop) must prove it came from the Console
// itself before anything else runs.
const context = { params: Promise.resolve({ segments: ["runs", "r1", "stop"] }) };

function post(headers: Record<string, string>) {
  return new NextRequest("https://console.ravi.bot/api/console/cloud-agents/runs/r1/stop", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

describe("console cloud agents route", () => {
  test("a cross-site POST is 403 before auth", async () => {
    const response = await POST(post({ "sec-fetch-site": "cross-site" }), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a POST with no Sec-Fetch-Site and a foreign or missing Origin is 403", async () => {
    expect((await POST(post({ origin: "https://evil.example" }), context)).status).toBe(403);
    expect((await POST(post({}), context)).status).toBe(403);
  });
});
