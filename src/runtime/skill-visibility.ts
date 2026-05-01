import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  codexSkillsDir,
  findInstalledSkill,
  findSkillByName,
  listCatalogSkills,
  slugifySkillName,
} from "../skills/manager.js";
import type {
  RuntimeEventMetadata,
  RuntimePlugin,
  RuntimeProviderId,
  RuntimeSkillVisibilityConfidence,
  RuntimeSkillVisibilityEvidence,
  RuntimeSkillVisibilityEvidenceKind,
  RuntimeSkillVisibilityRecord,
  RuntimeSkillVisibilitySnapshot,
  RuntimeSkillVisibilityState,
} from "./types.js";

interface PluginSkillDescriptor {
  id: string;
  source: string;
  path: string;
}

interface LoadedSkillDescriptor {
  id: string;
  source?: string;
  path?: string;
  detail: string;
}

interface ShowSkillDescriptor {
  name: string;
  source?: string;
  skillFilePath?: string;
  pluginName?: string;
}

interface RaviSkillToolCallInput {
  provider: RuntimeProviderId;
  toolName?: string;
  toolInput?: unknown;
  output?: unknown;
  metadata?: RuntimeEventMetadata;
  now?: number;
}

interface SkillGateLoadedInput {
  provider: RuntimeProviderId;
  skill: string;
  source?: string;
  path?: string;
  toolName?: string;
  now?: number;
}

export function emptySkillVisibilitySnapshot(now = Date.now()): RuntimeSkillVisibilitySnapshot {
  return { skills: [], loadedSkills: [], updatedAt: now };
}

export function buildSkillVisibilitySnapshot(
  records: RuntimeSkillVisibilityRecord[],
  now = Date.now(),
): RuntimeSkillVisibilitySnapshot {
  const deduped = new Map<string, RuntimeSkillVisibilityRecord>();
  for (const record of records) {
    if (!record.id.trim()) continue;
    const existing = deduped.get(record.id);
    if (!existing || stateRank(record.state) >= stateRank(existing.state)) {
      deduped.set(record.id, {
        ...record,
        evidence: record.evidence?.length ? record.evidence : undefined,
        lastSeenAt: record.lastSeenAt || now,
      });
    }
  }

  const skills = [...deduped.values()].sort((left, right) => left.id.localeCompare(right.id));
  const loadedSkills = skills
    .filter((skill) => skill.state === "loaded" && skill.confidence === "observed")
    .map((skill) => skill.id);

  return {
    skills,
    loadedSkills,
    updatedAt: now,
  };
}

export function buildPluginSkillVisibilitySnapshot(input: {
  provider: RuntimeProviderId;
  plugins?: RuntimePlugin[];
  state: RuntimeSkillVisibilityState;
  confidence: RuntimeSkillVisibilityConfidence;
  evidenceKind: RuntimeSkillVisibilityEvidenceKind;
  now?: number;
}): RuntimeSkillVisibilitySnapshot {
  const now = input.now ?? Date.now();
  const records = listPluginSkills(input.plugins ?? []).map((skill): RuntimeSkillVisibilityRecord => {
    return {
      id: skill.id,
      provider: input.provider,
      state: input.state,
      confidence: input.confidence,
      source: skill.source,
      evidence: [
        {
          kind: input.evidenceKind,
          observedAt: now,
          path: skill.path,
        },
      ],
      loadedAt: null,
      lastSeenAt: now,
    };
  });
  return buildSkillVisibilitySnapshot(records, now);
}

export function buildCodexSkillVisibilitySnapshot(
  syncedSkillNames: string[],
  now = Date.now(),
): RuntimeSkillVisibilitySnapshot {
  const records = [...new Set(syncedSkillNames.map((name) => name.trim()).filter(Boolean))].map(
    (name): RuntimeSkillVisibilityRecord => {
      const skillPath = join(codexSkillsDir(), name, "SKILL.md");
      return {
        id: name,
        provider: "codex",
        state: "advertised",
        confidence: "declared",
        source: "codex:sync",
        evidence: [
          {
            kind: "sync-manifest",
            observedAt: now,
            path: skillPath,
          },
          {
            kind: "system-prompt",
            observedAt: now,
            detail: "included in Codex skill catalog instructions",
          },
        ],
        loadedAt: null,
        lastSeenAt: now,
      };
    },
  );
  return buildSkillVisibilitySnapshot(records, now);
}

