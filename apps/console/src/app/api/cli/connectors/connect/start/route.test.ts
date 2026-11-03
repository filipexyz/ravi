import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

describe("POST /api/cli/connectors/connect/start", () => {
  test("requires the CLI bearer", async () => {
    const response = await POST(
      new NextRequest("https://console.example.test/api/cli/connectors/connect/start", {
        body: JSON.stringify({ provider: "google" }),
        headers: { "content-type": "application/json", "x-request-id": "req-cli" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "CLI authentication is required.", requestId: "req-cli" },
    });
  });
});
