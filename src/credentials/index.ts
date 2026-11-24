export {
  deleteSecret,
  describeSecret,
  readSecret,
  readSecretFromStdin,
  redactSecretRef,
  writeSecret,
  type SecretWriteInput,
} from "./backends.js";
export {
  CredentialBrokerError,
  isCredentialBrokerError,
  type CredentialBrokerErrorCode,
} from "./errors.js";
export {
  execCredentialBroker,
  explainCredentialPolicy,
  publicCredentialConnection,
  resolveCredentialSecret,
} from "./broker.js";
export {
  closeCredentialsDb,
  credentialConnectionId,
  ensureCredentialTables,
  getCredentialConnection,
  getCredentialsDbPath,
  listCredentialConnections,
  listCredentialLastUsedAt,
  listRecentCredentialAuditEvents,
  normalizeCredentialIdentifier,
  recordCredentialAuditEvent,
  removeCredentialConnection,
  setCredentialConnectionStatus,
  upsertCredentialConnection,
  type CredentialStoreOptions,
} from "./store.js";
export type {
  CredentialAuditEvent,
  CredentialAuditEventInput,
  CredentialBackend,
  CredentialConnectionPage,
  CredentialConnectionRecord,
  CredentialConnectionStatus,
  CredentialInventory,
  CredentialInventoryAuditEntry,
  CredentialInventoryItem,
  CredentialSecretDescription,
  CredentialSecretUnavailableReason,
  CredentialPolicyExplanation,
  PublicCredentialConnection,
} from "./types.js";
export {
  buildCredentialInventory,
  credentialSecretRefAlias,
  CREDENTIAL_INVENTORY_MAX_ITEMS,
  type BuildCredentialInventoryInput,
} from "./inventory.js";
