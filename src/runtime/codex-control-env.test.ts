import { expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRuntimeProvider } from "./codex-provider.js";

it("stored-session control spawns Codex without the daemon's secrets", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-control-env-"));
  const command = join(cwd, "fake-codex.mjs");
  const ledger = join(cwd, "env.json");
  writeFileSync(
    command,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(${JSON.stringify(ledger)}, JSON.stringify(Object.keys(process.env)));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") return send({id:message.id,result:{}});
  return send({id:message.id,result:{goal:null}});
});
`,
  );
  chmodSync(command, 0o755);
  const secrets = { RAVI_ADMIN_TOKEN: "canary-admin", ACME_API_KEY: "canary-acme", GEMINI_API_KEY: "canary-gemini" };
  const saved = Object.fromEntries(Object.keys(secrets).map((name) => [name, process.env[name]]));
  Object.assign(process.env, secrets);
  try {
    const provider = createCodexRuntimeProvider({ command });
    await provider.controlSession!(
      { cwd, sessionId: "thread_fixture", sessionParams: { codexHome: cwd }, env: { RAVI_CODEX_TRANSPORT: "stdio" } },
      { operation: "goal.get" },
    );

    const names: string[] = JSON.parse(readFileSync(ledger, "utf8"));
    for (const name of Object.keys(secrets)) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("PATH");
    expect(names).toContain("CODEX_HOME");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});
