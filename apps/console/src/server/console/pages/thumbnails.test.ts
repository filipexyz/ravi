import { expect, test } from "bun:test";

import { pageThumbnailIdempotencyKey, planPageThumbnail, summarizeThumbnailAttempts } from "./thumbnails";

const ROUTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-16T12:00:00Z");

function attempt(status: "pending" | "capturing" | "ready" | "failed", minutesAgo: number) {
  return {
    routeId: ROUTE_ID,
    sourceArtifactVersionId: VERSION_ID,
    status,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
  };
}

test("a page version with no capture gets its first attempt", () => {
  expect(planPageThumbnail({ attempts: [], now: NOW, retry: false })).toEqual({ state: "pending", attempt: 1 });
});

test("a ready capture is never taken again, whatever came after it", () => {
  expect(
    planPageThumbnail({ attempts: [attempt("failed", 1), attempt("ready", 30)], now: NOW, retry: true }),
  ).toEqual({ state: "ready", attempt: null });
});

test("a capture still running is left alone until it is abandoned", () => {
  expect(planPageThumbnail({ attempts: [attempt("capturing", 1)], now: NOW, retry: false })).toEqual({
    state: "pending",
    attempt: null,
  });
  expect(planPageThumbnail({ attempts: [attempt("pending", 10)], now: NOW, retry: false })).toEqual({
    state: "pending",
    attempt: 2,
  });
});

test("a failed capture is tried again only when asked, and at most three times", () => {
  expect(planPageThumbnail({ attempts: [attempt("failed", 5)], now: NOW, retry: false })).toEqual({
    state: "failed",
    attempt: null,
  });
  expect(planPageThumbnail({ attempts: [attempt("failed", 5)], now: NOW, retry: true })).toEqual({
    state: "pending",
    attempt: 2,
  });
  expect(
    planPageThumbnail({
      attempts: [attempt("failed", 1), attempt("failed", 5), attempt("pending", 20)],
      now: NOW,
      retry: true,
    }),
  ).toEqual({ state: "failed", attempt: null });
});

test("the idempotency key names the page version and the attempt", () => {
  const first = pageThumbnailIdempotencyKey({ routeId: ROUTE_ID, artifactVersionId: VERSION_ID, attempt: 1 });
  const second = pageThumbnailIdempotencyKey({ routeId: ROUTE_ID, artifactVersionId: VERSION_ID, attempt: 2 });
  expect(first).toMatch(new RegExp(`^thumb:v1:${ROUTE_ID}:${VERSION_ID}:[a-f0-9]{16}:1$`));
  expect(second.endsWith(":2")).toBe(true);
  expect(first.length).toBeLessThanOrEqual(200);
});

test("the screen hears about a failed version, and can retry only while attempts are left", () => {
  expect(summarizeThumbnailAttempts([], NOW)).toBeNull();
  expect(summarizeThumbnailAttempts([attempt("ready", 5)], NOW)).toBeNull();
  // Abandoned: the screen asks again instead of showing a state.
  expect(summarizeThumbnailAttempts([attempt("pending", 10)], NOW)).toBeNull();
  expect(summarizeThumbnailAttempts([attempt("capturing", 1)], NOW)).toEqual({
    status: "pending",
    at: NOW.getTime() - 60_000,
    retryable: false,
  });
  expect(summarizeThumbnailAttempts([attempt("failed", 20), attempt("failed", 5)], NOW)).toEqual({
    status: "failed",
    at: NOW.getTime() - 5 * 60_000,
    retryable: true,
  });
  expect(summarizeThumbnailAttempts([attempt("failed", 1), attempt("failed", 5), attempt("failed", 9)], NOW)).toEqual({
    status: "failed",
    at: NOW.getTime() - 60_000,
    retryable: false,
  });
});
