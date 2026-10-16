/**
 * Which `ravi-library` plugin a runtime session loads (spec skills/library).
 *
 * Read at session start from the pins of the last sync. Never throws: a
 * session starts without pinned skills rather than not at all.
 */

import { existsSync } from "node:fs";

import type { RuntimePlugin } from "../runtime/types.js";
import { logger } from "../utils/logger.js";
import { dbGetLibraryPinState, dbListLibraryPins } from "./pins-db.js";
import {
  codexLibrarySkillName,
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
    const pins = dbListLibraryPins();
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

function ownTurn(input: LibrarySessionPluginsInput): boolean {
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
