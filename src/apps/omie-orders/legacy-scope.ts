/**
 * LEGACY, scheduled for removal on 2027-01-31 (spec `apps/omie-orders`, "Legacy").
 *
 * The first installation's private configuration predates the channel port: it has no `channelType` and names the
 * membership connection `slackConnection`. Only that exact shape is upgraded, in memory, to the current one; the file
 * on disk is not rewritten. Any other shape passes through unchanged and is validated by `parseOmieScope`.
 * Remove this file and its call once every installation writes `channelType` and `channelConnection`.
 */
const LEGACY_FIELDS = ["app", "account", "channel", "canonicalChat", "executor", "connection", "slackConnection"];

export function upgradeLegacyOmieScope(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== LEGACY_FIELDS.length || !LEGACY_FIELDS.every((key) => keys.includes(key))) return raw;
  const { slackConnection, ...rest } = value;
  return { ...rest, channelType: "slack", channelConnection: slackConnection };
}
