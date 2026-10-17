import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseSessionKey } from "../../router/session-key.js";
import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { buildSessionRelayTurnOrigin } from "../../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { ContactPacket } from "../packet/packet.js";
import { type KnowledgeAudienceDeps, knowledgeAudienceForPrompt, resolveKnowledgeAudience } from "./audience.js";

const OWNER = "c_owner";
const CLIENT = "c_client";
const OWNER_CHAT = "5511900000001@s.whatsapp.net";
const CLIENT_CHAT = "5511900000002@s.whatsapp.net";
const ctx = { agentId: "main", sessionName: "main-dm" };

const packet: ContactPacket = {
  text: "<<<RAVI_CONTACT_MEMORY n1\n- (nothing yet)\nRAVI_CONTACT_MEMORY n1>>>",
  hash: "h",
  itemIds: [],
  sectionIds: [],
  nonce: "n1",
};

function dm(contactId: string, chatId: string, extra: Partial<RuntimeLaunchPrompt> = {}): RuntimeLaunchPrompt {
  return {
    prompt: "[WhatsApp +5511 Name mid:1 16/10/2026, 14:32 fri] oi",
    source: { channel: "whatsapp", accountId: "wa-main", chatId, contactId },
    context: {
      channelId: "whatsapp",
      channelName: "WhatsApp",
      accountId: "wa-main",
      chatId,
      messageId: "1",
      senderId: chatId,
      isGroup: false,
      timestamp: 0,
      contactId,
    },
    ...extra,
  };
}

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-audience-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function deps(overrides: Partial<KnowledgeAudienceDeps> = {}): KnowledgeAudienceDeps {
  return {
    ownerContactIds: () => [OWNER],
    sessionKeyFor: () => "agent:main:whatsapp:dm:5511900000001",
    // The session-key half of readIsPrivateDirectSession (its route and
    // attachment reads are covered in src/link/connector-turn.test.ts).
    isPrivateDirectSession: ({ sessionKey }) => {
      const parsed = sessionKey ? parseSessionKey(sessionKey) : null;
      return parsed?.peerKind === "dm" && parsed.dmScope !== "main";
    },
    dmContact: ({ chatId }) => (chatId === OWNER_CHAT ? OWNER : chatId === CLIENT_CHAT ? CLIENT : null),
    cronOwner: (jobId) =>
      jobId === "mine"
        ? { found: true, ownerPrincipal: "operator" }
        : jobId === "legacy"
          ? { found: true, ownerPrincipal: null }
          : jobId === "theirs"
            ? { found: true, ownerPrincipal: `contact:${CLIENT}` }
            : { found: false, ownerPrincipal: null },
    packet: () => {
      throw new Error("packet must not be built");
    },
    isLinkedOwner: () => true,
    isOperatorSession: () => true,
    ...overrides,
  };
}

