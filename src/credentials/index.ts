export {
  deleteSecret,
  readSecret,
  readSecretFromStdin,
  redactSecretRef,
  writeSecret,
  type SecretWriteInput,
} from "./backends.js";
export {
  classifySecretReadError,
  CREDENTIAL_SECRET_ERROR_CODES,
  CredentialAuditWriteError,
  execCredentialBroker,
  explainCredentialPolicy,
  publicCredentialConnection,
  resolveCredentialSecret,
  type CredentialSecretErrorCode,
} from "./broker.js";
export {
  closeCredentialsDb,
  credentialConnectionId,
  ensureCredentialTables,
  getCredentialConnection,
  getCredentialsDbPath,
  listCredentialConnections,
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
  CredentialPolicyExplanation,
  PublicCredentialConnection,
} from "./types.js";
