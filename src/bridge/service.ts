import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  bridgeRequestSchema,
  BridgeError,
  LEASE_MS,
  type BridgeGrant,
  type BridgeRequest,
  type BridgeResult,
  type BridgeSnapshot,
  type BridgeApproval,
  type BridgeEvent,
} from "./protocol.js";
import { requestDigest, verifyBridgeGrant } from "./auth.js";
import { conversationDto, type BridgeStore, type Enrollment, type ConversationRow } from "./store.js";
import { bridgeTurnAuthority } from "./authority.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";

const MUTATIONS = new Set(["conversations.create", "messages.send", "turns.cancel", "approvals.decide"]);
export interface BridgeRuntime {
  agents(): { id: string; name: string }[];
  start(turnId: string): Promise<void>;
  cancel(sessionName: string): boolean | void;
}
export class BridgeService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(
    readonly store: BridgeStore,
    readonly runtimeId: string,
    private cursorKey: string,
    readonly runtime: BridgeRuntime,
  ) {}
  start() {
    // An old running attempt may have produced effects. Never replay it after a daemon crash.
    for (const row of this.store.db
      .query<{ id: string }, []>("SELECT id FROM turns WHERE status IN ('running','awaiting_approval')")
      .all())
      this.store.setTurn(row.id, "interrupted_unknown");
    this.timer = setInterval(() => void this.tick(), 250);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.store.db
        .query<{ id: string; conversation_id: string; status: string; lease_until: number }, []>(
          "SELECT id,conversation_id,status,lease_until FROM turns WHERE status IN ('queued','running','awaiting_approval')",
        )
        .all();
      for (const row of rows) {
        const conversation = this.store.conversation(row.conversation_id)!;
        const current = this.store.turn(row.id)!;
        if (current.cancel_requested) {
          if (this.runtime.cancel(conversation.session_name) === false) this.store.setTurn(row.id, "cancelled");
          continue;
        }
        if (!bridgeTurnAuthority(row.id, this.store)) {
          this.store.setTurn(row.id, "authorization_expired");
          this.runtime.cancel(conversation.session_name);
          continue;
        }
        if (row.status !== "queued") continue;
        this.store.setTurn(row.id, "running");
        void this.runtime.start(row.id).catch(() => this.store.setTurn(row.id, "failed"));
      }
    } finally {
      this.ticking = false;
    }
  }
  async handle(input: unknown, token: string, connectionId: string): Promise<BridgeResult> {
    let requestId = "";
    try {
      const request = bridgeRequestSchema.parse(input);
      requestId = request.requestId;
      const { grant, enrollment } = await verifyBridgeGrant(this.store, request, token, connectionId, this.runtimeId);
      const data = this.store.atomic(() => {
        // Verification yields during crypto: recheck enrollment inside the transaction.
        const live = this.store.enrollment(enrollment.id);
        if (!live?.active || live.epoch !== grant.epoch) throw new BridgeError("ACCESS_REVOKED");
        this.advanceDelegation(grant);
        return this.execute(request, grant, live);
      });
      return { ok: true, requestId, data };
    } catch (error) {
      return {
        ok: false,
        requestId,
        error: error instanceof BridgeError ? error.code : "INVALID_REQUEST",
        effectState: error instanceof BridgeError ? error.effectState : "none",
      };
    }
  }
  private advanceDelegation(grant: BridgeGrant) {
    const head = this.store.db
      .query<{ revision: number; digest: string }, [string, string, string]>(
        "SELECT revision,digest FROM delegation_heads WHERE enrollment_id=? AND subject=? AND project_id=?",
      )
      .get(grant.enrollmentId, grant.sub, grant.projectId);
    if (
      head &&
      (grant.policyRevision < head.revision ||
        (grant.policyRevision === head.revision && grant.policyDigest !== head.digest))
    )
      throw new BridgeError("STALE_DELEGATION");
    if (!head || grant.policyRevision > head.revision) {
      this.store.db
        .query(
          "INSERT INTO delegation_heads VALUES (?,?,?,?,?) ON CONFLICT(enrollment_id,subject,project_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest",
        )
        .run(grant.enrollmentId, grant.sub, grant.projectId, grant.policyRevision, grant.policyDigest);
      // A fresh Console revision changes existing turns too. Reading never extends their lease.
      this.store.db
        .query(`UPDATE turns SET authority=?,lease_until=MIN(lease_until,?) WHERE status IN ('queued','running','awaiting_approval')
        AND conversation_id IN (SELECT id FROM conversations WHERE enrollment_id=? AND subject=? AND project_id=?)`)
        .run(
          JSON.stringify(grant),
          grant.canSend ? grant.exp * 1000 : Date.now(),
          grant.enrollmentId,
          grant.sub,
          grant.projectId,
        );
    }
  }
  private execute(request: BridgeRequest, grant: BridgeGrant, enrollment: Enrollment): unknown {
    const conversation =
      "conversationId" in request
        ? this.store.authorizedConversation(request.conversationId, enrollment, grant.sub, request.projectId)
        : null;
    if (conversation && !grant.agents.some((a) => a.id === conversation.agent_id))
      throw new BridgeError("NOT_FOUND_OR_DENIED");
    const receipt = this.store.db
      .query<{ digest: string; result: string; project_id: string }, [string, string, string]>(
        "SELECT digest,result,project_id FROM receipts WHERE enrollment_id=? AND subject=? AND request_id=?",
      )
      .get(enrollment.id, grant.sub, request.requestId);
    const digest = requestDigest(request);
    if (MUTATIONS.has(request.operation) && receipt) {
      if (receipt.digest !== digest) throw new BridgeError("IDEMPOTENCY_CONFLICT");
      return this.authorizeReceipt(receipt, enrollment, grant, request.projectId);
    }
    if (
      MUTATIONS.has(request.operation) &&
      (request.createdAt < Date.now() - 600_000 || request.createdAt > Date.now() + 5000)
    )
      throw new BridgeError("REQUEST_EXPIRED");
    if (["conversations.create", "messages.send", "lease.renew"].includes(request.operation) && !grant.canSend)
      throw new BridgeError("NOT_FOUND_OR_DENIED");
    let result: unknown;
    switch (request.operation) {
      case "agents.list":
        result = this.runtime.agents().filter((agent) => grant.agents.some((a) => a.id === agent.id));
        break;
      case "conversations.list":
        result = this.store.db
          .query<ConversationRow, [string, string, string]>(
            "SELECT * FROM conversations WHERE enrollment_id=? AND subject=? AND project_id=? ORDER BY updated_at DESC LIMIT 100",
          )
          .all(enrollment.id, grant.sub, request.projectId)
          .filter((c) => grant.agents.some((a) => a.id === c.agent_id))
          .map(conversationDto);
        break;
      case "conversations.create": {
        if (
          !grant.agents.some((a) => a.id === request.agentId) ||
          !this.runtime.agents().some((agent) => agent.id === request.agentId)
        )
          throw new BridgeError("NOT_FOUND_OR_DENIED");
        const id = randomUUID();
        this.store.db
          .query("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            enrollment.id,
            grant.sub,
            request.projectId,
            request.agentId,
            `console-${id}`,
            `agent:${request.agentId}:console:${id}`,
            "Nova conversa",
            0,
            Date.now(),
          );
        result = { conversationId: id, conversation: conversationDto(this.store.conversation(id)!) };
        break;
      }
      case "conversations.open":
        result = this.snapshot(conversation!, grant, enrollment);
        break;
      case "messages.list":
        result = this.history(conversation!.id, request.before);
        break;
      case "messages.send": {
        if (Buffer.byteLength(request.text) > 16_384) throw new BridgeError("PAYLOAD_TOO_LARGE");
        if (conversation!.version !== request.expectedVersion) throw new BridgeError("VERSION_CONFLICT");
        if (this.store.activeTurn(conversation!.id)) throw new BridgeError("TURN_BUSY");
        const { count } = this.store.db
          .query<{ count: number }, [string, string]>(
            "SELECT COUNT(*) count FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE c.enrollment_id=? AND c.subject=? AND t.status IN ('queued','running','awaiting_approval')",
          )
          .get(enrollment.id, grant.sub)!;
        if (count >= 3) throw new BridgeError("RATE_LIMITED");
        const turnId = randomUUID(),
          messageId = randomUUID(),
          now = Date.now();
        this.store.db
          .query(
            "INSERT INTO turns(id,conversation_id,status,lease_until,authority,created_at) VALUES (?,?,'queued',?,?,?)",
          )
          .run(turnId, conversation!.id, Math.min(now + LEASE_MS, grant.exp * 1000), JSON.stringify(grant), now);
        this.store.db
          .query("INSERT INTO messages VALUES (?,?,?,?,?,?)")
          .run(messageId, conversation!.id, "user", request.text, turnId, now);
        this.store.db
          .query("UPDATE conversations SET version=version+1,updated_at=? WHERE id=?")
          .run(now, conversation!.id);
        if (conversation!.version === 0)
          this.store.db
            .query("UPDATE conversations SET title=? WHERE id=?")
            .run(request.text.replace(/\s+/g, " ").slice(0, 64), conversation!.id);
        this.store.event(conversation!.id, "message.accepted", {
          id: messageId,
          turnId,
          role: "user",
          text: request.text,
          createdAt: now,
        });
        result = {
          accepted: true,
          conversationId: conversation!.id,
          messageId,
          turnId,
          version: conversation!.version + 1,
        };
        break;
      }
      case "lease.renew": {
        const turn = this.store.activeTurn(conversation!.id);
        if (turn && turn.lease_until > Date.now() && !turn.cancel_requested) {
          this.store.db
            .query("UPDATE turns SET lease_until=?,authority=? WHERE id=?")
            .run(Math.min(Date.now() + LEASE_MS, grant.exp * 1000), JSON.stringify(grant), turn.id);
        }
        result = {
          renewed: Boolean(turn && !turn.cancel_requested && turn.lease_until > Date.now()),
          conversationId: conversation!.id,
        };
        break;
      }
      case "events.read": {
        const after = request.cursor ? this.parseCursor(request.cursor, conversation!, grant, enrollment) : 0;
        const events = this.store.db
          .query<{ sequence: number; type: string; data: string; created_at: number }, [string, number]>(
            "SELECT * FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 100",
          )
          .all(conversation!.id, after);
        const items: BridgeEvent[] = events.map((e) => ({
          sequence: e.sequence,
          type: e.type,
          data: JSON.parse(e.data),
          createdAt: e.created_at,
        }));
        result = {
          events: items,
          cursor: this.cursor(conversation!, grant, enrollment, items.at(-1)?.sequence ?? after),
        };
        break;
      }
      case "requests.get": {
        const found = this.store.db
          .query<{ result: string; project_id: string }, [string, string, string]>(
            "SELECT result,project_id FROM receipts WHERE enrollment_id=? AND subject=? AND request_id=?",
          )
          .get(enrollment.id, grant.sub, request.targetRequestId);
        if (!found) throw new BridgeError("REQUEST_NOT_FOUND");
        result = this.authorizeReceipt(found, enrollment, grant, request.projectId);
        break;
      }
      case "turns.cancel": {
        const turn = this.store.turn(request.turnId);
        if (!turn || turn.conversation_id !== conversation!.id) throw new BridgeError("NOT_FOUND_OR_DENIED");
        const active = ["queued", "running", "awaiting_approval"].includes(turn.status);
        if (active) {
          this.store.db.query("UPDATE turns SET cancel_requested=1 WHERE id=?").run(turn.id);
          this.store.invalidateApprovals(turn.id);
          this.store.event(conversation!.id, "cancel.requested", { turnId: turn.id });
          if (turn.status === "queued") this.store.setTurn(turn.id, "cancelled");
          // The dispatcher observes this committed flag on its next tick.
        }
        result = { conversationId: conversation!.id, turnId: turn.id, cancelRequested: active, status: turn.status };
        break;
      }
      case "approvals.decide": {
        const row = this.store.db
          .query<
            {
              id: string;
              conversation_id: string;
              turn_id: string;
              capability: string;
              state: string;
              version: number;
              action_digest: string;
              expires_at: number;
            },
            [string]
          >("SELECT * FROM approvals WHERE id=?")
          .get(request.approvalId);
        if (!row || row.conversation_id !== conversation!.id || !grant.canApprove)
          throw new BridgeError("NOT_FOUND_OR_DENIED");
        const turn = this.store.activeTurn(conversation!.id);
        if (
          !turn ||
          turn.id !== row.turn_id ||
          turn.lease_until <= Date.now() ||
          turn.cancel_requested ||
          row.expires_at <= Date.now() ||
          row.state !== "pending" ||
          row.version !== request.expectedVersion ||
          row.action_digest !== request.actionDigest
        )
          throw new BridgeError("APPROVAL_STALE");
        const capability = JSON.parse(row.capability);
        const permitted = grant.agents.find((a) => a.id === conversation!.agent_id)!.approvalCapabilities;
        if (!canWithCapabilities(permitted, capability.permission, capability.objectType, capability.objectId))
          throw new BridgeError("NOT_FOUND_OR_DENIED");
        // The decision is bound to this invocation; the Console's current grant replaces the stale snapshot.
        this.store.db
          .query("UPDATE turns SET authority=?,lease_until=? WHERE id=?")
          .run(JSON.stringify(grant), Math.min(turn.lease_until, grant.exp * 1000), turn.id);
        const state = request.decision === "approve" ? "approved" : "rejected";
        this.store.db
          .query("UPDATE approvals SET state=?,version=version+1 WHERE id=? AND state='pending'")
          .run(state, row.id);
        this.store.event(conversation!.id, "approval.state", { id: row.id, state, version: row.version + 1 });
        result = { conversationId: conversation!.id, approvalId: row.id, state, version: row.version + 1 };
        break;
      }
    }
    if (MUTATIONS.has(request.operation)) {
      this.store.db
        .query("INSERT INTO receipts VALUES (?,?,?,?,?,?)")
        .run(enrollment.id, grant.sub, request.requestId, digest, JSON.stringify(result), request.projectId);
      this.store.db
        .query(
          "INSERT INTO audit(created_at,enrollment_id,subject,request_id,operation,target,result) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          Date.now(),
          enrollment.id,
          grant.sub,
          request.requestId,
          request.operation,
          conversation?.id ?? null,
          "accepted",
        );
    }
    return result;
  }
  private authorizeReceipt(
    row: { result: string; project_id: string },
    enrollment: Enrollment,
    grant: BridgeGrant,
    projectId: string,
  ) {
    if (row.project_id !== projectId) throw new BridgeError("NOT_FOUND_OR_DENIED");
    const result = JSON.parse(row.result);
    if (result.conversationId) {
      const conversation = this.store.authorizedConversation(result.conversationId, enrollment, grant.sub, projectId);
      if (!grant.agents.some((a) => a.id === conversation.agent_id)) throw new BridgeError("NOT_FOUND_OR_DENIED");
    }
    return result;
  }
  private cursor(c: ConversationRow, g: BridgeGrant, e: Enrollment, sequence: number) {
    const body = Buffer.from(JSON.stringify([e.id, e.epoch, g.sub, c.id, sequence])).toString("base64url");
    return `${body}.${createHmac("sha256", this.cursorKey).update(body).digest("base64url")}`;
  }
  private parseCursor(cursor: string, c: ConversationRow, g: BridgeGrant, e: Enrollment) {
    try {
      const [body, mac, extra] = cursor.split(".");
      if (!body || !mac || extra !== undefined) throw new Error();
      const expected = createHmac("sha256", this.cursorKey).update(body).digest();
      const actual = Buffer.from(mac, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const [enrollment, epoch, subject, conversation, sequence] = JSON.parse(
        Buffer.from(body, "base64url").toString(),
      );
      if (
        enrollment !== e.id ||
        epoch !== e.epoch ||
        subject !== g.sub ||
        conversation !== c.id ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
      )
        throw new Error();
      return sequence as number;
    } catch {
      throw new BridgeError("RESYNC_REQUIRED");
    }
  }
  snapshot(c: ConversationRow, g: BridgeGrant, e: Enrollment): BridgeSnapshot {
    const { messages, hasOlder } = this.history(c.id, null);
    const turn = this.store.db
      .query<{ id: string; status: import("./protocol.js").BridgeTurnStatus; cancel_requested: number }, [string]>(
        "SELECT * FROM turns WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(c.id);
    const approvals = this.store.db
      .query<
        {
          id: string;
          turn_id: string;
          capability: string;
          description: string;
          action_digest: string;
          version: number;
          expires_at: number;
          state: BridgeApproval["state"];
        },
        [string]
      >("SELECT * FROM approvals WHERE conversation_id=? ORDER BY rowid DESC LIMIT 20")
      .all(c.id)
      .map((a) => ({
        id: a.id,
        turnId: a.turn_id,
        capability: JSON.parse(a.capability),
        description: a.description,
        actionDigest: a.action_digest,
        version: a.version,
        expiresAt: a.expires_at,
        state: a.state,
      }));
    const sequence = this.store.db
      .query<{ value: number }, [string]>("SELECT COALESCE(MAX(sequence),0) value FROM events WHERE conversation_id=?")
      .get(c.id)!.value;
    return {
      conversation: conversationDto(c),
      messages,
      hasOlder,
      turn: turn ? { id: turn.id, status: turn.status, cancelRequested: Boolean(turn.cancel_requested) } : null,
      approvals,
      cursor: this.cursor(c, g, e, sequence),
    };
  }
  history(conversationId: string, before: string | null) {
    let offset = Number.MAX_SAFE_INTEGER;
    if (before) {
      const found = this.store.db
        .query<{ rowid: number }, [string, string]>("SELECT rowid FROM messages WHERE conversation_id=? AND id=?")
        .get(conversationId, before);
      if (!found) throw new BridgeError("NOT_FOUND_OR_DENIED");
      offset = found.rowid;
    }
    const rows = this.store.db
      .query<
        { id: string; role: "user" | "assistant"; text: string; turn_id: string; created_at: number },
        [string, number]
      >("SELECT * FROM messages WHERE conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21")
      .all(conversationId, offset);
    return {
      messages: rows
        .slice(0, 20)
        .reverse()
        .map((m) => ({ id: m.id, role: m.role, text: m.text, turnId: m.turn_id, createdAt: m.created_at })),
      hasOlder: rows.length > 20,
    };
  }
}
