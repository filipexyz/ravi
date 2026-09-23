/**
 * Headless OmniConsumer used when Omni is not configured.
 *
 * Presence and delivery degrade to no-ops. These methods are part of the
 * gateway typing/presence surface and must never throw.
 */
import type { OmniConsumer } from "./consumer.js";

/** Public consumer methods the daemon and gateway may call without Omni. */
export type OmniConsumerStubSurface = Pick<
  OmniConsumer,
  "start" | "stop" | "getActiveTarget" | "clearActiveTarget" | "renewActiveTarget"
>;

export function createStubOmniConsumer(): OmniConsumer {
  const stub: OmniConsumerStubSurface = {
    start: async () => {},
    stop: async () => {},
    getActiveTarget: () => undefined,
    clearActiveTarget: async () => {},
    renewActiveTarget: async () => false,
  };
  return stub as OmniConsumer;
}
