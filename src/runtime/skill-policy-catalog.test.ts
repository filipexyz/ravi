import { describe, expect, it } from "bun:test";
import { buildSkillPolicyCatalog, type SkillPolicyCatalogSource } from "./skill-policy-catalog.js";

function source(metadata?: string): SkillPolicyCatalogSource {
  return {
    name: "reader",
    description: "Read project documentation",
    pluginName: "ravi-system",
    path: "/plugins/ravi-system/skills/reader",
    skillFilePath: "/plugins/ravi-system/skills/reader/SKILL.md",
    content: `---\nname: reader\n${metadata === undefined ? "" : `ravi.requires: ${metadata}\n`}---\nPrivate skill content`,
    source: "plugin:ravi-system",
  };
}

describe("buildSkillPolicyCatalog", () => {
  it("parses explicit independence and resolves canonical identity with compatibility aliases", () => {
    const result = buildSkillPolicyCatalog([source('{"kind":"none"}')]);
    expect(result.entries[0]?.id).toBe("ravi-system:reader");
    expect(result.entries[0]?.aliases).toContain("ravi-system-reader");
    expect(result.entries[0]?.aliases).toContain("reader");
    expect(result.entries[0]?.requirements).toEqual({ kind: "none" });
  });

  it("preserves AND and OR requirements as canonical capability IDs", () => {
    const result = buildSkillPolicyCatalog([
      source('{"kind":"any-of","alternatives":[["fs.read","exec.shell"],["ravi.docs.read"]]}'),
    ]);
    expect(result.entries[0]?.requirements).toEqual({
      kind: "any-of",
      alternatives: [["exec.shell", "fs.read"], ["ravi.docs.read"]],
    });
  });

  it("keeps missing metadata unclassified with a diagnostic", () => {
    const result = buildSkillPolicyCatalog([source()]);
    expect(result.entries[0]?.requirements).toBeUndefined();
    expect(result.diagnostics).toContainEqual({ skillId: "ravi-system:reader", code: "missing-requirements" });
  });

  for (const value of [
    "not-json",
    "null",
    '{"kind":"none","extra":true}',
    '{"kind":"any-of","alternatives":[]}',
    '{"kind":"any-of","alternatives":[[]]}',
    '{"kind":"any-of","alternatives":[[" "]]}',
  ]) {
    it(`omits invalid requirement metadata: ${value}`, () => {
      const result = buildSkillPolicyCatalog([source(value)]);
      expect(result.entries).toEqual([]);
      expect(result.diagnostics).toContainEqual({ skillId: "ravi-system:reader", code: "invalid-requirements" });
      expect(JSON.stringify(result.diagnostics)).not.toContain("Private skill content");
    });
  }

  it("does not interpret a body example as a requirements declaration", () => {
    const item = source();
    const result = buildSkillPolicyCatalog([{ ...item, content: `${item.content}\nravi.requires: {"kind":"none"}` }]);
    expect(result.entries[0]?.requirements).toBeUndefined();
  });

  it("rejects duplicate declarations instead of choosing an easier requirement", () => {
    const item = source('{"kind":"none"}\nravi.requires: {"kind":"any-of","alternatives":[["exec.shell"]]}');
    const result = buildSkillPolicyCatalog([item]);
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("invalid-requirements");
  });

  it("retains in-memory source files for packaged runtime materialization", () => {
    const item = source('{"kind":"none"}');
    const result = buildSkillPolicyCatalog([
      {
        ...item,
        source: "catalog:ravi-system/reader",
        path: "skills/reader",
        skillFilePath: "skills/reader/SKILL.md",
        files: [
          { path: "SKILL.md", content: item.content },
          { path: "references/help.md", content: "reference" },
        ],
      },
    ]);
    expect(result.entries[0]?.resource.files?.map((file) => file.path)).toEqual(["SKILL.md", "references/help.md"]);
  });

  it("changes catalog revision when the actual skill body changes", () => {
    const item = source('{"kind":"none"}');
    const original = buildSkillPolicyCatalog([item]);
    const changed = buildSkillPolicyCatalog([{ ...item, content: item.content + "\nChanged instructions" }]);
    expect(original.revision).not.toBe(changed.revision);
  });

  it("uses source-qualified identities for non-plugin local skills", () => {
    const { pluginName: _plugin, ...item } = source('{"kind":"none"}');
    const result = buildSkillPolicyCatalog([{ ...item, source: "local:workspace" }]);
    expect(result.entries[0]?.id).toBe("local:workspace:reader");
  });

  it("migrates an internal system skill from the existing group registry", () => {
    const item = source();
    const result = buildSkillPolicyCatalog([{ ...item, name: "sessions", source: "catalog:ravi-system/sessions" }]);
    expect(result.entries[0]?.requirements).toEqual({ kind: "any-of", alternatives: [["ravi.cli.sessions"]] });
  });

  it("does not apply the internal migration to a custom skill with a matching name", () => {
    const result = buildSkillPolicyCatalog([{ ...source(), name: "sessions", source: "plugin:ravi-system" }]);
    expect(result.entries[0]?.requirements).toBeUndefined();
  });

  it("honors explicit requirements over an internal migration mapping", () => {
    const result = buildSkillPolicyCatalog([
      {
        ...source('{"kind":"any-of","alternatives":[["exec.shell"]]}'),
        name: "sessions",
        source: "catalog:ravi-system/sessions",
      },
    ]);
    expect(result.entries[0]?.requirements).toEqual({ kind: "any-of", alternatives: [["exec.shell"]] });
  });
});
