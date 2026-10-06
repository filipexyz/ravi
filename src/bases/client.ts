// Typed client for the Console Bases CLI API. Transport only: the Console owns
// authorization, view policy, filter compilation, and validation. This module
// never evaluates a filter or an access rule.

import { randomUUID } from "node:crypto";
import { ConsoleApiClient, normalizeConsoleUrl, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { getContext, hasRuntimeInvocationContext } from "../cli/context.js";
import { resolveConsoleProjectRef, type ConsoleScopeResolverDeps } from "../console-scope/resolver.js";
import type {
  BaseAggregateResponse,
  BaseAnyView,
  BaseChart,
  BaseChartDataResponse,
  BaseDetail,
  BasePropertyMutationResponse,
  BaseQueryResponse,
  BaseRowBatchWriteResponse,
  BaseRowHistoryResponse,
  BaseRowPurgeResponse,
  BaseRowWriteResponse,
  BaseSubscription,
  BaseSummary,
  BaseView,
  BaseViewDescribe,
} from "./schemas.js";

export const BASES_READ_SCOPE = "console.bases.read";
export const BASES_WRITE_SCOPE = "console.bases.write";
export const BASES_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type BasesJsonObject = Record<string, unknown>;

/** Untrusted metadata stored in the row ledger. Never used for authorization. */
export interface BasesClientHint {
  agentId?: string;
  sessionKey?: string;
  sdk: string;
}

export interface BasesClientDeps extends ConsoleScopeResolverDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  newIdempotencyKey?: () => string;
  clientHint?: () => BasesClientHint | null;
}

export interface BasesClientOptions {
  console?: string;
  project?: string;
}

export interface BasesWriteOptions {
  idempotencyKey?: string;
}

export interface BasesWriteResult<T> {
  response: T;
  idempotencyKey: string;
}

export interface BasesPage {
  cursor?: string | null;
  limit?: number;
}

/** Hint sent with row writes when the CLI runs inside an agent session. */
export function currentBasesClientHint(): BasesClientHint | null {
  if (!hasRuntimeInvocationContext()) return null;
  const context = getContext();
  const agentId = text(context?.agentId);
  const sessionKey = text(context?.sessionKey) ?? text(context?.sessionName);
  if (!agentId && !sessionKey) return null;
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    sdk: context?.transport === "gateway" ? "ravi-sdk-gateway" : "ravi-cli",
  };
}

export function newBasesIdempotencyKey(): string {
  return `ravi-cli:${randomUUID()}`;
}

export function assertBasesIdempotencyKey(value: string, label = "--idempotency-key"): string {
  const key = value.trim();
  if (!BASES_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `${label} must be 8-128 characters of letters, digits, '.', '_', ':', '-', starting with a letter or digit.`,
    );
  }
  return key;
}

/** Scopes the stored credentials lack. Empty when the credentials do not record scopes. */
export function missingBasesScopes(
  credentials: Pick<CloudCredentials, "scopes"> | null | undefined,
  required: readonly string[] = [BASES_READ_SCOPE, BASES_WRITE_SCOPE],
): string[] {
  const scopes = credentials?.scopes ?? [];
  if (scopes.length === 0) return [];
  const granted = new Set(scopes);
  return required.filter((scope) => !granted.has(scope));
}

export function basesApiRoot(projectRef: string): string {
  return `/api/cli/projects/${encodeURIComponent(projectRef)}/bases`;
}

export class RaviBasesClient {
  private credentials: CloudCredentials;

  constructor(
    private readonly session: {
      client: ConsoleApiClient;
      credentials: CloudCredentials;
      projectRef: string;
      write: (credentials: CloudCredentials) => void;
      delete: () => void;
      newIdempotencyKey: () => string;
      clientHint: () => BasesClientHint | null;
    },
  ) {
    this.credentials = session.credentials;
  }

  get projectRef(): string {
    return this.session.projectRef;
  }

  get consoleUrl(): string {
    return this.credentials.consoleUrl;
  }

  get scopes(): string[] {
    return [...(this.credentials.scopes ?? [])];
  }

  // Bases

  async listBases(options: { includeArchived?: boolean } = {}): Promise<{ bases: BaseSummary[] }> {
    const payload = await this.request<{ bases?: BaseSummary[] }>(
      "GET",
      withQuery("", { includeArchived: options.includeArchived ? "1" : undefined }),
    );
    return { bases: Array.isArray(payload.bases) ? payload.bases : [] };
  }