export function markLoadedFromInstructionSources(
  snapshot: RuntimeSkillVisibilitySnapshot,
  instructionSources: string[],
  now = Date.now(),
): RuntimeSkillVisibilitySnapshot {
  if (instructionSources.length === 0 || snapshot.skills.length === 0) {
    return snapshot;
  }

  const normalizedSources = new Set(instructionSources.map(normalizePathForMatch));
  const records = snapshot.skills.map((skill): RuntimeSkillVisibilityRecord => {
    const matchedPath = findMatchingInstructionSource(skill, normalizedSources, instructionSources);
    if (!matchedPath) {
      return skill;
    }

    return {
      ...skill,
      state: "loaded",
      confidence: "observed",
      evidence: [
        ...(skill.evidence ?? []),
        {
          kind: "instruction-source",
          observedAt: now,
          path: matchedPath,
        },
      ],
      loadedAt: skill.loadedAt ?? now,
      lastSeenAt: now,
    };
  });

  return buildSkillVisibilitySnapshot(records, now);
}

export function markLoadedFromRaviSkillToolCall(
  snapshot: RuntimeSkillVisibilitySnapshot,
  input: RaviSkillToolCallInput,
): RuntimeSkillVisibilitySnapshot {
  const now = input.now ?? Date.now();
  const loadedSkill = detectLoadedSkillFromRaviSkillToolCall(snapshot, input);
  if (!loadedSkill) {
    return snapshot;
  }

  const loadedSlug = slugifySkillName(loadedSkill.id);
  let found = false;
  const loadedRecord = (skill: RuntimeSkillVisibilityRecord): RuntimeSkillVisibilityRecord => ({
    ...skill,
    id: skill.id || loadedSkill.id,
    state: "loaded",
    confidence: "observed",
    source: skill.source ?? loadedSkill.source,
    evidence: [
      ...(skill.evidence ?? []),
      {
        kind: "tool-call",
        observedAt: now,
        path: loadedSkill.path,
        eventType: "ravi.skills.show",
        turnId: input.metadata?.turn?.id,
        itemId: input.metadata?.item?.id,
        detail: loadedSkill.detail,
      },
    ],
    loadedAt: skill.loadedAt ?? now,
    lastSeenAt: now,
  });

  const records = snapshot.skills.map((skill) => {
    if (skill.id === loadedSkill.id || slugifySkillName(skill.id) === loadedSlug) {
      found = true;
      return loadedRecord(skill);
    }
    return skill;
  });

  if (!found) {
    records.push(
      loadedRecord({
        id: loadedSkill.id,
        provider: input.provider,
        state: "loaded",
        confidence: "observed",
        source: loadedSkill.source,
        loadedAt: now,
        lastSeenAt: now,
      }),
    );
  }

  return buildSkillVisibilitySnapshot(records, now);
}

export function markLoadedFromSkillGate(
  snapshot: RuntimeSkillVisibilitySnapshot,
  input: SkillGateLoadedInput,
): RuntimeSkillVisibilitySnapshot {
  const now = input.now ?? Date.now();
  const loadedSlug = slugifySkillName(input.skill);
  let found = false;

  const loadedRecord = (skill: RuntimeSkillVisibilityRecord): RuntimeSkillVisibilityRecord => ({
    ...skill,
    id: skill.id || input.skill,
    state: "loaded",
    confidence: "observed",
    source: skill.source ?? input.source,
    evidence: [
      ...(skill.evidence ?? []),
      {
        kind: "skill-gate",
        observedAt: now,
        path: input.path,
        eventType: "runtime.skill-gate.loaded",
        detail: input.toolName ? `delivered by skill gate for ${input.toolName}` : "delivered by skill gate",
      },
    ],
    loadedAt: skill.loadedAt ?? now,
    lastSeenAt: now,
  });

  const records = snapshot.skills.map((skill) => {
    if (skill.id === input.skill || slugifySkillName(skill.id) === loadedSlug) {
      found = true;
      return loadedRecord(skill);
    }
    return skill;
  });

  if (!found) {
    records.push(
      loadedRecord({
        id: input.skill,
        provider: input.provider,
        state: "loaded",
        confidence: "observed",
        source: input.source,
        loadedAt: now,
        lastSeenAt: now,
      }),
    );
  }

  return buildSkillVisibilitySnapshot(records, now);
}

