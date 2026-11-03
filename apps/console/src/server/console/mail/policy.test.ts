import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAIL_RETENTION_DAYS,
  decideMailAccess,
  resolveMailRetentionDays,
  validateMailPayloadSize,
} from "./policy";

describe("Ravi Mail access policy", () => {
  test("allows read and send only inside the same organization with permission", () => {
    expect(
      decideMailAccess("read", {
        actorOrganizationId: "org_1",
        mailboxOrganizationId: "org_1",
        canRead: true,
      }),
    ).toEqual({ ok: true });

    expect(
      decideMailAccess("send", {
        actorOrganizationId: "org_1",
        mailboxOrganizationId: "org_1",
        canSend: true,
      }),
    ).toEqual({ ok: true });
  });

  test("denies cross-organization reads with coarse public errors", () => {
    expect(
      decideMailAccess("read", {
        actorOrganizationId: "org_1",
        mailboxOrganizationId: "org_2",
        canRead: true,
      }),
    ).toEqual({
      ok: false,
      reason: "cross_organization",
      publicError: "mail_operation_denied",
    });
  });

  test("keeps read/decrypt and send permissions separate", () => {
    expect(
      decideMailAccess("decrypt", {
        actorOrganizationId: "org_1",
        mailboxOrganizationId: "org_1",
        canSend: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: "missing_read_permission",
    });

    expect(
      decideMailAccess("send", {
        actorOrganizationId: "org_1",
        mailboxOrganizationId: "org_1",
        canRead: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: "missing_send_permission",
    });
  });

  test("uses the 130 day default retention contract", () => {
    expect(resolveMailRetentionDays(undefined)).toEqual({
      ok: true,
      days: DEFAULT_MAIL_RETENTION_DAYS,
    });
    expect(resolveMailRetentionDays(130)).toEqual({
      ok: true,
      days: 130,
    });
    expect(resolveMailRetentionDays(0)).toMatchObject({
      ok: false,
      reason: "retention_out_of_range",
    });
  });

  test("validates message and attachment size limits independently", () => {
    const limits = {
      maxMessageBytes: 100,
      maxAttachmentBytes: 20,
    };

    expect(validateMailPayloadSize({ messageBytes: 100, attachmentBytes: 20, limits })).toEqual({ ok: true });
    expect(validateMailPayloadSize({ messageBytes: 101, attachmentBytes: 1, limits })).toMatchObject({
      ok: false,
      reason: "message_too_large",
    });
    expect(validateMailPayloadSize({ messageBytes: 99, attachmentBytes: 21, limits })).toMatchObject({
      ok: false,
      reason: "attachment_too_large",
    });
  });
});
