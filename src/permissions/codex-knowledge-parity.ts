// Codex parity for Knowledge (contract §13.10): a codex agent on `chat-only`
// (or `explicit-only` without exec) must not reach more than the other
// runtimes give it. Codex ships native tools Ravi's Bash hook never sees
// (`apply_patch`, `web_search`, `view_image`); only the thread config can take
// them away. The contact packet and the curator refuse codex agents unless
// `codexKnowledgeParityHolds()` is true.

import {
  buildCodexThreadSecurity,
  type CodexSandboxMode,
  type CodexThreadSecurity,
} from "../runtime/codex-provider.js";

/** Every native tool a Codex thread advertises (no MCP servers, no dynamic tools: Ravi passes none). */
export const CODEX_NATIVE_TOOLS = ["shell", "apply_patch", "update_plan", "web_search", "view_image"] as const;
export type CodexNativeTool = (typeof CODEX_NATIVE_TOOLS)[number];

/**
 * What a restricted codex thread may still use: `shell` goes through Ravi's
 * Bash hook (`codex-hooks.ts`, which denies chat-only and no-exec agents) and
 * runs in the read-only sandbox; `update_plan` only edits the turn's plan.
 */
export const CODEX_KNOWLEDGE_ALLOWED_TOOLS: readonly CodexNativeTool[] = ["shell", "update_plan"];

/**
 * The native tools a thread built with this sandbox and config can use.
 * `apply_patch` writes files, so the read-only sandbox denies it; the two
 * network/file readers are on unless the config turns them off.
 */
export function codexUsableNativeTools(input: {
  sandbox: CodexSandboxMode | string | null | undefined;
  config: Record<string, unknown> | null | undefined;
}): CodexNativeTool[] {
  const config = input.config ?? {};
  const readOnly = input.sandbox === "read-only";
  return CODEX_NATIVE_TOOLS.filter((tool) => {
    switch (tool) {
      case "apply_patch":
        return !readOnly;
      case "web_search":
        return config["tools.web_search"] !== false && config.web_search !== "disabled";
      case "view_image":
        return config["tools.view_image"] !== false;
      default:
        return true;
    }
  });
}

function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

/** True when this thread security leaves exactly the allowed tools. */
export function codexSecurityHoldsKnowledgeParity(security: Pick<CodexThreadSecurity, "sandbox" | "config">): boolean {
  return sameToolSet(codexUsableNativeTools(security), CODEX_KNOWLEDGE_ALLOWED_TOOLS);
}

/**
 * A pure check of the config builder: for `chat-only` and for `explicit-only`
 * without exec capabilities, the thread Ravi builds advertises exactly the
 * allowed tools. Never throws.
 */
export function codexKnowledgeParityHolds(): boolean {
  try {
    const restrictedConfigs = [
      { profile: "chat-only" as const },
      { profile: "explicit-only" as const },
      { profile: "explicit-only" as const, capabilities: ["read:knowledge:*", "mutate:knowledge:remember"] },
    ];
    return restrictedConfigs.every((config) => {
      const security = buildCodexThreadSecurity(config);
      return security.restricted && codexSecurityHoldsKnowledgeParity(security);
    });
  } catch {
    return false;
  }
}
