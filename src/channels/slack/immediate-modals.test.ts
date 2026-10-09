import { describe, expect, it } from "bun:test";
import {
  buildSlackImmediateModalView,
  matchSlackImmediateModalRule,
  parseSlackImmediateModalRules,
  type SlackImmediateModalRule,
} from "./immediate-modals.js";

const modalView = {
  type: "modal",
  callback_id: "workflow_submit",
  title: { type: "plain_text", text: "Novo pedido" },
  blocks: [],
};

const rule: SlackImmediateModalRule = { actionId: "workflow_open", blockId: "workflow_actions", view: modalView };

describe("parseSlackImmediateModalRules", () => {
  it("returns no rules for an empty setting", () => {
    expect(parseSlackImmediateModalRules(null)).toEqual([]);
    expect(parseSlackImmediateModalRules("  ")).toEqual([]);
  });

  it("parses valid rules and trims ids", () => {
    expect(parseSlackImmediateModalRules(JSON.stringify([{ actionId: " workflow_open ", view: modalView }]))).toEqual([
      { actionId: "workflow_open", view: modalView },
    ]);
  });

  it("rejects invalid rules with a precise message", () => {
    expect(() => parseSlackImmediateModalRules("{")).toThrow("must be a JSON array");
    expect(() => parseSlackImmediateModalRules("{}")).toThrow("must be a JSON array");
    expect(() => parseSlackImmediateModalRules(JSON.stringify([{ view: modalView }]))).toThrow(
      "[0] requires actionId or blockId",
    );
    expect(() => parseSlackImmediateModalRules(JSON.stringify([{ callbackId: "x", view: modalView }]))).toThrow(
      "requires actionId or blockId",
    );
    expect(() => parseSlackImmediateModalRules(JSON.stringify([{ actionId: 1, view: modalView }]))).toThrow(
      "[0].actionId must be a non-empty string",
    );
    expect(() =>
      parseSlackImmediateModalRules(JSON.stringify([{ actionId: "a", view: { type: "home", blocks: [] } }])),
    ).toThrow("[0].view must be a Slack modal view");
    const { title: _title, ...untitled } = modalView;
    for (const view of [
      untitled,
      { ...modalView, title: "Novo pedido" },
      { ...modalView, title: { type: "mrkdwn", text: "Novo pedido" } },
      { ...modalView, title: { type: "plain_text", text: "  " } },
      { ...modalView, title: { type: "plain_text", text: "x".repeat(25) } },
    ]) {
      expect(() => parseSlackImmediateModalRules(JSON.stringify([{ actionId: "a", view }]))).toThrow(
        "[0].view.title must be a plain_text object with 1-24 characters",
      );
    }
  });
});

describe("matchSlackImmediateModalRule", () => {
  const interaction = {
    interactionType: "block_actions",
    triggerId: "trigger-1",
    accountId: "acct-1",
    actionId: "workflow_open",
    blockId: "workflow_actions",
  };

  it("requires every configured field to match", () => {
    expect(matchSlackImmediateModalRule([rule], interaction)).toBe(rule);
    expect(matchSlackImmediateModalRule([rule], { ...interaction, blockId: "other" })).toBeUndefined();
    expect(matchSlackImmediateModalRule([{ ...rule, accountId: "acct-2" }], interaction)).toBeUndefined();
    expect(matchSlackImmediateModalRule([{ ...rule, callbackId: "cb" }], interaction)).toBeUndefined();
    expect(
      matchSlackImmediateModalRule([{ ...rule, callbackId: "cb" }], { ...interaction, viewCallbackId: "cb" }),
    ).toBeDefined();
  });

  it("only matches block_actions that carry a trigger id", () => {
    expect(
      matchSlackImmediateModalRule([rule], { ...interaction, interactionType: "view_submission" }),
    ).toBeUndefined();
    expect(matchSlackImmediateModalRule([rule], { ...interaction, triggerId: undefined })).toBeUndefined();
  });
});

describe("buildSlackImmediateModalView", () => {
  it("fills private_metadata with the click context without mutating the rule", () => {
    const view = buildSlackImmediateModalView(rule, {
      accountId: "acct-1",
      channelId: "C123",
      messageTs: "1713000000.000100",
      userId: "U123",
      actionId: "workflow_open",
      value: "req-42",
    });
    expect(JSON.parse(view.private_metadata as string)).toEqual({
      source: "ravi.slack.immediate_modal",
      accountId: "acct-1",
      channelId: "C123",
      messageTs: "1713000000.000100",
      userId: "U123",
      actionId: "workflow_open",
      value: "req-42",
    });
    expect(rule.view.private_metadata).toBeUndefined();
  });

  it("keeps configured private_metadata and drops an oversized value", () => {
    expect(
      buildSlackImmediateModalView({ ...rule, view: { ...modalView, private_metadata: "fixed" } }, {}).private_metadata,
    ).toBe("fixed");
    const metadata = JSON.parse(
      buildSlackImmediateModalView(rule, { channelId: "C123", value: "x".repeat(4000) }).private_metadata as string,
    );
    expect(metadata).toEqual({ source: "ravi.slack.immediate_modal", channelId: "C123" });
  });
});
