/**
 * Foundation primitives of the WhatsApp library (`lib/**`): logger, content types,
 * outgoing message shapes, plugin storage, inbound sanitization and dedupe, the
 * download guard, channel errors and markdown conversion.
 *
 * Ported from omni packages/core and packages/channel-sdk (same names, same defaults,
 * same log event names) so the ported handlers keep their production behaviour. Only
 * the logger is adapted: it is a thin wrapper over ravi's `logger.child`.
 */

import { logger as raviLogger } from "../../../utils/logger.js";

// ============================================================================
// Logger (@omni/core createLogger / Logger)
// ============================================================================

/** Structured logger surface the WhatsApp library relies on. */
export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** `createLogger(module)` → ravi `logger.child(module)`. */
export function createLogger(module: string): Logger {
  return raviLogger.child(module);
}

// ============================================================================
// Content types (@omni/core/types)
// ============================================================================

export const CONTENT_TYPES = [
  "text",
  "audio",
  "image",
  "video",
  "document",
  "sticker",
  "contact",
  "location",
  "reaction",
  // Extended types for WhatsApp
  "poll",
  "poll_update",
  "event",
  "live_location",
  "product",
  "pix",
  "template",
  "location_request",
  "flow",
  // Meta types (message lifecycle)
  "edit",
  "delete",
  "unknown",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

// ============================================================================
// Streaming (@omni/core StreamDelta, @omni/channel-sdk StreamSender)
// ============================================================================

export type StreamDelta =
  | { phase: "thinking"; thinking: string; thinkingElapsedMs: number }
  | { phase: "content"; content: string; thinking?: string; thinkingDurationMs?: number }
  | { phase: "final"; content: string; thinking?: string; thinkingDurationMs?: number }
  | { phase: "error"; error: string };

/** Channel-specific stream sender for progressive message rendering. */
export interface StreamSender {
  onThinkingDelta(delta: StreamDelta & { phase: "thinking" }): Promise<void>;
  onContentDelta(delta: StreamDelta & { phase: "content" }): Promise<void>;
  onFinal(delta: StreamDelta & { phase: "final" }): Promise<void>;
  onError(delta: StreamDelta & { phase: "error" }): Promise<void>;
  abort(): Promise<void>;
  cancel?(): Promise<void>;
}

// ============================================================================
// Outgoing messages (@omni/channel-sdk OutgoingMessage)
// ============================================================================

export interface OutgoingContent {
  type: ContentType;
  text?: string;
  mediaUrl?: string;
  /** Local media path (for media types when available). */
  localPath?: string;
  mimeType?: string;
  filename?: string;
  caption?: string;
  emoji?: string;
  targetMessageId?: string;
  poll?: {
    question: string;
    options: string[];
    multiSelect?: boolean;
    isAnonymous?: boolean;
  };
  contact?: {
    name: string;
    phone?: string;
    email?: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
}

/** Well-known metadata keys for outgoing messages (open-ended). */
export interface MessageMetadata {
  messageFormatMode?: "convert" | "passthrough";
  systemNotice?: boolean;
  [key: string]: unknown;
}

export interface OutgoingMessage {
  to: string;
  threadId?: string;
  content: OutgoingContent;
  replyTo?: string;
  metadata?: MessageMetadata;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  timestamp: number;
}

// ============================================================================
// Plugin storage (@omni/channel-sdk PluginStorage)
// ============================================================================

/** One write of a batch: `value` null deletes the key. */
export interface AuthStorageWrite {
  readonly key: string;
  readonly value: string | null;
}

/** Key-value storage the auth state persists through (see auth-store.ts for SQLite). */
export interface PluginStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  /** List keys matching a glob pattern (`*` wildcard). */
  keys(pattern?: string): Promise<string[]>;
  /** Apply a batch of writes atomically (one transaction). Optional: without it, auth.ts writes key by key. */
  writeMany?(writes: readonly AuthStorageWrite[]): Promise<void>;
}

// ============================================================================
// Inbound sanitization (@omni/channel-sdk sanitize.ts)
// ============================================================================

export interface SanitizeOptions {
  maxLengthBytes?: number;
}

const DEFAULT_SANITIZE_MAX_LENGTH = 65_536; // 64KB

const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// C0 control characters (0x00-0x1F) except \t, \n, \r; also DEL and C1 control chars.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

const NULL_BYTE_RE = /\0/;

export interface SanitizeResult {
  ok: boolean;
  text: string;
  rejected?: "null_byte" | "too_long";
}

/**
 * Sanitize an inbound message text.
 *
 * Returns { ok: true, text } on success, { ok: false, rejected } when the message should be dropped.
 */
export function sanitizeMessage(
  text: string,
  logger: Logger,
  opts?: SanitizeOptions & { instanceId?: string; messageId?: string },
): SanitizeResult {
  const maxLength = opts?.maxLengthBytes ?? DEFAULT_SANITIZE_MAX_LENGTH;

  if (NULL_BYTE_RE.test(text)) {
    logger.warn("message_rejected_null_byte", {
      event: "message_rejected",
      reason: "null_byte",
      instanceId: opts?.instanceId,
      messageId: opts?.messageId,
      textLengthChars: text.length,
    });
    return { ok: false, text: "", rejected: "null_byte" };
  }

  const textByteLength = Buffer.byteLength(text, "utf8");
  if (textByteLength > maxLength) {
    logger.warn("message_rejected_too_long", {
      event: "message_rejected",
      reason: "too_long",
      instanceId: opts?.instanceId,
      messageId: opts?.messageId,
      textLengthChars: text.length,
      textLengthBytes: textByteLength,
      maxLength,
    });
    return { ok: false, text: "", rejected: "too_long" };
  }

  let cleaned = text.replace(CONTROL_CHARS_RE, "");
  cleaned = cleaned.normalize("NFC");

  return { ok: true, text: cleaned };
}

/** Validate an instance ID format for cache keys. */
export function isValidInstanceId(instanceId: string): boolean {
  return INSTANCE_ID_RE.test(instanceId);
}

// ============================================================================
// Inbound dedupe (@omni/channel-sdk dedupe.ts)
// ============================================================================

const EXTERNAL_ID_RE = /^[a-zA-Z0-9_.@:/=+-]{1,512}$/;

export interface DedupeConfig {
  maxSize?: number;
  ttlMs?: number;
}

export interface DedupeStats {
  hitCount: number;
  missCount: number;
  avgHitLatencyMs: number;
  cacheSize: number;
}

export interface DedupeCache {
  /** True when the message was already seen inside the TTL window (drop it). */
  isDuplicate(instanceId: string, externalId: string, channel: string, logger: Logger): boolean;
  stats(): DedupeStats;
  clear(): void;
  /** Stop the background cleanup timer and clear all entries. */
  dispose(): void;
  readonly size: number;
}

/** Validate cache key components. Returns the cache key or null when invalid. */
export function validateCacheKey(instanceId: string, externalId: string): string | null {
  if (!instanceId || !externalId) return null;
  if (!isValidInstanceId(instanceId)) return null;
  if (!EXTERNAL_ID_RE.test(externalId)) return null;
  return `${instanceId}:${externalId}`;
}

interface DedupeItem {
  firstSeenAt: string;
  duplicateCount: number;
  expiresAt: number;
}

/**
 * Create an inbound deduplication cache (LRU + TTL, defaults 500 entries / 60s).
 * Invalid keys fail open (never reported as duplicates).
 */
export function createInboundDedupeCache(config?: DedupeConfig): DedupeCache {
  const maxSize = config?.maxSize ?? 500;
  const ttlMs = config?.ttlMs ?? 60 * 1000;

  const cache = new Map<string, DedupeItem>();

  let hitCount = 0;
  let missCount = 0;
  let totalHitLatencyMs = 0;

  const cleanupIntervalMs = Math.min(ttlMs / 2, 60_000);
  const cleanupTimer = setInterval(() => {
    evictExpired();
  }, cleanupIntervalMs);
  cleanupTimer.unref?.();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, item] of cache) {
      if (item.expiresAt <= now) {
        cache.delete(key);
      }
    }
  }

  function ensureCapacity(): void {
    if (cache.size < maxSize) return;
    evictExpired();
    if (cache.size < maxSize) return;
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }

  function recordHit(
    existing: DedupeItem,
    cacheKey: string,
    externalId: string,
    instanceId: string,
    channel: string,
    elapsed: number,
    logger: Logger,
  ): true {
    hitCount++;
    totalHitLatencyMs += elapsed;
    existing.duplicateCount++;

    cache.delete(cacheKey);
    cache.set(cacheKey, existing);

    logger.info("duplicate_dropped", {
      event: "duplicate_dropped",
      messageId: externalId,
      instanceId,
      channel,
      cacheHitMs: Math.round(elapsed * 100) / 100,
      duplicateCount: existing.duplicateCount,
      firstSeenAt: existing.firstSeenAt,
    });

    return true;
  }

  function recordMiss(cacheKey: string): false {
    missCount++;
    ensureCapacity();
    cache.set(cacheKey, {
      firstSeenAt: new Date().toISOString(),
      duplicateCount: 0,
      expiresAt: Date.now() + ttlMs,
    });
    return false;
  }

  function isDuplicate(instanceId: string, externalId: string, channel: string, logger: Logger): boolean {
    const startTime = performance.now();

    const cacheKey = validateCacheKey(instanceId, externalId);
    if (cacheKey === null) {
      logger.warn("cache_key_invalid", {
        event: "cache_key_invalid",
        instanceId,
        externalId,
        reason: !instanceId || !externalId ? "empty_field" : "format_mismatch",
      });
      return false;
    }

    const existing = cache.get(cacheKey);
    const elapsed = performance.now() - startTime;

    if (existing && existing.expiresAt > Date.now()) {
      return recordHit(existing, cacheKey, externalId, instanceId, channel, elapsed, logger);
    }

    return recordMiss(cacheKey);
  }

  return {
    isDuplicate,
    stats(): DedupeStats {
      return {
        hitCount,
        missCount,
        avgHitLatencyMs: hitCount > 0 ? totalHitLatencyMs / hitCount : 0,
        cacheSize: cache.size,
      };
    },
    clear(): void {
      cache.clear();
      hitCount = 0;
      missCount = 0;
      totalHitLatencyMs = 0;
    },
    dispose(): void {
      clearInterval(cleanupTimer);
      cache.clear();
    },
    get size() {
      return cache.size;
    },
  };
}

