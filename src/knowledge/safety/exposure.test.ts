import { describe, expect, it } from "bun:test";

import type { InstanceConfig } from "../../router/router-db.js";
import type { AgentConfig, RouteConfig } from "../../router/types.js";
import {
  agentConfigHasNoExec,
  agentHasNoExec,
  inspectKnowledgeExposure,
  type KnowledgeExposureTrigger,
  triggerTopicCarriesOutsideContent,
} from "./exposure.js";

function agent(id: string, runtimePermissions?: unknown): AgentConfig {
  return { id, cwd: `/agents/${id}`, ...(runtimePermissions ? { defaults: { runtimePermissions } } : {}) };
}

function instance(overrides: Partial<InstanceConfig>): InstanceConfig {
  return {
    name: "wa-main",
    channel: "whatsapp",
    dmPolicy: "closed",
    groupPolicy: "closed",
    contactIntakeMode: "off",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function inspect(input: {
  agents: AgentConfig[];
  instances?: InstanceConfig[];
  routes?: RouteConfig[];
  contacts?: Record<string, { id: string; tags: string[] }>;
  linked?: string[];
  triggers?: KnowledgeExposureTrigger[];
}) {
  return inspectKnowledgeExposure({
    listTriggers: () => input.triggers ?? [],
    defaultAgentId: () => "main",
    listAgents: () => input.agents,
    listInstances: () => input.instances ?? [],
    listRoutes: () => input.routes ?? [],
    contactForPattern: (pattern) => input.contacts?.[pattern] ?? null,
    isLinkedContact: (contactId) => (input.linked ?? []).includes(contactId),
  });
}

const OPEN_DM = instance({ agent: "main", dmPolicy: "open" });

describe("inspectKnowledgeExposure", () => {
  it("counts an enabled trigger on an outside-content topic as reach", () => {
    const report = inspect({
      agents: [agent("main"), agent("ops")],
      triggers: [
        { id: "t-mail", topic: "ravi.inbox.mail.received", enabled: true },
        { id: "t-off", agentId: "ops", topic: "ravi.console.inbox.item", enabled: false },
      ],
    });

    expect(report.offenders).toEqual([
      {
        agentId: "main",
        profile: "bootstrap",
        reasons: [
          "trigger t-mail on ravi.inbox.mail.received can carry outside content",
          "profile bootstrap can read files (bun, cat)",
        ],
      },
    ]);
  });

  it("ignores triggers on internal-only topics", () => {
    const report = inspect({
      agents: [agent("main")],
      triggers: [
        { id: "a", agentId: "main", topic: "ravi.approval.request", enabled: true },
        { id: "b", agentId: "main", topic: "ravi.task.*.event", enabled: true },
        { id: "c", agentId: "main", topic: "ravi.inbox.system.runtime_recovery_exhausted", enabled: true },
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("fails closed on mail, interactions, Console inbox, watches, webhooks, wildcards and custom topics", () => {
    for (const topic of [
      "ravi.inbox.mail.received",
      "ravi.inbound.interaction",
      "ravi.inbound.interaction.slack",
      "ravi.console.inbox.item",
      "ravi.watch.github.push",
      "ravi.webhook.stripe",
      "ravi.>",
      "my.custom.topic",
    ]) {
      expect(triggerTopicCarriesOutsideContent(topic)).toBe(true);
    }
  });

  it("flags an open-DM instance served by a bootstrap agent", () => {
    const report = inspect({ agents: [agent("main")], instances: [OPEN_DM] });

    expect(report.ok).toBe(false);
    expect(report.checkedAgents).toBe(1);
    expect(report.offenders).toEqual([
      {
        agentId: "main",
        profile: "bootstrap",
        reasons: ["instance wa-main admits open DMs", "profile bootstrap can read files (bun, cat)"],
      },
    ]);
  });

  it("accepts the same instance with a chat-only agent", () => {
    expect(inspect({ agents: [agent("main", "chat-only")], instances: [OPEN_DM] }).ok).toBe(true);
  });

  it("accepts explicit-only with the C1 setup capabilities", () => {
    const report = inspect({
      agents: [
        agent("main", {
          profile: "explicit-only",
          capabilities: ["use:tool:Bash", "execute:executable:ravi", "read:knowledge:*", "mutate:knowledge:remember"],
        }),
      ],
      instances: [OPEN_DM],
    });

    expect(report).toEqual({ ok: true, offenders: [], checkedAgents: 1 });
  });

  it("names each explicit capability outside the allowlist", () => {
    for (const capability of ["execute:executable:head", "use:tool:Read", "execute:group:media"]) {
      const report = inspect({
        agents: [agent("main", { profile: "explicit-only", capabilities: ["use:tool:Bash", capability] })],
        instances: [OPEN_DM],
      });

      expect(report.ok).toBe(false);
      expect(report.offenders[0]?.profile).toBe("explicit-only");
      expect(report.offenders[0]?.reasons.join("\n")).toContain(capability);
      expect(report.offenders[0]?.reasons.join("\n")).not.toContain("use:tool:Bash,");
    }
  });

  it("flags full-access", () => {
    const report = inspect({ agents: [agent("main", "full-access")], instances: [OPEN_DM] });

    expect(report.offenders[0]?.reasons).toContain("profile full-access can read files and run any command");
  });

  it("ignores agents nobody outside can reach, and disabled instances", () => {
    const report = inspect({
      agents: [agent("main"), agent("dev")],
      instances: [
        instance({ agent: "main", dmPolicy: "closed", groupPolicy: "closed" }),
        instance({ name: "wa-old", agent: "dev", dmPolicy: "open", enabled: false }),
      ],
      routes: [{ pattern: "group:120363", accountId: "wa-old", agent: "dev" }],
    });

    expect(report).toEqual({ ok: true, offenders: [], checkedAgents: 2 });
  });

  it("treats pairing DMs and open or allowlisted groups as reachable", () => {
    const report = inspect({
      agents: [agent("a"), agent("b")],
      instances: [
        instance({ name: "wa-a", agent: "a", dmPolicy: "pairing" }),
        instance({ name: "wa-b", agent: "b", groupPolicy: "allowlist" }),
      ],
    });

    expect(report.offenders.map((offender) => offender.reasons[0])).toEqual([
      "instance wa-a admits DMs by pairing",
      "instance wa-b admits allowlisted groups",
    ]);
  });

  it("makes an agent reachable through group, wildcard and unknown-contact DM routes", () => {
    const report = inspect({
      agents: [agent("g"), agent("w"), agent("d")],
      routes: [
        { pattern: "group:120363012345678901", accountId: "wa-main", agent: "g" },
        { pattern: "5511*", accountId: "wa-main", agent: "w" },
        { pattern: "5511777777777", accountId: "wa-main", agent: "d" },
      ],
      contacts: { "5511777777777": { id: "c_ana", tags: [] } },
    });

    expect(report.offenders.map((offender) => offender.agentId)).toEqual(["d", "g", "w"]);
    expect(report.offenders[0]?.reasons[0]).toContain("not the owner or linked");
  });

  it("does not count DM routes for the owner or a linked contact", () => {
    const report = inspect({
      agents: [agent("main")],
      routes: [
        { pattern: "5511999999999", accountId: "wa-main", agent: "main" },
        { pattern: "5511888888888", accountId: "wa-main", agent: "main" },
      ],
      contacts: {
        "5511999999999": { id: "c_luis", tags: ["permission-owner"] },
        "5511888888888": { id: "c_bia", tags: [] },
      },
      linked: ["c_bia"],
    });

    expect(report.ok).toBe(true);
  });
});

describe("agentHasNoExec", () => {
  it("is true for chat-only and an empty explicit-only list", () => {
    expect(agentConfigHasNoExec(agent("a", "chat-only"))).toBe(true);
    expect(agentConfigHasNoExec(agent("a", { profile: "explicit-only" }))).toBe(true);
    expect(agentConfigHasNoExec(agent("a", { profile: "explicit-only", capabilities: ["read:knowledge:*"] }))).toBe(
      true,
    );
  });

  it("is false for exec grants, including execute:group:knowledge", () => {
    expect(
      agentConfigHasNoExec(agent("a", { profile: "explicit-only", capabilities: ["execute:group:knowledge"] })),
    ).toBe(false);
    expect(agentConfigHasNoExec(agent("a", { profile: "explicit-only", capabilities: ["use:tool:Bash"] }))).toBe(false);
    expect(agentConfigHasNoExec(agent("a"))).toBe(false);
    expect(agentConfigHasNoExec(agent("a", "full-access"))).toBe(false);
  });

  it("reads the agent by id and is false for an unknown agent", () => {
    const agents: Record<string, AgentConfig> = { calm: agent("calm", "chat-only") };
    const getAgent = (id: string) => agents[id] ?? null;

    expect(agentHasNoExec("calm", { getAgent })).toBe(true);
    expect(agentHasNoExec("ghost", { getAgent })).toBe(false);
  });
});
