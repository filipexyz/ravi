import { describe, expect, it } from "bun:test";
import { pickWhatsAppAccount, whatsappAccountsHint } from "./whatsapp-account.js";

const slack = { name: "ravi-slack", channel: "slack", enabled: true };
const main = { name: "main", channel: "whatsapp", instanceId: "inst-main", enabled: true };
const luis = { name: "luis", channel: "whatsapp", instanceId: "inst-luis", enabled: true };

const slackTurn = { channel: "slack", accountId: "ravi-slack" };
const whatsappTurn = { channel: "whatsapp", accountId: "luis" };

describe("pickWhatsAppAccount", () => {
  // Incident 2026-11-24: `ravi whatsapp group info <jid>` from a Slack turn failed with
  // `No omni instance mapped for account "ravi-slack"` because the account of the turn was used as WhatsApp account.
  it("does not use the account of a Slack turn as WhatsApp account", () => {
    expect(pickWhatsAppAccount({ source: slackTurn, instances: [slack, main] })).toEqual({
      ok: true,
      accountId: "main",
      via: "single-account",
    });
  });

  it("does not pick a non-WhatsApp instance just because it is the first one", () => {
    expect(pickWhatsAppAccount({ instances: [slack, main] })).toMatchObject({ ok: true, accountId: "main" });
  });

  it("uses the account of the turn when the turn comes from WhatsApp", () => {
    expect(pickWhatsAppAccount({ source: whatsappTurn, instances: [main, luis, slack] })).toEqual({
      ok: true,
      accountId: "luis",
      via: "turn",
    });
  });

  it("lets --account win over the turn and over inference", () => {
    expect(pickWhatsAppAccount({ account: "main", source: whatsappTurn, instances: [main, luis] })).toEqual({
      ok: true,
      accountId: "main",
      via: "flag",
    });
  });

  it("rejects --account naming a non-WhatsApp account and lists the WhatsApp ones", () => {
    const result = pickWhatsAppAccount({ account: "ravi-slack", source: slackTurn, instances: [slack, main, luis] });

    expect(result).toMatchObject({ ok: false, code: "ACCOUNT_NOT_WHATSAPP", candidates: ["main", "luis"] });
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain('"ravi-slack" is a slack account');
    expect(result.message).toContain("main, luis");
    expect(result.message).toContain("--account");
  });

  it("keeps an unknown --account as given (it may be an omni instance id)", () => {
    expect(pickWhatsAppAccount({ account: "9b1d5d3e-0000-4000-8000-000000000000", instances: [main] })).toMatchObject({
      ok: true,
      via: "flag",
    });
  });

  // The Omni consumer publishes a WhatsApp turn with the Omni channel type (`whatsapp-baileys`) as source channel,
  // while instances are stored as `whatsapp`.
  it("treats a turn published as whatsapp-baileys as a WhatsApp turn and uses its own account", () => {
    expect(
      pickWhatsAppAccount({
        source: { channel: "whatsapp-baileys", accountId: "luis" },
        instances: [slack, main, luis],
      }),
    ).toEqual({ ok: true, accountId: "luis", via: "turn" });
  });

  it("treats instances stored as whatsapp-baileys as WhatsApp accounts", () => {
    const baileys = { name: "legacy", channel: "whatsapp-baileys", enabled: true };

    expect(pickWhatsAppAccount({ source: slackTurn, instances: [slack, baileys] })).toMatchObject({
      ok: true,
      accountId: "legacy",
      via: "single-account",
    });
    expect(pickWhatsAppAccount({ account: "legacy", instances: [slack, baileys] })).toMatchObject({ ok: true });
  });

  it("does not treat twilio-whatsapp as a WhatsApp group account", () => {
    const twilio = { name: "twilio", channel: "twilio-whatsapp", enabled: true };

    expect(pickWhatsAppAccount({ source: slackTurn, instances: [twilio, main] })).toMatchObject({
      ok: true,
      accountId: "main",
    });
    expect(pickWhatsAppAccount({ account: "twilio", instances: [twilio, main] })).toMatchObject({
      ok: false,
      code: "ACCOUNT_NOT_WHATSAPP",
    });
  });

  it("asks for --account when a non-WhatsApp turn cannot tell which of several WhatsApp accounts to use", () => {
    const result = pickWhatsAppAccount({ source: slackTurn, instances: [slack, main, luis] });

    expect(result).toMatchObject({ ok: false, code: "AMBIGUOUS_WHATSAPP_ACCOUNT", candidates: ["main", "luis"] });
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("comes from slack");
    expect(result.message).toContain("main, luis");
    expect(result.message).toContain("Pass --account <id>");
  });

  it("keeps taking the first WhatsApp account when there is no turn at all (terminal, cron, script)", () => {
    expect(pickWhatsAppAccount({ instances: [slack, main, luis] })).toEqual({
      ok: true,
      accountId: "main",
      via: "first-account",
    });
  });

  it("fails clearly when there is no WhatsApp account", () => {
    expect(pickWhatsAppAccount({ source: slackTurn, instances: [slack] })).toEqual({
      ok: false,
      code: "NO_WHATSAPP_ACCOUNT",
      message: "No WhatsApp account configured.",
      candidates: [],
    });
  });

  it("ignores disabled and deleted WhatsApp instances", () => {
    const disabled = { ...luis, enabled: false };
    const deleted = { ...luis, name: "old", deletedAt: 1 };

    expect(pickWhatsAppAccount({ source: slackTurn, instances: [slack, main, disabled, deleted] })).toMatchObject({
      ok: true,
      accountId: "main",
      via: "single-account",
    });
  });

  it("treats an instance without an explicit enabled flag as enabled", () => {
    expect(
      pickWhatsAppAccount({ source: slackTurn, instances: [{ name: "main", channel: "whatsapp" }] }),
    ).toMatchObject({ ok: true, accountId: "main" });
  });
});

describe("whatsappAccountsHint", () => {
  it("names the WhatsApp accounts to pass", () => {
    expect(whatsappAccountsHint([slack, main, luis])).toBe(" WhatsApp accounts: main, luis. Pass --account <id>.");
  });

  it("is empty when there is nothing to suggest", () => {
    expect(whatsappAccountsHint([slack])).toBe("");
  });
});
