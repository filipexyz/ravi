import type {
  MailParsedGuardrailInput,
  MailParsedGuardrailResult,
} from "../../../src/server/console/mail/parser";

export type ModelArmorByteDataType =
  | "PLAINTEXT_UTF8"
  | "PDF"
  | "WORD_DOCUMENT"
  | "EXCEL_DOCUMENT"
  | "POWERPOINT_DOCUMENT"
  | "TXT"
  | "CSV";

export type MailModelArmorMode = "monitor" | "quarantine";
export type MailModelArmorFailPolicy = "fail-open" | "fail-closed";
export type MailModelArmorUnsupportedPolicy = "allow" | "quarantine";

export type MailModelArmorConfig = {
  accessToken?: string;
  endpoint: string;
  failPolicy: MailModelArmorFailPolicy;
  location: string;
  maxAttachmentBytes: number;
  maxTextBytes: number;
  mode: MailModelArmorMode;
  projectId: string;
  serviceAccountJson?: string;
  templateId: string;
  unsupportedPolicy: MailModelArmorUnsupportedPolicy;
};

export type MailModelArmorEnv = {
  RAVI_MAIL_MODEL_ARMOR_ACCESS_TOKEN?: string;
  RAVI_MAIL_MODEL_ARMOR_ENABLED?: string;
  RAVI_MAIL_MODEL_ARMOR_ENDPOINT?: string;
  RAVI_MAIL_MODEL_ARMOR_FAIL_POLICY?: string;
  RAVI_MAIL_MODEL_ARMOR_LOCATION?: string;
  RAVI_MAIL_MODEL_ARMOR_MAX_ATTACHMENT_BYTES?: string;
  RAVI_MAIL_MODEL_ARMOR_MAX_TEXT_BYTES?: string;
  RAVI_MAIL_MODEL_ARMOR_MODE?: string;
  RAVI_MAIL_MODEL_ARMOR_PROJECT_ID?: string;
  RAVI_MAIL_MODEL_ARMOR_SERVICE_ACCOUNT_JSON?: string;
  RAVI_MAIL_MODEL_ARMOR_TEMPLATE_ID?: string;
  RAVI_MAIL_MODEL_ARMOR_UNSUPPORTED_POLICY?: string;
};

export type MailModelArmorLog = (event: {
  event: "mail_model_armor_auth_failed" | "mail_model_armor_misconfigured" | "mail_model_armor_quarantined";
  level: "warn";
  requestId: string;
  organizationId: string;
  mailboxId: string;
  messageId: string;
  reason?: string;
}) => void;

type ModelArmorScanStatus =
  | "clean"
  | "matched"
  | "unsupported"
  | "skipped_size_limit"
  | "skipped"
  | "failed"
  | "disabled";

type ModelArmorScanMetadata = {
  status: ModelArmorScanStatus;
  filterMatchState?: string | null;
  invocationResult?: string | null;
  matchedFilters?: string[];
  error?: string;
};

type ModelArmorAttachmentMetadata = ModelArmorScanMetadata & {
  attachmentId: string;
  byteDataType?: ModelArmorByteDataType;
  contentType: string | null;
  sha256: string;
  sizeBytes: number;
};

const DEFAULT_ENDPOINT = "https://modelarmor.googleapis.com";
const DEFAULT_MAX_TEXT_BYTES = 1_000_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 4_000_000;
const DEFAULT_ATTACHMENT_SCAN_CONCURRENCY = 3;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let serviceAccountTokenCache: { cacheKey: string; accessToken: string; expiresAtMs: number } | null = null;

