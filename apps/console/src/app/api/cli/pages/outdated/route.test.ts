import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET } from "./route";

describe("GET /api/cli/pages/outdated", () => {
  test("returns a coded AUTH_REQUIRED without CLI auth", async () => {
    const response = await GET(new NextRequest("https://example.test/api/cli/pages/outdated?project=demo"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });
});
