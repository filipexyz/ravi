import { randomUUID } from "node:crypto";
import { hasRuntimeInvocationContext } from "../cli/context.js";
import { readSpawnedAutomationPrincipal } from "../runtime/turn-origin.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { getScopeContext, isScopeEnforced } from "../permissions/scope.js";
import { getDb } from "../router/router-db.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { buildChannelTextOutboundJob } from "../channels/outbound-stream.js";
import { publishChannelOutboundJobDurably } from "../channels/outbound-publish-outbox.js";
import { getDecision, decisionWrite } from "./store.js";
import { requireDecisionThread } from "./service.js";
import { DecisionError, DecisionDispatchRejectedError } from "./model.js";

export interface DecisionDelivery {
  id: string;
  decisionId: string;
  kind: "question" | "answer";
  revision: number;
  status: "pending" | "publishing" | "published" | "accepting" | "delivered" | "failed" | "uncertain" | "superseded";
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  deliveredAt: number | null;
}
interface DeliveryRow extends DecisionDelivery {
  payload: string | null;
  claimId: string | null;
  claimUntil: number | null;
}

const SELECT = `SELECT id,decision_id AS decisionId,kind,revision,status,attempts,next_attempt_at AS nextAttemptAt,
  last_error AS lastError,delivered_at AS deliveredAt,payload_json AS payload,claim_id AS claimId,claim_until AS claimUntil FROM decision_deliveries`;

export function decisionDeliveries(decisionId: string): DecisionDelivery[] {
  return (getDb().query(`${SELECT} WHERE decision_id=? ORDER BY created_at,id`).all(decisionId) as DeliveryRow[]).map(
    ({ payload: _payload, claimId: _claim, claimUntil: _until, ...publicRow }) => publicRow,
  );
}

export interface DecisionDeliveryDeps {
  publishPrompt: typeof publishSessionPrompt;
  publishOutbound: (job: ReturnType<typeof buildChannelTextOutboundJob>) => Promise<unknown>;
}
const defaults: DecisionDeliveryDeps = {
  publishPrompt: publishSessionPrompt,
  publishOutbound: publishChannelOutboundJobDurably,
};

/** Bounded replay from the existing thread reconciler. A lost admission receipt is never guessed. */
export async function reconcileDecisionDeliveries(
  deps: DecisionDeliveryDeps = defaults,
  decisionId?: string,
): Promise<void> {
  const now = Date.now();
  getDb()
    .query(
      "UPDATE decision_deliveries SET status='uncertain',last_error='ADMISSION_OUTCOME_UNKNOWN' WHERE status='accepting' AND claim_until<?",
    )
    .run(now);
  const rows = getDb()
    .query(`${SELECT} WHERE status IN ('pending','failed','published','publishing') AND next_attempt_at<=?
    AND (claim_until IS NULL OR claim_until<?) ${decisionId ? "AND decision_id=?" : ""} ORDER BY created_at LIMIT 25`)
    .all(now, now, ...(decisionId ? [decisionId] : [])) as DeliveryRow[];
  for (const row of rows) await deliver(row, deps);
  if (decisionId) await refreshDecisionCard(decisionId, deps);
}

