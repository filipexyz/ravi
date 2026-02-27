/**
 * Omni Consumer
 *
 * Subscribes to JetStream streams published by omni-v2 and translates
 * incoming message events into ravi session prompts.
 *
 * Replaces the channel plugin inbound subscriptions in gateway.ts.
 */

import { AckPolicy, DeliverPolicy, StringCodec, type JetStreamClient, type JetStreamManager } from "nats";
import { getNats, publish } from "../nats.js";
import { nats } from "../nats.js";
import { publishSessionPrompt } from "./session-stream.js";
import { handleSlashCommand } from "../slash/index.js";

const CONSUMER_READY_TIMEOUT = 60_000; // Wait up to 60s for streams to appear
const UNREGISTERED_COOLDOWN_MS = 5 * 60_000; // 5 min cooldown per instanceId
const unregisteredCooldowns = new Map<string, number>();
import {
  expandHome,
  resolveRoute,
  dbSaveMessageMeta,
  dbGetSetting,
} from "../router/index.js";
import { configStore } from "../config-store.js";
import { isContactAllowedForAgent, saveAccountPending, getContactName, getContact } from "../contacts.js";
import { getOrCreateSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import type { MessageTarget } from "../bot.js";
import {
  dbGetEntry,
  dbFindActiveEntryByPhone,
  dbRecordEntryResponse,
  dbSetEntrySenderId,
  dbUpdateEntry,
} from "../outbound/index.js";
import type { OmniSender } from "./sender.js";
import { fetchOmniMedia, saveToAgentAttachments, MAX_AUDIO_BYTES } from "../utils/media.js";
import { transcribeAudio } from "../transcribe/openai.js";

const log = logger.child("omni:consumer");
const sc = StringCodec();

/** Durable consumer names */
const MSG_CONSUMER = "ravi-messages";
const INSTANCE_CONSUMER = "ravi-instances";
const REACTION_CONSUMER = "ravi-reactions";

/** Stream names (must match omni's stream config) */
const MESSAGE_STREAM = "MESSAGE";
const INSTANCE_STREAM = "INSTANCE";
const REACTION_STREAM = "REACTION";

/**
 * Omni event envelope (wraps all events published to JetStream).
 */
interface OmniEvent {
  id: string;
  type: string;
  payload: unknown;
  metadata: {
    instanceId?: string;
    channelType?: string;
    personId?: string;
    source?: string;
    ingestMode?: 'realtime' | 'history-sync';
  };
  timestamp: number;
}

/** Omni message.received payload */
interface MessageReceivedPayload {
  externalId: string;
  chatId: string;
  from: string;
  content: {
    type: string;
    text?: string;
    mediaUrl?: string;
    mimeType?: string;
    localPath?: string;
    isVoiceNote?: boolean;
  };
  replyToId?: string;
  rawPayload?: Record<string, unknown>;
}

/** Omni instance.qr_code payload */
interface InstanceQrCodePayload {
  instanceId: string;
  channelType: string;
  qrCode: string;
  expiresAt: number;
}

/** Omni instance.connected payload */
interface InstanceConnectedPayload {
  instanceId: string;
  channelType: string;
  profileName?: string;
  ownerIdentifier?: string;
}

/** Omni reaction.received payload */
interface ReactionReceivedPayload {
  messageId: string;
  chatId: string;
  from: string;
  emoji: string;
}

/**
 * Strip @-suffix from JID to get the phone/id portion.
 * "5511999999999@s.whatsapp.net" → "5511999999999"
 * "120363xxx@g.us" → "120363xxx"
 * "5511999999999" → "5511999999999"
 */
function stripJid(jid: string): string {
  const atIdx = jid.indexOf("@");
  return atIdx !== -1 ? jid.slice(0, atIdx) : jid;
}

/**
 * Parse the NATS subject to get channelType and instanceId.
 * Subject format: {eventType}.{channelType}.{instanceId}
 * e.g., "message.received.whatsapp-baileys.abc-123-uuid"
 */
function parseSubject(subject: string): { channelType: string; instanceId: string } | null {
  const parts = subject.split(".");
  // minimum 4 parts: domain.action.channelType.instanceId
  if (parts.length < 4) return null;
  const channelType = parts[2];
  const instanceId = parts.slice(3).join(".");
  if (!channelType || !instanceId) return null;
  return { channelType, instanceId };
}

export class OmniConsumer {
  private running = false;
  /** Active targets for typing heartbeat: sessionName → MessageTarget */
  private activeTargets = new Map<string, MessageTarget>();
  /** Stored JetStreamManager for use inside consume loops */
  private jsm: JetStreamManager | null = null;
  /** Startup timestamp (ms) — messages older than this are history sync, skip them */
  private readonly startedAt = Date.now();
  /** Dedup set for recently processed event IDs (prevents double-processing) */
  private readonly processedEvents = new Set<string>();
  private readonly DEDUP_MAX = 500;

  constructor(
    private sender: OmniSender,
    private omniApiUrl: string,
    private omniApiKey: string,
  ) {}

  /**
   * Start the consumer.
   *
   * Awaits until both JetStream consumers are ready to process messages
   * (i.e. streams exist and consumers are registered). Loops continue
   * running in background after start() resolves.
   */
  async start(): Promise<void> {
    log.info("Starting omni consumer...");
    this.running = true;

    const nc = getNats();
    const js = nc.jetstream();
    this.jsm = await nc.jetstreamManager();

    // Start consume loops and wait until all consumers are ready
    await Promise.all([
      this.consumeLoop(js, MESSAGE_STREAM, MSG_CONSUMER, "message.received.>", (subject, event) =>
        this.handleMessageEvent(subject, event)
      ),
      this.consumeLoop(js, INSTANCE_STREAM, INSTANCE_CONSUMER, "instance.>", (subject, event) =>
        this.handleInstanceEvent(subject, event)
      ),
      this.consumeLoop(js, REACTION_STREAM, REACTION_CONSUMER, "reaction.received.>", (subject, event) =>
        this.handleReactionEvent(subject, event)
      ),
    ]);

    log.info("Omni consumer started");
  }

  async stop(): Promise<void> {
    log.info("Stopping omni consumer...");
    this.running = false;
    // Consume loops detect this.running === false and exit gracefully
  }

  /**
   * Ensure a durable pull consumer exists on the given stream.
   * Retries until the stream appears (omni may still be initializing).
   */
  private async ensureConsumer(
    jsm: JetStreamManager,
    stream: string,
    name: string,
    filterSubject: string,
    timeoutMs = CONSUMER_READY_TIMEOUT
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Check if consumer already exists
      try {
        await jsm.consumers.info(stream, name);
        log.debug("Consumer already exists", { stream, name });
        return;
      } catch {
        // Not found — try to create
      }

      // Try to create the consumer
      try {
        await jsm.consumers.add(stream, {
          durable_name: name,
          filter_subject: filterSubject,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
        });
        log.info("Created JetStream consumer", { stream, name, filter: filterSubject });
        return;
      } catch (err) {
        // Stream may not exist yet (omni still initializing — retry)
        if (!this.running) return;
        log.debug("Stream not ready yet, retrying in 2s", { stream, name, error: err });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    log.error("Timed out waiting for JetStream stream to appear", { stream, name });
  }

  /**
   * Generic consume loop.
   *
   * Returns a Promise that resolves once the consumer is ready (first
   * consumer.consume() call succeeds). The background loop continues
   * running after the promise resolves.
   */
  private consumeLoop(
    js: JetStreamClient,
    stream: string,
    consumerName: string,
    filterSubject: string,
    handler: (subject: string, event: OmniEvent) => Promise<void>
  ): Promise<void> {
    return new Promise<void>((resolveReady) => {
      let notifiedReady = false;

      const markReady = () => {
        if (!notifiedReady) {
          notifiedReady = true;
          resolveReady();
        }
      };

      // Fallback: unblock start() after timeout even if streams never appear.
      // The loop continues retrying in the background.
      const readyFallback = setTimeout(() => {
        if (!notifiedReady) {
          log.warn("Consumer ready timeout — unblocking start(), will keep retrying in background", { stream });
          markReady();
        }
      }, CONSUMER_READY_TIMEOUT);

      (async () => {
        while (this.running) {
          try {
            // Ensure consumer exists (retries until stream is available)
            if (this.jsm) {
              await this.ensureConsumer(this.jsm, stream, consumerName, filterSubject);
            }
            if (!this.running) break;

            const consumer = await js.consumers.get(stream, consumerName);
            const messages = await consumer.consume();
            clearTimeout(readyFallback);
            markReady(); // Consumer is active — unblock start()

            for await (const msg of messages) {
              if (!this.running) {
                msg.nak();
                break;
              }
              try {
                const raw = sc.decode(msg.data);
                const event = JSON.parse(raw) as OmniEvent;
                // Ack immediately so the consume loop is never blocked by slow
                // handlers (e.g. HTTP timeouts to omni sender). Handlers are
                // fire-and-forget — errors are logged but don't stall the stream.
                msg.ack();
                handler(msg.subject, event).catch((err) => {
                  log.error("Error handling event", { stream, subject: msg.subject, error: err });
                });
              } catch (err) {
                log.error("Error parsing event", { stream, subject: msg.subject, error: err });
                msg.nak();
              }
            }
          } catch (err) {
            if (!this.running) break;
            log.error("Consume loop error, restarting in 2s", { stream, consumerName, error: err });
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        clearTimeout(readyFallback);
        markReady(); // Unblock start() even on clean exit without connecting
      })();
    });
  }

  /**
   * Handle message.received event from omni.
   */
  private async handleMessageEvent(subject: string, event: OmniEvent): Promise<void> {
    if (event.type !== "message.received") return;

    const parsed = parseSubject(subject);
    if (!parsed) {
      log.warn("Could not parse subject", { subject });
      return;
    }

    const { channelType, instanceId } = parsed;
    const payload = event.payload as MessageReceivedPayload;

    // Skip reaction messages — these are handled by the REACTION stream consumer
    if (payload.content.type === "reaction") return;

    // Skip messages from Baileys history sync.
    // Omni sets ingestMode='history-sync' for messages replayed during reconnect.
    // Fallback: also filter by timestamp for older omni versions without the flag.
    if (event.metadata?.ingestMode === "history-sync") {
      log.debug("Skipping history sync message (ingestMode flag)", { instanceId, externalId: (event.payload as MessageReceivedPayload)?.externalId });
      return;
    }
    const msgTs = event.timestamp > 1e12 ? event.timestamp : event.timestamp * 1000;
    if (msgTs < this.startedAt - 5_000) {
      log.debug("Skipping history sync message (timestamp fallback)", { instanceId, msgTs, startedAt: this.startedAt });
      return;
    }

    // Derive phone and group status from JIDs
    const rawPayload = payload.rawPayload as Record<string, unknown> | undefined;
    // isDm: Slack uses lowercase "isDm", Discord/Telegram use "isDM"
    const rawIsDm = rawPayload?.isDm ?? rawPayload?.isDM;
    // rawPayload.isGroup: Telegram sets this explicitly
    const rawIsGroup = rawPayload?.isGroup;
    const isGroup = payload.chatId.endsWith("@g.us")
      || rawIsGroup === true
      || (rawIsDm === false && (channelType === "slack" || channelType === "discord"));
    const senderPhone = stripJid(payload.from);
    const chatJid = payload.chatId;
    // For routing: use phone for DMs, chatJid for groups
    const routePhone = isGroup ? chatJid : senderPhone;

    // Channel detection: Slack/Discord non-DM channels use "channel" peerKind.
    // accountId is still included in the session key for full isolation.
    const isNonDmChannel = rawIsDm === false
      && (channelType === "slack" || channelType === "discord");
    const peerKind = isNonDmChannel ? "channel" as const : undefined;
    // Resolve instanceId (UUID) → account name (e.g., "main") for route matching
    const effectiveAccountId = configStore.resolveAccountName(instanceId);
    if (!effectiveAccountId) {
      log.warn("Unknown instanceId — not registered in ravi, skipping", { instanceId, channelType });
      const now = Date.now();
      const lastEmit = unregisteredCooldowns.get(instanceId) ?? 0;
      if (now - lastEmit >= UNREGISTERED_COOLDOWN_MS) {
        unregisteredCooldowns.set(instanceId, now);
        publish("ravi.instances.unregistered", {
          instanceId,
          channelType,
          subject,
          from: senderPhone,
          chatId: chatJid,
          isGroup,
          contentType: payload.content?.type,
          timestamp: event.timestamp,
        }).catch(() => {});
      }
      return;
    }

    // Thread detection:
    // - Slack: isThreadReply + threadTs
    // - Discord: isThread + threadId (in rawPayload)
    let threadId: string | undefined;
    if (rawPayload?.isThreadReply === true && rawPayload.threadTs) {
      threadId = String(rawPayload.threadTs);
    } else if (rawPayload?.isThread === true && rawPayload.threadId) {
      threadId = String(rawPayload.threadId);
    }

    log.debug("Message received", {
      instanceId, channelType, from: senderPhone, chatId: chatJid, isGroup,
      ...(peerKind ? { peerKind } : {}),
      ...(threadId ? { threadId } : {}),
    });

    // Check for active outbound entry — if so, record response and suppress prompt
    if (!isGroup) {
      const activeEntry = dbFindActiveEntryByPhone(senderPhone);
      if (activeEntry && activeEntry.id && activeEntry.status !== "agent") {
        log.info("Inbound from outbound contact, recording response (suppressing prompt)", {
          senderPhone, entryId: activeEntry.id,
        });
        const content = this.formatContent(payload);
        dbRecordEntryResponse(activeEntry.id, content);
        if (!activeEntry.senderId) {
          dbSetEntrySenderId(activeEntry.id, senderPhone);
        }
        nats.emit("ravi.outbound.refresh", {}).catch(() => {});
        return;
      }
    }

    // Normalize for stable session keys:
    // - Strip channel implementation suffix (whatsapp-baileys → whatsapp)
    // - Strip JID domain suffixes (@g.us, @s.whatsapp.net)
    const sessionChannel = channelType.replace(/-baileys$/, "");
    const sessionGroupId = isGroup ? chatJid.replace(/@.*$/, "") : undefined;

    // Resolve route to get session key
    const routerConfig = configStore.getConfig();
    const resolved = resolveRoute(routerConfig, {
      phone: routePhone,
      channel: sessionChannel,
      accountId: effectiveAccountId,
      isGroup,
      groupId: sessionGroupId,
      threadId,
      peerKind,
    });

    if (!resolved) {
      const isNew = saveAccountPending(effectiveAccountId, routePhone, {
        chatId: chatJid,
        isGroup,
      });
      log.info("No route for message, saved as pending", {
        instanceId, accountId: effectiveAccountId, channelType, routePhone, isNew,
      });
      if (isNew) {
        nats.emit("ravi.contacts.pending", {
          type: "account",
          channel: channelType,
          accountId: effectiveAccountId,
          senderId: senderPhone,
          chatId: chatJid,
          isGroup,
        }).catch((err) => log.warn("Failed to emit pending notification", { error: err }));
      }
      return;
    }

    // -- Policy resolution helper --
    // Lookup order: route.policy → instance config → legacy settings → default
    const resolvePolicy = (policyName: "groupPolicy" | "dmPolicy", routePolicy: string | undefined, defaultValue: string): string => {
      // 1. Explicit override on the matched route
      if (routePolicy) return routePolicy;
      // 2. Instance config (from instances table via RouterConfig)
      const instance = routerConfig.instances?.[effectiveAccountId];
      if (instance) {
        const val = policyName === "groupPolicy" ? instance.groupPolicy : instance.dmPolicy;
        if (val) return val;
      }
      // 3. Legacy settings fallback
      return (
        dbGetSetting(`account.${effectiveAccountId}.${policyName}`) ??
        dbGetSetting(`whatsapp.${policyName}`) ??
        defaultValue
      );
    };

    // -- Group policy enforcement --
    // Skip policy check if the group has an explicit route (not wildcard) —
    // having a specific route is an implicit approval.
    const hasExplicitRoute = resolved.route && resolved.route.pattern !== "*";
    if (isGroup && !hasExplicitRoute) {
      const groupPolicy = resolvePolicy("groupPolicy", resolved.route?.policy, "open");
      if (groupPolicy === "closed") {
        log.info("Group rejected by policy (closed)", { chatJid, accountId: effectiveAccountId });
        return;
      }
      if (groupPolicy === "allowlist") {
        const contact = getContact(chatJid);
        if (!contact || contact.status !== "allowed") {
          const isNew = saveAccountPending(effectiveAccountId, chatJid, {
            chatId: chatJid,
            isGroup: true,
            name: getContactName(chatJid) ?? undefined,
          });
          log.info("Group not in allowlist, saved as pending", {
            chatJid, accountId: effectiveAccountId, isNew,
          });
          if (isNew) {
            nats.emit("ravi.contacts.pending", {
              type: "account",
              channel: channelType,
              accountId: effectiveAccountId,
              senderId: senderPhone,
              chatId: chatJid,
              isGroup: true,
            }).catch((err) => log.warn("Failed to emit pending notification", { error: err }));
          }
          return;
        }
      }
      // "open" → falls through normally
    }

    // -- DM policy enforcement --
    if (!isGroup) {
      const dmPolicy = resolvePolicy("dmPolicy", resolved.route?.policy, "open");
      if (dmPolicy === "closed") {
        log.info("DM rejected by policy (closed)", { senderPhone, accountId: effectiveAccountId });
        return;
      }
      if (dmPolicy === "pairing") {
        const contact = getContact(senderPhone);
        if (!contact || contact.status !== "allowed") {
          const isNew = saveAccountPending(effectiveAccountId, senderPhone, {
            chatId: chatJid,
            isGroup: false,
          });
          log.info("DM contact not approved (pairing policy), saved as pending", {
            senderPhone, accountId: effectiveAccountId, isNew,
          });
          if (isNew) {
            nats.emit("ravi.contacts.pending", {
              type: "account",
              channel: channelType,
              accountId: effectiveAccountId,
              senderId: senderPhone,
              chatId: chatJid,
              isGroup: false,
            }).catch((err) => log.warn("Failed to emit pending notification", { error: err }));
          }
          return;
        }
      }
      // "open" → falls through normally
    }

    const { sessionName, agent } = resolved;
    const agentMode = agent.mode ?? "active";

    // Per-agent contact scoping
    if (agentMode !== "sentinel") {
      const checkId = isGroup ? chatJid : senderPhone;
      if (!isContactAllowedForAgent(checkId, agent.id)) {
        log.info("Contact not allowed for agent", { checkId, agentId: agent.id });
        return;
      }
    }

    // Resolve sender display name: pushName (from rawPayload) → contacts DB → phone
    const pushName = (payload.rawPayload as Record<string, unknown> | undefined)?.pushName as string | undefined;
    const senderName = pushName || getContactName(senderPhone) || senderPhone;

    // Resolve group name from contacts DB
    const groupName = isGroup ? (getContactName(chatJid) ?? undefined) : undefined;

    // Process media (download from omni disk → agent attachments, transcribe audio)
    const agentCwd = expandHome(agent.cwd);
    const mediaResult = await this.processMedia(payload, agentCwd);

    // Build message envelope text
    const envelope = this.formatEnvelope(channelType, payload, isGroup, senderPhone, senderName, groupName, chatJid, event.timestamp, threadId, mediaResult);

    if (agentMode === "sentinel") {
      // Sentinel: observe silently, no typing indicator, no source
      try {
        const sentinelEnvelope = `${envelope}\n(sentinel — observe, use whatsapp dm send to reply if instructed)`;
        await publishSessionPrompt(sessionName, {
          prompt: sentinelEnvelope,
          context: this.buildContext(channelType, effectiveAccountId, instanceId, payload, isGroup, senderPhone, chatJid, event),
        });
      } catch (err) {
        log.error("Failed to publish sentinel prompt", err);
      }
      return;
    }

    // Check for slash commands before emitting to agent
    const rawText = payload.content.text ?? "";
    if (rawText.startsWith("/")) {
      const handled = await handleSlashCommand({
        text: rawText,
        senderId: senderPhone,
        chatId: chatJid,
        isGroup,
        channelType,
        accountId: effectiveAccountId,
        routerConfig,
        send: async (_accId, cId, text) => { await this.sender.send(instanceId, cId, text); },
      });
      if (handled) return;
    }

    // Active mode: send typing indicator, emit prompt with source
    const source: MessageTarget = {
      channel: channelType,
      accountId: effectiveAccountId,
      chatId: chatJid,
    };

    // Emit inbound reply event when message is a quote-reply (for approval/poll resolution)
    if (payload.replyToId && payload.content.text) {
      nats.emit("ravi.inbound.reply", {
        targetMessageId: payload.replyToId,
        text: payload.content.text,
        senderId: senderPhone,
      }).catch(() => {});
    }

    this.activeTargets.set(sessionName, source);
    await this.sender.sendTyping(instanceId, chatJid, true);

    // Mark message as read (blue check)
    if (payload.externalId) {
      this.sender.markRead(instanceId, chatJid, [payload.externalId]).catch(() => {});
    }

    try {
      await publishSessionPrompt(sessionName, {
        prompt: envelope,
        source,
        context: this.buildContext(channelType, effectiveAccountId, instanceId, payload, isGroup, senderPhone, chatJid, event),
      });
    } catch (err) {
      log.error("Failed to publish prompt", err);
      await this.sender.sendTyping(instanceId, chatJid, false);
      this.activeTargets.delete(sessionName);
    }
  }

  /**
   * Handle instance.* events from omni (QR code, connected, etc.)
   */
  private async handleInstanceEvent(subject: string, event: OmniEvent): Promise<void> {
    const parts = subject.split(".");
    const eventType = `${parts[0]}.${parts[1]}`; // e.g., "instance.qr_code"

    if (eventType === "instance.qr_code") {
      const payload = event.payload as InstanceQrCodePayload;
      // Relay QR code to any waiting CLI subscriber
      const relayTopic = `ravi.whatsapp.qr.${payload.instanceId}`;
      await nats.emit(relayTopic, {
        type: "qr",
        instanceId: payload.instanceId,
        qr: payload.qrCode,
        channelType: payload.channelType,
      });
      log.debug("QR code relayed", { instanceId: payload.instanceId });
    } else if (eventType === "instance.connected") {
      const payload = event.payload as InstanceConnectedPayload;
      const relayTopic = `ravi.whatsapp.connected.${payload.instanceId}`;
      await nats.emit(relayTopic, {
        type: "connected",
        instanceId: payload.instanceId,
        channelType: payload.channelType,
        profileName: payload.profileName,
        ownerIdentifier: payload.ownerIdentifier,
      });
      log.info("Instance connected", {
        instanceId: payload.instanceId,
        channelType: payload.channelType,
        profileName: payload.profileName,
      });
    }
  }

  /**
   * Handle reaction.received events from omni.
   * Emits ravi.inbound.reaction for approval/poll resolution.
   */
  private async handleReactionEvent(_subject: string, event: OmniEvent): Promise<void> {
    if (event.type !== "reaction.received") return;

    // Skip old reactions (before this daemon started)
    const reactionTs = event.timestamp > 1e12 ? event.timestamp : event.timestamp * 1000;
    if (reactionTs < this.startedAt - 5_000) return;

    const payload = event.payload as ReactionReceivedPayload;
    const senderId = stripJid(payload.from);

    // Dedup: omni publishes duplicate events with different IDs for the same reaction
    const dedupKey = `${payload.messageId}:${payload.emoji}:${senderId}`;
    if (this.processedEvents.has(dedupKey)) return;
    this.processedEvents.add(dedupKey);
    if (this.processedEvents.size > this.DEDUP_MAX) {
      const first = this.processedEvents.values().next().value;
      if (first) this.processedEvents.delete(first);
    }

    log.info("Reaction received", {
      messageId: payload.messageId,
      emoji: payload.emoji,
      senderId,
      chatId: payload.chatId,
    });

    await nats.emit("ravi.inbound.reaction", {
      targetMessageId: payload.messageId,
      emoji: payload.emoji,
      senderId,
    });
  }

  /**
   * Get active target for a session (used by gateway for typing heartbeat).
   */
  getActiveTarget(sessionName: string): MessageTarget | undefined {
    return this.activeTargets.get(sessionName);
  }

  /**
   * Clear active target (called when response is sent).
   */
  clearActiveTarget(sessionName: string): void {
    this.activeTargets.delete(sessionName);
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Process media: fetch from omni HTTP API, save to agent attachments, transcribe audio.
   */
  private async processMedia(
    payload: MessageReceivedPayload,
    agentCwd: string,
  ): Promise<{ localPath?: string; transcript?: string } | null> {
    const { content } = payload;
    if (!content.mediaUrl || content.type === "text" || !content.type) return null;

    const mimeType = content.mimeType ?? "application/octet-stream";
    const isAudio = content.type === "audio" || content.type === "voice";
    const maxBytes = isAudio ? MAX_AUDIO_BYTES : undefined;

    const buffer = await fetchOmniMedia(content.mediaUrl, this.omniApiUrl, this.omniApiKey, maxBytes);
    if (!buffer) return null;

    // Audio: transcribe, save to attachments as fallback
    if (isAudio) {
      try {
        const result = await transcribeAudio(buffer, mimeType);
        return { transcript: result.text };
      } catch (err) {
        log.warn("Audio transcription failed, saving file instead", { error: err });
        try {
          const dest = await saveToAgentAttachments(buffer, agentCwd, payload.externalId, mimeType);
          return { localPath: dest };
        } catch { return null; }
      }
    }

    // Images, videos, documents, stickers: save to agent attachments
    try {
      const dest = await saveToAgentAttachments(buffer, agentCwd, payload.externalId, mimeType);
      return { localPath: dest };
    } catch (err) {
      log.warn("Failed to save media to agent attachments", { error: err });
      return null;
    }
  }

  /**
   * Format message content as text for the prompt.
   * mediaResult comes from processMedia() — undefined for text-only messages.
   */
  private formatContent(
    payload: MessageReceivedPayload,
    mediaResult?: { localPath?: string; transcript?: string } | null,
  ): string {
    const { content } = payload;
    if (content.type === "text" || !content.type) {
      return content.text ?? "[message]";
    }

    const isAudio = content.type === "audio" || content.type === "voice";

    // Audio with transcript
    if (isAudio && mediaResult?.transcript) {
      return `[Audio]\nTranscript:\n${mediaResult.transcript}`;
    }

    // Audio without transcript but with file
    if (isAudio && mediaResult?.localPath) {
      return `[Audio]\nfile: ${mediaResult.localPath}`;
    }

    if (isAudio) {
      return "[Audio]";
    }

    // Other media (image, video, document, sticker)
    const parts: string[] = [];
    const label = content.type.charAt(0).toUpperCase() + content.type.slice(1);

    if (mediaResult?.localPath) {
      parts.push(`[${label}: ${mediaResult.localPath}]`);
    } else {
      parts.push(`[${label}]`);
    }

    if (content.text) {
      parts.push(content.text);
    }

    return parts.join("\n");
  }

  private formatEnvelope(
    channelType: string,
    payload: MessageReceivedPayload,
    isGroup: boolean,
    senderPhone: string,
    senderName: string,
    groupName: string | undefined,
    chatJid: string,
    timestamp: number,
    threadId?: string,
    mediaResult?: { localPath?: string; transcript?: string } | null,
  ): string {
    const channelName = this.channelDisplayName(channelType);
    const dt = new Date(timestamp);
    const ts = dt.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const dow = dt.toLocaleDateString("en-US", {
      timeZone: "America/Sao_Paulo", weekday: "short"
    }).toLowerCase();

    const content = this.formatContent(payload, mediaResult);
    const midTag = payload.externalId ? ` mid:${payload.externalId}` : "";
    const threadTag = threadId ? ` thread:${threadId}` : "";

    if (isGroup) {
      const groupLabel = groupName || stripJid(chatJid);
      return `[${channelName} ${groupLabel} id:${chatJid}${threadTag}${midTag} ${ts} ${dow}] ${senderName}: ${content}`;
    } else {
      const nameTag = senderName !== senderPhone ? ` ${senderName}` : "";
      return `[${channelName} +${senderPhone}${nameTag}${midTag} ${ts} ${dow}] ${content}`;
    }
  }

  private buildContext(
    channelType: string,
    accountId: string,
    instanceId: string,
    payload: MessageReceivedPayload,
    isGroup: boolean,
    senderPhone: string,
    chatJid: string,
    event: OmniEvent
  ): Record<string, unknown> {
    return {
      channelId: channelType,
      channelName: this.channelDisplayName(channelType),
      accountId,
      instanceId,
      chatId: chatJid,
      messageId: payload.externalId,
      senderId: senderPhone,
      isGroup,
      timestamp: event.timestamp,
    };
  }

  private channelDisplayName(channelType: string): string {
    const map: Record<string, string> = {
      "whatsapp-baileys": "WhatsApp",
      "discord": "Discord",
      "telegram": "Telegram",
      "slack": "Slack",
    };
    return map[channelType] ?? channelType;
  }
}
