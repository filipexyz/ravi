import { describe, expect, it } from "bun:test";
import { resolveSkillPolicy, SkillPolicyError, type SkillCatalogEntry, type SkillPolicyInput } from "./skill-policy.js";

function entry(id: string, requirements: SkillCatalogEntry["requirements"] = { kind: "none" }): SkillCatalogEntry {
  return {
    id,
    aliases: [id.split(":").at(-1) ?? id],
    name: id,
    resource: { path: `/skills/${id}/SKILL.md` },
    requirements,
  };
}

function input(overrides: Partial<SkillPolicyInput> = {}): SkillPolicyInput {
  return {
    scope: { agentId: "restricted", executionId: "run-1", contextKey: "context-1" },
    revisions: { policy: "1", catalog: "catalog-1", permissions: "permissions-1", toolSurface: "surface-1" },
    catalog: [],
    selection: { baseline: [], fromCapabilities: [], fromGrants: [], local: [] },
    capabilityState: { available: [], authorized: [] },
    ...overrides,
  };
}

describe("resolveSkillPolicy", () => {
  it("does not expose unselected catalog skills or open an empty selection", () => {
    const result = resolveSkillPolicy(input({ catalog: [entry("system:one")] }));
    expect(result.status).toBe("empty");
    expect(result.skills).toEqual([]);
  });

  it("admits explicitly independent baseline and local skills", () => {
    const result = resolveSkillPolicy(
      input({
        catalog: [entry("system:baseline"), entry("personal:local"), entry("personal:other")],
        selection: { baseline: ["baseline"], fromCapabilities: [], fromGrants: [], local: ["personal:local"] },
      }),
    );
    expect(result.skills.map((skill) => skill.id)).toEqual(["personal:local", "system:baseline"]);
    expect(result.provenance["personal:local"]).toEqual(["local"]);
    expect(result.provenance["system:baseline"]).toEqual(["baseline"]);
  });

  it("coalesces canonical IDs and aliases without counting them as separate skills", () => {
    const skill = { ...entry("system:read"), aliases: ["read", "system-read"] };
    const result = resolveSkillPolicy(
      input({
        catalog: [skill, skill],
        selection: { baseline: ["read"], fromCapabilities: ["system-read"], fromGrants: ["system:read"], local: [] },
      }),
    );
    expect(result.skills.map((value) => value.id)).toEqual(["system:read"]);
    expect(result.provenance["system:read"]).toEqual(["baseline", "capability", "grant"]);
  });

  for (const fixture of [
    { name: "missing authorization", available: ["fs.read"], authorized: [], code: "unauthorized-capability" },
    { name: "missing availability", available: [], authorized: ["fs.read"], code: "unavailable-capability" },
  ]) {
    it(`does not let a grant bypass ${fixture.name}`, () => {
      const result = resolveSkillPolicy(
        input({
          catalog: [entry("system:reader", { kind: "any-of", alternatives: [["fs.read"]] })],
          selection: { baseline: [], fromCapabilities: [], fromGrants: ["system:reader"], local: [] },
          capabilityState: { available: fixture.available, authorized: fixture.authorized },
        }),
      );
      expect(result.skills).toEqual([]);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === fixture.code)).toBe(true);
    });
  }

  it("requires every capability in an AND clause even for baseline", () => {
    const result = resolveSkillPolicy(
      input({
        catalog: [entry("system:both", { kind: "any-of", alternatives: [["fs.read", "exec.shell"]] })],
        selection: { baseline: ["system:both"], fromCapabilities: [], fromGrants: [], local: [] },
        capabilityState: { available: ["fs.read", "exec.shell"], authorized: ["fs.read"] },
      }),
    );
    expect(result.skills).toEqual([]);
  });

  it("allows an OR alternative whose entire clause is available and authorized", () => {
    const result = resolveSkillPolicy(
      input({
        catalog: [
          entry("system:either", { kind: "any-of", alternatives: [["fs.read", "exec.shell"], ["ravi.docs.read"]] }),
        ],
        selection: { baseline: [], fromCapabilities: ["system:either"], fromGrants: [], local: [] },
        capabilityState: { available: ["fs.read", "ravi.docs.read"], authorized: ["ravi.docs.read"] },
      }),
    );
    expect(result.skills.map((skill) => skill.id)).toEqual(["system:either"]);
  });

  it("does not treat absent requirements as tool independence", () => {
    const missing = entry("legacy:missing");
    const { requirements: _requirements, ...unclassified } = missing;
    const result = resolveSkillPolicy(
      input({
        catalog: [unclassified],
        selection: { baseline: [], fromCapabilities: [], fromGrants: ["legacy:missing"], local: [] },
      }),
    );
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toContainEqual({ skillId: "legacy:missing", code: "missing-requirements" });
  });

  it("rejects two identities sharing an alias even when one was requested canonically", () => {
    const result = resolveSkillPolicy(
      input({
        catalog: [entry("one:shared"), entry("two:shared")],
        selection: { baseline: ["one:shared"], fromCapabilities: [], fromGrants: ["shared"], local: [] },
      }),
    );
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "ambiguous-identity").length).toBe(2);
  });

  it("rejects conflicting records for the same canonical identity", () => {
    const first = entry("system:one");
    const result = resolveSkillPolicy(
      input({
        catalog: [first, { ...first, description: "different metadata" }],
        selection: { baseline: ["system:one"], fromCapabilities: [], fromGrants: [], local: [] },
      }),
    );
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "ambiguous-identity")).toBe(true);
  });

  it("diagnoses stale grants instead of inventing catalog entries", () => {
    const result = resolveSkillPolicy(
      input({
        selection: { baseline: [], fromCapabilities: [], fromGrants: ["removed:skill"], local: [] },
      }),
    );
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toContainEqual({ skillId: "removed:skill", code: "unknown-selection" });
  });

  it("throws an identified error for unresolved scope or revisions", () => {
    expect(() => resolveSkillPolicy(input({ scope: { agentId: "", executionId: "run", contextKey: "ctx" } }))).toThrow(
      SkillPolicyError,
    );
    expect(() =>
      resolveSkillPolicy(input({ revisions: { policy: "1", catalog: "", permissions: "1", toolSurface: "1" } })),
    ).toThrow("RAVI_SKILL_POLICY_RESOLUTION_ERROR");
  });

  it("keeps snapshot identity independent of catalog and selection ordering", () => {
    const first = input({
      catalog: [entry("system:one"), entry("system:two")],
      selection: { baseline: ["one", "two"], fromCapabilities: [], fromGrants: [], local: [] },
    });
    const second = input({
      ...first,
      catalog: [...first.catalog].reverse(),
      selection: { ...first.selection, baseline: ["two", "one"] },
    });
    expect(resolveSkillPolicy(first).id).toBe(resolveSkillPolicy(second).id);
  });

  it("binds a snapshot to scope and all relevant revisions", () => {
    const first = resolveSkillPolicy(input());
    const otherScope = resolveSkillPolicy(
      input({ scope: { agentId: "other", executionId: "run-1", contextKey: "context-1" } }),
    );
    const otherRevision = resolveSkillPolicy(
      input({
        revisions: { policy: "2", catalog: "catalog-1", permissions: "permissions-1", toolSurface: "surface-1" },
      }),
    );
    expect(first.id).not.toBe(otherScope.id);
    expect(first.id).not.toBe(otherRevision.id);
  });

  it("copies and freezes exposed metadata so later caller changes cannot widen it", () => {
    const aliases = ["one"];
    const files = [{ path: "SKILL.md", content: "original" }];
    const source = { ...entry("system:one"), aliases, resource: { path: "/skills/one/SKILL.md", files } };
    const result = resolveSkillPolicy(
      input({ catalog: [source], selection: { baseline: ["one"], fromCapabilities: [], fromGrants: [], local: [] } }),
    );
    aliases.push("unrelated");
    files[0].content = "changed";
    expect(result.skills[0]?.aliases).toEqual(["one"]);
    expect(result.skills[0]?.resource.files?.[0]?.content).toBe("original");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.skills[0]?.resource.files?.[0])).toBe(true);
  });
});