  createBase(input: BasesJsonObject): Promise<BaseDetail> {
    return this.request("POST", "", input);
  }

  getBase(baseRef: string): Promise<BaseDetail> {
    return this.request("GET", basePath(baseRef));
  }

  updateBase(baseRef: string, input: BasesJsonObject): Promise<BaseSummary> {
    return this.request("PATCH", basePath(baseRef), input);
  }

  setBaseArchived(baseRef: string, archived: boolean, expectedVersion: number): Promise<BaseSummary> {
    return this.request("POST", `${basePath(baseRef)}/${archived ? "archive" : "restore"}`, { expectedVersion });
  }

  // Properties

  createProperty(baseRef: string, input: BasesJsonObject): Promise<BasePropertyMutationResponse> {
    return this.request("POST", `${basePath(baseRef)}/properties`, input);
  }

  updateProperty(baseRef: string, propRef: string, input: BasesJsonObject): Promise<BasePropertyMutationResponse> {
    return this.request("PATCH", propertyPath(baseRef, propRef), input);
  }

  deleteProperty(
    baseRef: string,
    propRef: string,
    input: { expectedSchemaVersion: number; confirm?: boolean },
  ): Promise<BasePropertyMutationResponse> {
    return this.request("POST", `${propertyPath(baseRef, propRef)}/delete`, input);
  }

  restoreProperty(
    baseRef: string,
    propRef: string,
    input: { expectedSchemaVersion: number },
  ): Promise<BasePropertyMutationResponse> {
    return this.request("POST", `${propertyPath(baseRef, propRef)}/restore`, input);
  }

  // Rows (direct)

  queryRows(baseRef: string, query: BasesJsonObject): Promise<BaseQueryResponse> {
    return this.request("POST", `${basePath(baseRef)}/rows/query`, query);
  }

  aggregateRows(baseRef: string, request: BasesJsonObject): Promise<BaseAggregateResponse> {
    return this.request("POST", `${basePath(baseRef)}/rows/aggregate`, request);
  }

  createRow(
    baseRef: string,
    input: { values: BasesJsonObject; body?: string | null },
    options: BasesWriteOptions = {},
  ): Promise<BasesWriteResult<BaseRowWriteResponse>> {
    return this.idempotentWrite("POST", `${basePath(baseRef)}/rows`, input, options);
  }

  createRows(
    baseRef: string,
    rows: Array<{ values: BasesJsonObject; body?: string | null }>,
    options: BasesWriteOptions = {},
  ): Promise<BasesWriteResult<BaseRowBatchWriteResponse>> {
    return this.idempotentWrite("POST", `${basePath(baseRef)}/rows`, { rows }, options);
  }

  getRow(baseRef: string, rowId: string, options: { includeArchived?: boolean } = {}): Promise<BaseRowWriteResponse> {
    return this.request(
      "GET",
      withQuery(rowPath(baseRef, rowId), { includeArchived: options.includeArchived ? "1" : undefined }),
    );
  }

  updateRow(
    baseRef: string,
    rowId: string,
    input: BasesRowUpdateInput,
    options: BasesWriteOptions = {},
  ): Promise<BasesWriteResult<BaseRowWriteResponse>> {
    return this.idempotentWrite("PATCH", rowPath(baseRef, rowId), input, options);
  }

  setRowArchived(
    baseRef: string,
    rowId: string,
    archived: boolean,
    input: BasesRowLifecycleInput,
  ): Promise<BaseRowWriteResponse> {
    return this.request("POST", `${rowPath(baseRef, rowId)}/${archived ? "archive" : "restore"}`, this.withHint(input));
  }

  purgeRow(baseRef: string, rowId: string): Promise<BaseRowPurgeResponse> {
    return this.request("POST", `${rowPath(baseRef, rowId)}/purge`, { confirm: true });
  }

  rowHistory(baseRef: string, rowId: string, page: BasesPage = {}): Promise<BaseRowHistoryResponse> {
    return this.request("GET", withQuery(`${rowPath(baseRef, rowId)}/history`, pageQuery(page)));
  }

  // Views

