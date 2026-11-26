import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact } from "../contacts.js";
import { dbUpsertChat, dbUpsertChatMessage, dbUpsertChatParticipant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { ConnectorTurn } from "./connector-turn.js";
import {
  OWNER_CONFIRMATION_WINDOW_MS,
  ownerConfirmationCode,
  ownerReadExposure,
  type OwnerReadExposureDeps,
} from "./owner-read-confirmation.js";

const OWNER = "contact-owner";
const NOW = 1_795_700_000_000;
const WINDOW = Math.floor(NOW / OWNER_CONFIRMATION_WINDOW_MS);

function ownerTurn(chatId: string | undefined, kind: "dm" | "group" = "group"): ConnectorTurn {
  return {
    actorPrincipal: `contact:${OWNER}`,
    speaker: { kind: "owner", contactId: OWNER },
    conversation: kind,
    ...(chatId ? { answerChat: { chatId, kind } } : {}),
  };
}

function deps(overrides: Partial<OwnerReadExposureDeps> = {}): OwnerReadExposureDeps {
  return {
    now: () => NOW,
    isInsideContact: (contactId) => contactId === OWNER,
    directChatContact: () => null,
    contactMessagesSince: () => [],
    ...overrides,
  };
}

describe("owner read confirmation", () => {
  it("leaves turns that are not the owner's own message alone", () => {
    for (const turn of [
      { actorPrincipal: "terminal", speaker: { kind: "terminal" as const }, conversation: "terminal" as const },
      {
        actorPrincipal: "contact:c_ana",
        speaker: { kind: "contact" as const, contactId: "c_ana" },
        conversation: "group" as const,
      },
      { actorPrincipal: "automation:operator:local", speaker: { kind: "owner" as const }, conversation: "dm" as const },
    ]) {
      expect(ownerReadExposure(turn, deps())).toEqual({ ok: true, reason: "not_owner_chat" });
    }
  });

  it("brings it to the owner's own direct chat without asking", () => {
    expect(ownerReadExposure(ownerTurn("chat_owner_dm", "dm"), deps({ directChatContact: () => OWNER }))).toEqual({
      ok: true,
      reason: "inside",
    });
  });

  it("brings it to a direct chat with someone inside the organization", () => {
    const exposure = ownerReadExposure(
      ownerTurn("chat_colleague_dm", "dm"),
      deps({ directChatContact: () => "contact-colleague", isInsideContact: () => true }),
    );
    expect(exposure).toEqual({ ok: true, reason: "inside" });
  });

  it("asks the owner to confirm in a group, with a code for this chat and window", () => {
    const exposure = ownerReadExposure(ownerTurn("chat_client_group"), deps());
    expect(exposure.ok).toBe(false);
    if (exposure.ok) return;
    const code = ownerConfirmationCode("chat_client_group", OWNER, WINDOW);
    expect(exposure.code).toBe(code);
    expect(exposure.error.code).toBe("OWNER_CONFIRMATION_REQUIRED");
    expect(exposure.error.exitCode).toBe(3);
    expect(exposure.error.details).toMatchObject({
      source: "owner-read-confirmation",
      replyTo: "same_chat",
      confirmationCode: code,
      chatLinePt: `Este chat tem gente de fora da organização. Para eu trazer isso aqui, responda: confirmo ${code}`,
    });
  });

  it("asks in a direct chat with someone outside the organization", () => {
    const exposure = ownerReadExposure(
      ownerTurn("chat_client_dm", "dm"),
      deps({ directChatContact: () => "contact-client", isInsideContact: (id) => id === OWNER }),
    );
    expect(exposure.ok).toBe(false);
  });

  it("accepts the owner's own confirmation with this window's code or the one before", () => {
    for (const window of [WINDOW, WINDOW - 1]) {
      const code = ownerConfirmationCode("chat_client_group", OWNER, window);
      const exposure = ownerReadExposure(
        ownerTurn("chat_client_group"),
        deps({ contactMessagesSince: () => [`@ravi confirmo ${code}`] }),
      );
      expect(exposure).toEqual({ ok: true, reason: "confirmed" });
    }
  });

  it("does not take a wrong code, an older window's code, another chat's code or a bare confirmo", () => {
    for (const text of [
      "confirmo 000000",
      `confirmo ${ownerConfirmationCode("chat_client_group", OWNER, WINDOW - 2)}`,
      `confirmo ${ownerConfirmationCode("chat_other_group", OWNER, WINDOW)}`,
      "confirmo",
      "pode trazer",
    ]) {
      expect(ownerReadExposure(ownerTurn("chat_client_group"), deps({ contactMessagesSince: () => [text] })).ok).toBe(
        false,
      );
    }
  });

  it("looks only at the owner's own messages of the last ten minutes in this chat", () => {
    const seen: Array<{ chatRef: string; contactId: string; sinceMs: number }> = [];
    ownerReadExposure(
      ownerTurn("chat_client_group"),
      deps({
        contactMessagesSince: (input) => {
          seen.push(input);
          return [];
        },
      }),
    );
    expect(seen).toEqual([
      { chatRef: "chat_client_group", contactId: OWNER, sinceMs: NOW - OWNER_CONFIRMATION_WINDOW_MS },
    ]);
  });

  it("fails closed when it cannot tell where the answer goes or who reads it", () => {
    const noChat = ownerReadExposure(ownerTurn(undefined), deps());
    expect(noChat).toMatchObject({ ok: false, code: null });

    const unreadable = ownerReadExposure(
      ownerTurn("chat_client_group"),
      deps({
        directChatContact: () => {
          throw new Error("db locked");
        },
      }),
    );
    expect(unreadable).toMatchObject({ ok: false, code: null });
    if (!unreadable.ok) expect(unreadable.error.code).toBe("OWNER_CONFIRMATION_REQUIRED");
  });
});

describe("owner read confirmation against the chat store", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-owner-read-confirmation-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function directChat(platformChatId: string, contactId: string) {
    const chat = dbUpsertChat({ channel: "slack", instanceId: "ravi-slack", platformChatId, chatType: "dm" });
    dbUpsertChatParticipant({ chatId: chat.id, contactId });
    return chat;
  }

  function say(
    chatId: string,
    platformChatId: string,
    input: { contactId?: string; agentId?: string; text: string; at: number },
  ) {
    dbUpsertChatMessage({
      chatId,
      channel: "slack",
      instanceId: "ravi-slack",
      providerMessageId: `m-${input.at}-${input.contactId ?? input.agentId}`,
      rawChatId: platformChatId,
      actorType: input.contactId ? "contact" : "agent",
      contactId: input.contactId ?? null,
      agentId: input.agentId ?? null,
      content: { type: "text", text: input.text },
      providerTimestamp: input.at,
      ingestedAt: input.at,
    });
  }

  it("treats the tagged owner's DM, and a thread inside it, as inside the organization", () => {
    const owner = createContact({
      phone: "5511900000001",
      name: "Owner",
      status: "allowed",
      tags: ["permission-owner"],
    });
    const dm = directChat("D0OWNER", owner.id);
    const thread = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "D0OWNER#1795.1",
      chatType: "thread",
    });
    const turn = (chatId: string): ConnectorTurn => ({
      actorPrincipal: `contact:${owner.id}`,
      speaker: { kind: "owner", contactId: owner.id },
      conversation: "dm",
      answerChat: { chatId, kind: "dm" },
    });

    expect(ownerReadExposure(turn(dm.id))).toEqual({ ok: true, reason: "inside" });
    expect(ownerReadExposure(turn(thread.id))).toEqual({ ok: true, reason: "inside" });
  });

  it("asks in a group until the owner's own message there carries the code", () => {
    const owner = createContact({
      phone: "5511900000001",
      name: "Owner",
      status: "allowed",
      tags: ["permission-owner"],
    });
    const client = createContact({ phone: "5511988887777", name: "Client", status: "allowed" });
    const group = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-slack",
      platformChatId: "C0CLIENT",
      chatType: "group",
    });
    const now = Date.now();
    const turn: ConnectorTurn = {
      actorPrincipal: `contact:${owner.id}`,
      speaker: { kind: "owner", contactId: owner.id },
      conversation: "group",
      answerChat: { chatId: group.id, kind: "group" },
    };

    const asked = ownerReadExposure(turn);
    expect(asked.ok).toBe(false);
    if (asked.ok || !asked.code) throw new Error("expected a confirmation code");
    const code = asked.code;

    // Someone else, the agent, or an old message of the owner do not confirm it.
    say(group.id, "C0CLIENT", { contactId: client.id, text: `confirmo ${code}`, at: now - 1_000 });
    say(group.id, "C0CLIENT", { agentId: "main", text: `responda: confirmo ${code}`, at: now - 900 });
    say(group.id, "C0CLIENT", {
      contactId: owner.id,
      text: `confirmo ${code}`,
      at: now - OWNER_CONFIRMATION_WINDOW_MS - 60_000,
    });
    expect(ownerReadExposure(turn).ok).toBe(false);

    say(group.id, "C0CLIENT", { contactId: owner.id, text: `<@U0RAVI> confirmo ${code}`, at: now - 500 });
    expect(ownerReadExposure(turn)).toEqual({ ok: true, reason: "confirmed" });
  });

  it("asks in a direct chat with someone outside the organization", () => {
    const owner = createContact({
      phone: "5511900000001",
      name: "Owner",
      status: "allowed",
      tags: ["permission-owner"],
    });
    const client = createContact({ phone: "5511988887777", name: "Client", status: "allowed" });
    const clientDm = directChat("D0CLIENT", client.id);

    const exposure = ownerReadExposure({
      actorPrincipal: `contact:${owner.id}`,
      speaker: { kind: "owner", contactId: owner.id },
      conversation: "dm",
      answerChat: { chatId: clientDm.id, kind: "dm" },
    });
    expect(exposure.ok).toBe(false);
  });
});
