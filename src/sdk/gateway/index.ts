/**
 * Public entry point for the SDK gateway.
 */

export { startGateway, GATEWAY_VERSION, createGatewayHandlerContext, handleGatewayRequest } from "./server.js";
export type { GatewayConfig, GatewayHandle, GatewayHandlerContext } from "./server.js";
export type { GatewayAuthConfig, ResolvedAuth, AuthFailureReason } from "./auth.js";
export { dispatch } from "./dispatcher.js";
export type { DispatchOptions, DispatchResult, AuditEvent } from "./dispatcher.js";
export { commandUrlPath, buildRouteTable, buildMetaPayload, API_PREFIX } from "./route-table.js";
export type { RouteTable, RegistryMetaPayload } from "./route-table.js";
