import { describe, expect, it } from "bun:test";
import {
  buildGroupContext,
  buildSystemPrompt,
  buildSystemPromptSections,
  renderPromptSections,
  type PromptContextSection,
} from "./prompt-builder.js";

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
  it("uses typed sections internally but renders plain Markdown text", () => {
    const sections = buildSystemPromptSections(
      "main",
      {
        channelId: "whatsapp-baileys",
        channelName: "WhatsApp",
        isGroup: false,
      },
      [{ title: "Extra Context", content: "Injected context text." }],
      "dev",
    );

    expect(sections.map((section) => section.id)).toEqual([
      "identity",
      "system.commands",
      "session.runtime",
      "session.boundary",
      "channel.output_formatting",
      "channel.reactions",
      "extra.extra.context",
    ]);

    const prompt = renderPromptSections(sections);
    expect(prompt.startsWith("## Identidade\n\nVocê é Ravi.")).toBe(true);
    expect(prompt).toContain("## Extra Context\n\nInjected context text.");
    expect(prompt).not.toContain('"id"');
    expect(prompt).not.toContain('"priority"');
  });

  it("keeps unprioritized legacy sections after typed sections when rendering mixed inputs", () => {
    const typedSection: PromptContextSection = {
      id: "runtime",
      title: "Runtime",
      content: "Runtime rules.",
      priority: 50,
      source: "test",
    };
    const prompt = renderPromptSections([typedSection, { title: "Legacy Extra", content: "Legacy plugin text." }]);

    expect(prompt).toMatch(/^## Runtime[\s\S]+## Legacy Extra/);
  });

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
