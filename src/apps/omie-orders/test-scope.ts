import type { OmieScope } from "./scope.js";
import { registerOmieConversationAuthority } from "./conversation-authority.js";
import { createSlackOmieConversationAuthority } from "../../channels/slack/omie-conversation-authority.js";
/** Synthetic fixture only; never imported by the production executor. */
export const SCOPE: OmieScope = Object.freeze({
  app: "omie-orders",
  channelType: "slack",
  account: "example-slack",
  channel: "CEXAMPLE01",
  canonicalChat: "chat_example",
  executor: "example-executor",
  connection: "example-orders",
  channelConnection: "example-slack-connection",
});
// Tests compose like the daemon: the executor's suites run against the Slack adapter unless a test swaps it.
registerOmieConversationAuthority(createSlackOmieConversationAuthority());