// ============================================================================
// Download guard (@omni/channel-sdk download-guard.ts)
// ============================================================================

const DEFAULT_DOWNLOAD_MAX_SIZE_BYTES = 50 * 1024 * 1024;

export class DownloadTooLargeError extends Error {
  constructor(
    public readonly contentLength: number,
    public readonly maxSize: number,
  ) {
    super(`Download size ${contentLength} exceeds limit ${maxSize}`);
    this.name = "DownloadTooLargeError";
  }
}

export interface DownloadGuardConfig {
  maxSizeBytes?: number;
}

export interface DownloadGuardContext {
  instanceId?: string;
  url?: string;
  channel?: string;
}

export interface DownloadGuard {
  /** Throws DownloadTooLargeError when the declared Content-Length exceeds the limit. */
  checkResponse(response: Response, logger: Logger, ctx?: DownloadGuardContext): void;
  /** Throws DownloadTooLargeError when `sizeBytes` exceeds the limit. */
  checkSize(sizeBytes: number, logger: Logger, ctx?: DownloadGuardContext): void;
  readonly maxSizeBytes: number;
}

export function createDownloadGuard(config?: DownloadGuardConfig): DownloadGuard {
  const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_DOWNLOAD_MAX_SIZE_BYTES;

  function checkSize(sizeBytes: number, logger: Logger, ctx?: DownloadGuardContext): void {
    if (sizeBytes > maxSizeBytes) {
      logger.warn("download_too_large", {
        event: "download_too_large",
        instanceId: ctx?.instanceId,
        url: ctx?.url,
        channel: ctx?.channel,
        contentLength: sizeBytes,
        maxSizeBytes,
      });
      throw new DownloadTooLargeError(sizeBytes, maxSizeBytes);
    }
  }

  function checkResponse(response: Response, logger: Logger, ctx?: DownloadGuardContext): void {
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(size)) {
        checkSize(size, logger, ctx);
      }
    } else {
      logger.warn("download_size_unknown", {
        event: "download_size_unknown",
        instanceId: ctx?.instanceId,
        url: ctx?.url,
        channel: ctx?.channel,
        message: "Content-Length header missing; download size cannot be verified before streaming",
      });
    }
  }

  return { checkResponse, checkSize, maxSizeBytes };
}

