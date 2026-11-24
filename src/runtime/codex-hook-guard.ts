import { realpathSync } from "node:fs";
import { ensureCodexBashHookConfig, RAVI_CODEX_BASH_HOOK_MATCHER } from "./codex-hooks.js";

export type CodexHookGuardSend = (
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<Record<string, unknown>>;

export const CODEX_BASH_GATE_UNVERIFIED_MESSAGE =
  "Codex did not confirm the Ravi Bash permission gate is loaded, enabled and trusted. Refusing to run an ungoverned Codex session.";

export class CodexBashGateUnverifiedError extends Error {
  readonly failureKind = "transport" as const;

  constructor(readonly reason: string) {
    super(`${CODEX_BASH_GATE_UNVERIFIED_MESSAGE} (${reason})`);
    this.name = "CodexBashGateUnverifiedError";
  }
}

export interface CodexHookGuardOptions {
  /** Private human-bridge profile: `.*` matcher, and no other hook may exist. */
  humanBridge?: boolean;
  /** Error raised on any failed check; defaults to CodexBashGateUnverifiedError. */
  fail?: (reason: string) => Error;
}

type ListedHook = Record<string, unknown>;

/**
 * Asks the app-server which hooks it loaded for `cwd` and requires the Ravi
 * PreToolUse gate written to `configDir` to be there: same command, matcher and
 * file, enabled, synchronous and trusted. An untrusted gate is trusted for its
 * exact current hash only (the file Ravi just wrote), then checked again.
 * Throws when any of that cannot be confirmed, so the caller fails closed.
 */
export async function ensureCodexHookGuard(
  send: CodexHookGuardSend,
  cwd: string,
  configDir: string | undefined,
  options: CodexHookGuardOptions = {},
): Promise<ListedHook> {
  const humanBridge = options.humanBridge === true;
  const fail = options.fail ?? ((reason: string) => new CodexBashGateUnverifiedError(reason));
  const expected = ensureCodexBashHookConfig(configDir, humanBridge);
  const matcher = humanBridge ? ".*" : RAVI_CODEX_BASH_HOOK_MATCHER;
  const command = JSON.parse(expected.signature).hooks.PreToolUse.find(
    (group: { matcher: string }) => group.matcher === matcher,
  )?.hooks?.[0]?.command;
  if (typeof command !== "string") throw fail("missing guard");
  const expectedPath = safeRealpath(expected.path);

  const list = async (): Promise<ListedHook> => {
    let response: Record<string, unknown>;
    try {
      response = await send("hooks/list", { cwds: [cwd] }, { timeoutMs: 10_000 });
    } catch (error) {
      throw fail(`hooks/list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = response.data as Array<{ cwd: string; errors: unknown[]; hooks: ListedHook[] }>;
    if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]!.hooks))
      throw fail("cannot inspect hooks");
    if (humanBridge && Array.isArray(entries[0]!.errors) && entries[0]!.errors.length)
      throw fail("cannot inspect hooks");
    const hooks = entries[0]!.hooks;
    // The private bridge profile must not introduce any other executable hook.
    if (humanBridge && hooks.length !== 1) throw fail("unexpected hooks");
    const candidates = hooks.filter(
      (hook) =>
        hook.command === command ||
        (typeof hook.sourcePath === "string" &&
          expectedPath !== null &&
          safeRealpath(hook.sourcePath) === expectedPath),
    );
    if (candidates.length === 0) throw fail("gate not loaded");
    if (candidates.length !== 1) throw fail("ambiguous gate");
    const hook = candidates[0]!;
    if (
      hook.handlerType !== "command" ||
      hook.command !== command ||
      hook.matcher !== matcher ||
      hook.eventName !== "preToolUse" ||
      !hook.enabled ||
      hook.async === true ||
      typeof hook.sourcePath !== "string" ||
      expectedPath === null ||
      safeRealpath(hook.sourcePath) !== expectedPath ||
      typeof hook.key !== "string" ||
      typeof hook.currentHash !== "string"
    )
      throw fail("invalid gate");
    return hook;
  };

  const before = await list();
  if (before.trustStatus === "trusted") return before;
  try {
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
  } catch (error) {
    throw fail(`cannot trust gate: ${error instanceof Error ? error.message : String(error)}`);
  }
  const after = await list();
  if (after.trustStatus !== "trusted" || after.currentHash !== before.currentHash) throw fail("gate is not trusted");
  return after;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