export function resetLoadedSkillVisibilitySnapshot(
  snapshot: RuntimeSkillVisibilitySnapshot,
  now = Date.now(),
): RuntimeSkillVisibilitySnapshot {
  if (snapshot.skills.length === 0) {
    return { ...snapshot, loadedSkills: [], updatedAt: now };
  }

  const records = snapshot.skills.map((skill): RuntimeSkillVisibilityRecord => {
    if (skill.state !== "loaded") {
      return { ...skill, lastSeenAt: now };
    }
    return {
      ...skill,
      state: "stale",
      confidence: "observed",
      evidence: [
        ...(skill.evidence ?? []),
        {
          kind: "provider-event",
          observedAt: now,
          detail: "loaded skill reset by session compaction",
        },
      ],
      loadedAt: null,
      lastSeenAt: now,
    };
  });

  return buildSkillVisibilitySnapshot(records, now);
}

export function readSkillVisibilityFromParams(params: Record<string, unknown> | null | undefined) {
  const raw = params?.skillVisibility;
  if (!isRecord(raw)) {
    return emptySkillVisibilitySnapshot();
  }

  const skills = Array.isArray(raw.skills)
    ? raw.skills
        .filter(isRecord)
        .map((record): RuntimeSkillVisibilityRecord | null => {
          const id = typeof record.id === "string" ? record.id : "";
          const provider = typeof record.provider === "string" ? record.provider : "";
          const state = typeof record.state === "string" ? record.state : "unknown";
          const confidence = typeof record.confidence === "string" ? record.confidence : "unknown";
          const lastSeenAt = typeof record.lastSeenAt === "number" ? record.lastSeenAt : Date.now();
          if (!id || !provider || !isSkillState(state) || !isSkillConfidence(confidence)) {
            return null;
          }
          return {
            id,
            provider,
            state,
            confidence,
            source: typeof record.source === "string" ? record.source : undefined,
            evidence: Array.isArray(record.evidence)
              ? record.evidence
                  .filter(isRecord)
                  .map(normalizeEvidence)
                  .filter((value): value is RuntimeSkillVisibilityEvidence => Boolean(value))
              : undefined,
            loadedAt: typeof record.loadedAt === "number" ? record.loadedAt : null,
            lastSeenAt,
          };
        })
        .filter((record): record is RuntimeSkillVisibilityRecord => Boolean(record))
    : [];

  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now();
  return buildSkillVisibilitySnapshot(skills, updatedAt);
}

function listPluginSkills(plugins: RuntimePlugin[]): PluginSkillDescriptor[] {
  const skills: PluginSkillDescriptor[] = [];
  for (const plugin of plugins) {
    const pluginName = readPluginName(plugin.path);
    const skillsDir = join(plugin.path, "skills");
    if (!existsSync(skillsDir)) {
      continue;
    }

    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillDir = join(skillsDir, entry.name);
      const skillPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillPath)) {
        continue;
      }
      const content = readFileSync(skillPath, "utf8");
      const skillName = extractSkillName(content) ?? entry.name;
      skills.push({
        id: skillName,
        source: `plugin:${pluginName}/${entry.name}`,
        path: skillPath,
      });
    }
  }
  return skills;
}

function detectLoadedSkillFromRaviSkillToolCall(
  snapshot: RuntimeSkillVisibilitySnapshot,
  input: RaviSkillToolCallInput,
): LoadedSkillDescriptor | null {
  const outputSkill = parseSkillFromShowOutput(input.output);
  const dedicatedToolSkill = extractDedicatedSkillShowName(input.toolName, input.toolInput);
  const command = extractCommandFromToolInput(input.toolInput);
  const commandSkill = command ? extractSkillShowNameFromCommand(command) : null;
  if (!dedicatedToolSkill && !commandSkill) {
    return null;
  }
  const requestedName = outputSkill?.name ?? dedicatedToolSkill ?? commandSkill;

  if (!requestedName) {
    return null;
  }

  const resolved = outputSkill ?? resolveLocalSkill(requestedName);
  const id = resolveLoadedSkillId(input.provider, snapshot, {
    requestedName,
    commandSkill,
    dedicatedToolSkill,
    outputSkill,
    resolved,
  });
  return {
    id,
    source: resolved?.source,
    path: resolved?.skillFilePath ?? (input.provider === "codex" ? join(codexSkillsDir(), id, "SKILL.md") : undefined),
    detail: command ? clipDetail(command) : `tool=${input.toolName ?? "unknown"}`,
  };
}