// ============================================================================
// Errors (@omni/core ERROR_CODES / ChannelError)
// ============================================================================

/** Subset of the ported core error codes the WhatsApp library maps onto. */
export const ERROR_CODES = {
  UNKNOWN: "UNKNOWN",
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  CHANNEL_NOT_CONNECTED: "CHANNEL_NOT_CONNECTED",
  CHANNEL_CONNECTION_FAILED: "CHANNEL_CONNECTION_FAILED",
  CHANNEL_SEND_FAILED: "CHANNEL_SEND_FAILED",
  CHANNEL_TIMEOUT: "CHANNEL_TIMEOUT",
  CHANNEL_RATE_LIMITED: "CHANNEL_RATE_LIMITED",
  CHANNEL_AUTH_FAILED: "CHANNEL_AUTH_FAILED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Port of the core error → `ChannelError` hierarchy (flattened). */
export class ChannelError extends Error {
  readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;
  readonly recoverable: boolean;
  readonly timestamp: number;
  readonly channelType: string;
  readonly instanceId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    channelType: string,
    instanceId?: string,
    options?: { cause?: Error; recoverable?: boolean; context?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
    this.context = { channelType, instanceId, ...options?.context };
    this.recoverable = options?.recoverable ?? true;
    this.timestamp = Date.now();
    this.channelType = channelType;
    this.instanceId = instanceId;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      recoverable: this.recoverable,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}

// ============================================================================
// Markdown → WhatsApp (@omni/core markdown-to-whatsapp.ts)
// ============================================================================

const CODE_BLOCK_TOKEN_PREFIX = "__WA_CODE_BLOCK_";
const INLINE_CODE_TOKEN_PREFIX = "__WA_INLINE_CODE_";

function replaceWithTokens(
  input: string,
  regex: RegExp,
  formatter: (match: RegExpExecArray, index: number) => string,
  tokenPrefix: string,
): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  const text = input.replace(regex, (match: string, ...rest: unknown[]) => {
    const token = `${tokenPrefix}${tokens.length}__`;
    const execMatch = Object.assign([match], {
      0: match,
      index: 0,
      input,
      groups: undefined,
    }) as unknown as RegExpExecArray;
    // Capture groups are in `rest`; the last two args are offset and input.
    for (let g = 0; g < rest.length - 2; g++) {
      (execMatch as unknown as string[])[g + 1] = rest[g] as string;
    }
    tokens.push(formatter(execMatch, tokens.length));
    return token;
  });

  return { text, tokens };
}

function restoreTokens(input: string, tokens: string[], tokenPrefix: string): string {
  let result = input;
  for (let i = 0; i < tokens.length; i += 1) {
    result = result.replace(`${tokenPrefix}${i}__`, tokens[i] ?? "");
  }
  return result;
}

function convertHeaders(input: string): string {
  return input.replace(/^(#{1,6})\s+(.+)$/gm, (_full, _hashes: string, content: string) => `**${content.trim()}**`);
}

function convertLinks(input: string): string {
  return input.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2");
}

function convertEmphasis(input: string): string {
  const boldTokenPrefix = "__WA_BOLD_";
  const tripleTokenPrefix = "__WA_TRIPLE_";

  const triple = replaceWithTokens(input, /\*\*\*([^*\n]+?)\*\*\*/g, (match) => `*_${match[1]}_*`, tripleTokenPrefix);

  const bold = replaceWithTokens(triple.text, /\*\*([^*\n]+?)\*\*/g, (match) => `*${match[1]}*`, boldTokenPrefix);

  const converted = bold.text
    .replace(/~~~([\s\S]+?)~~~/g, "~$1~")
    .replace(/~~([\s\S]+?)~~/g, "~$1~")
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1_$2_");

  const withBold = restoreTokens(converted, bold.tokens, boldTokenPrefix);
  return restoreTokens(withBold, triple.tokens, tripleTokenPrefix);
}

/** Convert Markdown text into WhatsApp formatting syntax. */
export function markdownToWhatsApp(markdown: string): string {
  const fenced = replaceWithTokens(
    markdown,
    /```([^\n`]*)\n([\s\S]*?)```/g,
    (match) => {
      const code = match[2] ?? "";
      return `\`\`\`\n${code}\`\`\``;
    },
    CODE_BLOCK_TOKEN_PREFIX,
  );

  const inline = replaceWithTokens(
    fenced.text,
    /`([^`\n]+?)`/g,
    (match) => `\`${match[1]}\``,
    INLINE_CODE_TOKEN_PREFIX,
  );

  const converted = convertEmphasis(convertLinks(convertHeaders(inline.text)));
  const withInline = restoreTokens(converted, inline.tokens, INLINE_CODE_TOKEN_PREFIX);
  return restoreTokens(withInline, fenced.tokens, CODE_BLOCK_TOKEN_PREFIX);
}
