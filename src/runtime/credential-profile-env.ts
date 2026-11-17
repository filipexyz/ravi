/**
 * Credential profile environment helpers.
 *
 * Leaf module: pure helpers shared by the daemon request builder and the
 * runtime liveness probe. Keep it free of daemon imports so CLI paths (and
 * their test harnesses) can use the probe without dragging the full
 * runtime-request-builder graph.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeProviderId } from "./types.js";

export function buildRuntimeCredentialProfileEnv(
  runtimeProviderId: RuntimeProviderId,
  binding: Pick<RuntimeCredentialAttemptBinding, "authProfileRef"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const authProfileRef = binding?.authProfileRef?.trim();
  if (!authProfileRef) return undefined;
  const profilePath = expandHomePath(authProfileRef);
  if (runtimeProviderId === "codex") {
    return { CODEX_HOME: profilePath };
  }
  if (runtimeProviderId === "claude") {
    // Claude Code keys its stored login on whether CLAUDE_CONFIG_DIR is set, not
    // only on the directory it names. Naming the default directory explicitly
    // makes it look for a different login than the one the operator created by
    // logging in normally, so the default profile must stay implicit.
    if (!env.CLAUDE_CONFIG_DIR?.trim() && isDefaultClaudeProfilePath(profilePath)) return undefined;
    return { CLAUDE_CONFIG_DIR: profilePath };
  }
  return undefined;
}

function isDefaultClaudeProfilePath(profilePath: string): boolean {
  return resolve(profilePath) === resolve(homedir(), ".claude");
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}${value.slice(1)}`;
  return value;
}

export function formatRuntimeCredentialResolutionFailure(
  runtimeProviderId: RuntimeProviderId,
  model: string | undefined,
  rejected: Array<{ label: string; reason: string }>,
): string {
  const reasonSummary = rejected
    .slice(0, 5)
    .map((item) => `${item.label}: ${item.reason}`)
    .join("; ");
  const suffix = reasonSummary ? ` Rejected credentials: ${reasonSummary}.` : "";
  return `No managed runtime credential could be resolved for provider ${runtimeProviderId}${model ? ` model ${model}` : ""}.${suffix}`;
}
