import { describe, expect, it } from "bun:test";
import {
  SLACK_DEFAULT_HOME_METADATA_PREFIX,
  SLACK_HOME_VIEW_MAX_BLOCKS,
  buildSlackDefaultHomeView,
  slackAppHomeOpenedFromEnvelope,
} from "./app-home.js";
import type { SlackSocketEnvelope } from "./types.js";

function homeOpened(event: Record<string, unknown>): SlackSocketEnvelope {
  return {
    envelope_id: "Ev-home",
    type: "events_api",
    payload: { type: "event_callback", team_id: "T123", event_id: "Ev-home", event },
  };
}

type Block = Record<string, any>;

function texts(blocks: Block[]): string[] {
  return blocks.flatMap((block) => [
    ...(typeof block.text?.text === "string" ? [block.text.text as string] : []),
    ...((block.elements as Block[] | undefined) ?? []).map((element) => element.text as string),
  ]);
}

describe("slackAppHomeOpenedFromEnvelope", () => {
  it("reads the user, the tab and the metadata of the view the user has now", () => {
    expect(
      slackAppHomeOpenedFromEnvelope(
        homeOpened({
          type: "app_home_opened",
          user: "U123",
          channel: "D123",
          tab: "home",
          view: { id: "V1", type: "home", private_metadata: "ravi.home.default.v1:abc" },
        }),
      ),
    ).toEqual({ userId: "U123", tab: "home", currentPrivateMetadata: "ravi.home.default.v1:abc" });
    expect(
      slackAppHomeOpenedFromEnvelope(homeOpened({ type: "app_home_opened", user: "U123", tab: "messages" })),
    ).toEqual({ userId: "U123", tab: "messages" });
  });

  it("is null for any other envelope or an event without a user", () => {
    expect(slackAppHomeOpenedFromEnvelope(homeOpened({ type: "message", user: "U123", text: "oi" }))).toBeNull();
    expect(slackAppHomeOpenedFromEnvelope(homeOpened({ type: "app_home_opened", tab: "home" }))).toBeNull();
    expect(slackAppHomeOpenedFromEnvelope({ envelope_id: "x", type: "interactive", payload: {} })).toBeNull();
    expect(slackAppHomeOpenedFromEnvelope({ envelope_id: "x", type: "events_api" })).toBeNull();
  });
});

describe("buildSlackDefaultHomeView", () => {
  it("is a Home view inside Slack's limits for an agent with nothing configured", () => {
    const view = buildSlackDefaultHomeView({ agentId: "hana", agentName: "Hana" });
    const blocks = view.blocks as Block[];

    expect(view.type).toBe("home");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThanOrEqual(SLACK_HOME_VIEW_MAX_BLOCKS);
    const blockIds = blocks.map((block) => block.block_id);
    expect(new Set(blockIds).size).toBe(blocks.length);
    expect(blocks[0]).toEqual({
      type: "header",
      block_id: "ravi_home_title",
      text: { type: "plain_text", text: "Hana", emoji: true },
    });
    const all = texts(blocks).join("\n");
    expect(all).toContain("_Este agente ainda não tem descrição._");
    expect(all).toContain("aba *Mensagens*");
    expect(all).toContain("*@Hana*");
    expect(all).toContain("*Nada por aqui ainda*");
    expect(all).toContain("Ravi · agente `hana`");
    expect(view.private_metadata.startsWith(SLACK_DEFAULT_HOME_METADATA_PREFIX)).toBe(true);
  });

  it("shows the directory description escaped, and mentions the bot user when it is known", () => {
    const view = buildSlackDefaultHomeView({
      agentId: "vendas",
      agentName: "Vendas",
      description: "Propostas <!channel> & preços",
      botUserId: "U0BOT",
    });
    const all = texts(view.blocks as Block[]).join("\n");

    expect(all).toContain("Propostas &lt;!channel&gt; &amp; preços");
    expect(all).not.toContain("<!channel>");
    expect(all).toContain("mencione <@U0BOT> na mensagem");
  });

  it("keeps every text within Slack's limits for an oversized name and description", () => {
    const view = buildSlackDefaultHomeView({
      agentId: "a".repeat(400),
      agentName: `${"🦊".repeat(120)} nome`,
      description: "<&>".repeat(400),
      botUserId: "not-a-slack-id",
    });
    const blocks = view.blocks as Block[];
    const header = blocks[0]?.text?.text as string;

    expect(header.length).toBeLessThanOrEqual(150);
    expect(header.endsWith("…")).toBe(true);
    expect(header).not.toContain("�");
    expect(/[\uD800-\uDBFF]…$/.test(header)).toBe(false);
    for (const text of texts(blocks)) expect(text.length).toBeLessThanOrEqual(3000);
    expect(texts(blocks).join("\n")).not.toContain("<@not-a-slack-id>");
    expect(view.private_metadata.length).toBeLessThanOrEqual(3000);
  });

  it("says so when the app is bound to no agent", () => {
    const view = buildSlackDefaultHomeView({ description: "ignored without an agent" });
    const blocks = view.blocks as Block[];

    expect(blocks[0]?.text?.text).toBe("Ravi");
    const all = texts(blocks).join("\n");
    expect(all).toContain("_Este app ainda não está ligado a um agente._");
    expect(all).not.toContain("ignored without an agent");
  });

  it("fingerprints the content, so the same Home is recognized and a changed one is not", () => {
    const first = buildSlackDefaultHomeView({ agentId: "hana", agentName: "Hana", description: "Dev" });
    const same = buildSlackDefaultHomeView({ agentId: "hana", agentName: "Hana", description: "Dev" });
    const changed = buildSlackDefaultHomeView({ agentId: "hana", agentName: "Hana", description: "Dev e produto" });

    expect(same.private_metadata).toBe(first.private_metadata);
    expect(changed.private_metadata).not.toBe(first.private_metadata);
  });
});
