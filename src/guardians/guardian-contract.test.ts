import { describe, expect, it } from "bun:test";
import {
  AGENT_CONTEXT_GUARDIANS_DEFAULTS_KEY,
  AgentContextGuardiansConfigSchema,
  type AgentContextGuardiansConfig,
  readAgentContextGuardiansConfig,
  writeAgentContextGuardiansConfig,
} from "./contract.js";

describe("AgentContextGuardiansConfigSchema", () => {
  const validConfig: AgentContextGuardiansConfig = {
    agentId: "dev",
    guardians: [
      {
        id: "work-execution",
        agentId: "dev",
        objective: "Keep work execution moving with low-noise escalation",
        stableContractRef: "wish:context-guardian-agents/work-execution",
        contextTarget: {
          agentId: "dev",
          scope: "work_execution",
          surfaces: ["tasks", "sessions"],
        },
        escalationPolicy: {
          targetSession: "agent:main:main",
          notifyOn: ["front_switch_without_closure", "follow_up_overdue", "priority_drift"],
          minimumSeverity: "medium",
        },
        enabled: true,
      },
    ],
    recurringTasks: [
      {
        id: "work-execution-loop",
        guardianId: "work-execution",
        agentId: "dev",
        title: "Review work execution drift",
        instruction: "Inspect active work, detect drift, and escalate only when actionable.",
        trigger: {
          kind: "schedule",
          schedule: {
            type: "every",
            every: 30 * 60 * 1000,
          },
          enabled: true,
        },
        execution: {
          agentId: "dev",
          sessionTarget: "task",
        },
        state: {
          status: "active",
          runCount: 0,
        },
        lastOutput: {
          outcome: "alert",
          summary: "Follow-up is overdue on the current front.",
          detectedDrifts: ["follow_up_overdue"],
          alertMessage: "Current work front is stalled and needs a follow-up.",
          iterationContractRef: "iteration:guardian/work-execution/2026-04-10T12:00:00Z",
          recordedAt: 1_744_289_200_000,
        },
      },
    ],
  };

  it("accepts the minimum work_execution contract at agent level", () => {
    const parsed = AgentContextGuardiansConfigSchema.parse(validConfig);
    expect(parsed.guardians).toHaveLength(1);
    expect(parsed.recurringTasks).toHaveLength(1);
    expect(parsed.recurringTasks[0]?.trigger.schedule.type).toBe("every");
  });

  it("rejects recurring tasks that reference a missing guardian", () => {
    const broken = {
      ...validConfig,
      recurringTasks: [{ ...validConfig.recurringTasks[0], guardianId: "missing" }],
    };

    expect(() => AgentContextGuardiansConfigSchema.parse(broken)).toThrow(
      "recurring task must reference an existing guardian",
    );
  });

  it("rejects alert outputs without actionable drift evidence", () => {
    const broken = {
      ...validConfig,
      recurringTasks: [
        {
          ...validConfig.recurringTasks[0],
          lastOutput: {
            outcome: "alert",
            summary: "Something feels wrong.",
            detectedDrifts: [],
            recordedAt: 1_744_289_200_000,
          },
        },
      ],
    };

    expect(() => AgentContextGuardiansConfigSchema.parse(broken)).toThrow(
      "alert output must include at least one detected drift",
    );
  });

  it("round-trips through agent defaults under the canonical key", () => {
    const defaults = writeAgentContextGuardiansConfig({}, validConfig);
    expect(defaults[AGENT_CONTEXT_GUARDIANS_DEFAULTS_KEY]).toBeDefined();

    const parsed = readAgentContextGuardiansConfig(defaults, "dev");
    expect(parsed?.agentId).toBe("dev");
    expect(parsed?.guardians[0]?.contextTarget.scope).toBe("work_execution");
  });
});
