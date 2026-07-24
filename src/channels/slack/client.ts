import { Buffer } from "node:buffer";
import type { SlackBlockKitBlock } from "./block-kit.js";

export interface SlackWebApiClientOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface SlackPostMessageInput {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly clientMsgId?: string;
  readonly blocks?: readonly SlackBlockKitBlock[];
  readonly metadata?: Record<string, unknown>;
}

export interface SlackPostEphemeralInput extends SlackPostMessageInput {
  readonly user: string;
}

export interface SlackUpdateMessageInput {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly blocks?: readonly SlackBlockKitBlock[];
}

export interface SlackDeleteMessageInput {
  readonly channel: string;
  readonly ts: string;
}

export interface SlackChatUnfurlInput {
  readonly channel?: string;
  readonly ts?: string;
  readonly unfurlId?: string;
  readonly source?: string;
  readonly unfurls?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface SlackEntityPresentDetailsInput {
  readonly triggerId: string;
  readonly metadata?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
  readonly userAuthRequired?: boolean;
  readonly userAuthUrl?: string;
}

export interface SlackBlocksValidateInput {
  readonly blocks?: readonly SlackBlockKitBlock[];
  readonly message?: Record<string, unknown>;
  readonly view?: Record<string, unknown>;
}

export interface SlackReactionInput {
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
}

export interface SlackAssistantThreadStatusInput {
  readonly channelId: string;
  readonly threadTs: string;
  readonly status: string;
  readonly loadingMessages?: readonly string[];
}

export interface SlackPostMessageResult {
  readonly channel: string;
  readonly ts: string;
  readonly messageId: string;
  readonly raw: Record<string, unknown>;
}

export interface SlackDownloadFileInput {
  readonly url: string;
  readonly maxBytes?: number;
}

export interface SlackDownloadFileResult {
  readonly buffer: Buffer;
  readonly contentType?: string;
}

export interface SlackAuthTestResponse extends SlackApiResponse {
  readonly url?: string;
  readonly team?: string;
  readonly user?: string;
  readonly team_id?: string;
  readonly user_id?: string;
  readonly bot_id?: string;
  readonly scopes?: string[];
  readonly acceptedScopes?: string[];
}

export interface SlackConversationListInput {
  readonly types?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly excludeArchived?: boolean;
}

export interface SlackConversationInfoInput {
  readonly channel: string;
}

export interface SlackConversationHistoryInput {
  readonly channel: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly latest?: string;
  readonly oldest?: string;
  readonly inclusive?: boolean;
}

export interface SlackConversationMembersInput {
  readonly channel: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SlackConversationCreateInput {
  readonly name: string;
  readonly isPrivate?: boolean;
}

export interface SlackConversationRenameInput {
  readonly channel: string;
  readonly name: string;
}

export interface SlackConversationInviteInput {
  readonly channel: string;
  readonly userIds: readonly string[];
}

export interface SlackFilesListInput {
  readonly channel?: string;
  readonly user?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly tsFrom?: string;
  readonly tsTo?: string;
}

export interface SlackFileInfoInput {
  readonly file: string;
}

export interface SlackCanvasCreateInput {
  readonly title?: string;
  readonly markdown?: string;
  readonly channelId?: string;
}

export interface SlackConversationCanvasCreateInput {
  readonly channelId: string;
  readonly title?: string;
  readonly markdown?: string;
}

export type SlackCanvasEditOperation =
  | "insert_after"
  | "insert_before"
  | "insert_at_start"
  | "insert_at_end"
  | "replace"
  | "delete"
  | "rename";

export interface SlackCanvasEditChange {
  readonly operation: SlackCanvasEditOperation;
  readonly sectionId?: string;
  readonly markdown?: string;
  readonly title?: string;
}

export interface SlackCanvasEditInput {
  readonly canvasId: string;
  readonly changes: readonly SlackCanvasEditChange[];
}

export interface SlackCanvasSectionsLookupInput {
  readonly canvasId: string;
  readonly sectionTypes?: readonly string[];
  readonly containsText?: string;
}

export type SlackCanvasAccessLevel = "read" | "write" | "owner";

export interface SlackCanvasAccessInput {
  readonly canvasId: string;
  readonly userIds?: readonly string[];
  readonly channelIds?: readonly string[];
}

export interface SlackCanvasAccessSetInput extends SlackCanvasAccessInput {
  readonly accessLevel: SlackCanvasAccessLevel;
}

export interface SlackCanvasDeleteInput {
  readonly canvasId: string;
}

export interface SlackApiResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

interface SlackConnectionsOpenResponse extends SlackApiResponse {
  readonly url?: string;
}

interface SlackPostMessageResponse extends SlackApiResponse {
  readonly channel?: string;
  readonly ts?: string;
}

export interface SlackBlocksValidateResponse extends SlackApiResponse {
  readonly errors?: unknown[];
  readonly warnings?: unknown[];
  readonly response_metadata?: Record<string, unknown>;
}

export interface SlackViewsOpenInput {
  readonly triggerId: string;
  readonly view: Record<string, unknown>;
}

export interface SlackViewsUpdateInput {
  readonly view: Record<string, unknown>;
  readonly viewId?: string;
  readonly externalId?: string;
  readonly hash?: string;
}

export interface SlackViewsPushInput {
  readonly triggerId: string;
  readonly view: Record<string, unknown>;
}

export interface SlackViewsResponse extends SlackApiResponse {
  readonly view?: Record<string, unknown>;
}

export interface SlackChatUnfurlResponse extends SlackApiResponse {}

export interface SlackEntityPresentDetailsResponse extends SlackApiResponse {}

interface SlackReactionResponse extends SlackApiResponse {}
interface SlackDeleteMessageResponse extends SlackApiResponse {}

interface SlackAssistantThreadStatusResponse extends SlackApiResponse {}

export interface SlackCursorPaging {
  readonly next_cursor?: string;
}

export interface SlackConversationListResponse extends SlackApiResponse {
  readonly channels?: unknown[];
  readonly response_metadata?: SlackCursorPaging;
}

export interface SlackConversationInfoResponse extends SlackApiResponse {
  readonly channel?: unknown;
}

export interface SlackConversationHistoryResponse extends SlackApiResponse {
  readonly messages?: unknown[];
  readonly has_more?: boolean;
  readonly response_metadata?: SlackCursorPaging;
}

export interface SlackConversationMembersResponse extends SlackApiResponse {
  readonly members?: string[];
  readonly response_metadata?: SlackCursorPaging;
}

export interface SlackConversationCreateResponse extends SlackApiResponse {
  readonly channel?: unknown;
}

export interface SlackConversationRenameResponse extends SlackApiResponse {
  readonly channel?: unknown;
}

export interface SlackConversationInviteResponse extends SlackApiResponse {
  readonly channel?: unknown;
}

export interface SlackFilesListResponse extends SlackApiResponse {
  readonly files?: unknown[];
  readonly paging?: unknown;
  readonly response_metadata?: SlackCursorPaging;
}

export interface SlackFileInfoResponse extends SlackApiResponse {
  readonly file?: unknown;
}

export interface SlackCanvasCreateResponse extends SlackApiResponse {
  readonly canvas_id?: string;
  readonly canvas?: unknown;
}

export interface SlackCanvasEditResponse extends SlackApiResponse {
  readonly canvas?: unknown;
}

export interface SlackCanvasSectionsLookupResponse extends SlackApiResponse {
  readonly sections?: unknown[];
}

export interface SlackCanvasAccessResponse extends SlackApiResponse {}

export interface SlackCanvasDeleteResponse extends SlackApiResponse {}

export class SlackWebApiClient {
  private readonly appToken: string;
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackWebApiClientOptions) {
    this.appToken = options.appToken;
    this.botToken = options.botToken;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://slack.com/api";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async openSocketConnection(): Promise<string> {
    const response = await this.apiRequest<SlackConnectionsOpenResponse>("apps.connections.open", this.appToken, {});
    if (!response.url) {
      throw new Error("Slack apps.connections.open did not return a WebSocket URL");
    }
    return response.url;
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = {
      channel: input.channel,
      text: input.text,
    };
    if (input.threadTs) {
      body.thread_ts = input.threadTs;
    }
    if (input.clientMsgId) {
      body.client_msg_id = input.clientMsgId;
    }
    if (input.blocks) {
      body.blocks = JSON.stringify(input.blocks);
    }
    if (input.metadata) {
      body.metadata = JSON.stringify(input.metadata);
    }

    const response = await this.apiRequest<SlackPostMessageResponse>("chat.postMessage", this.botToken, body);
    if (!response.channel || !response.ts) {
      throw new Error("Slack chat.postMessage did not return channel and ts");
    }

    return {
      channel: response.channel,
      ts: response.ts,
      messageId: response.ts,
      raw: response,
    };
  }

