import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { collectSqliteResidue, LEGACY_ROUTER_RESIDUE_RULES, type ResidueRule } from "./fence-adoption-residue.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ravi-fence-residue-"));
  roots.push(path);
  return path;
}

const queueRule = (database: string): ResidueRule => ({ ...LEGACY_ROUTER_RESIDUE_RULES[0]!, database });

describe("legacy durable residue", () => {
  it("counts pending and in-flight work by status and ignores terminal rows", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE runtime_prompt_queue (id TEXT, status TEXT NOT NULL)");
    for (const status of ["complete", "failed", "queued", "queued", "leased", "delivered"])
      db.query("INSERT INTO runtime_prompt_queue VALUES (?, ?)").run(status, status);
    db.close();
    const residue = collectSqliteResidue([queueRule(path)]);
    expect(residue.unknown).toEqual([]);
    expect(residue.sources).toEqual([
      expect.objectContaining({ source: "runtime_prompt_queue.status", pending: 2, inFlight: 2 }),
    ]);
  });

  it("a status outside the rule is unknown and blocks", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE runtime_prompt_queue (id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO runtime_prompt_queue VALUES ('a', 'mystery')");
    db.close();
    expect(collectSqliteResidue([queueRule(path)]).unknown).toEqual(["runtime_prompt_queue.status=mystery (1)"]);
  });

  it("an absent database or table persisted no work of that kind", () => {
    const directory = root();
    const absent = collectSqliteResidue([queueRule(join(directory, "never.db"))]);
    expect(absent).toEqual({
      sources: [{ source: "runtime_prompt_queue.status", pending: 0, inFlight: 0, detail: { database: "absent" } }],
      unknown: [],
    });
    const path = join(directory, "ravi.db");
    new Database(path).close();
    expect(collectSqliteResidue([queueRule(path)]).sources[0]).toMatchObject({ detail: { table: "absent" } });
  });

  it("an unreadable database is unknown, and the probe never creates or changes a file", () => {
    const path = join(root(), "ravi.db");
    writeFileSync(path, "not a database");
    const residue = collectSqliteResidue([queueRule(path)]);
    expect(residue.unknown).toHaveLength(1);
    expect(residue.unknown[0]).toContain("runtime_prompt_queue.status: unreadable");
  });
});
