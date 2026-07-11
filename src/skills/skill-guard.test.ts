import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySkillGuard, archiveAgentCreatedSkill, resolveEditableSkillPath } from "./skill-guard.js";

describe("applySkillGuard (learning-loop skill write enforcement)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ravi-skill-guard-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const prov = { sessionKey: "sess-1", cadenceTurn: "10", taskId: "task-abc", date: "2026-07-09" };

  it("create: writes a new agent-created SKILL.md with frontmatter + provenance", () => {
    const r = applySkillGuard({
      skillName: "cadastrar-pedido",
      op: "create",
      description: "Como cadastrar um pedido no sistema X",
      content: "# Cadastrar pedido\n\n1. Abra o form.\n2. Preencha os campos obrigatórios.",
      agentId: "jarvis-2",
      provenance: prov,
      homeDir: home,
    });
    expect(r.outcome).toBe("written");
    if (r.outcome === "written") {
      expect(existsSync(r.path)).toBe(true);
      const md = readFileSync(r.path, "utf-8");
      expect(md).toContain("name: cadastrar-pedido");
      expect(md).toContain("origin: agent-created");
      expect(md).toContain("created_by: jarvis-2");
      expect(md).toContain("Cadastrar pedido");
    }
  });

  it("create: rejects when the skill already exists (use patch)", () => {
    applySkillGuard({ skillName: "s1", op: "create", description: "d", content: "body", agentId: "a", homeDir: home });
    const r = applySkillGuard({
      skillName: "s1",
      op: "create",
      description: "d",
      content: "body2",
      agentId: "a",
      homeDir: home,
    });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reason).toBe("exists");
  });

  it("patch: appends a provenance-stamped Learned section to an existing skill", () => {
    applySkillGuard({
      skillName: "cadastrar-pedido",
      op: "create",
      description: "Como cadastrar",
      content: "# Cadastrar pedido\n\nPassos originais.",
      agentId: "jarvis-2",
      homeDir: home,
    });
    const r = applySkillGuard({
      skillName: "cadastrar-pedido",
      op: "patch",
      content:
        "Pitfall: o campo CPF exige máscara — sem ela o form falha silenciosamente. Sempre aplicar a máscara antes de submeter.",
      agentId: "jarvis-2",
      provenance: prov,
      homeDir: home,
    });
    expect(r.outcome).toBe("written");
    if (r.outcome === "written") {
      const md = readFileSync(r.path, "utf-8");
      expect(md).toContain("Passos originais.");
      expect(md).toContain("## Learned —");
      expect(md).toContain("via curador-skills");
      expect(md).toContain("máscara");
    }
  });

  it("patch: rejects when the skill does not exist in the editable dir (protected/absent, I10)", () => {
    const r = applySkillGuard({ skillName: "bundled-skill", op: "patch", content: "x", agentId: "a", homeDir: home });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reason).toBe("not-found");
  });

  it("patch: rejects a skill explicitly marked protected in frontmatter (I10)", () => {
    const path = resolveEditableSkillPath("proteg", home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "---\nname: proteg\norigin: bundled\n---\nbody\n", "utf-8");
    const r = applySkillGuard({ skillName: "proteg", op: "patch", content: "x", agentId: "a", homeDir: home });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reason).toBe("protected");
  });

  it("patch: rejects a catalog/hub skill sitting in the editable dir with NO origin marker (I10 allowlist — the real hole)", () => {
    // Mirrors installSkills copying a catalog skill in verbatim: it lives in the
    // editable dir but carries no `origin: agent-created` marker.
    const path = resolveEditableSkillPath("cli-creator", home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "---\nname: cli-creator\ndescription: Creates CLIs\n---\n# CLI creator\n\nSteps.\n", "utf-8");
    const r = applySkillGuard({ skillName: "cli-creator", op: "patch", content: "x", agentId: "a", homeDir: home });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reason).toBe("protected");
  });

  it("patch: rejects a skill that only MENTIONS the marker in its body, not frontmatter (I10 frontmatter-only)", () => {
    // A catalog skill/doc describing the learning-loop feature: its body contains
    // a line `origin: agent-created`, but its frontmatter does NOT. Must NOT be
    // patchable — the allowlist parses the frontmatter, not the whole file.
    const path = resolveEditableSkillPath("doc-about-loop", home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      "---\nname: doc-about-loop\ndescription: Explains the loop\n---\n# About\n\nThe guard stamps `origin: agent-created` on skills it creates.\n",
      "utf-8",
    );
    const r = applySkillGuard({ skillName: "doc-about-loop", op: "patch", content: "x", agentId: "a", homeDir: home });
    expect(r.outcome).toBe("rejected");
    if (r.outcome === "rejected") expect(r.reason).toBe("protected");
  });

  it("patch: allows a skill THIS guard created (origin: agent-created), create→patch round-trip", () => {
    applySkillGuard({
      skillName: "minha-skill-criada",
      op: "create",
      description: "Criada pelo loop",
      content: "# Skill\n\nPassos.",
      agentId: "jarvis-2",
      homeDir: home,
    });
    const r = applySkillGuard({
      skillName: "minha-skill-criada",
      op: "patch",
      content: "Pitfall aprendido.",
      agentId: "jarvis-2",
      provenance: prov,
      homeDir: home,
    });
    expect(r.outcome).toBe("written");
  });

  it("dry-run: computes the write outcome without touching disk", () => {
    const r = applySkillGuard({
      skillName: "s-dry",
      op: "create",
      description: "d",
      content: "body",
      agentId: "a",
      dryRun: true,
      homeDir: home,
    });
    expect(r.outcome).toBe("written");
    if (r.outcome === "written") expect(existsSync(r.path)).toBe(false);
  });

  it("rejects empty content and empty name", () => {
    expect(
      applySkillGuard({ skillName: "s", op: "create", description: "d", content: "  ", agentId: "a", homeDir: home })
        .outcome,
    ).toBe("rejected");
    expect(
      applySkillGuard({ skillName: "", op: "create", description: "d", content: "x", agentId: "a", homeDir: home })
        .outcome,
    ).toBe("rejected");
  });

  describe("archiveAgentCreatedSkill (I10 allowlist — recoverable retirement, I14)", () => {
    it("archives an agent-created skill: gone from discovery path, MOVED to .archive (recoverable)", () => {
      const w = applySkillGuard({
        skillName: "junk",
        op: "create",
        description: "d",
        content: "b",
        agentId: "a",
        homeDir: home,
      });
      expect(w.outcome).toBe("written");
      const r = archiveAgentCreatedSkill("junk", home);
      expect(r.outcome).toBe("archived");
      expect(existsSync(resolveEditableSkillPath("junk", home))).toBe(false); // gone from discovery
      if (r.outcome === "archived") expect(existsSync(join(r.archivedTo, "SKILL.md"))).toBe(true); // recoverable
    });

    it("rejects a non-agent-created (catalog) skill (I10 protected)", () => {
      const path = resolveEditableSkillPath("cli-creator", home);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "---\nname: cli-creator\ndescription: x\n---\nbody\n", "utf-8");
      const r = archiveAgentCreatedSkill("cli-creator", home);
      expect(r.outcome).toBe("rejected");
      if (r.outcome === "rejected") expect(r.reason).toBe("protected");
      expect(existsSync(path)).toBe(true); // untouched
    });

    it("rejects a missing skill (not-found) and dry-run does not move", () => {
      expect(archiveAgentCreatedSkill("nope", home).outcome).toBe("rejected");
      applySkillGuard({ skillName: "keep", op: "create", description: "d", content: "b", agentId: "a", homeDir: home });
      const r = archiveAgentCreatedSkill("keep", home, true);
      expect(r.outcome).toBe("archived");
      expect(existsSync(resolveEditableSkillPath("keep", home))).toBe(true); // dry-run kept it in place
    });
  });
});
