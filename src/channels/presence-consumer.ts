import { StringCodec, type Subscription } from "nats";
import { getNats } from "../nats.js";
import type { MessageTarget } from "../runtime/message-types.js";
import { logger } from "../utils/logger.js";
import type { NativePresenceDelivery } from "./native/types.js";

const log = logger.child("channels:presence-consumer");
const sc = StringCodec();

export const CHANNEL_PRESENCE_SUBJECT_FILTER = "ravi.channel.presence.*";
export const CHANNEL_PRESENCE_QUEUE_GROUP = "ravi-channel-presence";

export interface ChannelPresenceRequest {
  channelId: string;
  sessionName: string;
  target: MessageTarget;
  active: boolean;
  reason?: string;
  timestamp: number;
}

export interface ChannelPresenceState {
  activeTargetsBySession: Map<string, MessageTarget>;
  recentTargetsBySession?: Map<string, Map<string, MessageTarget>>;
}

export interface ChannelPresenceConsumerOptions {
  deliveries: NativePresenceDelivery[];
  isRunning?: () => boolean;
  presenceState?: ChannelPresenceState;
}

export class ChannelPresenceConsumer {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private subscription: Subscription | null = null;
  private readonly presenceState: ChannelPresenceState;

  constructor(private readonly options: ChannelPresenceConsumerOptions) {
    this.presenceState = normalizePresenceState(options.presenceState);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.subscription = getNats().subscribe(CHANNEL_PRESENCE_SUBJECT_FILTER, {
      queue: CHANNEL_PRESENCE_QUEUE_GROUP,
    });
    this.loopPromise = this.runLoop(this.subscription);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.subscription?.unsubscribe();
    await this.loopPromise?.catch((error) => {
      log.debug("Channel presence consumer stopped after loop error", { error });
    });
    this.subscription = null;
    this.loopPromise = null;
  }

  isConsuming(): boolean {
    return this.running;
  }

  private shouldContinue(): boolean {
    return this.running && (this.options.isRunning?.() ?? true);
  }

  private async runLoop(subscription: Subscription): Promise<void> {
    for await (const msg of subscription) {
      if (!this.shouldContinue()) break;

      let request: ChannelPresenceRequest;
      try {
        request = JSON.parse(sc.decode(msg.data)) as ChannelPresenceRequest;
      } catch (error) {
        log.warn("Failed to parse channel presence request", { subject: msg.subject, error });
        continue;
      }

      await processChannelPresenceRequest(request, {
        ...this.options,
        presenceState: this.presenceState,
      });
    }
  }
}

export async function processChannelPresenceRequest(
  request: ChannelPresenceRequest,
  options: ChannelPresenceConsumerOptions,
): Promise<void> {
  const adapter = options.deliveries.find((candidate) => candidate.supports(request.target));
  if (!adapter) {
    log.debug("No native presence adapter registered for channel", {
      channelId: request.channelId,
      sessionName: request.sessionName,
    });
    return;
  }

  const state = options.presenceState;
  const currentTarget = state?.activeTargetsBySession.get(request.sessionName);

  try {
    const cleanupTargets: MessageTarget[] = [];

    if (request.active && currentTarget && !presenceTargetsMatch(currentTarget, request.target)) {
      cleanupTargets.push(currentTarget);
    }

    if (request.active) {
      for (const recentTarget of recentPresenceTargets(state, request.sessionName)) {
        if (!presenceTargetsMatch(recentTarget, request.target)) cleanupTargets.push(recentTarget);
      }
      const previousAnchorTarget = sourceFallbackAnchorTarget(request.target);
      if (previousAnchorTarget) {
        cleanupTargets.push(previousAnchorTarget);
      }
    }

    for (const target of uniquePresenceTargets(cleanupTargets)) {
      await sendPresenceUpdate(adapter, {
        sessionName: request.sessionName,
        target,
        active: false,
        reason: appendPresenceReason(request.reason, "replace-anchor"),
      });
    }

    if (!request.active && currentTarget && !presenceTargetsMatch(currentTarget, request.target)) {
      await sendPresenceUpdate(adapter, {
        sessionName: request.sessionName,
        target: currentTarget,
        active: false,
        reason: appendPresenceReason(request.reason, "current-anchor"),
      });
    }

    const result = await adapter.sendPresence({
      sessionName: request.sessionName,
      target: request.target,
      active: request.active,
      reason: request.reason,
    });
    if (state) {
      if (request.active && result.status === "active") {
        state.activeTargetsBySession.set(request.sessionName, request.target);
        rememberPresenceTarget(state, request.sessionName, request.target);
      } else if (!request.active) {
        state.activeTargetsBySession.delete(request.sessionName);
      }
    }
  } catch (error) {
    log.debug("Native channel presence update failed", {
      channelId: request.channelId,
      sessionName: request.sessionName,
      active: request.active,
      error,
    });
  }
}