function resolveLoadedSkillId(
  provider: RuntimeProviderId,
  snapshot: RuntimeSkillVisibilitySnapshot,
  input: {
    requestedName: string;
    commandSkill?: string | null;
    dedicatedToolSkill?: string | null;
    outputSkill?: ShowSkillDescriptor | null;
    resolved?: ShowSkillDescriptor | null;
  },
): string {
  const candidates = [
    input.commandSkill,
    input.dedicatedToolSkill,
    input.requestedName,
    input.outputSkill?.name,
    managedSkillAlias(input.outputSkill),
    input.resolved?.name,
    managedSkillAlias(input.resolved),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const candidateSlug = slugifySkillName(candidate);
    const existing = snapshot.skills.find(
      (skill) => skill.id === candidate || slugifySkillName(skill.id) === candidateSlug,
    );
    if (existing) {
      return existing.id;
    }
  }

  const managedAlias = managedSkillAlias(input.resolved ?? input.outputSkill);
  if (provider === "codex" && managedAlias) {
    return managedAlias;
  }
  return input.outputSkill?.name ?? input.resolved?.name ?? input.requestedName;
}

function extractDedicatedSkillShowName(toolName: string | undefined, toolInput: unknown): string | null {
  const normalized = toolName?.trim().toLowerCase().replace(/[-.]/g, "_");
  if (!normalized || !["skills_show", "ravi_skills_show"].includes(normalized)) {
    return null;
  }
  if (!isRecord(toolInput)) {
    return null;
  }
  return firstNonEmptyString(toolInput.name, toolInput.skill, toolInput.skillName, toolInput.id);
}

function extractCommandFromToolInput(toolInput: unknown): string | null {
  if (typeof toolInput === "string" && toolInput.trim()) {
    return toolInput.trim();
  }
  if (!isRecord(toolInput)) {
    return null;
  }
  return firstNonEmptyString(toolInput.command, toolInput.cmd, toolInput.script, toolInput.commandLine);
}

function extractSkillShowNameFromCommand(command: string): string | null {
  const match = /(?:^|[\s"'`])(?:\.\/)?(?:bin\/ravi|ravi|\/[^\s"'`]+\/bin\/ravi)\s+skills\s+show\b([^;&\n\r]*)/m.exec(
    command,
  );
  if (!match) {
    return null;
  }

  const tokens = shellishTokens(match[1] ?? "");
  const optionsWithValue = new Set(["--source", "-s"]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (optionsWithValue.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("--source=")) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token;
  }
  return null;
}

function parseSkillFromShowOutput(output: unknown): ShowSkillDescriptor | null {
  if (isRecord(output)) {
    const skill = isRecord(output.skill) ? output.skill : output;
    return parseSkillRecord(skill);
  }

  const text = outputToText(output);
  if (!text) {
    return null;
  }

  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      const skill = isRecord(parsed?.skill) ? parsed.skill : parsed;
      const parsedSkill = parseSkillRecord(skill);
      if (parsedSkill) {
        return parsedSkill;
      }
    } catch {
      // Fall through to human output parsing.
    }
  }

  const header = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!header) {
    return null;
  }
  const path = /^Path:\s+(.+)$/m.exec(text)?.[1]?.trim();
  const resolved = resolveLocalSkill(header);
  return {
    name: resolved?.name ?? header,
    source: resolved?.source,
    skillFilePath: resolved?.skillFilePath ?? (path ? join(path, "SKILL.md") : undefined),
  };
}

