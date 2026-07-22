import { JSONCodec } from "nats";

export const CHANNEL_RUNNER_HEALTH_SCHEMA_VERSION = 1 as const;
export const CHANNEL_RUNNER_HEALTH_SUBJECT_PREFIX = "_RAVI.channels.health";
export const DEFAULT_CHANNEL_RUNNER_HEALTH_TIMEOUT_MS = 750;

export type ChannelAdapterHealthState =
  | "disabled"
  | "starting"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "disconnected"
  | "failed";

export interface ChannelAdapterHealth {
  id: string;
  channelId: string;
  status: ChannelAdapterHealthState;
  reason?: string;
  connectedAt?: number;
  lastPongAt?: number;
  reconnectCount?: number;
}

export interface ChannelRunnerRuntimeStatus {
  running: boolean;
  startedAt: number | null;
  pid: number;
  outbound: {
    stream: string;
    consumer: string;
    enabled: boolean;
    infrastructureReady: boolean;
    consuming: boolean;
  };
  adapters: ChannelAdapterHealth[];
}

export interface ChannelRunnerHealthSnapshot extends ChannelRunnerRuntimeStatus {
  schemaVersion: typeof CHANNEL_RUNNER_HEALTH_SCHEMA_VERSION;
  observedAt: number;
}

export type ChannelRunnerHealthProbeFailureReason =
  | "timeout"
  | "no_responders"
  | "nats_unavailable"
  | "invalid_response"
  | "pid_mismatch";

export type ChannelRunnerHealthProbeResult =
  | { reachable: true; snapshot: ChannelRunnerHealthSnapshot }
  | { reachable: false; reason: ChannelRunnerHealthProbeFailureReason };

export interface ChannelRunnerHealthMessage {
  readonly data: Uint8Array;
  respond(data: Uint8Array): boolean;
}

export interface ChannelRunnerHealthSubscription extends AsyncIterable<ChannelRunnerHealthMessage> {
  unsubscribe(): void;
}

export interface ChannelRunnerHealthResponderConnection {
  subscribe(subject: string): ChannelRunnerHealthSubscription;
}

export interface ChannelRunnerHealthRequestConnection {
  request(subject: string, data: Uint8Array, options: { timeout: number }): Promise<{ readonly data: Uint8Array }>;
}

export interface ChannelRunnerHealthResponder {
  readonly subject: string;
  stop(): Promise<void>;
}

const codec = JSONCodec<unknown>();

export function channelRunnerHealthSubject(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Channel runner health PID must be a positive integer");
  }
  return `${CHANNEL_RUNNER_HEALTH_SUBJECT_PREFIX}.${pid}`;
}

export function createChannelRunnerHealthSnapshot(
  status: ChannelRunnerRuntimeStatus,
  observedAt = Date.now(),
): ChannelRunnerHealthSnapshot {
  return {
    schemaVersion: CHANNEL_RUNNER_HEALTH_SCHEMA_VERSION,
    observedAt,
    running: status.running,
    startedAt: status.startedAt,
    pid: status.pid,
    outbound: { ...status.outbound },
    adapters: status.adapters.map((adapter) => ({ ...adapter })),
  };
}

export function startChannelRunnerHealthResponder(options: {
  pid: number;
  getStatus: () => ChannelRunnerRuntimeStatus;
  connection: ChannelRunnerHealthResponderConnection;
  now?: () => number;
}): ChannelRunnerHealthResponder {
  const subject = channelRunnerHealthSubject(options.pid);
  const subscription = options.connection.subscribe(subject);
  let stopped = false;

  const loop = (async () => {
    for await (const message of subscription) {
      if (stopped) break;
      try {
        const snapshot = createChannelRunnerHealthSnapshot(options.getStatus(), options.now?.() ?? Date.now());
        message.respond(codec.encode(snapshot));
      } catch {
        // A health read must never take down the channel runner or expose an internal error.
      }
    }
  })();

  return {
    subject,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
      await loop.catch(() => {});
    },
  };
}

