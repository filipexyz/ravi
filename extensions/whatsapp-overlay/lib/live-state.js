import { getActiveServer, subscribe } from "../auth.js";
import { createStreamClient } from "./sdk/streaming.js";
import {
  applyGatewayTopicEvent,
  defaultLiveState,
  isBusyLiveActivity,
  normalizeLiveState,
} from "./live-state-model.js";

const RECONNECT_DELAY_MS = 5_000;

const liveBySessionName = new Map();
let activeStream = null;
let retryAfter = 0;
let subscribedToAuthChanges = false;
let lastStreamError = null;

export { isBusyLiveActivity };

export async function ensureLiveStateStream() {
  ensureAuthSubscription();
  const server = await getActiveServer();
  if (!server) {
    resetLiveStateStream({ clear: true });
    return false;
  }

  if (activeStream?.serverId === server.id) {
    return true;
  }

  const now = Date.now();
  if (now < retryAfter) {
    return false;
  }

  resetLiveStateStream();
  lastStreamError = null;

  const controller = new AbortController();
  const stream = createStreamClient({
    baseUrl: server.baseUrl,
    contextKey: server.contextKey,
  });

  const promise = consumeEventsStream(stream, controller.signal)
    .catch((error) => {
      if (!controller.signal.aborted) {
        lastStreamError = formatStreamError(error);
        retryAfter = Date.now() + RECONNECT_DELAY_MS;
      }
    })
    .finally(() => {
      if (activeStream?.promise === promise) {
        activeStream = null;
      }
    });

  activeStream = { serverId: server.id, controller, promise };
  return true;
}

export function resetLiveStateStream(options = {}) {
  if (activeStream) {
    activeStream.controller.abort();
    activeStream = null;
  }
  if (options.clear) {
    retryAfter = 0;
  }
  if (options.clear) {
    liveBySessionName.clear();
  }
}

export function getLiveForSession(session) {
  const names = [session?.name, session?.sessionName, session?.sessionKey].filter(
    (value) => typeof value === "string" && value.trim(),
  );
  const serverLive = session?.live ? normalizeLiveState(session.live, session) : null;

  for (const name of names) {
    const live = liveBySessionName.get(name);
    if (!live) continue;
    const cached = normalizeLiveState(live, session);
    if (!serverLive || (cached.updatedAt ?? 0) >= (serverLive.updatedAt ?? 0)) {
      return cached;
    }
  }

  if (serverLive) {
    return serverLive;
  }

  return defaultLiveState(session);
}

export function getLiveBySessionName() {
  return new Map(liveBySessionName);
}

export function getLiveStateStreamStatus() {
  return {
    connected: Boolean(activeStream),
    lastError: lastStreamError,
    retryAfter,
  };
}

async function consumeEventsStream(stream, signal) {
  for await (const event of stream.events({ subject: "ravi.session.>", noClaude: true, noHeartbeat: true, signal })) {
    if (signal.aborted) break;
    lastStreamError = null;
    ingestTopicEvent(event.data);
  }
}

function ingestTopicEvent(topicEvent) {
  const topic = typeof topicEvent?.topic === "string" ? topicEvent.topic : "";
  const sessionName = topic.startsWith("ravi.approval.")
    ? typeof topicEvent?.data?.sessionName === "string"
      ? topicEvent.data.sessionName
      : null
    : parseSessionName(topic);
  const current = sessionName ? liveBySessionName.get(sessionName) : undefined;
  const applied = applyGatewayTopicEvent(current, topicEvent);
  if (!applied) return;
  liveBySessionName.set(applied.sessionName, applied.live);
}

function parseSessionName(topic) {
  if (typeof topic !== "string" || !topic.startsWith("ravi.session.")) return null;
  const rest = topic.slice("ravi.session.".length);
  const dot = rest.lastIndexOf(".");
  return dot > 0 ? rest.slice(0, dot) : null;
}

function ensureAuthSubscription() {
  if (subscribedToAuthChanges) return;
  if (!globalThis.chrome?.storage?.onChanged) return;
  subscribedToAuthChanges = true;
  subscribe(() => {
    resetLiveStateStream({ clear: true });
  });
}

function formatStreamError(error) {
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return String(error || "live stream unavailable");
}
