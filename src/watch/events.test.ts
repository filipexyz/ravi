import { describe, expect, it } from "bun:test";
import type { InboxNatsPayload } from "../inbox/types.js";
import { eventSubject } from "./connectors.js";
import { watchEventFromInboxPayload } from "./events.js";

describe("watch events", () => {
  it("maps Console inbox watch items to trigger-ready NATS subjects", () => {
    const inbox = makeInboxPayload({
      eventType: "watch.github.pull_request.merged",
      payload: {
        watch: {
          id: "watch_123",
          provider: "github",
          placement: "console",
          resourceRef: "filipexyz/ravi",
          eventTypes: ["pull_request.merged"],
        },
        number: 42,
        merged: true,
      },
    });

    const event = watchEventFromInboxPayload(inbox, { inboxItemId: 7 });

    expect(event).toMatchObject({
      version: 1,
      eventId: "item_123",
      watchId: "watch_123",
      connector: "github",
      placement: "console",
      eventType: "pull_request.merged",
      subject: "ravi.watch.github.pull_request.merged",
      dedupeKey: "watch:watch_123:github:delivery_123",
      delivery: {
        subscriptionId: "sub_123",
        pollId: "poll_123",
        leaseId: "lease_123",
        inboxEventId: "item_123",
        inboxItemId: 7,
      },
      payload: {
        number: 42,
        merged: true,
      },
    });
    expect(event?.payload.watch).toMatchObject({ id: "watch_123", resourceRef: "filipexyz/ravi" });
    expect(event?.links?.[0]).toEqual({ label: "PR", url: "https://github.com/filipexyz/ravi/pull/42" });
  });

  it("ignores non-watch inbox items", () => {
    expect(watchEventFromInboxPayload(makeInboxPayload({ eventType: "mail.message.received" }))).toBeNull();
  });

  it("keeps watch subject generation stable", () => {
    expect(eventSubject("npm", "package.version_published")).toBe("ravi.watch.npm.package.version_published");
  });
});

function makeInboxPayload(overrides: Partial<InboxNatsPayload> = {}): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_123",
    sequence: 12,
    dedupeKey: "watch:watch_123:github:delivery_123",
    eventType: "watch.github.pull_request.merged",
    category: "source_control",
    severity: "info",
    sensitivity: "private",
    title: "PR merged",
    summary: "filipexyz/ravi#42 merged",
    organization: { id: "org_123" },
    project: null,
    source: {
      type: "github_webhook",
      provider: "github",
      providerEventType: "pull_request",
      providerAction: "closed",
      deliveryId: "delivery_123",
      repositoryFullName: "filipexyz/ravi",
    },
    actor: { type: "github_user", id: "octocat", login: "octocat" },
    target: { type: "github_repository", id: "repo_123", ref: "filipexyz/ravi" },
    payload: {
      watch: { id: "watch_123", provider: "github", placement: "console", resourceRef: "filipexyz/ravi" },
    },
    links: [{ label: "PR", url: "https://github.com/filipexyz/ravi/pull/42" }],
    delivery: {
      subscriptionId: "sub_123",
      installationId: "cli_123",
      pollId: "poll_123",
      leaseId: "lease_123",
      localDeliveredAt: "2026-05-21T16:00:00.000Z",
    },
    occurredAt: "2026-05-21T15:59:00.000Z",
    createdAt: "2026-05-21T16:00:00.000Z",
    ...overrides,
  };
}
