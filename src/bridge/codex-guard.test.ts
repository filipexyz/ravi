import { afterEach, expect, test } from "bun:test";
import { spawn } from "bun";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBridgeCodexGuard } from "./codex-trust.js";
import { ensureCodexBashHookConfig } from "../runtime/codex-hooks.js";

const dirs: string[] = [];
const temporary = () => {
  const p = mkdtempSync(join(tmpdir(), "bridge-guard-"));
  dirs.push(p);
  return p;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
  const dir = temporary(),
    config = ensureCodexBashHookConfig(dir, true);
  const hook = {
    handlerType: "command",
    command: JSON.parse(config.signature).hooks.PreToolUse[0].hooks[0].command,
    matcher: ".*",
    eventName: "preToolUse",
    enabled: true,
    sourcePath: config.path,
    key: "user:one",
    currentHash: "exact-hash",
    trustStatus: "untrusted",
  };
  const edits: unknown[] = [];
  const send = async (method: string, params: Record<string, unknown>) => {
    if (method === "hooks/list") return { data: [{ cwd: dir, errors: [], hooks: [hook] }] };
    edits.push(params);
    hook.trustStatus = "trusted";
    return {};
  };
  return { dir, hook, edits, send };
}
test("trusts only the generated guard hash and verifies it again", async () => {
  const f = fixture();
  await ensureBridgeCodexGuard(f.send, f.dir, f.dir);
  expect(f.edits).toEqual([
    { edits: [{ keyPath: 'hooks.state."user:one".trusted_hash', value: "exact-hash", mergeStrategy: "replace" }] },
  ]);
  await ensureBridgeCodexGuard(f.send, f.dir, f.dir);
  expect(f.edits).toHaveLength(1);
});
test("refuses a changed command, disabled guard, foreign source or missing trust", async () => {
  for (const change of [
    { command: "echo allowed" },
    { enabled: false },
    { sourcePath: "/etc/hosts" },
    { eventName: "postToolUse" },
    { matcher: "Bash" },
    { async: true },
  ]) {
    const f = fixture();
    Object.assign(f.hook, change);
    await expect(ensureBridgeCodexGuard(f.send, f.dir, f.dir)).rejects.toThrow("Invalid bridge guard");
    expect(f.edits).toHaveLength(0);
  }
  const f = fixture();
  await expect(
    ensureBridgeCodexGuard(
      async (method, params) => (method === "config/batchWrite" ? {} : f.send(method, params)),
      f.dir,
      f.dir,
    ),
  ).rejects.toThrow("not trusted");
});
test("hook process fails closed for CLI errors, malformed JSON and arbitrary allow output", async () => {
  const dir = temporary();
  writeFileSync(join(dir, "hook.ts"), readFileSync(join(import.meta.dir, "codex-hook.ts")));
  for (const [script, denied] of [
    ['console.log("{}");process.exit(3)', true],
    ['console.log("invalid")', true],
    ["console.log(JSON.stringify({allowed:true}))", true],
    ['console.log("{}")', false],
  ] as const) {
    writeFileSync(join(dir, "index.js"), script);
    const child = spawn([process.execPath, join(dir, "hook.ts")], {
      stdin: new Blob(['{"tool_name":"Bash","tool_input":{"command":"printf x"}}']),
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(output.hookSpecificOutput?.permissionDecision === "deny").toBe(denied);
  }
});
