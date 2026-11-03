import { describe, expect, test } from "bun:test";

import {
  approvalParamsHash,
  approvalPreview,
  approvalUrl,
  canonicalJson,
  effectiveApprovalStatus,
  readApprovalPreview,
} from "./approvals";
import { importRootWrapKey } from "./crypto";
import { encryptBundle, pendingSecretAad } from "./vault";

const ROOT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const APPROVAL = {
  id: "a0000000-0000-4000-8000-000000000001",
  organizationId: "o0000000-0000-4000-8000-000000000001",
  ownerUserId: "u0000000-0000-4000-8000-000000000001",
};

/** A preview sealed the way an exec seals it, under `dekKeyVersion`. */
async function sealPreview(rootWrapKey: CryptoKey, dekKeyVersion: number, preview: unknown): Promise<string> {
  return encryptBundle({
    plaintext: JSON.stringify(preview),
    aad: pendingSecretAad({
      organizationId: APPROVAL.organizationId,
      userId: APPROVAL.ownerUserId,
      binding: `approval:${APPROVAL.id}`,
      dekKeyVersion,
    }),
    rootWrapKey,
  });
}

describe("approval preview storage", () => {
  test("reads a preview sealed under the current or an older key version", async () => {
    const rootWrapKey = await importRootWrapKey(ROOT_KEY);
    const sealed = await sealPreview(rootWrapKey, 1, { subject: "Hi" });
    for (const dekKeyVersion of [1, 2, 3]) {
      expect(
        await readApprovalPreview({ rootWrapKey, dekKeyVersion }, { ...APPROVAL, previewEncrypted: sealed }),
      ).toEqual({ subject: "Hi" });
    }
  });

  test("a missing, tampered or misbound preview reads as nothing", async () => {
    const rootWrapKey = await importRootWrapKey(ROOT_KEY);
    const sealed = await sealPreview(rootWrapKey, 1, { subject: "Hi" });
    const deps = { rootWrapKey, dekKeyVersion: 1 };
    expect(await readApprovalPreview(deps, { ...APPROVAL, previewEncrypted: null })).toBeNull();
    const [dek, nonce, aadHash, ciphertext] = sealed.split(".");
    const flipped = `${ciphertext!.slice(0, -4)}${ciphertext!.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    expect(
      await readApprovalPreview(deps, { ...APPROVAL, previewEncrypted: [dek, nonce, aadHash, flipped].join(".") }),
    ).toBeNull();
    expect(await readApprovalPreview(deps, { ...APPROVAL, previewEncrypted: "not-a-bundle" })).toBeNull();
    expect(
      await readApprovalPreview(deps, { ...APPROVAL, id: "a0000000-0000-4000-8000-000000000002", previewEncrypted: sealed }),
    ).toBeNull();
    // Sealed under a version newer than the Worker knows: not guessed.
    const newer = await sealPreview(rootWrapKey, 5, { subject: "Hi" });
    expect(await readApprovalPreview(deps, { ...APPROVAL, previewEncrypted: newer })).toBeNull();
  });
});

describe("approval parameters", () => {
  test("canonical JSON sorts keys at every level and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson([undefined, "x"])).toBe('[null,"x"]');
  });

  test("the hash ignores key order and changes with any value", async () => {
    const hash = await approvalParamsHash({ to: ["a@example.com"], subject: "Hi", body: "Text" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await approvalParamsHash({ body: "Text", subject: "Hi", to: ["a@example.com"] })).toBe(hash);
    expect(await approvalParamsHash({ to: ["a@example.com"], subject: "Hi", body: "Text." })).not.toBe(hash);
    expect(await approvalParamsHash({ to: ["b@example.com", "a@example.com"], subject: "Hi", body: "Text" })).not.toBe(
      hash,
    );
  });

  test("an email preview shows recipients, subject and the start of the body", () => {
    expect(approvalPreview("gmail.message.send", { to: ["a@example.com"], subject: "Hi", body: "Short" })).toEqual({
      to: ["a@example.com"],
      cc: [],
      bcc: [],
      subject: "Hi",
      body: "Short",
    });
    const long = approvalPreview("gmail.message.send", {
      to: ["a@example.com"],
      bcc: ["b@example.com"],
      subject: "Long",
      body: "x".repeat(5000),
      bodyHtml: "<p>x</p>",
    });
    expect(long).toMatchObject({ bcc: ["b@example.com"], bodyTruncated: true, hasHtmlBody: true, bodyHtml: "<p>x</p>" });
    expect(long.body).toHaveLength(4000);
    expect(long.bodyHtmlTruncated).toBeUndefined();
    // A cut never leaves half of a surrogate pair.
    const emoji = approvalPreview("gmail.message.send", { to: [], subject: "", body: `${"x".repeat(3999)}😀tail` });
    expect(emoji.body).toBe("x".repeat(3999));
  });

  test("an email preview shows the HTML part as markup and what a reply attaches to", () => {
    const hidden = `<p>Thanks!</p><div style="display:none">${"secret ".repeat(1000)}</div>`;
    const preview = approvalPreview("gmail.message.send", {
      to: ["a@example.com"],
      subject: "Re: Hi",
      body: "Thanks!",
      bodyHtml: hidden,
      threadId: "t-123",
      inReplyTo: "<m1@mail.example.com>",
      references: ["<m0@mail.example.com>", "<m1@mail.example.com>"],
    });
    expect(preview).toMatchObject({
      body: "Thanks!",
      hasHtmlBody: true,
      bodyHtmlTruncated: true,
      threadId: "t-123",
      inReplyTo: "<m1@mail.example.com>",
      references: ["<m0@mail.example.com>", "<m1@mail.example.com>"],
    });
    expect(preview.bodyHtml).toBe(hidden.slice(0, 4000));
    expect(preview.bodyHtml as string).toContain('display:none">secret');
    expect(preview.bodyTruncated).toBeUndefined();
  });

  test("other previews are the parameters, cut to 4 KB", () => {
    expect(approvalPreview("drive.file.share", { b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
    const cut = approvalPreview("drive.file.share", { text: "é".repeat(4000) });
    expect(cut.truncated).toBe(true);
    expect(new TextEncoder().encode(cut.parameters as string).byteLength).toBeLessThanOrEqual(4096);
    expect(cut.parameters as string).not.toContain("�");
  });

  test("approval URL and effective status", () => {
    expect(approvalUrl("https://console.example.test/", "a1")).toBe(
      "https://console.example.test/connectors/approvals/a1",
    );
    expect(effectiveApprovalStatus({ status: "pending", pastExpiry: false })).toBe("pending");
    expect(effectiveApprovalStatus({ status: "pending", pastExpiry: true })).toBe("expired");
    expect(effectiveApprovalStatus({ status: "approved", pastExpiry: true })).toBe("expired");
    expect(effectiveApprovalStatus({ status: "consumed", pastExpiry: true })).toBe("consumed");
    expect(effectiveApprovalStatus({ status: "denied", pastExpiry: true })).toBe("denied");
  });
});