function parseSkillRecord(record: Record<string, unknown>): ShowSkillDescriptor | null {
  const name = firstNonEmptyString(record.name);
  if (!name) {
    return null;
  }
  return {
    name,
    source: firstNonEmptyString(record.source) ?? undefined,
    pluginName: firstNonEmptyString(record.pluginName, record.plugin_name) ?? undefined,
    skillFilePath:
      firstNonEmptyString(record.skillFilePath, record.skill_file_path) ??
      (typeof record.path === "string" && record.path.trim() ? join(record.path.trim(), "SKILL.md") : undefined),
  };
}

function resolveLocalSkill(name: string): ShowSkillDescriptor | null {
  const skill = findSkillByName(listCatalogSkills(), name) ?? findInstalledSkill(name);
  if (!skill) {
    return null;
  }
  return {
    name: skill.name,
    source: skill.source,
    skillFilePath: skill.skillFilePath,
    pluginName: skill.pluginName,
  };
}

function managedSkillAlias(skill: ShowSkillDescriptor | null | undefined): string | null {
  if (!skill?.pluginName) {
    return null;
  }
  const pluginSlug = codexManagedSlug(skill.pluginName);
  const skillSlug = codexManagedSlug(skill.name);
  return pluginSlug && skillSlug ? `${pluginSlug}-${skillSlug}` : null;
}

function codexManagedSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function outputToText(output: unknown): string | null {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    const text = output
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : null))
      .filter((value): value is string => Boolean(value))
      .join("\n");
    return text || null;
  }
  return null;
}

function shellishTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | `"` | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === `"`) {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function clipDetail(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function readPluginName(pluginPath: string): string {
  const manifestPath = join(pluginPath, ".codex-plugin", "plugin.json");
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.trim()) {
        return parsed.name.trim();
      }
    } catch {
      // Fall through to directory name.
    }
  }
  return basename(pluginPath);
}

function extractSkillName(content: string): string | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1];
  const match = frontmatter?.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || null;
}

function findMatchingInstructionSource(
  skill: RuntimeSkillVisibilityRecord,
  normalizedSources: Set<string>,
  originalSources: string[],
): string | null {
  const candidates = new Set<string>();
  for (const evidence of skill.evidence ?? []) {
    if (evidence.path) {
      candidates.add(normalizePathForMatch(evidence.path));
    }
  }
  candidates.add(normalizePathForMatch(join(codexSkillsDir(), skill.id, "SKILL.md")));

  for (const candidate of candidates) {
    if (!normalizedSources.has(candidate)) {
      continue;
    }
    return originalSources.find((source) => normalizePathForMatch(source) === candidate) ?? candidate;
  }
  return null;
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function stateRank(state: RuntimeSkillVisibilityState): number {
  switch (state) {
    case "unknown":
      return 0;
    case "available":
      return 1;
    case "synced":
      return 2;
    case "advertised":
      return 3;
    case "requested":
      return 4;
    case "stale":
      return 5;
    case "loaded":
      return 6;
  }
}

function normalizeEvidence(record: Record<string, unknown>): RuntimeSkillVisibilityEvidence | null {
  if (typeof record.kind !== "string" || !isEvidenceKind(record.kind)) {
    return null;
  }
  return {
    kind: record.kind,
    observedAt: typeof record.observedAt === "number" ? record.observedAt : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    eventType: typeof record.eventType === "string" ? record.eventType : undefined,
    eventId: typeof record.eventId === "string" ? record.eventId : undefined,
    turnId: typeof record.turnId === "string" ? record.turnId : undefined,
    itemId: typeof record.itemId === "string" ? record.itemId : undefined,
    detail: typeof record.detail === "string" ? record.detail : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSkillState(value: string): value is RuntimeSkillVisibilityState {
  return ["available", "synced", "advertised", "requested", "loaded", "stale", "unknown"].includes(value);
}

function isSkillConfidence(value: string): value is RuntimeSkillVisibilityConfidence {
  return ["observed", "inferred", "declared", "unknown"].includes(value);
}

function isEvidenceKind(value: string): value is RuntimeSkillVisibilityEvidence["kind"] {
  return [
    "provider-event",
    "tool-call",
    "sync-manifest",
    "system-prompt",
    "control-api",
    "rpc-state",
    "plugin-bootstrap",
    "instruction-source",
  ].includes(value);
}
