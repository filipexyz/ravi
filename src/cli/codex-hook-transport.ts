import { readFileSync } from "node:fs";
import { buildPreToolUseDenyResult } from "../bash/hook.js";
import { contextCodexBashHookReturnSchema } from "./commands/operational-return-schemas.js";
import { omitRenderingFlags } from "./registry-snapshot.js";
import {
  dispatchRemote,
  remoteGatewayErrorToContractError,
  resolveContextKeyForRemote,
  type RemoteDispatchResult,
  type RemoteGatewayConfig,
} from "./remote-gateway.js";

export function isCodexBashHookCommand(group: string, command: string): boolean {
  return group === "context" && command === "codex-bash-hook";
}

export function codexHookTransportFailure(reason: string): Record<string, unknown> {
  return buildPreToolUseDenyResult(`Codex hook gateway check failed: ${reason}`);
}

const CODEX_HOOK_OP = "context codex-bash-hook";

/**
 * A 401/403 here is not a transport failure: the gateway refused this turn's
 * context. Say so, with the missing capability when the gateway names it, so
 * the agent can tell the person instead of retrying a "gateway error". The
 * gateway's free text stays redacted.
 */
function codexHookRejection(result: RemoteDispatchResult): Record<string, unknown> {
  if (result.status === 401) {
    return buildPreToolUseDenyResult(
      "Ravi refused this turn's context (expired or revoked), so no tool can run in this turn. Stop retrying and tell the person; the next turn gets a fresh context.",
    );
  }
  if (result.status === 403) {
    const error = remoteGatewayErrorToContractError(CODEX_HOOK_OP, result);
    const capability = typeof error?.details.capability === "string" ? error.details.capability : undefined;
    return buildPreToolUseDenyResult(
      [
        `Ravi denied tool use in this turn${capability ? ` (missing capability: ${capability})` : ""}.`,
        "This turn's context has no tool authority: its actor is not identified (no linked contact), or the context expired or was revoked.",
        "Stop retrying tools and tell the person; a turn from an identified person or automation gets its authority back.",
      ].join(" "),
    );
  }
  return codexHookTransportFailure(`request rejected (HTTP ${result.status})`);
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
    if (!result.ok) return codexHookRejection(result);

    const parsed = contextCodexBashHookReturnSchema.safeParse(JSON.parse(result.body));
    if (!parsed.success) return codexHookTransportFailure("invalid hook response");
    return parsed.data;
  } catch {
    // A CLI error/exit 1 is not a PreToolUse denial. Never let missing input,
    // transport errors or malformed responses turn into an implicit allow.
    return codexHookTransportFailure("unable to evaluate the hook");
  }
}
