/**
 * Public entry point for `@ravi-os/sdk`.
 *
 * The SDK is split into stable hand-written modules (`errors`, transports)
 * and four GENERATED files (`client`, `schemas`, `types`, `version`). Both are
 * re-exported here so consumers who just `import { RaviClient } from "@ravi-os/sdk"`
 * get a typed client out of the box.
 *
 * For tree-shaking and browser/edge compatibility, prefer the deep imports:
 *
 *   import { RaviClient } from "@ravi-os/sdk/client";
 *   import { createHttpTransport } from "@ravi-os/sdk/transport/http";
 */

export { RaviClient } from "./client.js";
export {
  createHttpTransport,
  type HttpTransportConfig,
} from "./transport/http.js";
export type { Transport, TransportCallInput } from "./transport/types.js";
export {
  RaviError,
  RaviAuthError,
  RaviPermissionError,
  RaviValidationError,
  RaviInternalError,
  RaviTransportError,
  type AuthFailureReason,
  type RaviIssue,
  type RaviErrorBody,
} from "./errors.js";
export { SDK_VERSION, REGISTRY_HASH, GIT_SHA } from "./version.js";
export * from "./types.js";
export * from "./schemas.js";
