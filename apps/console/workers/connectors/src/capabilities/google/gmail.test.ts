import { describe, expect, test } from "bun:test";

import { getCapability } from "../registry";
import { buildGmailHandlers, buildMimeMessage } from "./gmail";

const send = getCapability("gmail.message.send");
const base = { to: ["boss@example.com"], subject: "Status", body: "All good." };

/** The header block of a MIME message, one entry per line. */
function headerLines(mime: string): string[] {
  return mime.split("\r\n\r\n")[0]!.split("\r\n");
}

describe("gmail.message.send headers", () => {
  test("a reply's Message-IDs are taken one per header value, with their brackets", () => {
    expect(send.input.parse({ ...base, inReplyTo: "<a1@mail.example.com>" })).toMatchObject({
      inReplyTo: "<a1@mail.example.com>",
    });
    expect(
      send.input.parse({ ...base, inReplyTo: "a1@mail.example.com", references: ["<r1@x>", "r2@x"] }),
    ).toMatchObject({ inReplyTo: "<a1@mail.example.com>", references: ["<r1@x>", "<r2@x>"] });
  });

  test("a line break or control character in a Message-ID is refused", () => {
    for (const inReplyTo of [
      "<a@b>\r\nBcc: attacker@evil.example",
      "<a@b>\nReply-To: attacker@evil.example",
      "<a@b>\r\n\r\nInjected body",
      "<a@b>\u0000",
      "<a b@c>",
      "<a@b><c@d>",
      "",
    ]) {
      expect(send.input.safeParse({ ...base, inReplyTo }).success).toBe(false);
      expect(send.input.safeParse({ ...base, references: ["<ok@x>", inReplyTo] }).success).toBe(false);
    }
  });

  test("the MIME builder never lets a header value start another line", () => {
    const mime = buildMimeMessage({
      ...base,
      cc: ["c@example.com"],
      inReplyTo: "<a@b>\r\nBcc: attacker@evil.example",
      references: ["<r@x>\nReply-To: attacker@evil.example"],
    });
    const lines = headerLines(mime);
    expect(lines.some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(lines.some((line) => /^reply-to:/i.test(line))).toBe(false);
    expect(lines).toContain("In-Reply-To: <a@b> Bcc: attacker@evil.example");
    expect(lines).toContain("Cc: c@example.com");
  });

  test("the request Gmail receives carries exactly the validated headers", async () => {
    let raw = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      raw = (JSON.parse(String(init?.body)) as { raw: string }).raw;
      return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), { status: 200 });
    }) as typeof fetch;
    const parameters = send.input.parse({ ...base, bcc: ["b@example.com"], inReplyTo: "a1@mail.example.com" });
    await buildGmailHandlers(fetchImpl).get("gmail.message.send")!.execute({
      parameters,
      accessToken: "token",
      abortSignal: new AbortController().signal,
    });
    const lines = headerLines(Buffer.from(raw, "base64url").toString("utf8"));
    expect(lines.filter((line) => /^bcc:/i.test(line))).toEqual(["Bcc: b@example.com"]);
    expect(lines).toContain("In-Reply-To: <a1@mail.example.com>");
  });
});
