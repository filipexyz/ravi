import { describe, expect, it } from "bun:test";
import { listCatalogSkills } from "../skills/manager.js";
import {
  inferRaviCommandSkillGate,
  inferRaviToolSkillGate,
  listDefaultSkillGateRules,
  resolveCommandSkillGate,
} from "./skill-gates.js";

describe("default skill gate rules for slack, observers and meetings", () => {
  const cases = [
    { group: "slack", skill: "ravi-system-slack", command: "ravi slack canvas-access-delete F123 --users U123 --json" },
    { group: "observers", skill: "ravi-system-observers", command: "ravi observers rules list --json" },
    { group: "meetings", skill: "ravi-system-meetings", command: "ravi meetings profiles list --json" },
  ] as const;

  it("names a system skill that ships in the catalog", () => {
    const catalog = listCatalogSkills();
    for (const { group, skill } of cases) {
      expect(listDefaultSkillGateRules()).toContainEqual({ id: group, pattern: `^${group}(?:[._]|$)`, skill });
      expect(catalog.some((entry) => entry.pluginName === "ravi-system" && `ravi-system-${entry.name}` === skill)).toBe(
        true,
      );
    }
  });

  it("gates the group, its subgroups and their tools on the first call", () => {
    for (const { group, skill, command } of cases) {
      expect(inferRaviCommandSkillGate(command)).toEqual({ skill, source: "inferred", ruleId: group });
      expect(resolveCommandSkillGate({ groupPath: `${group}.rules`, command: "list" })).toMatchObject({ skill });
      expect(inferRaviToolSkillGate(`${group}_list`)).toMatchObject({ skill });
    }
    expect(inferRaviToolSkillGate("slackish_list")).toBeUndefined();
  });
});
