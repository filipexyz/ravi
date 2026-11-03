// Library agent version -> the provider-neutral definition a cloud provider
// deploys. Pure: no database, no provider, no clock.

import { createHash } from "node:crypto";

import { type CloudBlock, CloudDefinitionError, type CloudEffort, parseCloudBlock } from "./definition";
import { cloudError } from "./errors";

export const CLOUD_DEFAULT_MODEL = "claude-sonnet-5-5";
export const CLOUD_OUTPUTS_DIR = "/mnt/session/outputs";

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};
const CLAUDE_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,100}$/;
const SKILL_REF = /^(?:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/)?([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

export const CLOUD_PREAMBLE = [
  "You run in a Ravi cloud run: a disposable container started for one task, on behalf of the person who started it.",
  `Write every deliverable (reports, files, exports) to ${CLOUD_OUTPUTS_DIR}; the person downloads them from the Ravi Console.`,
  "Ravi tools (projects, pages, bases, knowledge, contacts) are on the `ravi` MCP server.",
  "A person approves each write you make through Ravi tools. If a write is denied or not approved, do not retry it; say what you would have done.",
].join("\n");

export type CloudSourceFile = { path: string; content: string };

/** A Library skill version the agent's `skills` resolved to. */
export type CloudSkillSource = {
  ref: string;
  itemId: string;
  versionId: string;
  versionNumber: number | null;
  slug: string;
  name: string;
  description: string;
  contentHash: string;
  files: readonly CloudSourceFile[];
};

export type CompiledCloudSkill = Omit<CloudSkillSource, "files" | "description" | "name"> & { name: string };

export type CompiledCloudAgent = {
  system: string;
  model: string;
  effort: CloudEffort | null;
  budgetUsd: number;
  environment: CloudBlock["environment"];
  raviMcp: boolean;
  mcpServers: { name: string; url: string }[];
  webSearch: boolean;
  writes: CloudBlock["tools"]["writes"];
  repositories: CloudBlock["repositories"];
  schedule: CloudBlock["schedule"];
  heartbeat: string | null;
  skills: CompiledCloudSkill[];
  warnings: string[];
  compiledHash: string;
};

/** The skill references of `agent.json` the caller must resolve in the Library. */
export function cloudSkillRefs(files: readonly CloudSourceFile[]) {
  const manifest = readManifest(files);
  const refs: string[] = [];
  for (const ref of manifestSkills(manifest)) {
    if (SKILL_REF.exec(ref)?.[1] && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

export function compileCloudAgent(input: {
  files: readonly CloudSourceFile[];
  skills?: ReadonlyMap<string, CloudSkillSource>;
}): CompiledCloudAgent {
  const agents = input.files.find((file) => file.path === "AGENTS.md")?.content;
  if (!agents?.trim()) throw cloudError("cloud_agent_definition_invalid", "The agent has no AGENTS.md.");
  const heartbeat = input.files.find((file) => file.path === "HEARTBEAT.md")?.content.trim() || null;
  const manifest = readManifest(input.files);

  const provider = manifest.provider;
  if (provider !== undefined && provider !== null && provider !== "claude") {
    throw cloudError(
      "cloud_agent_provider_unsupported",
      `agent.json provider is ${JSON.stringify(provider)}; cloud agents run on Claude Managed Agents, so the provider must be claude or unset.`,
      { reason: "provider", provider },
    );
  }

  let block: CloudBlock;
  try {
    block = parseCloudBlock(manifest.cloud);
  } catch (error) {
    if (error instanceof CloudDefinitionError) throw cloudError("cloud_agent_definition_invalid", `agent.json ${error.message}`);
    throw error;
  }

  const requested = block.model ?? (typeof manifest.model === "string" ? manifest.model : null);
  const model = resolveModel(requested);

  const skills: CompiledCloudSkill[] = [];
  const warnings: string[] = [];
  for (const ref of manifestSkills(manifest)) {
    if (!SKILL_REF.exec(ref)?.[1]) {
      warnings.push(`Skill ${ref} ships with the Ravi CLI and is not available in cloud runs.`);
      continue;
    }
    const skill = input.skills?.get(ref);
    if (!skill) {
      throw cloudError("cloud_agent_definition_invalid", `agent.json requires ${ref}, which has no published version visible to this project.`, {
        skill: ref,
      });
    }
    skills.push({
      ref,
      itemId: skill.itemId,
      versionId: skill.versionId,
      versionNumber: skill.versionNumber,
      slug: skill.slug,
      name: skill.name,
      contentHash: skill.contentHash,
    });
  }

  const compiled = {
    system: `${CLOUD_PREAMBLE}\n\n${agents.trim()}\n`,
    model,
    effort: block.effort,
    budgetUsd: block.budgetUsd,
    environment: block.environment,
    raviMcp: block.mcp.ravi,
    mcpServers: block.mcp.servers,
    webSearch: block.tools.webSearch,
    writes: block.tools.writes,
    repositories: block.repositories,
    schedule: block.schedule,
    heartbeat,
    skills,
    warnings,
  };
  return { ...compiled, compiledHash: sha256Hex(canonicalJson(compiled)) };
}

export function resolveModel(requested: string | null): string {
  if (!requested) return CLOUD_DEFAULT_MODEL;
  const alias = MODEL_ALIASES[requested.toLowerCase()];
  if (alias) return alias;
  if (CLAUDE_MODEL.test(requested)) return requested;
  throw cloudError(
    "cloud_agent_provider_unsupported",
    `Model ${JSON.stringify(requested)} does not run on Claude Managed Agents; use opus, sonnet, haiku or a claude-* model id.`,
    { reason: "model", model: requested },
  );
}

/** Stable JSON: object keys sorted at every depth, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readManifest(files: readonly CloudSourceFile[]): Record<string, unknown> {
  const content = files.find((file) => file.path === "agent.json")?.content;
  if (content === undefined) return {};
  try {
    const value = JSON.parse(content);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw cloudError("cloud_agent_definition_invalid", "agent.json is not a JSON object.");
}

function manifestSkills(manifest: Record<string, unknown>) {
  return Array.isArray(manifest.skills) ? manifest.skills.filter((ref): ref is string => typeof ref === "string") : [];
}
