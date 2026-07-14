/**
 * Skill write enforcement — the `ravi skills guard` core (learning-loop/skill-curation).
 *
 * Ravi had no way to WRITE a skill (only list/show/install/sync). The skill
 * learning loop needs one: when the curador-skills agent learns a correction or
 * technique from a session, it must PATCH the skill that was in play (or CREATE
 * a new class-level umbrella) — through an enforcement layer, never a raw file
 * edit, mirroring `ravi memory guard`.
 *
 * Enforced invariants (see spec learning-loop/skill-curation):
 *  - I10 protected skills, enforced as a POSITIVE ALLOWLIST: the loop may PATCH
 *    only skills IT created — those carrying the `origin: agent-created` marker
 *    this guard's `create` op stamps. Catalog/hub-installed skills share the very
 *    same user plugin dir (`installSkills` copies them in verbatim, never
 *    stamping origin), and hand-authored user skills carry no marker either — so
 *    a name/path check alone can't tell them apart. Anything without the
 *    agent-created marker is refused: patching it would silently mutate a shared
 *    or installed skill. (A blocklist on `origin: bundled|hub` was insufficient —
 *    installed skills have NO origin field at all, so nothing to block on.)
 *  - I11 provenance: every write stamps who/when/which-session/task.
 *  - Atomic write (temp + rename) so a crash never leaves a half-written SKILL.md.
 *
 * This module is pure/deterministic and unit-testable; the CLI command is a thin
 * wrapper (like memory guard). Writes go ONLY under the user skills plugin dir.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { slugifySkillName, userSkillsPluginDir } from "./manager.js";

export type SkillGuardOp = "patch" | "create";

export interface SkillGuardProvenance {
  sessionKey?: string;
  cadenceTurn?: string;
  taskId?: string;
  /** Absolute ISO date the curador resolved for "today" (R16-style). */
  date?: string;
}

export interface SkillGuardInput {
  skillName: string;
  op: SkillGuardOp;
  /**
   * `patch`: a markdown block to append (a learned pitfall / correction / step).
   * `create`: the SKILL.md body (without frontmatter — the guard writes the
   * frontmatter with name/description/origin/provenance).
   */
  content: string;
  agentId: string;
  /** Required for `create`; ignored for `patch`. */
  description?: string;
  provenance?: SkillGuardProvenance;
  dryRun?: boolean;
  /** Override home dir (tests). */
  homeDir?: string;
}

export type SkillGuardDecision =
  | { outcome: "written"; op: SkillGuardOp; path: string; finalChars: number }
  | { outcome: "rejected"; reason: SkillGuardReason; detail: string };

export type SkillGuardReason =
  | "invalid-name"
  | "not-found"
  | "protected"
  | "exists"
  | "missing-description"
  | "empty-content";

/**
 * The positive allowlist marker: only skills this guard's `create` op wrote
 * carry `origin: agent-created` (see renderNewSkill). Patch is gated on it, so
 * the loop can never mutate a catalog/hub-installed or hand-authored skill that
 * happens to sit in the same editable dir.
 *
 * IMPORTANT: this is matched ONLY inside the YAML frontmatter block (see
 * isAgentCreated), never against the whole file — a skill/doc whose BODY merely
 * mentions `origin: agent-created` (e.g. one describing this feature) must not
 * become patchable.
 */
