import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { dbReplaceLibraryPins } from "../library/pins-db.js";
import { isLibraryPluginSkillAllowedForTurn, libraryPluginSkillName } from "../library/session-plugins.js";
import { fakeSkill } from "../library/test-fixtures.js";
import { getOrCreateSession } from "../router/index.js";
import type { ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "./context-registry.js";
import { createRuntimeHostServices } from "./host-services.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-turn-skills-");
  const restricted = fakeSkill({ slug: "tom-de-voz" }).item;
  const open = { ...fakeSkill({ slug: "agenda" }).item, externalAllowed: true };
  dbReplaceLibraryPins({
    consoleUrl: "https://console.test",
    organizationId: "org-1",
    installationId: "inst-1",
    installationName: "macbook",
    revision: "r1",
    fingerprint: "f1",
    pluginDir: null,
    pins: [
      {
        agentId: "main",
        libraryId: "org:tom-de-voz",
        ref: "org/tom-de-voz",
        skillName: "org-tom-de-voz",
        version: 1,
        contentHash: restricted.contentHash,
        externalAllowed: false,
        item: restricted,
      },
      {
        agentId: "main",
        libraryId: "org:agenda",
        ref: "org/agenda",
        skillName: "org-agenda",
        version: 1,
        contentHash: open.contentHash,
        externalAllowed: true,
        item: open,
      },
      {
        agentId: "other",
        libraryId: "org:segredo",
        ref: "org/segredo",
        skillName: "org-segredo",
        version: 1,
        contentHash: restricted.contentHash,
        externalAllowed: true,
        item: restricted,
      },
    ],
  });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" };
}

describe("pinned Library skills are checked against the turn that loads them", () => {
  it("names plugin skills by both provider spellings", () => {
    expect(libraryPluginSkillName("ravi-library:org-agenda")).toBe("org-agenda");
    expect(libraryPluginSkillName("ravi-library-org-agenda")).toBe("org-agenda");
    expect(libraryPluginSkillName("org-agenda")).toBeNull();
    expect(libraryPluginSkillName("ravi-library:")).toBeNull();
  });

  it("loads a skill not marked externalAllowed only in the operator's own turn", () => {
    const check = (skill: string, own: boolean) =>
      isLibraryPluginSkillAllowedForTurn({ agentId: "main", skill, isOperatorOwnTurn: () => own });
    expect(check("ravi-library:org-tom-de-voz", true)).toBe(true);
    expect(check("ravi-library:org-tom-de-voz", false)).toBe(false);
    expect(check("ravi-library-org-tom-de-voz", false)).toBe(false);
    expect(check("ravi-library:org-agenda", false)).toBe(true);
    // Pinned to another agent: never, whoever asks.
    expect(check("ravi-library-org-segredo", true)).toBe(false);
    // Not a Library plugin skill: not this check's business.
    expect(check("gmail-pack", false)).toBe(true);
    // A failing classification fails closed.
    expect(
      isLibraryPluginSkillAllowedForTurn({
        agentId: "main",
        skill: "ravi-library:org-tom-de-voz",
        isOperatorOwnTurn: () => {
          throw new Error("boom");
        },
      }),
    ).toBe(false);
  });

  it("denies the load in a later turn of a live session when that turn is not the operator's", async () => {
    // The session (and its plugin) may have started on the operator's turn;
    // the context below is the refreshed one of a later turn from someone else.
    getOrCreateSession("agent:main:whatsapp:wa-main:group:120363000000000001", "main", stateDir!, {
      name: "main-group",
      runtimeProvider: "claude",
    });
    const context = createRuntimeContext({
      kind: "agent-runtime",
      agentId: "main",
      sessionKey: "agent:main:whatsapp:wa-main:group:120363000000000001",
      sessionName: "main-group",
      capabilities: [cap("use", "tool", "Skill"), cap("use", "tool", "Read"), cap("use", "tool", "Bash")],
    });
    const services = createRuntimeHostServices({
      context,
      agentId: "main",
      sessionName: "main-group",
      toolContext: {},
    });

    const skill = await services.authorizeToolUse({
      toolName: "Skill",
      input: { skill: "ravi-library:org-tom-de-voz" },
    });
    expect(skill.approved).toBe(false);
    expect(skill.reason).toContain("Library skill 'ravi-library:org-tom-de-voz' does not load in this turn");

    const open = await services.authorizeToolUse({ toolName: "Skill", input: { skill: "ravi-library:org-agenda" } });
    expect(open.approved).toBe(true);

    const other = await services.authorizeToolUse({ toolName: "Skill", input: { skill: "ravi-library:org-segredo" } });
    expect(other.approved).toBe(false);
  });
});