export async function scanParsedMailWithModelArmor({
  env,
  fetchImpl = fetch,
  input,
  log,
}: {
  env: MailModelArmorEnv;
  fetchImpl?: typeof fetch;
  input: MailParsedGuardrailInput;
  log?: MailModelArmorLog;
}): Promise<MailParsedGuardrailResult> {
  const config = modelArmorConfigFromEnv(env);
  if (!config) {
    if (truthy(env.RAVI_MAIL_MODEL_ARMOR_ENABLED)) {
      const reason = modelArmorConfigIssues(env).join(",") || "model_armor_config_invalid";
      const metadata = failedConfigurationMetadata({
        env,
        input,
        reason,
      });
      log?.(logEvent(input, "mail_model_armor_misconfigured", "warn", reason));
      if (metadata.delivery === "quarantine") {
        log?.(logEvent(input, "mail_model_armor_quarantined", "warn", reason));
      }
      return { metadataJson: { guardrail: metadata } };
    }

    return {
      metadataJson: {
        guardrail: {
          schemaVersion: 1,
          provider: "model_armor",
          enabled: false,
          delivery: "deliver",
          content: { status: "disabled" },
          attachments: input.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            contentType: attachment.contentType,
            sha256: attachment.sha256,
            sizeBytes: attachment.sizeBytes,
            status: "disabled",
          })),
        },
      },
    };
  }

  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(config, fetchImpl);
  } catch {
    const metadata = failedMetadata({ config, input, reason: "auth_failed" });
    log?.(logEvent(input, "mail_model_armor_auth_failed", "warn", "auth_failed"));
    return { metadataJson: { guardrail: metadata } };
  }

  const text = buildPromptText(input);
  const content = await scanText({ accessToken, config, fetchImpl, input, text });
  const attachments = await mapWithConcurrency(input.attachments, DEFAULT_ATTACHMENT_SCAN_CONCURRENCY, async (attachment) => {
    const byteDataType = modelArmorByteDataTypeForAttachment({
      contentType: attachment.contentType,
      filename: attachment.filename,
    });

    if (!byteDataType) {
      return {
        attachmentId: attachment.attachmentId,
        contentType: attachment.contentType,
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
        status: "unsupported",
      } satisfies ModelArmorAttachmentMetadata;
    }

    if (attachment.sizeBytes > config.maxAttachmentBytes) {
      return {
        attachmentId: attachment.attachmentId,
        byteDataType,
        contentType: attachment.contentType,
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
        status: "skipped_size_limit",
      } satisfies ModelArmorAttachmentMetadata;
    }

    return scanAttachment({
      accessToken,
      attachment: {
        attachmentId: attachment.attachmentId,
        byteData: bytesToBase64(attachment.content),
        byteDataType,
        contentType: attachment.contentType,
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
      },
      config,
      fetchImpl,
      input,
    });
  });

  const delivery = deliveryDecision({
    attachments,
    config,
    content,
  });

  if (delivery === "quarantine") {
    log?.(logEvent(input, "mail_model_armor_quarantined", "warn"));
  }

  return {
    metadataJson: {
      guardrail: {
        schemaVersion: 1,
        provider: "model_armor",
        enabled: true,
        delivery,
        mode: config.mode,
        failPolicy: config.failPolicy,
        unsupportedPolicy: config.unsupportedPolicy,
        template: {
          location: config.location,
          templateId: config.templateId,
        },
        content,
        attachments,
      },
    },
  };
}

export function modelArmorConfigFromEnv(env: MailModelArmorEnv): MailModelArmorConfig | null {
  if (!truthy(env.RAVI_MAIL_MODEL_ARMOR_ENABLED)) return null;

  if (modelArmorConfigIssues(env).length > 0) return null;

  const projectId = env.RAVI_MAIL_MODEL_ARMOR_PROJECT_ID?.trim() ?? "";
  const location = env.RAVI_MAIL_MODEL_ARMOR_LOCATION?.trim() ?? "";
  const templateId = env.RAVI_MAIL_MODEL_ARMOR_TEMPLATE_ID?.trim() ?? "";

  const accessToken = env.RAVI_MAIL_MODEL_ARMOR_ACCESS_TOKEN?.trim() || undefined;
  const serviceAccountJson = env.RAVI_MAIL_MODEL_ARMOR_SERVICE_ACCOUNT_JSON?.trim() || undefined;

  return {
    accessToken,
    endpoint: normalizeEndpoint(env.RAVI_MAIL_MODEL_ARMOR_ENDPOINT),
    failPolicy: normalizeFailPolicy(env.RAVI_MAIL_MODEL_ARMOR_FAIL_POLICY),
    location,
    maxAttachmentBytes: positiveInt(env.RAVI_MAIL_MODEL_ARMOR_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_ATTACHMENT_BYTES),
    maxTextBytes: positiveInt(env.RAVI_MAIL_MODEL_ARMOR_MAX_TEXT_BYTES, DEFAULT_MAX_TEXT_BYTES),
    mode: normalizeMode(env.RAVI_MAIL_MODEL_ARMOR_MODE),
    projectId,
    serviceAccountJson,
    templateId,
    unsupportedPolicy: normalizeUnsupportedPolicy(env.RAVI_MAIL_MODEL_ARMOR_UNSUPPORTED_POLICY),
  };
}

