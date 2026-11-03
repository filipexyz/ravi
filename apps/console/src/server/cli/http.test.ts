import { describe, expect, test } from "bun:test";

import { CliApiError } from "./errors";
import { readJsonBody } from "./http";

describe("CLI HTTP helpers", () => {
  test("reads bounded JSON bodies", async () => {
    const body = await readJsonBody(
      new Request("https://console.ravi.bot/api/cli/test", {
        body: JSON.stringify({ ok: true }),
        method: "POST",
      }),
      "req_body",
      { maxBytes: 1024 },
    );

    expect(body).toEqual({ ok: true });
  });

  test("rejects bodies larger than the explicit byte limit", async () => {
    await expect(
      readJsonBody(
        new Request("https://console.ravi.bot/api/cli/test", {
          body: JSON.stringify({ value: "x".repeat(32) }),
          method: "POST",
        }),
        "req_too_large",
        { maxBytes: 16 },
      ),
    ).rejects.toThrow(CliApiError);
  });
});
