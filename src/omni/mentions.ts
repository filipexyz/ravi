export interface OmniUserMention {
  id: string;
  type: "user";
}

export interface OmniMentionParticipant {
  platformUserId: string;
  normalizedPlatformUserId?: string | null;
  mentionUserId?: string | null;
  phoneJid?: string | null;
  phoneNumber?: string | null;
  displayName?: string | null;
}

export interface ResolvedOmniMention {
  id: string;
  placeholder: string;
  displayName?: string;
  source: "explicit" | "inline";
  matched: string;
}

export interface PreparedOmniMentionMessage {
  text: string;
  mentions: OmniUserMention[];
  resolved: ResolvedOmniMention[];
}

export interface InboundMentionReplacement {
  placeholder: string;
  replacement: string;
  id: string;
  displayName: string;
}

export interface InboundMentionTarget {
  id: string;
  displayName?: string;
}

interface ParticipantCandidate {
  participant: OmniMentionParticipant;
  keys: Set<string>;
}

interface InlineMentionAlias {
  participant: OmniMentionParticipant;
  surface: string;
}

type MentionPlaceholderMode = "display" | "native";

const MIN_WHATSAPP_MENTION_ID_DIGITS = 10;
const MAX_WHATSAPP_MENTION_ID_DIGITS = 15;

function cleanMentionRef(value: string): string {
  return value.trim().replace(/^@+/, "");
}

function baseIdentity(value: string): string {
  const trimmed = cleanMentionRef(value);
  return trimmed.includes("@") ? trimmed.slice(0, trimmed.indexOf("@")) : trimmed;
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

function isPlausibleWhatsAppMentionDigits(value: string): boolean {
  return value.length >= MIN_WHATSAPP_MENTION_ID_DIGITS && value.length <= MAX_WHATSAPP_MENTION_ID_DIGITS;
}

function isRawChannelIdentifierLabel(value: string): boolean {
  const cleaned = cleanMentionRef(value)
    .trim()
    .replace(/\s+\([^)]*\)\s*$/, "");
  if (!cleaned) return false;
  if (/^(?:lid|group):\d+$/i.test(cleaned)) return true;
  if (/^\d+@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(cleaned)) return true;
  const base = baseIdentity(cleaned);
  const digits = digitsOnly(base);
  return digits === base && isPlausibleWhatsAppMentionDigits(digits);
}

function asWhatsAppPhoneJid(value: string | null | undefined): string | undefined {
  const cleaned = value ? cleanMentionRef(value) : "";
  if (!cleaned) return undefined;
  if (/^\d+@s\.whatsapp\.net$/i.test(cleaned)) return cleaned;
  if (cleaned.includes("@") || cleaned.toLowerCase().startsWith("lid:") || cleaned.toLowerCase().startsWith("group:")) {
    return undefined;
  }
  const digits = digitsOnly(cleaned);
  return digits === cleaned && isPlausibleWhatsAppMentionDigits(digits) ? `${digits}@s.whatsapp.net` : undefined;
}

export function mentionPlaceholderForId(id: string): string {
  const base = baseIdentity(id);
  const digits = digitsOnly(base);
  return `@${digits || base.replace(/[^\p{L}\p{N}_-]+/gu, "") || base}`;
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function normalizeLookup(value: string): string {
  return cleanMentionRef(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactLookup(value: string): string {
  return normalizeLookup(value).replace(/\s+/g, "");
}

function rawMentionId(value: string): string | null {
  const cleaned = cleanMentionRef(value);
  if (!cleaned) return null;
  if (cleaned.includes("@")) return cleaned;
  const digits = digitsOnly(cleaned);
  return isPlausibleWhatsAppMentionDigits(digits) ? digits : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safeDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^@+/, "");
  if (!trimmed || trimmed === "-") return undefined;
  if (isRawChannelIdentifierLabel(trimmed)) return undefined;
  return trimmed;
}

function visibleMentionPlaceholderForDisplayName(value: string | null | undefined): string | undefined {
  const displayName = safeDisplayName(value ?? undefined);
  return displayName ? `@${displayName}` : undefined;
}

function collectMentionedJids(rawPayload: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  const addArray = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) add(item);
  };

  addArray(rawPayload?.mentionedJids);
  const message = asRecord(rawPayload?.message);
  const extendedTextMessage = asRecord(message?.extendedTextMessage);
  const contextInfo = asRecord(extendedTextMessage?.contextInfo);
  addArray(contextInfo?.mentionedJid);

  return Array.from(new Set(out));
}

