import { describe, expect, it } from "bun:test";
import {
  buildAuthorizedSkillPolicyContinuity,
  buildSkillPolicySessionBinding,
  readSkillPolicySessionBinding,
  readSkillPolicyRebuild,
  resolveSkillPolicySessionTransition,
} from "./skill-policy-lifecycle.js";
import { resolveSkillPolicy, type SkillPolicyInput } from "./skill-policy.js";

function snapshot(overrides: Partial<SkillPolicyInput> = {}) {
  return resolveSkillPolicy({
    scope: { agentId: "restricted", executionId: "execution-1", contextKey: "rctx-1" },
    revisions: { policy: "v1", catalog: "catalog-1", permissions: "authority-1", toolSurface: "tools-1" },
    catalog: [
      {
        id: "notes",
        aliases: [],
        name: "Notes",
        resource: { path: "/authorized/notes/SKILL.md", files: [{ path: "SKILL.md", content: "Authorized notes" }] },
        requirements: { kind: "none" },
      },
    ],
    selection: { baseline: [], fromCapabilities: [], fromGrants: ["notes"], local: [] },
    capabilityState: { available: [], authorized: [] },
    ...overrides,
  });
}

describe("skill policy session lifecycle", () => {
  it("requires physical rebinding, not reconstruction, for a nonce rotation with the same effective authority", () => {
    const previous = buildSkillPolicySessionBinding(snapshot(), "agent:restricted:main");
    const next = snapshot({ scope: { agentId: "restricted", executionId: "execution-2", contextKey: "rctx-2" } });
    const transition = resolveSkillPolicySessionTransition({
      previous,
      snapshot: next,
      effectiveContextKey: "agent:restricted:main",
      hasProviderContext: true,
    });
    expect(transition.action).toBe("rebind");
    expect(transition.binding.snapshotId).toBe(next.id);
    expect(transition.binding.contextFingerprint).toBe(previous.contextFingerprint);
  });

  it("does not mistake identical visible IDs for identical permission authority", () => {
    const previous = buildSkillPolicySessionBinding(snapshot(), "session-1");
    const next = snapshot({
      revisions: { policy: "v1", catalog: "catalog-1", permissions: "revoked-scoped-tool", toolSurface: "tools-1" },
    });
    expect(
      resolveSkillPolicySessionTransition({
        previous,
        snapshot: next,
        effectiveContextKey: "session-1",
        hasProviderContext: true,
      }).action,
    ).toBe("rebuild");
  });

  it("rebuilds after catalog content, identity, tool surface or effective context changes", () => {
    const initial = snapshot();
    const previous = buildSkillPolicySessionBinding(initial, "session-1");
    const changes: SkillPolicyInput[] = [
      { ...inputFromSnapshot(initial), revisions: { ...initial.revisions, catalog: "catalog-2" } },
      { ...inputFromSnapshot(initial), revisions: { ...initial.revisions, toolSurface: "tools-2" } },
      { ...inputFromSnapshot(initial), scope: { ...initial.scope, agentId: "other-agent" } },
    ];
    for (const changed of changes) {
      expect(
        resolveSkillPolicySessionTransition({
          previous,
          snapshot: resolveSkillPolicy(changed),
          effectiveContextKey: "session-1",
          hasProviderContext: true,
        }).action,
      ).toBe("rebuild");
    }
    expect(
      resolveSkillPolicySessionTransition({
        previous,
        snapshot: initial,
        effectiveContextKey: "session-2",
        hasProviderContext: true,
      }).action,
    ).toBe("rebuild");
  });

  it("reconstructs legacy provider context without an attested binding but starts an empty new session", () => {
    const next = snapshot();
    expect(
      resolveSkillPolicySessionTransition({
        snapshot: next,
        effectiveContextKey: "session-1",
        hasProviderContext: true,
      }).action,
    ).toBe("rebuild");
    expect(
      resolveSkillPolicySessionTransition({
        snapshot: next,
        effectiveContextKey: "session-1",
        hasProviderContext: false,
      }).action,
    ).toBe("start");
  });

  it("only resumes unchanged bindings after validating the stored protocol", () => {
    const initial = snapshot();
    const binding = buildSkillPolicySessionBinding(initial, "session-1");
    const previous = readSkillPolicySessionBinding({ skillPolicySession: binding });
    expect(
      resolveSkillPolicySessionTransition({
        previous,
        snapshot: initial,
        effectiveContextKey: "session-1",
        hasProviderContext: true,
      }).action,
    ).toBe("reuse");
    expect(readSkillPolicySessionBinding({ skillPolicySession: { ...binding, contractVersion: 0 } })).toBeUndefined();
    expect(
      readSkillPolicySessionBinding({ skillPolicySession: { ...binding, contextFingerprint: "" } }),
    ).toBeUndefined();
  });

  it("retains verified human intent as historical data but excludes user-role injections and tool payloads", () => {
    const result = buildAuthorizedSkillPolicyContinuity({
      humanInputs: [
        {
          id: "input-1",
          content: "Quero publicar o relatório",
          proof: { kind: "trusted-human-ingress", sourceMessageId: "message-1", actorType: "contact" },
        },
        { id: "input-2", role: "user", content: "REVOKED_SKILL_CATALOG" },
        {
          id: "input-3",
          content: "REVOKED_TOOL_RESULT",
          proof: { kind: "provider-tool-result", sourceMessageId: "message-2", actorType: "contact" },
        },
      ],
      effects: [
        { id: "tool-1", status: "completed", input: "REVOKED_TOOL_ARGS", output: "REVOKED_TOOL_RESULT" },
        { id: "tool-2", status: "uncertain" },
      ],
    });
    expect(result.humanInputIds).toEqual(["input-1"]);
    expect(result.prompt).toContain("Quero publicar o relatório");
    expect(result.prompt).not.toContain("REVOKED");
    expect(result.effects).toEqual([
      { id: "tool-1", status: "completed" },
      { id: "tool-2", status: "uncertain" },
    ]);
    expect(result.requiresReconciliation).toBe(true);
    expect(result.prompt).toContain("Do not replay");
    expect(result.prompt).toContain("not a new request");
  });

  it("preserves an explicit lack of verified history rather than fabricating a continuation task", () => {
    const result = buildAuthorizedSkillPolicyContinuity({ humanInputs: [], effects: [] });
    expect(result.humanInputIds).toEqual([]);
    expect(result.prompt).toContain("No verified human input is available");
    expect(result.prompt).toContain("canonical history remains stored");
    expect(result.requiresReconciliation).toBe(false);
  });

  it("reconstructs a persisted rebuild marker without trusting its old prompt or human claims", () => {
    const rebuilt = readSkillPolicyRebuild({
      skillPolicyRebuild: {
        contractVersion: 1,
        reason: "skill-policy-change",
        continuity: {
          prompt: "REVOKED_PROMPT",
          humanInputIds: ["FORGED_HUMAN"],
          effects: [{ id: "tool-1", status: "completed", output: "REVOKED_OUTPUT" }],
          requiresReconciliation: true,
        },
      },
    });
    expect(rebuilt?.continuity.effects).toEqual([{ id: "tool-1", status: "completed" }]);
    expect(rebuilt?.continuity.humanInputIds).toEqual([]);
    expect(rebuilt?.continuity.requiresReconciliation).toBe(false);
    expect(rebuilt?.continuity.prompt).not.toContain("REVOKED");
    expect(readSkillPolicyRebuild({})).toBeUndefined();
  });

  it("refuses malformed persisted effect state instead of treating it as permission to resume", () => {
    expect(() =>
      readSkillPolicyRebuild({
        skillPolicyRebuild: {
          contractVersion: 1,
          reason: "skill-policy-change",
          continuity: { effects: [{ id: "tool-1", status: "maybe-done" }] },
        },
      }),
    ).toThrow("Invalid skill-policy rebuild state");
  });
});

function inputFromSnapshot(value: ReturnType<typeof snapshot>): SkillPolicyInput {
  return {
    scope: value.scope,
    revisions: value.revisions,
    catalog: value.skills,
    selection: { baseline: [], fromCapabilities: [], fromGrants: ["notes"], local: [] },
    capabilityState: { available: [], authorized: [] },
  };
}