async function deliver(candidate: DeliveryRow, deps: DecisionDeliveryDeps): Promise<void> {
  const claim = randomUUID();
  const won = getDb()
    .query(`UPDATE decision_deliveries SET status='publishing',claim_id=?,claim_until=?,attempts=attempts+1
    WHERE id=? AND status IN ('pending','failed','published','publishing') AND next_attempt_at<=? AND (claim_until IS NULL OR claim_until<?)`)
    .run(claim, Date.now() + 60_000, candidate.id, Date.now(), Date.now()).changes;
  if (!won) return;
  // Another reconciler may have frozen a payload since the batch was read.
  const row = getDb().query(`${SELECT} WHERE id=?`).get(candidate.id) as DeliveryRow;
  try {
    const decision = getDecision(row.decisionId)!;
    const { record, child, chat } = requireDecisionThread(decision.origin);
    if (row.kind === "question" && (decision.status !== "open" || row.revision !== decision.revision)) {
      finish(row.id, claim, "superseded");
      return;
    }
    const target = {
      channel: "slack",
      accountId: record.accountId,
      instanceId: record.instanceId,
      chatId: record.platformChatId,
      canonicalChatId: chat.id,
      threadId: record.providerThreadId,
    };
    if (row.kind === "question") {
      const text = `**Decisão pendente: ${decision.key}**\n\n${decision.ask}\n\nResponsável: ${decision.ownerType}${decision.ownerId ? `:${decision.ownerId}` : ""}.\nPara registrar a resposta, peça à sessão que abriu esta thread ou use o CLI de decisões.\nReferência: ${decision.id}`;
      const job = row.payload
        ? (JSON.parse(row.payload) as ReturnType<typeof buildChannelTextOutboundJob>)
        : buildChannelTextOutboundJob({
            requestId: row.id,
            emitId: row.id,
            idempotencyKey: row.id,
            sessionName: child.name ?? child.sessionKey,
            text,
            target,
            now: decision.updatedAt,
          });
      // Retries keep the exact outbox fingerprint even after a session rename.
      if (!row.payload)
        getDb()
          .query("UPDATE decision_deliveries SET payload_json=? WHERE id=? AND claim_id=?")
          .run(JSON.stringify(job), row.id, claim);
      const result = await deps.publishOutbound(job);
      if (result && typeof result === "object" && "ok" in result && result.ok === false)
        throw new Error("OUTBOUND_PENDING");
      finish(row.id, claim, "delivered");
    } else {
      if (!row.payload) throw new Error("ANSWER_PAYLOAD_MISSING");
      const payload = JSON.parse(row.payload) as RuntimeLaunchPrompt;
      await deps.publishPrompt(child.name ?? child.sessionKey, payload as unknown as Record<string, unknown>, {
        messageId: row.id,
      });
      // Publication is not admission. The consumer owns 'delivered'.
      getDb()
        .query(
          "UPDATE decision_deliveries SET status='published',claim_id=NULL,claim_until=NULL,next_attempt_at=?,last_error=NULL WHERE id=? AND claim_id=? AND status='publishing'",
        )
        .run(Date.now() + 60_000, row.id, claim);
    }
    await refreshDecisionCard(row.decisionId, deps);
  } catch {
    getDb()
      .query(
        "UPDATE decision_deliveries SET status='failed',claim_id=NULL,claim_until=NULL,next_attempt_at=?,last_error='DELIVERY_FAILED' WHERE id=? AND claim_id=? AND status='publishing'",
      )
      .run(Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(row.attempts - 1, 4)), row.id, claim);
  }
}

async function refreshDecisionCard(decisionId: string, deps: DecisionDeliveryDeps): Promise<void> {
  try {
    const decision = getDecision(decisionId);
    if (!decision || decision.origin.type !== "thread") return;
    const { record } = requireDecisionThread(decision.origin);
    const { updateSlackThreadCard } = await import("../channels/slack/thread-lifecycle.js");
    await updateSlackThreadCard(
      record,
      { status: record.status === "closed" ? "closed" : "open" },
      { publishOutbound: deps.publishOutbound, publishPrompt: deps.publishPrompt, publishEvent: async () => {} },
    );
  } catch {
    /* A presentation failure must not change the durable admission receipt. */
  }
}

function finish(id: string, claim: string, status: "delivered" | "superseded") {
  getDb()
    .query(
      "UPDATE decision_deliveries SET status=?,delivered_at=?,claim_id=NULL,claim_until=NULL,last_error=NULL WHERE id=? AND claim_id=?",
    )
    .run(status, Date.now(), id, claim);
}

