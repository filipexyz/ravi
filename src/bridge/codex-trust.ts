import { ensureCodexHookGuard, type CodexHookGuardSend } from "../runtime/codex-hook-guard.js";

const BRIDGE_ERRORS: Record<string, string> = {
  "missing guard": "Missing bridge guard",
  "cannot inspect hooks": "Cannot inspect bridge guard",
  "unexpected hooks": "Unexpected bridge hooks",
  "gate is not trusted": "Bridge guard is not trusted",
};

function bridgeError(reason: string): string {
  if (BRIDGE_ERRORS[reason]) return BRIDGE_ERRORS[reason];
  if (reason.startsWith("hooks/list")) return "Cannot inspect bridge guard";
  if (reason.startsWith("cannot trust gate")) return "Bridge guard is not trusted";
  return "Invalid bridge guard";
}

/** Trust only the exact Ravi guard generated in this private provider profile. */
export async function ensureBridgeCodexGuard(send: CodexHookGuardSend, cwd: string, configDir: string) {
  await ensureCodexHookGuard(send, cwd, configDir, {
    humanBridge: true,
    fail: (reason) => new Error(bridgeError(reason)),
  });
}
