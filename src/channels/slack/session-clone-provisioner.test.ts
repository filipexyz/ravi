import { describe, expect, it } from "bun:test";

import { SessionCloneError } from "../../sessions/clone.js";
import { createSlackSessionCloneProvisioner } from "./session-clone-provisioner.js";

const INPUT = {
  name: "pesquisa",
  agentId: "main",
  origin: { channel: "slack", accountId: "ravi-slack", chatId: "D0C8BEV8QUR" },
  inviteActorIds: ["U0BAA2B1LTS", "not-a-slack-user"],
};

function created(route: Record<string, unknown>, invite?: Record<string, unknown>) {
  return { item: { id: "C0NEW" }, route, ...(invite ? { invite } : {}) };
}

describe("the Slack clone provisioner", () => {
  it("creates a private channel routed to the same agent, invites only Slack users, and names the session", async () => {
    const calls: unknown[] = [];
    const provisioner = createSlackSessionCloneProvisioner({
      channelsCreate: async (input) => {
        calls.push(input);
        return created({ status: "created", accountId: "ravi-slack-acct" }, { status: "invited" });
      },
      sessionKeyFor: ({ chatId, routeAccountId }) => `agent:main:slack:${routeAccountId}:group:${chatId}`,
    });
    const result = await provisioner.provision(INPUT);
    expect(calls).toEqual([{ name: "pesquisa", raviChannel: "ravi-slack", inviteCsv: "U0BAA2B1LTS", agentId: "main" }]);
    expect(result).toEqual({
      chatId: "C0NEW",
      sessionKey: "agent:main:slack:ravi-slack-acct:group:C0NEW",
      source: { channel: "slack", accountId: "ravi-slack", chatId: "C0NEW" },
      invited: 1,
      inviteFailed: false,
    });
  });

  it("reports a failed invite without failing the clone", async () => {
    const provisioner = createSlackSessionCloneProvisioner({
      channelsCreate: async () => created({ status: "created", accountId: "a" }, { status: "failed" }),
      sessionKeyFor: () => "k",
    });
    expect(await provisioner.provision(INPUT)).toMatchObject({ invited: 0, inviteFailed: true });
  });

  it("refuses a channel it could not route: no clone without a route to the agent", async () => {
    const provisioner = createSlackSessionCloneProvisioner({
      channelsCreate: async () => created({ status: "failed", reason: "db locked" }),
      sessionKeyFor: () => "k",
    });
    await expect(provisioner.provision(INPUT)).rejects.toThrow(SessionCloneError);
    await expect(provisioner.provision(INPUT)).rejects.toThrow(/C0NEW.*not routed.*db locked/);
  });

  it("refuses when Slack returns no channel id or the router cannot see the route", async () => {
    const noId = createSlackSessionCloneProvisioner({
      channelsCreate: async () => ({ route: { status: "created", accountId: "a" } }),
      sessionKeyFor: () => "k",
    });
    await expect(noId.provision(INPUT)).rejects.toThrow(/channel id/);
    const unseen = createSlackSessionCloneProvisioner({
      channelsCreate: async () => created({ status: "created", accountId: "a" }),
      sessionKeyFor: () => null,
    });
    await expect(unseen.provision(INPUT)).rejects.toThrow(/not visible/);
  });
});