function collectMentionedContacts(
  rawPayload: Record<string, unknown> | undefined,
): Array<{ id: string; name?: string }> {
  const contacts: Array<{ id: string; name?: string }> = [];
  const rawContacts = rawPayload?.mentionedContacts;
  if (!Array.isArray(rawContacts)) return contacts;

  for (const item of rawContacts) {
    const record = asRecord(item);
    if (!record) continue;
    const id = firstString(record.jid, record.id, record.platformUserId, record.userId, record.phone);
    if (!id) continue;
    contacts.push({
      id,
      name: safeDisplayName(firstString(record.name, record.displayName, record.pushName, record.notify)),
    });
  }

  return contacts;
}

export function extractInboundMentionTargets(rawPayload: Record<string, unknown> | undefined): InboundMentionTarget[] {
  const byId = new Map<string, InboundMentionTarget>();
  const add = (id: string | null | undefined, displayName?: string | null) => {
    const cleanId = id?.trim();
    if (!cleanId) return;
    const existing = byId.get(cleanId);
    const safeName = safeDisplayName(displayName ?? undefined);
    byId.set(cleanId, {
      id: cleanId,
      displayName: existing?.displayName ?? safeName,
    });
  };

  for (const contact of collectMentionedContacts(rawPayload)) {
    add(contact.id, contact.name);
  }
  for (const jid of collectMentionedJids(rawPayload)) {
    add(jid);
  }

  return Array.from(byId.values());
}

function mentionLookupKeys(id: string): string[] {
  const base = baseIdentity(id);
  const digits = digitsOnly(base);
  return Array.from(new Set([base, digits].filter(Boolean)));
}

function buildInboundMentionNameMap(input: {
  rawPayload?: Record<string, unknown>;
  resolveName?: (id: string) => string | null | undefined;
}): Map<string, { id: string; displayName: string }> {
  const byPlaceholder = new Map<string, { id: string; displayName: string }>();
  const add = (id: string, displayName: string | null | undefined) => {
    const safeName = safeDisplayName(displayName ?? undefined);
    if (!safeName) return;
    for (const key of mentionLookupKeys(id)) {
      byPlaceholder.set(key, { id, displayName: safeName });
    }
  };

  for (const contact of collectMentionedContacts(input.rawPayload)) {
    add(contact.id, contact.name ?? input.resolveName?.(contact.id));
  }
  for (const jid of collectMentionedJids(input.rawPayload)) {
    add(jid, input.resolveName?.(jid));
  }

  return byPlaceholder;
}

export function normalizeInboundMentionText(input: {
  text: string | null | undefined;
  rawPayload?: Record<string, unknown>;
  resolveName?: (id: string) => string | null | undefined;
}): { text: string | undefined; replacements: InboundMentionReplacement[] } {
  if (input.text === undefined || input.text === null) {
    return { text: undefined, replacements: [] };
  }

  const mentionNames = buildInboundMentionNameMap({
    rawPayload: input.rawPayload,
    resolveName: input.resolveName,
  });
  if (mentionNames.size === 0) return { text: input.text, replacements: [] };

  const replacements: InboundMentionReplacement[] = [];
  const text = input.text.replace(/(?<=^|\s)@(\d{6,})(?=\b|$|[,.!?;:])/gu, (placeholder, digits: string) => {
    const mention = mentionNames.get(digits);
    if (!mention) return placeholder;
    const replacement = `@${mention.displayName}`;
    replacements.push({
      placeholder,
      replacement,
      id: mention.id,
      displayName: mention.displayName,
    });
    return replacement;
  });

  return { text, replacements };
}

