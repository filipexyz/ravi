import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { BridgeError, type BridgeConversation, type BridgeTurnStatus, type BridgeTeam } from "./protocol.js";

export interface Enrollment {
  id: string;
  orgId: string;
  installationId: string;
  runtimeId: string;
  issuer: string;
  issuerPublicKey: string;
  issuerKeyId: string;
  epoch: number;
  active: boolean;
}
export interface ConversationRow {
  id: string;
  enrollment_id: string;
  subject: string;
  project_id: string;
  agent_id: string;
  session_name: string;
  session_key: string;
  title: string;
  version: number;
  updated_at: number;
}
export interface TurnRow {
  id: string;
  conversation_id: string;
  status: BridgeTurnStatus;
  cancel_requested: number;
  lease_until: number;
  authority: string;
  created_at: number;
}
export class BridgeStore {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS enrollments(id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, subject TEXT NOT NULL,
        project_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_name TEXT UNIQUE NOT NULL, session_key TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        status TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL, authority TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_turn ON turns(conversation_id) WHERE status IN ('queued','running','awaiting_approval');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL, text TEXT NOT NULL, turn_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS message_metadata(message_id TEXT PRIMARY KEY REFERENCES messages(id), request_id TEXT NOT NULL,
        barrier TEXT NOT NULL, delivery TEXT NOT NULL, reply_to TEXT);
      CREATE TABLE IF NOT EXISTS queued_messages(turn_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),
        message_id TEXT NOT NULL REFERENCES messages(id),barrier TEXT NOT NULL,state TEXT NOT NULL,authority TEXT NOT NULL,lease_until INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teams(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), definition TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_members(conversation_id TEXT NOT NULL REFERENCES teams(conversation_id), subject TEXT NOT NULL,
        role TEXT NOT NULL, PRIMARY KEY(conversation_id,subject));
      CREATE TABLE IF NOT EXISTS turn_targets(turn_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_handoffs(message_id TEXT PRIMARY KEY,parent_turn_id TEXT NOT NULL UNIQUE,turn_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,definition TEXT NOT NULL,depth INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_authors(message_id TEXT PRIMARY KEY,subject TEXT NOT NULL,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(enrollment_id TEXT NOT NULL, subject TEXT NOT NULL, request_id TEXT NOT NULL,
        digest TEXT NOT NULL, result TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY(enrollment_id,subject,request_id));
      CREATE TABLE IF NOT EXISTS delegation_heads(enrollment_id TEXT NOT NULL, subject TEXT NOT NULL, project_id TEXT NOT NULL,
        revision INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(enrollment_id,subject,project_id));
      CREATE TABLE IF NOT EXISTS replays(jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_receipts(enrollment_id TEXT NOT NULL,subject TEXT NOT NULL,operation_id TEXT NOT NULL,
        digest TEXT NOT NULL,status INTEGER,body TEXT,PRIMARY KEY(enrollment_id,subject,operation_id));
      CREATE TABLE IF NOT EXISTS events(conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
        data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_id,sequence));
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        capability TEXT NOT NULL, description TEXT NOT NULL, action_digest TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, enrollment_id TEXT,
        subject TEXT, request_id TEXT, operation TEXT NOT NULL, target TEXT, result TEXT NOT NULL);`);
  }
  atomic<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }
  enrollment(id: string): Enrollment | null {
    const row = this.db.query<{ document: string }, [string]>("SELECT document FROM enrollments WHERE id=?").get(id);
    return row ? JSON.parse(row.document) : null;
  }
  putEnrollment(value: Enrollment) {
    this.db
      .query("INSERT INTO enrollments VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
      .run(value.id, JSON.stringify(value));
  }
  conversation(id: string): ConversationRow | null {
    return this.db.query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id=?").get(id);
  }
  turn(id: string): TurnRow | null {
    return this.db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id=?").get(id);
  }
  activeTurn(conversationId: string): TurnRow | null {
    return this.db
      .query<TurnRow, [string]>(
        "SELECT * FROM turns WHERE conversation_id=? AND status IN ('queued','running','awaiting_approval')",
      )
      .get(conversationId);
  }
  authorizedConversation(id: string, enrollment: Enrollment, subject: string, projectId: string): ConversationRow {
    const row = this.conversation(id);
    if (
      !row ||
      row.enrollment_id !== enrollment.id ||
      !this.hasParticipant(row, subject) ||
      row.project_id !== projectId
    )
      throw new BridgeError("NOT_FOUND_OR_DENIED");
    return row;
  }
  hasParticipant(row: ConversationRow, subject: string): boolean {
    if (!this.team(row.id)) return row.subject === subject;
    return Boolean(
      this.db.query("SELECT 1 FROM team_members WHERE conversation_id=? AND subject=?").get(row.id, subject),
    );
  }
  team(id: string): BridgeTeam | undefined {
    const row = this.db
      .query<{ definition: string }, [string]>("SELECT definition FROM teams WHERE conversation_id=?")
      .get(id);
    return row ? JSON.parse(row.definition) : undefined;
  }
  conversationDto(row: ConversationRow): BridgeConversation {
    const team = this.team(row.id);
    return { ...conversationDto(row), ...(team ? { team } : {}) };
  }
  turnAgent(turnId: string): string | undefined {
    return this.db
      .query<{ agent_id: string }, [string]>("SELECT agent_id FROM turn_targets WHERE turn_id=?")
      .get(turnId)?.agent_id;
  }
  author(messageId: string) {
    const row = this.db
      .query<{ subject: string; name: string }, [string]>("SELECT subject,name FROM message_authors WHERE message_id=?")
      .get(messageId);
    return row ? { authorId: row.subject, authorName: row.name } : {};
  }
  event(conversationId: string, type: string, data: unknown) {
    this.db
      .query(`INSERT INTO events(conversation_id,sequence,type,data,created_at)
      VALUES (?,(SELECT COALESCE(MAX(sequence),0)+1 FROM events WHERE conversation_id=?),?,?,?)`)
      .run(conversationId, conversationId, type, JSON.stringify(data), Date.now());
  }
  setTurn(id: string, status: BridgeTurnStatus) {
    const turn = this.turn(id);
    if (!turn || !["queued", "running", "awaiting_approval"].includes(turn.status)) return;
    this.atomic(() => {
      this.db.query("UPDATE turns SET status=? WHERE id=?").run(status, id);
      this.db
        .query("UPDATE conversations SET version=version+1,updated_at=? WHERE id=?")
        .run(Date.now(), turn.conversation_id);
      if (!["queued", "running", "awaiting_approval"].includes(status)) this.invalidateApprovals(id);
      this.event(turn.conversation_id, "turn.state", {
        id,
        status,
        cancelRequested: Boolean(turn.cancel_requested),
        ...(this.turnAgent(id) ? { agentId: this.turnAgent(id) } : {}),
      });
    });
  }
  invalidateApprovals(turnId: string) {
    const rows = this.db
      .query<{ id: string; conversation_id: string; version: number }, [string]>(
        "SELECT id,conversation_id,version FROM approvals WHERE turn_id=? AND state='pending'",
      )
      .all(turnId);
    this.db
      .query("UPDATE approvals SET state='invalidated',version=version+1 WHERE turn_id=? AND state='pending'")
      .run(turnId);
    for (const row of rows)
      this.event(row.conversation_id, "approval.state", { id: row.id, state: "invalidated", version: row.version + 1 });
  }
  close() {
    this.db.close();
  }
}
export function conversationDto(row: ConversationRow): BridgeConversation {
  return { id: row.id, agentId: row.agent_id, title: row.title, version: row.version, updatedAt: row.updated_at };
}
let singleton: BridgeStore | undefined;
export function bridgeStateDir() {
  return join(getRaviStateDir(), "human-bridge");
}
export function getBridgeStore() {
  if (!singleton) {
    mkdirSync(bridgeStateDir(), { recursive: true, mode: 0o700 });
    singleton = new BridgeStore(join(bridgeStateDir(), "bridge.db"));
  }
  return singleton;
}
