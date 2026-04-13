import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GENERATED_AGENTS_BRIDGE_MARKER = "<!-- ravi:generated:agents-bridge -->";
const GENERATED_CLAUDE_BRIDGE_MARKER = "<!-- ravi:generated:claude-bridge -->";
const SIMPLE_LEGACY_AGENTS_BRIDGE = "@CLAUDE.md";
const SIMPLE_CLAUDE_COMPAT_BRIDGE = "@AGENTS.md";
const LEGACY_REPO_AGENTS_BRIDGE = [
  "# AGENTS.md",
  "",
  "This workspace uses `./CLAUDE.md` as the authoritative instruction file.",
  "",
  "Before doing any work here:",
  "",
  "1. Read `./CLAUDE.md`",
  "2. Follow it as the primary operating guide for this repo",
  "3. Treat any CLI/runtime hierarchy rules there as canonical",
  "",
  "@CLAUDE.md",
].join("\n");

export interface AgentInstructionPaths {
  claudePath: string;
  agentsPath: string;
}

export interface AgentInstructionSyncResult {
  createdClaude: boolean;
  createdAgents: boolean;
  updatedClaude: boolean;
  updatedAgents: boolean;
}

export interface AgentWorkspaceInstructions {
  path: string;
  content: string;
}

export type AgentInstructionState =
  | "missing-both"
  | "agents-only"
  | "claude-only"
  | "agents-canonical"
  | "legacy-claude-canonical"
  | "duplicated-custom"
  | "divergent-custom-both"
  | "agents-bridge-only"
  | "claude-bridge-only"
  | "double-bridge";

export interface AgentInstructionInspection {
  state: AgentInstructionState;
  agents: AgentWorkspaceInstructions | null;
  claude: AgentWorkspaceInstructions | null;
}

export function getAgentInstructionPaths(cwd: string): AgentInstructionPaths {
  return {
    claudePath: join(cwd, "CLAUDE.md"),
    agentsPath: join(cwd, "AGENTS.md"),
  };
}

export function buildGeneratedAgentsBridge(): string {
  return [
    GENERATED_AGENTS_BRIDGE_MARKER,
    "# AGENTS.md",
    "",
    "This file is managed by Ravi for workspace instruction compatibility.",
    "The authoritative workspace instructions for this agent live in `./CLAUDE.md`.",
    "Before doing any work, read `./CLAUDE.md` and follow it as the primary instruction file for this workspace.",
    "",
    "@CLAUDE.md",
    "",
  ].join("\n");
}

export function buildGeneratedClaudeBridge(): string {
  return [
    GENERATED_CLAUDE_BRIDGE_MARKER,
    "# CLAUDE.md",
    "",
    "This file is managed by Ravi for Claude SDK compatibility.",
    "The authoritative workspace instructions for this agent live in `./AGENTS.md`.",
    "Before doing any work, read `./AGENTS.md` and follow it as the primary instruction file for this workspace.",
    "",
    "@AGENTS.md",
    "",
  ].join("\n");
}

export function isGeneratedAgentsBridge(content: string): boolean {
  return content.includes(GENERATED_AGENTS_BRIDGE_MARKER);
}

export function isGeneratedClaudeBridge(content: string): boolean {
  return content.includes(GENERATED_CLAUDE_BRIDGE_MARKER);
}

export function isLegacyAgentsBridge(content: string): boolean {
  const normalized = normalizeInstructionContent(content);
  return (
    normalized === SIMPLE_LEGACY_AGENTS_BRIDGE ||
    normalized === LEGACY_REPO_AGENTS_BRIDGE ||
    isGeneratedAgentsBridge(normalized)
  );
}

export function isClaudeCompatibilityBridge(content: string): boolean {
  const normalized = normalizeInstructionContent(content);
  return normalized === SIMPLE_CLAUDE_COMPAT_BRIDGE || isGeneratedClaudeBridge(normalized);
}