  async listViews(baseRef: string): Promise<{ views: BaseAnyView[] }> {
    const payload = await this.request<{ views?: BaseAnyView[] }>("GET", `${basePath(baseRef)}/views`);
    return { views: Array.isArray(payload.views) ? payload.views : [] };
  }

  createView(baseRef: string, input: BasesJsonObject): Promise<BaseView> {
    return this.request("POST", `${basePath(baseRef)}/views`, input);
  }

  getView(baseRef: string, viewId: string): Promise<BaseViewDescribe> {
    return this.request("GET", viewPath(baseRef, viewId));
  }

  updateView(baseRef: string, viewId: string, input: BasesJsonObject): Promise<BaseView> {
    return this.request("PATCH", viewPath(baseRef, viewId), input);
  }

  archiveView(baseRef: string, viewId: string, expectedVersion: number): Promise<BaseView> {
    return this.request("POST", `${viewPath(baseRef, viewId)}/archive`, { expectedVersion });
  }

  queryView(baseRef: string, viewId: string, query: BasesJsonObject): Promise<BaseQueryResponse> {
    return this.request("POST", `${viewPath(baseRef, viewId)}/query`, query);
  }

  createViewRow(
    baseRef: string,
    viewId: string,
    input: { values: BasesJsonObject; body?: string | null },
    options: BasesWriteOptions = {},
  ): Promise<BasesWriteResult<BaseRowWriteResponse>> {
    return this.idempotentWrite("POST", `${viewPath(baseRef, viewId)}/rows`, input, options);
  }

  getViewRow(baseRef: string, viewId: string, rowId: string): Promise<BaseRowWriteResponse> {
    return this.request("GET", viewRowPath(baseRef, viewId, rowId));
  }

  updateViewRow(
    baseRef: string,
    viewId: string,
    rowId: string,
    input: BasesRowUpdateInput,
    options: BasesWriteOptions = {},
  ): Promise<BasesWriteResult<BaseRowWriteResponse>> {
    return this.idempotentWrite("PATCH", viewRowPath(baseRef, viewId, rowId), input, options);
  }

  archiveViewRow(
    baseRef: string,
    viewId: string,
    rowId: string,
    input: BasesRowLifecycleInput,
  ): Promise<BaseRowWriteResponse> {
    return this.request("POST", `${viewRowPath(baseRef, viewId, rowId)}/archive`, this.withHint(input));
  }

  viewRowHistory(
    baseRef: string,
    viewId: string,
    rowId: string,
    page: BasesPage = {},
  ): Promise<BaseRowHistoryResponse> {
    return this.request("GET", withQuery(`${viewRowPath(baseRef, viewId, rowId)}/history`, pageQuery(page)));
  }

  // Charts

  async listCharts(baseRef: string): Promise<{ charts: BaseChart[] }> {
    const payload = await this.request<{ charts?: BaseChart[] }>("GET", `${basePath(baseRef)}/charts`);
    return { charts: Array.isArray(payload.charts) ? payload.charts : [] };
  }

  createChart(baseRef: string, input: BasesJsonObject): Promise<BaseChart> {
    return this.request("POST", `${basePath(baseRef)}/charts`, input);
  }

  getChart(baseRef: string, chartId: string): Promise<BaseChart> {
    return this.request("GET", chartPath(baseRef, chartId));
  }

  updateChart(baseRef: string, chartId: string, input: BasesJsonObject): Promise<BaseChart> {
    return this.request("PATCH", chartPath(baseRef, chartId), input);
  }

  archiveChart(baseRef: string, chartId: string, expectedVersion: number): Promise<BaseChart> {
    return this.request("POST", `${chartPath(baseRef, chartId)}/archive`, { expectedVersion });
  }

  chartData(baseRef: string, chartId: string): Promise<BaseChartDataResponse> {
    return this.request("POST", `${chartPath(baseRef, chartId)}/data`, {});
  }

  // Subscriptions

  async listSubscriptions(baseRef: string): Promise<{ subscriptions: BaseSubscription[] }> {
    const payload = await this.request<{ subscriptions?: BaseSubscription[] }>(
      "GET",
      `${basePath(baseRef)}/subscriptions`,
    );
    return { subscriptions: Array.isArray(payload.subscriptions) ? payload.subscriptions : [] };
  }

  subscribe(baseRef: string): Promise<BaseSubscription> {
    return this.request("POST", `${basePath(baseRef)}/subscriptions`, {});
  }

