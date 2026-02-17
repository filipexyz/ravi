/**
 * WhatsApp Channel Plugin - Public API
 */

// Types
export type {
  WhatsAppConfig,
  WhatsAppConfigInput,
  AccountConfig,
  AccountConfigInput,
  AckReactionConfig,
} from "./config.js";

// Config utilities
export {
  WhatsAppConfigSchema,
  AccountConfigSchema,
  AckReactionSchema,
  parseConfig,
  safeParseConfig,
  getAccountConfig,
  mergeAccountConfig,
  DEFAULT_CONFIG,
  DEFAULT_ACCOUNT_CONFIG,
} from "./config.js";

// Normalization utilities
export {
  normalizePhone,
  phoneToJid,
  jidToSessionId,
  sessionIdToPhone,
  parseJid,
  buildJid,
  isGroup,
  isLid,
  isUser,
  isBroadcast,
  isPhoneNumber,
  formatPhone,
  WHATSAPP_SERVER,
  LID_SERVER,
  GROUP_SERVER,
  BROADCAST_JID,
} from "./normalize.js";

// Session management
export { sessionManager, SessionManager } from "./session.js";
export type { SessionEvents, ActiveSession } from "./session.js";

// Inbound processing
export {
  extractText,
  extractMedia,
  extractQuotedMessage,
  extractMentions,
  isMentioned,
  normalizeMessage,
  shouldProcess,
  debounceMessage,
  mergeMessages,
  downloadMedia,
} from "./inbound.js";
export type { FilterResult } from "./inbound.js";

// Outbound processing
export {
  sendMessage,
  sendTyping,
  sendReadReceipt,
  sendReaction,
  sendAckReaction,
} from "./outbound.js";

// Status tracking
export {
  recordReceived,
  recordSent,
  recordError,
  resetMetrics,
  clearAllMetrics,
  getSnapshot,
  getHealth,
  startWatchdog,
  stopWatchdog,
  heartbeat,
  getStats,
} from "./status.js";
export type { ChannelStats } from "./status.js";

// Plugin
export { createWhatsAppPlugin, whatsappPlugin, addWhatsAppAccount } from "./plugin.js";
