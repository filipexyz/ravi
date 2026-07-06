export type SlackSubscriptionScope = "chat" | "thread" | "chat_and_thread";
export type SlackThreadReplyMode = "same_thread" | "channel_root" | "policy_default";
export type SlackRootReplyMode = "channel_root" | "new_thread" | "policy_default";

export interface SlackRoutingPolicy {
  readonly subscriptionScope: SlackSubscriptionScope;
  readonly threadReplyMode: SlackThreadReplyMode;
  readonly rootReplyMode: SlackRootReplyMode;
}

export interface SlackThreadContext {
  readonly inboundThreadTs?: string;
  readonly routeThreadTs?: string;
  readonly outboundThreadTs?: string;
}

export interface SlackSocketEnvelope {
  readonly envelope_id?: string;
  readonly type?: string;
  readonly accepts_response_payload?: boolean;
  readonly payload?: SlackEventsApiPayload | Record<string, unknown>;
  readonly retry_attempt?: number;
  readonly retry_reason?: string;
}

export interface SlackEventsApiPayload {
  readonly token?: string;
  readonly team_id?: string;
  readonly api_app_id?: string;
  readonly event?: SlackEventPayload;
  readonly type?: string;
  readonly event_id?: string;
  readonly event_time?: number;
  readonly authorizations?: readonly Record<string, unknown>[];
}

export interface SlackEventPayload {
  readonly type?: string;
  readonly subtype?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly team?: string;
  readonly event_ts?: string;
  readonly edited?: Record<string, unknown>;
  readonly hidden?: boolean;
  readonly [key: string]: unknown;
}

export interface SlackNormalizedMessage {
  readonly teamId: string;
  readonly channelId: string;
  readonly channelType: string;
  readonly userId: string;
  readonly text: string;
  readonly ts: string;
  readonly thread: SlackThreadContext;
  readonly eventId?: string;
  readonly envelopeId?: string;
  readonly eventTimeMs: number;
  readonly rawEnvelope: SlackSocketEnvelope;
}
