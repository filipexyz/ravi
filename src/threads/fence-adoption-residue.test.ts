import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  collectJetStreamResidue,
  collectSqliteResidue,
  LEGACY_RESIDUE_EXCLUSIONS,
  LEGACY_ROUTER_RESIDUE_RULES,
  legacyResidueRules,
  mergeResidue,
  RESTART_REASON_FILE,
  RESTART_RESUME_WINDOW_MS,
  type ResidueRule,
  readRestartEpoch,
  restartSnapshotResidue,
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

  it("adapters left running and answered library requests do not block; a dead handoff does", () => {
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
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    const bySource = Object.fromEntries(residue.sources.map((source) => [source.source, source]));
    expect(residue.unknown).toEqual(["ravi.db:thread_handoffs.status=queued (1): resumption not verified"]);
    expect(bySource["ravi.db:session_adapters.status"]).toMatchObject({ pending: 0, inFlight: 1 });
    expect(bySource["ravi.db:library_agent_requests.status"]).toMatchObject({ pending: 1, inFlight: 1 });
  });

  it("a refused call tool is final, a stale approval claim waits, an unexpired lease says until when", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE call_tool_runs (id TEXT, status TEXT NOT NULL)");
    // Tag tool-bridge.ts l.400-429: a policy refusal is written blocked, reported, and never written again.
    db.exec("INSERT INTO call_tool_runs VALUES ('t1', 'blocked'), ('t2', 'completed')");
    // Tag chat-db.ts l.369: a click's claim of a stopped process is reopened after 2 min; it waits for a person.
    db.exec("CREATE TABLE cloud_chat_approvals (approval_id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO cloud_chat_approvals VALUES ('a1', 'deciding'), ('a2', 'approved')");
    const until = Date.now() + 120_000;
    db.exec("CREATE TABLE pr_publication_leases (id TEXT, expires_at INTEGER NOT NULL)");
    db.exec(`INSERT INTO pr_publication_leases VALUES ('old', 1), ('live', ${until})`);
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    const bySource = Object.fromEntries(residue.sources.map((source) => [source.source, source]));
    expect(residue.unknown.filter((entry) => entry.includes("call_tool_runs"))).toEqual([]);
    expect(residue.unknown).toHaveLength(1);
    expect(residue.unknown[0]).toStartWith(
      `ravi.db:pr_publication_leases.expires_at: 1 row(s) where expires_at > ?: wait until ${new Date(until).toISOString()} (the latest expires_at), then retry; `,
    );
    expect(bySource["ravi.db:call_tool_runs.status"]).toMatchObject({ pending: 0, inFlight: 0 });
    expect(bySource["ravi.db:cloud_chat_approvals.status"]).toMatchObject({ pending: 1, inFlight: 0 });
  });

  it("seventh review, B1: Slack turns in flight and threads being created are carried; a dead admission blocks", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE slack_thread_turn_health (request_id TEXT, state TEXT NOT NULL)");
    // Every Slack thread with a turn in flight at the stop: recomputed by the gateway reconciliation.
    db.exec("INSERT INTO slack_thread_turn_health VALUES ('r1', 'running'), ('r2', 'idle')");
    db.exec("CREATE TABLE slack_thread_lifecycle (request_id TEXT, status TEXT NOT NULL)");
    db.exec(
      "INSERT INTO slack_thread_lifecycle VALUES ('a', 'queued'), ('b', 'root_delivered'), ('c', 'starting'), ('d', 'open')",
    );
    db.exec("CREATE TABLE slack_thread_attention_notices (event_id TEXT, admission_status TEXT NOT NULL)");
    db.exec(
      "INSERT INTO slack_thread_attention_notices VALUES ('n1', 'pending'), ('n2', 'refused'), ('n3', 'accepting'), ('n4', 'admitted')",
    );
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    const bySource = Object.fromEntries(residue.sources.map((source) => [source.source, source]));
    expect(residue.unknown).toHaveLength(1);
    expect(residue.unknown[0]).toStartWith("ravi.db:slack_thread_attention_notices.admission_status=accepting (1): ");
    expect(
      String(
        (bySource["ravi.db:slack_thread_attention_notices.admission_status"]?.detail as { owner?: string } | undefined)
          ?.owner,
      ),
    ).toContain("the RUNBOOK settle step for this table");
    expect(bySource["ravi.db:slack_thread_turn_health.state"]).toMatchObject({ pending: 0, inFlight: 1 });
    expect(bySource["ravi.db:slack_thread_lifecycle.status"]).toMatchObject({ pending: 0, inFlight: 3 });
    expect(bySource["ravi.db:slack_thread_attention_notices.admission_status"]).toMatchObject({
      pending: 2,
      inFlight: 0,
    });
  });

  it("seventh review, B2: remote mirrors and derived states do not block; a call the stop caught points at the call settle step", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    for (const table of ["devin_sessions", "cloud_thread_runs", "workflow_runs", "workflow_node_runs", "call_runs"])
      db.exec(`CREATE TABLE ${table} (id TEXT, status TEXT NOT NULL)`);
    db.exec("INSERT INTO devin_sessions VALUES ('d1', 'running'), ('d2', 'creating'), ('d3', 'exit')");
    db.exec("INSERT INTO cloud_thread_runs VALUES ('c1', 'running'), ('c2', 'starting')");
    db.exec("INSERT INTO workflow_runs VALUES ('w1', 'running'), ('w2', 'ready')");
    db.exec("INSERT INTO workflow_node_runs VALUES ('n1', 'running')");
    db.exec("INSERT INTO call_runs VALUES ('k1', 'in_progress')");
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    const bySource = Object.fromEntries(residue.sources.map((source) => [source.source, source]));
    expect(residue.unknown).toEqual(["ravi.db:call_runs.status=in_progress (1): resumption not verified"]);
    expect(String((bySource["ravi.db:call_runs.status"]?.detail as { owner?: string } | undefined)?.owner)).toContain(
      "the RUNBOOK settle step for calls",
    );
    expect(bySource["ravi.db:devin_sessions.status"]).toMatchObject({ pending: 2, inFlight: 0 });
    expect(bySource["ravi.db:cloud_thread_runs.status"]).toMatchObject({ pending: 0, inFlight: 2 });
    expect(bySource["ravi.db:workflow_runs.status"]).toMatchObject({ pending: 0, inFlight: 2 });
    expect(bySource["ravi.db:workflow_node_runs.status"]).toMatchObject({ pending: 0, inFlight: 1 });
  });

  it("seventh review, B3: a credential attempt the stop leaves started is a record, not a block", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE runtime_credential_attempts (id TEXT, status TEXT NOT NULL, completed_at INTEGER)");
    // The legacy stop does not wait for the turn's finally (tag bot.ts l.192, l.212-223).
    db.exec(
      "INSERT INTO runtime_credential_attempts VALUES ('a1', 'started', NULL), ('a2', 'reserved', NULL), ('a3', 'abandoned', 9)",
    );
    db.close();
    const residue = collectSqliteResidue(legacyResidueRules(path));
    expect(residue.unknown).toEqual([]);
    expect(
      residue.sources.find((source) => source.source === "ravi.db:runtime_credential_attempts.status"),
    ).toMatchObject({
      pending: 2,
      inFlight: 0,
    });
  });

  it("seventh review: runtime state, receipts, cron runs and outboxes block with their settle step; reactions and reminders are excluded", () => {
    const path = join(root(), "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE channel_backend_runtime_state (turn_id TEXT, state TEXT NOT NULL)");
    db.exec("INSERT INTO channel_backend_runtime_state VALUES ('t1', 'running'), ('t2', 'completed')");
    db.exec("CREATE TABLE channel_outbound_receipts (idempotency_key TEXT, state TEXT NOT NULL)");
    db.exec("INSERT INTO channel_outbound_receipts VALUES ('k1', 'sent'), ('k2', 'complete')");
    db.exec("CREATE TABLE cron_runs (id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO cron_runs VALUES ('c1', 'pending')");
    db.exec("CREATE TABLE mail_outbox (id TEXT, status TEXT NOT NULL)");
    db.exec("INSERT INTO mail_outbox VALUES ('m1', 'sending')");
    // One SQLite transaction claims and completes a reaction (tag policy/reaction-actions.ts l.132-176).
    db.exec("CREATE TABLE reaction_actions (id TEXT, completed_at INTEGER NOT NULL)");
    db.exec("INSERT INTO reaction_actions VALUES ('done', 5)");
    db.close();
    const residue = collectSqliteResidue(
      legacyResidueRules(path).filter((rule) =>
        ["channel_backend_runtime_state", "channel_outbound_receipts", "cron_runs", "mail_outbox"].includes(rule.table),
      ),
    );
    expect(residue.unknown.sort()).toEqual([
      "channel_backend_runtime_state.state=running (1): resumption not verified",
      "channel_outbound_receipts.state=sent (1): resumption not verified",
      "cron_runs.status=pending (1): resumption not verified",
      "mail_outbox.status=sending (1): resumption not verified",
    ]);
    for (const source of residue.sources)
      expect(String((source.detail as { owner?: string } | undefined)?.owner)).toContain(
        "the RUNBOOK settle step for this table",
      );
    const excluded = new Set(LEGACY_RESIDUE_EXCLUSIONS.map((entry) => entry.table));
    expect(excluded.has("reaction_actions")).toBe(true);
    expect(excluded.has("calendar_event_reminders")).toBe(true);
    expect(legacyResidueRules(path).some((rule) => rule.table === "reaction_actions")).toBe(false);
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

describe("restart snapshots (CodeRabbit r4595928941)", () => {
  const T = 1_800_000_000_000;
  function legacyRestartState(epoch: string | null) {
    const directory = root();
    const databasePath = join(directory, "ravi.db");
    const db = new Database(databasePath);
    db.exec("CREATE TABLE sessions (session_key TEXT PRIMARY KEY, ephemeral INTEGER DEFAULT 0, expires_at INTEGER)");
    db.exec(
      "CREATE TABLE daemon_restart_session_snapshots (restart_epoch TEXT NOT NULL, session_key TEXT NOT NULL, session_name TEXT NOT NULL, non_idle INTEGER NOT NULL DEFAULT 0, stopped_at INTEGER NOT NULL, pending_message_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (restart_epoch, session_key))",
    );
    db.exec(
      "CREATE TABLE daemon_restart_resume_deliveries (restart_epoch TEXT NOT NULL, session_key TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY (restart_epoch, session_key))",
    );
    db.exec("INSERT INTO sessions VALUES ('s1', 0, NULL), ('s2', 0, NULL), ('s4', 1, 1)");
    // An older epoch with pending messages, history: never the stop's own.
    db.exec(`INSERT INTO daemon_restart_session_snapshots VALUES ('old', 's1', 'one', 1, ${T - 86_400_000}, 3)`);
    // The stop's epoch: one session to resume, one already delivered, one whose session is gone,
    // one expired ephemeral session.
    db.exec(
      `INSERT INTO daemon_restart_session_snapshots VALUES ('stop', 's1', 'one', 1, ${T}, 2), ('stop', 's2', 'two', 1, ${T}, 1), ('stop', 's3', 'three', 1, ${T}, 4), ('stop', 's4', 'four', 1, ${T}, 1)`,
    );
    db.exec(`INSERT INTO daemon_restart_resume_deliveries VALUES ('stop', 's2', ${T + 1})`);
    db.close();
    const restartReasonPath = join(directory, "restart-reason.txt");
    if (epoch)
      writeFileSync(
        restartReasonPath,
        JSON.stringify({ reason: "supervised_restart", restartEpoch: epoch, createdAt: T }),
      );
    return { databasePath, restartReasonPath };
  }

  it("the stop's epoch is carried inside the window and blocks past it, with the successor's eligibility", () => {
    const state = legacyRestartState("stop");
    const inside = restartSnapshotResidue({ ...state, now: T + 5 * 60_000 });
    expect(inside.unknown).toEqual([]);
    // s1 only: s2 was delivered, s3 has no session, s4 is an expired ephemeral session.
    expect(inside.sources[0]).toMatchObject({
      inFlight: 1,
      detail: { epoch: "stop", sessions: 1, pendingMessages: 2 },
    });
    // The successor's read 51 minutes after the stop: less than the 10-minute margin is left.
    const late = restartSnapshotResidue({ ...state, now: T + 51 * 60_000 });
    expect(late.unknown).toHaveLength(1);
    expect(late.unknown[0]).toContain("are past the 60-minute resume window less 10 min of margin");
    expect(late.sources[0]).toMatchObject({ inFlight: 0 });
  });

  it("without an epoch the successor resumes nothing: this stop's snapshots block whatever their age, older ones are history", () => {
    const state = legacyRestartState(null);
    expect(readRestartEpoch(state.restartReasonPath)).toBeNull();
    // The stopped daemon started an hour before the stop: its snapshots are those at or after that.
    const stoppedProcessStartedAt = T - 3_600_000;
    for (const now of [T + 60_000, T + 5 * RESTART_RESUME_WINDOW_MS]) {
      const residue = restartSnapshotResidue({ ...state, now, stoppedProcessStartedAt });
      expect(residue.unknown).toHaveLength(1);
      expect(residue.unknown[0]).toContain("snapshotted by this adoption's stop");
      expect(residue.unknown[0]).toContain("restart-reason.txt names no epoch");
    }
    // The epoch of a day before belongs to an earlier process: history, never this stop's.
    expect(restartSnapshotResidue({ ...state, now: T + 60_000, stoppedProcessStartedAt: T + 1 }).unknown).toEqual([]);
    // Without the adoption record (no stopped process known) the last 60 minutes stand in for it.
    expect(restartSnapshotResidue({ ...state, now: T + 60_000 }).unknown).toHaveLength(1);
    expect(restartSnapshotResidue({ ...state, now: T + RESTART_RESUME_WINDOW_MS + 60_000 }).unknown).toEqual([]);
    // A start time that is not a positive integer cannot bound this stop's snapshots: refused, not guessed.
    for (const invalid of [0, -1, Number.NaN, 1.5])
      expect(
        restartSnapshotResidue({ ...state, now: T + 60_000, stoppedProcessStartedAt: invalid }).unknown[0],
      ).toContain("start time that is not a positive integer");
    writeFileSync(state.restartReasonPath, "plain text reason");
    expect(readRestartEpoch(state.restartReasonPath)).toBeNull();
  });

  it("the reason file, the window and the eligibility match this release's daemon and router", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "daemon.ts"), "utf8");
    expect(daemon).toContain('const RESTART_REASON_FILE = join(homedir(), ".ravi", "restart-reason.txt");');
    expect(daemon).toContain("const RESTART_RESUME_WINDOW_MS = 60 * 60 * 1000;");
    expect(RESTART_REASON_FILE).toBe(join(homedir(), ".ravi", "restart-reason.txt"));
    const router = readFileSync(join(import.meta.dir, "..", "router", "router-db.ts"), "utf8");
    for (const fragment of [
      "JOIN sessions live_sessions ON live_sessions.session_key = snapshots.session_key",
      "AND snapshots.non_idle = 1",
      "AND snapshots.stopped_at >= ?",
      "(live_sessions.ephemeral = 0 OR live_sessions.expires_at IS NULL OR live_sessions.expires_at > ?)",
      "WHERE delivered.restart_epoch = snapshots.restart_epoch",
    ])
      expect(router).toContain(fragment);
  });
});