  unsubscribe(baseRef: string, subscriptionId: string): Promise<BaseSubscription> {
    return this.request("POST", `${basePath(baseRef)}/subscriptions/${encodeURIComponent(subscriptionId)}/revoke`, {});
  }

  // Transport

  private async idempotentWrite<T>(
    method: string,
    path: string,
    body: BasesJsonObject,
    options: BasesWriteOptions,
  ): Promise<BasesWriteResult<T>> {
    const idempotencyKey = options.idempotencyKey
      ? assertBasesIdempotencyKey(options.idempotencyKey)
      : this.session.newIdempotencyKey();
    const response = await this.request<T>(method, path, this.withHint({ ...body, idempotencyKey }), {
      "Idempotency-Key": idempotencyKey,
    });
    return { response, idempotencyKey };
  }

  private withHint<T extends object>(body: T): T & { clientHint?: BasesClientHint } {
    const hint = this.session.clientHint();
    return hint ? { ...body, clientHint: hint } : body;
  }

  private async request<T>(
    method: string,
    relativePath: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const path = `${basesApiRoot(this.session.projectRef)}${relativePath}`;
    try {
      return await this.session.client.requestJson<T>(method, path, body, this.credentials.accessToken, headers);
    } catch (error) {
      if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
    }
    this.credentials = await refreshCredentialsForStore({
      client: this.session.client,
      credentials: this.credentials,
      write: this.session.write,
      delete: this.session.delete,
    });
    return this.session.client.requestJson<T>(method, path, body, this.credentials.accessToken, headers);
  }
}

export type BasesRowUpdateInput = {
  values?: BasesJsonObject;
  body?: string | null;
  expectedVersion?: number;
  lastWriteWins?: boolean;
};

export type BasesRowLifecycleInput = {
  expectedVersion?: number;
  lastWriteWins?: boolean;
};

/** Read stored credentials, resolve the Console project, and bind a client to it. */
export async function openBasesClient(
  options: BasesClientOptions = {},
  deps: BasesClientDeps = {},
): Promise<RaviBasesClient> {
  const readCredentials = deps.readCredentials ?? readCloudCredentials;
  const credentials = requireStoredCredentials(readCredentials(), options.console);
  const { projectRef } = await resolveConsoleProjectRef(
    { consoleUrl: options.console, explicitProject: options.project ?? null },
    { ...deps, readCredentials },
  );
  return new RaviBasesClient({
    client: deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl }),
    credentials,
    projectRef,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
    newIdempotencyKey: deps.newIdempotencyKey ?? newBasesIdempotencyKey,
    clientHint: deps.clientHint ?? currentBasesClientHint,
  });
}

function requireStoredCredentials(credentials: CloudCredentials | null, consoleUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    const normalized = normalizeConsoleUrl(consoleUrl);
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalized}. Run \`ravi login --console ${normalized}\`.`,
    );
  }
  return credentials;
}

function basePath(baseRef: string): string {
  return `/${encodeURIComponent(requireRef(baseRef, "base"))}`;
}

function propertyPath(baseRef: string, propRef: string): string {
  return `${basePath(baseRef)}/properties/${encodeURIComponent(requireRef(propRef, "property"))}`;
}

function rowPath(baseRef: string, rowId: string): string {
  return `${basePath(baseRef)}/rows/${encodeURIComponent(requireRef(rowId, "row"))}`;
}

function viewPath(baseRef: string, viewId: string): string {
  return `${basePath(baseRef)}/views/${encodeURIComponent(requireRef(viewId, "view"))}`;
}

function viewRowPath(baseRef: string, viewId: string, rowId: string): string {
  return `${viewPath(baseRef, viewId)}/rows/${encodeURIComponent(requireRef(rowId, "row"))}`;
}

function chartPath(baseRef: string, chartId: string): string {
  return `${basePath(baseRef)}/charts/${encodeURIComponent(requireRef(chartId, "chart"))}`;
}

function requireRef(value: string, label: string): string {
  const ref = value?.trim();
  if (!ref) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label} reference.`);
  return ref;
}

function pageQuery(page: BasesPage): Record<string, string | undefined> {
  return {
    cursor: page.cursor ?? undefined,
    limit: page.limit !== undefined ? String(page.limit) : undefined,
  };
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
