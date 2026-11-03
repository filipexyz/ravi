import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { ConsoleRole } from "@/lib/auth/session";
import type { CliAuthContext } from "@/server/cli/auth";
import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { cliApiError } from "@/server/cli/errors";
import { parseConsoleRole } from "@/server/console/workspace";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { writeKnowledgeRun } from "./retrieval-core";

// Who is asking (CONTRACT §4). OSS sends `X-Ravi-Exec-Context` on every
// `/api/cli/knowledge/*` call; the Console cannot verify it, so the decision
// fails closed: only the operator's own turns (terminal, own DM, operator
// relay, own cron) are answered. `speaker.consoleUserId` is never read from
// the header; an owner DM with a contact is checked against an active
// binding for this installation, org and user instead.

export const KNOWLEDGE_EXEC_CONTEXT_HEADER = "x-ravi-exec-context";
export const KNOWLEDGE_EXEC_CONTEXT_MAX_BYTES = 2048;

export type KnowledgeExecContext = {
  v: 1;
  agentId?: string;
  sessionName?: string;
  routine?: { kind: "cron" | "heartbeat" | "trigger"; id?: string };
  speaker: { kind: "terminal" | "owner" | "contact" | "agent" | "automation"; contactId?: string };
  conversation: "terminal" | "dm" | "group" | "automation";
  turnKey?: string;
  /** Printable label only; stored in `callerJson`, never used for a decision. */
  agentDisplayName?: string;
};

export type KnowledgeOperatorCaller = {
  audience: "operator";
  workspace: { authorization?: import("../authorization/identity").AuthorizationActor["delegation"]; mode: "workos"; user: { id: string }; organization: { id: string }; membership: { role: ConsoleRole } };
  localInstallationId: string;
  turnKey: string | null;
  /** { surface:"cli", speaker:{kind}, conversation, routine?, agentId?, sessionName?, localInstallationId } */
  callerJson: JsonRecord;
};

export type KnowledgeBindingLookup = (q: {
  installationId: string;
  organizationId: string;
  contactId: string;
}) => Promise<{ consoleUserId: string } | null>;

export type KnowledgeTurnDenialReason = "binding" | "audience";

// Printable labels only: they end up in run rows.
const label = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);

// Strict like the connectors Worker's parser (workers/connectors/src/exec-context.ts),
// re-implemented because src/ does not import workers/.
const execContextSchema = z.strictObject({
  v: z.literal(1),
  agentId: label(200).optional(),
  sessionName: label(500).optional(),
  routine: z
    .strictObject({
      kind: z.enum(["cron", "heartbeat", "trigger"]),
      id: label(200).optional(),
    })
    .optional(),
  speaker: z.strictObject({
    kind: z.enum(["terminal", "owner", "contact", "agent", "automation"]),
    contactId: label(200).optional(),
    // Accepted because OSS may send it; dropped and never read.
    consoleUserId: label(200).optional(),
  }),
  conversation: z.enum(["terminal", "dm", "group", "automation"]),
  turnKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  agentDisplayName: label(200).optional(),
});

/** Null context = no header (a legacy CLI), treated as the terminal. A malformed header is `{ok:false}` (400). */
export function parseKnowledgeExecContext(
  header: string | null,
): { ok: true; context: KnowledgeExecContext | null } | { ok: false } {
  if (header === null || header === undefined) return { ok: true, context: null };
  const encoded = header.trim();
  if (Buffer.byteLength(encoded, "utf8") > KNOWLEDGE_EXEC_CONTEXT_MAX_BYTES) return { ok: false };
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return { ok: false };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  const parsed = execContextSchema.safeParse(json);
  if (!parsed.success) return { ok: false };

  const { speaker, ...rest } = parsed.data;
  const context: KnowledgeExecContext = {
    ...rest,
    speaker: { kind: speaker.kind, ...(speaker.contactId ? { contactId: speaker.contactId } : {}) },
  };
  return { ok: true, context };
}

/**
 * Resolves the caller of an org Knowledge route to the operator, or throws
 * 403 `KNOWLEDGE_TURN_NOT_OPERATOR` after writing a denied run. The table in
 * CONTRACT §4.2 runs in order and fails closed.
 */
