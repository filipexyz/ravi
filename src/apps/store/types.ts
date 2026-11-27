/**
 * Ravi Apps store formats (spec apps/store).
 *
 * The official source publishes three signed JSON files next to each other:
 * `keys.json` (signed by a root key compiled into Ravi), `index.json` (signed
 * by a publication key listed in keys.json) and `blocklist.json` (signed by a
 * block key listed in keys.json). Each file has a detached `<file>.sig` with a
 * base64 Ed25519 signature over the exact bytes of the file.
 */

import { z } from "zod";

export const APP_SIGNERS_SCHEMA = "ravi.app-signers/v1";
export const APP_INDEX_SCHEMA = "ravi.app-index/v1";
export const APP_BLOCKLIST_SCHEMA = "ravi.app-blocklist/v1";
export const APP_BUNDLE_SCHEMA = "ravi.app-bundle/v1";
export const APP_RECEIPT_SCHEMA = "ravi.app-receipt/v1";
export const APP_STORE_STATE_SCHEMA = "ravi.app-store-state/v1";

export const APP_CLASSES = ["compose", "connector", "code"] as const;
export type RaviAppClass = (typeof APP_CLASSES)[number];

const publicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "an Ed25519 public key in base64 (32 bytes)");
const isoDateSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "an ISO date");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a hex SHA-256");
const serialSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const appKeysFileSchema = z.object({
  schema: z.literal(APP_SIGNERS_SCHEMA),
  serial: serialSchema,
  expires: isoDateSchema,
  publish: z.array(publicKeySchema).min(1),
  block: z.array(publicKeySchema).default([]),
});
export type AppKeysFile = z.infer<typeof appKeysFileSchema>;

export const appOperationGrantSchema = z.object({
  /** The command template the operation runs, or `builtin:<handler>`. */
  runs: z.string().nullable(),
  mutating: z.boolean(),
});

export const appGrantsSchema = z.object({
  contextAllow: z.array(z.string()),
  operations: z.record(z.string(), appOperationGrantSchema),
  hosts: z.array(z.string()).default([]),
  /** Credential connections the app may use (connector class; empty for compose). */
  connections: z.array(z.string()).default([]),
});
export type AppGrants = z.infer<typeof appGrantsSchema>;

export const appIndexVersionSchema = z.object({
  version: z.string().min(1),
  class: z.enum(APP_CLASSES),
  treeHash: sha256Schema,
  bundle: z.object({
    path: z.string().regex(/^bundles\/[a-z0-9][a-z0-9.-]*\.json$/, "bundles/<name>.json"),
    sha256: sha256Schema,
    size: z.number().int().positive(),
  }),
  grants: appGrantsSchema,
  engines: z.object({ ravi: z.string().optional() }).default({}),
  publishedAt: isoDateSchema,
  status: z.enum(["active", "yanked"]),
  security: z.boolean().default(false),
});
export type AppIndexVersion = z.infer<typeof appIndexVersionSchema>;

export const appIndexEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  publisher: z.string().min(1),
  versions: z.array(appIndexVersionSchema).min(1),
});
export type AppIndexEntry = z.infer<typeof appIndexEntrySchema>;

export const appIndexFileSchema = z.object({
  schema: z.literal(APP_INDEX_SCHEMA),
  source: z.string().min(1),
  serial: serialSchema,
  issuedAt: isoDateSchema,
  expires: isoDateSchema,
  apps: z.record(z.string(), appIndexEntrySchema),
});
export type AppIndexFile = z.infer<typeof appIndexFileSchema>;

export const appBlockEntrySchema = z.object({
  id: z.string().min(1),
  version: z.string().optional(),
  treeHash: sha256Schema.optional(),
  reason: z.string().default(""),
  blockedAt: isoDateSchema.optional(),
});
export type AppBlockEntry = z.infer<typeof appBlockEntrySchema>;

export const appBlocklistFileSchema = z.object({
  schema: z.literal(APP_BLOCKLIST_SCHEMA),
  serial: serialSchema,
  expires: isoDateSchema,
  blocked: z.array(appBlockEntrySchema),
});
export type AppBlocklistFile = z.infer<typeof appBlocklistFileSchema>;

export const appBundleFileSchema = z.object({
  schema: z.literal(APP_BUNDLE_SCHEMA),
  id: z.string().min(1),
  version: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
});
export type AppBundleFile = z.infer<typeof appBundleFileSchema>;

export const appReceiptSchema = z.object({
  schema: z.literal(APP_RECEIPT_SCHEMA),
  id: z.string(),
  source: z.enum(["official", "local"]),
  version: z.string(),
  class: z.enum(APP_CLASSES),
  treeHash: sha256Schema,
  grants: appGrantsSchema,
  packagePath: z.string(),
  installedAt: isoDateSchema,
  state: z.enum(["active", "quarantined"]),
  quarantine: z.object({ reason: z.string(), at: isoDateSchema }).nullable().default(null),
  exposedTo: z.array(z.string()).default([]),
  previous: z
    .array(
      z.object({ version: z.string(), treeHash: sha256Schema, packagePath: z.string(), class: z.enum(APP_CLASSES) }),
    )
    .default([]),
});
export type AppReceipt = z.infer<typeof appReceiptSchema>;

export const appStoreSourceStateSchema = z.object({
  schema: z.literal(APP_STORE_STATE_SCHEMA),
  keysSerial: z.number().int().nonnegative().default(0),
  indexSerial: z.number().int().nonnegative().default(0),
  blockSerial: z.number().int().nonnegative().default(0),
  refreshedAt: isoDateSchema.nullable().default(null),
});
export type AppStoreSourceState = z.infer<typeof appStoreSourceStateSchema>;

/** Error raised by store operations; `exitCode` follows the agent-first CLI contract. */
export class AppStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 | 3 = 1,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppStoreError";
  }
}
