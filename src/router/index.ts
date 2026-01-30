/**
 * Session Router - Public API
 */

// Types
export type {
  DmScope,
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
  saveRouterConfig,
  getRaviDir,
  getConfigPath,
  validateConfig,
  checkAgentDirs,
  ensureAgentDirs,
} from "./config.js";

// Sessions
export {
  getOrCreateSession,
  getSession,
  getSessionBySdkId,
  getSessionsByAgent,
  updateSdkSessionId,
  updateTokens,
  deleteSession,
  listSessions,
  closeSessions,
} from "./sessions.js";
