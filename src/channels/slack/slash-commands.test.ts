import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildSlackCommandEvent,
  isSlackCommandAnsweredInAck,
  parseSlackCommandEvent,
  parseSlackCommandText,
  readSlackCommandPayload,
  SLACK_COMMAND_DEFAULT_IDLE_HOURS,
  SLACK_COMMAND_MAX_TEXT_LENGTH,
  slackCommandAckPayload,
  slackCommandHelpMessage,
  verifySlackCommandOrigin,
} from "./slash-commands.js";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: "legacy-token",
    team_id: "T0TEAM",
    channel_id: "D0CHAT",
    user_id: "U0PERSON",
    user_name: "someone",
    command: "/ravi",
    text: "status",
    api_app_id: "A0APP",
    response_url: "https://hooks.slack.com/commands/T0TEAM/1/secret",
    trigger_id: "13345224609.738474920.8088930838d88f008e0",
    ...overrides,
  };
}

describe("parseSlackCommandText", () => {
  it("reads the subcommands without caring about case", () => {
    expect(parseSlackCommandText("status")).toEqual({ kind: "status" });
    expect(parseSlackCommandText("  THREADS ")).toEqual({ kind: "threads" });
    expect(parseSlackCommandText("stop")).toEqual({ kind: "stop" });
    expect(parseSlackCommandText("")).toEqual({ kind: "help" });
    expect(parseSlackCommandText("HELP")).toEqual({ kind: "help" });
    expect(parseSlackCommandText("?")).toEqual({ kind: "help" });
  });

  it("keeps the case of the thread it is told to close", () => {
    expect(parseSlackCommandText("close Main-T-1795186379128919")).toEqual({
      kind: "close",
      threadRef: "Main-T-1795186379128919",
    });
  });

  it("closes idle threads after 12 hours unless told another number", () => {
    expect(parseSlackCommandText("close idle")).toEqual({
      kind: "close_idle",
      hours: SLACK_COMMAND_DEFAULT_IDLE_HOURS,
    });
    expect(parseSlackCommandText("close idle 6h")).toEqual({ kind: "close_idle", hours: 6 });
    expect(parseSlackCommandText("close idle 48")).toEqual({ kind: "close_idle", hours: 48 });
  });

  it("refuses an hour count that is not one instead of closing everything", () => {
    for (const bad of ["0h", "-3h", "abc", "9999h", "1.5h"]) {
      expect(parseSlackCommandText(`close idle ${bad}`)).toEqual({ kind: "usage", command: "close" });
    }
  });

  it("asks for what to close when nothing is named", () => {
    expect(parseSlackCommandText("close")).toEqual({ kind: "usage", command: "close" });
  });

  it("names a word it does not know, cut short", () => {
    expect(parseSlackCommandText("dance now")).toEqual({ kind: "unknown", word: "dance" });
    const long = parseSlackCommandText(`${"x".repeat(200)} y`);
    expect(long.kind === "unknown" && long.word.length).toBe(40);
  });

  it("does not take the old Portuguese words: the commands are English", () => {
    for (const word of ["ajuda", "fechar", "parar"]) {
      expect(parseSlackCommandText(word).kind).toBe("unknown");
    }
  });

  it("answers help, usage and unknown words in the ack, and nothing else", () => {
    for (const text of ["", "help", "close", "xyz"]) {
      expect(isSlackCommandAnsweredInAck(parseSlackCommandText(text))).toBe(true);
    }
    for (const text of ["status", "threads", "stop", "close t-1", "close idle"]) {
      expect(isSlackCommandAnsweredInAck(parseSlackCommandText(text))).toBe(false);
    }
  });
});

