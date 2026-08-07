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

  it("does not render raw channel ids as group members", () => {
    const context = buildGroupContext({
      channelId: "whatsapp-baileys",
      channelName: "WhatsApp",
      isGroup: true,
      groupName: "Ravi - Dev",
      groupMembers: ["Luis", "122054447747088", "178035101794451@lid", "Ravi Bot"],
    });

    expect(context).toContain("Group members (2): Luis, Ravi Bot.");
    expect(context).not.toContain("122054447747088");
    expect(context).not.toContain("178035101794451@lid");
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
      "session.attach",
      "session.actions",
      "automation.background_followups",
      "session.runtime",
      "session.boundary",
      "channel.output_formatting",
      "channel.thread_workspaces",
      "channel.reactions",
      "extra.extra.context",
    ]);

    const prompt = renderPromptSections(sections);
    expect(prompt.startsWith("## Identidade\n\nVocê é Ravi.")).toBe(true);
    expect(prompt).toContain("## Extra Context\n\nInjected context text.");
    expect(prompt).toContain("ravi sessions unmute");
    expect(prompt).toContain("ravi sessions actions --json");
    expect(prompt).toContain("ravi sessions delete-message <message-id> --execute");
    expect(prompt).toContain('ravi sessions edit-message <message-id> "novo texto" --execute');
    expect(prompt).toContain("## Background Followup Automation");
    expect(prompt).toContain('ravi cron add "<name>" --at "<ISO time>"');
    expect(prompt).toContain("Do this in the background without announcing it in your visible response.");
    expect(prompt).toContain("Inactivity / silence-based follow-up");
    expect(prompt).toContain("`ravi sessions followups`");
    expect(prompt).toContain("## WhatsApp Thread Workspaces");
    expect(prompt).toContain("sugira proativamente criar um agent e um grupo dedicados");
    expect(prompt).toContain('ravi whatsapp group create "<nome>" --agent <agent>');
    expect(prompt).toContain('ravi whatsapp group create "<nome>" --agent <agent> --create-agent');
    expect(prompt).toContain("Não use `ravi whatsapp group list` para descobrir grupo recém-criado");
    expect(prompt).toContain("O CLI infere a sessão pelo contexto de execução do agent.");
    expect(prompt).toContain("Leia os campos `promptHint` e `usage.tools` retornados por `actions --json`");
    expect(prompt).toContain("apagar ou editar suas próprias mensagens, reagir, enviar mídia, enviar stickers");
    expect(prompt).not.toContain("ravi sessions focus");
    expect(prompt).not.toContain("focus_chat");
    expect(prompt).not.toContain('"id"');
    expect(prompt).not.toContain('"priority"');
  });

  it("keeps proactive agent/group suggestions scoped to WhatsApp prompts", () => {
    const prompt = buildSystemPrompt("main", {
      channelId: "matrix",
      channelName: "Matrix",
      isGroup: false,
    });

    expect(prompt).not.toContain("## WhatsApp Thread Workspaces");
    expect(prompt).not.toContain("sugira proativamente criar um agent e um grupo dedicados");
    expect(prompt).not.toContain("Não use `ravi whatsapp group list`");
  });

  it("does not instruct sentinel agents to create background follow-up cron jobs", () => {
    const prompt = buildSystemPrompt(
      "observer",
      {
        channelId: "whatsapp-baileys",
        channelName: "WhatsApp",
        isGroup: false,
      },
      undefined,
      "observer",
      { agentMode: "sentinel" },
    );

    expect(prompt).not.toContain("## Background Followup Automation");
    expect(prompt).not.toContain("ravi cron add");
    expect(prompt).toContain("ravi whatsapp dm read <contact> --account $RAVI_ACCOUNT_ID --no-ack");
    expect(prompt).toContain("ravi whatsapp dm ack <contact> <messageId> --account $RAVI_ACCOUNT_ID --execute");
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
    expect(prompt).toContain("ravi sessions read --json");
    expect(prompt).toContain("Never recover missing context from another DM/group/session");
  });

  describe("proactive scheduling prompt", () => {
    function activePrompt(): string {
      return buildSystemPrompt("main", {
        channelId: "whatsapp-baileys",
        channelName: "WhatsApp",
        isGroup: false,
      });
    }

    it("contains the decision checklist for cron creation", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("Decision checklist");
      expect(prompt).toContain("create a background cron only when ALL of these are true");
      expect(prompt).toContain("concrete next step");
      expect(prompt).toContain("time-based or recurring");
      expect(prompt).toContain("concrete schedule");
      expect(prompt).toContain("sufficient permission and context");
      expect(prompt).toContain("Expected noise is low");
      expect(prompt).toContain("real operational risk if forgotten");
    });

    it("includes one-shot cron creation syntax with --delete-after", () => {
      const prompt = activePrompt();
      expect(prompt).toContain('ravi cron add "<name>" --at "<ISO time>" --message "<prompt>" --delete-after');
    });

    it("includes interval and calendar cron syntax for concrete recurring schedules", () => {
      const prompt = activePrompt();
      expect(prompt).toContain('ravi cron add "<name>" --every <duration> --message "<prompt>"');
      expect(prompt).toContain('ravi cron add "<name>" --cron "<expr>" --message "<prompt>" --tz "<timezone>"');
    });

    it("rejects vague reminders explicitly", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("vague");
      expect(prompt).toContain('"check on this later"');
      expect(prompt).toContain('"follow up sometime"');
    });

    it("rejects duplicate and noisy cron jobs", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("duplicate cron already covers the same check");
      expect(prompt).toContain("fire frequently without clear value");
    });

    it("routes inactivity follow-up to ravi sessions followups, not cron", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("Inactivity / silence-based follow-up");
      expect(prompt).toContain("`ravi sessions followups`");
      expect(prompt).toContain("not cron");
    });

    it("routes deterministic shell work to cron --shell with error-only notification", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("`ravi cron add --shell`");
      expect(prompt).toContain("error-only notification");
    });

    it("routes recurring policy behavior to routine/spec, not long cron prompt", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("routine/spec, cron references it");
      expect(prompt).toContain("routine/spec, not a long cron prompt");
    });

    it("instructs agents to inspect created cron via ravi cron show <id>", () => {
      const prompt = activePrompt();
      expect(prompt).toContain("`ravi cron show <id>`");
      expect(prompt).toContain("verify agent, account, session/reply-session, schedule, and delete-after");
    });

    it("preserves sentinel exclusion from background followup automation", () => {
      const prompt = buildSystemPrompt(
        "observer",
        {
          channelId: "whatsapp-baileys",
          channelName: "WhatsApp",
          isGroup: false,
        },
        undefined,
        "observer",
        { agentMode: "sentinel" },
      );

      expect(prompt).not.toContain("## Background Followup Automation");
      expect(prompt).not.toContain("Decision checklist");
      expect(prompt).not.toContain("ravi cron add");
    });
  });

  it("does not render mentioned contact metadata into the system prompt", () => {
    const context = {
      channelId: "whatsapp-baileys",
      channelName: "WhatsApp",
      isGroup: true,
      groupName: "Projeto",
      mentionedContactsContext: [
        {
          displayName: "Thiago Freire",
          summaryLines: [
            "No CRM, aparece com lifecycle active, relacionamento good.",
            "Próxima ação no CRM: alinhar arquitetura.",
          ],
        },
      ],
    };

    const prompt = buildSystemPrompt("main", context);
    expect(prompt).not.toContain("## Pessoas Mencionadas");
    expect(prompt).not.toContain("Nota privada de identidade");
    expect(prompt).not.toContain("Thiago Freire");
    expect(prompt).not.toContain("No CRM, aparece com lifecycle active");
    expect(prompt).not.toContain('"summaryLines"');
  });
});
