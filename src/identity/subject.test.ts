import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertChat, dbUpsertChatParticipant } from "../router/router-db.js";
import { dbCreateTask } from "../tasks/task-db.js";
import { isEmptySubject, readSubjectFromEnv, resolveSubjectForChat } from "./subject.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-subject-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("readSubjectFromEnv", () => {
  it("keeps a resolved contact as the subject", () => {
    const subject = readSubjectFromEnv({
      RAVI_ACTOR_TYPE: "contact",
      RAVI_CONTACT_ID: "contact-1",
      RAVI_PLATFORM_IDENTITY_ID: "pi-1",
      RAVI_RAW_SENDER_ID: "U123",
      RAVI_CHANNEL: "slack",
    });

    expect(subject).toEqual({
      kind: "contact",
      contactId: "contact-1",
      identityId: "pi-1",
      channel: "slack",
      rawId: "U123",
    });
  });

  it("keeps an agent actor as an agent subject, never as a human", () => {
    const subject = readSubjectFromEnv({
      RAVI_ACTOR_TYPE: "agent",
      RAVI_AGENT_ID: "dev",
      RAVI_SENDER_ID: "U999",
    });

    expect(subject.kind).toBe("agent");
    expect(subject.agentId).toBe("dev");
    expect(subject.contactId).toBeUndefined();
  });

  it("stays explicitly unknown when the turn carries no actor metadata", () => {
    const subject = readSubjectFromEnv({ RAVI_SENDER_NAME: "luis" });

    expect(subject).toEqual({ kind: "unknown" });
    expect(isEmptySubject(subject)).toBe(true);
  });

  it("does not treat a display name as identity evidence", () => {
    const subject = readSubjectFromEnv({ RAVI_SENDER_NAME: "luis", RAVI_ACTOR_TYPE: "contact" });

    expect(subject.kind).toBe("unknown");
    expect(subject.contactId).toBeUndefined();
  });
});

describe("resolveSubjectForChat", () => {
  function seedChat(platformChatId: string): string {
    return dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId,
      chatType: "dm",
    }).id;
  }

  it("resolves a one-to-one chat to its single human", () => {
    const chatId = seedChat("D-one-to-one");
    dbUpsertChatParticipant({
      chatId,
      contactId: "contact-1",
      platformIdentityId: "pi-1",
      rawPlatformUserId: "U123",
      role: "member",
      source: "inbound_message",
    });

    const subject = resolveSubjectForChat(chatId);

    expect(subject).toEqual({ kind: "contact", contactId: "contact-1", identityId: "pi-1", rawId: "U123" });
  });

  it("does not guess in a shared chat with several humans", () => {
    const chatId = seedChat("C-shared");
    dbUpsertChatParticipant({
      chatId,
      contactId: "contact-1",
      platformIdentityId: "pi-1",
      rawPlatformUserId: "U123",
      role: "member",
      source: "inbound_message",
    });
    dbUpsertChatParticipant({
      chatId,
      contactId: "contact-2",
      platformIdentityId: "pi-2",
      rawPlatformUserId: "U456",
      role: "member",
      source: "inbound_message",
    });

    const subject = resolveSubjectForChat(chatId);

    expect(subject.kind).toBe("unknown");
    expect(subject.contactId).toBeUndefined();
  });

  it("returns unknown for a chat it has never seen", () => {
    expect(resolveSubjectForChat("chat-missing")).toEqual({ kind: "unknown" });
  });
});

describe("task subject attribution", () => {
  it("persists the subject of the task", () => {
    const created = dbCreateTask({
      title: "Attributed task",
      instructions: "carry the subject",
      createdBy: "test",
      subject: { kind: "contact", contactId: "contact-1", identityId: "pi-1", channel: "slack", rawId: "U123" },
    });

    expect(created.task.subject).toEqual({
      kind: "contact",
      contactId: "contact-1",
      identityId: "pi-1",
      channel: "slack",
      rawId: "U123",
    });
  });

  it("inherits the subject from the parent task", () => {
    const parent = dbCreateTask({
      title: "Parent",
      instructions: "asked for by a human",
      createdBy: "test",
      subject: { kind: "contact", contactId: "contact-1" },
    });
    const child = dbCreateTask({
      title: "Child",
      instructions: "created by an agent inside the parent task",
      createdBy: "agent",
      parentTaskId: parent.task.id,
    });

    expect(child.task.subject?.contactId).toBe("contact-1");
  });

  it("stores an explicit unknown subject instead of dropping attribution", () => {
    const created = dbCreateTask({
      title: "Unattributed task",
      instructions: "no human known",
      createdBy: "test",
      subject: { kind: "unknown", channel: "slack", rawId: "U999" },
    });

    expect(created.task.subject).toEqual({ kind: "unknown", channel: "slack", rawId: "U999" });
  });
});
