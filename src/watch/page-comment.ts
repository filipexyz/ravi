/**
 * Page comment events delivered through the Console Agent Inbox.
 *
 * Console's eventType is `page.comment.created` / `page.comment.resolved`
 * (not `watch.*`). The inbox runner republishes them as normalized watch
 * subjects so triggers can match them the same way bug follow matches
 * `ravi.watch.console.bug.status`.
 */

export const PAGE_COMMENT_CREATED_EVENT = "page.comment.created";
export const PAGE_COMMENT_RESOLVED_EVENT = "page.comment.resolved";

export const PAGE_COMMENT_EVENTS = [PAGE_COMMENT_CREATED_EVENT, PAGE_COMMENT_RESOLVED_EVENT] as const;

export type PageCommentEventType = (typeof PAGE_COMMENT_EVENTS)[number];

export const PAGE_COMMENT_CREATED_TOPIC = "ravi.watch.console.page.comment.created";
export const PAGE_COMMENT_RESOLVED_TOPIC = "ravi.watch.console.page.comment.resolved";

export const PAGE_COMMENT_CREATED_MESSAGE =
  "A comment was added on page {{data.payload.pageId}}. Tell the user what it says and include the page URL. Comment: {{data.payload.body}} URL: {{data.payload.url}}";

export const PAGE_COMMENT_RESOLVED_MESSAGE =
  "A comment was resolved on page {{data.payload.pageId}}. Tell the user and include the page URL. Comment: {{data.payload.body}} URL: {{data.payload.url}}";

export function isPageCommentInboxEvent(eventType: string): eventType is PageCommentEventType {
  return eventType === PAGE_COMMENT_CREATED_EVENT || eventType === PAGE_COMMENT_RESOLVED_EVENT;
}

export function pageCommentWatchSubject(eventType: PageCommentEventType): string {
  return eventType === PAGE_COMMENT_RESOLVED_EVENT ? PAGE_COMMENT_RESOLVED_TOPIC : PAGE_COMMENT_CREATED_TOPIC;
}
