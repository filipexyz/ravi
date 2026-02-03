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
  // Tool Management
  setAgentTools,
  addAgentTool,
  removeAgentTool,
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
  // Schema (for validation)
  DmScopeSchema,
  // Database management
  closeRouterDb,
} from "./router-db.js";

// Sessions
export {
  getOrCreateSession,
  getSession,
  getSessionBySdkId,
  getSessionsByAgent,
  updateSdkSessionId,
  updateTokens,
  updateSessionSource,
  updateSessionDisplayName,
  updateSessionHeartbeat,
  deleteSession,
  listSessions,
} from "./sessions.js";
