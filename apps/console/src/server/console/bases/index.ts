// Public server API of Bases. Envelopes (Console and CLI routes) use
// `handleBasesRequest` / `handleBasesCliRequest`; Ravi Pages connector actions
// use the `*ForCaller` functions with a caller from `basesCallerForPagesViewer`.

export {
  basesCallerForPagesViewer,
  basesCallerFromCliAuth,
  basesCallerFromConsoleWorkspace,
  basesSystemCaller,
  type BasesCaller,
  type BasesCallerActorType,
  type BasesCallerSourceKind,
  type BasesCallerSurface,
} from "./context";
export {
  archiveRowThroughViewForCaller,
  chartDataForCaller,
  createRowThroughViewForCaller,
  describeViewForCaller,
  getRowThroughViewForCaller,
  queryViewForCaller,
  updateRowThroughViewForCaller,
  viewVersionForCaller,
  type BasesViewTarget,
} from "./for-caller";
export { handleBasesRequest, matchBasesRoute, type BasesHttpRequest, type BasesHttpResult } from "./http";
export { BASES_CLI_READ_SCOPE, BASES_CLI_WRITE_SCOPE, basesCliAccess, basesCliActorOptions, basesCliError, basesCliScopeFor, handleBasesCliRequest } from "./cli";
export { BASES_EVENT_CATEGORY } from "./events";