describe("readSlackCommandPayload", () => {
  it("reads only the fields Ravi acts on", () => {
    const read = readSlackCommandPayload(payload());

    expect(read).toEqual({
      teamId: "T0TEAM",
      channelId: "D0CHAT",
      userId: "U0PERSON",
      command: "/ravi",
      text: "status",
      apiAppId: "A0APP",
      triggerId: "13345224609.738474920.8088930838d88f008e0",
      responseUrl: "https://hooks.slack.com/commands/T0TEAM/1/secret",
    });
    expect(JSON.stringify(read)).not.toContain("legacy-token");
    expect(JSON.stringify(read)).not.toContain("someone");
  });

  it("refuses a payload that is not a command", () => {
    expect(readSlackCommandPayload(null)).toBeNull();
    expect(readSlackCommandPayload([])).toBeNull();
    expect(readSlackCommandPayload(payload({ command: "ravi" }))).toBeNull();
    expect(readSlackCommandPayload(payload({ command: "/ravi status" }))).toBeNull();
    expect(readSlackCommandPayload(payload({ user_id: "someone" }))).toBeNull();
    expect(readSlackCommandPayload(payload({ channel_id: "" }))).toBeNull();
    expect(readSlackCommandPayload(payload({ team_id: undefined }))).toBeNull();
  });

  it("cuts a text no subcommand needs", () => {
    const read = readSlackCommandPayload(payload({ text: "x".repeat(SLACK_COMMAND_MAX_TEXT_LENGTH * 3) }));
    expect(read?.text.length).toBe(SLACK_COMMAND_MAX_TEXT_LENGTH);
  });
});

describe("verifySlackCommandOrigin", () => {
  const command = { teamId: "T0TEAM", apiAppId: "A0APP" };

  it("takes a command from this instance's workspace", () => {
    expect(verifySlackCommandOrigin(command, { localTeamId: "T0TEAM" })).toEqual({ ok: true });
  });

  it("refuses a command from another workspace the same socket carries", () => {
    expect(verifySlackCommandOrigin(command, { localTeamId: "T0OTHER" })).toEqual({
      ok: false,
      reason: "team_mismatch",
    });
  });

  it("refuses when it cannot tell its own workspace", () => {
    expect(verifySlackCommandOrigin(command, {})).toEqual({ ok: false, reason: "team_unverified" });
  });

  it("refuses an app other than the one the connection has been seeing", () => {
    expect(verifySlackCommandOrigin(command, { localTeamId: "T0TEAM", pinnedAppId: "A0APP" })).toEqual({ ok: true });
    expect(verifySlackCommandOrigin(command, { localTeamId: "T0TEAM", pinnedAppId: "A0OTHER" })).toEqual({
      ok: false,
      reason: "app_mismatch",
    });
  });
});

describe("the help", () => {
  it("is ephemeral and lists every command under the name it was typed with", () => {
    const help = slackCommandHelpMessage("/hana");

    expect(help.response_type).toBe("ephemeral");
    for (const sub of ["status", "threads", "close <thread>", "close idle", "stop"]) {
      expect(help.text).toContain(`/hana ${sub}`);
    }
    expect(help.text).not.toContain("/ravi");
  });

  it("falls back to /ravi when the typed name is not a command name", () => {
    expect(slackCommandHelpMessage("`; drop").text).toContain("/ravi status");
  });

  it("names the unknown word without letting it break the text", () => {
    expect(slackCommandHelpMessage("/ravi", { unknown: "a`b" }).text).toContain("I don't know `a'b`");
  });

  it("rides in the ack for static subcommands and never for the ones that need the daemon", () => {
    const read = (text: string) => readSlackCommandPayload(payload({ text }))!;

    expect(slackCommandAckPayload(read(""))?.text).toContain("/ravi status");
    expect(slackCommandAckPayload(read("close"))?.text).toContain("Usage:");
    expect(slackCommandAckPayload(read("status"))).toBeUndefined();
    expect(slackCommandAckPayload(read("stop"))).toBeUndefined();
  });
});

