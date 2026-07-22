export {
  deleteSecret,
  readSecret,
  readSecretFromStdin,
  redactSecretRef,
  replaceSecret,
  writeSecret,
  type SecretWriteInput,
} from "./backends.js";
export {
  CredentialAuthorizationError,
  execCredentialBroker,
  explainCredentialPolicy,
  publicCredentialConnection,
  resolveCredentialSecret,
  type CredentialBrokerDependencies,
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
  CredentialAuthorizationInput,
  CredentialBackend,
  CredentialCallerContext,
  CredentialConnectionPage,
  CredentialConnectionRecord,
  CredentialConnectionStatus,
  CredentialPolicyExplanation,
  PublicCredentialConnection,
} from "./types.js";
