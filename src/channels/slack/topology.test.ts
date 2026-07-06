import { describe, expect, it } from "bun:test";
import type { RouterConfig } from "../../router/index.js";
import { buildSlackTopology } from "./topology.js";

describe("Slack topology", () => {
  it("reports Slack channels with Ravi route/session metadata without modeling sidebar sections", () => {
    const topology = buildSlackTopology({
      accountId: "ravi-rbbt-slack",
      routerConfig: routerConfig(),
      channels: [
        {
          id: "C1",
          name: "ravi-hil",
          created: 1783210000,
          creator: "U1",
          is_channel: true,
          is_member: true,
          is_private: false,
          num_members: 2,
        },
        {
          id: "C2",
          name: "ravi-dev",
          is_channel: true,
          is_member: true,
          is_private: false,
        },
      ],
    });

    expect(topology.channels.find((channel) => channel.id === "C1")).toMatchObject({
      id: "C1",
      name: "ravi-hil",
      ravi: {
        matched: true,
        accountId: "ravi-rbbt-slack",
        agentId: "ravi-hil",
        routePattern: "group:C1",
        routeSession: "ravi-hil",
        policyGate: {
          inboundAllowed: true,
          reason: "explicit_route",
          explicitRoute: true,
          effectivePolicy: "open",
        },
      },
    });
    expect(topology.channels.find((channel) => channel.id === "C2")).toMatchObject({
      id: "C2",
      ravi: {
        matched: true,
        agentId: "main",
        policyGate: {
          inboundAllowed: true,
          reason: "group_open",
          explicitRoute: false,
          effectivePolicy: "open",
        },
      },
    });
    expect(topology.ungroupedChannelIds).toEqual(["C1", "C2"]);
    expect(topology.capabilities).toEqual({});
  });

  it("reports policy admission separately from route fallback", () => {
    const topology = buildSlackTopology({
      accountId: "ravi-rbbt-slack",
      routerConfig: {
        ...routerConfig(),
        instances: {
          "ravi-rbbt-slack": {
            name: "ravi-rbbt-slack",
            channel: "slack",
            dmPolicy: "closed",
            groupPolicy: "allowlist",
            contactIntakeMode: "pending",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      },
      channels: [
        { id: "C1", name: "explicit", is_channel: true },
        { id: "C2", name: "fallback", is_channel: true },
      ],
      getContactStatus: ({ peerId }) => (peerId === "C2" ? "pending" : undefined),
    });

    expect(topology.channels.find((channel) => channel.id === "C1")?.ravi.policyGate).toMatchObject({
      inboundAllowed: true,
      reason: "explicit_route",
      explicitRoute: true,
      effectivePolicy: "allowlist",
      instancePolicy: "allowlist",
    });
    expect(topology.channels.find((channel) => channel.id === "C2")?.ravi.policyGate).toMatchObject({
      inboundAllowed: false,
      reason: "group_allowlist_pending",
      explicitRoute: false,
      effectivePolicy: "allowlist",
      instancePolicy: "allowlist",
      contactStatus: "pending",
    });
  });
});

function routerConfig(): RouterConfig {
  return {
    agents: {
      main: { id: "main", cwd: "/tmp/main" },
      "ravi-hil": { id: "ravi-hil", cwd: "/tmp/ravi-hil" },
    },
    routes: [
      {
        pattern: "group:C1",
        accountId: "ravi-rbbt-slack",
        channel: "slack",
        agent: "ravi-hil",
        session: "ravi-hil",
        priority: 10,
      },
    ],
    defaultAgent: "main",
    defaultDmScope: "per-account-channel-peer",
    accountAgents: {
      "ravi-rbbt-slack": "main",
    },
    instanceToAccount: {},
    instances: {},
  };
}
