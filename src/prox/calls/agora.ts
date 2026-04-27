/**
 * prox.city Calls — Agora SIP Provider
 *
 * Bridges Ravi call requests to Agora Conversational AI outbound calls.
 * The public Ravi model stays provider-neutral; Agora-specific details are
 * contained in this adapter and webhook normalizer.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateConvoAIToken, generateRtcToken } from "agora-agent-server-sdk";
import { getDb } from "../../router/router-db.js";
import {
  createCallEvent,
  createCallResult,
  getCallRequest,
  getCallRun,
  listCallEvents,
  updateCallRequestStatus,
  updateCallRunStatus,
} from "./calls-db.js";
import { notifyCallOrigin } from "./notify.js";
import type {
  CallProviderAdapter,
  CallResultOutcome,
  CallRunStatus,
  ProviderDialInput,
  ProviderDialResult,
} from "./types.js";

const AGORA_API_BASE_URL = "https://api.agora.io/api/conversational-ai-agent/v2";
export const AGORA_MCP_TOOLS_PATH = "/webhooks/agora/tools";
const DEFAULT_AGENT_UID = "1001";
const DEFAULT_SIP_UID = "100";
const TOKEN_TTL_SECONDS = 60 * 60;

type JsonRecord = Record<string, unknown>;

export interface AgoraSipConfig {
  appId: string;
  appCertificate: string;
  customerId?: string;
  customerSecret?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface AgoraWebhookPayload {
  noticeId?: string;
  productId?: number;
  eventType: 101 | 102 | 103 | 110 | 111 | 201 | 202;
  notifyMs?: number;
  sid?: string;
  payload: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonEnv(value: string | undefined, name: string): JsonRecord | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${name} must be valid JSON object.`);
  }
}

function readRaviEnvVar(name: string): string | undefined {
  if (process.env.RAVI_CALLS_DISABLE_ENV_FILE === "1") return undefined;
  const envPath = join(homedir(), ".ravi/.env");
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${name}=`));
  if (!line) return undefined;
  const value = line.split("=").slice(1).join("=").trim();
  return value.replace(/^['"]|['"]$/g, "") || undefined;
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || readRaviEnvVar(name);
}

export function resolveAgoraSipConfig(): AgoraSipConfig | null {
  const appId = envValue("AGORA_APP_ID");
  const appCertificate = envValue("AGORA_APP_CERTIFICATE");
  if (!appId || !appCertificate) return null;

  return {
    appId,
    appCertificate,
    customerId: envValue("AGORA_CUSTOMER_ID"),
    customerSecret: envValue("AGORA_CUSTOMER_SECRET"),
  };
}

function authHeader(config: AgoraSipConfig, token: string): string {
  if (config.customerId && config.customerSecret) {
    return `Basic ${Buffer.from(`${config.customerId}:${config.customerSecret}`).toString("base64")}`;
  }
  return `agora token=${token}`;
}

function safeCompareString(expectedValue: string, actualValue: string): boolean {
  if (!expectedValue || !actualValue) return false;
  const expected = Buffer.from(expectedValue);
  const actual = Buffer.from(actualValue);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function validateE164(value: string | null | undefined, field: string): string | null {
  if (!value?.trim()) return `Missing ${field}.`;
  if (!/^\+[1-9]\d{7,14}$/.test(value.trim())) {
    return `${field} must be E.164, e.g. +5511999999999.`;
  }
  return null;
}

function extractDynamicVariables(metadata: JsonRecord | null): Record<string, string> {
  const raw = metadata?.dynamic_variables ?? metadata?.dynamicVariables;
  if (!isRecord(raw)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value === "string") out[key] = value;
    if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

function cleanTtsParams(vendor: string | undefined, params: JsonRecord | undefined): JsonRecord | undefined {
  if (!params) return undefined;
  const next = { ...params };
  if (vendor === "elevenlabs" && typeof next.base_url === "string" && next.base_url.includes("elevenlabs.io")) {
    delete next.base_url;
  }
  return next;
}

function buildSystemPrompt(input: ProviderDialInput): string {
  return [
    input.profile.prompt,
    "",
    "Contexto da chamada:",
    `- Pessoa: {{person_name}}`,
    `- Motivo: {{reason}}`,
    "{{context}}",
    "",
    "Objetivo:",
    "{{goal}}",
    "",
    "Resultado esperado:",
    "{{expected_output}}",
    "",
    "Conduza em portugues do Brasil, de forma curta e objetiva.",
    "Quando o objetivo da chamada for cumprido, faca uma despedida curta e chame a ferramenta end_call imediatamente.",
    "Se a pessoa pedir para encerrar, chame end_call imediatamente. Nao espere a pessoa desligar.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
    .trim();
}

function normalizeBaseUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return value.trim().replace(/\/+$/, "");
}

function agoraMcpPublicBaseUrl(): string | null {
  return (
    normalizeBaseUrl(envValue("AGORA_MCP_PUBLIC_BASE_URL")) ??
    normalizeBaseUrl(envValue("RAVI_WEBHOOK_PUBLIC_BASE_URL")) ??
    normalizeBaseUrl(envValue("RAVI_PUBLIC_BASE_URL"))
  );
}

function agoraMcpToolSecret(): string | null {
  return envValue("RAVI_AGORA_TOOL_SECRET") ?? envValue("AGORA_MCP_TOOL_SECRET") ?? null;
}

function buildAgoraMcpServers(requestId: string): JsonRecord[] | undefined {
  const baseUrl = agoraMcpPublicBaseUrl();
  const secret = agoraMcpToolSecret();
  if (!baseUrl || !secret) return undefined;

  return [
    {
      name: "raviTools",
      endpoint: `${baseUrl}${AGORA_MCP_TOOLS_PATH}?request_id=${encodeURIComponent(requestId)}`,
      transport: "streamable_http",
      headers: {
        Authorization: `Bearer ${secret}`,
      },
      allowed_tools: ["end_call"],
      timeout_ms: 5000,
    },
  ];
}

function buildFullProperties(
  input: ProviderDialInput,
  channel: string,
  agentUid: string,
  sipUid: string,
  token: string,
): JsonRecord {
  const dynamicVariables = {
    person_name: input.request.target_person_id,
    reason: input.request.reason,
    opening_line: input.profile.first_message ?? "Oi, aqui é o Ravi.",
    goal: "Entender a resposta da pessoa e devolver um resumo objetivo.",
    context: "",
    expected_output: "Resumo objetivo da chamada e proxima acao.",
    ...extractDynamicVariables(input.request.metadata_json),
  };

  const ttsVendor = envValue("AGORA_TTS_VENDOR");
  const ttsParams = cleanTtsParams(ttsVendor, parseJsonEnv(envValue("AGORA_TTS_PARAMS_JSON"), "AGORA_TTS_PARAMS_JSON"));
  const llmApiKey = envValue("AGORA_LLM_API_KEY") || envValue("OPENAI_API_KEY");
  const asrParams = parseJsonEnv(envValue("AGORA_ASR_PARAMS_JSON"), "AGORA_ASR_PARAMS_JSON");
  const asrVendor = envValue("AGORA_ASR_VENDOR");

  if (!llmApiKey) {
    throw new Error(
      "AGORA_LLM_API_KEY or OPENAI_API_KEY is required for Agora full-config calls when no pipeline_id is configured.",
    );
  }
  if (!ttsVendor || !ttsParams) {
    throw new Error(
      "AGORA_TTS_VENDOR and AGORA_TTS_PARAMS_JSON are required for Agora full-config calls when no pipeline_id is configured.",
    );
  }

  const asr: JsonRecord = {
    language: envValue("AGORA_ASR_LANGUAGE") || "pt-BR",
  };
  if (asrVendor) asr.vendor = asrVendor;
  if (asrParams) asr.params = asrParams;
  const mcpServers = buildAgoraMcpServers(input.request.id);

  return {
    channel,
    token,
    agent_rtc_uid: agentUid,
    remote_rtc_uids: [sipUid],
    advanced_features: { enable_rtm: true, enable_tools: Boolean(mcpServers) },
    enable_string_uid: false,
    idle_timeout: Number(envValue("AGORA_AGENT_IDLE_TIMEOUT") || 600),
    parameters: {
      transcript: {
        enable: true,
        protocol_version: "v2",
        enable_words: false,
      },
      data_channel: "rtm",
      enable_dump: true,
      enable_metrics: true,
      enable_error_message: true,
    },
    turn_detection: {
      config: {
        end_of_speech: {
          mode: envValue("AGORA_END_OF_SPEECH_MODE") || "semantic",
        },
      },
    },
    labels: {
      ravi_call_request_id: input.request.id,
      ravi_call_run_id: input.run.id,
      ravi_profile_id: input.profile.id,
    },
    llm: {
      url: envValue("AGORA_LLM_URL") || "https://api.openai.com/v1/chat/completions",
      api_key: llmApiKey,
      style: envValue("AGORA_LLM_STYLE") || "openai",
      system_messages: [{ role: "system", content: buildSystemPrompt(input) }],
      max_history: Number(envValue("AGORA_LLM_MAX_HISTORY") || 32),
      greeting_message: input.profile.first_message || "{{opening_line}}",
      failure_message: "Segura um segundo, vou reorganizar a pergunta.",
      template_variables: dynamicVariables,
      params: {
        model: envValue("AGORA_LLM_MODEL") || "gpt-4o-mini",
      },
      input_modalities: ["text"],
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
    },
    tts: {
      vendor: ttsVendor,
      params: ttsParams,
    },
    asr,
  };
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function jsonRpcResult(id: unknown, result: JsonRecord): JsonRecord {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): JsonRecord {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && typeof value.method === "string";
}

function extractBearerToken(authorization: string | null | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function findLatestAgoraRunByRequest(requestId: string): { runId: string; requestId: string; agentId: string } | null {
  const row = getDb()
    .prepare(
      `
      SELECT id, request_id, provider_call_id
      FROM call_runs
      WHERE request_id = ?
        AND provider = 'agora_sip'
        AND provider_call_id IS NOT NULL
      ORDER BY COALESCE(answered_at, started_at, 0) DESC, attempt_number DESC
      LIMIT 1
      `,
    )
    .get(requestId) as { id: string; request_id: string; provider_call_id: string } | undefined;
  return row ? { runId: row.id, requestId: row.request_id, agentId: row.provider_call_id } : null;
}

function hasHangupAlreadyRequested(requestId: string, runId: string): boolean {
  return listCallEvents(requestId).some(
    (event) =>
      event.run_id === runId &&
      event.source === "prox.calls.agora.tool" &&
      event.event_type === "run.progress" &&
      event.status === "hangup_requested",
  );
}

function isTerminalRunStatus(status: CallRunStatus): boolean {
  return ["completed", "no_answer", "busy", "voicemail", "failed", "canceled"].includes(status);
}

export async function hangupAgoraSipCall(
  config: AgoraSipConfig,
  agentId: string,
  reason: string | null,
): Promise<{ ok: boolean; message: string }> {
  const response = await (config.fetchImpl ?? fetch)(
    `${config.apiBaseUrl ?? AGORA_API_BASE_URL}/projects/${encodeURIComponent(config.appId)}/calls/${encodeURIComponent(agentId)}/hangup`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: authHeader(config, ""),
      },
      body: JSON.stringify({ reason: reason || "end_call_tool" }),
    },
  );
  const text = await response.text();

  if (!response.ok) {
    return { ok: false, message: text.trim() || `Agora hangup failed with HTTP ${response.status}` };
  }

  return { ok: true, message: "Call hangup requested." };
}

async function hangupAgoraCallForRequest(
  requestId: string,
  reason: string | null,
): Promise<{ ok: boolean; message: string }> {
  const config = resolveAgoraSipConfig();
  if (!config) return { ok: false, message: "Agora credentials are not configured." };
  if (!config.customerId || !config.customerSecret) {
    return { ok: false, message: "AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET are required for API hangup." };
  }

  const match = findLatestAgoraRunByRequest(requestId);
  if (!match) return { ok: false, message: `No active Agora run found for call request ${requestId}.` };

  const request = getCallRequest(match.requestId);
  const run = getCallRun(match.runId);
  if (!request || !run) return { ok: false, message: `Call request ${requestId} is no longer available.` };

  if (isTerminalRunStatus(run.status) || hasHangupAlreadyRequested(request.id, run.id)) {
    return { ok: true, message: "Call hangup was already requested." };
  }

  const result = await hangupAgoraSipCall(config, match.agentId, reason);

  if (!result.ok) {
    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "provider.error",
      status: "hangup_failed",
      message: result.message,
      payload_json: {
        provider: "agora",
        agent_id: match.agentId,
        status: "failed",
      },
      source: "prox.calls.agora.tool",
    });
    return result;
  }

  createCallEvent({
    request_id: request.id,
    run_id: run.id,
    event_type: "run.progress",
    status: "hangup_requested",
    message: reason || "Agora hangup requested by end_call tool.",
    payload_json: {
      provider: "agora",
      agent_id: match.agentId,
    },
    source: "prox.calls.agora.tool",
  });

  return { ok: true, message: "Call hangup requested." };
}

async function handleAgoraToolCall(requestId: string, rpc: JsonRpcRequest): Promise<JsonRecord> {
  const params = isRecord(rpc.params) ? rpc.params : {};
  const toolName = stringValue(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (toolName !== "end_call") {
    return jsonRpcError(rpc.id, -32602, `Unsupported tool: ${toolName ?? "unknown"}`);
  }

  const hangup = await hangupAgoraCallForRequest(requestId, stringValue(args.reason) ?? null);
  return jsonRpcResult(rpc.id, {
    content: [{ type: "text", text: hangup.message }],
    isError: !hangup.ok,
  });
}

export async function handleAgoraMcpToolRequest(input: {
  requestId: string | null;
  authorization: string | null;
  payload: unknown;
}): Promise<{ status: number; body: JsonRecord | null }> {
  const expectedSecret = agoraMcpToolSecret();
  if (!expectedSecret) return { status: 503, body: { ok: false, error: "tool_secret_not_configured" } };

  const actualSecret = extractBearerToken(input.authorization);
  if (!actualSecret || !safeCompareString(expectedSecret, actualSecret)) {
    return { status: 401, body: { ok: false, error: "invalid_token" } };
  }

  if (!input.requestId) return { status: 400, body: { ok: false, error: "missing_request_id" } };
  if (Array.isArray(input.payload)) {
    return { status: 400, body: { ok: false, error: "batch_not_supported" } };
  }
  if (!isJsonRpcRequest(input.payload)) {
    return { status: 400, body: { ok: false, error: "invalid_json_rpc" } };
  }

  const rpc = input.payload;
  const method = String(rpc.method);
  if (!("id" in rpc) && method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }

  switch (method) {
    case "initialize":
      return {
        status: 200,
        body: jsonRpcResult(rpc.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ravi-prox-calls", version: "0.1.0" },
        }),
      };
    case "ping":
      return { status: 200, body: jsonRpcResult(rpc.id, {}) };
    case "tools/list":
      return {
        status: 200,
        body: jsonRpcResult(rpc.id, {
          tools: [
            {
              name: "end_call",
              description:
                "End the current prox.city voice call after the objective is complete or the user asks to stop.",
              inputSchema: {
                type: "object",
                properties: {
                  reason: { type: "string", description: "Short reason for ending the call." },
                },
                additionalProperties: false,
              },
            },
          ],
        }),
      };
    case "tools/call":
      return { status: 200, body: await handleAgoraToolCall(input.requestId, rpc) };
    default:
      return { status: 200, body: jsonRpcError(rpc.id, -32601, `Method not found: ${method}`) };
  }
}

function buildPipelineProperties(channel: string, agentUid: string, sipUid: string, token: string): JsonRecord {
  return {
    channel,
    token,
    agent_rtc_uid: agentUid,
    remote_rtc_uids: [sipUid],
    labels: {},
  };
}

function describeAgoraError(status: number, body: unknown, text: string): string {
  if (isRecord(body)) {
    const detail = stringValue(body.detail) ?? stringValue(body.description) ?? stringValue(body.message);
    const reason = stringValue(body.reason) ?? stringValue(body.error_type);
    if (detail && reason) return `${reason}: ${detail}`;
    if (detail) return detail;
    if (reason) return reason;
  }
  return text.trim() ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
}

export class AgoraSipCallProvider implements CallProviderAdapter {
  readonly name = "agora_sip";
  private readonly config: AgoraSipConfig;

  constructor(config: AgoraSipConfig) {
    this.config = config;
  }

  async dial(input: ProviderDialInput): Promise<ProviderDialResult> {
    const phoneError = validateE164(input.target_phone, "target phone");
    if (phoneError) {
      return { provider_call_id: null, twilio_call_sid: null, status: "failed", failure_reason: phoneError };
    }

    const fromNumber = input.profile.twilio_number_id || envValue("AGORA_CALL_FROM_NUMBER");
    const fromError = validateE164(fromNumber, "Agora caller number");
    if (fromError) {
      return {
        provider_call_id: null,
        twilio_call_sid: null,
        status: "failed",
        failure_reason: `${fromError} Configure with: ravi prox calls profiles configure <id> --twilio-number-id <e164>`,
      };
    }

    const channel = `prox-call-${input.request.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
    const agentUid = envValue("AGORA_AGENT_UID") || DEFAULT_AGENT_UID;
    const sipUid = envValue("AGORA_SIP_UID") || DEFAULT_SIP_UID;
    const pipelineId = input.profile.provider_agent_id || envValue("AGORA_AGENT_PIPELINE_ID");

    let body: JsonRecord;
    try {
      const sipRtcToken = generateRtcToken({
        appId: this.config.appId,
        appCertificate: this.config.appCertificate,
        channel,
        uid: Number(sipUid),
        expirySeconds: TOKEN_TTL_SECONDS,
      });
      const agentToken = generateConvoAIToken({
        appId: this.config.appId,
        appCertificate: this.config.appCertificate,
        channelName: channel,
        account: agentUid,
        tokenExpire: TOKEN_TTL_SECONDS,
      });

      const properties = pipelineId
        ? buildPipelineProperties(channel, agentUid, sipUid, agentToken)
        : buildFullProperties(input, channel, agentUid, sipUid, agentToken);

      if (isRecord(properties.labels)) {
        properties.labels = {
          ...properties.labels,
          ravi_call_request_id: input.request.id,
          ravi_call_run_id: input.run.id,
          ravi_profile_id: input.profile.id,
        };
      }

      body = {
        name: `ravi-${input.request.id}-${randomUUID().slice(0, 8)}`,
        sip: {
          to_number: input.target_phone,
          from_number: fromNumber,
          rtc_uid: sipUid,
          rtc_token: sipRtcToken,
        },
        ...(pipelineId ? { pipeline_id: pipelineId } : {}),
        properties,
      };

      const response = await (this.config.fetchImpl ?? fetch)(
        `${this.config.apiBaseUrl ?? AGORA_API_BASE_URL}/projects/${encodeURIComponent(this.config.appId)}/call`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: authHeader(this.config, agentToken),
          },
          body: JSON.stringify(body),
        },
      );

      const text = await response.text();
      let data: unknown = null;
      if (text.trim()) {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          data = text;
        }
      }

      if (!response.ok) {
        return {
          provider_call_id: null,
          twilio_call_sid: null,
          status: "failed",
          failure_reason: describeAgoraError(response.status, data, text),
        };
      }

      const agentId = isRecord(data) ? stringValue(data.agent_id) : undefined;
      if (!agentId) {
        return {
          provider_call_id: null,
          twilio_call_sid: null,
          status: "failed",
          failure_reason: "Agora call response did not include agent_id.",
        };
      }

      return {
        provider_call_id: agentId,
        twilio_call_sid: null,
        status: "dialing",
        failure_reason: null,
      };
    } catch (error) {
      return {
        provider_call_id: null,
        twilio_call_sid: null,
        status: "failed",
        failure_reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function normalizeAgoraWebhookPayload(input: unknown): AgoraWebhookPayload | null {
  if (!isRecord(input)) return null;
  const eventType = numberValue(input.eventType);
  if (![101, 102, 103, 110, 111, 201, 202].includes(eventType ?? -1)) return null;
  const payload = input.payload;
  if (!isRecord(payload)) return null;

  return {
    noticeId: stringValue(input.noticeId),
    productId: numberValue(input.productId),
    eventType: eventType as AgoraWebhookPayload["eventType"],
    notifyMs: numberValue(input.notifyMs),
    sid: stringValue(input.sid),
    payload,
  };
}

function findRunByAgoraAgentId(agentId?: string): { runId: string; requestId: string } | null {
  if (!agentId) return null;
  const row = getDb().prepare("SELECT id, request_id FROM call_runs WHERE provider_call_id = ? LIMIT 1").get(agentId) as
    | { id: string; request_id: string }
    | undefined;
  return row ? { runId: row.id, requestId: row.request_id } : null;
}

function formatAgoraTranscript(contents: unknown): string | null {
  if (!Array.isArray(contents)) return null;
  const lines = contents
    .filter(isRecord)
    .map((item) => {
      const role = item.role === "assistant" ? "agent" : item.role === "user" ? "user" : "unknown";
      const content = stringValue(item.content);
      return content ? `${role}: ${content}` : null;
    })
    .filter((line): line is string => Boolean(line));
  return lines.length ? lines.join("\n") : null;
}

function transcriptHasUser(contents: unknown, transcript: string | null): boolean {
  if (Array.isArray(contents)) {
    return contents
      .filter(isRecord)
      .some((item) => item.role === "user" && typeof item.content === "string" && item.content.trim());
  }
  return Boolean(transcript && /(?:^|\n)user\s*:/i.test(transcript));
}

function mapAgoraProgressStatus(eventType: number, state?: string): CallRunStatus | null {
  if (eventType !== 201 && eventType !== 202) return null;
  switch (state) {
    case "START":
    case "CALLING":
      return "dialing";
    case "RINGING":
      return "ringing";
    case "ANSWERED":
      return "in_progress";
    default:
      return null;
  }
}

function errorSummary(payload: JsonRecord): string {
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  const messages = errors
    .map((item) => {
      const moduleName = stringValue(item.module);
      const message = stringValue(item.message);
      return [moduleName, message].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  return messages.join("; ") || stringValue(payload.message) || "Agora agent error";
}

export function handleAgoraWebhook(payload: AgoraWebhookPayload): {
  request_id: string;
  run_id: string;
  outcome: CallResultOutcome | null;
  summary: string | null;
} | null {
  const agentId = stringValue(payload.payload.agent_id);
  const match = findRunByAgoraAgentId(agentId);
  if (!match) return null;

  const run = getCallRun(match.runId);
  const request = getCallRequest(match.requestId);
  if (!run || !request) return null;

  if (payload.eventType === 103) {
    const transcript = formatAgoraTranscript(payload.payload.contents);
    const answered = transcriptHasUser(payload.payload.contents, transcript);
    const outcome: CallResultOutcome = answered ? "answered" : "no_answer";
    const runStatus: CallRunStatus = answered ? "completed" : "no_answer";
    const summary = answered ? "Call completed via Agora." : "Call ended without user transcript.";

    updateCallRunStatus(run.id, runStatus);
    updateCallRequestStatus(request.id, answered ? "completed" : "failed");

    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: answered ? "run.completed" : "run.failed",
      status: runStatus,
      message: summary,
      payload_json: {
        notice_id: payload.noticeId,
        event_type: payload.eventType,
        agent_id: agentId,
        channel: stringValue(payload.payload.channel),
      },
      source: "prox.calls.webhook.agora",
    });

    const result = createCallResult({
      request_id: request.id,
      run_id: run.id,
      outcome,
      summary,
      transcript,
      extraction_json: {
        provider: "agora",
        event_type: payload.eventType,
        notice_id: payload.noticeId,
        sid: payload.sid,
        labels: isRecord(payload.payload.labels) ? payload.payload.labels : null,
      },
      next_action: answered ? "none" : "retry",
    });

    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "result.created",
      status: outcome,
      message: summary,
      source: "prox.calls.webhook.agora",
    });
    notifyCallOrigin(request, result, "prox.calls.webhook.agora");
    return { request_id: request.id, run_id: run.id, outcome, summary };
  }

  if (payload.eventType === 110) {
    const summary = errorSummary(payload.payload);
    updateCallRunStatus(run.id, "failed", { failure_reason: summary });
    updateCallRequestStatus(request.id, "failed");
    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "run.failed",
      status: "failed",
      message: summary,
      payload_json: {
        notice_id: payload.noticeId,
        event_type: payload.eventType,
        agent_id: agentId,
      },
      source: "prox.calls.webhook.agora",
    });
    const result = createCallResult({
      request_id: request.id,
      run_id: run.id,
      outcome: "failed_provider",
      summary,
      extraction_json: {
        provider: "agora",
        event_type: payload.eventType,
        notice_id: payload.noticeId,
      },
      next_action: "retry",
    });
    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "result.created",
      status: "failed_provider",
      message: summary,
      source: "prox.calls.webhook.agora",
    });
    notifyCallOrigin(request, result, "prox.calls.webhook.agora");
    return { request_id: request.id, run_id: run.id, outcome: "failed_provider", summary };
  }

  const state = stringValue(payload.payload.state);
  const status = mapAgoraProgressStatus(payload.eventType, state);
  if (status) {
    updateCallRunStatus(run.id, status);
  }
  createCallEvent({
    request_id: request.id,
    run_id: run.id,
    event_type: "run.progress",
    status: status ?? state ?? `event_${payload.eventType}`,
    message: `Agora event ${payload.eventType}${state ? `: ${state}` : ""}`,
    payload_json: {
      notice_id: payload.noticeId,
      event_type: payload.eventType,
      agent_id: agentId,
      state,
      channel: stringValue(payload.payload.channel),
    },
    source: "prox.calls.webhook.agora",
  });
  return { request_id: request.id, run_id: run.id, outcome: null, summary: null };
}

function safeCompareHex(expectedHex: string, actualHex: string): boolean {
  if (!expectedHex || !actualHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function verifyAgoraWebhookSignature(
  rawBody: string,
  secret: string,
  signature?: string | null,
  version = 2,
): boolean {
  const algorithm = version === 1 ? "sha1" : "sha256";
  const expected = createHmac(algorithm, secret).update(rawBody).digest("hex");
  return safeCompareHex(expected, signature ?? "");
}
