import type { SlackSocketModeStatus } from "./socket-mode.js";
import type { SlackSocketEnvelope } from "./types.js";

interface SlackGatewayClaimedEvent {
  readonly id: string;
  readonly claimId: string;
  readonly envelope: SlackSocketEnvelope;
}

interface SlackGatewayClaimResponse {
  readonly event: SlackGatewayClaimedEvent | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SlackGatewayEnvelopeProcessor {
  handleEnvelope(envelope: SlackSocketEnvelope): Promise<"duplicate" | "ignored" | "processed">;
  resumePendingInboundEnvelopes(): Promise<unknown>;
}

export interface SlackGatewayModeServiceOptions {
  readonly claimUrl: string;
  readonly completionBaseUrl: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly processor: SlackGatewayEnvelopeProcessor;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
}

export class SlackGatewayModeService {
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private activeRequest: AbortController | null = null;
  private interruptRetryDelay: (() => void) | null = null;
  private lifecycleState: SlackSocketModeStatus["state"] = "stopped";
  private lifecycleReason: SlackSocketModeStatus["reason"] = "stopped";
  private connectedAt: number | undefined;
  private lastPollAt: number | undefined;
  private reconnectCount = 0;

  constructor(private readonly options: SlackGatewayModeServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connectedAt = undefined;
    this.reconnectCount = 0;
    this.setLifecycle("connecting", "polling_gateway");
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.interruptRetryDelay?.();
    this.interruptRetryDelay = null;
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;
    this.connectedAt = undefined;
    this.setLifecycle("stopped", "stopped");
  }

  status(): SlackSocketModeStatus {
    return {
      state: this.lifecycleState,
      ...(this.connectedAt !== undefined ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastPollAt !== undefined ? { lastPongAt: this.lastPollAt } : {}),
      reconnectCount: this.reconnectCount,
      ...(this.lifecycleReason ? { reason: this.lifecycleReason } : {}),
    };
  }

  private async runLoop(): Promise<void> {
    await this.options.processor.resumePendingInboundEnvelopes().catch(() => {});
    while (this.running) {
      try {
        const claim = await this.claim();
        if (!this.running) return;
        const observedAt = this.now();
        this.lastPollAt = observedAt;
        if (this.connectedAt === undefined) this.connectedAt = observedAt;
        this.setLifecycle("connected", "polling_gateway");
        if (claim.event) await this.process(claim.event);
      } catch {
        if (!this.running) return;
        this.connectedAt = undefined;
        this.reconnectCount += 1;
        this.setLifecycle("reconnecting", "gateway_unavailable");
        await this.delay(Math.min(15_000, this.retryDelayMs * Math.max(1, this.reconnectCount)));
      }
    }
  }

  private async claim(): Promise<SlackGatewayClaimResponse> {
    const response = await this.request(this.options.claimUrl, {});
    const payload = (await response.json()) as unknown;
    if (!isClaimResponse(payload)) throw new Error("Invalid Slack gateway claim response");
    return payload;
  }

  private async process(event: SlackGatewayClaimedEvent): Promise<void> {
    try {
      await this.options.processor.handleEnvelope(event.envelope);
    } catch {
      await this.complete(event, {
        status: "failed",
        error: "O runtime não conseguiu processar o evento do Slack.",
      }).catch(() => {});
      throw new Error("Slack gateway event processing failed");
    }
    await this.complete(event, { status: "delivered" });
  }

  private async complete(
    event: SlackGatewayClaimedEvent,
    result: { status: "delivered" } | { status: "failed"; error: string },
  ): Promise<void> {
    await this.request(`${this.options.completionBaseUrl}/${encodeURIComponent(event.id)}/complete`, {
      claimId: event.claimId,
      ...result,
    });
  }

  private async request(url: string, body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    this.activeRequest = controller;
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          ...this.options.requestHeaders,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Slack gateway request failed (${response.status})`);
      return response;
    } finally {
      clearTimeout(timer);
      if (this.activeRequest === controller) this.activeRequest = null;
    }
  }

  private delay(milliseconds: number): Promise<void> {
    if (!this.running || milliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.interruptRetryDelay === complete) this.interruptRetryDelay = null;
        resolve();
      };
      const timer = setTimeout(complete, milliseconds);
      timer.unref?.();
      this.interruptRetryDelay = complete;
    });
  }

  private setLifecycle(state: SlackSocketModeStatus["state"], reason: SlackSocketModeStatus["reason"]): void {
    this.lifecycleState = state;
    this.lifecycleReason = reason;
  }
}

function isClaimResponse(value: unknown): value is SlackGatewayClaimResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = (value as Record<string, unknown>).event;
  if (event === null) return true;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const record = event as Record<string, unknown>;
  const envelope = record.envelope;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const envelopeRecord = envelope as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    UUID_PATTERN.test(record.id) &&
    typeof record.claimId === "string" &&
    UUID_PATTERN.test(record.claimId) &&
    typeof envelopeRecord.envelope_id === "string" &&
    envelopeRecord.envelope_id.length > 0 &&
    envelopeRecord.envelope_id.length <= 256 &&
    (envelopeRecord.type === "events_api" || envelopeRecord.type === "interactive") &&
    Boolean(envelopeRecord.payload) &&
    typeof envelopeRecord.payload === "object" &&
    !Array.isArray(envelopeRecord.payload)
  );
}