function participantIdentityValues(participant: OmniMentionParticipant): string[] {
  const values = [
    participant.platformUserId,
    participant.normalizedPlatformUserId,
    participant.mentionUserId,
    participant.phoneJid,
    participant.phoneNumber,
  ];
  return Array.from(new Set(values.map((value) => (value ? cleanMentionRef(value) : "")).filter(Boolean)));
}

function participantPhoneAliasBase(participant: OmniMentionParticipant): string | undefined {
  for (const value of [
    participant.mentionUserId,
    participant.phoneJid,
    participant.normalizedPlatformUserId,
    participant.phoneNumber,
  ]) {
    const jid = asWhatsAppPhoneJid(value);
    if (jid) return baseIdentity(jid);
  }
  return undefined;
}

function participantNativeMentionId(participant: OmniMentionParticipant): string {
  const platformUserId = cleanMentionRef(participant.platformUserId);
  if (!platformUserId) return cleanMentionRef(participant.mentionUserId ?? participant.platformUserId);
  if (platformUserId.includes("@")) return platformUserId;

  const platformDigits = digitsOnly(platformUserId);
  const phoneAlias = participantPhoneAliasBase(participant);
  if (platformDigits && platformDigits === platformUserId) {
    if (phoneAlias && phoneAlias !== platformDigits) return `${platformDigits}@lid`;
    if (isPlausibleWhatsAppMentionDigits(platformDigits)) return `${platformDigits}@s.whatsapp.net`;
  }

  return platformUserId;
}

function participantMentionId(participant: OmniMentionParticipant): string {
  return participantNativeMentionId(participant);
}

function addCandidateKey(keys: Set<string>, value: string | null | undefined): void {
  if (!value) return;
  const normalized = normalizeLookup(value);
  if (normalized) keys.add(normalized);
  const compact = compactLookup(value);
  if (compact) keys.add(compact);
}

function participantCandidates(participants: readonly OmniMentionParticipant[] = []): ParticipantCandidate[] {
  const firstTokenCounts = new Map<string, number>();
  for (const participant of participants) {
    const first = normalizeLookup(participant.displayName ?? "").split(" ")[0];
    if (first.length >= 2) firstTokenCounts.set(first, (firstTokenCounts.get(first) ?? 0) + 1);
  }

  return participants.map((participant) => {
    const keys = new Set<string>();
    for (const id of participantIdentityValues(participant)) {
      addCandidateKey(keys, id);
      addCandidateKey(keys, baseIdentity(id));
      addCandidateKey(keys, digitsOnly(id));
    }
    addCandidateKey(keys, participant.displayName ?? undefined);

    const first = normalizeLookup(participant.displayName ?? "").split(" ")[0];
    if (first.length >= 2 && firstTokenCounts.get(first) === 1) {
      keys.add(first);
    }

    return { participant, keys };
  });
}

function findParticipant(
  ref: string,
  participants: readonly OmniMentionParticipant[] = [],
): { participant: OmniMentionParticipant; ambiguous: boolean } | null {
  const normalized = normalizeLookup(ref);
  const compact = compactLookup(ref);
  const candidates = participantCandidates(participants);
  const exact = candidates.filter((candidate) => candidate.keys.has(normalized) || candidate.keys.has(compact));
  if (exact.length === 1) return { participant: exact[0].participant, ambiguous: false };
  if (exact.length > 1) return { participant: exact[0].participant, ambiguous: true };

  return null;
}

