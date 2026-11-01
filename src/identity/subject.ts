/**
 * Subject attribution.
 *
 * A `subject` answers *on whose behalf* a durable record exists (a task, an
 * approval request). It is deliberately not the same thing as an `actor`:
 *
 *   actor   — who performed the work (almost always an agent)
 *   subject — the human the work is for
 *
 * The shape follows `contacts/identity-graph/message-session-attribution`:
 * `contact_id` only when the actor is a resolved contact, `platform_identity_id`
 * whenever the platform identity is known, and raw provider ids as provenance.
 * Unresolved is allowed but MUST be explicit (`kind: "unknown"`).
 *
 * Display names are never identity evidence.
 */

import { getDb } from "../router/router-db.js";

export type SubjectKind = "contact" | "agent" | "unknown";

export interface SubjectRef {
  readonly kind: SubjectKind;
  readonly contactId?: string;
  readonly identityId?: string;
  readonly agentId?: string;
  readonly channel?: string;
  readonly rawId?: string;
}

type EnvLike = Record<string, string | undefined>;

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the subject of the current turn from the runtime environment.
 *
 * The runtime already exports the actor bundle (`RAVI_ACTOR_TYPE`,
 * `RAVI_CONTACT_ID`, `RAVI_PLATFORM_IDENTITY_ID`, raw sender ids), so a command
 * running inside a turn does not need to join anything to know who it is
 * working for.
 */
export function readSubjectFromEnv(env: EnvLike = process.env): SubjectRef {
  const actorType = clean(env.RAVI_ACTOR_TYPE);
  const contactId = clean(env.RAVI_CONTACT_ID);
  const agentId = clean(env.RAVI_ACTOR_AGENT_ID) ?? clean(env.RAVI_AGENT_ID);
  const provenance = {
    ...(clean(env.RAVI_PLATFORM_IDENTITY_ID) ? { identityId: clean(env.RAVI_PLATFORM_IDENTITY_ID) } : {}),
    ...(clean(env.RAVI_CHANNEL) ? { channel: clean(env.RAVI_CHANNEL) } : {}),
    ...((clean(env.RAVI_RAW_SENDER_ID) ?? clean(env.RAVI_SENDER_ID))
      ? { rawId: clean(env.RAVI_RAW_SENDER_ID) ?? clean(env.RAVI_SENDER_ID) }
      : {}),
  };

  if (actorType === "contact" && contactId) {
    return { kind: "contact", contactId, ...provenance };
  }
  if (actorType === "agent") {
    return { kind: "agent", ...(agentId ? { agentId } : {}), ...provenance };
  }
  return { kind: "unknown", ...provenance };
}

interface ChatParticipantRow {
  contact_id: string | null;
  platform_identity_id: string | null;
  raw_platform_user_id: string | null;
  last_seen_at: string | null;
}

/**
 * Resolve the subject of a chat that is not tied to a live turn (the daemon
 * creates approval requests, for example).
 *
 * Only an unambiguous chat resolves to a contact: exactly one human participant.
 * A shared channel is ambiguous by construction, so it stays `unknown` instead
 * of guessing which member the work belongs to.
 */
export function resolveSubjectForChat(chatId: string | null | undefined): SubjectRef {
  const normalizedChatId = clean(chatId);
  if (!normalizedChatId) return { kind: "unknown" };

  let rows: ChatParticipantRow[];
  try {
    rows = getDb()
      .prepare(
        `SELECT contact_id, platform_identity_id, raw_platform_user_id, last_seen_at
           FROM chat_participants
          WHERE chat_id = ?
          ORDER BY last_seen_at DESC`,
      )
      .all(normalizedChatId) as ChatParticipantRow[];
  } catch {
    return { kind: "unknown" };
  }
  if (rows.length === 0) return { kind: "unknown" };

  const contactIds = [...new Set(rows.map((row) => clean(row.contact_id)).filter((id): id is string => !!id))];
  const identityIds = [
    ...new Set(rows.map((row) => clean(row.platform_identity_id)).filter((id): id is string => !!id)),
  ];
  const channel = channelForChat(normalizedChatId);
  const provenance = { ...(channel ? { channel } : {}) };

  if (contactIds.length === 1) {
    const contactId = contactIds[0]!;
    const ownerRow = rows.find((row) => clean(row.contact_id) === contactId && clean(row.platform_identity_id));
    const rawId = clean(ownerRow?.raw_platform_user_id);
    return {
      kind: "contact",
      contactId,
      ...(clean(ownerRow?.platform_identity_id) ? { identityId: clean(ownerRow?.platform_identity_id) } : {}),
      ...(rawId ? { rawId } : {}),
      ...provenance,
    };
  }

  // Two or more humans: the chat cannot tell us who the work is for.
  if (contactIds.length > 1) {
    return {
      kind: "unknown",
      ...(identityIds.length === 1 ? { identityId: identityIds[0] } : {}),
      ...provenance,
    };
  }

  if (identityIds.length === 1) {
    const identityId = identityIds[0]!;
    const identityRow = rows.find((row) => clean(row.platform_identity_id) === identityId);
    const rawId = clean(identityRow?.raw_platform_user_id);
    return { kind: "unknown", identityId, ...(rawId ? { rawId } : {}), ...provenance };
  }

  return { kind: "unknown", ...provenance };
}

