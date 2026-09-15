/**
 * Turn-immutable assistant transcript helpers.
 *
 * Visible assistant utterances must stay one chat.db row each. Providers can
 * still emit one `assistant.message` whose `text` is prior utterances
 * empty-joined (`primeiro?Olá`) plus the new reply. Persist must refuse that
 * blob, peel already-stored history, and keep only the new utterance(s).
 * Consecutive labeled chunks (`A1_LIVESTR_X` + `A2_LIVESTR_X`) must not
 * coalesce. A single incoming blob without punctuation stays one utterance.
 */

const UPPER_START = /^[\p{Lu}]/u;

export function looksLikeEmptyJoinMash(text: string): boolean {
  return findEmptyJoinBoundaries(text).length > 0;
}

export function splitEmptyJoinedAssistantUtterances(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const bounds = findEmptyJoinBoundaries(trimmed);
  if (bounds.length === 0) return [trimmed];

  const parts: string[] = [];
  let last = 0;
  for (const index of bounds) {
    const part = trimmed.slice(last, index).trim();
    if (part) parts.push(part);
    last = index;
  }
  const tail = trimmed.slice(last).trim();
  if (tail) parts.push(tail);
  return parts.length > 0 ? parts : [trimmed];
}

export function coalesceAssistantTextBlocks(blocks: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of blocks) {
    if (!raw) continue;
    if (result.length === 0) {
      result.push(raw);
      continue;
    }
    const previous = result[result.length - 1]!;
    if (shouldCoalesceAssistantBlocks(previous, raw)) {
      result[result.length - 1] = previous + raw;
      continue;
    }
    result.push(raw);
  }
  return result.map((block) => block.trim()).filter((block) => block.length > 0);
}

export function peelPersistedAssistantPrefix(text: string, existing: readonly string[]): string {
  let remaining = text.trim();
  let progressed = true;
  const rows = [...new Set(existing.map((row) => row.trim()).filter((row) => row.length > 0))].sort(
    (left, right) => right.length - left.length,
  );

  while (progressed && remaining) {
    progressed = false;
    for (const row of rows) {
      if (remaining === row) return "";
      if (!remaining.startsWith(row)) continue;
      remaining = remaining
        .slice(row.length)
        .replace(/^(?:\n\n|\n)+/, "")
        .trim();
      progressed = true;
      break;
    }
  }
  return remaining;
}

export function resolveVisibleAssistantUtterances(
  text: string,
  existingAssistantRows: readonly string[] = [],
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const peeled = peelPersistedAssistantPrefix(trimmed, existingAssistantRows);
  if (!peeled) return [];

  const seen = new Set(existingAssistantRows.map((row) => row.trim()).filter(Boolean));
  const utterances: string[] = [];
  for (const part of splitEmptyJoinedAssistantUtterances(peeled)) {
    if (seen.has(part)) continue;
    utterances.push(part);
    seen.add(part);
  }
  return utterances;
}

function findEmptyJoinBoundaries(text: string): number[] {
  const bounds: number[] = [];
  const pattern = /[.!?…](?=[\p{Lu}])/gu;
  for (const match of text.matchAll(pattern)) {
    const splitAt = (match.index ?? 0) + match[0].length;
    const left = text.slice(0, splitAt).trim();
    const right = text.slice(splitAt);
    if (isConversationalEmptyJoin(left, right)) {
      bounds.push(splitAt);
    }
  }
  return bounds;
}

function isConversationalEmptyJoin(left: string, right: string): boolean {
  if (!right || !UPPER_START.test(right)) return false;
  const punct = left.slice(-1);
  const leftBody = left.slice(0, -1).trim();
  if (!leftBody) return false;
  // Skip abbreviations such as "U." / "S." inside "U.S.Army".
  if (leftBody.length <= 2 && /^[\p{Lu}]+$/u.test(leftBody) && punct === ".") return false;
  if (punct === "?" || punct === "!") return right.length >= 2;
  if (/^[\p{Ll}]+$/u.test(leftBody) && leftBody.length >= 2) return right.length >= 2;
  return leftBody.length >= 4 && right.length >= 2;
}

function looksLikeStandaloneUtteranceToken(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6 || /\s/.test(trimmed)) return false;
  if (!/^[\p{Lu}][\p{L}\p{N}_]*[\p{L}\p{N}]$/u.test(trimmed)) return false;
  return /[\p{N}_]/u.test(trimmed);
}

function shouldCoalesceAssistantBlocks(previous: string, next: string): boolean {
  if (next.startsWith(" ") || next.startsWith("\n")) return true;
  if (/^[,;:]/.test(next.trimStart())) return true;
  const joined = previous + next;
  if (looksLikeEmptyJoinMash(joined)) return false;
  if (looksLikeStandaloneUtteranceToken(previous) && looksLikeStandaloneUtteranceToken(next)) {
    return false;
  }
  if (/^[a-zà-ÿ]/u.test(next.trimStart())) return true;
  return !/[.!?…]\s*$/.test(previous.trimEnd());
}