/** Validated at the consumer, before any runtime work, independently of JetStream's dedup window. */
export async function admitDecisionAnswer(
  sessionName: string,
  prompt: RuntimeLaunchPrompt,
  handle: (prompt: RuntimeLaunchPrompt) => Promise<void>,
  deps: DecisionDeliveryDeps = defaults,
): Promise<boolean> {
  const id = prompt._decisionDeliveryId;
  if (!id) return false;
  const claimed = decisionWrite((db) => {
    const row = db.query(`${SELECT} WHERE id=? AND kind='answer'`).get(id) as DeliveryRow | null;
    if (!row) throw new DecisionError("DECISION_NOT_FOUND", "Decision delivery not found.");
    const decision = getDecision(row.decisionId)!;
    const { child } = requireDecisionThread(decision.origin);
    if (sessionName !== (child.name ?? child.sessionKey) || !row.payload)
      throw new DecisionError("DECISION_ORIGIN_MISMATCH", "Decision delivery target differs.");
    const expected = JSON.parse(row.payload) as RuntimeLaunchPrompt;
    // Never accept caller-supplied text, routing, or authority in place of the frozen answer.
    if (
      prompt.prompt !== expected.prompt ||
      JSON.stringify(prompt._turnOrigin) !== JSON.stringify(expected._turnOrigin) ||
      JSON.stringify(prompt.source) !== JSON.stringify(expected.source)
    ) {
      throw new DecisionError("DECISION_ORIGIN_MISMATCH", "Decision delivery envelope differs.");
    }
    if (["delivered", "accepting", "uncertain"].includes(row.status)) return null;
    const claim = randomUUID();
    db.query("UPDATE decision_deliveries SET status='accepting',claim_id=?,claim_until=? WHERE id=?").run(
      claim,
      Date.now() + 300_000,
      id,
    );
    return { claim, expected, decisionId: row.decisionId };
  });
  if (!claimed) return true;
  try {
    await handle(claimed.expected);
    finish(id, claimed.claim, "delivered");
    await refreshDecisionCard(claimed.decisionId, deps);
  } catch (error) {
    if (error instanceof DecisionDispatchRejectedError) {
      getDb()
        .query(
          "UPDATE decision_deliveries SET status='failed',claim_id=NULL,claim_until=NULL,next_attempt_at=?,last_error=? WHERE id=? AND claim_id=?",
        )
        .run(Date.now() + 30_000, error.reason, id, claimed.claim);
      throw error;
    }
    // The runtime may have started before throwing. Repeating would risk executing twice.
    getDb()
      .query(
        "UPDATE decision_deliveries SET status='uncertain',last_error='ADMISSION_OUTCOME_UNKNOWN' WHERE id=? AND claim_id=?",
      )
      .run(id, claimed.claim);
    throw error;
  }
  return true;
}

export function resetFailedDecisionDeliveries(decisionId: string): void {
  if (decisionDeliveries(decisionId).some((d) => d.status === "uncertain" || d.status === "accepting")) {
    throw new DecisionError(
      "DECISION_DELIVERY_UNCERTAIN",
      "Runtime admission is uncertain. Inspect the session trace; do not replay this answer blindly.",
    );
  }
  getDb()
    .query(
      "UPDATE decision_deliveries SET next_attempt_at=0 WHERE decision_id=? AND status IN ('pending','failed','published')",
    )
    .run(decisionId);
}

/** Manual recovery is deliberately terminal/operator-only; a worker cannot guess away uncertainty. */
export function validateDeliveryResolution(decisionId: string, outcome: string, evidence: string): void {
  if (
    hasRuntimeInvocationContext() ||
    readSpawnedAutomationPrincipal() ||
    isScopeEnforced(getScopeContext()) ||
    getScopeContext().sessionKey ||
    getScopeContext().sessionName
  ) {
    throw new CliExpectedError(
      "Only the local operator may resolve uncertain admission after inspecting its trace.",
      "PERMISSION_DENIED",
    );
  }
  if (!["received", "not_received"].includes(outcome) || !evidence.trim()) {
    throw new CliExpectedError(
      "Use --outcome received|not_received and --evidence with the trace finding.",
      "USAGE_ERROR",
      2,
    );
  }
  if (!decisionDeliveries(decisionId).some((d) => d.kind === "answer" && d.status === "uncertain")) {
    throw new CliExpectedError("This answer has no uncertain admission to resolve.", "DECISION_NOT_OPEN");
  }
}

export function resolveUncertainDecisionDelivery(decisionId: string, outcome: string, evidence: string): void {
  decisionWrite((db) => {
    validateDeliveryResolution(decisionId, outcome, evidence);
    const delivery = decisionDeliveries(decisionId).find((d) => d.kind === "answer" && d.status === "uncertain")!;
    db.query(
      "UPDATE decision_deliveries SET status=?,claim_id=NULL,claim_until=NULL,next_attempt_at=0,delivered_at=?,last_error=NULL WHERE id=? AND status='uncertain'",
    ).run(outcome === "received" ? "delivered" : "pending", outcome === "received" ? Date.now() : null, delivery.id);
    db.query(
      "INSERT INTO decision_history(decision_id,type,actor,snapshot_json,created_at) VALUES (?,'delivery_resolved','operator',?,?)",
    ).run(decisionId, JSON.stringify({ deliveryId: delivery.id, outcome, evidence: evidence.trim() }), Date.now());
  });
}