export async function resolveKnowledgeOperator(
  input: { auth: CliAuthContext; header: string | null; requestId: string },
  deps?: {
    findBinding?: KnowledgeBindingLookup;
    writeDeniedRun?: typeof writeKnowledgeRun;
  },
): Promise<KnowledgeOperatorCaller> {
  const { auth } = input;
  const parsed = parseKnowledgeExecContext(input.header);
  if (!parsed.ok) {
    throw cliApiError(400, "PAYLOAD_INVALID", "The X-Ravi-Exec-Context header is malformed.");
  }
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "KNOWLEDGE_DISABLED", undefined, { reason: "feature_forbidden" });
  }

  const context = parsed.context;
  const turnKey = context?.turnKey ? context.turnKey.toLowerCase() : null;
  const callerJson = knowledgeCallerJson(context, auth.localInstallation.id);
  const denial = await operatorDenial(context, auth, deps?.findBinding ?? findActiveKnowledgeBinding);

  if (denial) {
    try {
      await (deps?.writeDeniedRun ?? writeKnowledgeRun)({
        organizationId: auth.organization.id,
        projectId: null,
        audience: "operator",
        status: "denied",
        actorType: "cli",
        actorId: auth.user.id,
        callerJson: { ...callerJson, denied: denial },
        localInstallationId: auth.localInstallation.id,
        turnKey,
        queryText: null,
        normalizedQuery: null,
        mode: null,
        candidateCount: 0,
        withheld: {},
        deniedReason: `turn_not_operator:${denial}`,
        citations: [],
        durationMs: 0,
        requestId: input.requestId,
        surface: "cli",
      });
    } catch (error) {
      console.error("[knowledge] failed to record a denied run", {
        requestId: input.requestId,
        name: error instanceof Error ? error.name : "unknown",
      });
    }
    throw cliApiError(403, "KNOWLEDGE_TURN_NOT_OPERATOR", undefined, { reason: denial });
  }

  return {
    audience: "operator",
    workspace: {
      authorization: projectAuthorizationFromCli(auth),
      mode: "workos",
      user: { id: auth.user.id },
      organization: { id: auth.organization.id },
      membership: { role },
    },
    localInstallationId: auth.localInstallation.id,
    turnKey,
    callerJson,
  };
}

async function operatorDenial(
  context: KnowledgeExecContext | null,
  auth: CliAuthContext,
  findBinding: KnowledgeBindingLookup,
): Promise<KnowledgeTurnDenialReason | null> {
  // 1. No header, or the terminal itself.
  if (!context) return null;
  const { speaker, conversation, routine } = context;
  if (speaker.kind === "terminal" && conversation === "terminal") return null;

  if (speaker.kind === "owner") {
    // 2. Operator relay: the owner without a contact, in a DM or the terminal.
    if (!speaker.contactId && (conversation === "dm" || conversation === "terminal")) return null;
    // 3. The owner's own DM: only with an active binding to this very user.
    if (speaker.contactId && conversation === "dm") {
      const binding = await findBinding({
        installationId: auth.localInstallation.id,
        organizationId: auth.organization.id,
        contactId: speaker.contactId,
      });
      return binding && binding.consoleUserId === auth.user.id ? null : "binding";
    }
    return "audience";
  }

  // 4. The operator's cron: OSS already checked ownership and that the answer goes to the owner's DM.
  if (
    speaker.kind === "automation" &&
    routine?.kind === "cron" &&
    (conversation === "automation" || conversation === "dm")
  ) {
    return null;
  }

  // 5. Groups, heartbeats, triggers, contacts, other agents.
  return "audience";
}

/**
 * Active binding for (installation, org, contact). Written here on purpose:
 * `findActiveBindingByContact` (ravi-link.ts) lacks the org and `revoked_at`
 * filters.
 */
export async function findActiveKnowledgeBinding(q: {
  installationId: string;
  organizationId: string;
  contactId: string;
}): Promise<{ consoleUserId: string } | null> {
  const [row] = await db
    .select({ consoleUserId: schema.raviActorBindings.consoleUserId })
    .from(schema.raviActorBindings)
    .where(
      and(
        eq(schema.raviActorBindings.installationId, q.installationId),
        eq(schema.raviActorBindings.organizationId, q.organizationId),
        eq(schema.raviActorBindings.contactId, q.contactId),
        eq(schema.raviActorBindings.status, "active"),
        isNull(schema.raviActorBindings.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Labels and the classification only: never the contact id or the turn key. */
export function knowledgeCallerJson(context: KnowledgeExecContext | null, localInstallationId: string): JsonRecord {
  if (!context) {
    return {
      surface: "cli",
      speaker: { kind: "terminal" },
      conversation: "terminal",
      legacyCli: true,
      localInstallationId,
    };
  }
  return {
    surface: "cli",
    speaker: { kind: context.speaker.kind },
    conversation: context.conversation,
    ...(context.routine ? { routine: { ...context.routine } } : {}),
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentDisplayName ? { agentDisplayName: context.agentDisplayName } : {}),
    ...(context.sessionName ? { sessionName: context.sessionName } : {}),
    localInstallationId,
  };
}
