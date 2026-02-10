/**
 * Request/Reply via notif
 *
 * Provides a request-reply pattern over notif PubSub.
 * CLI commands emit a request with a unique replyTopic,
 * then wait for the gateway/daemon to send the result back.
 */

import { randomUUID } from "node:crypto";
import { notif } from "../notif.js";

/**
 * Send a request and wait for a reply via notif.
 *
 * @param topic - Topic to emit the request to
 * @param data - Request payload (replyTopic is injected automatically)
 * @param timeoutMs - Max time to wait for reply (default: 15s)
 * @returns The reply data
 */
export async function requestReply<T = Record<string, unknown>>(
  topic: string,
  data: Record<string, unknown>,
  timeoutMs = 15000
): Promise<T> {
  const replyTopic = `ravi._reply.${randomUUID()}`;

  // Start listening BEFORE emitting to avoid race condition
  const stream = notif.subscribe(replyTopic);

  // Emit the request with the reply topic
  await notif.emit(topic, { ...data, replyTopic });

  // Wait for first event or timeout
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        stream.return?.();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Request timeout (${timeoutMs}ms) on ${topic}`));
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of stream) {
          clearTimeout(timer);
          cleanup();
          const result = event.data as Record<string, unknown>;
          if (result.error) {
            reject(new Error(result.error as string));
          } else {
            resolve(result as T);
          }
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    })();
  });
}
