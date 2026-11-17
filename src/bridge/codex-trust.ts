import { realpathSync } from "node:fs";
import { ensureCodexBashHookConfig } from "../runtime/codex-hooks.js";

type Send = (
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<Record<string, unknown>>;

/** Trust only the exact Ravi guard generated in this private provider profile. */
export async function ensureBridgeCodexGuard(send: Send, cwd: string, configDir: string) {
  const expected = ensureCodexBashHookConfig(configDir, true);
  const command = JSON.parse(expected.signature).hooks.PreToolUse.find(
    (group: { matcher: string }) => group.matcher === ".*",
  )?.hooks[0]?.command;
  if (typeof command !== "string") throw new Error("Missing bridge guard");
  const list = async () => {
    const response = await send("hooks/list", { cwds: [cwd] }, { timeoutMs: 10_000 });
    const entries = response.data as Array<{ cwd: string; errors: unknown[]; hooks: Array<Record<string, unknown>> }>;
    if (!Array.isArray(entries) || entries.length !== 1 || entries[0]!.errors.length)
      throw new Error("Cannot inspect bridge guard");
    const hooks = entries[0]!.hooks;
    // This profile must not introduce any other executable hook.
    if (hooks.length !== 1) throw new Error("Unexpected bridge hooks");
    const hook = hooks[0]!;
    if (
      hook.handlerType !== "command" ||
      hook.command !== command ||
      hook.matcher !== ".*" ||
      hook.eventName !== "preToolUse" ||
      !hook.enabled ||
      hook.async === true ||
      typeof hook.sourcePath !== "string" ||
      realpathSync(hook.sourcePath) !== realpathSync(expected.path) ||
      typeof hook.key !== "string" ||
      typeof hook.currentHash !== "string"
    )
      throw new Error("Invalid bridge guard");
    return hook;
  };
  const before = await list();
  if (before.trustStatus !== "trusted") {
    await send(
      "config/batchWrite",
      {
        edits: [
          {
            keyPath: `hooks.state.${JSON.stringify(before.key)}.trusted_hash`,
            value: before.currentHash,
            mergeStrategy: "replace",
          },
        ],
      },
      { timeoutMs: 10_000 },
    );
  }
  const after = await list();
  if (after.trustStatus !== "trusted" || after.currentHash !== before.currentHash)
    throw new Error("Bridge guard is not trusted");
}