async function sendPresenceUpdate(
  adapter: NativePresenceDelivery,
  request: Parameters<NativePresenceDelivery["sendPresence"]>[0],
): Promise<void> {
  try {
    await adapter.sendPresence(request);
  } catch (error) {
    log.debug("Native channel presence cleanup failed", {
      channelId: adapter.channelId,
      sessionName: request.sessionName,
      active: request.active,
      error,
    });
  }
}

function appendPresenceReason(reason: string | undefined, suffix: string): string {
  return reason ? `${reason}:${suffix}` : suffix;
}

function normalizePresenceState(state: ChannelPresenceState | undefined): ChannelPresenceState {
  return {
    activeTargetsBySession: state?.activeTargetsBySession ?? new Map(),
    recentTargetsBySession: state?.recentTargetsBySession ?? new Map(),
  };
}

function recentPresenceTargets(state: ChannelPresenceState | undefined, sessionName: string): MessageTarget[] {
  return Array.from(state?.recentTargetsBySession?.get(sessionName)?.values() ?? []);
}

function uniquePresenceTargets(targets: MessageTarget[]): MessageTarget[] {
  const uniqueTargets = new Map<string, MessageTarget>();
  for (const target of targets) {
    uniqueTargets.set(presenceTargetKey(target), target);
  }
  return Array.from(uniqueTargets.values());
}

function rememberPresenceTarget(state: ChannelPresenceState, sessionName: string, target: MessageTarget): void {
  state.recentTargetsBySession ??= new Map();
  const targets = state.recentTargetsBySession.get(sessionName) ?? new Map<string, MessageTarget>();
  targets.set(presenceTargetKey(target), target);
  while (targets.size > 8) {
    const firstKey = targets.keys().next().value;
    if (!firstKey) break;
    targets.delete(firstKey);
  }
  state.recentTargetsBySession.set(sessionName, targets);
}

function sourceFallbackAnchorTarget(target: MessageTarget): MessageTarget | null {
  if (!target.statusAnchorMessageId || !target.sourceMessageId) return null;
  if (target.statusAnchorMessageId === target.sourceMessageId) return null;
  const {
    statusAnchorMessageId: _statusAnchorMessageId,
    statusAnchorKind: _statusAnchorKind,
    ...sourceTarget
  } = target;
  return sourceTarget;
}

function presenceTargetsMatch(left: MessageTarget, right: MessageTarget): boolean {
  return presenceTargetKey(left) === presenceTargetKey(right);
}

function presenceTargetKey(target: MessageTarget): string {
  return [
    target.channel.toLowerCase(),
    target.instanceId ?? target.accountId,
    target.chatId,
    target.threadId ?? "",
    target.statusAnchorMessageId ?? target.sourceMessageId ?? "",
  ].join("\u0000");
}

export function subjectForChannelPresence(channelId: string): string {
  return `ravi.channel.presence.${toNatsToken(channelId)}`;
}

function toNatsToken(value: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token || "unknown";
}
