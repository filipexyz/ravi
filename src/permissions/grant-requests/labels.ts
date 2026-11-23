/**
 * Names on an approval prompt come from contacts and chat titles that anyone
 * can set, and channels render them as markup. Keep letters, digits and a few
 * plain separators, cap the length, and always show stable ids next to them so
 * a lookalike name cannot stand in for the target.
 */
export function safeLabel(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "")
    .replace(/[^\p{L}\p{N} .,:@#()+'/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

/** Ids rendered in code spans: nothing outside a conservative id alphabet. */
export function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@-]/g, "").slice(0, 80);
}
