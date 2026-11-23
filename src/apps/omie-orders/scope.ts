import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../../utils/paths.js";
import { AppError } from "./domain.js";
import { upgradeLegacyOmieScope } from "./legacy-scope.js";

export const OMIE_APP_ID = "omie-orders";
export interface OmieScope {
  readonly app: typeof OMIE_APP_ID;
  /** Which registered conversation adapter proves the turn and the membership. */
  readonly channelType: string;
  readonly account: string;
  /** The conversation id on that channel; its shape is checked by the adapter. */
  readonly channel: string;
  readonly canonicalChat: string;
  readonly executor: string;
  readonly connection: string;
  /** Broker connection the channel adapter uses for its membership read. */
  readonly channelConnection: string;
}

export const OMIE_SCOPE_FIELDS = [
  "app",
  "channelType",
  "account",
  "channel",
  "canonicalChat",
  "executor",
  "connection",
  "channelConnection",
] as const;

/** Validate an already-parsed configuration. Exported for tests; production reads the private file. */
export function parseOmieScope(raw: unknown): Readonly<OmieScope> {
  const value = upgradeLegacyOmieScope(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !(OMIE_SCOPE_FIELDS as readonly string[]).includes(key)) ||
    OMIE_SCOPE_FIELDS.some(
      (key) =>
        typeof (value as Record<string, unknown>)[key] !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test((value as Record<string, string>)[key]),
    ) ||
    (value as Record<string, unknown>).app !== OMIE_APP_ID
  )
    throw new Error("invalid scope");
  return Object.freeze({ ...(value as OmieScope) });
}

/** Operator-owned host configuration, never a manifest/argv/context override. No usable defaults. */
export function loadOmieScope(): Readonly<OmieScope> {
  try {
    return parseOmieScope(
      JSON.parse(readFileSync(join(getRaviStateDir(), "integrations", "omie-orders.json"), "utf8")),
    );
  } catch {
    // no-cause: Host configuration diagnostics may disclose private installation identifiers and paths.
    throw new AppError("OMIE_HOST_CONFIG_REQUIRED", "Configuração privada válida do executor é obrigatória.");
  }
}