describe("knowledgeAudienceForPrompt", () => {
  it("gives operator for the owner's DM in a private per-peer session", () => {
    expect(knowledgeAudienceForPrompt(dm(OWNER, OWNER_CHAT), ctx, deps())).toBe("operator");
  });

  it("gives none for the owner's DM when the owner is not linked to this login", () => {
    expect(knowledgeAudienceForPrompt(dm(OWNER, OWNER_CHAT), ctx, deps({ isLinkedOwner: () => false }))).toBe("none");
  });

  it("gives none for the operator's CLI relay into a session that is not theirs alone", () => {
    const cli: RuntimeLaunchPrompt = { prompt: "oi", _cliDestination: true };
    expect(knowledgeAudienceForPrompt(cli, ctx, deps())).toBe("operator");
    expect(knowledgeAudienceForPrompt(cli, ctx, deps({ isOperatorSession: () => false }))).toBe("none");
  });

  it("gives none for the owner's DM in a dmScope main session other contacts share", () => {
    expect(
      knowledgeAudienceForPrompt(dm(OWNER, OWNER_CHAT), ctx, deps({ sessionKeyFor: () => "agent:main:main" })),
    ).toBe("none");
  });

  it("gives none for the owner in a group", () => {
    const prompt = dm(OWNER, "120363000000000001@g.us");
    prompt.context = { ...prompt.context!, isGroup: true };
    expect(
      knowledgeAudienceForPrompt(
        prompt,
        ctx,
        deps({ sessionKeyFor: () => "agent:main:whatsapp:wa-main:group:120363000000000001" }),
      ),
    ).toBe("none");
  });

  it("treats a chat whose session key is a group as a group even without context", () => {
    const prompt: RuntimeLaunchPrompt = {
      prompt: "oi",
      source: { channel: "whatsapp", accountId: "wa-main", chatId: OWNER_CHAT, contactId: OWNER },
    };
    expect(
      knowledgeAudienceForPrompt(
        prompt,
        ctx,
        deps({ sessionKeyFor: () => "agent:main:whatsapp:wa-main:group:120363000000000001" }),
      ),
    ).toBe("none");
  });

  it("gives none for heartbeat and trigger turns, even with the owner's chat as source", () => {
    expect(knowledgeAudienceForPrompt({ prompt: "check", _heartbeat: true }, ctx, deps())).toBe("none");
    expect(knowledgeAudienceForPrompt(dm(OWNER, OWNER_CHAT, { _heartbeat: true }), ctx, deps())).toBe("none");
    expect(knowledgeAudienceForPrompt({ prompt: "event", _trigger: true, _triggerId: "t1" }, ctx, deps())).toBe("none");
    expect(knowledgeAudienceForPrompt(dm(OWNER, OWNER_CHAT, { _trigger: true }), ctx, deps())).toBe("none");
  });

  it("gives none for a turn with no chat and no operator marker", () => {
    expect(knowledgeAudienceForPrompt({ prompt: "hello" }, ctx, deps())).toBe("none");
  });

  it("gives operator for the CLI and the operator's own relay, none for a relay from another session", () => {
    expect(knowledgeAudienceForPrompt({ prompt: "q", _cliDestination: true }, ctx, deps())).toBe("operator");
    const relay = buildSessionRelayTurnOrigin("send");
    expect(knowledgeAudienceForPrompt({ prompt: "q", _turnOrigin: relay }, ctx, deps())).toBe("operator");
    const fromSession = buildSessionRelayTurnOrigin("send", { agentId: "dev", sessionName: "dev-main" });
    expect(knowledgeAudienceForPrompt({ prompt: "q", _turnOrigin: fromSession }, ctx, deps())).toBe("none");
    // The operator's relay answering into someone else's chat.
    expect(
      knowledgeAudienceForPrompt(
        { prompt: "q", _turnOrigin: relay, source: { channel: "whatsapp", accountId: "wa-main", chatId: CLIENT_CHAT } },
        ctx,
        deps(),
      ),
    ).toBe("none");
  });

  it("gives operator only for the operator's own cron", () => {
    expect(knowledgeAudienceForPrompt({ prompt: "r", _cron: true, _jobId: "mine" }, ctx, deps())).toBe("operator");
    expect(knowledgeAudienceForPrompt({ prompt: "r", _cron: true, _jobId: "legacy" }, ctx, deps())).toBe("operator");
    expect(knowledgeAudienceForPrompt({ prompt: "r", _cron: true, _jobId: "theirs" }, ctx, deps())).toBe("none");
    expect(knowledgeAudienceForPrompt({ prompt: "r", _cron: true, _jobId: "gone" }, ctx, deps())).toBe("none");
    expect(
      knowledgeAudienceForPrompt(
        {
          prompt: "r",
          _cron: true,
          _jobId: "mine",
          source: { channel: "whatsapp", accountId: "wa-main", chatId: CLIENT_CHAT },
        },
        ctx,
        deps(),
      ),
    ).toBe("none");
  });

  it("gives contact with the packet for a non-owner DM when a packet is built, else none", () => {
    const calls: unknown[] = [];
    const result = resolveKnowledgeAudience(
      dm(CLIENT, CLIENT_CHAT),
      ctx,
      deps({
        packet: (input) => {
          calls.push(input);
          return packet;
        },
      }),
    );
    expect(result).toEqual({ audience: "contact", packet });
    expect(calls).toEqual([
      {
        agentId: "main",
        sessionName: "main-dm",
        source: dm(CLIENT, CLIENT_CHAT).source,
        messageText: dm(CLIENT, CLIENT_CHAT).prompt,
      },
    ]);

    expect(knowledgeAudienceForPrompt(dm(CLIENT, CLIENT_CHAT), ctx, deps({ packet: () => null }))).toBe("none");
  });

  it("fails closed to none when a lookup throws", () => {
    expect(
      knowledgeAudienceForPrompt(
        dm(OWNER, OWNER_CHAT),
        ctx,
        deps({
          ownerContactIds: () => {
            throw new Error("db down");
          },
        }),
      ),
    ).toBe("none");
  });
});
