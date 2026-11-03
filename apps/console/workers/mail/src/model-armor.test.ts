import { describe, expect, mock, test } from "bun:test";

import {
  modelArmorByteDataTypeForAttachment,
  scanParsedMailWithModelArmor,
  type MailModelArmorEnv,
} from "./model-armor";

describe("Ravi Mail Model Armor guardrail", () => {
  test("maps supported attachment types explicitly", () => {
    expect(modelArmorByteDataTypeForAttachment({ contentType: "application/pdf", filename: null })).toBe("PDF");
    expect(modelArmorByteDataTypeForAttachment({ contentType: null, filename: "notes.docx" })).toBe(
      "WORD_DOCUMENT",
    );
    expect(modelArmorByteDataTypeForAttachment({ contentType: null, filename: "sheet.xlsx" })).toBe(
      "EXCEL_DOCUMENT",
    );
    expect(modelArmorByteDataTypeForAttachment({ contentType: null, filename: "deck.pptx" })).toBe(
      "POWERPOINT_DOCUMENT",
    );
    expect(modelArmorByteDataTypeForAttachment({ contentType: null, filename: "readme.txt" })).toBe("TXT");
    expect(modelArmorByteDataTypeForAttachment({ contentType: "text/csv", filename: null })).toBe("CSV");
    expect(modelArmorByteDataTypeForAttachment({ contentType: "image/png", filename: "image.png" })).toBeNull();
  });

  test("scans content and supported attachments without persisting raw payloads in metadata", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        sanitizationResult: {
          filterMatchState: "NO_MATCH_FOUND",
          invocationResult: "SUCCESS",
        },
      });
    }) as unknown as typeof fetch;

    const result = await scanParsedMailWithModelArmor({
      env: modelArmorEnv(),
      fetchImpl,
      input: parsedMailInput(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual([
      {
        userPromptData: {
          text: "Subject: Plain subject\nsecret body",
        },
      },
      {
        userPromptData: {
          byteItem: {
            byteData: "YXR0YWNobWVudCBieXRlcw==",
            byteDataType: "PDF",
          },
        },
      },
    ]);
    expect(result.metadataJson).toMatchObject({
      guardrail: {
        delivery: "deliver",
        provider: "model_armor",
        content: {
          status: "clean",
        },
        attachments: [
          {
            attachmentId: "message_1:attachment:1",
            byteDataType: "PDF",
            status: "clean",
          },
        ],
      },
    });
    expect(JSON.stringify(result.metadataJson)).not.toContain("secret body");
    expect(JSON.stringify(result.metadataJson)).not.toContain("contract.pdf");
    expect(JSON.stringify(result.metadataJson)).not.toContain("attachment bytes");
    expect(JSON.stringify(result.metadataJson)).not.toContain("YXR0YWNobWVudCBieXRlcw==");
  });

  test("quarantines matched Model Armor findings when enforcement mode is quarantine", async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        sanitizationResult: {
          filterMatchState: "MATCH_FOUND",
          invocationResult: "SUCCESS",
          piAndJailbreakFilterResult: {
            filterMatchState: "MATCH_FOUND",
          },
        },
      }),
    ) as unknown as typeof fetch;

    const result = await scanParsedMailWithModelArmor({
      env: modelArmorEnv({ RAVI_MAIL_MODEL_ARMOR_MODE: "quarantine" }),
      fetchImpl,
      input: parsedMailInput(),
    });

    expect(result.metadataJson).toMatchObject({
      guardrail: {
        delivery: "quarantine",
        mode: "quarantine",
        content: {
          status: "matched",
        },
      },
    });
  });

  test("quarantines when Model Armor is enabled but required config is missing", async () => {
    const fetchImpl = mock(async () => Response.json({})) as unknown as typeof fetch;
    const log = mock(() => {});

    const result = await scanParsedMailWithModelArmor({
      env: {
        RAVI_MAIL_MODEL_ARMOR_ENABLED: "true",
      },
      fetchImpl,
      input: parsedMailInput(),
      log,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mail_model_armor_misconfigured",
        reason: "missing_project_id,missing_location,missing_template_id,missing_auth",
      }),
    );
    expect(result.metadataJson).toMatchObject({
      guardrail: {
        enabled: true,
        delivery: "quarantine",
        failPolicy: "fail-closed",
        content: {
          status: "failed",
          error: "missing_project_id,missing_location,missing_template_id,missing_auth",
        },
        attachments: [
          {
            attachmentId: "message_1:attachment:1",
            status: "failed",
          },
        ],
      },
    });
  });

  test("delivers with skipped scan metadata when explicit fail-open policy is configured", async () => {
    const fetchImpl = mock(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    const result = await scanParsedMailWithModelArmor({
      env: modelArmorEnv({ RAVI_MAIL_MODEL_ARMOR_FAIL_POLICY: "fail-open" }),
      fetchImpl,
      input: parsedMailInput(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.metadataJson).toMatchObject({
      guardrail: {
        delivery: "deliver",
        failPolicy: "fail-open",
        content: {
          status: "skipped",
          error: "http_503",
        },
        attachments: [
          {
            attachmentId: "message_1:attachment:1",
            status: "skipped",
            error: "http_503",
          },
        ],
      },
    });
  });

  test("records unsupported and oversized attachments without calling Model Armor for them", async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        sanitizationResult: {
          filterMatchState: "NO_MATCH_FOUND",
          invocationResult: "SUCCESS",
        },
      }),
    ) as unknown as typeof fetch;

    const result = await scanParsedMailWithModelArmor({
      env: modelArmorEnv({ RAVI_MAIL_MODEL_ARMOR_MAX_ATTACHMENT_BYTES: "4" }),
      fetchImpl,
      input: {
        ...parsedMailInput(),
        attachments: [
          {
            attachmentId: "message_1:attachment:1",
            content: new TextEncoder().encode("too-large"),
            contentType: "application/pdf",
            filename: "large.pdf",
            sha256: "sha256_large",
            sizeBytes: 9,
          },
          {
            attachmentId: "message_1:attachment:2",
            content: new TextEncoder().encode("image"),
            contentType: "image/png",
            filename: "image.png",
            sha256: "sha256_image",
            sizeBytes: 5,
          },
        ],
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.metadataJson).toMatchObject({
      guardrail: {
        delivery: "quarantine",
        unsupportedPolicy: "quarantine",
        attachments: [
          {
            attachmentId: "message_1:attachment:1",
            status: "skipped_size_limit",
          },
          {
            attachmentId: "message_1:attachment:2",
            status: "unsupported",
          },
        ],
      },
    });
  });

  test("scans supported attachments with bounded concurrency", async () => {
    let activeAttachmentScans = 0;
    let maxActiveAttachmentScans = 0;
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.userPromptData?.byteItem) {
        activeAttachmentScans += 1;
        maxActiveAttachmentScans = Math.max(maxActiveAttachmentScans, activeAttachmentScans);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeAttachmentScans -= 1;
      }
      return Response.json({
        sanitizationResult: {
          filterMatchState: "NO_MATCH_FOUND",
          invocationResult: "SUCCESS",
        },
      });
    }) as unknown as typeof fetch;

    const result = await scanParsedMailWithModelArmor({
      env: modelArmorEnv(),
      fetchImpl,
      input: {
        ...parsedMailInput(),
        attachments: Array.from({ length: 4 }, (_, index) => ({
          attachmentId: `message_1:attachment:${index + 1}`,
          content: new TextEncoder().encode(`attachment ${index + 1}`),
          contentType: "application/pdf",
          filename: `contract-${index + 1}.pdf`,
          sha256: `sha256_attachment_${index + 1}`,
          sizeBytes: 16,
        })),
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(maxActiveAttachmentScans).toBe(3);
    expect(result.metadataJson).toMatchObject({
      guardrail: {
        delivery: "deliver",
        attachments: [
          { attachmentId: "message_1:attachment:1", status: "clean" },
          { attachmentId: "message_1:attachment:2", status: "clean" },
          { attachmentId: "message_1:attachment:3", status: "clean" },
          { attachmentId: "message_1:attachment:4", status: "clean" },
        ],
      },
    });
  });
});

