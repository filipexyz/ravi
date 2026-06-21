import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { FeedbackCommands } from "./feedback.js";

describe("feedback CLI commands", () => {
  it("submits structured feedback through the Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        id: "fb_1",
        kind: "bug",
        severity: "high",
        message: "Pages links are hard to find",
      };
    });
    const command = new FeedbackCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.send(
        ["Pages", "links", "are", "hard", "to", "find"],
        "bug",
        "high",
        "Pages nav",
        "console/pages",
        "rbbt",
        "https://console.example/p/rbbt/pages",
        "pages,ux",
        '{"route":"/p/rbbt/pages"}',
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/feedback",
        accessToken: "access-secret",
        body: {
          kind: "bug",
          severity: "high",
          title: "Pages nav",
          message: "Pages links are hard to find",
          surface: "console/pages",
          projectRef: "rbbt",
          url: "https://console.example/p/rbbt/pages",
          tags: ["pages", "ux"],
          source: "cli",
          metadata: { route: "/p/rbbt/pages" },
        },
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      consoleUrl: "https://console.example",
      feedback: {
        id: "fb_1",
        kind: "bug",
        severity: "high",
      },
      url: "https://console.example/org/feedback",
    });
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function makeClient(
  handler: (method: string, path: string, body: unknown, accessToken: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeReadCredentials() {
  return () => makeCredentials();
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["console.feedback"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
