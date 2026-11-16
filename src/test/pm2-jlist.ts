import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// PM2's lib/binaries/CLI.js prints this before jlist when manager/client versions differ.
export const OUTDATED_PM2_BANNER = `
>>>> In-memory PM2 is out-of-date, do:
>>>> $ pm2 update
In memory PM2 version: 7.1.1
Local PM2 version: 7.1.2

`;

/** A fresh child keeps Bun's executable lookup isolated as well as its environment. */
export function runWithPm2Jlist(raw: string, script: string) {
  const root = mkdtempSync(join(tmpdir(), "ravi-pm2-jlist-fixture-"));
  try {
    mkdirSync(join(root, "pm2-home"));
    const executable = join(root, "pm2");
    writeFileSync(join(root, "jlist.txt"), raw);
    const probe = join(root, "probe.ts");
    writeFileSync(probe, script);
    writeFileSync(executable, '#!/bin/sh\n[ "$1" = "jlist" ] || exit 1\n/bin/cat "$PM2_HOME/../jlist.txt"\n');
    chmodSync(executable, 0o755);
    return spawnSync(process.execPath, [probe], {
      cwd: process.cwd(),
      env: {
        PATH: root,
        PM2_HOME: join(root, "pm2-home"),
        RAVI_STATE_DIR: join(root, "state"),
        RAVI_CREDENTIALS_PATH: join(root, "credentials.json"),
        RAVI_SUPPRESS_AUDIT_EVENTS: "1",
        NATS_URL: "nats://127.0.0.1:1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
