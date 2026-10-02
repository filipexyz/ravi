/**
 * WhatsApp channel naming.
 *
 * A WhatsApp channel row binds an instance by name. Channel names must be opaque
 * URL-safe ids (the same rule as `ChannelBackendOpaqueIdSchema`, channels/backend.ts),
 * while instance names are free text. When an instance name is not a valid channel
 * name, or is already taken, the channel gets a sanitized name and stores the
 * instance name in `defaults.instance`.
 *
 * Leaf module: it imports nothing from `src/**`, so `router-db.ts` can use it
 * without an import cycle.
 */

/** Same pattern as ChannelBackendOpaqueIdSchema; the length limit is 128 UTF-8 bytes. */
export const WHATSAPP_CHANNEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

const MAX_CHANNEL_NAME_BYTES = 128;
const SANITIZED_NAME_MAX_BYTES = 120;
const textEncoder = new TextEncoder();

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function isValidWhatsAppChannelName(name: string): boolean {
  return utf8Length(name) <= MAX_CHANNEL_NAME_BYTES && WHATSAPP_CHANNEL_NAME_RE.test(name);
}

function sanitize(accountName: string): string {
  const replaced = accountName
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  // Only ASCII is left, so one character is one byte.
  return replaced.slice(0, SANITIZED_NAME_MAX_BYTES);
}

/**
 * The channel name for a WhatsApp instance.
 *
 * `accountName` unchanged when it is valid and not taken. Otherwise:
 * NFKD → strip combining marks → replace every char outside [A-Za-z0-9._~-] with "-" →
 * collapse "-+" → trim leading chars until [A-Za-z0-9] → truncate to 120 bytes;
 * empty or still taken → `whatsapp-${instanceId.slice(0, 8)}`, then `-2`, `-3`, … until free.
 *
 * `isTaken(name)` is true when a channels row with that name exists (any provider, deleted or not).
 */
export function whatsappChannelNameFor(
  accountName: string,
  instanceId: string,
  isTaken: (name: string) => boolean,
): string {
  if (isValidWhatsAppChannelName(accountName) && !isTaken(accountName)) return accountName;

  const sanitized = sanitize(accountName);
  if (sanitized && isValidWhatsAppChannelName(sanitized) && !isTaken(sanitized)) return sanitized;

  const idPrefix = sanitize(instanceId.slice(0, 8));
  const base = idPrefix ? `whatsapp-${idPrefix}` : "whatsapp";
  if (!isTaken(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}
