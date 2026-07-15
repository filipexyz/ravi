import { describe, expect, it } from "bun:test";
import { GmailClient, encodeGmailMimeMessage, parseGmailCredential } from "./client.js";

const placeholderCredential = { accessToken: "placeholder-access" };

function recordingFetch(
  calls: Array<{ url: string; method: string; body: string | null; authorization: string | null }>,
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.endsWith("/messages/send")) return Response.json({ id: "sent-id", threadId: "thread-id" });
    if (url.includes("/messages/message-id")) return Response.json({ id: "message-id", snippet: "hello" });
    return Response.json({ messages: [{ id: "message-id", threadId: "thread-id" }] });
  }) as typeof fetch;
}

describe("GmailClient", () => {
  it("accepts only an explicit access-token credential envelope", () => {
    expect(parseGmailCredential('{"accessToken":"placeholder"}')).toEqual({ accessToken: "placeholder" });
    expect(parseGmailCredential('{"access_token":"placeholder"}')).toEqual({ accessToken: "placeholder" });
    expect(() => parseGmailCredential('{"refreshToken":"placeholder"}')).toThrow("accessToken");
    expect(() => parseGmailCredential("not-json")).toThrow("JSON object");
  });

  it("fails closed before any network call when credentials are absent", async () => {
    let fetchCalls = 0;
    const client = new GmailClient({
      fetch: (async () => {
        fetchCalls += 1;
        return Response.json({});
      }) as unknown as typeof fetch,
      credentialResolver: async () => {
        throw new Error("Gmail credential is not configured");
      },
    });

    await expect(client.listMessages()).rejects.toThrow("credential is not configured");
    expect(fetchCalls).toBe(0);
  });

  it("uses the official list, get and send methods with fake transport only", async () => {
    const calls: Array<{ url: string; method: string; body: string | null; authorization: string | null }> = [];
    const client = new GmailClient({ credential: placeholderCredential, fetch: recordingFetch(calls) });

    await client.listMessages({
      q: "is:unread",
      labelIds: ["INBOX", "IMPORTANT"],
      maxResults: 25,
      pageToken: "next-page",
      includeSpamTrash: false,
    });
    await client.getMessage("message-id", "metadata");
    await client.sendMessage({ raw: "encoded-message", threadId: "thread-id" });

    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&labelIds=INBOX&labelIds=IMPORTANT&maxResults=25&pageToken=next-page&includeSpamTrash=false",
        method: "GET",
      },
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/message-id?format=metadata",
        method: "GET",
      },
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        method: "POST",
      },
    ]);
    expect(JSON.parse(calls[2]?.body ?? "null")).toEqual({ raw: "encoded-message", threadId: "thread-id" });
    expect(calls.every((call) => call.authorization === "Bearer placeholder-access")).toBe(true);
  });

  it("encodes an RFC 2822 MIME message as base64url and rejects header injection", () => {
    const raw = encodeGmailMimeMessage({
      to: ["person@example.test"],
      subject: "Assunto",
      body: "Olá",
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: person@example.test\r\n");
    expect(decoded).toContain("Subject: Assunto\r\n");
    expect(decoded).toEndWith("\r\n\r\nOlá");
    expect(raw).not.toContain("=");
    expect(() =>
      encodeGmailMimeMessage({
        to: ["person@example.test"],
        subject: "safe\r\nBcc: attacker@example.test",
        body: "body",
      }),
    ).toThrow("line breaks");
  });

  it("redacts provider credential fields from errors", async () => {
    const client = new GmailClient({
      credential: placeholderCredential,
      fetch: (async () =>
        Response.json(
          { access_token: "provider-value", client_secret: "provider-secret" },
          { status: 401 },
        )) as unknown as typeof fetch,
    });

    const error = await client.listMessages().then(
      () => new Error("Expected Gmail API request to fail"),
      (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
    );
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("provider-value");
    expect(error.message).not.toContain("provider-secret");
  });
});
