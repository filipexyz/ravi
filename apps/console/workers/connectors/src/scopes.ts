/**
 * Provider scope selection for the connect flow and the access mode of a
 * connection.
 *
 * The Worker alone picks the scopes a connect requests: the adapter's
 * defaults plus the identity scopes, so the account (`sub`, email) can be
 * read from the token response. `read_only` drops every write scope from
 * the request and from what the connection stores, whatever else the
 * provider says the account granted before; the mode is kept on the row
 * (`metadata_json.accessMode`) and enforced on exec. "Allow writing" is a
 * reconnect of the same account with `full` access (Google keeps
 * incremental grants via `include_granted_scopes=true`).
 */

import type { ConnectorAdapter } from "./adapters/adapter";

export type ConnectorAccessMode = "full" | "read_only";

type ScopeAdapter = Pick<ConnectorAdapter, "defaultScopes" | "identityScopes" | "writeScopes">;

export function parseAccessMode(value: unknown): ConnectorAccessMode | null {
  return value === "full" || value === "read_only" ? value : null;
}

export function computeRequestedScopes(
  adapter: ScopeAdapter,
  input: { accessMode: ConnectorAccessMode },
): string[] {
  const scopes = uniqueScopes([...(adapter.identityScopes ?? []), ...adapter.defaultScopes]);
  if (input.accessMode !== "read_only") return scopes;
  const writeScopes = new Set(adapter.writeScopes ?? []);
  return scopes.filter((scope) => !writeScopes.has(scope));
}

/**
 * The scopes a connection stores after a connect. With incremental
 * authorization the provider lists every scope the account ever granted
 * the Ravi client, so a `read_only` connect keeps only what it requested,
 * minus any write scope.
 */
export function scopesToStore(
  adapter: ScopeAdapter,
  input: { granted: readonly string[]; requested: readonly string[]; accessMode: ConnectorAccessMode },
): string[] {
  const scopes = uniqueScopes(input.granted.length > 0 ? input.granted : input.requested);
  if (input.accessMode !== "read_only") return scopes;
  const requested = new Set(input.requested);
  const writeScopes = new Set(adapter.writeScopes ?? []);
  return scopes.filter((scope) => requested.has(scope) && !writeScopes.has(scope));
}

/** `read_only` when none of the granted scopes allows writing, else `full`. */
export function deriveAccessMode(
  grantedScopes: readonly string[],
  writeScopes: readonly string[],
): ConnectorAccessMode {
  const writes = new Set(writeScopes);
  return grantedScopes.some((scope) => writes.has(scope)) ? "full" : "read_only";
}

/** The access mode chosen at connect, when the row recorded one. */
export function storedAccessMode(metadata: Record<string, unknown> | null | undefined): ConnectorAccessMode | null {
  return parseAccessMode(metadata?.accessMode);
}

/**
 * A connection's access mode: `read_only` when it was connected read only,
 * whatever its scopes say; otherwise derived from the granted scopes
 * (rows connected before the mode was recorded).
 */
export function connectionAccessMode(
  connection: { scopesJson: readonly string[]; metadataJson: Record<string, unknown> | null | undefined },
  writeScopes: readonly string[],
): ConnectorAccessMode {
  if (storedAccessMode(connection.metadataJson) === "read_only") return "read_only";
  return deriveAccessMode(connection.scopesJson, writeScopes);
}

/** The required provider scopes `grantedScopes` does not cover (broader Google scopes count). */
export function missingRequiredProviderScopes(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
): string[] {
  return requiredScopes.filter(
    (requiredScope) => !grantedScopes.some((grantedScope) => providerScopeSatisfies(grantedScope, requiredScope)),
  );
}

function providerScopeSatisfies(grantedScope: string, requiredScope: string): boolean {
  if (grantedScope === requiredScope) return true;
  return impliedProviderScopes(grantedScope).includes(requiredScope);
}

function impliedProviderScopes(grantedScope: string): string[] {
  switch (grantedScope) {
    case "https://mail.google.com/":
      return [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ];
    case "https://www.googleapis.com/auth/gmail.modify":
      return ["https://www.googleapis.com/auth/gmail.readonly"];
    case "https://www.googleapis.com/auth/calendar":
      return ["https://www.googleapis.com/auth/calendar.readonly"];
    default:
      return [];
  }
}

function uniqueScopes(scopes: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of scopes) {
    const scope = typeof raw === "string" ? raw.trim() : "";
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    result.push(scope);
  }
  return result;
}
