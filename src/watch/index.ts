export type {
  ConsoleWatch,
  ConsoleWatchCreateRequest,
  EffectiveWatchPlacement,
  WatchCapabilities,
  WatchConnectorDefinition,
  WatchConnectorEventType,
  WatchCreateInput,
  WatchFidelity,
  WatchListPage,
  WatchNatsPayload,
  WatchPlacement,
  WatchProvider,
  WatchRecord,
  WatchStatus,
} from "./types.js";

export {
  WATCH_CONNECTORS,
  eventSubject,
  getWatchConnector,
  listWatchConnectors,
  resolveEventTypes,
} from "./connectors.js";
export { WatchApiError, isWatchApiError } from "./errors.js";
export {
  createConsoleWatch,
  getWatchCapabilities,
  listConsoleWatches,
  listGithubInstallationRepos,
  listGithubInstallations,
  setConsoleWatchEnabled,
} from "./console-client.js";
export {
  createWatch,
  listWatchRecords,
  removeWatch,
  setWatchEnabled,
  showWatch,
  type WatchCreateResult,
} from "./operations.js";
export { deleteWatch, getWatch, listWatches, updateWatchStatus, upsertWatch } from "./watch-db.js";
export { watchEventFromInboxPayload } from "./events.js";
