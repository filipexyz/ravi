import { describe, expect, it } from "bun:test";

import { getCommandAccessMetadata } from "../../cli/decorators.js";
import { slackCommandChannel } from "./slash-command-handler.js";
import { renderSlackCommandResult } from "./slash-command-render.js";
import { slackCommandHelpMessage } from "./slash-commands.js";

describe("/ravi clone in Slack", () => {
  it("asks a person what the CLI asks for `sessions clone`: a confirmed, mutating command", async () => {
    const { SessionCommands } = await import("../../cli/commands/sessions.js");
    const access = getCommandAccessMetadata(SessionCommands).get("clone");
    expect(access).toMatchObject({ kind: "mutate", resource: "sessions", action: "clone", requiresConfirmation: true });
    const channel = slackCommandChannel({
      accountId: "ravi-slack",
      instanceId: "ravi-slack",
      channelId: "D0C8BEV8QUR",
      userId: "U0BAA2B1LTS",
      text: "clone x",
      receivedAt: 1,
      command: "/ravi",
      surface: "command",
    } as Parameters<typeof slackCommandChannel>[0]);
    const declared = await channel.cloneAccess?.();
    expect(declared?.group).toBe("sessions");
    expect(declared?.command).toBe("clone");
    expect(declared?.access).toBe(access as NonNullable<typeof access>);
    expect(typeof channel.clone).toBe("function");
  });

  it("says where the clone went and that it goes on by itself", () => {
    const message = renderSlackCommandResult(
      {
        kind: "cloned",
        sessionName: "main",
        cloneName: "pesquisa",
        chatId: "C0NEW",
        messages: 12,
        redacted: true,
        inviteFailed: true,
      },
      "/ravi",
    );
    expect(message.text).toContain("<#C0NEW>");
    expect(message.text).toContain("`pesquisa`");
    expect(message.text).toContain("12 messages");
    expect(message.text).toContain("secrets masked");
    expect(message.text).toContain("join the channel yourself");
  });

  it("words the refusals a person can fix", () => {
    const invalid = renderSlackCommandResult(
      { kind: "clone_refused", code: "CLONE_NAME_INVALID", message: "" },
      "/ravi",
    );
    expect(invalid.text).toContain("/ravi clone pesquisa-voz");
    const taken = renderSlackCommandResult({ kind: "clone_refused", code: "CLONE_NAME_TAKEN", message: "" }, "/ravi");
    expect(taken.text).toContain("already exists");
    const denied = renderSlackCommandResult({ kind: "not_authorized_command", operation: "clone" }, "/ravi");
    expect(denied.text).toContain("clone sessions");
  });

  it("lists clone in the help and explains its usage", () => {
    expect(slackCommandHelpMessage("/ravi").text).toContain("/ravi clone <name>");
    expect(slackCommandHelpMessage("/ravi", { usage: "clone" }).text).toContain("Usage: `/ravi clone <name>`");
  });
});