export async function probeChannelRunnerHealth(options: {
  pid: number;
  timeoutMs?: number;
  connect?: () => Promise<ChannelRunnerHealthRequestConnection>;
}): Promise<ChannelRunnerHealthProbeResult> {
  let subject: string;
  try {
    subject = channelRunnerHealthSubject(options.pid);
  } catch {
    return { reachable: false, reason: "invalid_response" };
  }

  let connection: ChannelRunnerHealthRequestConnection;
  try {
    connection = await (options.connect ?? defaultHealthConnection)();
  } catch {
    return { reachable: false, reason: "nats_unavailable" };
  }

  let response: { readonly data: Uint8Array };
  try {
    response = await connection.request(subject, codec.encode({}), {
      timeout: options.timeoutMs ?? DEFAULT_CHANNEL_RUNNER_HEALTH_TIMEOUT_MS,
    });
  } catch (error) {
    return { reachable: false, reason: healthRequestFailureReason(error) };
  }

  let decoded: unknown;
  try {
    decoded = codec.decode(response.data);
  } catch {
    return { reachable: false, reason: "invalid_response" };
  }

  if (!isChannelRunnerHealthSnapshot(decoded)) {
    return { reachable: false, reason: "invalid_response" };
  }
  if (decoded.pid !== options.pid) {
    return { reachable: false, reason: "pid_mismatch" };
  }
  return { reachable: true, snapshot: decoded };
}

export function isChannelRunnerHealthSnapshot(value: unknown): value is ChannelRunnerHealthSnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== CHANNEL_RUNNER_HEALTH_SCHEMA_VERSION) return false;
  if (!isPositiveInteger(value.pid)) return false;
  if (typeof value.running !== "boolean") return false;
  if (value.startedAt !== null && !isFiniteNumber(value.startedAt)) return false;
  if (!isFiniteNumber(value.observedAt)) return false;
  if (!isRecord(value.outbound)) return false;
  if (typeof value.outbound.stream !== "string" || typeof value.outbound.consumer !== "string") return false;
  if (typeof value.outbound.enabled !== "boolean") return false;
  if (typeof value.outbound.infrastructureReady !== "boolean") return false;
  if (typeof value.outbound.consuming !== "boolean") return false;
  if (!Array.isArray(value.adapters) || !value.adapters.every(isChannelAdapterHealth)) return false;
  return true;
}

function isChannelAdapterHealth(value: unknown): value is ChannelAdapterHealth {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.channelId !== "string") return false;
  if (!CHANNEL_ADAPTER_HEALTH_STATES.has(value.status)) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (value.connectedAt !== undefined && !isFiniteNumber(value.connectedAt)) return false;
  if (value.lastPongAt !== undefined && !isFiniteNumber(value.lastPongAt)) return false;
  if (
    value.reconnectCount !== undefined &&
    (typeof value.reconnectCount !== "number" ||
      !Number.isSafeInteger(value.reconnectCount) ||
      value.reconnectCount < 0)
  ) {
    return false;
  }
  return true;
}

const CHANNEL_ADAPTER_HEALTH_STATES = new Set<unknown>([
  "disabled",
  "starting",
  "connected",
  "degraded",
  "reconnecting",
  "disconnected",
  "failed",
]);

function healthRequestFailureReason(error: unknown): ChannelRunnerHealthProbeFailureReason {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
  const name = error instanceof Error ? error.name.toUpperCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code === "503" || code === "NO_RESPONDERS" || message.includes("no responders")) return "no_responders";
  if (code === "TIMEOUT" || name.includes("TIMEOUT") || message.includes("timeout")) return "timeout";
  return "nats_unavailable";
}

async function defaultHealthConnection(): Promise<ChannelRunnerHealthRequestConnection> {
  const { ensureConnected } = await import("../nats.js");
  return await ensureConnected();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
