import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { createMailDomain, listMailDomains, listMessages, readMessage, sendMail } from "./client.js";

describe("Ravi Mail Console client", () => {
  it("requires Ravi Cloud auth before calling mail endpoints", async () => {
    await expect(listMailDomains({}, { readCredentials: () => null })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("creates managed domains through the Console mail endpoint", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return { domain: { domain: "ravi.bot", status: "verified" } };
    });

    const result = await createMailDomain({ domain: "ravi.bot" }, { client, readCredentials: makeReadCredentials() });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/mail/domains",
        body: { domain: "ravi.bot" },
        accessToken: "access-secret",
      },
    ]);
    expect(result).toEqual({ domain: { domain: "ravi.bot", status: "verified" } });
  });

  it("lists message metadata without returning decrypted or plaintext body fields", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        messages: [
          {
            id: "msg_1",
            subject: "Hello",
            from: "alice@example.com",
            body: "plaintext body must not leave metadata list",
            decryptedBody: "decrypted body must not leave metadata list",
            attachments: [{ filename: "invoice.pdf", content: "attachment body" }],
          },
        ],
      };
    });

    const result = await listMessages(
      { mailbox: "box_1", limit: 25, offset: 50 },
      { client, readCredentials: makeReadCredentials() },
    );

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/mail/messages?limit=25&offset=50&mailbox=box_1",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(JSON.stringify(result)).toContain("msg_1");
    expect(JSON.stringify(result)).not.toContain("plaintext body");
    expect(JSON.stringify(result)).not.toContain("decrypted body");
    expect(JSON.stringify(result)).not.toContain("attachment body");
  });

  it("reads exactly one message through the explicit read/decrypt endpoint", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {
        message: {
          id: "msg_1",
          subject: "Hello",
          body: "explicit read body",
        },
        audit: { operation: "mail.message.read" },
      };
    });

    const result = await readMessage(
      "msg_1",
      { payloadKind: "raw_mime" },
      { client, readCredentials: makeReadCredentials() },
    );

    expect(calls).toEqual([
      { method: "POST", path: "/api/cli/mail/messages/msg_1/read", body: { payloadKind: "raw_mime" } },
    ]);
    expect(JSON.stringify(result)).toContain("explicit read body");
  });

  it("sends without --from so Console can resolve the default mailbox", async () => {
    const bodies: unknown[] = [];
    const client = makeClient(async (_method, _path, body) => {
      bodies.push(body);
      return { sent: { id: "out_1", status: "queued" } };
    });

    await sendMail(
      { to: ["bob@example.com"], subject: "Hi", body: "Body" },
      { client, readCredentials: makeReadCredentials() },
    );

    expect(bodies).toEqual([{ to: ["bob@example.com"], subject: "Hi", body: "Body" }]);
  });

  it("sends with explicit --from when provided", async () => {
    const bodies: unknown[] = [];
    const client = makeClient(async (_method, _path, body) => {
      bodies.push(body);
      return { sent: { id: "out_1", status: "queued" } };
    });

    await sendMail(
      { from: "agent@example.com", to: ["bob@example.com"], subject: "Hi", body: "Body" },
      { client, readCredentials: makeReadCredentials() },
    );

    expect(bodies).toEqual([{ from: "agent@example.com", to: ["bob@example.com"], subject: "Hi", body: "Body" }]);
  });

  it("coarsens cross-tenant mail lookup errors from Console", async () => {
    const client = makeClient(async () => {
      throw new CloudAuthError("ORG_ACCESS_DENIED", "Mailbox secret@other-tenant.example is denied.", {
        status: 403,
      });
    });

    try {
      await listMessages(
        { mailbox: "secret@other-tenant.example" },
        { client, readCredentials: makeReadCredentials() },
      );
      throw new Error("expected listMessages to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      const cloudError = error as CloudAuthError;
      expect(cloudError.code).toBe("ORG_ACCESS_DENIED");
      expect(cloudError.message).toBe("Mail resource is not available to this Ravi Cloud identity.");
      expect(cloudError.message).not.toContain("secret@other-tenant");
    }
  });
});

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