  async postEphemeral(input: SlackPostEphemeralInput): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = {
      channel: input.channel,
      user: input.user,
      text: input.text,
    };
    if (input.threadTs) {
      body.thread_ts = input.threadTs;
    }
    if (input.blocks) {
      body.blocks = JSON.stringify(input.blocks);
    }

    const response = await this.apiRequest<SlackPostMessageResponse>("chat.postEphemeral", this.botToken, body);
    const ts = typeof response.message_ts === "string" ? response.message_ts : response.ts;
    if (!ts) {
      throw new Error("Slack chat.postEphemeral did not return message_ts");
    }

    return {
      channel: input.channel,
      ts,
      messageId: ts,
      raw: response,
    };
  }

  async updateMessage(input: SlackUpdateMessageInput): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
    };
    if (input.blocks) {
      body.blocks = JSON.stringify(input.blocks);
    }

    const response = await this.apiRequest<SlackPostMessageResponse>("chat.update", this.botToken, body);
    if (!response.channel || !response.ts) {
      throw new Error("Slack chat.update did not return channel and ts");
    }

    return {
      channel: response.channel,
      ts: response.ts,
      messageId: response.ts,
      raw: response,
    };
  }

  async deleteMessage(input: SlackDeleteMessageInput): Promise<Record<string, unknown>> {
    return this.apiRequest<SlackDeleteMessageResponse>(
      "chat.delete",
      this.botToken,
      {
        channel: input.channel,
        ts: input.ts,
      },
      { okErrors: ["message_not_found"] },
    );
  }

  async unfurl(input: SlackChatUnfurlInput): Promise<SlackChatUnfurlResponse> {
    const body = compactBody({
      channel: input.channel,
      ts: input.ts,
      unfurl_id: input.unfurlId,
      source: input.source,
      unfurls: input.unfurls ? JSON.stringify(input.unfurls) : undefined,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
    });
    return this.apiRequest<SlackChatUnfurlResponse>("chat.unfurl", this.botToken, body);
  }

  async entityPresentDetails(input: SlackEntityPresentDetailsInput): Promise<SlackEntityPresentDetailsResponse> {
    const body = compactBody({
      trigger_id: input.triggerId,
      metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
      error: input.error ? JSON.stringify(input.error) : undefined,
      user_auth_required: input.userAuthRequired,
      user_auth_url: input.userAuthUrl,
    });
    return this.apiRequest<SlackEntityPresentDetailsResponse>("entity.presentDetails", this.botToken, body);
  }

  async blocksValidate(input: SlackBlocksValidateInput): Promise<SlackBlocksValidateResponse> {
    const selected = [input.blocks !== undefined, input.message !== undefined, input.view !== undefined].filter(
      Boolean,
    );
    if (selected.length !== 1) {
      throw new Error("Slack blocks.validate requires exactly one of blocks, message or view");
    }

    return this.apiRequest<SlackBlocksValidateResponse>(
      "blocks.validate",
      this.botToken,
      compactBody({
        blocks: input.blocks ? JSON.stringify(input.blocks) : undefined,
        message: input.message ? JSON.stringify(input.message) : undefined,
        view: input.view ? JSON.stringify(input.view) : undefined,
      }),
    );
  }

  async viewsOpen(input: SlackViewsOpenInput): Promise<SlackViewsResponse> {
    return this.apiJsonRequest<SlackViewsResponse>("views.open", this.botToken, {
      trigger_id: input.triggerId,
      view: input.view,
    });
  }

  async viewsUpdate(input: SlackViewsUpdateInput): Promise<SlackViewsResponse> {
    if (!input.viewId && !input.externalId) {
      throw new Error("Slack views.update requires viewId or externalId");
    }
    return this.apiJsonRequest<SlackViewsResponse>(
      "views.update",
      this.botToken,
      compactBody({
        view_id: input.viewId,
        external_id: input.externalId,
        hash: input.hash,
        view: input.view,
      }),
    );
  }

  async viewsPush(input: SlackViewsPushInput): Promise<SlackViewsResponse> {
    return this.apiJsonRequest<SlackViewsResponse>("views.push", this.botToken, {
      trigger_id: input.triggerId,
      view: input.view,
    });
  }

  async authTest(options: { signal?: AbortSignal } = {}): Promise<SlackAuthTestResponse> {
    const { payload, headers } = await this.apiRequestWithHeaders<SlackAuthTestResponse>(
      "auth.test",
      this.botToken,
      {},
      options,
    );
    return {
      ...payload,
      scopes: parseSlackScopeHeader(headers.get("x-oauth-scopes")),
      acceptedScopes: parseSlackScopeHeader(headers.get("x-accepted-oauth-scopes")),
    };
  }

  async addReaction(input: SlackReactionInput): Promise<Record<string, unknown>> {
    return this.apiRequest<SlackReactionResponse>(
      "reactions.add",
      this.botToken,
      {
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
      },
      { okErrors: ["already_reacted"] },
    );
  }

  async removeReaction(input: SlackReactionInput): Promise<Record<string, unknown>> {
    return this.apiRequest<SlackReactionResponse>(
      "reactions.remove",
      this.botToken,
      {
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
      },
      { okErrors: ["no_reaction"] },
    );
  }

  async setAssistantThreadStatus(input: SlackAssistantThreadStatusInput): Promise<Record<string, unknown>> {
    const body = compactBody({
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      loading_messages:
        input.loadingMessages && input.loadingMessages.length > 0 ? JSON.stringify(input.loadingMessages) : undefined,
    });
    body.status = input.status;
    return this.apiRequest<SlackAssistantThreadStatusResponse>("assistant.threads.setStatus", this.botToken, body);
  }

  async conversationsList(input: SlackConversationListInput = {}): Promise<SlackConversationListResponse> {
    return this.apiRequest<SlackConversationListResponse>(
      "conversations.list",
      this.botToken,
      compactBody({
        types: input.types ?? "public_channel,private_channel,im,mpim",
        limit: input.limit,
        cursor: input.cursor,
        exclude_archived: input.excludeArchived,
      }),
    );
  }

  async conversationsInfo(input: SlackConversationInfoInput): Promise<SlackConversationInfoResponse> {
    return this.apiRequest<SlackConversationInfoResponse>("conversations.info", this.botToken, {
      channel: input.channel,
    });
  }

  async conversationsHistory(input: SlackConversationHistoryInput): Promise<SlackConversationHistoryResponse> {
    return this.apiRequest<SlackConversationHistoryResponse>(
      "conversations.history",
      this.botToken,
      compactBody({
        channel: input.channel,
        limit: input.limit,
        cursor: input.cursor,
        latest: input.latest,
        oldest: input.oldest,
        inclusive: input.inclusive,
      }),
    );
  }

  async conversationsMembers(input: SlackConversationMembersInput): Promise<SlackConversationMembersResponse> {
    return this.apiRequest<SlackConversationMembersResponse>(
      "conversations.members",
      this.botToken,
      compactBody({
        channel: input.channel,
        limit: input.limit,
        cursor: input.cursor,
      }),
    );
  }

  async conversationsCreate(input: SlackConversationCreateInput): Promise<SlackConversationCreateResponse> {
    return this.apiRequest<SlackConversationCreateResponse>(
      "conversations.create",
      this.botToken,
      compactBody({
        name: input.name,
        is_private: input.isPrivate,
      }),
    );
  }

  async conversationsRename(input: SlackConversationRenameInput): Promise<SlackConversationRenameResponse> {
    return this.apiRequest<SlackConversationRenameResponse>("conversations.rename", this.botToken, {
      channel: input.channel,
      name: input.name,
    });
  }

  async conversationsInvite(input: SlackConversationInviteInput): Promise<SlackConversationInviteResponse> {
    return this.apiRequest<SlackConversationInviteResponse>("conversations.invite", this.botToken, {
      channel: input.channel,
      users: encodeSlackIds(input.userIds),
    });
  }

  async filesList(input: SlackFilesListInput = {}): Promise<SlackFilesListResponse> {
    return this.apiRequest<SlackFilesListResponse>(
      "files.list",
      this.botToken,
      compactBody({
        channel: input.channel,
        user: input.user,
        limit: input.limit,
        cursor: input.cursor,
        ts_from: input.tsFrom,
        ts_to: input.tsTo,
      }),
    );
  }

  async filesInfo(input: SlackFileInfoInput): Promise<SlackFileInfoResponse> {
    return this.apiRequest<SlackFileInfoResponse>("files.info", this.botToken, {
      file: input.file,
    });
  }

  async canvasesCreate(input: SlackCanvasCreateInput): Promise<SlackCanvasCreateResponse> {
    return this.apiJsonRequest<SlackCanvasCreateResponse>(
      "canvases.create",
      this.botToken,
      compactBody({
        title: input.title,
        document_content: slackCanvasDocumentContent(input.markdown),
        channel_id: input.channelId,
      }),
    );
  }

  async conversationsCanvasesCreate(
    input: SlackConversationCanvasCreateInput,
    options: { okErrors?: readonly string[] } = {},
  ): Promise<SlackCanvasCreateResponse> {
    return this.apiJsonRequest<SlackCanvasCreateResponse>(
      "conversations.canvases.create",
      this.botToken,
      compactBody({
        channel_id: input.channelId,
        title: input.title,
        document_content: slackCanvasDocumentContent(input.markdown),
      }),
      options,
    );
  }

  async canvasesEdit(input: SlackCanvasEditInput): Promise<SlackCanvasEditResponse> {
    return this.apiJsonRequest<SlackCanvasEditResponse>("canvases.edit", this.botToken, {
      canvas_id: input.canvasId,
      changes: input.changes.map(slackCanvasEditChange),
    });
  }

  async canvasesSectionsLookup(input: SlackCanvasSectionsLookupInput): Promise<SlackCanvasSectionsLookupResponse> {
    return this.apiJsonRequest<SlackCanvasSectionsLookupResponse>(
      "canvases.sections.lookup",
      this.botToken,
      compactBody({
        canvas_id: input.canvasId,
        criteria: compactBody({
          section_types: input.sectionTypes,
          contains_text: input.containsText,
        }),
      }),
    );
  }

  async canvasesAccessSet(input: SlackCanvasAccessSetInput): Promise<SlackCanvasAccessResponse> {
    return this.apiJsonRequest<SlackCanvasAccessResponse>(
      "canvases.access.set",
      this.botToken,
      slackCanvasAccessBody({
        canvasId: input.canvasId,
        accessLevel: input.accessLevel,
        userIds: input.userIds,
        channelIds: input.channelIds,
      }),
    );
  }

  async canvasesAccessDelete(input: SlackCanvasAccessInput): Promise<SlackCanvasAccessResponse> {
    return this.apiJsonRequest<SlackCanvasAccessResponse>(
      "canvases.access.delete",
      this.botToken,
      slackCanvasAccessBody({
        canvasId: input.canvasId,
        userIds: input.userIds,
        channelIds: input.channelIds,
      }),
    );
  }

  async canvasesDelete(input: SlackCanvasDeleteInput): Promise<SlackCanvasDeleteResponse> {
    return this.apiJsonRequest<SlackCanvasDeleteResponse>("canvases.delete", this.botToken, {
      canvas_id: input.canvasId,
    });
  }

  async downloadFile(input: SlackDownloadFileInput): Promise<SlackDownloadFileResult> {
    const res = await this.fetchImpl(input.url, {
      headers: {
        authorization: `Bearer ${this.botToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Slack file download failed: ${res.status} ${res.statusText}`);
    }

    const maxBytes = input.maxBytes;
    const contentLength = Number(res.headers.get("content-length"));
    if (maxBytes && Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Slack file download exceeded max size: ${contentLength}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    if (maxBytes && arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Slack file download exceeded max size: ${arrayBuffer.byteLength}`);
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  private async apiRequest<T extends SlackApiResponse>(
    method: string,
    token: string,
    body: Record<string, unknown>,
    options: { okErrors?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { payload } = await this.apiRequestWithHeaders<T>(method, token, body, options);
    return payload;
  }

  private async apiJsonRequest<T extends SlackApiResponse>(
    method: string,
    token: string,
    body: Record<string, unknown>,
    options: { okErrors?: readonly string[] } = {},
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    const payload = (await res.json()) as T;
    if (!res.ok || payload.ok !== true) {
      const error = payload.error ?? `${res.status} ${res.statusText}`;
      if (payload.ok === false && options.okErrors?.includes(error)) {
        return payload;
      }
      throw new Error(`Slack ${method} failed: ${formatSlackApiError(payload, error)}`);
    }
    return payload;
  }

  private async apiRequestWithHeaders<T extends SlackApiResponse>(
    method: string,
    token: string,
    body: Record<string, unknown>,
    options: { okErrors?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<{ payload: T; headers: Headers }> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: encodeSlackFormBody(body),
      signal: options.signal,
    });

    const payload = (await res.json()) as T;
    if (!res.ok || payload.ok !== true) {
      const error = payload.error ?? `${res.status} ${res.statusText}`;
      if (payload.ok === false && options.okErrors?.includes(error)) {
        return { payload, headers: res.headers };
      }
      throw new Error(`Slack ${method} failed: ${formatSlackApiError(payload, error)}`);
    }
    return { payload, headers: res.headers };
  }
}

function compactBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== "") body[key] = value;
  }
  return body;
}

function encodeSlackIds(ids: readonly string[] | undefined): string | undefined {
  const cleaned = ids?.map((id) => id.trim()).filter(Boolean);
  return cleaned && cleaned.length > 0 ? cleaned.join(",") : undefined;
}

function encodeSlackFormBody(body: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params;
}

function slackCanvasDocumentContent(markdown: string | undefined): Record<string, string> | undefined {
  if (!markdown?.trim()) return undefined;
  return { type: "markdown", markdown };
}

function slackCanvasEditChange(input: SlackCanvasEditChange): Record<string, unknown> {
  return compactBody({
    operation: input.operation,
    section_id: input.sectionId,
    document_content: slackCanvasDocumentContent(input.markdown),
    title_content: input.title ? { type: "markdown", markdown: input.title } : undefined,
  });
}

function slackCanvasAccessBody(input: {
  readonly canvasId: string;
  readonly accessLevel?: SlackCanvasAccessLevel;
  readonly userIds?: readonly string[];
  readonly channelIds?: readonly string[];
}): Record<string, unknown> {
  return compactBody({
    canvas_id: input.canvasId,
    access_level: input.accessLevel,
    user_ids: input.userIds,
    channel_ids: input.channelIds,
  });
}

function formatSlackApiError(payload: SlackApiResponse, error: string): string {
  const details = ["needed", "provided"]
    .map((key) => {
      const value = payload[key];
      return typeof value === "string" && value ? `${key}=${value}` : undefined;
    })
    .filter(Boolean);
  return details.length > 0 ? `${error} (${details.join(" ")})` : error;
}

function parseSlackScopeHeader(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}
