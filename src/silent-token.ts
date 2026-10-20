/**
 * Silence delivery contract.
 *
 * `@@SILENT@@` is not a message: a response that is only the marker must not
 * reach a chat. The marker can arrive exact, with internal whitespace, split
 * across content fragments, or truncated by the provider/model. Classification
 * happens on the whole delivery text so prose that explains or quotes the
 * marker is still delivered verbatim.
 */

export const SILENT_TOKEN = "@@SILENT@@";

/** The marker without the leading `@@`, used to accept truncated tails. */
const SILENT_BODY = "SILENT@@";

function compactSilentText(text: string): string {
  return text.replace(/\s+/g, "").toUpperCase();
}

/**
 * True when the whole text is a silence marker (or a truncated/whitespace
 * variant of it), never when the marker is only part of a sentence.
 *
 * Empty or whitespace-only text is not classified here: callers decide how an
 * empty delivery is handled (empty response vs silent).
 */
export function isSilentTokenText(text: string): boolean {
  const compact = compactSilentText(text);
  if (!compact.startsWith("@@")) return false;
  const body = compact.slice(2);
  if (!body) return false;
  if (body.length > SILENT_BODY.length) return false;
  return SILENT_BODY.startsWith(body);
}

/** True when a delivery carries no text at all. */
export function isEmptyOrExactSilentText(text: string): boolean {
  return !text.trim() || isExactSilentTokenText(text);
}

/** Exact marker (whitespace/case tolerant) — used per content part, never for fragments. */
export function isExactSilentTokenText(text: string): boolean {
  return compactSilentText(text) === `@@${SILENT_BODY}`;
}

/**
 * Remove a marker used as a control prefix (`@@SILENT@@ text`), which is how
 * providers attach the marker to real content. Only a leading standalone
 * marker is removed: a marker cited inside prose is left untouched.
 */
export function stripLeadingSilentMarker(text: string): string {
  const match = text.match(/^\s*@@\s*SILEN(?:T)?\s*@?@?(?=\s|$)/i);
  return match ? text.slice(match[0].length).trimStart() : text.trim();
}
