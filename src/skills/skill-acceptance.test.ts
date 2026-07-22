import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DbSkillGrant } from "../router/router-db.js";
import { dbCreateAgent } from "../router/router-db.js";
import { resolveAgentSkills } from "../runtime/allowed-skills.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { acceptSkillCreate } from "./skill-acceptance.js";
import { resolveEditableSkillPath } from "./skill-guard.js";

describe("acceptSkillCreate", () => {
  let stateDir: string | null = null;
  let home: string;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-skill-acceptance-");
    home = mkdtempSync(join(tmpdir(), "ravi-skill-acceptance-home-"));
    dbCreateAgent({ id: "agent-a", cwd: home });
  });

  afterEach(async () => {
    rmSync(home, { recursive: true, force: true });
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates, grants, and makes the accepted skill visible to the origin agent", () => {
    const decision = acceptSkillCreate({
      skillName: "Nova Técnica",
      op: "create",
      description: "Técnica aceita pelo loop",
      content: "# Nova Técnica\n\nUse quando houver evidência.",
      agentId: "agent-a",
      provenance: { taskId: "task-1", sessionKey: "session-1", cadenceTurn: "20", date: "2026-07-22" },
      homeDir: home,
    });

    expect(decision.outcome).toBe("written");
    expect(decision.grant).toMatchObject({ agentId: "agent-a", skillName: "nova-t-cnica" });
    expect(decision.visibleToAgent).toBe(true);
    expect(resolveAgentSkills("agent-a").allowlist).toContain("nova-t-cnica");
    expect(readFileSync(resolveEditableSkillPath("nova-t-cnica", home), "utf-8")).toContain("origin: agent-created");
  });

  it("is idempotent for the same agent-created artifact and grant", () => {
    const first = acceptSkillCreate({
      skillName: "Idempotente",
      op: "create",
      description: "d",
      content: "body",
      agentId: "agent-a",
      homeDir: home,
    });
    expect(first.outcome).toBe("written");

    const second = acceptSkillCreate({
      skillName: "Idempotente",
      op: "create",
      description: "d",
      content: "different body",
      agentId: "agent-a",
      homeDir: home,
    });

    expect(second.outcome).toBe("written");
    expect(second.idempotent).toBe(true);
    expect(readFileSync(resolveEditableSkillPath("idempotente", home), "utf-8")).toContain("body");
    expect(readFileSync(resolveEditableSkillPath("idempotente", home), "utf-8")).not.toContain("different body");
  });

  it("does not grant rejected proposals", () => {
    const rejected = acceptSkillCreate({
      skillName: "Sem Conteudo",
      op: "create",
      description: "d",
      content: " ",
      agentId: "agent-a",
      homeDir: home,
    });

    expect(rejected.outcome).toBe("rejected");
    expect(resolveAgentSkills("agent-a").allowlist).not.toContain("sem-conteudo");
    expect(existsSync(resolveEditableSkillPath("sem-conteudo", home))).toBe(false);
  });

  it("rolls back the file and grant when publication visibility fails", () => {
    const grants: DbSkillGrant[] = [];
    expect(() =>
      acceptSkillCreate(
        {
          skillName: "Rollback Parcial",
          op: "create",
          description: "d",
          content: "body",
          agentId: "agent-a",
          homeDir: home,
        },
        {
          listGrants: () => grants,
          upsertGrant: (input) => {
            const grant = { ...input, grantedAt: Date.now() };
            grants.push(grant);
            return grant;
          },
          deleteGrant: (_agentId, skillName) => {
            const before = grants.length;
            for (let index = grants.length - 1; index >= 0; index--) {
              if (grants[index]?.skillName === skillName) grants.splice(index, 1);
            }
            return grants.length !== before;
          },
          isVisible: () => false,
        },
      ),
    ).toThrow(/rolled back/);

    expect(grants).toEqual([]);
    expect(existsSync(resolveEditableSkillPath("rollback-parcial", home))).toBe(false);
  });
});