export function modelArmorByteDataTypeForAttachment(input: {
  contentType: string | null;
  filename: string | null;
}): ModelArmorByteDataType | null {
  const contentType = input.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = input.filename?.split(".").pop()?.trim().toLowerCase() ?? "";

  if (contentType === "application/pdf" || extension === "pdf") return "PDF";
  if (
    contentType === "application/msword" ||
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "doc" ||
    extension === "docx"
  ) {
    return "WORD_DOCUMENT";
  }
  if (
    contentType === "application/vnd.ms-excel" ||
    contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    extension === "xls" ||
    extension === "xlsx"
  ) {
    return "EXCEL_DOCUMENT";
  }
  if (
    contentType === "application/vnd.ms-powerpoint" ||
    contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    extension === "ppt" ||
    extension === "pptx"
  ) {
    return "POWERPOINT_DOCUMENT";
  }
  if (contentType === "text/csv" || extension === "csv") return "CSV";
  if (extension === "txt") return "TXT";
  if (contentType.startsWith("text/")) return "PLAINTEXT_UTF8";
  return null;
}

async function scanText({
  accessToken,
  config,
  fetchImpl,
  input,
  text,
}: {
  accessToken: string;
  config: MailModelArmorConfig;
  fetchImpl: typeof fetch;
  input: MailParsedGuardrailInput;
  text: string;
}): Promise<ModelArmorScanMetadata> {
  const sizeBytes = new TextEncoder().encode(text).byteLength;
  if (sizeBytes > config.maxTextBytes) return { status: "skipped_size_limit" };

  return sanitizeUserPrompt({
    accessToken,
    body: {
      userPromptData: {
        text,
      },
    },
    config,
    fetchImpl,
    input,
  });
}

async function scanAttachment({
  accessToken,
  attachment,
  config,
  fetchImpl,
  input,
}: {
  accessToken: string;
  attachment: {
    attachmentId: string;
    byteData: string;
    byteDataType: ModelArmorByteDataType;
    contentType: string | null;
    sha256: string;
    sizeBytes: number;
  };
  config: MailModelArmorConfig;
  fetchImpl: typeof fetch;
  input: MailParsedGuardrailInput;
}): Promise<ModelArmorAttachmentMetadata> {
  const result = await sanitizeUserPrompt({
    accessToken,
    body: {
      userPromptData: {
        byteItem: {
          byteData: attachment.byteData,
          byteDataType: attachment.byteDataType,
        },
      },
    },
    config,
    fetchImpl,
    input,
  });

  return {
    ...result,
    attachmentId: attachment.attachmentId,
    byteDataType: attachment.byteDataType,
    contentType: attachment.contentType,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
  };
}

