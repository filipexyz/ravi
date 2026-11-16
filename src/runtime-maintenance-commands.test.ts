import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { withoutRaviRuntimeContextEnv } from "./test/ravi-state.js";

it.each([
  ["daemon", "start", "new DaemonCommands().start(true)"],
  ["daemon", "restart", 'new DaemonCommands().restart("isolated test", false, true)'],
  ["channels", "start", "new ChannelsCommands().start(false, true)"],
  ["channels", "restart", "new ChannelsCommands().restart(false, true)"],
])(
  "%s %s refuses legacy preparation before handoff or PM2 mutation",
  (group, _action, invocation) => {
    const root = mkdtempSync(join(tmpdir(), "ravi-maintenance-native-control-"));
    const stateDir = join(root, "state");
    const bin = join(root, "bin");
    const log = join(root, "pm2.log");
    const bundle = join(root, "bundle.js");
    mkdirSync(stateDir);
    mkdirSync(bin);
    writeFileSync(log, "");
    writeFileSync(bundle, "throw new Error('preparation must prevent launch');");
    const pm2 = join(bin, "pm2");
    writeFileSync(pm2, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_PM2_LOG"\nprintf "[]\\n"\n');
    chmodSync(pm2, 0o755);
    const db = new Database(join(stateDir, "ravi.db"));
    db.exec("CREATE TABLE accepted_work (id TEXT); INSERT INTO accepted_work VALUES ('retained')");
    db.close();
    const klass = group === "daemon" ? "DaemonCommands" : "ChannelsCommands";
    const module = new URL(`./cli/commands/${group}.ts`, import.meta.url).href;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--no-env-file",
          "--eval",
          `
      import { ${klass} } from ${JSON.stringify(module)};
      try { await ${invocation}; process.exitCode = 2; }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `,
        ],
        {
          env: {
            ...withoutRaviRuntimeContextEnv(process.env),
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            RAVI_STATE_DIR: stateDir,
            RAVI_BUNDLE: bundle,
            TEST_PM2_LOG: log,
          },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("THREAD_SCHEMA_FENCED");
      expect(readFileSync(log, "utf8")).not.toMatch(/^(?:start|delete|restart|save)\b/m);
      const after = new Database(join(stateDir, "ravi.db"), { readonly: true, create: false });
      try {
        expect(after.query("SELECT * FROM accepted_work").all()).toEqual([{ id: "retained" }]);
        expect(after.query("SELECT name FROM sqlite_master WHERE name='thread_schema_fence'").get()).toBeNull();
      } finally {
        after.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