function modelArmorEnv(overrides: Partial<MailModelArmorEnv> = {}): MailModelArmorEnv {
  return {
    RAVI_MAIL_MODEL_ARMOR_ACCESS_TOKEN: "model-armor-token",
    RAVI_MAIL_MODEL_ARMOR_ENABLED: "true",
    RAVI_MAIL_MODEL_ARMOR_LOCATION: "us-central1",
    RAVI_MAIL_MODEL_ARMOR_PROJECT_ID: "ravi-prod",
    RAVI_MAIL_MODEL_ARMOR_TEMPLATE_ID: "mail-inbound",
    ...overrides,
  };
}

function parsedMailInput() {
  return {
    schemaVersion: 1 as const,
    requestId: "req_1",
    organizationId: "org_1",
    projectId: "proj_1",
    mailboxId: "mailbox_1",
    messageId: "message_1",
    subject: "Plain subject",
    bodyText: "secret body",
    bodyHtml: null,
    classification: {
      schemaVersion: 1 as const,
      category: "unknown" as const,
      hasAttachments: true,
      attachmentCount: 1,
    },
    attachments: [
      {
        attachmentId: "message_1:attachment:1",
        content: new TextEncoder().encode("attachment bytes"),
        contentType: "application/pdf",
        filename: "contract.pdf",
        sha256: "sha256_attachment",
        sizeBytes: 16,
      },
    ],
  };
}
