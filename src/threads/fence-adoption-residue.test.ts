import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  collectJetStreamResidue,
  collectSqliteResidue,
  LEGACY_RESIDUE_EXCLUSIONS,
  LEGACY_ROUTER_RESIDUE_RULES,
  legacyResidueRules,
  mergeResidue,
  type ResidueRule,
} from "./fence-adoption-residue.js";

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

  it("legacy rules cover the outboxes: uncertain decisions are durable, an unowned mail lease blocks", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE decision_deliveries (id TEXT, status TEXT NOT NULL)");
    db.exec("CREATE TABLE mail_outbox (id TEXT, status TEXT NOT NULL)");
    db.exec("CREATE TABLE jobs (id TEXT, status TEXT NOT NULL)");
    for (const status of ["delivered", "uncertain", "published", "accepting"])
      db.query("INSERT INTO decision_deliveries VALUES (?, ?)").run(status, status);
    db.exec("INSERT INTO mail_outbox VALUES ('m1', 'sent'), ('m2', 'leased')");
    db.exec("INSERT INTO jobs VALUES ('j1', 'running'), ('j2', 'succeeded')");
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    expect(residue.unknown).toEqual(["mail_outbox.status=leased (1): resumption not verified"]);
    const byTable = Object.fromEntries(residue.sources.map((entry) => [entry.source, entry]));
    expect(byTable["decision_deliveries.status"]).toMatchObject({ pending: 1, inFlight: 2 });
    expect(byTable["jobs.status"]).toMatchObject({ pending: 0, inFlight: 1 });
    expect(byTable["runtime_prompt_queue.status"]).toMatchObject({ detail: { table: "absent" } });
    expect(LEGACY_RESIDUE_EXCLUSIONS.map((entry) => entry.table)).toContain("session_turns");
  });

  it("adapters left running, answered library requests and restart snapshots do not block; a dead handoff does", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE session_adapters (adapter_id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO session_adapters VALUES ('a1', 'running'), ('a2', 'stopped')");
    db.exec("CREATE TABLE library_agent_requests (id TEXT, status TEXT NOT NULL)");
    db.exec(
      "INSERT INTO library_agent_requests VALUES ('r1', 'answered'), ('r2', 'open'), ('r3', 'queued'), ('r4', 'expired')",
    );
    db.exec("CREATE TABLE thread_handoffs (id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO thread_handoffs VALUES ('h1', 'delivered'), ('h2', 'queued')");
    db.exec(
      "CREATE TABLE daemon_restart_session_snapshots (restart_epoch TEXT, session_key TEXT, pending_message_count INTEGER NOT NULL)",
    );
    db.exec("INSERT INTO daemon_restart_session_snapshots VALUES ('e1', 's1', 2), ('e1', 's2', 0)");
    db.exec("CREATE TABLE reaction_actions (id TEXT, completed_at INTEGER NOT NULL)");
    db.exec("INSERT INTO reaction_actions VALUES ('x', 5)");
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    const bySource = Object.fromEntries(residue.sources.map((source) => [source.source, source]));
    expect(residue.unknown).toEqual(["ravi.db:thread_handoffs.status=queued (1): resumption not verified"]);
    expect(bySource["ravi.db:session_adapters.status"]).toMatchObject({ pending: 0, inFlight: 1 });
    expect(bySource["ravi.db:library_agent_requests.status"]).toMatchObject({ pending: 1, inFlight: 1 });
    // Counted in the evidence: one session snapshot with pending messages.
    expect(bySource["ravi.db:daemon_restart_session_snapshots.pending_message_count"]).toMatchObject({ pending: 1 });
    expect(bySource["ravi.db:reaction_actions.completed_at"]).toMatchObject({ pending: 0, inFlight: 0 });
  });

  it("a cleanly closed WAL database (no -wal/-shm) is read without creating any file", () => {
    const directory = root();
    const path = join(directory, "ravi.db");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE runtime_prompt_queue (id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO runtime_prompt_queue VALUES ('a', 'queued')");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    // What the last connection of a stopped runtime leaves on Linux; macOS may keep empty files.
    for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const residue = collectSqliteResidue([queueRule(path)]);
    expect(residue.unknown).toEqual([]);
    expect(residue.sources[0]).toMatchObject({ pending: 1, inFlight: 0 });
    expect(readdirSync(directory).sort()).toEqual(["ravi.db"]);
  });

  it("an unreadable database is unknown, and the probe never creates or changes a file", () => {
    const path = join(root(), "ravi.db");
    writeFileSync(path, "not a database");
    const residue = collectSqliteResidue([queueRule(path)]);
    expect(residue.unknown).toHaveLength(1);
    expect(residue.unknown[0]).toContain("runtime_prompt_queue.status: unreadable");
  });
});

describe("legacy broker residue", () => {
  const reader = (streams: Record<string, number | null>, consumers: Record<string, [number, number] | null>) => ({
    streamMessages: async (stream: string) => {
      if (stream === "BROKEN") throw new Error("timeout");
      return streams[stream] ?? null;
    },
    consumerPending: async (stream: string, consumer: string) => {
      const value = consumers[`${stream}/${consumer}`];
      return value ? { pending: value[0], ackPending: value[1] } : null;
    },
  });

  it("durable queues and consumers count as pending with their owner", async () => {
    const residue = await collectJetStreamResidue(
      reader({ SESSION_PROMPTS: 0, CHANNEL_OUTBOUND: 3 }, { "MESSAGE/ravi-messages": [2, 1] }),
    );
    expect(residue.unknown).toEqual([]);
    expect(residue.sources).toContainEqual(
      expect.objectContaining({ source: "jetstream:CHANNEL_OUTBOUND", pending: 3 }),
    );
    expect(residue.sources).toContainEqual(
      expect.objectContaining({ source: "jetstream:MESSAGE/ravi-messages", pending: 2, inFlight: 1 }),
    );
    expect(residue.sources).toContainEqual(
      expect.objectContaining({ source: "jetstream:INSTANCE/ravi-instances", detail: { consumer: "absent" } }),
    );
  });

  it("prompts left in the memory-only session stream are not durable and block", async () => {
    const residue = await collectJetStreamResidue(reader({ SESSION_PROMPTS: 2 }, {}));
    expect(residue.unknown).toEqual([
      "jetstream:SESSION_PROMPTS: 2 prompt(s) in memory storage expire in 60 s and are not durable",
    ]);
  });

  it("an unreachable broker is unknown, and residues merge without losing either side", async () => {
    const broker = await collectJetStreamResidue(reader({}, {}), [
      { kind: "workqueue-durable", stream: "BROKEN", owner: "x" },
    ]);
    expect(broker.unknown).toEqual(["jetstream:BROKEN: unreadable (timeout)"]);
    const merged = mergeResidue(broker, { sources: [{ source: "a", pending: 1, inFlight: 0 }], unknown: [] });
    expect(merged).toEqual({ sources: [{ source: "a", pending: 1, inFlight: 0 }], unknown: broker.unknown });
  });
});