function firstNameCounts(participants: readonly OmniMentionParticipant[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const participant of participants) {
    const first = normalizeLookup(participant.displayName ?? "").split(" ")[0];
    if (first.length >= 2) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return counts;
}

function aliasSurfacesForParticipant(participant: OmniMentionParticipant, firstCounts: Map<string, number>): string[] {
  const surfaces = new Set<string>();
  const addSurface = (value: string | null | undefined) => {
    const clean = safeDisplayName(value ?? undefined);
    if (!clean) return;
    surfaces.add(clean);
    const ascii = stripDiacritics(clean);
    if (ascii !== clean) surfaces.add(ascii);
  };

  const displayName = safeDisplayName(participant.displayName ?? undefined);
  addSurface(displayName);

  const compactName = displayName ? compactLookup(displayName) : "";
  if (compactName.length >= 2 && compactName !== normalizeLookup(displayName ?? "")) {
    addSurface(compactName);
  }

  const first = displayName?.split(/\s+/)[0];
  const firstLookup = normalizeLookup(first ?? "");
  if (first && firstLookup.length >= 2 && firstCounts.get(firstLookup) === 1) {
    addSurface(first);
  }

  for (const id of participantIdentityValues(participant)) {
    const base = baseIdentity(id);
    const digits = digitsOnly(base);
    if (digits && digits === base && isPlausibleWhatsAppMentionDigits(digits)) {
      surfaces.add(digits);
    }
  }

  return Array.from(surfaces).filter((surface) => normalizeLookup(surface));
}

function buildInlineMentionAliases(participants: readonly OmniMentionParticipant[]): InlineMentionAlias[] {
  const firstCounts = firstNameCounts(participants);
  const byLookup = new Map<string, InlineMentionAlias[]>();

  for (const participant of participants) {
    for (const surface of aliasSurfacesForParticipant(participant, firstCounts)) {
      const lookup = normalizeLookup(surface);
      if (!lookup) continue;
      const aliases = byLookup.get(lookup) ?? [];
      aliases.push({ participant, surface });
      byLookup.set(lookup, aliases);
    }
  }

  const uniqueAliases: InlineMentionAlias[] = [];
  for (const aliases of byLookup.values()) {
    const participantIds = new Set(aliases.map((alias) => participantMentionId(alias.participant)));
    if (participantIds.size !== 1) continue;
    uniqueAliases.push(...aliases);
  }

  const seen = new Set<string>();
  return uniqueAliases
    .filter((alias) => {
      const key = `${participantMentionId(alias.participant)}:${alias.surface}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.surface.length - left.surface.length);
}

function inlineAliasRegex(surface: string): RegExp {
  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<=^|\\s)@${escaped}(?![\\p{L}\\p{N}_-])`, "giu");
}

function isVisiblePlaceholderAt(text: string, offset: number, placeholder: string): boolean {
  return normalizeLookup(text.slice(offset, offset + placeholder.length)) === normalizeLookup(placeholder);
}

function resolveMention(
  ref: string,
  participants: readonly OmniMentionParticipant[] = [],
): { id: string; displayName?: string; ambiguous?: boolean } | null {
  const participant = findParticipant(ref, participants);
  if (participant?.ambiguous) return { id: participantMentionId(participant.participant), ambiguous: true };
  if (participant) {
    return {
      id: participantMentionId(participant.participant),
      ...(participant.participant.displayName?.trim()
        ? { displayName: participant.participant.displayName.trim() }
        : {}),
    };
  }

  const raw = rawMentionId(ref);
  if (raw) return { id: raw };
  return null;
}

function addResolvedMention(
  resolvedById: Map<string, ResolvedOmniMention>,
  input: { id: string; displayName?: string; matched: string; placeholder?: string; source: "explicit" | "inline" },
): ResolvedOmniMention {
  const existing = resolvedById.get(input.id);
  if (existing) return existing;
  const resolved: ResolvedOmniMention = {
    id: input.id,
    placeholder:
      input.placeholder ??
      visibleMentionPlaceholderForDisplayName(input.displayName) ??
      mentionPlaceholderForId(input.id),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    source: input.source,
    matched: input.matched,
  };
  resolvedById.set(input.id, resolved);
  return resolved;
}

function mentionPlaceholderForMode(
  id: string,
  displayName: string | null | undefined,
  mode: MentionPlaceholderMode,
): string {
  return mode === "native"
    ? mentionPlaceholderForId(id)
    : (visibleMentionPlaceholderForDisplayName(displayName) ?? mentionPlaceholderForId(id));
}

function replaceInlineMentions(
  text: string,
  participants: readonly OmniMentionParticipant[],
  resolvedById: Map<string, ResolvedOmniMention>,
  placeholderMode: MentionPlaceholderMode,
): string {
  let out = text;
  for (const alias of buildInlineMentionAliases(participants)) {
    out = out.replace(inlineAliasRegex(alias.surface), (match, offset: number, fullText: string) => {
      const id = participantMentionId(alias.participant);
      if (placeholderMode === "display" && !visibleMentionPlaceholderForDisplayName(alias.participant.displayName)) {
        return match;
      }
      const placeholder = mentionPlaceholderForMode(id, alias.participant.displayName, placeholderMode);
      const resolved = addResolvedMention(resolvedById, {
        id,
        ...(alias.participant.displayName?.trim() ? { displayName: alias.participant.displayName.trim() } : {}),
        matched: match,
        placeholder,
        source: "inline",
      });
      if (isVisiblePlaceholderAt(fullText, offset, placeholder)) return match;
      return resolved.placeholder;
    });
  }
  return out;
}

function replaceExplicitPlaceholder(text: string, target: string, placeholder: string, displayName?: string): string {
  const tokens = new Set<string>();
  const cleaned = cleanMentionRef(target);
  if (cleaned && !cleaned.includes(" ")) tokens.add(cleaned);
  const displayFirst = normalizeLookup(displayName ?? "").split(" ")[0];
  if (displayFirst.length >= 2) tokens.add(displayFirst);
  tokens.add(baseIdentity(cleaned));

  for (const token of tokens) {
    if (!token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const next = text.replace(new RegExp(`(?<=^|\\s)@${escaped}(?=\\s|$|[,.!?;:])`, "iu"), placeholder);
    if (next !== text) return next;
  }

  return `${placeholder} ${text}`.trim();
}

export function prepareOmniMentionMessage(input: {
  text: string;
  explicitTargets?: readonly string[];
  participants?: readonly OmniMentionParticipant[] | null;
  autoResolveInline?: boolean;
  autoResolvePhoneNumbers?: boolean;
  placeholderMode?: MentionPlaceholderMode;
}): PreparedOmniMentionMessage {
  const participants = input.participants ?? [];
  const placeholderMode = input.placeholderMode ?? "display";
  const explicitTargets = [...(input.explicitTargets ?? [])].map(cleanMentionRef).filter(Boolean);
  const resolvedById = new Map<string, ResolvedOmniMention>();
  let text =
    input.autoResolveInline === false
      ? input.text
      : replaceInlineMentions(input.text, participants, resolvedById, placeholderMode);

  if (input.autoResolvePhoneNumbers === true) {
    for (const match of text.matchAll(/(?<=^|\s)@(\d{10,15})(?=\b|$|[,.!?;:])/gu)) {
      if (Array.from(resolvedById.values()).some((mention) => mention.placeholder === match[0])) continue;
      const digits = match[1];
      if (!digits || !isPlausibleWhatsAppMentionDigits(digits)) continue;
      const id = asWhatsAppPhoneJid(digits);
      if (!id) continue;
      addResolvedMention(resolvedById, {
        id,
        matched: match[0],
        placeholder: match[0],
        source: "inline",
      });
    }
  }

  for (const target of explicitTargets) {
    const resolution = resolveMention(target, participants);
    if (!resolution) {
      throw new Error(`Cannot resolve mention target "${target}". Use a group participant name, phone, or JID.`);
    }
    if (resolution.ambiguous) {
      throw new Error(`Mention target "${target}" is ambiguous in this chat. Use an explicit JID/phone.`);
    }

    const alreadyResolved = resolvedById.has(resolution.id);
    const resolved = addResolvedMention(resolvedById, {
      id: resolution.id,
      displayName: resolution.displayName,
      matched: target,
      placeholder: mentionPlaceholderForMode(resolution.id, resolution.displayName, placeholderMode),
      source: "explicit",
    });
    if (!alreadyResolved) {
      text = replaceExplicitPlaceholder(text, target, resolved.placeholder, resolved.displayName);
    }
  }

  const resolved = Array.from(resolvedById.values());
  return {
    text,
    mentions: resolved.map((mention) => ({ id: mention.id, type: "user" })),
    resolved,
  };
}
