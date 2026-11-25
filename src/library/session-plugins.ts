/**
 * Which `ravi-library` plugin a runtime session loads (spec skills/library).
 *
 * Read at session start from the pins of the last sync. Never throws: a
 * session starts without pinned skills rather than not at all.
 */

import { existsSync } from "node:fs";

import { loadableMcpSkillPluginPins } from "../mcp/skill-plugin.js";
import type { RuntimePlugin } from "../runtime/types.js";
import { logger } from "../utils/logger.js";
import { dbGetLibraryPinState, dbListLibraryPins } from "./pins-db.js";
import {
  codexLibrarySkillName,
  LIBRARY_PLUGIN_NAME,
  LIBRARY_PLUGIN_SKILL_PREFIX,
  libraryAgentPluginDir,
  libraryUnionPluginDir,
  type LibraryPluginVariant,
} from "./plugin.js";

const log = logger.child("library:session-plugins");

export interface LibrarySessionPluginsInput {
  agentId: string;
  /** The provider copies plugin skills into one shared directory (Codex). */
  sharedSkillsDir: boolean;
  /**
   * Whether this session serves the operator's own turn. Asked only when the
   * agent has a pinned skill not marked `externalAllowed`; fails closed.
   */
  isOperatorOwnTurn: () => boolean;
}

export interface LibrarySessionPlugins {
  plugins: RuntimePlugin[];
  /** Codex skill names (`ravi-library-<name>`) this session must not load. */
  hiddenSkills: string[];
  /** Plugin skill names this session loads. */
  skills: string[];
  variant: LibraryPluginVariant | null;
}

const EMPTY: LibrarySessionPlugins = { plugins: [], hiddenSkills: [], skills: [], variant: null };

export function resolveLibrarySessionPlugins(input: LibrarySessionPluginsInput): LibrarySessionPlugins {
  try {
    const state = dbGetLibraryPinState();
    const generationDir = state?.pluginDir;
    if (!generationDir || !existsSync(generationDir)) return EMPTY;
    const pins = pluginPins();
    if (pins.length === 0) return EMPTY;

    const own = pins.filter((pin) => pin.agentId === input.agentId);
    const variant: LibraryPluginVariant | null =
      own.length === 0 ? null : own.every((pin) => pin.externalAllowed) || ownTurn(input) ? "all" : "external";
    const visible = new Set(own.filter((pin) => variant === "all" || pin.externalAllowed).map((pin) => pin.skillName));

    if (input.sharedSkillsDir) {
      const union = libraryUnionPluginDir(generationDir);
      if (!existsSync(union)) return EMPTY;
      const hiddenSkills = [...new Set(pins.map((pin) => pin.skillName))]
        .filter((name) => !visible.has(name))
        .map(codexLibrarySkillName);
      return { plugins: [{ type: "local", path: union }], hiddenSkills, skills: [...visible], variant };
    }

    if (!variant || visible.size === 0) return { ...EMPTY, variant };
    const dir = libraryAgentPluginDir(generationDir, input.agentId, variant);
    if (!existsSync(dir)) return EMPTY;
    return { plugins: [{ type: "local", path: dir }], hiddenSkills: [], skills: [...visible], variant };
  } catch (error) {
    log.warn("Library pins not loaded for this session", {
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY;
  }
}

interface PluginPin {
  agentId: string;
  skillName: string;
  externalAllowed: boolean;
}

/**
 * Every pin the generated plugin serves: the Library pins of the last sync,
 * and the remote MCP skill pins that may load now (spec mcp, Remote Skills:
 * active, server enabled and attached, no name a Library pin uses). Throws
 * when either table cannot be read.
 */
function pluginPins(agentId?: string): PluginPin[] {
  const library = dbListLibraryPins();
  const names = new Set(library.map((pin) => pin.skillName.toLowerCase()));
  const own = agentId === undefined ? library : library.filter((pin) => pin.agentId === agentId);
  return [
    ...own.map((pin) => ({ agentId: pin.agentId, skillName: pin.skillName, externalAllowed: pin.externalAllowed })),
    ...loadableMcpSkillPluginPins(names, agentId),
  ];
}

/**
 * The pinned skill a plugin skill name stands for: `ravi-library:<name>` (Claude,
 * Pi) or `ravi-library-<name>` (Codex). Null for any other skill.
 */
export function libraryPluginSkillName(skill: string): string | null {
  const value = skill.trim().toLowerCase();
  for (const prefix of [`${LIBRARY_PLUGIN_NAME}:`, LIBRARY_PLUGIN_SKILL_PREFIX]) {
    if (value.startsWith(prefix) && value.length > prefix.length) return value.slice(prefix.length);
  }
  return null;
}

/**
 * Whether the current turn may load the pinned Library skill `skill` names.
 *
 * A runtime session outlives the turn that started it, and the plugin it
 * loaded (and, for Codex, the skills it hid) was chosen for that first turn.
 * So every load is checked again against the turn that asks for it: a skill
 * pinned to another agent never loads, and one not marked `externalAllowed`
 * loads only in the operator's own turn. A remote MCP skill stub counts only
 * while its pin is active and its server enabled and attached to the agent.
 * Skills that are not Library plugin skills pass. Fails closed when the pins
 * cannot be read.
 */
export function isLibraryPluginSkillAllowedForTurn(input: {
  agentId: string;
  skill: string;
  isOperatorOwnTurn: () => boolean;
}): boolean {
  const name = libraryPluginSkillName(input.skill);
  if (!name) return true;
  let own: PluginPin[];
  try {
    own = pluginPins(input.agentId).filter((pin) => pin.skillName.toLowerCase() === name);
  } catch {
    return false;
  }
  if (own.length === 0) return false;
  if (own.some((pin) => pin.externalAllowed)) return true;
  return ownTurn(input);
}

function ownTurn(input: Pick<LibrarySessionPluginsInput, "isOperatorOwnTurn">): boolean {
  try {
    return input.isOperatorOwnTurn();
  } catch {
    return false;
  }
}

/** The installation-wide plugin (every pin), for `ravi skills sync` of Codex skills. */
export function libraryUnionPlugins(): RuntimePlugin[] {
  try {
    const dir = dbGetLibraryPinState()?.pluginDir;
    if (!dir) return [];
    const union = libraryUnionPluginDir(dir);
    return existsSync(union) ? [{ type: "local", path: union }] : [];
  } catch {
    return [];
  }
}
