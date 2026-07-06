import { describe, expect, it } from "bun:test";
import type { RuntimeMessageTarget } from "./host-session.js";
import { classifyCompactionAnnouncement } from "./compaction-announcement.js";

const humanSource: RuntimeMessageTarget = {
  channel: "whatsapp",
  accountId: "main",
  chatId: "5511999999999",
  canonicalChatId: "chat_1",
  actorType: "contact",
  identityProvenance: { source: "whatsapp" },
};

describe("classifyCompactionAnnouncement", () => {
  it("allows external announcements for a human/channel turn", () => {
    const result = classifyCompactionAnnouncement({ prompt: {}, source: humanSource });
    expect(result.externalAnnouncementsAllowed).toBe(true);
    expect(result.automationOriginated).toBe(false);
    expect(result.origin).toBe("human");
  });

  it("allows external announcements when there is no signal at all", () => {
    expect(classifyCompactionAnnouncement({}).externalAnnouncementsAllowed).toBe(true);
  });

  it("suppresses announcements for a cron turn even with a reply source", () => {
    const result = classifyCompactionAnnouncement({
      prompt: { _cron: true },
      source: humanSource,
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.automationOriginated).toBe(true);
    expect(result.origin).toBe("cron");
  });

  it("suppresses announcements for a trigger turn even with a reply source", () => {
    const result = classifyCompactionAnnouncement({
      prompt: { _trigger: true },
      source: humanSource,
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.origin).toBe("trigger");
  });

  it("suppresses announcements for a session followup turn with a resolved source", () => {
    const result = classifyCompactionAnnouncement({
      prompt: { _sessionFollowup: true },
      source: humanSource,
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.origin).toBe("session-followup");
  });

  it("suppresses announcements for a heartbeat turn", () => {
    const result = classifyCompactionAnnouncement({
      prompt: { _heartbeat: true },
      source: humanSource,
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.origin).toBe("heartbeat");
  });

  it("suppresses announcements when the resolved source is an automation actor", () => {
    const result = classifyCompactionAnnouncement({
      source: {
        ...humanSource,
        actorType: "automation",
        automationId: "session-followup:cad-1",
      },
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.origin).toBe("automation");
  });

  it("suppresses announcements when identity provenance is an automation source", () => {
    const result = classifyCompactionAnnouncement({
      source: { ...humanSource, identityProvenance: { source: "cron" } },
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.origin).toBe("automation");
  });

  it("suppresses announcements for background sources that set suppressPresence", () => {
    const result = classifyCompactionAnnouncement({
      source: { ...humanSource, suppressPresence: true },
    });
    expect(result.externalAnnouncementsAllowed).toBe(false);
    expect(result.origin).toBe("background");
  });

  it("does not treat a plain human source without automation markers as automation", () => {
    const result = classifyCompactionAnnouncement({
      source: { ...humanSource, actorType: "automation" },
    });
    // actorType=automation without an automationId is not a sufficient signal on its own.
    expect(result.externalAnnouncementsAllowed).toBe(true);
    expect(result.origin).toBe("human");
  });
});
