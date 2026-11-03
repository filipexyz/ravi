import { ConsoleApiError } from "@/server/console/api-error";
import {
  curatedPlatformUsesSnapshot,
  parseStoredConnectorUsesSnapshot,
  unionConnectorUsesSnapshots,
  withAlwaysAllowlistedUses,
  type PagesConnectorUsesSnapshot,
} from "./catalog";

/** This is the same installation-mode flag as the neutral OIDC auth adapter. */
export function isolatedPagesOriginsRequired(): boolean {
  return process.env.RAVI_AUTH_MODE === "oidc";
}

/**
 * One origin is one trust domain. Path, Referer and a readable route token cannot
 * distinguish hostile sibling code. Compare actual authority, not the route name.
 * `null` metadata means a missing artifact join, never an absent manifest field.
 */
export function connectorUsesForOrigin(
  metadata: Array<unknown>,
  options: { isolated?: boolean; error?: string; status?: number } = {},
): PagesConnectorUsesSnapshot | null {
  const isolated = options.isolated ?? isolatedPagesOriginsRequired();
  const deny = () => {
    throw new ConsoleApiError(options.status ?? 403, {
      error: options.error ?? "connector_origin_grants_conflict",
    });
  };
  const snapshots = metadata.map((value) => {
    const snapshot = parseStoredConnectorUsesSnapshot(value);
    if (isolated) {
      if (!value || typeof value !== "object" || Array.isArray(value)) deny();
      const record = value as Record<string, unknown>;
      const manifest = record.packageManifest;
      const declared = "connectors" in record || "uses" in record ||
        (manifest && typeof manifest === "object" && "uses" in manifest);
      // Invalid declared authority is not equivalent to an omitted allowlist.
      if (declared && !snapshot) deny();
    }
    return snapshot;
  });
  if (!isolated) return unionConnectorUsesSnapshots(snapshots);
  if (!snapshots.length) deny();
  const effective = snapshots.map((snapshot) => withAlwaysAllowlistedUses(snapshot ?? curatedPlatformUsesSnapshot()));
  const signature = (snapshot: PagesConnectorUsesSnapshot) => JSON.stringify({
    schema: snapshot.catalogSchemaVersion,
    uses: [...snapshot.uses].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, revision }) => [id, revision]),
  });
  const first = effective[0]!;
  if (effective.some((snapshot) => signature(snapshot) !== signature(first))) deny();
  return first;
}
