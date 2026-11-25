/**
 * Remote skill pins as entries of the generated `ravi-library` plugin
 * (spec mcp, Remote Skills; spec skills/library, Generated plugin).
 *
 * Each active pin of a registered server becomes a stub skill: a `SKILL.md`
 * with the approved name and description and the command that reads the
 * skill on demand. A pin whose plugin name a Library pin already uses is left
 * out: the Library pin wins, and the gate never confuses the two.
 */

import type { LibraryPluginSkill } from "../library/plugin.js";
import { logger } from "../utils/logger.js";
import { mcpSkillStubMarkdown } from "./skill-ids.js";
import { listGeneratedMcpSkillPins, listLoadableMcpSkillPins, type McpSkillPinRecord } from "./skill-pins-db.js";

const log = logger.child("mcp:skill-plugin");

function withoutCollisions(pins: McpSkillPinRecord[], libraryNames: ReadonlySet<string>): McpSkillPinRecord[] {
  return pins.filter((pin) => {
    if (!libraryNames.has(pin.skillName.toLowerCase())) return true;
    log.warn("Remote skill pin left out: a Library pin uses its plugin name", {
      agentId: pin.agentId,
      server: pin.server,
      skill: pin.skillName,
    });
    return false;
  });
}

/** The stub entries of every generated pin, for a plugin generation. Never throws: none on a read failure. */
export function mcpSkillPluginEntries(libraryNames: ReadonlySet<string>): LibraryPluginSkill[] {
  let pins: McpSkillPinRecord[];
  try {
    pins = listGeneratedMcpSkillPins();
  } catch {
    // no-cause: an unreadable pin table adds no stub; the Library pins still generate.
    log.warn("Remote skill pins could not be read; no stub is generated");
    return [];
  }
  return withoutCollisions(pins, libraryNames).map((pin) => ({
    agentId: pin.agentId,
    skillName: pin.skillName,
    externalAllowed: pin.externalAllowed,
    sourceDir: "",
    ref: pin.skillId,
    version: 0,
    contentKey: pin.manifestDigest,
    skillMarkdown: mcpSkillStubMarkdown({
      skillName: pin.skillName,
      skillId: pin.skillId,
      server: pin.server,
      name: pin.manifest.name,
      description: pin.description,
    }),
  }));
}

export interface McpSkillPluginPin {
  agentId: string;
  skillName: string;
  externalAllowed: boolean;
}

/**
 * The pins a session or the gate may count now (active, server enabled and
 * attached, no Library name collision). Throws when the table cannot be
 * read; callers fail closed.
 */
export function loadableMcpSkillPluginPins(libraryNames: ReadonlySet<string>, agentId?: string): McpSkillPluginPin[] {
  return withoutCollisions(listLoadableMcpSkillPins(agentId), libraryNames).map((pin) => ({
    agentId: pin.agentId,
    skillName: pin.skillName,
    externalAllowed: pin.externalAllowed,
  }));
}