const AGENT_CREATED_RE = /^\s*origin:\s*['"]?agent-created['"]?\s*$/im;

/** Extract the leading YAML frontmatter block (between the first `---` fences), or "" if none. */
function extractFrontmatter(content: string): string {
  const match = content.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  return match ? match[1]! : "";
}

/** True only when the skill's FRONTMATTER declares origin: agent-created (I10 allowlist). */
function isAgentCreated(content: string): boolean {
  return AGENT_CREATED_RE.test(extractFrontmatter(content));
}

/** Resolve the agent-editable SKILL.md path for a skill name (user plugin dir). */
export function resolveEditableSkillPath(skillName: string, homeDir = homedir()): string {
  const slug = slugifySkillName(skillName);
  return join(userSkillsPluginDir(homeDir), "skills", slug, "SKILL.md");
}

export function applySkillGuard(input: SkillGuardInput): SkillGuardDecision {
  const home = input.homeDir ?? homedir();
  // Reject an empty/whitespace name explicitly — slugifySkillName falls back to
  // "skill" for empty input, which would silently write a skill literally named
  // "skill" instead of surfacing the caller's mistake.
  if (!input.skillName.trim()) {
    return { outcome: "rejected", reason: "invalid-name", detail: "skill name is empty" };
  }
  const slug = slugifySkillName(input.skillName);
  if (!input.content.trim()) {
    return { outcome: "rejected", reason: "empty-content", detail: "content is empty" };
  }
  const path = resolveEditableSkillPath(slug, home);
  const exists = existsSync(path);

  if (input.op === "patch") {
    // I10: patch only an existing, agent-editable skill. A skill absent from the
    // user plugin dir is either non-existent or bundled/catalog (protected) — the
    // curador must not reach past its writable surface.
    if (!exists) {
      return {
        outcome: "rejected",
        reason: "not-found",
        detail: `Skill "${slug}" not found in the agent-editable plugin dir. Patch requires an existing user skill; bundled/hub/catalog skills are protected (I10). Use op=create for a new one.`,
      };
    }
    const current = readFileSync(path, "utf-8");
    // I10 positive allowlist: patch ONLY skills the loop created itself. A
    // catalog/hub-installed skill (e.g. cli-creator, agents-manager) lives in
    // this same dir but was copied in verbatim with no `origin: agent-created`
    // marker — so without this gate the guard would write straight through it.
    if (!isAgentCreated(current)) {
      return {
        outcome: "rejected",
        reason: "protected",
        detail: `Skill "${slug}" is not agent-created (no 'origin: agent-created' in frontmatter) — it is a catalog/hub-installed or hand-authored skill, protected from the learning loop (I10). Only skills this loop created may be patched.`,
      };
    }
    const next = appendLearnedSection(current, input);
    if (!input.dryRun) {
      atomicWrite(path, next);
    }
    return { outcome: "written", op: "patch", path, finalChars: next.length };
  }

  // op === "create"
  if (exists) {
    return { outcome: "rejected", reason: "exists", detail: `Skill "${slug}" already exists — use op=patch` };
  }
  if (!input.description?.trim()) {
    return { outcome: "rejected", reason: "missing-description", detail: "create requires a description" };
  }
  const body = renderNewSkill(slug, input);
  if (!input.dryRun) {
    mkdirSync(join(userSkillsPluginDir(home), "skills", slug), { recursive: true });
    atomicWrite(path, body);
  }
  return { outcome: "written", op: "create", path, finalChars: body.length };
}

/** Append a provenance-stamped "Learned" section to an existing SKILL.md body. */
function appendLearnedSection(current: string, input: SkillGuardInput): string {
  const base = current.endsWith("\n") ? current : `${current}\n`;
  return `${base}\n${renderLearnedSection(input)}`;
}

function renderLearnedSection(input: SkillGuardInput): string {
  const p = input.provenance ?? {};
  const stamp = [
    p.date ? `learned ${p.date}` : null,
    p.sessionKey ? `session ${p.sessionKey}` : null,
    p.cadenceTurn ? `turn ${p.cadenceTurn}` : null,
    p.taskId ? p.taskId : null,
    "via curador-skills",
  ]
    .filter(Boolean)
    .join(" · ");
  return `## Learned — ${stamp}\n\n${input.content.trim()}\n`;
}

function renderNewSkill(slug: string, input: SkillGuardInput): string {
  const p = input.provenance ?? {};
  const fm = [
    "---",
    `name: ${slug}`,
    `description: ${escapeYaml(input.description!.trim())}`,
    "metadata:",
    "  origin: agent-created",
    `  created_by: ${input.agentId}`,
    ...(p.date ? [`  created: ${p.date}`] : []),
    ...(p.sessionKey ? [`  session: ${p.sessionKey}`] : []),
    ...(p.cadenceTurn ? [`  cadence_turn: ${p.cadenceTurn}`] : []),
    "---",
    "",
  ].join("\n");
  return `${fm}${input.content.trim()}\n`;
}

function escapeYaml(value: string): string {
  // Single-line description; quote if it carries YAML-significant chars.
  if (/[:#'"\n]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

export type SkillArchiveDecision =
  | { outcome: "archived"; skill: string; path: string; archivedTo: string }
  | { outcome: "rejected"; reason: "invalid-name" | "not-found" | "protected"; detail: string };

/**
 * ARCHIVE an AGENT-CREATED skill — move its dir out of the discovered skill path
 * into `<plugin>/.archive/<slug>/`, RECOVERABLE (I14: the loop archives, never
 * hard-deletes). Same I10 allowlist as patch: only skills carrying
 * `origin: agent-created` in frontmatter may be archived; catalog/hub/hand-
 * authored skills are protected. This is the counterpart the guard needs so
 * agents can retire the skills the loop itself created (junk, superseded, test
 * artifacts) without a raw `rm` and without losing them irrecoverably.
 */
export function archiveAgentCreatedSkill(skillName: string, homeDir = homedir(), dryRun = false): SkillArchiveDecision {
  if (!skillName.trim()) {
    return { outcome: "rejected", reason: "invalid-name", detail: "skill name is empty" };
  }
  const slug = slugifySkillName(skillName);
  const path = resolveEditableSkillPath(slug, homeDir);
  if (!existsSync(path)) {
    return { outcome: "rejected", reason: "not-found", detail: `Skill "${slug}" not found in the agent-editable dir` };
  }
  if (!isAgentCreated(readFileSync(path, "utf-8"))) {
    return {
      outcome: "rejected",
      reason: "protected",
      detail: `Skill "${slug}" is not agent-created — catalog/hub/hand-authored skills cannot be archived by the loop (I10).`,
    };
  }
  const skillDir = dirname(path);
  const archiveRoot = join(userSkillsPluginDir(homeDir), ".archive");
  const archivedTo = join(archiveRoot, slug);
  if (!dryRun) {
    mkdirSync(archiveRoot, { recursive: true });
    // Replace any prior archive of the same slug with the current version.
    if (existsSync(archivedTo)) {
      rmSync(archivedTo, { recursive: true, force: true });
    }
    renameSync(skillDir, archivedTo);
  }
  return { outcome: "archived", skill: slug, path: skillDir, archivedTo };
}
