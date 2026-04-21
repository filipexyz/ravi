/**
 * Session Router - Public API
 */

// Types
export type {
  DmScope,
  HeartbeatConfig,
  AgentConfig,
  RouteConfig,
  RouterConfig,
  SessionKeyParams,
  SessionEntry,
  MatchedRoute,
  ResolvedRoute,
} from "./types.js";

// Session Key
export {
  buildSessionKey,
  parseSessionKey,
  getAgentFromKey,
  matchSessionKey,
  deriveSourceFromSessionKey,
} from "./session-key.js";

// Resolver
export {
  matchPattern,
  findRoute,
  matchRoute,
  resolveRoute,
  expandHome,
  getAgentCwd,
} from "./resolver.js";

// Config
export {
  loadRouterConfig,
  getRaviDir,
  checkAgentDirs,
  ensureAgentDirs,
  // Agent CRUD
  getAgent,
  getAllAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentDebounce,
} from "./config.js";

// Router Database (direct access for CLI commands)
export {
  // Route operations
  dbCreateRoute,
  dbGetRoute,
  dbListRoutes,
  dbListRoutesBySessionName,
  dbRenameRouteSessionName,
  dbUpdateRoute,
  dbDeleteRoute,
  dbRestoreRoute,
  dbListDeletedRoutes,
  // Context registry
  dbCreateContext,
  dbGetContext,
  dbGetContextByKey,
  dbTouchContext,
  dbRevokeContext,
  dbUpdateContextCapabilities,
  dbDeleteContext,
  type ContextCapability,
  type ContextRecord,
  type ContextSource,
  // Settings
  dbGetSetting,
  dbSetSetting,
  dbDeleteSetting,
  dbListSettings,
  getDefaultAgentId,
  getDefaultDmScope,
  getAnnounceCompaction,
  getAccountForAgent,
  // Schema (for validation)
  DmScopeSchema,
  // Database management
  closeRouterDb,
  // Message metadata
  dbSaveMessageMeta,
  dbGetMessageMeta,
  dbListMessageMetaByChatId,
  dbCleanupMessageMeta,
  type MessageMetadata,
  // Session cleanup
  dbCleanupExpiredSessions,
  // Audit log
  dbListAuditLog,
  type AuditEntry,
  // Cost tracking
  dbInsertCostEvent,
  dbGetCostSummary,
  dbGetCostByAgent,
  dbGetCostForAgent,
  dbGetCostForSession,
  dbGetTopSessions,
  dbGetCostReport,
  type CostEvent,
} from "./router-db.js";

// Session Name
export {
  generateSessionName,
  ensureUniqueName,
  slugify,
} from "./session-name.js";

// Sessions
export {
  getOrCreateSession,
  getSession,
  getSessionByName,
  getSessionBySdkId,
  getSessionByProviderId,
  getSessionsByAgent,
  getMainSession,
  resolveSession,
  findSessionByAttributes,
  updateSdkSessionId,
  updateProviderSession,
  updateRuntimeProviderState,
  updateProviderSessionId,
  clearProviderSession,
  updateTokens,
  updateSessionName,
  updateSessionSource,
  updateSessionContext,
  updateSessionDisplayName,
  updateSessionHeartbeat,
  isNameTaken,
  deleteSession,
  deleteSessionByName,
  resetSession,
  listSessions,
  setSessionEphemeral,
  extendSession,
  makeSessionPermanent,
  getExpiringSessions,
  getExpiredSessions,
} from "./sessions.js";
