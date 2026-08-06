import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { observerRefreshReturnSchema } from "./operational-return-schemas.js";

// Spread the real modules into the mocks so every named export stays defined:
// bun mocks are process-global, and other test files in the same run import
// symbols (e.g. resolveObserverProfile) this file does not stub.
const actualRouterModule = await import("../../router/index.js");
const actualObservationPlaneModule = await import("../../runtime/observation-plane.js");
const actualObservationProfilesModule = await import("../../runtime/observation-profiles.js");

const deleteRuleCalls: string[] = [];
const setEnabledCalls: Array<{ id: string; enabled: boolean }> = [];

const sampleSession = { sessionKey: "agent:main:main", name: "main", agentId: "main" };

const sampleRule = {
  id: "rule-review",
  enabled: true,
  scope: "global",
  priority: 100,
  observerRole: "review",
  observerAgentId: "observer",
  observerRuntimeProviderId: null,
  observerModel: null,
  observerProfileId: null,
  observerMode: "observe",
  eventTypes: ["message.user"],
  deliveryPolicy: "end_of_turn",
  debounceMs: null,
  sourceAgentId: null,
  sourceSession: null,
  sourceTaskId: null,
  sourceProfileId: null,
  sourceProjectId: null,
  tagTargetType: null,
  tagSlug: null,
  tagInherited: false,
  permissionGrants: [],
  selector: null,
  metadata: null,
  createdAt: 1,
  updatedAt: 1,
};

const sampleBinding = {
  id: "bind-1",
  sourceSessionKey: "agent:main:main",
  sourceSessionName: "main",
  sourceAgentId: "main",
  observerSessionName: "obs:main:review",
  observerAgentId: "observer",
  observerRuntimeProviderId: null,
  observerModel: null,
  observerProfileId: null,
  observerProfileVersion: null,
  observerProfileSource: null,
  observerRole: "review",
  observerMode: "observe",
  ruleId: "rule-review",
  eventTypes: ["message.user"],
  deliveryPolicy: "end_of_turn",
  permissionGrants: [],
  selector: null,
  metadata: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  lastDeliveredAt: null,
};

const sampleProfile = {
  id: "tasks",
  version: "1",
  label: "Tasks",
  description: "Task status renderer",
  sourceKind: "system",
  source: "system",
  profilePath: "/tmp/profiles/tasks/PROFILE.md",
  profileDir: "/tmp/profiles/tasks",
  defaults: { deliveryPolicy: "end_of_turn", mode: "observe", eventTypes: ["message.user"] },
  templates: { delivery: {}, events: {} },
  body: "# Tasks profile",
};

mock.module("../../router/index.js", () => ({
  ...actualRouterModule,
  getSession: (key: string) => (key === sampleSession.sessionKey ? sampleSession : null),
  getSessionByName: (name: string) => (name === sampleSession.name ? sampleSession : null),
}));

mock.module("../../runtime/observation-plane.js", () => ({
  ...actualObservationPlaneModule,
  dbDeleteObserverRule: (id: string) => {
    deleteRuleCalls.push(id);
    return true;
  },
  dbGetObserverBinding: (id: string) => (id === sampleBinding.id ? sampleBinding : null),
  dbGetObserverRule: (id: string) => (id === sampleRule.id ? sampleRule : null),
  dbListObserverBindings: () => [sampleBinding],
  dbListObserverRules: () => [sampleRule],
  dbSetObserverRuleEnabled: (id: string, enabled: boolean) => {
    setEnabledCalls.push({ id, enabled });
    return { ...sampleRule, enabled };
  },
  dbUpsertObserverRule: (input: Record<string, unknown>) => ({ ...sampleRule, ...input }),
  explainObserverRulesForSession: (sessionName: string) =>
    sessionName === sampleSession.name
      ? {
          source: { sessionName: "main", agentId: "main", tags: [] },
          rules: [],
          bindings: [],
        }
      : { source: null, rules: [], bindings: [] },
  reconcileObserverBindingsForSession: () => ({
    source: { sessionName: "main", agentId: "main" },
    bindings: [sampleBinding],
    created: [],
    disabled: [],
    refreshedProfiles: [],
    mode: "attach-missing",
    skipped: [],
  }),
  validateObserverRules: () => ({ ok: true, errors: [] }),
}));

