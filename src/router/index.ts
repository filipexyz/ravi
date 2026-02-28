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
  dbUpdateRoute,
  dbDeleteRoute,
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
  dbCleanupMessageMeta,
  type MessageMetadata,
  // Session cleanup
  dbCleanupExpiredSessions,
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
  getSessionsByAgent,
  getMainSession,
  resolveSession,
  findSessionByAttributes,
  updateSdkSessionId,
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
