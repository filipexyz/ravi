/**
 * Slack instance alias resolution.
 *
 * The native Slack adapter can address a workspace by its logical account slug
 * while existing platform identities may have been stored under the configured
 * legacy instance UUID (or the exact empty legacy scope). Exact-only lookup then
 * reports a known actor as unresolved.
 *
 * This module centralizes the slug/UUID alias derivation and the scoped lookup
 * order so identity reads and writes share one deterministic, testable contract:
 *
 *   1. resolve the canonical instance reference and its configured aliases;
 *   2. resolve only those scoped aliases (canonical first);
 *   3. fall back to the exact empty legacy scope after every scoped alias misses.
 *
 * Aliases are derived exclusively from explicit `RouterConfig`/`ConfigStore`
 * configuration for the same instance. Empty `instance_id` is never treated as a
 * wildcard, and another workspace is never searched.
 */

import { z } from "zod";
import type { RouterConfig } from "../../router/types.js";

/** Reason codes carried on Slack instance-scoped identity resolution provenance. */
export const SLACK_IDENTITY_RESOLVED_REASON = "resolved";
export const SLACK_IDENTITY_NOT_FOUND_REASON = "identity_not_found";
export const SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON = "ambiguous_instance_alias";

export const SlackInstanceResolutionReasonSchema = z.enum([
  SLACK_IDENTITY_RESOLVED_REASON,
  SLACK_IDENTITY_NOT_FOUND_REASON,
  SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON,
]);
export type SlackInstanceResolutionReason = z.infer<typeof SlackInstanceResolutionReasonSchema>;

/**
 * Structured, non-sensitive provenance attached to resolved and unresolved Slack
 * actor identities. Uses concrete field schemas so runtime metadata stays typed
 * rather than an opaque bag.
 */
export const SlackInstanceIdentityProvenanceSchema = z.object({
  source: z.literal("platform_identities"),
  channel: z.literal("slack"),
  /** Instance reference as received from the Slack runtime (slug or UUID). */
  receivedInstance: z.string(),
  /** Canonical instance reference derived from configuration. */
  canonicalInstance: z.string(),
  /** Instance scope the resolved identity was actually read from, when resolved. */
  matchedInstance: z.string().nullable(),
  reason: SlackInstanceResolutionReasonSchema,
});
export type SlackInstanceIdentityProvenance = z.infer<typeof SlackInstanceIdentityProvenanceSchema>;

export interface SlackInstanceAliasResolution {
  /** Trimmed instance reference as received from the Slack runtime. */
  received: string;
  /** Canonical instance reference used for new writes. */
  canonical: string;
  /**
   * Ordered, deduplicated, non-empty scoped aliases to resolve against, canonical
   * first. Never includes the empty legacy scope.
   */
  scopedAliases: string[];
  /** Whether an explicit slug<->UUID mapping was found in configuration. */
  configured: boolean;
}

type SlackAliasConfig = Pick<RouterConfig, "instances" | "instanceToAccount">;

function dedupeNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Derive the canonical Slack instance reference and its deterministic scoped
 * aliases for a received instance reference, using only explicit configuration.
 */
export function resolveSlackInstanceAliases(
  config: SlackAliasConfig | null | undefined,
  receivedInstanceId: string | null | undefined,
): SlackInstanceAliasResolution {
  const received = receivedInstanceId?.trim() ?? "";

  let slug: string | undefined;
  let uuid: string | undefined;

  if (config && received) {
    const instances = config.instances ?? {};
    const instanceToAccount = config.instanceToAccount ?? {};

    const mappedName = instanceToAccount[received];
    if (mappedName) {
      // Received value is a configured instance UUID mapped to a logical slug.
      slug = mappedName;
      uuid = received;
    } else if (instances[received]) {
      // Received value is a configured logical slug.
      slug = received;
    }

    if (slug && !uuid) {
      uuid = instances[slug]?.instanceId?.trim() || undefined;
    }
  }

  const configured = Boolean(slug && uuid);
  const canonical = uuid || slug || received;
  const scopedAliases = dedupeNonEmpty([canonical, slug, uuid, received]);

  return { received, canonical, scopedAliases, configured };
}

export interface SlackScopedIdentityResolution<T> {
  identity: T | null;
  matchedInstance: string | null;
  reason: SlackInstanceResolutionReason;
}

/**
 * Resolve an identity across the derived scoped aliases and the exact empty
 * legacy scope, failing closed when equivalent aliases resolve to different
 * owners.
 *
 * - Every scoped alias is consulted; if scoped matches disagree on owner the
 *   resolution fails closed with `ambiguous_instance_alias` and no identity —
 *   the first result is never chosen blindly.
 * - The exact empty legacy scope is consulted only after every scoped alias
 *   misses, and only when it is not already one of the scoped aliases.
 */
export function resolveScopedSlackIdentity<T>(
  aliases: SlackInstanceAliasResolution,
  lookup: (instanceId: string) => T | null,
  ownerKeyOf: (identity: T) => string | null,
): SlackScopedIdentityResolution<T> {
  const scopedMatches: Array<{ instanceId: string; identity: T }> = [];
  for (const scope of aliases.scopedAliases) {
    const identity = lookup(scope);
    if (identity) scopedMatches.push({ instanceId: scope, identity });
  }

  if (scopedMatches.length > 0) {
    const ownerKeys = new Set(scopedMatches.map((match) => ownerKeyOf(match.identity) ?? "unowned"));
    if (ownerKeys.size > 1) {
      return { identity: null, matchedInstance: null, reason: SLACK_AMBIGUOUS_INSTANCE_ALIAS_REASON };
    }
    const first = scopedMatches[0]!;
    return { identity: first.identity, matchedInstance: first.instanceId, reason: SLACK_IDENTITY_RESOLVED_REASON };
  }

  if (!aliases.scopedAliases.includes("")) {
    const legacy = lookup("");
    if (legacy) {
      return { identity: legacy, matchedInstance: "", reason: SLACK_IDENTITY_RESOLVED_REASON };
    }
  }

  return { identity: null, matchedInstance: null, reason: SLACK_IDENTITY_NOT_FOUND_REASON };
}

/** Build concrete, validated provenance for a Slack instance resolution outcome. */
export function buildSlackInstanceProvenance(
  aliases: SlackInstanceAliasResolution,
  outcome: { reason: SlackInstanceResolutionReason; matchedInstance: string | null },
): SlackInstanceIdentityProvenance {
  return SlackInstanceIdentityProvenanceSchema.parse({
    source: "platform_identities",
    channel: "slack",
    receivedInstance: aliases.received,
    canonicalInstance: aliases.canonical,
    matchedInstance: outcome.matchedInstance,
    reason: outcome.reason,
  });
}