/** The provider channel a chat belongs to (slack, whatsapp, ...), when known. */
function channelForChat(chatId: string): string | undefined {
  try {
    const row = getDb().prepare("SELECT channel FROM chats WHERE id = ?").get(chatId) as
      | { channel: string | null }
      | undefined;
    return clean(row?.channel);
  } catch {
    return undefined;
  }
}

/** True when the subject carries no usable attribution at all. */
export function isEmptySubject(subject: SubjectRef | null | undefined): boolean {
  if (!subject) return true;
  return subject.kind === "unknown" && !subject.contactId && !subject.identityId && !subject.agentId;
}

/**
 * True when the subject actually names who the work is for. Provenance alone
 * (a raw sender id, a channel) does not count: a subject made only of provenance
 * must not stop a later resolution step from finding the human.
 */
export function hasResolvedSubject(subject: SubjectRef | null | undefined): boolean {
  if (!subject) return false;
  if (subject.kind === "contact") return !!subject.contactId;
  if (subject.kind === "agent") return !!subject.agentId;
  return !!subject.contactId || !!subject.identityId;
}

export interface ResolveSubjectInput {
  /** Environment of the command that is creating the record, if it is turn-scoped. */
  env?: EnvLike;
  /** Chats to fall back to, most specific first. */
  chatIds?: Array<string | null | undefined>;
}

/**
 * Resolve the subject for a new durable record.
 *
 * Order: the turn's own actor bundle, then the chats the turn is attached to.
 * A relayed turn has no actor contact (the actor is the relaying agent) and no
 * `source` on the context record, so the chat is the only thing that can name
 * the human the work is for.
 */
export function resolveSubject(input: ResolveSubjectInput = {}): SubjectRef | undefined {
  const env = input.env ?? {};
  if (env.RAVI_CONTEXT_KEY || env.RAVI_SESSION_KEY) {
    const fromTurn = readSubjectFromEnv(env);
    if (hasResolvedSubject(fromTurn)) return fromTurn;
  }

  const seen = new Set<string>();
  for (const candidate of input.chatIds ?? []) {
    const chatId = clean(candidate);
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    const fromChat = resolveSubjectForChat(chatId);
    if (hasResolvedSubject(fromChat)) return fromChat;
  }

  return undefined;
}

export interface SubjectColumns {
  subjectKind: string;
  subjectContactId: string | null;
  subjectIdentityId: string | null;
  subjectAgentId: string | null;
  subjectChannel: string | null;
  subjectRawId: string | null;
}

export function toSubjectColumns(subject: SubjectRef | null | undefined): SubjectColumns {
  return {
    subjectKind: subject?.kind ?? "unknown",
    subjectContactId: subject?.contactId ?? null,
    subjectIdentityId: subject?.identityId ?? null,
    subjectAgentId: subject?.agentId ?? null,
    subjectChannel: subject?.channel ?? null,
    subjectRawId: subject?.rawId ?? null,
  };
}

export function fromSubjectColumns(row: {
  subject_kind: string | null;
  subject_contact_id: string | null;
  subject_identity_id: string | null;
  subject_agent_id: string | null;
  subject_channel: string | null;
  subject_raw_id: string | null;
}): SubjectRef | undefined {
  const kind = clean(row.subject_kind) as SubjectKind | undefined;
  if (!kind) return undefined;
  const subject: SubjectRef = {
    kind,
    ...(clean(row.subject_contact_id) ? { contactId: clean(row.subject_contact_id) } : {}),
    ...(clean(row.subject_identity_id) ? { identityId: clean(row.subject_identity_id) } : {}),
    ...(clean(row.subject_agent_id) ? { agentId: clean(row.subject_agent_id) } : {}),
    ...(clean(row.subject_channel) ? { channel: clean(row.subject_channel) } : {}),
    ...(clean(row.subject_raw_id) ? { rawId: clean(row.subject_raw_id) } : {}),
  };
  return subject;
}
