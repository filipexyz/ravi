import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(new URL("./facade-process-boundary.fixture.ts", import.meta.url));
let stateDir: string | null = null;

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("CRM facade process boundary", () => {
  it("persists applying without a dispatched effect when the process exits after claim", () => {
    stateDir = mkdtempSync(join(tmpdir(), "ravi-crm-facade-process-"));
    const result = spawnSync(process.execPath, [fixturePath], {
      cwd: dirname(dirname(dirname(fixturePath))),
      encoding: "utf8",
      env: {
        ...process.env,
        RAVI_STATE_DIR: stateDir,
        RAVI_SUPPRESS_AUDIT_EVENTS: "1",
      },
    });

    expect(result.status).toBe(73);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");

    const database = new Database(join(stateDir, "chat.db"), { readonly: true });
    const plans = database
      .query("SELECT plan_id, state FROM crm_facade_plans ORDER BY created_at DESC")
      .all() as Array<{ plan_id: string; state: string }>;
    const effects = database.query("SELECT effect_id FROM crm_facade_effects").all();
    database.close();

    expect(plans).toHaveLength(1);
    expect(plans[0]?.state).toBe("applying");
    expect(effects).toHaveLength(0);
  });
});
