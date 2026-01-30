/**
 * Channel Plugin System - Public API
 */

// Core types
export type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ConfigAdapter,
  SecurityAdapter,
  OutboundAdapter,
  GatewayAdapter,
  StatusAdapter,
  ResolvedAccount,
  AccountState,
  InboundMessage,
  InboundMedia,
  OutboundOptions,
  OutboundMedia,
  SendResult,
  SecurityDecision,
  DmPolicy,
  GroupPolicy,
  AccountSnapshot,
  ChannelHealth,
  WhatsAppInbound,
  JidComponents,
} from "./types.js";

// Registry
export {
  registerPlugin,
  getPlugin,
  getAllPlugins,
  hasPlugin,
  unregisterPlugin,
  initAllPlugins,
  shutdownAllPlugins,
} from "./registry.js";

// Channel Manager
export {
  ChannelManager,
  createChannelManager,
} from "./manager/index.js";
export type {
  ChannelAccountSnapshot,
  ChannelRuntimeStore,
  ChannelGatewayContext,
  ChannelManagerConfig,
  ChannelManagerEvents,
} from "./manager/types.js";

// WhatsApp plugin
export * from "./whatsapp/index.js";