describe("the command event", () => {
  const read = readSlackCommandPayload(payload())!;

  it("carries who, where and what, and neither the token nor the response URL", () => {
    const event = buildSlackCommandEvent({
      payload: read,
      accountId: "ravi-slack",
      routeAccountId: "ravi-slack",
      instanceId: "inst-1",
      envelopeId: "env-1",
      responseUrlId: "handle-1",
      ackedWithHelp: false,
      receivedAt: 1_700_000_000_000,
    });

    expect(event).toMatchObject({
      provider: "slack",
      source: "slack.socket_mode",
      teamId: "T0TEAM",
      channelId: "D0CHAT",
      userId: "U0PERSON",
      command: "/ravi",
      text: "status",
      responseUrlId: "handle-1",
      receivedAt: 1_700_000_000_000,
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("legacy-token");
    expect(event.ackedWithHelp).toBeUndefined();
  });

  it("round-trips through the daemon's reader", () => {
    const event = buildSlackCommandEvent({
      payload: read,
      accountId: "ravi-slack",
      routeAccountId: "route-scope",
      instanceId: "inst-1",
      responseUrlId: "handle-1",
      ackedWithHelp: true,
      receivedAt: 5,
    });

    expect(parseSlackCommandEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it("is not trusted by its shape: another provider, a bad id or no time is not a command", () => {
    const good = buildSlackCommandEvent({
      payload: read,
      accountId: "a",
      routeAccountId: "a",
      instanceId: "i",
      ackedWithHelp: false,
      receivedAt: 1,
    });

    expect(parseSlackCommandEvent({ ...good, provider: "discord" })).toBeNull();
    expect(parseSlackCommandEvent({ ...good, source: "somewhere" })).toBeNull();
    expect(parseSlackCommandEvent({ ...good, userId: "someone" })).toBeNull();
    expect(parseSlackCommandEvent({ ...good, command: "ravi" })).toBeNull();
    expect(parseSlackCommandEvent({ ...good, receivedAt: "yesterday" })).toBeNull();
    expect(parseSlackCommandEvent({ ...good, instanceId: "" })).toBeNull();
    expect(parseSlackCommandEvent("nope")).toBeNull();
    expect(parseSlackCommandEvent(null)).toBeNull();
  });

  it("falls back to the account for the route scope an older runner did not send", () => {
    const { routeAccountId: _omitted, ...withoutRoute } = buildSlackCommandEvent({
      payload: read,
      accountId: "acct",
      routeAccountId: "acct",
      instanceId: "i",
      ackedWithHelp: false,
      receivedAt: 1,
    });

    expect(parseSlackCommandEvent(withoutRoute)?.routeAccountId).toBe("acct");
  });
});

describe("the reference manifest in the docs", () => {
  const doc = readFileSync(join(import.meta.dir, "../../../docs/channels/slack.mdx"), "utf8");
  const block = /<Accordion title="Reference manifest">\s*```json\n([\s\S]*?)\n```/.exec(doc)?.[1];

  it("is valid JSON", () => {
    expect(block).toBeDefined();
    expect(() => JSON.parse(block!)).not.toThrow();
  });

  it("registers the command, with the scope it needs, on Socket Mode", () => {
    const manifest = JSON.parse(block!) as {
      features: { slash_commands: Array<{ command: string; usage_hint: string; url?: string }> };
      oauth_config: { scopes: { bot: string[] } };
      settings: { socket_mode_enabled: boolean; interactivity: { is_enabled: boolean } };
    };

    expect(manifest.features.slash_commands.map((entry) => entry.command)).toEqual(["/ravi"]);
    expect(manifest.features.slash_commands[0]?.url).toBeUndefined();
    expect(manifest.oauth_config.scopes.bot).toContain("commands");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
  });

  it("names every subcommand the parser knows in its usage hint", () => {
    const manifest = JSON.parse(block!) as { features: { slash_commands: Array<{ usage_hint: string }> } };
    const hint = manifest.features.slash_commands[0]!.usage_hint;

    for (const word of ["help", "status", "threads", "close", "idle", "stop"]) {
      expect(hint).toContain(word);
      expect(parseSlackCommandText(word === "idle" ? "close idle" : word).kind).not.toBe("unknown");
    }
  });

  it("lists the scope in the table the docs tell operators to follow", () => {
    expect(doc).toContain("| `commands` | The `/ravi` slash command |");
  });
});