async function sanitizeUserPrompt({
  accessToken,
  body,
  config,
  fetchImpl,
  input,
}: {
  accessToken: string;
  body: Record<string, unknown>;
  config: MailModelArmorConfig;
  fetchImpl: typeof fetch;
  input: MailParsedGuardrailInput;
}): Promise<ModelArmorScanMetadata> {
  let response: Response;
  try {
    response = await fetchImpl(modelArmorTemplateUrl(config), {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
  } catch {
    return failureScanMetadata(config, "network_error");
  }

  if (!response.ok) return failureScanMetadata(config, `http_${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failureScanMetadata(config, "invalid_json");
  }

  const result = findSanitizationResult(payload);
  const matchedFilters = matchedFilterNames(result ?? payload);
  const matchFound = hasStringValue(result ?? payload, "MATCH_FOUND") || matchedFilters.length > 0;

  return {
    status: matchFound ? "matched" : "clean",
    filterMatchState: stringProperty(result, "filterMatchState"),
    invocationResult: stringProperty(result, "invocationResult"),
    ...(matchedFilters.length > 0 ? { matchedFilters } : {}),
  };
}

function failureScanMetadata(config: MailModelArmorConfig, error: string): ModelArmorScanMetadata {
  return {
    status: failureScanStatus(config),
    error,
  };
}

function failedMetadata({
  config,
  input,
  reason,
}: {
  config: MailModelArmorConfig;
  input: MailParsedGuardrailInput;
  reason: string;
}) {
  const delivery = config.failPolicy === "fail-closed" ? "quarantine" : "deliver";
  return {
    schemaVersion: 1,
    provider: "model_armor",
    enabled: true,
    delivery,
    mode: config.mode,
    failPolicy: config.failPolicy,
    unsupportedPolicy: config.unsupportedPolicy,
    template: {
      location: config.location,
      templateId: config.templateId,
    },
    content: {
      status: failureScanStatus(config),
      error: reason,
    },
    attachments: input.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      contentType: attachment.contentType,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      status: failureScanStatus(config),
      error: reason,
    })),
  };
}

function failedConfigurationMetadata({
  env,
  input,
  reason,
}: {
  env: MailModelArmorEnv;
  input: MailParsedGuardrailInput;
  reason: string;
}) {
  const failPolicy = normalizeFailPolicy(env.RAVI_MAIL_MODEL_ARMOR_FAIL_POLICY);
  const delivery = failPolicy === "fail-closed" ? "quarantine" : "deliver";
  return {
    schemaVersion: 1,
    provider: "model_armor",
    enabled: true,
    delivery,
    mode: normalizeMode(env.RAVI_MAIL_MODEL_ARMOR_MODE),
    failPolicy,
    unsupportedPolicy: normalizeUnsupportedPolicy(env.RAVI_MAIL_MODEL_ARMOR_UNSUPPORTED_POLICY),
    template: {
      location: env.RAVI_MAIL_MODEL_ARMOR_LOCATION?.trim() || null,
      templateId: env.RAVI_MAIL_MODEL_ARMOR_TEMPLATE_ID?.trim() || null,
    },
    content: {
      status: failPolicy === "fail-closed" ? "failed" : "skipped",
      error: reason,
    },
    attachments: input.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      contentType: attachment.contentType,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      status: failPolicy === "fail-closed" ? "failed" : "skipped",
      error: reason,
    })),
  };
}

function failureScanStatus(config: MailModelArmorConfig): "failed" | "skipped" {
  return config.failPolicy === "fail-closed" ? "failed" : "skipped";
}

function deliveryDecision({
  attachments,
  config,
  content,
}: {
  attachments: ModelArmorAttachmentMetadata[];
  config: MailModelArmorConfig;
  content: ModelArmorScanMetadata;
}): "deliver" | "quarantine" {
  if (config.failPolicy === "fail-closed" && content.status === "failed") return "quarantine";
  if (config.failPolicy === "fail-closed" && attachments.some((attachment) => attachment.status === "failed")) {
    return "quarantine";
  }
  if (config.mode === "quarantine" && content.status === "matched") return "quarantine";
  if (config.mode === "quarantine" && attachments.some((attachment) => attachment.status === "matched")) {
    return "quarantine";
  }
  if (config.mode === "quarantine" && content.status === "skipped_size_limit") return "quarantine";
  if (config.mode === "quarantine" && attachments.some((attachment) => attachment.status === "skipped_size_limit")) {
    return "quarantine";
  }
  if (
    config.unsupportedPolicy === "quarantine" &&
    (content.status === "skipped_size_limit" ||
      attachments.some((attachment) => attachment.status === "unsupported" || attachment.status === "skipped_size_limit"))
  ) {
    return "quarantine";
  }
  return "deliver";
}

async function resolveAccessToken(config: MailModelArmorConfig, fetchImpl: typeof fetch): Promise<string> {
  if (config.accessToken) return config.accessToken;
  if (!config.serviceAccountJson) throw new Error("model_armor_auth_missing");
  return serviceAccountAccessToken(config.serviceAccountJson, fetchImpl);
}

async function serviceAccountAccessToken(serviceAccountJson: string, fetchImpl: typeof fetch): Promise<string> {
  const credentials = JSON.parse(serviceAccountJson) as {
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };
  if (!credentials.client_email || !credentials.private_key) throw new Error("model_armor_service_account_invalid");

  const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
  const cacheKey = `${credentials.client_email}:${tokenUri}`;
  const nowMs = Date.now();
  if (serviceAccountTokenCache?.cacheKey === cacheKey && serviceAccountTokenCache.expiresAtMs > nowMs + 60_000) {
    return serviceAccountTokenCache.accessToken;
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const assertion = await signJwt({
    claims: {
      aud: tokenUri,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      iss: credentials.client_email,
      scope: CLOUD_PLATFORM_SCOPE,
    },
    privateKeyPem: credentials.private_key,
  });

  const response = await fetchImpl(tokenUri, {
    body: new URLSearchParams({
      assertion,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error("model_armor_token_exchange_failed");
  const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("model_armor_token_missing");
  }
  const expiresInSeconds = positiveInt(String(payload.expires_in ?? ""), 3600);
  serviceAccountTokenCache = {
    cacheKey,
    accessToken: payload.access_token,
    expiresAtMs: nowMs + Math.max(60, expiresInSeconds - 60) * 1000,
  };
  return payload.access_token;
}

async function signJwt({
  claims,
  privateKeyPem,
}: {
  claims: Record<string, unknown>;
  privateKeyPem: string;
}): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function buildPromptText(input: MailParsedGuardrailInput): string {
  return [
    `Subject: ${input.subject}`,
    "",
    input.bodyText,
    "",
    htmlToText(input.bodyHtml),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function htmlToText(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function modelArmorTemplateUrl(config: MailModelArmorConfig): string {
  const endpoint = config.endpoint.replace(/\/+$/, "");
  return `${endpoint}/v1/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(
    config.location,
  )}/templates/${encodeURIComponent(config.templateId)}:sanitizeUserPrompt`;
}

function findSanitizationResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (isPlainObject(object.sanitizationResult)) return object.sanitizationResult;
  if (isPlainObject(object.sanitization_result)) return object.sanitization_result;
  return isPlainObject(value) ? value : null;
}

function matchedFilterNames(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => matchedFilterNames(item, [...path, String(index)]));

  const matches: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (
      (key === "filterMatchState" || key === "filter_match_state") &&
      typeof nested === "string" &&
      nested === "MATCH_FOUND"
    ) {
      matches.push(path[path.length - 1] ?? "unknown");
    }
    matches.push(...matchedFilterNames(nested, [...path, key]));
  }
  return [...new Set(matches.filter((name) => name !== "sanitizationResult"))].sort();
}

function hasStringValue(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasStringValue(item, expected));
  return Object.values(value).some((item) => hasStringValue(item, expected));
}

function stringProperty(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key] ?? value?.[snakeCase(key)];
  return typeof candidate === "string" ? candidate : null;
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function normalizeEndpoint(value: string | undefined): string {
  return value?.trim() || DEFAULT_ENDPOINT;
}

function normalizeMode(value: string | undefined): MailModelArmorMode {
  return value?.trim() === "quarantine" ? "quarantine" : "monitor";
}

function normalizeFailPolicy(value: string | undefined): MailModelArmorFailPolicy {
  return value?.trim() === "fail-open" ? "fail-open" : "fail-closed";
}

function normalizeUnsupportedPolicy(value: string | undefined): MailModelArmorUnsupportedPolicy {
  return value?.trim() === "allow" ? "allow" : "quarantine";
}

function modelArmorConfigIssues(env: MailModelArmorEnv): string[] {
  const issues: string[] = [];
  if (!env.RAVI_MAIL_MODEL_ARMOR_PROJECT_ID?.trim()) issues.push("missing_project_id");
  if (!env.RAVI_MAIL_MODEL_ARMOR_LOCATION?.trim()) issues.push("missing_location");
  if (!env.RAVI_MAIL_MODEL_ARMOR_TEMPLATE_ID?.trim()) issues.push("missing_template_id");
  if (
    !env.RAVI_MAIL_MODEL_ARMOR_ACCESS_TOKEN?.trim() &&
    !env.RAVI_MAIL_MODEL_ARMOR_SERVICE_ACCOUNT_JSON?.trim()
  ) {
    issues.push("missing_auth");
  }
  return issues;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function logEvent(
  input: MailParsedGuardrailInput,
  event: "mail_model_armor_auth_failed" | "mail_model_armor_misconfigured" | "mail_model_armor_quarantined",
  level: "warn",
  reason?: string,
): Parameters<MailModelArmorLog>[0] {
  return {
    event,
    level,
    requestId: input.requestId,
    organizationId: input.organizationId,
    mailboxId: input.mailboxId,
    messageId: input.messageId,
    ...(reason ? { reason } : {}),
  };
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + chunkSize)));
  }
  return btoa(chunks.join(""));
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  return results;
}
