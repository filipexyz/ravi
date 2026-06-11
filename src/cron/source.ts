import type { MessageTarget } from "../runtime/message-types.js";

export type CronPromptSource = Pick<MessageTarget, "channel" | "accountId" | "chatId" | "threadId"> & {
  suppressPresence?: boolean;
};

export function markCronSourceAsBackground(source: CronPromptSource | undefined): CronPromptSource | undefined {
  return source ? { ...source, suppressPresence: true } : undefined;
}
