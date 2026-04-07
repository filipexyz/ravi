export interface OverlayChatRowMatchHints {
  title?: string | null;
  preview?: string | null;
  timeLabel?: string | null;
  chatIdCandidate?: string | null;
}

export interface OmniChatMatchCandidate {
  externalId?: string | null;
  canonicalId?: string | null;
  name?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  updatedAt?: string | null;
}

export function matchOmniChatFromRow<T extends OmniChatMatchCandidate>(
  row: OverlayChatRowMatchHints,
  chats: T[],
): T | null {
  const chatIdVariants = buildOmniChatIdVariants(row.chatIdCandidate);
  if (chatIdVariants.length > 0) {
    const byChatId = chats
      .filter((chat) => {
        const values = [chat.externalId, chat.canonicalId].map(normalizeLookupToken).filter(Boolean) as string[];
        return values.some((value) => chatIdVariants.includes(value));
      })
      .sort((a, b) => compareChatRecencyDesc(a, b))[0];
    if (byChatId) {
      return byChatId;
    }
  }

  const titleNeedle = normalizeComparable(row.title);
  if (!titleNeedle) return null;

  const previewNeedle = normalizeComparable(row.preview);
  const timeNeedle = normalizeTimeLabel(row.timeLabel);
  const titleIsShortGeneric = isShortGenericNeedle(titleNeedle);

  const ranked = chats
    .map((chat) => {
      const titleScore = scoreComparableField(chat.name, titleNeedle, 300);
      if (titleScore === 0) return null;

      const previewScore = previewNeedle ? scorePreviewField(chat.lastMessagePreview, previewNeedle) : 0;
      const timeScore = timeNeedle ? scoreTimeLabel(timeNeedle, chat.lastMessageAt ?? chat.updatedAt) : 0;
      const supportScore = previewScore + timeScore;

      if (titleIsShortGeneric && titleScore < 1000 && previewScore === 0) {
        return null;
      }

      return {
        chat,
        score: titleScore + supportScore,
        titleScore,
        previewScore,
        supportScore,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        compareChatRecencyDesc(a.chat, b.chat) ||
        b.score - a.score ||
        b.supportScore - a.supportScore ||
        compareIsoDateDesc(b.chat.lastMessageAt ?? b.chat.updatedAt, a.chat.lastMessageAt ?? a.chat.updatedAt),
    );

  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best) return null;
  if (titleIsShortGeneric && best.titleScore < 1000 && best.previewScore === 0) return null;
  if (best.titleScore < 1000 && best.score < 540) return null;
  if (runnerUp && best.score - runnerUp.score < 80 && compareChatRecencyDesc(best.chat, runnerUp.chat) === 0) {
    return null;
  }
  return best.chat;
}

export function buildOmniChatIdVariants(value: string | null | undefined): string[] {
  const normalized = normalizeLookupToken(value);
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  if (/^\d+$/.test(normalized)) {
    variants.add(`${normalized}@g.us`);
    variants.add(`${normalized}@s.whatsapp.net`);
    variants.add(`group:${normalized}`);
  }

  const groupMatch = normalized.match(/^group:(.+)$/);
  if (groupMatch) {
    variants.add(`${groupMatch[1]}@g.us`);
  }

  const groupJid = normalized.match(/^(.+)@g\.us$/);
  if (groupJid) {
    variants.add(groupJid[1]);
    variants.add(`group:${groupJid[1]}`);
  }

  const dmJid = normalized.match(/^(\d+)@s\.whatsapp\.net$/);
  if (dmJid) {
    variants.add(dmJid[1]);
  }

  return [...variants];
}

function scoreComparableField(rawField: string | null | undefined, needle: string, baseWeight: number): number {
  const field = normalizeComparable(rawField);
  if (!field) return 0;
  if (field === needle) return baseWeight + 1000;

  const fieldTokens = tokenizeComparable(field);
  const needleTokens = tokenizeComparable(needle);
  if (fieldTokens.length === 0 || needleTokens.length === 0) return 0;

  const overlap = fieldTokens.filter((token) => needleTokens.includes(token)).length;
  const allFieldTokensMatch = overlap === fieldTokens.length;
  const meaningfulField = field.length >= 5;

  if (allFieldTokensMatch && fieldTokens.length >= 2) {
    return baseWeight + 500 + overlap * 20 + field.length;
  }

  if (meaningfulField && fieldTokens.length >= 2 && overlap >= 2) {
    return baseWeight + 300 + overlap * 15 + field.length;
  }

  if (meaningfulField && fieldTokens.length >= 2 && (needle.includes(field) || field.includes(needle))) {
    return baseWeight + 220 + field.length;
  }

  if (
    meaningfulField &&
    fieldTokens.length === 1 &&
    field.length >= 4 &&
    (needle.includes(field) || field.includes(needle))
  ) {
    return baseWeight + 140 + field.length;
  }

  return 0;
}

function scorePreviewField(rawField: string | null | undefined, needle: string): number {
  const field = normalizeComparable(rawField);
  if (!field || !needle) return 0;
  if (field === needle) return 900;

  const shorter = field.length <= needle.length ? field : needle;
  const longer = field.length > needle.length ? field : needle;

  if (shorter.length >= 24 && (longer.startsWith(shorter) || shorter.startsWith(longer))) {
    return 620 + shorter.length;
  }

  if (shorter.length >= 36 && longer.includes(shorter)) {
    return 420 + Math.min(shorter.length, 120);
  }

  return 0;
}

function scoreTimeLabel(timeNeedle: string, isoLikeValue: string | null | undefined): number {
  const variants = buildTimeLabelVariants(isoLikeValue);
  return variants.includes(timeNeedle) ? 130 : 0;
}

function buildTimeLabelVariants(value: string | null | undefined): string[] {
  if (!value) return [];
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return [];
  }

  const date = new Date(timestamp);
  const variants = new Set<string>();
  for (const locale of ["pt-BR", "en-US"]) {
    variants.add(
      normalizeTimeLabel(
        new Intl.DateTimeFormat(locale, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(date),
      ),
    );
    variants.add(
      normalizeTimeLabel(
        new Intl.DateTimeFormat(locale, {
          weekday: "short",
        }).format(date),
      ),
    );
    variants.add(
      normalizeTimeLabel(
        new Intl.DateTimeFormat(locale, {
          day: "2-digit",
          month: "2-digit",
          year: "2-digit",
        }).format(date),
      ),
    );
    variants.add(
      normalizeTimeLabel(
        new Intl.DateTimeFormat(locale, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }).format(date),
      ),
    );
  }

  return [...variants].filter(Boolean);
}

function isShortGenericNeedle(value: string): boolean {
  const tokens = tokenizeComparable(value);
  return tokens.length === 1;
}

function normalizeComparable(value: string | null | undefined): string | null {
  const cleaned = cleanNullable(value);
  if (!cleaned) return null;
  const comparable = cleaned
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[@._-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return comparable.length > 0 ? comparable : null;
}

function tokenizeComparable(value: string): string[] {
  return value
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeTimeLabel(value: string | null | undefined): string {
  return (
    cleanNullable(value)
      ?.normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\./g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

function normalizeLookupToken(value: string | null | undefined): string | null {
  const cleaned = cleanNullable(value);
  if (!cleaned) return null;
  return cleaned.normalize("NFKC").trim().toLowerCase();
}

function cleanNullable(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compareIsoDateDesc(a: string | null | undefined, b: string | null | undefined): number {
  const aTime = a ? Date.parse(a) : 0;
  const bTime = b ? Date.parse(b) : 0;
  return aTime - bTime;
}

function compareChatRecencyDesc(a: OmniChatMatchCandidate, b: OmniChatMatchCandidate): number {
  return compareIsoDateDesc(b.lastMessageAt ?? b.updatedAt, a.lastMessageAt ?? a.updatedAt);
}