mock.module("../../runtime/observation-profiles.js", () => ({
  ...actualObservationProfilesModule,
  initObserverProfile: () => ({
    sourceKind: "workspace",
    profileDir: "/tmp/profiles/new",
    profilePath: "/tmp/profiles/new/PROFILE.md",
  }),
  listObserverProfiles: () => [sampleProfile],
  previewObserverProfile: (profileId: string) => {
    if (profileId !== sampleProfile.id) {
      throw new Error(`Unknown observer profile: ${profileId}. Available profiles: tasks.`);
    }
    return { profile: sampleProfile, eventType: "message.user", eventMarkdown: "md", prompt: "prompt" };
  },
  validateObserverProfiles: () => ({ ok: true, errors: [], profiles: [] }),
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { ObserverCommands, ObserverProfileCommands, ObserverRuleCommands } = await import("./observers.js");
const { ContractError } = await import("../agent-contract.js");

afterAll(() => mock.restore());

function capture<T>(run: () => T): { thrown: unknown; logs: string[] } {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  } finally {
    console.log = originalLog;
  }
  return { thrown, logs };
}

describe("observer refresh return contract", () => {
  const basePayload = {
    source: {},
    total: 1,
    created: [{}],
    bindings: [{}],
    skipped: [],
  };

  it("requires and validates reconciliation result fields", () => {
    expect(
      observerRefreshReturnSchema.safeParse({
        ...basePayload,
        mode: "refresh-profile",
        disabled: [],
        refreshedProfiles: [{}],
      }).success,
    ).toBe(true);
    expect(observerRefreshReturnSchema.safeParse(basePayload).success).toBe(false);
    expect(
      observerRefreshReturnSchema.safeParse({
        ...basePayload,
        mode: "future-only",
        disabled: [],
        refreshedProfiles: [],
      }).success,
    ).toBe(false);
    expect(
      observerRefreshReturnSchema.safeParse({
        ...basePayload,
        source: null,
        mode: "attach-missing",
        disabled: [],
        refreshedProfiles: [],
      }).success,
    ).toBe(true);
  });
});

describe("observers agent-first contract", () => {
  beforeEach(() => {
    deleteRuleCalls.length = 0;
    setEnabledCalls.length = 0;
  });

  it("blocks observers rules rm without --execute (dry-run, exit 3, no delete)", () => {
    const commands = new ObserverRuleCommands();
    const { thrown } = capture(() => commands.rm("rule-review", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("observers rules rm");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    expect((envelope.error.plan as Record<string, unknown>).id).toBe("rule-review");
    expect(deleteRuleCalls).toHaveLength(0);
  });

  it("deletes the rule with --execute", () => {
    const commands = new ObserverRuleCommands();
    const { thrown } = capture(() => commands.rm("rule-review", true, true));
    expect(thrown).toBeUndefined();
    expect(deleteRuleCalls).toEqual(["rule-review"]);
  });

  it("emits OBSERVER_NOT_FOUND with suggestions on rules rm before the brake (exit 1)", () => {
    const commands = new ObserverRuleCommands();
    const { thrown } = capture(() => commands.rm("rule-nope", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("observers rules rm");
    expect(envelope.error.code).toBe("OBSERVER_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("rule-review");
    expect(deleteRuleCalls).toHaveLength(0);
  });

  it("emits OBSERVER_NOT_FOUND on rules enable for unknown ids without writing", () => {
    const commands = new ObserverRuleCommands();
    const { thrown } = capture(() => commands.enable("rule-nope", true));
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as InstanceType<typeof ContractError>).exitCode).toBe(1);
    expect(setEnabledCalls).toHaveLength(0);
  });

  it("emits OBSERVER_NOT_FOUND with binding suggestions on observers show (exit 1)", () => {
    const commands = new ObserverCommands();
    const { thrown } = capture(() => commands.show("bind-nope", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("observers show");
    expect(envelope.error.code).toBe("OBSERVER_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("bind-1");
  });

  it("emits OBSERVER_NOT_FOUND with profile suggestions on profiles show (exit 1)", () => {
    const commands = new ObserverProfileCommands();
    const { thrown } = capture(() => commands.show("nope", true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.error.code).toBe("OBSERVER_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("tasks");
  });

  it("maps unknown profile throws from preview to OBSERVER_NOT_FOUND (exit 1)", () => {
    const commands = new ObserverProfileCommands();
    const { thrown } = capture(() => commands.preview("nope", undefined, true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    expect(contractError.envelope().error.code).toBe("OBSERVER_NOT_FOUND");
  });

  it("emits SESSION_NOT_FOUND without suggestions on refresh (exit 1)", () => {
    const commands = new ObserverCommands();
    const { thrown } = capture(() => commands.refresh("ghost-session", undefined, true));
    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("observers refresh");
    expect(envelope.error.code).toBe("SESSION_NOT_FOUND");
    expect(envelope.error.suggestions).toBeUndefined();
  });

  it("supports --fields compact mode on observers list", () => {
    const commands = new ObserverCommands();
    const { logs } = capture(() => commands.list(undefined, undefined, true, undefined, undefined, "id"));
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0])).toEqual(["id"]);
  });

  it("supports --fields compact mode on observers rules list", () => {
    const commands = new ObserverRuleCommands();
    const { logs } = capture(() => commands.list(true, undefined, undefined, "id,enabled"));
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0]).sort()).toEqual(["enabled", "id"]);
  });

  it("supports --fields compact mode on observers profiles list", () => {
    const commands = new ObserverProfileCommands();
    const { logs } = capture(() => commands.list(true, undefined, undefined, "id"));
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0])).toEqual(["id"]);
  });
});
