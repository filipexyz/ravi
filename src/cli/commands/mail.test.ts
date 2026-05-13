import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { MailCommands, MailDomainsCommands, MailMessagesCommands } from "./mail.js";

describe("mail CLI commands", () => {
  it("registers a managed domain through mail domains create", async () => {
    const bodies: unknown[] = [];
    const client = makeClient(async (_method, _path, body) => {
      bodies.push(body);
      return { domain: { domain: "ravi.bot", status: "verified" } };
    });
    const command = new MailDomainsCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.create("ravi.bot", undefined, true));
    const payload = JSON.parse(output);

    expect(bodies).toEqual([{ domain: "ravi.bot" }]);
    expect(payload.domain.domain).toBe("ravi.bot");
  });

  it("prints message list metadata without body content", async () => {
    const client = makeClient(async () => ({
      messages: [
        {
          id: "msg_1",
          from: "alice@example.com",
          subject: "Hello",
          body: "hidden body",
          decryptedBody: "hidden decrypted body",
        },
      ],
    }));
    const command = new MailMessagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.list("box_1", undefined, undefined, undefined, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(payload.messages[0].id).toBe("msg_1");
    expect(JSON.stringify(payload)).not.toContain("hidden body");
    expect(JSON.stringify(payload)).not.toContain("hidden decrypted body");
  });

  it("requests address summaries only when --addresses is explicit", async () => {
    const paths: string[] = [];
    const client = makeClient(async (_method, path) => {
      paths.push(path);
      return {
        messages: [
          {
            id: "msg_1",
            addressSummary: {
              schemaVersion: 1,
              from: [{ name: "Alice", address: "alice@example.com" }],
              to: [{ address: "agent@ravi.bot" }],
            },
          },
        ],
      };
    });
    const command = new MailMessagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.list("box_1", undefined, undefined, undefined, true, false));

    expect(paths[0]).toContain("addresses=1");
    expect(output).toContain("from=Alice <alice@example.com>");
  });

  it("prints explicit read payload only through messages read", async () => {
    const client = makeClient(async () => ({
      message: {
        id: "msg_1",
        subject: "Hello",
        body: "explicit body",
      },
    }));
    const command = new MailMessagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.read("msg_1", undefined, undefined, true));

    expect(output).toContain("explicit body");
  });

  it("sends without from unless --from is provided", async () => {
    const bodies: unknown[] = [];
    const client = makeClient(async (_method, _path, body) => {
      bodies.push(body);
      return { sent: { id: "out_1", status: "queued" } };
    });
    const command = new MailCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() =>
      command.send("bob@example.com", "Subject", "Body", undefined, undefined, undefined, true),
    );
    await captureConsole(() =>
      command.send("bob@example.com", "Subject", "Body", "agent@example.com", undefined, undefined, true),
    );

    expect(bodies).toEqual([
      { to: ["bob@example.com"], subject: "Subject", body: "Body" },
      { from: "agent@example.com", to: ["bob@example.com"], subject: "Subject", body: "Body" },
    ]);
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
    scopes: ["mail"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
