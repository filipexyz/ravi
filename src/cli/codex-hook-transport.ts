import { readFileSync } from "node:fs";
import { buildPreToolUseDenyResult } from "../bash/hook.js";
import { contextCodexBashHookReturnSchema } from "./commands/operational-return-schemas.js";
import { omitRenderingFlags } from "./registry-snapshot.js";
import { dispatchRemote, resolveContextKeyForRemote, type RemoteGatewayConfig } from "./remote-gateway.js";

export function isCodexBashHookCommand(group: string, command: string): boolean {
  return group === "context" && command === "codex-bash-hook";
}

export function codexHookTransportFailure(reason: string): Record<string, unknown> {
  return buildPreToolUseDenyResult(`Codex hook gateway check failed: ${reason}`);
}

/** Keep stdin in the caller process and preserve the provider's fail-closed protocol. */
export async function dispatchRemoteCodexBashHook(
  config: RemoteGatewayConfig,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const contextKey = resolveContextKeyForRemote();
    if (!contextKey) return codexHookTransportFailure("runtime context key is missing");

    const payload = input.payload ?? readFileSync(0, "utf8");
    const result = await dispatchRemote({
      groupSegments: ["context"],
      command: "codex-bash-hook",
      body: { ...omitRenderingFlags(input), payload },
      config,
      contextKey,
      cwd: process.cwd(),
    });
    if (!result.ok) return codexHookTransportFailure(`request rejected (HTTP ${result.status})`);

    const parsed = contextCodexBashHookReturnSchema.safeParse(JSON.parse(result.body));
    if (!parsed.success) return codexHookTransportFailure("invalid hook response");
    return parsed.data;
  } catch {
    // A CLI error/exit 1 is not a PreToolUse denial. Never let missing input,
    // transport errors or malformed responses turn into an implicit allow.
    return codexHookTransportFailure("unable to evaluate the hook");
  }
}