export function inspectAgentInstructionFiles(cwd: string): AgentInstructionInspection {
  const { claudePath, agentsPath } = getAgentInstructionPaths(cwd);
  const agents = readInstructionFileIfExists(agentsPath)
    ? {
        path: agentsPath,
        content: readInstructionFileIfExists(agentsPath)!,
      }
    : null;
  const claude = readInstructionFileIfExists(claudePath)
    ? {
        path: claudePath,
        content: readInstructionFileIfExists(claudePath)!,
      }
    : null;

  if (!agents && !claude) {
    return { state: "missing-both", agents, claude };
  }

  if (agents && !claude) {
    return {
      state: isLegacyAgentsBridge(agents.content) ? "agents-bridge-only" : "agents-only",
      agents,
      claude,
    };
  }

  if (!agents && claude) {
    return {
      state: isClaudeCompatibilityBridge(claude.content) ? "claude-bridge-only" : "claude-only",
      agents,
      claude,
    };
  }

  const agentsIsBridge = isLegacyAgentsBridge(agents!.content);
  const claudeIsBridge = isClaudeCompatibilityBridge(claude!.content);

  if (!agentsIsBridge && claudeIsBridge) {
    return { state: "agents-canonical", agents, claude };
  }

  if (agentsIsBridge && !claudeIsBridge) {
    return { state: "legacy-claude-canonical", agents, claude };
  }

  if (agentsIsBridge && claudeIsBridge) {
    return { state: "double-bridge", agents, claude };
  }

  return {
    state:
      normalizeInstructionContent(agents!.content) === normalizeInstructionContent(claude!.content)
        ? "duplicated-custom"
        : "divergent-custom-both",
    agents,
    claude,
  };
}

export function ensureAgentInstructionFiles(
  cwd: string,
  options: { createAgentsStub?: string; createClaudeStub?: string } = {},
): AgentInstructionSyncResult {
  mkdirSync(cwd, { recursive: true });

  const { claudePath, agentsPath } = getAgentInstructionPaths(cwd);
  let createdClaude = false;
  let createdAgents = false;
  let updatedClaude = false;
  let updatedAgents = false;

  const desiredCanonicalStub = options.createAgentsStub ?? options.createClaudeStub;
  const desiredClaudeBridge = buildGeneratedClaudeBridge();
  const before = inspectAgentInstructionFiles(cwd);

  const canonicalAgentsContent =
    before.agents && !isLegacyAgentsBridge(before.agents.content)
      ? before.agents.content
      : before.claude && !isClaudeCompatibilityBridge(before.claude.content)
        ? before.claude.content
        : (desiredCanonicalStub ?? null);

  if ((!before.agents || isLegacyAgentsBridge(before.agents.content)) && canonicalAgentsContent) {
    if (!before.agents) {
      writeFileSync(agentsPath, canonicalAgentsContent);
      createdAgents = true;
    } else if (
      normalizeInstructionContent(before.agents.content) !== normalizeInstructionContent(canonicalAgentsContent)
    ) {
      writeFileSync(agentsPath, canonicalAgentsContent);
      updatedAgents = true;
    }
  }

  const afterAgents = readInstructionFileIfExists(agentsPath);
  const originalClaude = before.claude?.content ?? null;
  const originalAgents = before.agents?.content ?? null;
  const originalAgentsWasBridge = originalAgents ? isLegacyAgentsBridge(originalAgents) : false;
  const claudeCanBecomeBridge =
    !!afterAgents &&
    (!originalClaude ||
      isClaudeCompatibilityBridge(originalClaude) ||
      originalAgentsWasBridge ||
      normalizeInstructionContent(originalClaude) === normalizeInstructionContent(afterAgents));

  if (afterAgents && claudeCanBecomeBridge) {
    const currentClaude = readInstructionFileIfExists(claudePath);
    if (!currentClaude) {
      writeFileSync(claudePath, desiredClaudeBridge);
      createdClaude = true;
    } else if (normalizeInstructionContent(currentClaude) !== normalizeInstructionContent(desiredClaudeBridge)) {
      writeFileSync(claudePath, desiredClaudeBridge);
      updatedClaude = true;
    }
  }

  return { createdClaude, createdAgents, updatedClaude, updatedAgents };
}

export async function loadAgentWorkspaceInstructions(cwd: string): Promise<AgentWorkspaceInstructions | null> {
  ensureAgentInstructionFiles(cwd);

  const { claudePath, agentsPath } = getAgentInstructionPaths(cwd);
  const agents = await tryReadInstructionFile(agentsPath);
  const claude = await tryReadInstructionFile(claudePath);

  if (agents && !isLegacyAgentsBridge(agents.content)) {
    return agents;
  }

  if (claude && !isClaudeCompatibilityBridge(claude.content)) {
    return claude;
  }

  return agents ?? claude;
}

function readInstructionFileIfExists(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }

  return readFileSync(path, "utf8");
}

async function tryReadInstructionFile(path: string): Promise<AgentWorkspaceInstructions | null> {
  try {
    const content = (await readFile(path, "utf8")).trim();
    if (content.length > 0) {
      return { path, content };
    }
  } catch {}

  return null;
}

function normalizeInstructionContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}
