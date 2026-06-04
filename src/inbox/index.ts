/**
 * Inbox Module - Public exports.
 *
 * Local poller that bridges the Console agent-inbox into NATS so existing
 * `ravi triggers` can react to Console events.
 */

export type {
  ConsoleInboxItem,
  ConsolePollResponse,
  ConsolePulseResponse,
  ConsoleSubscriptionPayload,
  ConsoleWatermarkPayload,
  InboxItemRow,
  InboxNatsPayload,
  InboxSubscriptionRow,
  InboxSubscriptionStatus,
} from "./types.js";
export { INBOX_NATS_SUBJECT } from "./types.js";
export {
  LOCAL_INBOX_MAIL_RECEIVED_SUBJECT,
  setLocalInboxEventPublisherForTests,
  type LocalInboxMailReceivedPayload,
} from "./local-events.js";

export {
  ackInboxItems,
  fetchInboxPulse,
  pollInboxItems,
  upsertGlobalInboxSubscription,
} from "./inbox-client.js";

export {
  countPendingItems,
  ensureSubscriptionRow,
  getItemById,
  getItemByItemId,
  getSubscriptionByOrg,
  listRecentItems,
  listSubscriptions,
  setSubscriptionEnabled,
  upsertDeliveredItem,
} from "./inbox-db.js";

export {
  getInboxRunner,
  getStatusSnapshot,
  runSingleTick,
  setEnabledForCurrentOrg,
  startInboxRunner,
  stopInboxRunner,
} from "./inbox-runner.js";

export type {
  LocalInboxActorType,
  LocalInboxEvent,
  LocalInboxItem,
  LocalInboxPriority,
  LocalInboxStatus,
  UpsertLocalInboxItemInput,
} from "./local-db.js";

export {
  ensureLocalInboxSchema,
  listLocalInboxEvents,
  listLocalInboxItems,
  listLocalInboxSources,
  markLocalInboxItem,
  projectMailMessageToInbox,
  readLocalInboxItem,
  upsertLocalInboxItem,
} from "./local-db.js";
