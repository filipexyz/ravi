import { expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreCompactHook } from "./pre-compact.js";

// The memory agent is a Claude Code process. Without an explicit `env`, the SDK
// spawns it with `{...process.env}`, the whole daemon env. A fake Claude Code
// records the env names and the flags it actually received, so the test checks
// the spawn, not what the code meant to pass.
// It needs the real SDK `query`: another test file that mocks the SDK in the
// same process leaves the fake executable never started (see the ledger check).
it("spawns the memory agent with the provider env filter and the tool limit, not the daemon env", async () => {
  const root = mkdtempSync(join(tmpdir(), "ravi-pre-compact-env-"));
  const agentCwd = join(root, "agent");
  mkdirSync(agentCwd);
  const ledger = join(root, "env.json");
  const executable = join(root, "fake-claude");
  writeFileSync(
    executable,
    // process.execPath in the shebang: the filtered PATH need not hold `node`.
    // Written to a temp name and renamed, so the test never reads a half-written ledger.
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(`${ledger}.tmp`)}, JSON.stringify({ env: Object.keys(process.env), argv: process.argv.slice(2) }));
fs.renameSync(${JSON.stringify(`${ledger}.tmp`)}, ${JSON.stringify(ledger)});
process.exit(1);
`,
  );
  chmodSync(executable, 0o755);
  const transcriptPath = join(root, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "lembra disso" }] },
      timestamp: "2026-11-19T10:00:00Z",
    })}\n`,
  );

  const dropped = {
    RAVI_ADMIN_TOKEN: "canary-admin",
    ACME_API_KEY: "canary-acme",
    // Another provider's login: only Codex may inherit it.
    OPENAI_API_KEY: "canary-openai",
  };
  const kept = { CLAUDE_CODE_OAUTH_TOKEN: "canary-claude-login" };
  const saved = Object.fromEntries(Object.keys({ ...dropped, ...kept }).map((name) => [name, process.env[name]]));
  Object.assign(process.env, dropped, kept);
  try {
    const hook = createPreCompactHook({ memoryModel: "haiku", pathToClaudeCodeExecutable: executable });
    await hook(
      {
        hook_event_name: "PreCompact",
        session_id: "pre-compact-env",
        transcript_path: transcriptPath,
        cwd: agentCwd,
        trigger: "auto",
        custom_instructions: null,
      },
      null,
      { signal: new AbortController().signal },
    );

    const deadline = Date.now() + 15_000;
    while (!existsSync(ledger) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(existsSync(ledger), "fake Claude Code never ran: was the SDK mocked by another test file?").toBe(true);
    const { env: names, argv }: { env: string[]; argv: string[] } = JSON.parse(readFileSync(ledger, "utf8"));
    for (const name of Object.keys(dropped)) {
      expect(names).not.toContain(name);
    }
    // Claude Code still logs in from the daemon env, as a real Claude turn does.
    expect(names).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(names).toContain("PATH");

    // The tool limit is `tools` (removes the tools), not `allowedTools` (auto-approves).
    // Dropping any of these flags gives the memory agent Bash again.
    expect(argv).toContain("--tools=Read,Edit,Write");
    expect(argv).toContain("--allowedTools=Read,Edit,Write");
    expect(argv).toContain("--permission-mode=dontAsk");
    expect(argv.some((arg) => arg.startsWith("--setting-sources"))).toBe(true);
    expect(argv.find((arg) => arg.startsWith("--setting-sources"))).toMatch(/^--setting-sources(=|$)/);
    expect(argv).not.toContain("--allow-dangerously-skip-permissions");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.some((arg) => arg.startsWith("--permission-mode=bypass"))).toBe(false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
