/**
 * Matrix Channel Plugin
 *
 * Public exports for Matrix channel integration.
 */

// Plugin
export { createMatrixPlugin } from "./plugin.js";

// Configuration
export {
  loadMatrixConfigFromEnv,
  loadMatrixConfigFromCredentials,
  loadMatrixConfig,
  isMatrixConfigured,
  parseConfig,
  safeParseConfig,
  getAccountConfig,
} from "./config.js";
export type {
  MatrixAccountConfigInput,
  MatrixConfigInput,
} from "./config.js";

// Credentials
export {
  loadCredentials,
  loadAllCredentials,
  saveCredentials,
  clearCredentials,
  clearAllCredentials,
  touchCredentials,
  listAccountIds,
  credentialsMatchConfig,
} from "./credentials.js";

// Session
export { sessionManager, resolveStoragePaths } from "./session.js";

// Types
export type {
  MatrixConfig,
  MatrixAccountConfig,
  MatrixStoredCredentials,
  MatrixCredentialsStore,
  MatrixStoragePaths,
  MatrixInbound,
  MatrixRawEvent,
  RoomMessageEventContent,
  EncryptedFile,
} from "./types.js";

export { EventType, MsgType, RelationType } from "./types.js";

// Outbound
export {
  sendMessage,
  sendTyping,
  sendReadReceipt,
  sendReaction,
  resolveRoomId,
} from "./outbound.js";

// Inbound
export {
  shouldProcessEvent,
  normalizeMessage,
  downloadMatrixMedia,
  debounceMessage,
  mergeMessages,
  getRoomInfo,
  getMemberDisplayName,
} from "./inbound.js";

// Direct room tracking
export { createDirectRoomTracker, type DirectRoomTracker } from "./direct.js";

// Status
export {
  recordReceived,
  recordSent,
  recordError,
  recordStart,
  heartbeat,
  getSnapshot,
  getHealth,
} from "./status.js";
