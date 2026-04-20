import { describe, expect, it } from "bun:test";
import { buildGroupContext, buildSystemPrompt } from "./prompt-builder.js";

describe("buildGroupContext", () => {
  it("does not render undefined or unknown when group metadata is partial", () => {
    const context = buildGroupContext({
      channelId: "whatsapp-baileys",
      channelName: "WhatsApp",
      isGroup: true,
    });

    expect(context).toContain('You are replying inside the WhatsApp group "current group".');
    expect(context).toContain("Group member list is not available for this group yet.");
    expect(context).not.toContain('"undefined"');
    expect(context).not.toContain("unknown");
  });

  it("renders group name and members when they are available", () => {
    const context = buildGroupContext({
      channelId: "whatsapp-baileys",
      channelName: "WhatsApp",
      isGroup: true,
      groupName: "Ravi - Dev",
      groupMembers: ["Luis", "Rafa", "Ravi"],
    });

    expect(context).toContain('You are replying inside the WhatsApp group "Ravi - Dev".');
    expect(context).toContain("Group members (3): Luis, Rafa, Ravi.");
  });
});

describe("buildSystemPrompt", () => {
  it("instructs agents to recover missing context only from the current session", () => {
    const prompt = buildSystemPrompt(
      "main",
      {
        channelId: "whatsapp-baileys",
        channelName: "WhatsApp",
        isGroup: false,
      },
      undefined,
      "main-dm-615153",
    );

    expect(prompt).toContain("## Session Boundary");
    expect(prompt).toContain("current session (main-dm-615153)");
    expect(prompt).toContain("ravi sessions read main-dm-615153");
    expect(prompt).toContain("Never recover missing context from another DM/group/session");
  });
});
