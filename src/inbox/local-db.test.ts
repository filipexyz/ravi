import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createMailAccount, createMailMailbox, importMailMessage } from "../mailbox/index.js";
import { LOCAL_INBOX_MAIL_RECEIVED_SUBJECT, setLocalInboxEventPublisherForTests } from "./local-events.js";
import {
  listLocalInboxEvents,
  listLocalInboxItems,
  markLocalInboxItem,
  projectMailMessageToInbox,
  readLocalInboxItem,
  upsertLocalInboxItem,
} from "./local-db.js";

let stateDir: string | null = null;
let publishedEvents: Array<{ subject: string; payload: Record<string, unknown> }> = [];

describe("local inbox db", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-local-inbox-test-");
    publishedEvents = [];
    setLocalInboxEventPublisherForTests((subject, payload) => {
      publishedEvents.push({ subject, payload });
    });
  });

  afterEach(async () => {
    setLocalInboxEventPublisherForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("dedupes local inbox items by source event", () => {
    const first = upsertLocalInboxItem({
      sourceDomain: "watch",
      sourceType: "github_event",
      sourceId: "evt_1",
      dedupeKey: "watch:evt_1",
      title: "PR opened",
    });
    const second = upsertLocalInboxItem({
      sourceDomain: "watch",
      sourceType: "github_event",
      sourceId: "evt_1",
      dedupeKey: "watch:evt_1",
      title: "PR opened again",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(listLocalInboxItems({ includeArchived: true })).toHaveLength(1);
  });

  it("projects inbound mail into local inbox items", () => {
    const account = createMailAccount({ provider: "ravi-mail" });
    const mailbox = createMailMailbox({ accountId: account.id, address: "luis@ravi.bot", isDefault: true });
    const message = importMailMessage({
      mailbox: mailbox.address,
      providerMessageId: "msg_1",
      subject: "Needs attention",
      bodyText: "Please review",
      addresses: [
        { kind: "from", address: "alice@example.com" },
        { kind: "to", address: mailbox.address },
      ],
      attachments: [
        {
          filename: "contrato.pdf",
          contentType: "application/pdf",
          sizeBytes: 12345,
          sha256: "sha256:abc",
          providerAttachmentId: "remote_att_1",
          redactionStatus: "unscanned",
        },
      ],
    });

    const projection = projectMailMessageToInbox(message);

    expect(projection?.created).toBe(true);
    expect(listLocalInboxItems()).toHaveLength(1);
    expect(listLocalInboxItems()[0].sourceDomain).toBe("mail");
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]?.subject).toBe(LOCAL_INBOX_MAIL_RECEIVED_SUBJECT);
    expect(publishedEvents[0]?.payload).toMatchObject({
      version: 1,
      eventType: "inbox.mail.received",
      sourceDomain: "mail",
      sourceType: "mail_message",
      sourceId: message.id,
      mail: {
        messageId: message.id,
        mailboxId: mailbox.id,
        fromText: "alice@example.com",
        toText: mailbox.address,
        subject: "Needs attention",
        attachments: [
          expect.objectContaining({
            filename: "contrato.pdf",
            contentType: "application/pdf",
            providerAttachmentId: "remote_att_1",
            hasLocalBlob: false,
          }),
        ],
      },
    });
    expect(JSON.stringify(publishedEvents[0]?.payload)).not.toContain("bodyText");

    const replay = projectMailMessageToInbox(message);

    expect(replay?.created).toBe(false);
    expect(publishedEvents).toHaveLength(1);
  });

  it("audits local inbox lifecycle changes", () => {
    const { item } = upsertLocalInboxItem({
      sourceDomain: "approval",
      sourceType: "request",
      sourceId: "approval_1",
      dedupeKey: "approval:1",
      title: "Approve command",
    });

    readLocalInboxItem(item.id);
    markLocalInboxItem(item.id, "done");

    const events = listLocalInboxEvents(item.id);
    expect(events.map((event) => event.eventType)).toContain("created");
    expect(events.map((event) => event.eventType)).toContain("seen");
    expect(events.map((event) => event.eventType)).toContain("done");
  });
});
