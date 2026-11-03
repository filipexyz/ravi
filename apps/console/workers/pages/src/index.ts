import {
  handlePageChatRequest,
  injectPageChatHeadShim,
  pageChatPaths,
  type PageChatDurableObjectNamespace,
} from "./page-chat";
import {
  handleChatRoomRequest,
  isChatRoomPath,
  pagesAuthStartUrl,
  parsedChatOrigin,
  type ChatRoomDurableObjectNamespace,
} from "./chat-room";
import { chatDockSnippet, containsRaviChatTag, replaceRaviChatTags } from "./chat-panel";
import { pagesAiEnabled } from "./ai-policy";

export { PageChatSession } from "./page-chat";
export { PageChatRoom } from "./chat-room";

export interface PagesWorkerEnv {
  RAVI_PAGES_HOSTED_DOMAIN?: string;
  RAVI_CONSOLE_API_URL: string;
  RAVI_PAGES_AUTH_START_PATH?: string;
  RAVI_PAGES_AUTH_OPTIONAL_PATH?: string;
  RAVI_PAGES_AUTH_CLAIM_PATH?: string;
  RAVI_PAGES_EDGE_MANIFEST_TTL_SECONDS?: string;
  RAVI_PAGES_OPERATOR_COMMENTS_PATH?: string;
  RAVI_PAGES_OPERATOR_PASSWORD_PATH?: string;
  RAVI_PAGES_OPERATOR_RELEASES_PATH?: string;
  RAVI_PAGES_OPERATOR_VISIBILITY_PATH?: string;
  RAVI_PAGES_CONNECTORS_CATALOG_PATH?: string;
  RAVI_PAGES_CONNECTORS_EXEC_PATH?: string;
  RAVI_PAGES_PASSWORD_VERIFY_PATH?: string;
  RAVI_PAGES_RESOLVE_PATH?: string;
  RAVI_PAGES_USAGE_PATH?: string;
  RAVI_PAGES_USAGE_QUEUE?: PagesUsageQueue;
  RAVI_PAGES_RESERVED_PREFIX?: string;
  RAVI_PAGES_CONTROL_TOKEN?: string;
  RAVI_PAGES_BROWSER?: BrowserRunLike;
  RAVI_PAGES_ASSETS: R2BucketLike;
  RAVI_PAGES_CHAT_SESSION_PATH?: string;
  RAVI_PAGES_CHAT_CLOSE_PATH?: string;
  OPENAI_API_KEY?: string;
  RAVI_PAGE_CHAT_OPENAI_BASE_URL?: string;
  RAVI_PAGE_CHAT_SESSIONS?: PageChatDurableObjectNamespace;
  /** Page chat rooms (text): one Durable Object per room, fanning Console events out to sockets. */
  RAVI_PAGES_CHAT_ROOMS?: ChatRoomDurableObjectNamespace;
  RAVI_PAGES_CHAT_ROOMS_PATH?: string;
  /** Isolated origin for the chat panel iframe (K10); unset = the page's own origin. */
  RAVI_PAGES_CHAT_ORIGIN?: string;
  RAVI_PAGES_AI_ENABLED?: string;
}

type PageVisibility = "public" | "private" | "protected_link" | "password";

interface PagesWorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBody | null>;
  put?(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export interface BrowserRunLike {
  quickAction(action: "screenshot", input: Record<string, unknown>): Promise<Response>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentEncoding?: string;
    contentLanguage?: string;
  };
  customMetadata?: Record<string, string>;
}

interface PagesUsageQueue {
  send(message: PagesUsageQueueMessage): Promise<void>;
}

export interface PagesUsageQueueMessage {
  schemaVersion: 1;
  source: "pages_worker";
  requestId: string;
  enqueuedAt: string;
  events: PagesUsageEvent[];
}

interface PagesUsageQueueMessageLike {
  body: unknown;
}

interface PagesUsageQueueBatch {
  messages: PagesUsageQueueMessageLike[];
}

interface ResolveOkResponse {
  status?: "ok" | "resolved";
  headers?: Record<string, string>;
  site?: {
    id?: string;
    organizationId?: string;
    projectId?: string;
    visibility?: PageVisibility;
  };
  release?: {
    id?: string;
    number?: number;
  };
  route?: {
    id?: string;
    bindingId?: string;
    path?: string;
    matchType?: "exact" | "prefix" | "spa";
    visibility?: PageVisibility;
    browserPermissions?: BrowserPermissions;
  };
  artifact?: {
    id?: string;
    versionId?: string;
    versionNumber?: number;
  };
  object: {
    r2Key: string;
    path?: string;
    assetId?: string | null;
    contentType?: string;
    cache?: "immutable" | "entrypoint" | "html" | "private" | "no-store";
    etag?: string | null;
    sha256?: string | null;
    sizeBytes?: number | null;
  };
  toolbar?: {
    enabled?: boolean;
    host?: string;
    path?: string;
    effectiveVisibility?: PageVisibility;
    siteId?: string;
    projectId?: string;
    routeId?: string;
    releaseId?: string;
    releaseNumber?: number;
    artifactId?: string;
    artifactVersionId?: string;
    artifactVersionNumber?: number;
    pageChat?: {
      enabled?: boolean;
    };
  };
  /** A guest on a route marked for page viewers: a "talk" button only, never the toolbar. */
  guestChat?: {
    enabled?: boolean;
  };
}

interface ResolveStateResponse {
  status?: string;
  error?: string;
  redirect?: {
    location?: string;
  };
}

type ResolveResponse = ResolveOkResponse | ResolveStateResponse;

interface EdgeSiteManifest {
  schemaVersion: 1;
  edgeState: "pending" | "ready" | "failed";
  site: {
    id: string;
    organizationId: string;
    projectId: string;
    defaultHostname: string;
    defaultVisibility: PageVisibility;
    status: "active" | "disabled" | "deleted";
    activeReleaseId: string;
  };
  release: {
    id: string;
    number: number;
    manifestHash?: string | null;
  };
  artifacts?: EdgeManifestArtifact[];
  routes: EdgeManifestRoute[];
}

interface EdgeManifestArtifact {
  id: string;
  versionId: string;
  versionNumber?: number | null;
  files: EdgeManifestFile[];
}

interface EdgeManifestRoute {
  id: string;
  bindingId: string;
  path: string;
  matchType: "exact" | "prefix" | "spa";
  priority: number;
  visibility: PageVisibility;
  browserPermissions?: BrowserPermissions;
  artifact: {
    id: string;
    versionId: string;
    versionNumber?: number | null;
    entrypoint: string;
    assetBase: string;
  };
}

interface BrowserPermissions {
  deviceMotion: "self";
}

interface EdgeManifestFile {
  path: string;
  r2Key: string;
  assetId?: string | null;
  contentType?: string;
  cache?: "immutable" | "entrypoint" | "html" | "private" | "no-store";
  etag?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
}

const DEFAULT_RESERVED_PREFIX = "/_ravi/";
const DEFAULT_AUTH_START_PATH = "/api/pages/auth/start";
const DEFAULT_AUTH_OPTIONAL_PATH = "/api/pages/auth/optional";
const DEFAULT_AUTH_CLAIM_PATH = "/api/internal/pages/auth/claim";
const DEFAULT_OPERATOR_COMMENTS_PATH = "/api/internal/pages/operator/comments";
const DEFAULT_OPERATOR_PASSWORD_PATH = "/api/internal/pages/operator/password";
const DEFAULT_OPERATOR_RELEASES_PATH = "/api/internal/pages/operator/releases";
const DEFAULT_OPERATOR_VISIBILITY_PATH = "/api/internal/pages/operator/visibility";
const DEFAULT_CONNECTORS_CATALOG_PATH = "/api/internal/pages/connectors/catalog";
const DEFAULT_CONNECTORS_EXEC_PATH = "/api/internal/pages/connectors/exec";
const DEFAULT_PASSWORD_VERIFY_PATH = "/api/internal/pages/password/verify";
const CONNECTORS_NO_STORE_CACHE = "private, no-store";
const DEFAULT_RESOLVE_PATH = "/api/internal/pages/resolve";
const DEFAULT_USAGE_PATH = "/api/internal/usage/events";
const DEFAULT_EDGE_MANIFEST_TTL_SECONDS = 0;
const MAX_EDGE_MANIFEST_TTL_SECONDS = 300;
const MAX_EDGE_MANIFEST_CACHE_ENTRIES = 512;
const MAX_USAGE_EVENTS_PER_INGEST_BATCH = 50;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const ENTRYPOINT_CACHE = "public, max-age=0, must-revalidate";
const NO_STORE_CACHE = "no-store";
const DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";
const DEFAULT_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "camera=(self)",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=(self)",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");
const DEFAULT_HTML_CSP = [
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");
const RAVI_PAGES_APEX_HOST = "ravi.page";
const PAGES_SESSION_COOKIE = "__Host-ravi_page_session";
const PAGES_PASSWORD_SESSION_COOKIE = "__Host-ravi_page_password_session";
const PAGES_PASSWORD_CHALLENGE_COOKIE = "__Host-ravi_page_password_challenge";
const PAGES_OPERATOR_CHECKED_COOKIE = "__Host-ravi_page_operator_checked";
const PAGES_CLAIM_CODE_QUERY_PARAM = "code";
const PAGES_CLAIM_PATH = "/_ravi/auth/claim";
const PAGES_PASSWORD_CHALLENGE_PATH = "/_ravi/auth/password";
const PAGES_TOOLBAR_QUERY_PARAMS = ["ravi_toolbar", "_ravi_toolbar"];
const PAGES_OPERATOR_CHECKED_QUERY_PARAM = "_ravi_operator_checked";
const PAGES_OPERATOR_CHECKED_COOKIE_VALUE = "v2";
const PAGES_OPERATOR_CHECKED_MAX_AGE_SECONDS = 5 * 60;
const PAGES_PASSWORD_CHALLENGE_MAX_AGE_SECONDS = 10 * 60;
const PAGES_CAPTURE_HEADER = "x-ravi-pages-capture";
const PAGES_CAPTURE_MODE = "thumbnail";
const PAGES_CAPTURE_FILENAME = "thumbnail.jpg";
const MAX_CAPTURE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PASSWORD_FORM_BYTES = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGES_SESSION_LENGTH = 512;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const edgeManifestCache = new Map<string, { expiresAt: number; manifest: EdgeSiteManifest }>();

type PagesUsageResolver = "edge_manifest" | "control_plane";
type EdgeManifestMissReason =
  | "manifest_missing"
  | "manifest_unreadable"
  | "manifest_invalid"
  | "manifest_not_ready"
  | "site_not_active"
  | "host_mismatch"
  | "active_release_mismatch"
  | "route_miss"
  | "reserved_asset_route_miss"
  | "reserved_asset_file_miss"
  | "file_miss"
  | "private_session"
  | "password_session"
  | "toolbar_session";

type EdgeManifestResolveResult =
  | { kind: "ok"; payload: ResolveOkResponse }
  | { kind: "response"; response: Response }
  | { kind: "miss"; reason: EdgeManifestMissReason };

type PagesUsageEvent = {
  organizationId: string;
  projectId?: string | null;
  siteId?: string | null;
  releaseId?: string | null;
  routeId?: string | null;
  artifactId?: string | null;
  artifactVersionId?: string | null;
  assetId?: string | null;
  source: "pages_worker";
  eventType: string;
  metricKey: string;
  quantity: number;
  unit: string;
  dimensionsJson?: Record<string, unknown>;
  measurementsJson?: Record<string, unknown>;
  evidenceJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
  idempotencyKey: string;
  requestId: string;
  occurredAt: string;
};

type PagesUsageContext = {
  requestId: string;
  resolver: PagesUsageResolver;
  usedFallback: boolean;
  pagesSessionUsed: boolean;
  edgeMissReason?: EdgeManifestMissReason | null;
};

export function __resetPagesWorkerEdgeManifestCacheForTests(): void {
  edgeManifestCache.clear();
}

export default {
  async fetch(request: Request, env: PagesWorkerEnv, ctx?: PagesWorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const reservedPrefix = normalizeReservedPrefix(env.RAVI_PAGES_RESERVED_PREFIX);
    const requestId = crypto.randomUUID();

    if (isHttpVisitorRequest(request, url)) {
      return httpsRedirect(url);
    }

    if (url.pathname === `${reservedPrefix}health`) {
      return json({
        ok: true,
        service: "ravi-pages",
        host: url.hostname,
      });
    }

    if (url.pathname === pagesInternalCapturesPath(reservedPrefix)) {
      return createInternalPageCapture(request, env, url, requestId, reservedPrefix);
    }

    if (url.pathname.startsWith(`${pagesInternalCapturesPath(reservedPrefix)}/`)) {
      return readInternalPageCapture(request, env, url, requestId, reservedPrefix);
    }

    if (isRaviPagesApex(url, env) && url.pathname === "/") {
      return standardPage();
    }

    if (hasUnsafePathSegments(url.pathname)) {
      return notFound();
    }

    if (url.pathname === pagesOperatorVisibilityPath(reservedPrefix)) {
      return updatePagesOperatorVisibility(request, env, url, requestId);
    }

    if (url.pathname === pagesOperatorCommentsPath(reservedPrefix)) {
      return handlePagesOperatorComments(request, env, url, requestId);
    }

    if (url.pathname === pagesOperatorPasswordPath(reservedPrefix)) {
      return handlePagesOperatorPassword(request, env, url, requestId);
    }

    if (url.pathname === pagesOperatorReleasesPath(reservedPrefix)) {
      return handlePagesOperatorReleases(request, env, url, requestId);
    }

    if (url.pathname === pagesConnectorsCatalogPath(reservedPrefix)) {
      return handlePagesConnectorsCatalog(request, env, url, requestId);
    }

    if (url.pathname === pagesConnectorsExecPath(reservedPrefix)) {
      return handlePagesConnectorsExec(request, env, url, requestId);
    }

    if (url.pathname === pagesPasswordChallengePath(reservedPrefix)) {
      return handlePagesPasswordChallenge(request, env, url, requestId);
    }

    if (url.pathname.startsWith(pageChatPaths(reservedPrefix).shell)) {
      if (!pagesAiEnabled(env)) return Response.json({ error: "page_chat_engine_disabled" }, { status: 503, headers: { "cache-control": "private, no-store" } });
      const pageChatResponse = await handlePageChatRequest({
        request,
        env,
        url,
        requestId,
        reservedPrefix,
        pagesSession: pagesSessionFromRequest(request),
        isSameOrigin: isSameOriginPagesRequest(request, url),
      });
      if (pageChatResponse) return pageChatResponse;
    }

    if (isChatRoomPath(url.pathname, reservedPrefix)) {
      if (!pagesAiEnabled(env)) return Response.json({ error: "page_chat_engine_disabled" }, { status: 503, headers: { "cache-control": "private, no-store" } });
      const chatRoomResponse = await handleChatRoomRequest({
        request,
        env,
        url,
        requestId,
        reservedPrefix,
        pagesSession: pagesSessionFromRequest(request),
        isSameOrigin: isSameOriginPagesRequest(request, url),
        isControlAuthorized: () => isPagesWorkerControlRequestAuthorized(request, env),
      });
      if (chatRoomResponse) return chatRoomResponse;
    }

    if (!isStaticMethod(request.method)) {
      return methodNotAllowed();
    }

    if (url.pathname === pagesClaimPath(reservedPrefix)) {
      return claimPagesSession(env, url);
    }

    if (url.pathname.startsWith(reservedPrefix) && !isReservedAssetPath(url.pathname, reservedPrefix)) {
      return reservedRoute(url);
    }

    if (url.searchParams.get(PAGES_OPERATOR_CHECKED_QUERY_PARAM) === "1") {
      return redirectWithoutPagesOperatorCheckedQuery(url);
    }

    const toolbarBootstrap = isCaptureRenderRequest(request) ? "none" : pagesToolbarBootstrapState(request, url);
    if (toolbarBootstrap === "start_auth") {
      return redirectToPagesAuth(env, url, { stripToolbarQuery: true });
    }
    if (toolbarBootstrap === "strip_query") {
      return redirectWithoutPagesToolbarQuery(url);
    }

    const edgeResolved = await resolvePagesRouteFromEdgeManifest(request, env, url, reservedPrefix);
    if (edgeResolved.kind === "ok") {
      const mountRedirect = mountedRouteBaseRedirect(url, edgeResolved.payload);
      if (mountRedirect) return mountRedirect;
      return serveR2Object(request, env, ctx, edgeResolved.payload, {
        requestId,
        resolver: "edge_manifest",
        usedFallback: false,
        pagesSessionUsed: false,
      });
    }
    if (edgeResolved.kind === "response") {
      return edgeResolved.response;
    }

    const pagesSessionUsed = Boolean(pagesSessionFromRequest(request));
    const resolved = await resolvePagesRoute(request, env, url, requestId, edgeResolved.reason);

    if (resolved.kind !== "ok") {
      return resolved.response;
    }

    if (pagesSessionUsed && !isCaptureRenderRequest(request) && shouldRetryOptionalPagesOperatorAuth(request, resolved.payload)) {
      return redirectToOptionalPagesAuthClearingSession(env, url);
    }

    const mountRedirect = mountedRouteBaseRedirect(url, resolved.payload);
    if (mountRedirect) return mountRedirect;

    return serveR2Object(request, env, ctx, resolved.payload, {
      requestId,
      resolver: "control_plane",
      usedFallback: true,
      pagesSessionUsed,
      edgeMissReason: edgeResolved.reason,
    });
  },

  async queue(batch: PagesUsageQueueBatch, env: PagesWorkerEnv): Promise<void> {
    await flushUsageQueueBatch(batch, env);
  },
};

function isStaticMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function isHttpVisitorRequest(request: Request, url: URL): boolean {
  if (url.protocol === "http:") {
    return true;
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "http") {
    return true;
  }

  const cfVisitor = request.headers.get("cf-visitor");
  if (!cfVisitor) {
    return false;
  }

  try {
    const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
    return typeof parsed.scheme === "string" && parsed.scheme.toLowerCase() === "http";
  } catch {
    return false;
  }
}

function httpsRedirect(url: URL): Response {
  const target = new URL(url.toString());
  target.protocol = "https:";

  return new Response(null, {
    status: 308,
    headers: {
      "Cache-Control": "public, max-age=3600",
      Location: target.toString(),
    },
  });
}

function mountedRouteBaseRedirect(url: URL, resolved: ResolveOkResponse): Response | null {
  const routePath = resolved.route?.path;
  const matchType = resolved.route?.matchType;
  if (!routePath || routePath === "/" || routePath.endsWith("/") || (matchType !== "prefix" && matchType !== "spa")) {
    return null;
  }
  if (url.pathname !== routePath) return null;

  const target = new URL(url.toString());
  target.pathname = `${routePath}/`;

  return new Response(null, {
    status: 308,
    headers: {
      "Cache-Control": NO_STORE_CACHE,
      Location: target.toString(),
    },
  });
}

function normalizeReservedPrefix(prefix: string | undefined): string {
  const rawPrefix = prefix?.trim() || DEFAULT_RESERVED_PREFIX;
  const withLeadingSlash = rawPrefix.startsWith("/") ? rawPrefix : `/${rawPrefix}`;

  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function hasUnsafePathSegments(pathname: string): boolean {
  if (pathname !== "/" && pathname.includes("//")) {
    return true;
  }

  for (const rawSegment of pathname.split("/")) {
    if (rawSegment === "") {
      continue;
    }

    let segment: string;

    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return true;
    }

    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      return true;
    }
  }

  return false;
}

async function resolvePagesRouteFromEdgeManifest(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  reservedPrefix: string,
): Promise<EdgeManifestResolveResult> {
  const loadedManifest = await loadEdgeSiteManifest(env, url.hostname);
  if (loadedManifest.kind === "miss") {
    return { kind: "miss", reason: loadedManifest.reason };
  }

  const manifest = loadedManifest.manifest;
  const mismatchReason = edgeManifestMismatchReason(manifest, url.hostname);
  if (mismatchReason) {
    return { kind: "miss", reason: mismatchReason };
  }

  const reservedAssetPath = parseReservedAssetPath(url.pathname, reservedPrefix);
  if (reservedAssetPath) {
    return resolveReservedAssetFromEdgeManifest(request, env, url, manifest, reservedAssetPath);
  }

  const route = matchEdgeRoute(manifest.routes, url.pathname);
  if (!route) return { kind: "miss", reason: "route_miss" };

  const visibility = effectiveEdgeVisibility(manifest.site.defaultVisibility, route.visibility);
  if (visibility === "password") {
    return passwordEdgeManifestResponse(request, env, url);
  }
  if (visibility !== "public") {
    return privateEdgeManifestResponse(request, env, url);
  }

  const requestedPath = artifactPathForEdgeRequest(route, url.pathname);
  const file =
    findEdgeFile(manifest, route, requestedPath) ??
    (spaFallbackApplies(route) && requestedPath !== route.artifact.entrypoint
      ? findEdgeFile(manifest, route, route.artifact.entrypoint)
      : null);
  if (!file) return { kind: "miss", reason: "file_miss" };
  const pagesSession = pagesSessionFromRequest(request);
  if (pagesSession && isToolbarEligibleEdgeFile(file)) {
    return { kind: "miss", reason: "toolbar_session" };
  }
  if (!pagesSession && isToolbarEligibleEdgeFile(file) && shouldStartOptionalPagesOperatorAuth(request)) {
    return { kind: "response", response: redirectToOptionalPagesAuth(env, url) };
  }

  return {
    kind: "ok",
    payload: edgeFileToResolvePayload(manifest, route, file),
  };
}

async function resolveReservedAssetFromEdgeManifest(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  manifest: EdgeSiteManifest,
  assetPath: ReservedAssetPath,
): Promise<EdgeManifestResolveResult> {
  const candidateRoutes = manifest.routes.filter(
    (route) => route.artifact.id === assetPath.artifactId && route.artifact.versionId === assetPath.artifactVersionId,
  );
  if (candidateRoutes.length === 0) return { kind: "miss", reason: "reserved_asset_route_miss" };

  const publicRoute = candidateRoutes.find(
    (route) => effectiveEdgeVisibility(manifest.site.defaultVisibility, route.visibility) === "public",
  );
  if (!publicRoute) {
    const passwordRoute = candidateRoutes.find(
      (route) => effectiveEdgeVisibility(manifest.site.defaultVisibility, route.visibility) === "password",
    );
    if (passwordRoute && !pagesSessionFromRequest(request)) {
      return passwordEdgeManifestResponse(request, env, url);
    }
    return privateEdgeManifestResponse(request, env, url);
  }

  const file = findEdgeFile(manifest, publicRoute, assetPath.filePath);
  if (!file) return { kind: "miss", reason: "reserved_asset_file_miss" };

  return {
    kind: "ok",
    payload: edgeFileToResolvePayload(manifest, publicRoute, file),
  };
}

function passwordEdgeManifestResponse(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
): { kind: "response"; response: Response } | { kind: "miss"; reason: EdgeManifestMissReason } {
  if (pagesSessionFromRequest(request) || pagesPasswordSessionFromRequest(request)) {
    return { kind: "miss", reason: "password_session" };
  }
  if (shouldStartOptionalPagesOperatorAuth(request)) {
    return { kind: "response", response: redirectToOptionalPagesAuth(env, url) };
  }
  return {
    kind: "response",
    response: passwordChallengeResponse(request, url, {
      formAction: pagesPasswordChallengePath(normalizeReservedPrefix(env.RAVI_PAGES_RESERVED_PREFIX)),
    }),
  };
}

function privateEdgeManifestResponse(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
): { kind: "response"; response: Response } | { kind: "miss"; reason: EdgeManifestMissReason } {
  return pagesSessionFromRequest(request)
    ? { kind: "miss", reason: "private_session" }
    : { kind: "response", response: redirectToPagesAuth(env, url) };
}

type ReservedAssetPath = {
  artifactId: string;
  artifactVersionId: string;
  filePath: string;
};

function parseReservedAssetPath(pathname: string, reservedPrefix: string): ReservedAssetPath | null {
  const prefix = `${reservedPrefix}assets/`;
  if (!pathname.startsWith(prefix)) return null;

  const rest = pathname.slice(prefix.length);
  const [artifactId, artifactVersionId, ...filePathParts] = rest.split("/");
  if (!artifactId || !artifactVersionId || filePathParts.length === 0) return null;

  const filePath = filePathParts.join("/");
  if (!isSafeManifestPath(filePath)) return null;

  return {
    artifactId,
    artifactVersionId,
    filePath,
  };
}

function isSafeManifestPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("//")) return false;
  for (const rawSegment of path.split("/")) {
    if (!rawSegment) return false;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return false;
    }
    if (segment === "." || segment === ".." || segment.startsWith(".")) return false;
  }
  return true;
}

async function loadEdgeSiteManifest(
  env: PagesWorkerEnv,
  hostname: string,
): Promise<{ kind: "ok"; manifest: EdgeSiteManifest } | { kind: "miss"; reason: EdgeManifestMissReason }> {
  const normalizedHost = hostname.toLowerCase();
  const ttlSeconds = edgeManifestTtlSeconds(env);
  if (ttlSeconds > 0) {
    const cached = edgeManifestCache.get(normalizedHost);
    if (cached && cached.expiresAt > Date.now()) {
      return { kind: "ok", manifest: cached.manifest };
    }
  }

  let object: R2ObjectBody | null;
  try {
    object = await env.RAVI_PAGES_ASSETS.get(activeSiteManifestKey(normalizedHost));
  } catch {
    return { kind: "miss", reason: "manifest_unreadable" };
  }
  if (!object) return { kind: "miss", reason: "manifest_missing" };

  let payload: unknown;
  try {
    payload = await new Response(object.body).json();
  } catch {
    return { kind: "miss", reason: "manifest_invalid" };
  }

  const manifest = parseEdgeSiteManifest(payload);
  if (!manifest) return { kind: "miss", reason: "manifest_invalid" };
  if (ttlSeconds > 0) {
    if (!edgeManifestCache.has(normalizedHost) && edgeManifestCache.size >= MAX_EDGE_MANIFEST_CACHE_ENTRIES) {
      const oldestHost = edgeManifestCache.keys().next().value;
      if (oldestHost) edgeManifestCache.delete(oldestHost);
    }
    edgeManifestCache.set(normalizedHost, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      manifest,
    });
  }
  return { kind: "ok", manifest };
}

function activeSiteManifestKey(hostname: string): string {
  return `sites/${hostname.toLowerCase()}/active.json`;
}

function edgeManifestTtlSeconds(env: PagesWorkerEnv): number {
  const configured = Number(env.RAVI_PAGES_EDGE_MANIFEST_TTL_SECONDS ?? DEFAULT_EDGE_MANIFEST_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_EDGE_MANIFEST_TTL_SECONDS;
  return Math.min(Math.floor(configured), MAX_EDGE_MANIFEST_TTL_SECONDS);
}

function parseEdgeSiteManifest(payload: unknown): EdgeSiteManifest | null {
  const root = record(payload);
  if (root.schemaVersion !== 1) return null;
  const edgeState = edgeStateValue(root.edgeState);
  if (!edgeState) return null;
  const site = record(root.site);
  const release = record(root.release);
  const rawRoutes = Array.isArray(root.routes) ? root.routes : null;
  if (!rawRoutes) return null;
  const artifacts = parseEdgeManifestArtifacts(root.artifacts);

  const parsedSite = {
    id: stringValue(site.id),
    organizationId: stringValue(site.organizationId),
    projectId: stringValue(site.projectId),
    defaultHostname: stringValue(site.defaultHostname),
    defaultVisibility: visibilityValue(site.defaultVisibility),
    status: siteStatusValue(site.status),
    activeReleaseId: stringValue(site.activeReleaseId),
  };
  const parsedRelease = {
    id: stringValue(release.id),
    number: numberValue(release.number),
    manifestHash: optionalStringValue(release.manifestHash),
  };
  if (
    !parsedSite.id ||
    !parsedSite.organizationId ||
    !parsedSite.projectId ||
    !parsedSite.defaultHostname ||
    !parsedSite.defaultVisibility ||
    !parsedSite.status ||
    !parsedSite.activeReleaseId ||
    !parsedRelease.id ||
    !Number.isFinite(parsedRelease.number)
  ) {
    return null;
  }

  const routes: EdgeManifestRoute[] = [];
  for (const rawRoute of rawRoutes) {
    const parsed = parseEdgeManifestRoute(rawRoute);
    if (!parsed) return null;
    routes.push(parsed);
  }

  return {
    schemaVersion: 1,
    edgeState,
    site: parsedSite as EdgeSiteManifest["site"],
    release: parsedRelease as EdgeSiteManifest["release"],
    ...(artifacts ? { artifacts } : {}),
    routes,
  };
}

function parseEdgeManifestArtifacts(input: unknown): EdgeManifestArtifact[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) return null;

  const artifacts: EdgeManifestArtifact[] = [];
  for (const rawArtifact of input) {
    const artifact = record(rawArtifact);
    const rawFiles = Array.isArray(artifact.files) ? artifact.files : null;
    const parsed = {
      id: stringValue(artifact.id),
      versionId: stringValue(artifact.versionId),
      versionNumber: optionalNumberValue(artifact.versionNumber),
      files: [] as EdgeManifestFile[],
    };
    if (!parsed.id || !parsed.versionId || !rawFiles) return null;
    for (const rawFile of rawFiles) {
      const parsedFile = parseEdgeManifestFile(rawFile);
      if (!parsedFile) return null;
      parsed.files.push(parsedFile);
    }
    artifacts.push(parsed as EdgeManifestArtifact);
  }
  return artifacts;
}

function parseEdgeManifestRoute(input: unknown): EdgeManifestRoute | null {
  const route = record(input);
  if (Object.prototype.hasOwnProperty.call(route, "files")) return null;
  const artifact = record(route.artifact);
  const parsedRoute = {
    id: stringValue(route.id),
    bindingId: stringValue(route.bindingId),
    path: stringValue(route.path),
    matchType: matchTypeValue(route.matchType),
    priority: numberValue(route.priority),
    visibility: visibilityValue(route.visibility),
    ...browserPermissionsProjection(route.browserPermissions),
    artifact: {
      id: stringValue(artifact.id),
      versionId: stringValue(artifact.versionId),
      versionNumber: optionalNumberValue(artifact.versionNumber),
      entrypoint: stringValue(artifact.entrypoint),
      assetBase: stringValue(artifact.assetBase),
    },
  };
  if (
    !parsedRoute.id ||
    !parsedRoute.bindingId ||
    !parsedRoute.path ||
    !parsedRoute.matchType ||
    !Number.isFinite(parsedRoute.priority) ||
    !parsedRoute.visibility ||
    !parsedRoute.artifact.id ||
    !parsedRoute.artifact.versionId ||
    !parsedRoute.artifact.entrypoint ||
    !parsedRoute.artifact.assetBase
  ) {
    return null;
  }
  return parsedRoute as EdgeManifestRoute;
}

function parseEdgeManifestFile(input: unknown): EdgeManifestFile | null {
  const file = record(input);
  const path = stringValue(file.path);
  const r2Key = stringValue(file.r2Key);
  if (!path || !r2Key || !isSafeManifestPath(path)) return null;

  return {
    path,
    r2Key,
    contentType: optionalStringValue(file.contentType) ?? undefined,
    cache: cacheModeValue(file.cache),
    etag: optionalStringValue(file.etag),
    sha256: optionalStringValue(file.sha256),
    sizeBytes: optionalNumberValue(file.sizeBytes),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function optionalNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function visibilityValue(value: unknown): EdgeSiteManifest["site"]["defaultVisibility"] | null {
  return value === "public" || value === "private" || value === "protected_link" || value === "password" ? value : null;
}

function siteStatusValue(value: unknown): EdgeSiteManifest["site"]["status"] | null {
  return value === "active" || value === "disabled" || value === "deleted" ? value : null;
}

function matchTypeValue(value: unknown): EdgeManifestRoute["matchType"] | null {
  return value === "exact" || value === "prefix" || value === "spa" ? value : null;
}

function cacheModeValue(value: unknown): EdgeManifestFile["cache"] {
  if (value === "immutable" || value === "entrypoint" || value === "html" || value === "private" || value === "no-store") {
    return value;
  }
  return undefined;
}

function edgeStateValue(value: unknown): EdgeSiteManifest["edgeState"] | null {
  if (value === "pending" || value === "ready" || value === "failed") return value;
  return null;
}

function edgeManifestMismatchReason(manifest: EdgeSiteManifest, hostname: string): EdgeManifestMissReason | null {
  if (manifest.edgeState !== "ready") return "manifest_not_ready";
  if (manifest.site.status !== "active") return "site_not_active";
  if (manifest.site.defaultHostname.toLowerCase() !== hostname.toLowerCase()) return "host_mismatch";
  if (manifest.site.activeReleaseId !== manifest.release.id) return "active_release_mismatch";
  return null;
}

function matchEdgeRoute(routes: EdgeManifestRoute[], requestPath: string): EdgeManifestRoute | null {
  const matches = routes.filter((route) => routeMatches(route, requestPath));
  matches.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.path.length !== a.path.length) return b.path.length - a.path.length;
    return b.path.localeCompare(a.path);
  });
  return matches[0] ?? null;
}

function routeMatches(route: EdgeManifestRoute, requestPath: string): boolean {
  if (route.matchType === "exact") return requestPath === route.path;
  if (route.path === "/") return true;
  return requestPath === route.path || requestPath.startsWith(`${route.path}/`);
}

// The root route owns the whole host, so an SPA fallback there would turn every
// unknown path (typos, `/report;`, removed pages) into the home page. Unknown
// paths on the root route are 404; non-root SPA mounts keep their fallback.
function spaFallbackApplies(route: { path: string; matchType: string }): boolean {
  return route.matchType === "spa" && route.path !== "/";
}

function artifactPathForEdgeRequest(route: EdgeManifestRoute, requestPath: string): string {
  if (route.matchType === "exact") return route.artifact.entrypoint;
  if (requestPath === route.path) return route.artifact.entrypoint;
  if (route.path === "/") return requestPath.replace(/^\/+/, "") || route.artifact.entrypoint;
  return requestPath.slice(route.path.length).replace(/^\/+/, "") || route.artifact.entrypoint;
}

function findEdgeFile(manifest: EdgeSiteManifest, route: EdgeManifestRoute, path: string): EdgeManifestFile | null {
  return filesForEdgeRoute(manifest, route).find((file) => file.path === path) ?? null;
}

function filesForEdgeRoute(manifest: EdgeSiteManifest, route: EdgeManifestRoute): EdgeManifestFile[] {
  const artifact = manifest.artifacts?.find(
    (candidate) => candidate.id === route.artifact.id && candidate.versionId === route.artifact.versionId,
  );
  return artifact?.files ?? [];
}

function effectiveEdgeVisibility(
  siteVisibility: EdgeSiteManifest["site"]["defaultVisibility"],
  routeVisibility: EdgeManifestRoute["visibility"],
): EdgeManifestRoute["visibility"] {
  if (routeVisibility !== "public") return routeVisibility;
  return siteVisibility === "public" ? "public" : siteVisibility;
}

function edgeFileToResolvePayload(
  manifest: EdgeSiteManifest,
  route: EdgeManifestRoute,
  file: EdgeManifestFile,
): ResolveOkResponse {
  return {
    status: "ok",
    site: {
      id: manifest.site.id,
      organizationId: manifest.site.organizationId,
      projectId: manifest.site.projectId,
      visibility: manifest.site.defaultVisibility,
    },
    release: {
      id: manifest.release.id,
      number: manifest.release.number,
    },
    route: {
      id: route.id,
      bindingId: route.bindingId,
      path: route.path,
      matchType: route.matchType,
      visibility: route.visibility,
      ...(route.browserPermissions ? { browserPermissions: route.browserPermissions } : {}),
    },
    artifact: {
      id: route.artifact.id,
      versionId: route.artifact.versionId,
      versionNumber: route.artifact.versionNumber ?? undefined,
    },
    object: {
      r2Key: file.r2Key,
      path: file.path,
      assetId: file.assetId,
      contentType: file.contentType,
      cache: cacheModeForEdgeFile(manifest, route, file),
      etag: file.etag,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    },
    headers: {
      ...(file.contentType ? { "content-type": file.contentType } : {}),
      ...(file.etag ? { etag: file.etag } : {}),
    },
  };
}

function cacheModeForEdgeFile(
  manifest: EdgeSiteManifest,
  route: EdgeManifestRoute,
  file: EdgeManifestFile,
): EdgeManifestFile["cache"] {
  if (effectiveEdgeVisibility(manifest.site.defaultVisibility, route.visibility) !== "public") return "private";
  if (file.cache === "private" || file.cache === "no-store") return file.cache;
  if (file.cache === "entrypoint" || file.cache === "html") return "entrypoint";
  if (file.path === route.artifact.entrypoint || (file.contentType ?? "").toLowerCase().startsWith("text/html")) {
    return "entrypoint";
  }
  return file.cache === "immutable" ? "immutable" : "immutable";
}

async function resolvePagesRoute(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
  edgeMissReason?: EdgeManifestMissReason | null,
): Promise<{ kind: "ok"; payload: ResolveOkResponse } | { kind: "response"; response: Response }> {
  let endpoint: URL;

  try {
    endpoint = new URL(env.RAVI_PAGES_RESOLVE_PATH ?? DEFAULT_RESOLVE_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return {
      kind: "response",
      response: serviceUnavailable("pages_control_plane_misconfigured"),
    };
  }

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "ravi-pages-worker",
    "x-request-id": requestId,
    "x-ravi-pages-edge-resolve": edgeMissReason ? "fallback" : "direct",
    "x-ravi-pages-host": url.hostname,
    "x-ravi-pages-path": url.pathname,
  });
  if (edgeMissReason) headers.set("x-ravi-pages-edge-miss-reason", edgeMissReason);

  if (env.RAVI_PAGES_CONTROL_TOKEN) {
    headers.set("authorization", `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN}`);
  }

  let response: Response;

  const resolveBody: {
    host: string;
    path: string;
    search?: string;
    method: string;
    pagesSession?: string;
    pagesPasswordSession?: string;
  } = {
    host: url.hostname,
    path: url.pathname,
    method: request.method,
  };
  if (url.search) {
    resolveBody.search = url.search;
  }
  const pagesSession = pagesSessionFromRequest(request);
  if (pagesSession) {
    resolveBody.pagesSession = pagesSession;
  }
  const pagesPasswordSession = pagesPasswordSessionFromRequest(request);
  if (pagesPasswordSession) {
    resolveBody.pagesPasswordSession = pagesPasswordSession;
  }

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(resolveBody),
    });
  } catch {
    return {
      kind: "response",
      response: serviceUnavailable("pages_control_plane_unavailable"),
    };
  }

  if (response.status === 404) {
    return { kind: "response", response: notFound() };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: "response",
      response: serviceUnavailable("pages_control_plane_auth_failed"),
    };
  }

  if (!response.ok) {
    return {
      kind: "response",
      response: serviceUnavailable("pages_control_plane_error"),
    };
  }

  let payload: ResolveResponse;

  try {
    payload = (await response.json()) as ResolveResponse;
  } catch {
    return {
      kind: "response",
      response: serviceUnavailable("pages_control_plane_invalid_response"),
    };
  }

  if (isResolveOk(payload)) {
    return { kind: "ok", payload };
  }

  const status = payload.status ?? payload.error;

  if (status === "redirect") {
    const location = safeResolveRedirectLocation(payload.redirect?.location);
    return {
      kind: "response",
      response: location ? redirectResponse(location) : serviceUnavailable("pages_control_plane_invalid_redirect"),
    };
  }

  if (status === "not_found" || status === "missing" || status === "disabled") {
    return { kind: "response", response: notFound() };
  }

  if (status === "private" || status === "unauthorized" || status === "forbidden") {
    const pagesSession = pagesSessionFromRequest(request);
    if (pagesSession) {
      const response = redirectToPagesAuth(env, url);
      response.headers.append("set-cookie", clearPagesSessionCookie());
      return {
        kind: "response",
        response,
      };
    }
    return {
      kind: "response",
      response: redirectToPagesAuth(env, url),
    };
  }

  if (status === "password_required") {
    const passwordSession = pagesPasswordSessionFromRequest(request);
    if (!passwordSession && shouldStartOptionalPagesOperatorAuth(request)) {
      return { kind: "response", response: redirectToOptionalPagesAuth(env, url) };
    }
    const response = passwordChallengeResponse(request, url, {
      error: passwordSession ? "A senha desta página foi alterada. Digite-a novamente." : undefined,
      formAction: pagesPasswordChallengePath(normalizeReservedPrefix(env.RAVI_PAGES_RESERVED_PREFIX)),
    });
    if (passwordSession) response.headers.append("set-cookie", clearPagesPasswordSessionCookie());
    return { kind: "response", response };
  }

  return {
    kind: "response",
    response: serviceUnavailable("pages_control_plane_unresolved"),
  };
}

function isResolveOk(payload: ResolveResponse): payload is ResolveOkResponse {
  return (
    "object" in payload &&
    typeof payload.object === "object" &&
    payload.object !== null &&
    typeof payload.object.r2Key === "string" &&
    payload.object.r2Key.length > 0 &&
    (!("status" in payload) || payload.status === undefined || payload.status === "ok" || payload.status === "resolved")
  );
}

function safeResolveRedirectLocation(location: string | undefined) {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function redirectResponse(location: string) {
  return new Response(null, {
    status: 308,
    headers: {
      "cache-control": "public, max-age=300",
      location,
      "x-content-type-options": "nosniff",
    },
  });
}

function isReservedAssetPath(pathname: string, reservedPrefix: string): boolean {
  return pathname.startsWith(`${reservedPrefix}assets/`);
}

function pagesClaimPath(reservedPrefix: string): string {
  return reservedPrefix === DEFAULT_RESERVED_PREFIX ? PAGES_CLAIM_PATH : `${reservedPrefix}auth/claim`;
}

function pagesPasswordChallengePath(reservedPrefix: string): string {
  return reservedPrefix === DEFAULT_RESERVED_PREFIX
    ? PAGES_PASSWORD_CHALLENGE_PATH
    : `${reservedPrefix}auth/password`;
}

function pagesOperatorVisibilityPath(reservedPrefix: string): string {
  return `${reservedPrefix}operator/visibility`;
}

function pagesOperatorCommentsPath(reservedPrefix: string): string {
  return `${reservedPrefix}operator/comments`;
}

function pagesOperatorPasswordPath(reservedPrefix: string): string {
  return `${reservedPrefix}operator/password`;
}

function pagesOperatorReleasesPath(reservedPrefix: string): string {
  return `${reservedPrefix}operator/releases`;
}

function pagesConnectorsCatalogPath(reservedPrefix: string): string {
  return `${reservedPrefix}connectors/catalog`;
}

function pagesConnectorsExecPath(reservedPrefix: string): string {
  return `${reservedPrefix}connectors/exec`;
}

function pagesInternalCapturesPath(reservedPrefix: string): string {
  return `${reservedPrefix}internal/captures`;
}

async function handlePagesPasswordChallenge(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    const returnTo = safePasswordReturnTo(url.searchParams.get("returnTo"), url);
    return passwordChallengeResponse(request, returnTo ?? new URL("/", url), {
      formAction: url.pathname,
    });
  }
  if (request.method !== "POST") return methodNotAllowed();

  let form: URLSearchParams;
  try {
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      throw new Error("invalid content type");
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_PASSWORD_FORM_BYTES) {
      throw new Error("password form too large");
    }
    form = new URLSearchParams(rawBody);
  } catch {
    return passwordChallengeResponse(request, new URL("/", url), {
      error: "Solicitação inválida.",
      formAction: url.pathname,
      status: 400,
    });
  }
  const returnTo = safePasswordReturnTo(form.get("returnTo"), url);
  if (!isVerifiedPasswordSubmission(request, url, form.get("challenge"))) {
    return passwordChallengeResponse(request, returnTo ?? new URL("/", url), {
      error: "Não foi possível verificar a solicitação. Tente novamente.",
      formAction: url.pathname,
      status: 403,
    });
  }
  const password = form.get("password");
  if (!returnTo || typeof password !== "string" || password.length === 0 || password.length > 256) {
    return passwordChallengeResponse(request, returnTo ?? new URL("/", url), {
      error: "Digite a senha da página.",
      formAction: url.pathname,
      status: 400,
    });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_PASSWORD_VERIFY_PATH ?? DEFAULT_PASSWORD_VERIFY_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_password_misconfigured");
  }

  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
    "content-type": "application/json",
    "user-agent": "ravi-pages-worker",
    "x-request-id": requestId,
  });
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim();
  if (clientAddress) headers.set("x-forwarded-for", clientAddress);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        host: url.hostname,
        password,
        path: returnTo.pathname,
      }),
    });
  } catch {
    return serviceUnavailable("pages_password_unavailable");
  }

  let payload: { cookie?: unknown; status?: unknown } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (
    !response.ok ||
    payload.status !== "ok" ||
    typeof payload.cookie !== "string" ||
    !isSafePasswordSessionCookie(payload.cookie)
  ) {
    const rateLimited = response.status === 429;
    return passwordChallengeResponse(request, returnTo, {
      error: rateLimited
        ? "Muitas tentativas. Aguarde alguns minutos e tente novamente."
        : "Senha incorreta.",
      formAction: url.pathname,
      status: rateLimited ? 429 : 401,
    });
  }

  const responseHeaders = new Headers({
    "cache-control": NO_STORE_CACHE,
    location: returnTo.toString(),
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  responseHeaders.append("set-cookie", payload.cookie);
  responseHeaders.append("set-cookie", clearPagesPasswordChallengeCookie());
  return new Response(null, {
    status: 303,
    headers: responseHeaders,
  });
}

function passwordChallengeResponse(
  request: Request,
  returnTo: URL,
  options: { error?: string; formAction?: string; status?: number } = {},
): Response {
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  const isDocument = accept.includes("text/html") || request.headers.get("sec-fetch-dest") === "document";
  if (!isDocument) {
    return json(
      { error: "password_required" },
      { status: options.status ?? 401, headers: { "cache-control": NO_STORE_CACHE } },
    );
  }
  const formAction = options.formAction ?? PAGES_PASSWORD_CHALLENGE_PATH;
  const challenge = createPagesPasswordChallenge();
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : "";
  const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow,noarchive">
    <title>Senha necessária · Ravi Pages</title>
    <style>
      :root{color-scheme:light;--ink:#17202a;--muted:#667382;--line:#d8e0e7;--accent:#14635a;--danger:#a83232}
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f7f9fb;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}
      main{width:min(100%,380px);padding:26px;border:1px solid var(--line);border-radius:8px;background:#fff;box-shadow:0 18px 44px rgba(23,32,42,.1)}
      .mark{display:grid;place-items:center;width:34px;height:34px;background:var(--ink);color:#fff;border-radius:6px;font-weight:800}h1{margin:22px 0 8px;font-size:24px;line-height:1.15}p{margin:0;color:var(--muted);font-size:14px;line-height:1.5}
      label{display:block;margin:22px 0 7px;font-size:13px;font-weight:720}input{width:100%;height:42px;padding:0 11px;border:1px solid #aeb9c4;border-radius:6px;background:#fff;color:var(--ink);font:inherit;outline:none}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(20,99,90,.12)}button{width:100%;height:42px;margin-top:12px;border:0;border-radius:6px;background:var(--ink);color:#fff;font:inherit;font-weight:740;cursor:pointer}.error{margin-top:14px;color:var(--danger);font-weight:650}
    </style>
  </head>
  <body>
    <main>
      <div class="mark">R</div>
      <h1>Esta página é protegida</h1>
      <p>Digite a senha definida pelo responsável para continuar.</p>
      ${error}
      <form method="post" action="${escapeHtml(formAction)}">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo.toString())}">
        <input type="hidden" name="challenge" value="${escapeHtml(challenge)}">
        <label for="password">Senha da página</label>
        <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required autofocus>
        <button type="submit">Acessar página</button>
      </form>
    </main>
  </body>
</html>`;
  return htmlResponse(html, {
    status: options.status ?? 401,
    headers: {
      "cache-control": NO_STORE_CACHE,
      "referrer-policy": "no-referrer",
      "set-cookie": pagesPasswordChallengeCookie(challenge),
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}

function isVerifiedPasswordSubmission(request: Request, current: URL, formChallenge: string | null): boolean {
  const cookieChallenge = pagesPasswordChallengeFromRequest(request);
  if (
    typeof formChallenge === "string" &&
    isOpaqueTokenShape(formChallenge) &&
    cookieChallenge === formChallenge
  ) {
    return true;
  }

  const origin = request.headers.get("origin")?.trim();
  if (origin && origin !== "null") {
    try {
      return new URL(origin).origin === current.origin;
    } catch {
      return false;
    }
  }

  return (
    request.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin" &&
    request.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate" &&
    request.headers.get("sec-fetch-dest")?.toLowerCase() === "document"
  );
}

function createPagesPasswordChallenge(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function pagesPasswordChallengeCookie(challenge: string): string {
  return `${PAGES_PASSWORD_CHALLENGE_COOKIE}=${challenge}; Path=/; Max-Age=${PAGES_PASSWORD_CHALLENGE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearPagesPasswordChallengeCookie(): string {
  return `${PAGES_PASSWORD_CHALLENGE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function safePasswordReturnTo(value: FormDataEntryValue | string | null, current: URL) {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const target = new URL(value, current.origin);
    if (
      target.protocol !== "https:" ||
      target.hostname !== current.hostname ||
      target.username ||
      target.password ||
      target.pathname === current.pathname
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

async function createInternalPageCapture(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
  reservedPrefix: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!(await isPagesWorkerControlRequestAuthorized(request, env))) {
    return json({ error: "capture_unauthorized" }, { status: 401, headers: { "cache-control": NO_STORE_CACHE } });
  }
  if (!env.RAVI_PAGES_BROWSER || !env.RAVI_PAGES_ASSETS.put) {
    return json({ error: "capture_provider_unavailable" }, { status: 503, headers: { "cache-control": NO_STORE_CACHE } });
  }

  let body: Record<string, unknown>;
  try {
    body = record(await request.json());
  } catch {
    return json({ error: "capture_invalid_request" }, { status: 400, headers: { "cache-control": NO_STORE_CACHE } });
  }
  const parsed = parseInternalCaptureInput(body, url, reservedPrefix);
  if (!parsed) {
    return json({ error: "capture_invalid_request" }, { status: 400, headers: { "cache-control": NO_STORE_CACHE } });
  }

  const targetUrl = new URL(parsed.path, `${url.protocol}//${url.host}`);
  let screenshotResponse: Response;
  try {
    screenshotResponse = await env.RAVI_PAGES_BROWSER.quickAction("screenshot", {
      url: targetUrl.toString(),
      cookies: [
        {
          name: PAGES_SESSION_COOKIE,
          value: parsed.pagesSession,
          domain: url.hostname,
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      setExtraHTTPHeaders: { [PAGES_CAPTURE_HEADER]: PAGES_CAPTURE_MODE },
      screenshotOptions: {
        type: parsed.config.format,
        quality: parsed.config.quality,
        fullPage: false,
      },
      viewport: parsed.config.viewport,
      gotoOptions: {
        waitUntil: "networkidle2",
        timeout: parsed.config.timeoutMs,
      },
      actionTimeout: parsed.config.timeoutMs,
    });
  } catch {
    return json({ error: "capture_render_failed" }, { status: 503, headers: { "cache-control": NO_STORE_CACHE } });
  }
  if (!screenshotResponse.ok) {
    return json(
      { error: screenshotResponse.status === 429 ? "capture_rate_limited" : "capture_render_failed" },
      { status: screenshotResponse.status === 429 ? 429 : 503, headers: { "cache-control": NO_STORE_CACHE } },
    );
  }

  const image = await screenshotResponse.arrayBuffer();
  if (image.byteLength === 0 || image.byteLength > MAX_CAPTURE_IMAGE_BYTES) {
    return json({ error: "capture_image_too_large" }, { status: 413, headers: { "cache-control": NO_STORE_CACHE } });
  }
  const storageKey = captureStorageKey(parsed);
  const sha256 = await sha256Hex(image);
  try {
    await env.RAVI_PAGES_ASSETS.put(storageKey, image, {
      httpMetadata: {
        contentType: "image/jpeg",
        cacheControl: "private, max-age=31536000, immutable",
      },
      customMetadata: {
        captureSetId: parsed.captureSetId,
        role: "thumbnail",
        sha256,
      },
    });
  } catch {
    return json({ error: "capture_storage_failed" }, { status: 503, headers: { "cache-control": NO_STORE_CACHE } });
  }

  return json(
    {
      storageKey,
      filename: PAGES_CAPTURE_FILENAME,
      role: "thumbnail",
      mimeType: "image/jpeg",
      width: parsed.config.viewport.width,
      height: parsed.config.viewport.height,
      sizeBytes: image.byteLength,
      sha256,
    },
    { status: 201, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
  );
}

async function readInternalPageCapture(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
  reservedPrefix: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
  if (!(await isPagesWorkerControlRequestAuthorized(request, env))) {
    return json({ error: "capture_unauthorized" }, { status: 401, headers: { "cache-control": NO_STORE_CACHE } });
  }
  const suffix = url.pathname.slice(`${pagesInternalCapturesPath(reservedPrefix)}/`.length);
  const segments = suffix.split("/").map((value) => decodeURIComponent(value));
  if (segments.length !== 5 || !segments.slice(0, 4).every(isUuid) || segments[4] !== PAGES_CAPTURE_FILENAME) {
    return notFound();
  }
  const organizationId = segments[0]!;
  const projectId = segments[1]!;
  const captureArtifactId = segments[2]!;
  const captureArtifactVersionId = segments[3]!;
  const filename = segments[4]!;
  const storageKey = captureStorageKey({ organizationId, projectId, captureArtifactId, captureArtifactVersionId });
  let object: R2ObjectBody | null;
  try {
    object = await env.RAVI_PAGES_ASSETS.get(storageKey);
  } catch {
    return serviceUnavailable("capture_storage_unavailable");
  }
  if (!object) return notFound();
  const headers = new Headers({
    "cache-control": "private, max-age=300",
    "content-type": object.httpMetadata?.contentType ?? "image/jpeg",
    "content-disposition": `inline; filename="${filename}"`,
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function parseInternalCaptureInput(body: Record<string, unknown>, url: URL, reservedPrefix: string) {
  const organizationId = uuidValue(body.organizationId);
  const projectId = uuidValue(body.projectId);
  const captureSetId = uuidValue(body.captureSetId);
  const captureArtifactId = uuidValue(body.captureArtifactId);
  const captureArtifactVersionId = uuidValue(body.captureArtifactVersionId);
  const path = typeof body.path === "string" ? body.path : "";
  const pagesSession = typeof body.pagesSession === "string" && isPagesSessionShape(body.pagesSession) ? body.pagesSession : null;
  const config = parseCaptureConfig(body.config);
  if (
    !organizationId ||
    !projectId ||
    !captureSetId ||
    !captureArtifactId ||
    !captureArtifactVersionId ||
    !pagesSession ||
    body.mode !== PAGES_CAPTURE_MODE ||
    !config ||
    !path.startsWith("/") ||
    path.startsWith(reservedPrefix) ||
    hasUnsafePathSegments(path)
  ) {
    return null;
  }
  try {
    const target = new URL(path, `${url.protocol}//${url.host}`);
    if (target.protocol !== "https:" || target.host !== url.host || target.username || target.password) return null;
  } catch {
    return null;
  }
  return { organizationId, projectId, captureSetId, captureArtifactId, captureArtifactVersionId, path, pagesSession, config };
}

function parseCaptureConfig(value: unknown) {
  const input = record(value);
  const viewport = record(input.viewport);
  const width = integerInRange(viewport.width, 320, 2560);
  const height = integerInRange(viewport.height, 240, 2048);
  const deviceScaleFactor = numberInRange(viewport.deviceScaleFactor, 1, 2);
  const quality = integerInRange(input.quality, 40, 95);
  const timeoutMs = integerInRange(input.timeoutMs, 1_000, 60_000);
  if (!width || !height || !deviceScaleFactor || !quality || !timeoutMs || input.format !== "jpeg") return null;
  return { viewport: { width, height, deviceScaleFactor }, format: "jpeg", quality, timeoutMs } as const;
}

function captureStorageKey(input: {
  organizationId: string;
  projectId: string;
  captureArtifactId: string;
  captureArtifactVersionId: string;
}) {
  return `org/${input.organizationId}/project/${input.projectId}/artifact/${input.captureArtifactId}/version/${input.captureArtifactVersionId}/${PAGES_CAPTURE_FILENAME}`;
}

async function isPagesWorkerControlRequestAuthorized(request: Request, env: PagesWorkerEnv) {
  const expected = env.RAVI_PAGES_CONTROL_TOKEN?.trim();
  const provided = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!expected || !provided) return false;
  const [left, right] = await Promise.all([sha256Bytes(expected), sha256Bytes(provided)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

async function sha256Hex(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function uuidValue(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function integerInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function numberInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function isCaptureRenderRequest(request: Request) {
  return request.headers.get(PAGES_CAPTURE_HEADER) === PAGES_CAPTURE_MODE;
}

async function updatePagesOperatorVisibility(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!isSameOriginPagesRequest(request, url)) {
    return json(
      { status: "error", error: "cross_origin_rejected" },
      { status: 403, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  const pagesSession = pagesSessionFromRequest(request);
  if (!pagesSession) {
    return json(
      { status: "error", error: "pages_session_required" },
      { status: 401, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let body: { path?: unknown; visibility?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(
      { status: "error", error: "invalid_json" },
      { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  const visibility = typeof body.visibility === "string" ? body.visibility : "";
  if (visibility !== "public" && visibility !== "private" && visibility !== "protected_link" && visibility !== "password") {
    return json(
      { status: "error", error: "invalid_visibility" },
      { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_OPERATOR_VISIBILITY_PATH ?? DEFAULT_OPERATOR_VISIBILITY_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_operator_misconfigured");
  }

  const path = typeof body.path === "string" && body.path.startsWith("/") ? body.path : url.pathname;
  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      host: url.hostname,
      pagesSession,
      path,
      visibility,
    }),
  });

  const headers = new Headers({
    "cache-control": NO_STORE_CACHE,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  return new Response(await response.text(), { status: response.status, headers });
}

async function handlePagesOperatorPassword(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!isSameOriginPagesRequest(request, url)) {
    return json(
      { status: "error", error: "cross_origin_rejected" },
      { status: 403, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }
  const pagesSession = pagesSessionFromRequest(request);
  if (!pagesSession) {
    return json(
      { status: "error", error: "pages_session_required" },
      { status: 401, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let body: Record<string, unknown>;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_PASSWORD_FORM_BYTES) {
      throw new Error("password request too large");
    }
    body = record(JSON.parse(rawBody));
  } catch {
    return json(
      { status: "error", error: "invalid_json" },
      { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }
  const action = body.action === "set" || body.action === "disable" || body.action === "status"
    ? body.action
    : null;
  const password = typeof body.password === "string" ? body.password : undefined;
  const path = commentsRequestPath(body.path ?? url.pathname);
  const scope = body.scope === "site" ? "site" : "route";
  if (!action || (action === "set" && (!password || password.length > 256))) {
    return json(
      { status: "error", error: "invalid_request" },
      { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_OPERATOR_PASSWORD_PATH ?? DEFAULT_OPERATOR_PASSWORD_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_operator_misconfigured");
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({ action, host: url.hostname, pagesSession, password, path, scope }),
    });
  } catch {
    return serviceUnavailable("pages_operator_password_unavailable");
  }
  const headers = new Headers({
    "cache-control": NO_STORE_CACHE,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  return new Response(await response.text(), { status: response.status, headers });
}

async function handlePagesOperatorComments(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();
  if (!isSameOriginPagesRequest(request, url)) {
    return json(
      { status: "error", error: "cross_origin_rejected" },
      { status: 403, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  const pagesSession = pagesSessionFromRequest(request);
  if (!pagesSession) {
    return json(
      { status: "error", error: "pages_session_required" },
      { status: 401, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_OPERATOR_COMMENTS_PATH ?? DEFAULT_OPERATOR_COMMENTS_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_operator_misconfigured");
  }

  let payload: Record<string, unknown>;
  if (request.method === "GET") {
    payload = {
      action: "list",
      host: url.hostname,
      pagesSession,
      path: commentsRequestPath(url.searchParams.get("path")),
    };
  } else {
    let body: Record<string, unknown>;
    try {
      body = record(await request.json());
    } catch {
      return json(
        { status: "error", error: "invalid_json" },
        { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
      );
    }
    const action = body.action === "create" || body.action === "delete" ? body.action : "list";
    payload = {
      action,
      body: body.body,
      commentId: body.commentId,
      host: url.hostname,
      parentId: body.parentId,
      pagesSession,
      path: commentsRequestPath(body.path),
      target: body.target,
    };
  }

  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return serviceUnavailable("pages_operator_comments_unavailable");
  }

  const headers = new Headers({
    "cache-control": NO_STORE_CACHE,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  return new Response(await response.text(), { status: response.status, headers });
}

const OPERATOR_RELEASE_ACTIONS = new Set(["list", "compare", "file_diff", "restore"]);

async function handlePagesOperatorReleases(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!isSameOriginPagesRequest(request, url)) {
    return json(
      { status: "error", error: "cross_origin_rejected" },
      { status: 403, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }
  const pagesSession = pagesSessionFromRequest(request);
  if (!pagesSession) {
    return json(
      { status: "error", error: "pages_session_required" },
      { status: 401, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = record(await request.json());
  } catch {
    return json(
      { status: "error", error: "invalid_json" },
      { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }
  const action = typeof body.action === "string" && OPERATOR_RELEASE_ACTIONS.has(body.action) ? body.action : "";
  if (!action) {
    return json(
      { status: "error", error: "invalid_request" },
      { status: 400, headers: { "cache-control": NO_STORE_CACHE, "x-request-id": requestId } },
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_OPERATOR_RELEASES_PATH ?? DEFAULT_OPERATOR_RELEASES_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_operator_misconfigured");
  }

  const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);
  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        action,
        baseReleaseId: body.baseReleaseId === null ? null : optionalString(body.baseReleaseId),
        file: optionalString(body.file),
        host: url.hostname,
        matchType: optionalString(body.matchType),
        pagesSession,
        path: commentsRequestPath(body.path),
        releaseId: optionalString(body.releaseId),
        routePath: optionalString(body.routePath),
      }),
    });
  } catch {
    return serviceUnavailable("pages_operator_releases_unavailable");
  }

  const headers = new Headers({
    "cache-control": NO_STORE_CACHE,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  return new Response(await response.text(), { status: response.status, headers });
}

async function handlePagesConnectorsCatalog(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return connectorsJson({ error: "payload_invalid" }, { status: 405, requestId });
  }
  if (!isSameOriginPagesRequest(request, url)) {
    return connectorsJson({ error: "connector_unauthorized" }, { status: 401, requestId });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_CONNECTORS_CATALOG_PATH ?? DEFAULT_CONNECTORS_CATALOG_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return connectorsJson({ error: "connector_unavailable" }, { status: 503, requestId });
  }

  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        auth: url.searchParams.get("auth"),
        class: url.searchParams.get("class"),
        executable: url.searchParams.get("executable"),
        host: url.hostname,
        ids: url.searchParams.get("ids"),
        pagesSession: pagesSessionFromRequest(request),
        q: url.searchParams.get("q"),
      }),
    });
  } catch {
    return connectorsJson({ error: "connector_unavailable" }, { status: 503, requestId });
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      status: response.status,
      headers: connectorsResponseHeaders(requestId),
    });
  }

  return new Response(await response.text(), {
    status: response.status,
    headers: connectorsResponseHeaders(requestId),
  });
}

async function handlePagesConnectorsExec(
  request: Request,
  env: PagesWorkerEnv,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return connectorsJson({ error: "payload_invalid" }, { status: 405, requestId });
  }
  if (!isSameOriginPagesRequest(request, url)) {
    return connectorsJson({ error: "connector_unauthorized" }, { status: 401, requestId });
  }

  const pagesSession = pagesSessionFromRequest(request);
  if (!pagesSession) {
    return connectorsJson({ error: "connector_session_required" }, { status: 401, requestId });
  }

  let body: { id?: unknown; input?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return connectorsJson({ error: "payload_invalid" }, { status: 400, requestId });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_CONNECTORS_EXEC_PATH ?? DEFAULT_CONNECTORS_EXEC_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return connectorsJson({ error: "connector_unavailable" }, { status: 503, requestId });
  }

  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        host: url.hostname,
        id: body.id,
        input: body.input ?? {},
        origin: request.headers.get("origin"),
        pagesSession,
      }),
    });
  } catch {
    return connectorsJson({ error: "connector_unavailable" }, { status: 503, requestId });
  }

  return new Response(await response.text(), {
    status: response.status,
    headers: connectorsResponseHeaders(requestId),
  });
}

function isSameOriginPagesRequest(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin")?.trim();
  if (origin === "null") return false;
  if (origin) {
    try {
      return origin === url.origin;
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

function connectorsJson(
  payload: unknown,
  init: { status: number; requestId: string },
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status,
    headers: connectorsResponseHeaders(init.requestId),
  });
}

function connectorsResponseHeaders(requestId: string): Headers {
  return new Headers({
    "cache-control": CONNECTORS_NO_STORE_CACHE,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
}

function commentsRequestPath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 2048 ? value : "/";
}

async function claimPagesSession(env: PagesWorkerEnv, url: URL): Promise<Response> {
  const code = url.searchParams.get(PAGES_CLAIM_CODE_QUERY_PARAM);
  if (!code || !isOpaqueTokenShape(code)) {
    return privateNotFound({ clearPagesSession: true });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_AUTH_CLAIM_PATH ?? DEFAULT_AUTH_CLAIM_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_auth_misconfigured");
  }

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "ravi-pages-worker",
    "x-request-id": crypto.randomUUID(),
  });

  if (env.RAVI_PAGES_CONTROL_TOKEN) {
    headers.set("authorization", `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN}`);
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code,
        host: url.hostname,
      }),
    });
  } catch {
    return serviceUnavailable("pages_auth_unavailable");
  }

  if (response.status === 401 || response.status === 403) {
    return serviceUnavailable("pages_auth_control_failed");
  }

  let payload: {
    status?: string;
    returnTo?: string;
    session?: { cookie?: string };
    clearCookies?: string[];
  };

  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return serviceUnavailable("pages_auth_invalid_response");
  }

  if (
    !response.ok ||
    payload.status !== "ok" ||
    !payload.returnTo ||
    !payload.session?.cookie ||
    !isSafePagesSessionCookie(payload.session.cookie)
  ) {
    return privateNotFound({ clearPagesSession: true, extraClearCookies: payload.clearCookies });
  }

  const returnTo = safeReturnToForHost(payload.returnTo, url.hostname);
  if (!returnTo) {
    return privateNotFound({ clearPagesSession: true });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: returnTo,
      "cache-control": NO_STORE_CACHE,
      "set-cookie": payload.session.cookie,
    },
  });
}

function redirectToPagesAuth(
  env: PagesWorkerEnv,
  url: URL,
  options: { stripToolbarQuery?: boolean } = {},
): Response {
  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_AUTH_START_PATH ?? DEFAULT_AUTH_START_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_auth_misconfigured");
  }

  const returnTo = new URL(url);
  returnTo.searchParams.delete(PAGES_CLAIM_CODE_QUERY_PARAM);
  if (options.stripToolbarQuery) {
    stripPagesToolbarQuery(returnTo);
  }
  endpoint.searchParams.set("returnTo", returnTo.toString());
  return new Response(null, {
    status: 302,
    headers: {
      location: endpoint.toString(),
      "cache-control": NO_STORE_CACHE,
    },
  });
}

function redirectToOptionalPagesAuth(env: PagesWorkerEnv, url: URL): Response {
  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_AUTH_OPTIONAL_PATH ?? DEFAULT_AUTH_OPTIONAL_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    return serviceUnavailable("pages_auth_misconfigured");
  }

  const returnTo = new URL(url);
  returnTo.searchParams.delete(PAGES_CLAIM_CODE_QUERY_PARAM);
  stripPagesToolbarQuery(returnTo);
  returnTo.searchParams.delete(PAGES_OPERATOR_CHECKED_QUERY_PARAM);
  endpoint.searchParams.set("returnTo", returnTo.toString());
  return new Response(null, {
    status: 302,
    headers: {
      location: endpoint.toString(),
      "cache-control": NO_STORE_CACHE,
    },
  });
}

function redirectToOptionalPagesAuthClearingSession(env: PagesWorkerEnv, url: URL): Response {
  const response = redirectToOptionalPagesAuth(env, url);
  response.headers.append("set-cookie", clearPagesSessionCookie());
  return response;
}

function pagesToolbarBootstrapState(request: Request, url: URL): "none" | "start_auth" | "strip_query" {
  if (!hasPagesToolbarQuery(url)) return "none";
  return pagesSessionFromRequest(request) ? "strip_query" : "start_auth";
}

function hasPagesToolbarQuery(url: URL): boolean {
  return PAGES_TOOLBAR_QUERY_PARAMS.some((name) => {
    const value = url.searchParams.get(name);
    return value !== null && value !== "0" && value.toLowerCase() !== "false";
  });
}

function stripPagesToolbarQuery(url: URL): void {
  for (const name of PAGES_TOOLBAR_QUERY_PARAMS) {
    url.searchParams.delete(name);
  }
}

function redirectWithoutPagesToolbarQuery(url: URL): Response {
  const target = new URL(url);
  stripPagesToolbarQuery(target);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": NO_STORE_CACHE,
      "x-content-type-options": "nosniff",
    },
  });
}

function redirectWithoutPagesOperatorCheckedQuery(url: URL): Response {
  const target = new URL(url);
  target.searchParams.delete(PAGES_OPERATOR_CHECKED_QUERY_PARAM);
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": NO_STORE_CACHE,
      "set-cookie": pagesOperatorCheckedCookie(),
      "x-content-type-options": "nosniff",
    },
  });
}

function shouldStartOptionalPagesOperatorAuth(request: Request) {
  if (request.method !== "GET") return false;
  if (pagesOperatorCheckedFromRequest(request)) return false;

  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  if (!accept.includes("text/html")) return false;

  const fetchDest = request.headers.get("sec-fetch-dest")?.toLowerCase();
  if (fetchDest && fetchDest !== "document" && fetchDest !== "empty") return false;

  const fetchMode = request.headers.get("sec-fetch-mode")?.toLowerCase();
  if (fetchMode && fetchMode !== "navigate") return false;

  return true;
}

function shouldRetryOptionalPagesOperatorAuth(request: Request, resolved: ResolveOkResponse) {
  if (resolved.toolbar?.enabled) return false;
  if (!shouldStartOptionalPagesOperatorAuth(request)) return false;
  if (!resolved.object) return false;
  if (resolvedVisibility(resolved) !== "public") return false;
  return isHtmlContentType(resolved.object.contentType ?? "");
}

function pagesSessionFromRequest(request: Request) {
  return opaqueCookieFromRequest(request, PAGES_SESSION_COOKIE);
}

function pagesPasswordSessionFromRequest(request: Request) {
  return opaqueCookieFromRequest(request, PAGES_PASSWORD_SESSION_COOKIE);
}

function pagesPasswordChallengeFromRequest(request: Request) {
  return opaqueCookieFromRequest(request, PAGES_PASSWORD_CHALLENGE_COOKIE);
}

function opaqueCookieFromRequest(request: Request, cookieName: string) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== cookieName) continue;
    const value = rawValue.join("=");
    if (!value) return null;
    try {
      const decodedValue = decodeURIComponent(value);
      return isPagesSessionShape(decodedValue) ? decodedValue : null;
    } catch {
      return isPagesSessionShape(value) ? value : null;
    }
  }
  return null;
}

function clearPagesPasswordSessionCookie() {
  return `${PAGES_PASSWORD_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function pagesOperatorCheckedFromRequest(request: Request) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;
  return cookie
    .split(";")
    .some((part) => {
      const [name, value] = part.trim().split("=");
      return name === PAGES_OPERATOR_CHECKED_COOKIE && value === PAGES_OPERATOR_CHECKED_COOKIE_VALUE;
    });
}

function pagesOperatorCheckedCookie() {
  return `${PAGES_OPERATOR_CHECKED_COOKIE}=${PAGES_OPERATOR_CHECKED_COOKIE_VALUE}; Path=/; Max-Age=${PAGES_OPERATOR_CHECKED_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function isPagesSessionShape(token: string) {
  return token.length <= MAX_PAGES_SESSION_LENGTH && OPAQUE_TOKEN_PATTERN.test(token);
}

function isOpaqueTokenShape(token: string) {
  return token.length <= MAX_PAGES_SESSION_LENGTH && OPAQUE_TOKEN_PATTERN.test(token);
}

function safeReturnToForHost(returnTo: string, host: string) {
  try {
    const url = new URL(returnTo);
    if (url.protocol !== "https:" || url.hostname !== host) return null;
    url.searchParams.delete(PAGES_CLAIM_CODE_QUERY_PARAM);
    return url.toString();
  } catch {
    return null;
  }
}

function isSafePagesSessionCookie(cookie: string) {
  return isSafeHostSessionCookie(cookie, PAGES_SESSION_COOKIE);
}

function isSafePasswordSessionCookie(cookie: string) {
  return isSafeHostSessionCookie(cookie, PAGES_PASSWORD_SESSION_COOKIE);
}

function isSafeHostSessionCookie(cookie: string, name: string) {
  const lowerCookie = cookie.toLowerCase();
  return (
    cookie.startsWith(`${name}=`) &&
    lowerCookie.includes("httponly") &&
    lowerCookie.includes("secure") &&
    lowerCookie.includes("samesite=lax") &&
    lowerCookie.includes("path=/") &&
    !/;\s*domain=/i.test(cookie)
  );
}

async function serveR2Object(
  request: Request,
  env: PagesWorkerEnv,
  ctx: PagesWorkerExecutionContext | undefined,
  resolved: ResolveOkResponse,
  usageContext: PagesUsageContext,
): Promise<Response> {
  if (!isFinalR2Key(resolved)) {
    queueUsageEvents(env, ctx, usageEventsForEdgeError(request, resolved, usageContext, "invalid_object_key", 503));
    return serviceUnavailable("pages_control_plane_invalid_object_key");
  }

  let object: R2ObjectBody | null;

  try {
    object = await env.RAVI_PAGES_ASSETS.get(resolved.object.r2Key);
  } catch {
    queueUsageEvents(env, ctx, usageEventsForEdgeError(request, resolved, usageContext, "storage_unavailable", 503));
    return serviceUnavailable("pages_storage_unavailable");
  }

  if (!object) {
    queueUsageEvents(env, ctx, usageEventsForEdgeError(request, resolved, usageContext, "storage_missing", 404));
    return notFound();
  }

  const headers = safeResolvedHeaders(resolved.headers);
  const contentType = resolved.object.contentType ?? object.httpMetadata?.contentType ?? "application/octet-stream";

  if (!headers.has("content-type")) headers.set("content-type", contentType);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", cacheControlFor(resolved.object.cache, object.httpMetadata?.cacheControl));
  }
  if (resolvedVisibility(resolved) !== "public") appendVaryHeader(headers, "Cookie");
  const pageChat = pagesAiEnabled(env) && isPageChatResponse(request, resolved, contentType);
  applyDefaultSecurityHeaders(headers, contentType, resolved.route?.browserPermissions, {
    allowSameOriginFrame: pageChat,
  });
  if (!headers.has("etag") && resolved.object.etag) headers.set("etag", resolved.object.etag);
  if (!headers.has("content-length") && typeof resolved.object.sizeBytes === "number" && resolved.object.sizeBytes >= 0) {
    headers.set("content-length", String(resolved.object.sizeBytes));
  }

  if (object.httpMetadata?.contentEncoding) {
    headers.set("content-encoding", object.httpMetadata.contentEncoding);
  }

  if (object.httpMetadata?.contentLanguage) {
    headers.set("content-language", object.httpMetadata.contentLanguage);
  }

  if (
    request.method !== "HEAD" &&
    !isCaptureRenderRequest(request) &&
    isHtmlContentType(contentType) &&
    resolved.toolbar?.enabled
  ) {
    const body = await new Response(object.body).text();
    const withShim = pageChat ? injectPageChatHeadShim(body) : body;
    const withChat = injectPageChatRoom(withShim, request, env, resolved, pageChat);
    const response = new Response(injectPagesToolbar(withChat, env, resolved), {
      status: 200,
      headers,
    });
    response.headers.set("cache-control", NO_STORE_CACHE);
    response.headers.set("x-ravi-pages-toolbar", "1");
    response.headers.delete("content-length");
    appendVaryHeader(response.headers, "Cookie");
    queueUsageEvents(env, ctx, usageEventsForServedObject(request, resolved, usageContext, response));
    return response;
  }

  if (pageChat && resolved.guestChat?.enabled) {
    const body = await new Response(object.body).text();
    const withChat = injectPageChatRoom(injectPageChatHeadShim(body), request, env, resolved, true);
    const response = new Response(injectGuestChatButton(withChat), {
      status: 200,
      headers,
    });
    response.headers.set("cache-control", NO_STORE_CACHE);
    response.headers.set("x-ravi-pages-guest-chat", "1");
    response.headers.delete("content-length");
    appendVaryHeader(response.headers, "Cookie");
    queueUsageEvents(env, ctx, usageEventsForServedObject(request, resolved, usageContext, response));
    return response;
  }

  if (shouldScanForRaviChatTag(request, resolved, contentType)) {
    // Pages without chat for this viewer still turn <ravi-chat> into a note; bytes stay untouched otherwise.
    const buffer = await new Response(object.body).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let responseBody: ArrayBuffer | string = buffer;
    if (containsRaviChatTag(bytes)) {
      responseBody = injectPageChatRoom(new TextDecoder().decode(bytes), request, env, resolved, false);
      headers.delete("content-length");
      appendVaryHeader(headers, "Cookie");
    }
    const response = new Response(responseBody, { status: 200, headers });
    queueUsageEvents(env, ctx, usageEventsForServedObject(request, resolved, usageContext, response));
    return response;
  }

  const response = new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
  queueUsageEvents(env, ctx, usageEventsForServedObject(request, resolved, usageContext, response));
  return response;
}

/** Largest HTML document scanned for a `<ravi-chat>` tag when chat is off for the viewer. */
const MAX_RAVI_CHAT_SCAN_BYTES = 4 * 1024 * 1024;

function shouldScanForRaviChatTag(request: Request, resolved: ResolveOkResponse, contentType: string) {
  const size = resolved.object.sizeBytes;
  return (
    request.method === "GET" &&
    !isCaptureRenderRequest(request) &&
    isHtmlContentType(contentType) &&
    typeof size === "number" &&
    size > 0 &&
    size <= MAX_RAVI_CHAT_SCAN_BYTES
  );
}

/**
 * Page chat rooms on a served HTML page: `<ravi-chat>` becomes the room's
 * iframe (or a note when chat is off for this viewer), and a chat-enabled
 * page gets the dock the bar entry and the guest button open.
 */
function injectPageChatRoom(
  html: string,
  request: Request,
  env: PagesWorkerEnv,
  resolved: ResolveOkResponse,
  enabled: boolean,
): string {
  const url = new URL(request.url);
  const chatOrigin = parsedChatOrigin(env)?.origin ?? null;
  const chatPath = "/_ravi/chat";
  const replaced = replaceRaviChatTags(html, {
    excluded: !pagesAiEnabled(env),
    enabled,
    path: url.pathname,
    chatPath,
    chatOrigin,
    host: url.hostname,
    loginUrl: pagesAuthStartUrl(env, url.toString()),
    signedIn: Boolean(pagesSessionFromRequest(request)),
  });
  if (!enabled) return replaced;
  const dock = chatDockSnippet({
    chatPath,
    chatOrigin,
    voiceUrl: "/_ravi/page-chat",
    peekUnread: Boolean(resolved.toolbar?.enabled),
    barId: resolved.toolbar?.enabled ? "ravi-pages-toolbar" : null,
  });
  return replaced.match(/<\/body\s*>/i) ? replaced.replace(/<\/body\s*>/i, `${dock}</body>`) : `${replaced}${dock}`;
}

function usageEventsForServedObject(
  request: Request,
  resolved: ResolveOkResponse,
  usageContext: PagesUsageContext,
  response: Response,
): PagesUsageEvent[] {
  const base = usageBase(request, resolved, usageContext);
  if (!base) return [];

  const visibility = resolvedVisibility(resolved);
  const events: PagesUsageEvent[] = [
    {
      ...base,
      eventType: "pages.request_served",
      metricKey: visibility === "public" ? "pages.requests.public" : "pages.requests.private",
      quantity: 1,
      unit: "count",
      measurementsJson: {
        method: request.method,
        statusCode: response.status,
      },
      idempotencyKey: `${usageContext.requestId}:request_served`,
    },
  ];

  const bytesServed = request.method === "HEAD" ? 0 : resolvedSizeBytes(resolved, response);
  if (bytesServed > 0) {
    events.push({
      ...base,
      eventType: "pages.bytes_served",
      metricKey: "pages.bytes_served",
      quantity: bytesServed,
      unit: "bytes",
      measurementsJson: {
        bytesServed,
        method: request.method,
        statusCode: response.status,
      },
      idempotencyKey: `${usageContext.requestId}:bytes_served`,
    });
  }

  if (usageContext.usedFallback) {
    events.push({
      ...base,
      eventType: "pages.resolve_fallback",
      metricKey: "pages.resolve.fallbacks",
      quantity: 1,
      unit: "count",
      measurementsJson: {
        fallbackResolves: 1,
      },
      metadataJson: compactRecord({
        edgeMissReason: usageContext.edgeMissReason,
      }),
      idempotencyKey: `${usageContext.requestId}:resolve_fallback`,
    });
  }

  if (visibility !== "public" && usageContext.pagesSessionUsed) {
    events.push({
      ...base,
      eventType: "pages.private_auth_check",
      metricKey: "pages.private_auth_checks",
      quantity: 1,
      unit: "count",
      measurementsJson: {
        privateAuthChecks: 1,
      },
      idempotencyKey: `${usageContext.requestId}:private_auth_check`,
    });
  }

  return events;
}

function usageEventsForEdgeError(
  request: Request,
  resolved: ResolveOkResponse,
  usageContext: PagesUsageContext,
  code: string,
  statusCode: number,
): PagesUsageEvent[] {
  const base = usageBase(request, resolved, usageContext);
  if (!base) return [];

  return [
    {
      ...base,
      eventType: "pages.edge_error",
      metricKey: "pages.edge.errors",
      quantity: 1,
      unit: "count",
      measurementsJson: {
        edgeErrors: 1,
        statusCode,
      },
      metadataJson: {
        code,
      },
      idempotencyKey: `${usageContext.requestId}:edge_error:${code}`,
    },
  ];
}

function usageBase(
  request: Request,
  resolved: ResolveOkResponse,
  usageContext: PagesUsageContext,
): Omit<PagesUsageEvent, "eventType" | "metricKey" | "quantity" | "unit" | "idempotencyKey"> | null {
  if (!resolved.site?.organizationId) return null;
  const url = new URL(request.url);
  const visibility = resolvedVisibility(resolved);
  return {
    organizationId: resolved.site.organizationId,
    projectId: resolved.site.projectId ?? null,
    siteId: resolved.site.id ?? null,
    releaseId: resolved.release?.id ?? null,
    routeId: resolved.route?.id ?? null,
    artifactId: resolved.artifact?.id ?? null,
    artifactVersionId: resolved.artifact?.versionId ?? null,
    assetId: resolved.object.assetId ?? null,
    source: "pages_worker",
    dimensionsJson: compactRecord({
      service: "pages",
      host: url.hostname,
      requestPath: url.pathname,
      routePath: resolved.route?.path,
      routeMatchType: resolved.route?.matchType,
      assetPath: resolved.object.path,
      contentType: resolved.object.contentType,
      cache: resolved.object.cache,
      visibility,
      resolver: usageContext.resolver,
    }),
    measurementsJson: {},
    evidenceJson: compactRecord({
      resolver: usageContext.resolver,
    }),
    metadataJson: {},
    requestId: usageContext.requestId,
    occurredAt: new Date().toISOString(),
  };
}

function queueUsageEvents(
  env: PagesWorkerEnv,
  ctx: PagesWorkerExecutionContext | undefined,
  events: PagesUsageEvent[],
): void {
  if (events.length === 0) return;
  const promise = dispatchUsageEvents(env, events).catch(() => undefined);
  if (ctx) {
    ctx.waitUntil(promise);
    return;
  }
  void promise;
}

async function dispatchUsageEvents(env: PagesWorkerEnv, events: PagesUsageEvent[]): Promise<void> {
  if (env.RAVI_PAGES_USAGE_QUEUE) {
    await env.RAVI_PAGES_USAGE_QUEUE.send({
      schemaVersion: 1,
      source: "pages_worker",
      requestId: events[0]?.requestId ?? crypto.randomUUID(),
      enqueuedAt: new Date().toISOString(),
      events,
    });
    return;
  }

  if (!env.RAVI_PAGES_CONTROL_TOKEN) return;
  await sendUsageEvents(env, events);
}

async function flushUsageQueueBatch(batch: PagesUsageQueueBatch, env: PagesWorkerEnv): Promise<void> {
  const messages = batch.messages.map((message) => parseUsageQueueMessage(message.body));
  const validMessages = messages.filter((message): message is PagesUsageQueueMessage => Boolean(message));
  if (validMessages.length === 0) return;

  const events = validMessages.flatMap((message) => message.events);

  try {
    await sendUsageEventsInChunks(env, events);
  } catch (error) {
    if (!(error instanceof UsageDeliveryError) || error.status !== 400) {
      throw error;
    }

    await isolateUsageQueueValidationFailures(env, validMessages);
  }
}

function parseUsageQueueMessage(body: unknown): PagesUsageQueueMessage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Partial<PagesUsageQueueMessage>;
  if (record.schemaVersion !== 1) return null;
  if (record.source !== "pages_worker") return null;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;
  if (typeof record.enqueuedAt !== "string" || record.enqueuedAt.length === 0) return null;
  if (!Array.isArray(record.events)) return null;
  return record as PagesUsageQueueMessage;
}

async function isolateUsageQueueValidationFailures(
  env: PagesWorkerEnv,
  messages: PagesUsageQueueMessage[],
): Promise<void> {
  for (const message of messages) {
    try {
      await sendUsageEventsInChunks(env, message.events);
    } catch (error) {
      if (error instanceof UsageDeliveryError && error.status === 400) {
        console.error("Dropping invalid Pages usage queue message", {
          requestId: message.requestId,
          eventCount: message.events.length,
        });
        continue;
      }
      throw error;
    }
  }
}

async function sendUsageEventsInChunks(env: PagesWorkerEnv, events: PagesUsageEvent[]): Promise<void> {
  for (let index = 0; index < events.length; index += MAX_USAGE_EVENTS_PER_INGEST_BATCH) {
    await sendUsageEvents(env, events.slice(index, index + MAX_USAGE_EVENTS_PER_INGEST_BATCH));
  }
}

async function sendUsageEvents(env: PagesWorkerEnv, events: PagesUsageEvent[]): Promise<void> {
  if (!env.RAVI_PAGES_CONTROL_TOKEN) throw new UsageDeliveryError("usage_control_token_missing");

  let endpoint: URL;
  try {
    endpoint = new URL(env.RAVI_PAGES_USAGE_PATH ?? DEFAULT_USAGE_PATH, env.RAVI_CONSOLE_API_URL);
  } catch {
    throw new UsageDeliveryError("usage_endpoint_invalid");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "ravi-pages-worker",
      "x-request-id": events[0]?.requestId ?? crypto.randomUUID(),
    },
    body: JSON.stringify({ events }),
  });

  if (!response.ok) {
    throw new UsageDeliveryError("usage_ingest_failed", response.status);
  }
}

class UsageDeliveryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UsageDeliveryError";
  }
}

function resolvedVisibility(resolved: ResolveOkResponse): PageVisibility {
  if (resolved.route?.visibility && resolved.route.visibility !== "public") return resolved.route.visibility;
  if (resolved.site?.visibility && resolved.site.visibility !== "public") return resolved.site.visibility;
  if (resolved.object.cache === "private" || resolved.object.cache === "no-store") return "private";
  return "public";
}

function resolvedSizeBytes(resolved: ResolveOkResponse, response: Response): number {
  if (typeof resolved.object.sizeBytes === "number" && Number.isFinite(resolved.object.sizeBytes) && resolved.object.sizeBytes > 0) {
    return Math.trunc(resolved.object.sizeBytes);
  }
  const contentLength = response.headers.get("content-length");
  if (!contentLength) return 0;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function isFinalR2Key(resolved: ResolveOkResponse): boolean {
  const key = resolved.object.r2Key;
  const organizationId = resolved.site?.organizationId;
  const projectId = resolved.site?.projectId;
  const artifactId = resolved.artifact?.id;
  const versionId = resolved.artifact?.versionId;
  if (!organizationId || !projectId || !artifactId || !versionId) return false;
  const prefix = `org/${organizationId}/project/${projectId}/artifact/${artifactId}/version/${versionId}/`;
  if (key.startsWith(prefix) && key.length > prefix.length) return true;

  const objectPath = resolved.object.path;
  if (!objectPath) return false;

  const marker = `/artifact/${artifactId}/version/${versionId}/`;
  const markerIndex = key.indexOf(marker);
  if (markerIndex < 0) return false;

  const ownerPrefix = key.slice(0, markerIndex);
  const finalPath = key.slice(markerIndex + marker.length);
  return /^org\/[^/]+\/project\/[^/]+$/.test(ownerPrefix) && finalPath === objectPath;
}

function cacheControlFor(cache: ResolveOkResponse["object"]["cache"], r2CacheControl: string | undefined): string {
  if (cache === "immutable") {
    return IMMUTABLE_CACHE;
  }

  if (cache === "entrypoint" || cache === "html") {
    return ENTRYPOINT_CACHE;
  }

  if (cache === "private" || cache === "no-store") {
    return NO_STORE_CACHE;
  }

  return r2CacheControl ?? ENTRYPOINT_CACHE;
}

/**
 * Page Chat opens the page inside its frame on the same origin, so HTML it
 * serves may be framed by this origin only, never by another site.
 */
function isPageChatResponse(request: Request, resolved: ResolveOkResponse, contentType: string) {
  return (
    request.method !== "HEAD" &&
    !isCaptureRenderRequest(request) &&
    isHtmlContentType(contentType) &&
    Boolean((resolved.toolbar?.enabled && resolved.toolbar.pageChat?.enabled) || resolved.guestChat?.enabled)
  );
}

/**
 * The guest entry to Page Chat: one floating "Falar com o assistente" link
 * that opens the Page Chat frame on this page, like the toolbar's talk link.
 * It lives in a shadow root so page CSS cannot restyle it, keeps a visible
 * focus ring, and animates only without prefers-reduced-motion. Pure ASCII,
 * no backticks or dollar-brace sequences.
 */
function injectGuestChatButton(html: string) {
  const snippet = guestChatButtonSnippet();
  return html.match(/<\/body\s*>/i) ? html.replace(/<\/body\s*>/i, `${snippet}</body>`) : `${html}${snippet}`;
}

function guestChatButtonSnippet() {
  const css = [
    ":host{all:initial}",
    "a{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:inline-flex;align-items:center;gap:8px;" +
      "min-height:44px;padding:0 18px;border-radius:999px;background:#111;color:#fff;text-decoration:none;" +
      "font:600 15px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.25);border:2px solid #fff}",
    "a:hover{background:#333}",
    "a:focus-visible{outline:3px solid #2563eb;outline-offset:3px}",
    "svg{width:18px;height:18px;flex:none}",
    "@media (prefers-reduced-motion:no-preference){a{transition:background-color .15s ease,transform .15s ease}a:hover{transform:translateY(-1px)}}",
    "@media print{a{display:none}}",
  ].join("");
  const script = [
    "(function(){",
    "var current=document.currentScript;",
    // Inside the Page Chat frame the frame's own panel replaces this button.
    "try{if(window.parent!==window&&window.parent.__raviPageChatShell){if(current)current.remove();return;}}catch(e){}",
    "if(document.getElementById('ravi-page-guest-chat')){if(current)current.remove();return;}",
    "var host=document.createElement('div');host.id='ravi-page-guest-chat';",
    "var root=host.attachShadow?host.attachShadow({mode:'closed'}):host;",
    "var style=document.createElement('style');style.textContent=" + JSON.stringify(css) + ";root.appendChild(style);",
    "var link=document.createElement('a');link.setAttribute('aria-label','Falar com o assistente');",
    "link.innerHTML='<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"9\" y=\"2\" width=\"6\" height=\"12\" rx=\"3\"/><path d=\"M5 10a7 7 0 0 0 14 0M12 17v5\"/></svg>';",
    "var label=document.createElement('span');label.textContent='Falar com o assistente';link.appendChild(label);",
    // The frame reopens this same page inside it, so the conversation survives navigation.
    "var href=function(){return '/_ravi/page-chat?path='+encodeURIComponent(location.pathname+location.search+location.hash);};",
    // With the chat dock on the page the button opens the conversation panel; voice is a button inside it.
    "link.href=href();link.addEventListener('click',function(e){var dock=window.__raviChatDock;if(dock){e.preventDefault();dock.toggle(link);return;}link.href=href();});",
    "root.appendChild(link);(document.body||document.documentElement).appendChild(host);",
    "if(current)current.remove();",
    "})();",
  ].join("");
  return `<script data-ravi-page-guest-chat="1">${script.replace(/</g, "\\u003c")}</script>`;
}

function applyDefaultSecurityHeaders(
  headers: Headers,
  contentType: string,
  browserPermissions?: BrowserPermissions,
  options: { allowSameOriginFrame?: boolean } = {},
) {
  headers.set("x-content-type-options", "nosniff");
  // Separate subdomains remain separate code trust domains even for legacy
  // document.domain relaxation, before any customer script executes.
  headers.set("origin-agent-cluster", "?1");
  if (!headers.has("referrer-policy")) headers.set("referrer-policy", DEFAULT_REFERRER_POLICY);
  if (!headers.has("permissions-policy")) {
    headers.set("permissions-policy", permissionsPolicy(browserPermissions));
  }

  if (!isHtmlContentType(contentType)) return;
  if (!headers.has("content-security-policy")) {
    headers.set(
      "content-security-policy",
      options.allowSameOriginFrame ? DEFAULT_HTML_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : DEFAULT_HTML_CSP,
    );
  }
  if (!headers.has("x-frame-options")) headers.set("x-frame-options", options.allowSameOriginFrame ? "SAMEORIGIN" : "DENY");
}

function permissionsPolicy(browserPermissions?: BrowserPermissions) {
  if (browserPermissions?.deviceMotion !== "self") return DEFAULT_PERMISSIONS_POLICY;
  return DEFAULT_PERMISSIONS_POLICY
    .replace("accelerometer=()", "accelerometer=(self)")
    .replace("gyroscope=()", "gyroscope=(self)");
}

function browserPermissionsProjection(input: unknown): { browserPermissions?: BrowserPermissions } {
  const browserPermissions = record(input);
  return browserPermissions.deviceMotion === "self"
    ? { browserPermissions: { deviceMotion: "self" } }
    : {};
}

function isHtmlContentType(contentType: string) {
  return contentType.split(";")[0]?.trim().toLowerCase() === "text/html";
}

function isToolbarEligibleEdgeFile(file: EdgeManifestFile) {
  return isHtmlContentType(file.contentType ?? "") || file.path.toLowerCase().endsWith(".html");
}

function injectPagesToolbar(html: string, env: PagesWorkerEnv, resolved: ResolveOkResponse) {
  const snippet = pagesToolbarSnippet(env, resolved);
  if (!snippet) return html;
  return html.match(/<\/body\s*>/i) ? html.replace(/<\/body\s*>/i, `${snippet}</body>`) : `${html}${snippet}`;
}

function pagesToolbarSnippet(env: PagesWorkerEnv, resolved: ResolveOkResponse) {
  const toolbar = resolved.toolbar;
  const siteId = toolbar?.siteId ?? resolved.site?.id;
  const projectId = toolbar?.projectId ?? resolved.site?.projectId;
  if (!toolbar?.enabled || !siteId || !projectId) return "";

  const consoleUrl = consolePageUrl(env, projectId, siteId);
  const data = {
    commentsUrl: "/_ravi/operator/comments",
    consoleUrl,
    host: toolbar.host ?? resolved.site?.id ?? "Ravi Page",
    path: toolbar.path ?? resolved.route?.path ?? "/",
    passwordUrl: "/_ravi/operator/password",
    releasesUrl: "/_ravi/operator/releases",
    visibilityUrl: "/_ravi/operator/visibility",
    pageChatUrl: pagesAiEnabled(env) && toolbar.pageChat?.enabled ? "/_ravi/page-chat" : null,
    chatUrl: pagesAiEnabled(env) && toolbar.pageChat?.enabled ? "/_ravi/chat" : null,
    visibility: toolbar.effectiveVisibility ?? resolvedVisibility(resolved),
    release: toolbar.releaseNumber ?? resolved.release?.number ?? null,
    version: toolbar.artifactVersionNumber ?? resolved.artifact?.versionNumber ?? null,
  };
  // The page may declare a non-UTF-8 charset, so the emitted script stays pure ASCII: "<" (no
  // "</script>" breakout), every non-ASCII character and U+2028/U+2029 are escaped in the data.
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

  // Operator bar: a thin dark bar fixed to the top edge (36px with a fine pointer from 600px wide,
  // 44px on touch and phones). While it is expanded it pushes the page down (html margin-top) and
  // moves the page's own pinned top chrome below it; minimizing removes every offset and leaves a
  // small handle on the top edge. Pins, the composer and thread cards live outside the shadow root.
  // Keep this script free of backticks and dollar-brace sequences: it sits inside a template literal.
  const script = `
(() => {
  const current = document.currentScript;
  const d = ${json};
  // Inside the Page Chat frame the frame's own bar replaces this one.
  try {
    if (window.parent !== window && window.parent.__raviPageChatShell) {
      if (current) current.remove();
      return;
    }
  } catch (error) {}
  if (document.getElementById("ravi-pages-toolbar")) {
    if (current) current.remove();
    return;
  }

  const root = document.documentElement;
  const mq = (query) => Boolean(window.matchMedia && window.matchMedia(query).matches);
  const coarse = () => mq("(pointer: coarse)");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  const FONT = "ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
  const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  // Elements injected outside the shadow root start from all:initial so page CSS cannot leak in.
  const BASE = "all:initial;direction:ltr;unicode-bidi:isolate;box-sizing:border-box;font:inherit;color:inherit;visibility:inherit;";
  const MIN_KEY = "ravi-pages-toolbar:min";
  const VIS = { public: "P\\u00fablica", password: "Com senha", protected_link: "Protegida", private: "Privada" };
  const VIS_SHORT = { public: "P\\u00fablica", password: "Senha", protected_link: "Link", private: "Privada" };
  const VIS_NOW = { public: "p\\u00fablica", password: "com senha", protected_link: "protegida", private: "privada" };
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[onclick],[tabindex]:not([tabindex="-1"])';
  function svg(paths, size, cls) {
    const s = String(size || 16);
    return '<svg' + (cls ? ' class="' + cls + '"' : "") + ' viewBox="0 0 24 24" width="' + s + '" height="' + s + '" style="display:block;flex:none;width:' + s + "px;height:" + s + 'px" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + "</svg>";
  }
  const BUBBLE = '<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L3.5 20l1.4-5A8 8 0 1 1 20.5 11.5Z"/>';
  const P = {
    down: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    bubble: BUBBLE,
    add: BUBBLE + '<path d="M12.4 8v7M8.9 11.5h7"/>',
    more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
    refresh: '<path d="M20 12a8 8 0 0 1-14.3 4.9"/><path d="M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.5H14"/><path d="M5.5 21v-4.5H10"/>',
    ext: '<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    aim: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    trash: '<path d="M4 7h16M10 7V4.5h4V7M6.5 7l.8 12.5h9.4l.8-12.5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  };

  const css = [
    ":host{all:initial;direction:ltr;unicode-bidi:isolate}",
    "*,*::before,*::after{box-sizing:border-box}",
    ".rv{--rv-h:44px;font-family:" + FONT + ";font-size:13px;line-height:1.25;color:#f4f4f5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}",
    "button,select,input,a{font:inherit;color:inherit;margin:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation}",
    ":focus{outline:none}",
    ":focus-visible{outline:2px solid #60a5fa;outline-offset:2px}",
    ".sr{position:fixed;top:0;left:0;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
    ".scrim{position:fixed;inset:0;z-index:2147483646;display:none;background:rgba(9,9,11,.42)}",
    ".bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;height:calc(44px + env(safe-area-inset-top,0px));padding:env(safe-area-inset-top,0px) max(6px,env(safe-area-inset-right,0px)) 0 max(6px,env(safe-area-inset-left,0px));background:#111318;border-bottom:1px solid #262a33;box-shadow:0 2px 10px rgba(0,0,0,.16)}",
    ".row{display:flex;align-items:center;gap:4px;height:100%;min-width:0}",
    ".sel{display:none}",
    ".selecting .main{display:none}",
    ".selecting .sel{display:flex}",
    ".selecting .bar{background:#1d4ed8;border-bottom-color:#1e40af}",
    ".min .bar{display:none}",
    ".brand{display:inline-flex;align-items:center;gap:7px;flex:none;min-width:0;padding:0 4px 0 2px;color:#fff;font-size:14px;font-weight:650;letter-spacing:-.01em;white-space:nowrap}",
    ".logo{display:grid;place-items:center;flex:none;width:26px;height:26px;border-radius:7px;background:#fff;color:#111318;font-size:13px;font-weight:800;line-height:1}",
    ".vis{position:relative;display:inline-flex;align-items:center;gap:7px;flex:none;height:34px;padding:0 9px 0 11px;border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(255,255,255,.06);color:#fff;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer}",
    ".vis:has(select:focus-visible){outline:2px solid #60a5fa;outline-offset:2px}",
    "@supports not selector(:has(a)){.vis:focus-within{outline:2px solid #60a5fa;outline-offset:2px}}",
    ".vis select{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;border-radius:999px;opacity:0;font-size:16px;cursor:pointer;-webkit-appearance:none;appearance:none}",
    ".vis.busy{opacity:.6}",
    ".vis.busy select{cursor:progress}",
    ".vs{display:none}",
    ".dot{flex:none;width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2)}",
    ".vis[data-v=password] .dot{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.22)}",
    ".vis[data-v=protected_link] .dot{background:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.22)}",
    ".vis[data-v=private] .dot{background:#a1a1aa;box-shadow:0 0 0 3px rgba(161,161,170,.22)}",
    ".vchev{color:#9ca3af}",
    ".status{flex:1 1 auto;min-width:0;margin:0 10px;color:#a1a1aa;font-size:12px;font-weight:500;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}",
    ".status.ok{color:#86efac}",
    ".status.err{color:#fca5a5}",
    ".status.busy{color:#bfdbfe}",
    ".status.float{position:fixed;top:calc(var(--rv-h) + 8px);left:50%;transform:translateX(-50%);width:max-content;max-width:min(560px,calc(100vw - 16px));margin:0;padding:9px 12px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:#17191f;color:#f4f4f5;font-size:13px;line-height:1.35;text-align:left;white-space:normal;overflow:visible;box-shadow:0 10px 30px rgba(0,0,0,.3);cursor:pointer}",
    ".status.float.err{border-color:rgba(248,113,113,.55);color:#fecaca}",
    ".right{display:inline-flex;align-items:center;gap:4px;flex:none;margin-left:auto}",
    ".btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:40px;min-width:38px;margin:0;padding:0 8px;border:0;border-radius:10px;background:transparent;color:#e4e4e7;font-size:14px;font-weight:600;line-height:1;white-space:nowrap;text-decoration:none;cursor:pointer}",
    ".btn:disabled{opacity:.45;cursor:default}",
    ".btn:active{background:rgba(255,255,255,.14)}",
    ".btn[aria-expanded=true]{background:rgba(255,255,255,.12);color:#fff}",
    ".icon{width:38px;padding:0;color:#a1a1aa}",
    ".count{gap:5px;padding:0 8px;color:#d4d4d8;font-variant-numeric:tabular-nums}",
    ".count b{font-weight:650;color:#f4f4f5}",
    ".count .ic{color:#9ca3af}",
    ".count.err b{color:#fca5a5}",
    ".cl{display:none;font-weight:500;color:#a1a1aa}",
    ".primary{width:42px;height:36px;min-width:0;padding:0;border-radius:10px;background:#fff;color:#111318}",
    ".chat{gap:7px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.06);color:#a1a1aa;font-weight:500}",
    ".chat .ic{color:#d4d4d8}",
    ".chat[aria-expanded=true]{border-color:rgba(255,255,255,.4);background:rgba(255,255,255,.14);color:#fff}",
    ".udot{position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;background:#60a5fa;box-shadow:0 0 0 2px #111318}",
    ".udot[hidden]{display:none}",
    ".primary:active{background:#d4d4d8}",
    ".lbl{display:none}",
    ".chip{display:none;flex:none;margin:0 2px;padding:4px 7px;border:1px solid rgba(255,255,255,.14);border-radius:6px;color:#a1a1aa;font:600 11px/1 " + MONO + ";white-space:nowrap}",
    ".console{display:none;color:#d4d4d8}",
    ".console .ic{color:#9ca3af}",
    ".sel{align-items:center;gap:10px;height:100%;padding:0 0 0 8px;color:#fff}",
    ".sel-t{flex:1 1 auto;min-width:0;font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".kbd{display:none;flex:none;padding:3px 6px;border:1px solid rgba(255,255,255,.45);border-radius:5px;color:#dbeafe;font:600 11px/1 " + MONO + "}",
    ".cancel{padding:0 16px;background:#fff;color:#1d4ed8;font-weight:650}",
    ".cancel:active{background:#bfdbfe}",
    ".menu{position:absolute;top:calc(100% + 6px);right:8px;display:none;width:300px;max-width:calc(100vw - 16px);max-height:calc(100vh - var(--rv-h) - 16px);overflow:auto;overscroll-behavior:contain;padding:6px;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:#17191f;color:#f4f4f5;box-shadow:0 18px 44px rgba(0,0,0,.36),0 2px 6px rgba(0,0,0,.2)}",
    ".menu-open .menu{display:block}",
    ".mh{padding:8px 10px 10px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,.08)}",
    ".mh-host{color:#fff;font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".mh-meta{margin-top:4px;color:#a1a1aa;font-size:12px;line-height:1.4}",
    ".item{display:flex;align-items:center;gap:12px;width:100%;height:46px;margin:0;padding:0 10px;border:0;border-radius:9px;background:transparent;color:#f4f4f5;font-size:15px;font-weight:550;text-align:left;text-decoration:none;cursor:pointer}",
    ".item .ic{color:#a1a1aa}",
    ".item:active{background:rgba(255,255,255,.12)}",
    ".rl{display:none;padding:0 2px 4px}",
    ".rl-open .list,.rl-open .mh{display:none}",
    ".rl-open .rl{display:block}",
    ".rl-head{display:flex;align-items:center;gap:4px;margin:0 0 4px;padding:0 4px 6px;border-bottom:1px solid rgba(255,255,255,.08)}",
    ".rl-t{color:#fff;font-size:14px;font-weight:700}",
    ".rl-row{padding:9px 8px}",
    ".rl-row+.rl-row{border-top:1px solid rgba(255,255,255,.06)}",
    ".rl-top{display:flex;align-items:center;gap:8px}",
    ".rl-info{flex:1 1 auto;min-width:0}",
    ".rl-name{display:flex;align-items:center;gap:7px;min-width:0}",
    ".rl-num,.rl-live,.rl-bad{flex:none}",
    ".rl-num{color:#fff;font:650 13px/1.2 " + MONO + "}",
    ".rl-by{min-width:0;color:#d4d4d8;font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".rl-live,.rl-bad{padding:2px 7px;border-radius:999px;font-size:11px;font-weight:650}",
    ".rl-live{background:rgba(34,197,94,.16);color:#86efac}",
    ".rl-bad{background:rgba(239,68,68,.16);color:#fca5a5}",
    ".rl-meta{margin-top:3px;color:#a1a1aa;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".rl-acts{display:flex;flex:none;gap:6px}",
    ".rl-acts .btn{height:34px;padding:0 10px;background:rgba(255,255,255,.07);font-size:13px}",
    ".rl-acts .btn[aria-expanded=true]{background:#fff;color:#111318}",
    ".rl-detail{margin-top:9px;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:#0d0e12}",
    ".rl-note{margin:0 0 8px;color:#a1a1aa;font-size:12px;line-height:1.45}",
    ".rl-note:empty{display:none}",
    ".rl-note.err{color:#fca5a5}",
    ".rl-sum{margin:0 0 4px;color:#e4e4e7;font-size:12.5px;font-weight:600;line-height:1.4}",
    ".rt{margin-top:10px}",
    ".rt-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px}",
    ".pill{padding:2px 6px;border-radius:5px;font-size:11px;font-weight:650}",
    ".pill.changed{background:rgba(245,158,11,.16);color:#fcd34d}",
    ".pill.added{background:rgba(34,197,94,.16);color:#86efac}",
    ".pill.removed{background:rgba(239,68,68,.16);color:#fca5a5}",
    ".rt-p{color:#fff;font-family:" + MONO + ";word-break:break-all}",
    ".rt-here{color:#93c5fd;font-size:11px;font-weight:600}",
    ".rt-n{color:#a1a1aa;font-size:11.5px}",
    ".fl{margin:6px 0 0;padding:0;list-style:none}",
    ".fb{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;margin:0;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:#e4e4e7;font:12px/1.3 " + MONO + ";text-align:left;cursor:pointer}",
    ".fb:disabled{opacity:.8;cursor:default}",
    ".fb[aria-expanded=true]{background:rgba(255,255,255,.07)}",
    ".fs{flex:none;width:14px;font-weight:700;text-align:center}",
    ".fs.added{color:#86efac}.fs.removed{color:#fca5a5}.fs.changed{color:#fcd34d}",
    ".fp{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".fz{flex:none;color:#71717a;font-size:11px}",
    ".df{max-height:min(360px,50vh);margin:4px 0 8px;overflow:auto;overscroll-behavior:contain;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:#050506;font:11.5px/1.55 " + MONO + "}",
    ".dl{display:flex;min-width:max-content;white-space:pre}",
    ".dl.add{background:rgba(34,197,94,.14)}",
    ".dl.del{background:rgba(239,68,68,.15)}",
    ".dn{flex:none;width:36px;padding:0 6px 0 0;color:#52525b;text-align:right;user-select:none;-webkit-user-select:none}",
    ".dsg{flex:none;width:16px;color:#71717a;text-align:center;user-select:none;-webkit-user-select:none}",
    ".dl.add .dsg{color:#86efac}.dl.del .dsg{color:#fca5a5}",
    ".dt{padding-right:12px;color:#e4e4e7}",
    ".dgap{padding:3px 10px;color:#71717a;background:rgba(255,255,255,.03);white-space:normal;font-family:" + FONT + ";font-size:12px}",
    ".rl-confirm{display:flex;gap:8px;margin:0 0 10px}",
    ".rl-after{padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}",
    ".rl-confirm .btn{flex:1 1 0;height:40px;background:rgba(255,255,255,.08);color:#f4f4f5}",
    ".rl-confirm .go{background:#fff;color:#111318}",
    ".chip{background:transparent;cursor:pointer}",
    ".pw{display:none;margin:0;padding:6px 8px 8px}",
    ".pw-open .list{display:none}",
    ".pw-open .pw{display:block}",
    ".pw-t{margin:2px 0 10px;color:#fff;font-size:15px;font-weight:700}",
    ".pw label{display:block;margin-bottom:6px;color:#d4d4d8;font-size:13px;font-weight:600}",
    ".pw input{display:block;width:100%;height:44px;margin:0;padding:0 12px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:#0b0c10;color:#fff;font-size:16px}",
    ".pw input:focus{outline:2px solid #60a5fa;outline-offset:1px}",
    ".hint{margin:8px 0 0;color:#a1a1aa;font-size:12px;line-height:1.4}",
    ".hint.err{color:#fca5a5}",
    ".pw-acts{display:flex;gap:8px;margin-top:12px}",
    ".pw-acts .btn{flex:1 1 0;height:44px;background:rgba(255,255,255,.08);color:#f4f4f5}",
    ".pw-acts .go{background:#fff;color:#111318}",
    ".handle{position:fixed;top:0;left:calc(50% - 24px);z-index:2147483647;display:none;align-items:center;gap:3px;height:calc(30px + env(safe-area-inset-top,0px));margin:0;padding:env(safe-area-inset-top,0px) 7px 0 6px;border:1px solid rgba(255,255,255,.32);border-top:0;border-radius:0 0 10px 10px;background:#111318;color:#d4d4d8;box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer}",
    ".handle .logo{width:18px;height:18px;border-radius:5px;font-size:10px}",
    ".min .handle{display:inline-flex}",
    "@media (min-width:600px){.lbl,.cl{display:inline}.primary{width:auto;padding:0 12px 0 10px}.chat{min-width:168px;justify-content:flex-start;padding:0 12px 0 10px}}",
    "@media (min-width:860px){.console{display:inline-flex}}",
    "@media (min-width:960px){.chip{display:inline-block}}",
    "@media (min-width:600px){.rl-open .menu{width:480px}}",
    "@media (max-width:599px){" +
      ".status{position:fixed;top:calc(var(--rv-h) + 8px);left:8px;right:8px;margin:0;padding:10px 12px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:#17191f;color:#f4f4f5;font-size:13px;line-height:1.35;text-align:left;white-space:normal;overflow:visible;box-shadow:0 10px 30px rgba(0,0,0,.3);cursor:pointer}" +
      ".status:empty{display:none}" +
      ".status.ok{color:#f4f4f5;border-color:rgba(74,222,128,.45)}" +
      ".status.err{color:#fecaca;border-color:rgba(248,113,113,.55)}" +
      ".status.busy{color:#f4f4f5;border-color:rgba(96,165,250,.5)}" +
      ".menu-open .status{top:auto;bottom:max(12px,env(safe-area-inset-bottom,0px))}" +
      ".menu{top:calc(100% + 1px);left:0;right:0;width:auto;max-width:none;max-height:calc(100vh - var(--rv-h) - 24px);padding:4px 8px 10px;border:0;border-top:1px solid rgba(255,255,255,.06);border-radius:0 0 16px 16px}" +
      ".menu-open .scrim{display:block}" +
    "}",
    "@media (pointer:fine) and (min-width:600px){" +
      ".bar{height:calc(36px + env(safe-area-inset-top,0px));padding-left:max(8px,env(safe-area-inset-left,0px));padding-right:max(8px,env(safe-area-inset-right,0px))}" +
      ".btn{height:28px;min-width:28px;border-radius:7px;font-size:13px}" +
      ".icon{width:28px;padding:0}" +
      ".primary{height:26px;padding:0 10px 0 8px;border-radius:7px}" +
      ".brand{gap:8px;font-size:13px}" +
      ".logo{width:20px;height:20px;border-radius:5px;font-size:11px}" +
      ".vis{height:26px;gap:6px;padding:0 8px 0 10px;font-size:12.5px}" +
      ".dot{width:7px;height:7px}" +
      ".sel-t{font-size:13px}.kbd{display:inline-block}.cancel{padding:0 12px}" +
      ".item{height:34px;gap:10px;border-radius:7px;font-size:13px}" +
      ".mh-host{font-size:13px}.pw-t{font-size:14px}" +
      ".rl-acts .btn{height:26px;padding:0 8px;font-size:12.5px}.rl-confirm .btn{height:32px}.fb{min-height:24px}" +
      ".pw input{height:34px;font-size:13px}.pw-acts .btn{height:32px}" +
      ".handle{height:calc(22px + env(safe-area-inset-top,0px))}.handle .logo{width:15px;height:15px;border-radius:4px;font-size:9px}" +
    "}",
    "@media (hover:hover){" +
      ".btn:hover{background:rgba(255,255,255,.09);color:#fff}.icon:hover{color:#fff}" +
      ".primary:hover{background:#e4e4e7;color:#111318}.vis:hover{background:rgba(255,255,255,.11)}" +
      ".cancel:hover{background:#dbeafe;color:#1d4ed8}.item:hover{background:rgba(255,255,255,.07)}" +
      ".pw-acts .go:hover{background:#e4e4e7;color:#111318}.handle:hover{color:#fff;border-color:rgba(255,255,255,.55)}" +
      ".chip:hover{color:#fff;border-color:rgba(255,255,255,.3)}.fb:hover:not(:disabled){background:rgba(255,255,255,.07)}.rl-confirm .go:hover{background:#e4e4e7;color:#111318}" +
    "}",
    // fitBar steps, applied one by one while the minimize button would overflow the bar.
    ".t1 .name{display:none}",
    ".t2 .chip,.t2 .console{display:none}",
    ".t3 .cl{display:none}",
    ".t4 .row{gap:2px}.t4 .bar{padding-left:4px;padding-right:4px}.t4 .btn{min-width:34px;padding:0 6px}.t4 .icon{width:34px;padding:0}.t4 .primary{width:38px;padding:0}.t4 .lbl{display:none}.t4 .chat{min-width:34px;padding:0 6px}.t4 .vis{gap:7px;padding:0 7px 0 9px}",
    ".t5 .vl{display:none}.t5 .vs{display:inline}",
    ".t6 .count{display:none}",
    "@media (prefers-reduced-motion:no-preference){.menu{animation:rv-in .12s ease-out}}",
    "@keyframes rv-in{from{opacity:0;transform:translateY(-4px)}}",
    "@media print{.rv{display:none}}",
  ].join("");

  const host = document.createElement("div");
  host.id = "ravi-pages-toolbar";
  host.dataset.raviOperatorUi = "toolbar";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const ui = document.createElement("div");
  ui.className = "rv";
  const options = ["public", "password", "protected_link", "private"].map((v) => '<option value="' + v + '">' + VIS[v] + "</option>").join("");
  ui.innerHTML =
    '<div class="scrim" data-k="scrim"></div>' +
    '<div class="bar" data-k="bar" role="region" aria-label="Barra do Ravi Page">' +
      '<div class="row main">' +
        '<span class="brand" role="img" aria-label="Ravi Page" title="Ravi Page"><span class="logo" aria-hidden="true">R</span><span class="name" aria-hidden="true">Ravi Page</span></span>' +
        '<label class="vis" data-k="vis" data-v="public" title="Visibilidade da p&aacute;gina">' +
          '<span class="dot" aria-hidden="true"></span><span class="vl" data-k="vis-label" aria-hidden="true"></span><span class="vs" data-k="vis-short" aria-hidden="true"></span>' + svg(P.down, 14, "vchev") +
          '<select data-k="select" aria-label="Visibilidade da p&aacute;gina">' + options + "</select>" +
        "</label>" +
        '<p class="status" data-k="status" role="status" aria-live="polite"></p>' +
        '<span class="right">' +
          (d.chatUrl ? '<button class="btn chat" type="button" data-k="chat" aria-expanded="false" aria-label="Fale com o Ravi" title="Conversar sobre esta p&aacute;gina">' + svg(P.bubble, 16, "ic") + '<span class="lbl cf">Fale com o Ravi</span><span class="udot" data-k="chat-dot" hidden></span></button>' : "") +
          (d.pageChatUrl ? '<a class="btn talk" data-k="talk" title="Falar com o assistente desta p&aacute;gina">' + svg(P.mic, 18, "ic") + '<span class="lbl">Falar</span></a>' : "") +
          '<button class="btn count" type="button" data-k="comments-next">' + svg(P.bubble, 18, "ic") + '<b data-k="comment-count">&hellip;</b><span class="cl" data-k="count-label"></span></button>' +
          '<button class="btn primary" type="button" data-k="pick" aria-pressed="false" aria-label="Comentar item" title="Comentar um item da p&aacute;gina">' + svg(P.add, 18) + '<span class="lbl">Comentar</span></button>' +
          '<button class="chip" type="button" data-k="release" aria-haspopup="dialog"></button>' +
          '<a class="btn console" data-k="console" target="_blank" rel="noreferrer" title="Abrir no Console (nova aba)">Console' + svg(P.ext, 13, "ic") + "</a>" +
          '<button class="btn icon" type="button" data-k="menu" aria-haspopup="dialog" aria-expanded="false" aria-controls="rv-menu" aria-label="Mais op&ccedil;&otilde;es" title="Mais op&ccedil;&otilde;es">' + svg(P.more, 18) + "</button>" +
          '<button class="btn icon" type="button" data-k="collapse" aria-label="Ocultar barra" title="Ocultar barra">' + svg(P.up, 18) + "</button>" +
        "</span>" +
      "</div>" +
      '<div class="row sel" data-k="sel">' + svg(P.aim, 18) + '<span class="sel-t" data-k="sel-text"></span><span class="kbd" aria-hidden="true">Esc</span><button class="btn cancel" type="button" data-k="pick-cancel">Cancelar</button></div>' +
      '<div class="menu" id="rv-menu" data-k="panel" role="dialog" aria-label="Mais op&ccedil;&otilde;es">' +
        '<div class="mh"><div class="mh-host" data-k="host"></div><div class="mh-meta" data-k="menu-meta"></div></div>' +
        '<div class="list">' +
          '<button class="item" type="button" data-k="manage-password">' + svg(P.lock, 18, "ic") + '<span data-k="manage-password-label"></span></button>' +
          '<button class="item" type="button" data-k="releases">' + svg(P.history, 18, "ic") + "<span>Hist&oacute;rico de releases</span></button>" +
          '<button class="item" type="button" data-k="toggle-pins"><span data-k="toggle-pins-icon"></span><span data-k="toggle-pins-label"></span></button>' +
          '<button class="item" type="button" data-k="refresh">' + svg(P.refresh, 18, "ic") + "<span>Recarregar coment&aacute;rios</span></button>" +
          '<a class="item" data-k="console-menu" target="_blank" rel="noreferrer">' + svg(P.ext, 18, "ic") + "<span>Abrir no Console</span></a>" +
          '<button class="item" type="button" data-k="hide">' + svg(P.up, 18, "ic") + "<span>Ocultar barra</span></button>" +
        "</div>" +
        '<div class="rl" data-k="rl" aria-label="Hist&oacute;rico de releases">' +
          '<div class="rl-head"><button class="btn icon" type="button" data-k="rl-back" aria-label="Voltar ao menu" title="Voltar">' + svg(P.back, 18) + '</button><div class="rl-t">Hist&oacute;rico de releases</div></div>' +
          '<div class="rl-body" data-k="rl-body"></div>' +
        "</div>" +
        '<form class="pw" data-k="password-form" novalidate>' +
          '<div class="pw-t" data-k="password-title"></div>' +
          '<label for="rv-pw">Senha da p&aacute;gina</label>' +
          '<input id="rv-pw" data-k="password-input" type="password" autocomplete="new-password" minlength="8" maxlength="128" aria-describedby="rv-pw-hint">' +
          '<p class="hint" id="rv-pw-hint" data-k="password-hint" aria-live="polite"></p>' +
          '<div class="pw-acts"><button class="btn" type="button" data-k="password-cancel">Cancelar</button><button class="btn go" type="submit" data-k="password-save">Salvar senha</button></div>' +
        "</form>" +
      "</div>" +
    "</div>" +
    '<button class="handle" type="button" data-k="expand" aria-label="Mostrar barra do Ravi Page" title="Mostrar barra do Ravi Page"><span class="logo" aria-hidden="true">R</span>' + svg(P.down, 14) + "</button>" +
    '<div class="sr" data-k="sr" aria-live="polite"></div>';
  shadow.append(style, ui);

  const $ = (k) => shadow.querySelector('[data-k="' + k + '"]');
  const bar = $("bar");
  const scrim = $("scrim");
  const visWrap = $("vis");
  const visLabel = $("vis-label");
  const visShort = $("vis-short");
  const select = $("select");
  const status = $("status");
  const nextBtn = $("comments-next");
  const countEl = $("comment-count");
  const countLabel = $("count-label");
  const pick = $("pick");
  const releaseEl = $("release");
  const link = $("console");
  const talk = $("talk");
  if (talk) {
    // The frame reopens this same page inside it, so the conversation survives navigation.
    const talkHref = () => d.pageChatUrl + "?path=" + encodeURIComponent(location.pathname + location.search + location.hash);
    talk.href = talkHref();
    talk.addEventListener("click", () => {
      talk.href = talkHref();
    });
  }
  const chatBtn = $("chat");
  if (chatBtn) {
    const chatDot = $("chat-dot");
    chatBtn.addEventListener("click", () => {
      const dock = window.__raviChatDock;
      if (dock) dock.toggle(chatBtn);
    });
    const syncChat = (state) => {
      if (!state) return;
      chatBtn.setAttribute("aria-expanded", state.open ? "true" : "false");
      chatDot.hidden = !(state.unread > 0) || state.open;
      chatBtn.setAttribute("aria-label", state.unread > 0 && !state.open ? "Fale com o Ravi (" + state.unread + " novas)" : "Fale com o Ravi");
    };
    window.addEventListener("ravi-chat:state", (event) => syncChat(event.detail));
    if (window.__raviChatDock) syncChat(window.__raviChatDock.state());
  }
  const menuBtn = $("menu");
  const collapseBtn = $("collapse");
  const expandBtn = $("expand");
  const selText = $("sel-text");
  const pickCancel = $("pick-cancel");
  const panel = $("panel");
  const hostEl = $("host");
  const menuMeta = $("menu-meta");
  const managePassword = $("manage-password");
  const managePasswordLabel = $("manage-password-label");
  const togglePins = $("toggle-pins");
  const togglePinsIcon = $("toggle-pins-icon");
  const togglePinsLabel = $("toggle-pins-label");
  const refresh = $("refresh");
  const linkMenu = $("console-menu");
  const hideItem = $("hide");
  const releasesItem = $("releases");
  const rlBack = $("rl-back");
  const rlBody = $("rl-body");
  const passwordForm = $("password-form");
  const passwordTitle = $("password-title");
  const passwordInput = $("password-input");
  const passwordHint = $("password-hint");
  const passwordCancel = $("password-cancel");
  const passwordSave = $("password-save");
  const srEl = $("sr");
  const currentPath = () => location.pathname || d.path || "/";
  const releaseText = () => (d.release ? "r" + d.release : "live") + (d.version ? " \\u00b7 v" + d.version : "");
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  let commentsLoaded = false;
  let commentsFailed = false;
  let commentTotal = null;
  let pinRecords = [];
  let bubble = null;
  let openRec = null;
  let composer = null;
  let composerTarget = null;
  let selecting = false;
  let minimized = false;
  let printing = false;
  let pinsHidden = false;
  let menuOpen = false;
  let pwFromSelect = false;
  let nextIndex = 0;
  let statusTimer = 0;
  let barH = 0;
  let appShell = null;
  let markEl = null;
  let markSoft = false;
  let observer = null;
  let lastWidth = window.innerWidth;
  const shifted = new Map();
  const shells = new Map();
  const benched = new WeakMap();
  let shellsDirty = false;
  let burst = null;

  const rootStyle = getComputedStyle(root);
  const baseMarginTop = parseFloat(rootStyle.marginTop) || 0;
  const basePad = parseFloat(rootStyle.scrollPaddingTop) || 0;
  const offsetStyle = document.createElement("style");
  offsetStyle.dataset.raviOperatorUi = "offset";
  const cursorStyle = document.createElement("style");
  cursorStyle.dataset.raviOperatorUi = "cursor";
  const helperStyle = document.createElement("style");
  helperStyle.dataset.raviOperatorUi = "style";
  helperStyle.textContent =
    "[data-ravi-operator-ui] :focus-visible,[data-ravi-operator-ui]:focus-visible{outline:2px solid #2563eb!important;outline-offset:2px!important}" +
    "[data-ravi-operator-ui] textarea:focus{outline:none!important;border-color:#2563eb!important;box-shadow:0 0 0 3px rgba(37,99,235,.18)!important}" +
    "[data-ravi-operator-ui] textarea::placeholder{color:#94a3b8!important;opacity:1!important}" +
    "@media (hover:hover){.ravi-pages-comment-pin:hover>span{transform:scale(1.1)}" +
    "[data-ravi-btn=icon]:hover{background:#f1f5f9!important;color:#0f172a!important}" +
    "[data-ravi-btn=plain]:hover{background:#f8fafc!important;border-color:rgba(15,23,42,.28)!important}" +
    "[data-ravi-btn=primary]:hover{background:#262a31!important}" +
    "[data-ravi-btn=danger]:hover{background:#b91c1c!important}}" +
    "[data-ravi-btn]:disabled{opacity:.55!important;cursor:progress!important}" +
    "@media (prefers-reduced-motion:reduce){[data-ravi-operator-ui],[data-ravi-operator-ui] *{transition:none!important;animation:none!important}}" +
    "@media print{#ravi-pages-toolbar,[data-ravi-operator-ui]:not(style){display:none!important}}";

  const mark = document.createElement("div");
  mark.dataset.raviOperatorUi = "selection";
  mark.style.cssText = BASE + "display:none;position:absolute;z-index:2147483643;margin:0;pointer-events:none;border:2px solid #2563eb;border-radius:6px;background:rgba(37,99,235,.08);box-shadow:0 0 0 4px rgba(37,99,235,.14)";

  /* Small helpers. */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }
  function make(tag, css, text) {
    const el = document.createElement(tag);
    el.style.cssText = BASE + (css || "");
    if (text != null) el.textContent = text;
    return el;
  }
  function esc(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "");
  }
  function selectorFor(el) {
    if (!el || !el.tagName) return "";
    if (el.id) return "#" + esc(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4 && node !== root) {
      let part = node.tagName.toLowerCase();
      const cls = Array.from(node.classList || []).filter(Boolean).slice(0, 2).map((c) => "." + esc(c)).join("");
      if (cls) part += cls;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }
  function isOperatorElement(el) {
    return Boolean(el && el.closest && el.closest("[data-ravi-operator-ui]"));
  }
  function ownEvent(event) {
    return Boolean(event.composedPath && event.composedPath().includes(host));
  }
  function eventTarget(event) {
    const el = event.target;
    if (!el || el === root || el === document.body || ownEvent(event) || isOperatorElement(el)) return null;
    return el.nodeType === 1 ? el : null;
  }
  function viewportWidth() {
    return root.clientWidth || window.innerWidth;
  }
  function narrowView() {
    return viewportWidth() < 600;
  }
  // Absolute operator elements are placed relative to html's real origin (html may be positioned).
  function docOrigin() {
    const cs = getComputedStyle(root);
    if (cs.position === "static") return { x: 0, y: 0 };
    const r = root.getBoundingClientRect();
    return { x: r.left + window.scrollX + (parseFloat(cs.borderLeftWidth) || 0), y: r.top + window.scrollY + (parseFloat(cs.borderTopWidth) || 0) };
  }
  function placeAt(el, viewportLeft, viewportTop) {
    const o = docOrigin();
    el.style.left = Math.round(viewportLeft + window.scrollX - o.x) + "px";
    el.style.top = Math.round(viewportTop + window.scrollY - o.y) + "px";
  }
  function jumpTo(y) {
    try {
      window.scrollTo({ top: y, left: window.scrollX, behavior: "instant" });
    } catch {
      window.scrollTo(window.scrollX, y);
    }
  }
  function elementRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round((rect.left + window.scrollX) * 100) / 100,
      y: Math.round((rect.top + window.scrollY) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }
  function targetElement(target) {
    if (!target || !target.selector) return null;
    try {
      const el = document.querySelector(target.selector);
      return el && !isOperatorElement(el) ? el : null;
    } catch {
      return null;
    }
  }
  // Stored rects are bar-independent: the bar height is added back when one is used as a fallback.
  function rectFromTarget(target, fallbackIndex) {
    const el = targetElement(target);
    if (el) return elementRect(el);
    const rect = target && target.rect;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      return { x: rect.x, y: rect.y + barH, width: rect.width || 0, height: rect.height || 0 };
    }
    return { x: Math.max(16, viewportWidth() - 110), y: barH + 72 + fallbackIndex * 36, width: 0, height: 0 };
  }

  /* Status: a line in the bar on wide screens, a toast under the bar on phones (and whenever the
     message does not fit the bar). Success clears after 2.6s or on the next action, errors stay 7s. */
  // short: an in-bar variant without the raw code (kept in the tooltip) tried before the toast.
  function say(text, kind, ms, detail, short) {
    clearTimeout(statusTimer);
    status.className = "status" + (kind ? " " + kind : "");
    status.textContent = text || "";
    status.title = text ? text + (detail ? " (" + detail + ")" : "") : "";
    const overflows = () => status.scrollWidth > status.clientWidth + 1;
    if (text && !narrowView() && overflows()) {
      if (short) status.textContent = short;
      if (!short || overflows()) {
        status.textContent = text;
        status.classList.add("float");
      }
    }
    if (text && ms) statusTimer = setTimeout(() => say("", ""), ms);
  }
  const okMsg = (text) => say(text, "ok", 2600);
  const infoMsg = (text) => say(text, "info", 3200);
  const busyMsg = (text) => say(text, "busy", 0);
  const failMsg = (fail) => say(fail.text, "err", 7000, fail.code, fail.short);
  // The card already shows the error inline (a live note): on phones a toast would only cover it.
  const failNear = (fail) => (narrowView() ? say("", "") : failMsg(fail));
  function dropOk() {
    if (status.classList.contains("ok") || status.classList.contains("info")) say("", "");
  }
  // Plain PT-BR first, the raw error code second (in the text when unmapped, else in the tooltip).
  function failure(action, error) {
    const code = error && error.message ? String(error.message) : "";
    const http = error && error.status;
    if (error && error.network) {
      return { text: "Falha de rede ao " + action + ". Tente de novo.", code };
    }
    if (http === 401 || http === 403 || /forbidden|unauthori[sz]ed|permission|not_allowed|denied/i.test(code)) {
      return { text: "Sem permiss\\u00e3o para " + action, code };
    }
    const text = "N\\u00e3o foi poss\\u00edvel " + action;
    return { text: text + (code ? " (" + code + ")" : ""), code: "", short: code ? text : "" };
  }
  function announce(text) {
    srEl.textContent = "";
    setTimeout(() => {
      srEl.textContent = text;
    }, 40);
  }
  // Only a rejected fetch is a network failure; any other error keeps its own code.
  async function requestJson(url, init, fallbackError) {
    let res;
    try {
      res = await fetch(url, Object.assign({ credentials: "same-origin" }, init));
    } catch (cause) {
      const error = new Error(cause && cause.message ? String(cause.message) : "network_error");
      error.network = true;
      throw error;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.status !== "ok") {
      const error = new Error(payload.error || fallbackError);
      error.status = res.status;
      throw error;
    }
    return payload;
  }
  function postJson(url, body, fallbackError) {
    return requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, fallbackError);
  }

  /* Page offset: reserve the bar height on <html> and move the page's pinned top chrome below it.
     Only elements that are actually moved get an inline top; the original value comes back on
     minimize and print unless the page changed it in the meantime. */
  function measureBar() {
    return Math.round(bar.getBoundingClientRect().height) || 0;
  }
  const SCROLLS = /(auto|scroll|hidden|overlay)/;
  function containedScroll(el) {
    for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
      const cs = getComputedStyle(node);
      // body's overflow goes to the viewport unless <html> sets its own (html,body{overflow-x:
      // hidden}): then body itself is the scroll container, and it already starts below the bar.
      if (node === document.body) {
        const rs = getComputedStyle(root);
        return rs.overflowX + rs.overflowY !== "visiblevisible" && SCROLLS.test(cs.overflowX + " " + cs.overflowY);
      }
      if (SCROLLS.test(cs.overflowX + " " + cs.overflowY)) return true;
    }
    return false;
  }
  // Ancestors with a transform, filter, perspective, will-change or containment lay out their fixed
  // and absolute descendants: those already move with the page, so they are left alone.
  function holdsFixed(cs) {
    return (
      cs.transform !== "none" ||
      cs.filter !== "none" ||
      cs.perspective !== "none" ||
      Boolean(cs.backdropFilter && cs.backdropFilter !== "none") ||
      /transform|filter|perspective/.test(cs.willChange || "") ||
      /paint|layout|strict|content/.test(cs.contain || "") ||
      /size/.test(cs.containerType || "")
    );
  }
  function icbAbsolute(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.position !== "static" || holdsFixed(cs)) return false;
    }
    return true;
  }
  function viewportFixed(el) {
    for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
      if (holdsFixed(getComputedStyle(node))) return false;
    }
    return true;
  }
  // Whether top/bottom are "auto". Resolved values of positioned elements are used px values, so read
  // the typed OM when available, otherwise the computed value with the element briefly unpositioned.
  function anchors(el, cs) {
    let topAuto = cs.top === "auto";
    let bottomAuto = cs.bottom === "auto";
    if (el.computedStyleMap) {
      try {
        const map = el.computedStyleMap();
        topAuto = String(map.get("top")) === "auto";
        bottomAuto = String(map.get("bottom")) === "auto";
        return { topAuto, bottomAuto };
      } catch {}
    }
    if (!topAuto && !bottomAuto) {
      const hadStyle = el.hasAttribute("style");
      const saved = setOwn(el, "position", "static");
      const s = getComputedStyle(el);
      topAuto = s.top === "auto";
      bottomAuto = s.bottom === "auto";
      dropOwn(el, saved);
      tidyStyle(el, hadStyle);
    }
    return { topAuto, bottomAuto };
  }
  // Inline overrides remember the page's own inline value and come back only if still ours.
  function setOwn(el, prop, value) {
    const saved = { prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop), applied: "" };
    el.style.setProperty(prop, value, "important");
    saved.applied = el.style.getPropertyValue(prop);
    return saved;
  }
  function dropOwn(el, saved) {
    if (!saved || !saved.applied || el.style.getPropertyValue(saved.prop) !== saved.applied) return;
    if (saved.value) el.style.setProperty(saved.prop, saved.value, saved.priority);
    else el.style.removeProperty(saved.prop);
  }
  function tidyStyle(el, hadStyle) {
    if (!hadStyle && el.getAttribute("style") === "") el.removeAttribute("style");
  }
  // 100dvh where supported (it follows the visible viewport), 100vh otherwise.
  function setViewportCalc(el, prop, px) {
    const add = (n) => "calc(" + Math.round(n) + "px + ";
    const saved = setOwn(el, prop, add(px) + "100dvh)");
    if (saved.applied.indexOf("dvh") < 0) {
      dropOwn(el, saved);
      return setOwn(el, prop, add(px) + "100vh)");
    }
    return saved;
  }
  // The page's own top, and whether our write must hold a top transition off (calm).
  // While top is transitioning (the page's animation, or the one started by taking our value off)
  // the computed value is the current frame: the page's value is where that transition ends, and
  // writing ours just retargets it. With no top transition running, a transition our write would
  // start is only an artifact of the offset (a header sliding in on load), so it lands at once.
  // top is null when a transition runs but its end cannot be read: read it with transitions off.
  // A running keyframe animation on top cannot be overridden without freezing a frame (our value
  // is !important): top is NaN (not moved now), and the scan after animationend moves it.
  function pageTop(el, cs) {
    const now = parseFloat(cs.top);
    const animated = cs.animationName && cs.animationName !== "none";
    const calm = topTransition(cs);
    if (!animated && !calm) return { top: now, calm: null };
    try {
      const list = el.getAnimations();
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        if (a.transitionProperty === undefined) {
          if (a.playState === "finished" || !a.effect) continue;
          const frames = a.effect.getKeyframes();
          for (let f = 0; f < frames.length; f += 1) if ("top" in frames[f]) return { top: NaN, calm: null };
          continue;
        }
        if (a.transitionProperty !== "top") continue;
        const frames = a.effect.getKeyframes();
        const end = frames.length ? String(frames[frames.length - 1].top || "") : "";
        return /px$/.test(end) && Number.isFinite(parseFloat(end)) ? { top: parseFloat(end), calm: null } : { top: null, calm };
      }
      return { top: now, calm };
    } catch {
      return { top: calm ? null : now, calm };
    }
  }
  // When top can transition, the longhands that turn off just top: the page's lists (expanded to
  // the property count) plus "top 0s" last (a later entry wins), so the page's other transitions
  // (a background fading on scroll) keep running untouched. null when top does not transition.
  function topTransition(cs) {
    if (!/[1-9]/.test(cs.transitionDuration || "") && !/[1-9]/.test(cs.transitionDelay || "")) return null;
    const props = String(cs.transitionProperty || "").split(",").map((v) => v.trim());
    const durs = String(cs.transitionDuration).split(",");
    const delays = String(cs.transitionDelay || "0s").split(",");
    const at = (list, i) => list[i % list.length].trim();
    let live = false;
    for (let i = 0; i < props.length; i += 1) {
      if (props[i] === "top" || props[i] === "all") live = parseFloat(at(durs, i)) > 0 || parseFloat(at(delays, i)) > 0;
    }
    if (!live) return null;
    return {
      property: props.concat("top").join(", "),
      duration: props.map((_, i) => at(durs, i)).concat("0s").join(", "),
      delay: props.map((_, i) => at(delays, i)).concat("0s").join(", "),
    };
  }
  function considerShift(el, vh, stack) {
    if (el === host || isOperatorElement(el)) return false;
    const bench = benched.get(el);
    if (bench) {
      if (bench > Date.now()) return false;
      benched.delete(el);
    }
    const prev = shifted.get(el);
    if (prev) {
      if (el.style.getPropertyValue("top") === prev.top.applied) return false;
      shifted.delete(el);
      putBack(el, prev);
    }
    const cs = getComputedStyle(el);
    const pos = cs.position;
    if ((pos !== "fixed" && pos !== "sticky" && pos !== "absolute") || cs.display === "none") return false;
    const hadStyle = el.hasAttribute("style");
    const own = pageTop(el, cs);
    const calm = own.calm
      ? [setOwn(el, "transition-property", own.calm.property), setOwn(el, "transition-duration", own.calm.duration), setOwn(el, "transition-delay", own.calm.delay)]
      : null;
    const top = own.top === null ? parseFloat(cs.top) : own.top;
    const moved = Number.isFinite(top) && shiftNow(el, cs, top, hadStyle, vh, stack);
    if (calm) {
      void cs.top;
      calm.forEach((saved) => dropOwn(el, saved));
      tidyStyle(el, hadStyle);
    }
    return moved;
  }
  function shiftNow(el, cs, top, hadStyle, vh, stack) {
    const pos = cs.position;
    const vw = viewportWidth();
    let r = null;
    let rail = false;
    if (pos === "absolute") {
      r = el.getBoundingClientRect();
      if (!r.height || r.top + window.scrollY >= barH || !icbAbsolute(el)) return false;
    } else {
      // At or below the bar edge only chrome stacked under moved chrome counts (stack is measured
      // only then: null means "not measured yet").
      if (top >= barH) {
        const s = stack || stackInfo();
        if (!(s.orig > 0 && top <= s.orig + 24)) return false;
      }
      if (pos === "sticky" && containedScroll(el)) return false;
      if (pos === "sticky" && heightHint.has(el)) r = { height: heightHint.get(el) };
      if (pos === "fixed" && !viewportFixed(el)) return false;
    }
    if (pos !== "sticky") {
      const a = anchors(el, cs);
      if (a.topAuto) return false;
      r = r || el.getBoundingClientRect();
      // A full-height layer only moves when its bottom is anchored too (it shrinks instead of
      // sliding off screen) or when it is a narrow side rail, which gets a max-height cap below.
      if (pos === "fixed" && r.height >= vh * 0.9 && a.bottomAuto) {
        if (r.width > vw * 0.5) return false;
        rail = true;
      }
    }
    const px = Math.round(top + barH);
    const rec = { top: setOwn(el, "top", px + "px"), cap: null, px, orig: top, kind: pos, style: hadStyle };
    shifted.set(el, rec);
    // Tall sidebars (sticky tables of contents, fixed rails) would now end below the screen: cap
    // them to the room under the new top so their last items stay reachable.
    if (pos !== "absolute" && !(r && px + r.height <= vh + 1)) {
      const nr = el.getBoundingClientRect();
      if (nr.bottom > vh + 1 && nr.top < vh * 0.5 && (rail || nr.width <= vw * 0.5 || /(auto|scroll)/.test(cs.overflowY))) {
        rec.cap = setViewportCalc(el, "max-height", -px);
      }
    }
    return true;
  }
  function putBack(el, rec) {
    dropOwn(el, rec.top);
    dropOwn(el, rec.cap);
    tidyStyle(el, rec.style);
  }
  // Re-evaluate a moved element from scratch (its classes, inline style or an ancestor changed):
  // take our values off, read the page's own position and top again, and move it again if needed.
  // Returns whether the outcome differs from before.
  // The moved elements among els worth re-reading now, in one pass of reads (no writes): any whose
  // position changed, and the rest unless they are sticky and away from the top band (sticky
  // table headers and section titles scrolled away are left as they are; the scan after scrolling
  // re-reads them once they stick). edgeOnly keeps only top-edge chrome (fixed or sticky with an
  // original top inside the bar) besides the position changes.
  const heightHint = new Map();
  function pinnedNow(els, edgeOnly) {
    const out = [];
    const band = barH * 3;
    els.forEach((el) => {
      const rec = shifted.get(el);
      if (!rec || !el.isConnected) return;
      if (getComputedStyle(el).position !== rec.kind) {
        out.push(el);
        return;
      }
      if (edgeOnly && (rec.kind === "absolute" || rec.orig >= barH)) return;
      if (rec.kind === "sticky") {
        const r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top > Math.max(rec.px, band) + 1) return;
        // Its height does not depend on top: the re-evaluation reuses it instead of measuring
        // again after its own write (one layout for the whole pass, not one per element).
        heightHint.set(el, r.height);
      }
      out.push(el);
    });
    return out;
  }
  function recheck(el) {
    const rec = shifted.get(el);
    if (!rec) return false;
    shifted.delete(el);
    putBack(el, rec);
    if (barH && !minimized && !printing) considerShift(el, window.innerHeight, null);
    const now = shifted.get(el);
    return !now || now.top.applied !== rec.top.applied;
  }
  // Wide, short chrome moved below the bar and pinned right now: its original bottom (to find
  // stacked chrome such as a subnav at top:56 under a 56px header) and its bottom on screen.
  function stackInfo() {
    let orig = 0;
    let view = 0;
    const vw = viewportWidth();
    const vh = window.innerHeight;
    shifted.forEach((rec, el) => {
      if (!el.isConnected) {
        // A detached node may come back later (keep-alive views, portals): without our values.
        shifted.delete(el);
        putBack(el, rec);
        return;
      }
      if (rec.kind === "absolute") return;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height <= 0 || r.height > vh * 0.4 || Math.abs(r.top - rec.px) > 1) return;
      orig = Math.max(orig, rec.orig + r.height);
      view = Math.max(view, r.bottom);
    });
    return { orig, view };
  }
  function stackRows(stack, from) {
    const rows = [];
    const end = Math.min(window.innerHeight - 2, stack.view + 2);
    for (let y = Math.max(barH + 6, from || 0); y <= end; y += 18) rows.push(Math.round(y));
    return rows;
  }
  // Probe columns: every ~40px plus both edges for the rows inside the bar (small fixed logos and
  // menu buttons), 9 (or 5) columns for the rows below it.
  function probeColumns(dense, sparse) {
    const vw = viewportWidth();
    const xs = [];
    if (dense) {
      const n = Math.max(8, Math.ceil((vw - 16) / 40));
      for (let j = 0; j <= n; j += 1) xs.push(Math.round(8 + ((vw - 16) * j) / n));
    } else {
      for (let j = 0; j <= 8; j += sparse ? 2 : 1) xs.push(clamp(Math.round((vw * j) / 8), 1, vw - 1));
    }
    return xs;
  }
  // mode "light": periodic rescans on pages that mutate constantly probe only the bar edge, on 5
  // columns. "scroll": the scan after scrolling stops skips the dense in-bar rows (small fixed
  // controls do not move on scroll; load, resize and mutation scans find them).
  function shiftHeaders(mode) {
    if (!barH || minimized || printing || !document.elementsFromPoint) return false;
    const light = mode === "light";
    const vh = window.innerHeight;
    let moved = false;
    if (!light) {
      // Moved elements the page has since unpinned (an affix class removed from an ancestor, a
      // stylesheet swap) get their own values back. Top-edge chrome on screen now is re-read every
      // time: pages also hide it through data attributes or CSS variables, which the observer does
      // not see. Candidates are read in one pass, then re-evaluated.
      pinnedNow(Array.from(shifted.keys()), true).forEach((el) => {
        if (recheck(el)) moved = true;
      });
      heightHint.clear();
    }
    let stack = stackInfo();
    let rows = [1, Math.max(1, barH - 4), barH + 2].concat(stack.view > barH && !light ? stackRows(stack, 0) : []);
    const dense = mode ? null : probeColumns(true);
    const wide = probeColumns(false, false);
    const sparse = probeColumns(false, true);
    for (let pass = 0; pass < 3 && rows.length; pass += 1) {
      const seen = new Set();
      let movedNow = false;
      for (let i = 0; i < rows.length; i += 1) {
        const y = rows[i];
        // Rows below the bar edge only look for stacked chrome (wide subnavs, edge sidebars).
        const xs = (light && pass === 0) || y > barH + 2 ? sparse : dense && y < barH ? dense : wide;
        for (let j = 0; j < xs.length; j += 1) {
          const list = document.elementsFromPoint(xs[j], y);
          for (let k = 0; k < list.length; k += 1) {
            for (let node = list[k]; node && node !== root && node !== document.body && !seen.has(node); node = node.parentElement) {
              seen.add(node);
              if (considerShift(node, vh, stack)) movedNow = true;
            }
          }
        }
      }
      if (!movedNow) break;
      moved = true;
      const next = stackInfo();
      rows = next.view > stack.view ? stackRows(next, Math.max(stack.view, barH) + 6) : [];
      stack = next;
    }
    if (observer) observer.takeRecords();
    return moved;
  }
  // The page changed a moved element (hide-on-scroll headers rewrite its inline top, affix scripts
  // toggle classes): re-evaluate it right away, on every scroll event if need be. Only a page that
  // puts its own value back synchronously (an observer fighting ours, many rounds inside a single
  // task) is left alone for a few seconds.
  function reapply(el) {
    if (!burst) {
      burst = new Map();
      setTimeout(() => {
        burst = null;
      }, 0);
    }
    const n = (burst.get(el) || 0) + 1;
    burst.set(el, n);
    if (n > 16) {
      const rec = shifted.get(el);
      if (rec) {
        shifted.delete(el);
        putBack(el, rec);
      }
      benched.set(el, Date.now() + 3000);
      return;
    }
    recheck(el);
  }
  function restoreShifted() {
    shifted.forEach((rec, el) => putBack(el, rec));
    shifted.clear();
    if (observer) observer.takeRecords();
  }
  // App shells (root does not scroll, html as tall as the viewport) would lose their bottom strip.
  function detectAppShell() {
    const bodyStyle = document.body ? getComputedStyle(document.body) : null;
    const locked = /hidden|clip/.test(getComputedStyle(root).overflowY) || Boolean(bodyStyle && /hidden|clip/.test(bodyStyle.overflowY));
    return locked && Math.abs(root.getBoundingClientRect().height - window.innerHeight) <= 2;
  }
  // Viewport-sized layouts (100vh/100dvh bodies and app containers, chat-like shells, often with
  // a locked root) end H px below the screen once the page is pushed down. When the whole document
  // is just that much taller than the viewport, shrink, top-down, the viewport-tall boxes that end
  // at that edge (and boxes inside a shrunk one that still do). Heights follow the viewport.
  const NO_SHRINK = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|svg)$/;
  function unfitShell(rec, el) {
    dropOwn(el, rec.height);
    dropOwn(el, rec.min);
    tidyStyle(el, rec.style);
  }
  function unfitShells() {
    shells.forEach(unfitShell);
    shells.clear();
    shellsDirty = false;
  }
  function fitShells(full) {
    const had = shells.size;
    if (full || shellsDirty) unfitShells();
    else if (had) {
      shells.forEach((rec, el) => {
        if (el.isConnected) return;
        shells.delete(el);
        unfitShell(rec, el);
      });
      // The document outgrew the viewport (a route with long content): the shell is gone.
      if (shells.size && root.scrollHeight - window.innerHeight > barH + 2) unfitShells();
    }
    if (barH && !minimized && !printing && document.body) addShells();
    // Our own writes (shells, and the height probes without Typed OM) must not schedule a scan.
    if (observer) observer.takeRecords();
    return shells.size !== had;
  }
  // Content-sized boxes (height auto) are not resized themselves; the explicit viewport heights
  // inside them are.
  function autoHeight(el, h) {
    if (el.computedStyleMap) {
      try {
        return String(el.computedStyleMap().get("height")) === "auto";
      } catch {}
    }
    const hadStyle = el.hasAttribute("style");
    const saved = setOwn(el, "height", "auto");
    const natural = parseFloat(getComputedStyle(el).height);
    dropOwn(el, saved);
    tidyStyle(el, hadStyle);
    return Math.abs(natural - h) <= 1;
  }
  function addShells() {
    const vh = window.innerHeight;
    const over = Math.round(root.scrollHeight - vh);
    if (over <= 1 || over > barH + 2) return;
    const edge = vh + over;
    let level = [[document.body, false]];
    for (let depth = 0; depth < 4 && level.length; depth += 1) {
      const next = [];
      level.forEach((item) => {
        const el = item[0];
        const known = shells.has(el);
        const r = el.getBoundingClientRect();
        if (!known && (r.bottom < edge - 2 || r.height < vh * 0.4)) return;
        const atEdge = Math.abs(r.bottom - edge) <= 2;
        const tall = atEdge && (item[1] || r.height >= vh - 2);
        if (!known && tall && !NO_SHRINK.test(el.tagName)) {
          const cs = getComputedStyle(el);
          const h = parseFloat(cs.height);
          if (cs.position !== "fixed" && cs.position !== "absolute" && Number.isFinite(h) && h > over) {
            const hadStyle = el.hasAttribute("style");
            const rec = { height: null, min: null, style: hadStyle };
            // min-height: 100vh layouts only get their minimum lowered, so content can still grow.
            if ((parseFloat(cs.minHeight) || 0) >= h - 0.5) rec.min = setViewportCalc(el, "min-height", h - over - vh);
            if (!autoHeight(el, h) && (!rec.min || Math.abs(el.getBoundingClientRect().bottom - edge) <= 2)) {
              rec.height = setViewportCalc(el, "height", h - over - vh);
            }
            if (rec.min || rec.height) shells.set(el, rec);
            else tidyStyle(el, hadStyle);
          }
        }
        const kids = el.children;
        for (let i = 0; i < kids.length && i < 40; i += 1) if (!isOperatorElement(kids[i])) next.push([kids[i], item[1] || known || tall]);
      });
      level = next;
    }
  }
  function applyOffset() {
    const next = minimized || printing ? 0 : measureBar();
    if (next !== barH) restoreShifted();
    barH = next;
    ui.style.setProperty("--rv-h", (next || 44) + "px");
    if (!barH) {
      unfitShells();
      offsetStyle.textContent = "";
      offsetStyle.remove();
      return;
    }
    if (appShell === null) appShell = !offsetStyle.isConnected && detectAppShell();
    offsetStyle.textContent =
      "@media not print{html{margin-top:" + (baseMarginTop + barH) + "px!important;scroll-padding-top:" + (basePad + barH + 8) + "px!important" +
      (appShell ? ";height:calc(100% - " + (baseMarginTop + barH) + "px)!important" : "") + "}}";
    if (!offsetStyle.isConnected) (document.head || root).appendChild(offsetStyle);
    shiftHeaders();
    fitShells(true);
  }
  // Bar bottom plus any moved page header still pinned right under it: cards open below this line.
  function occupiedTop() {
    let top = barH;
    const vw = viewportWidth();
    const vh = window.innerHeight;
    for (let pass = 0; pass < 3; pass += 1) {
      const before = top;
      shifted.forEach((rec, el) => {
        if (!el.isConnected || rec.kind === "absolute") return;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.width >= vw * 0.4 && r.top <= top + 2 && r.bottom > top && r.bottom < vh * 0.4) top = r.bottom;
      });
      if (top === before) break;
    }
    return vh - top < 240 ? barH : Math.round(top);
  }

  /* Scans: trailing edge after scroll, throttled after DOM mutations (backing off on pages that
     mutate constantly), and on load/resize. */
  let scanTimer = 0;
  let scrollTimer = 0;
  let settleTimer = 0;
  let mutationGap = 250;
  function runScan(fromMutation) {
    scanTimer = 0;
    if (minimized) {
      positionPins();
      return;
    }
    const moved = shiftHeaders(fromMutation && mutationGap >= 1000 ? "light" : "");
    const fitted = fitShells(false);
    const pinsMoved = positionPins();
    if (fromMutation) mutationGap = moved || fitted || pinsMoved ? 250 : Math.min(3000, Math.round(mutationGap * 1.6));
  }
  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(() => runScan(true), mutationGap);
  }
  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (minimized) placeHandle();
      else shiftHeaders("scroll");
    }, 180);
  }

  /* Comment cards (composer and thread) and pins, all outside the shadow root. */
  function button(label, kind) {
    const h = coarse() ? 40 : 30;
    const look =
      kind === "primary" ? "border:1px solid #111318;background:#111318;color:#fff"
      : kind === "danger" ? "border:1px solid #dc2626;background:#dc2626;color:#fff"
      : "border:1px solid rgba(15,23,42,.16);background:#fff;color:#0f172a";
    const b = make(
      "button",
      "display:inline-flex;align-items:center;justify-content:center;flex:none;height:" + h + "px;margin:0;padding:0 14px;border-radius:9px;font:600 13px/1 " + FONT +
        ";white-space:nowrap;cursor:pointer;touch-action:manipulation;" + look,
      label,
    );
    b.type = "button";
    b.dataset.raviBtn = kind || "plain";
    return b;
  }
  function iconButton(paths, label, size) {
    const b = make(
      "button",
      "display:grid;place-items:center;flex:none;width:" + size + "px;height:" + size + "px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:#64748b;cursor:pointer;touch-action:manipulation",
    );
    b.type = "button";
    b.dataset.raviBtn = "icon";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = svg(paths, 16);
    return b;
  }
  function textArea(placeholder, label, minH, maxH, onGrow) {
    const t = make(
      "textarea",
      "display:block;width:100%;min-width:0;height:" + minH + "px;min-height:" + minH + "px;max-height:" + maxH + "px;margin:0;padding:9px 11px;border:1px solid rgba(15,23,42,.18);border-radius:10px;background:#fff;color:#0f172a;font:400 " +
        (coarse() ? 16 : 13) + "px/1.4 " + FONT + ";white-space:pre-wrap;overflow-wrap:break-word;overflow:auto;resize:none;cursor:text;outline:none",
    );
    t.maxLength = 2000;
    t.rows = 1;
    t.placeholder = placeholder;
    t.setAttribute("aria-label", label);
    t.addEventListener("input", () => {
      const before = t.offsetHeight;
      t.style.height = "auto";
      t.style.height = clamp(t.scrollHeight + 2, minH, maxH) + "px";
      if (t.offsetHeight !== before && onGrow) onGrow();
    });
    return t;
  }
  function noteLine() {
    const note = make("div", "display:none;margin-top:6px;color:#b91c1c;font-size:12px;font-weight:500;line-height:1.35;white-space:normal;overflow-wrap:anywhere");
    note.setAttribute("aria-live", "polite");
    return note;
  }
  function setNote(note, text, kind) {
    note.textContent = text || "";
    note.style.display = text ? "block" : "none";
    note.style.color = kind === "err" ? "#b91c1c" : "#64748b";
    note.dataset.kind = text ? kind || "info" : "";
  }
  function cardShell(kind, label) {
    const card = make(
      "div",
      "display:flex;flex-direction:column;position:absolute;z-index:2147483645;margin:0;padding:0;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;color:#0f172a;text-align:left;" +
        "box-shadow:0 22px 50px rgba(15,23,42,.22),0 2px 6px rgba(15,23,42,.08);font:400 " + (coarse() ? 14 : 13) + "px/1.45 " + FONT + ";visibility:hidden;cursor:auto",
    );
    card.dataset.raviOperatorUi = kind;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", label);
    return card;
  }
  function cardHeader(title, extra, onClose, closeLabel) {
    const head = make("div", "display:flex;align-items:center;gap:8px;flex:none;padding:6px 6px 6px 14px;border-bottom:1px solid rgba(15,23,42,.08)");
    head.append(make("div", "display:block;flex:none;font-weight:700;font-size:14px;color:#0f172a", title));
    if (extra) head.append(make("div", "display:block;flex:1 1 auto;min-width:0;color:#64748b;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", extra));
    const close = iconButton(P.x, closeLabel, coarse() ? 36 : 28);
    close.style.marginLeft = "auto";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    });
    head.append(close);
    return { head, close };
  }
  function moveMark(el, soft) {
    markEl = el;
    markSoft = Boolean(soft);
    if (!mark.isConnected) root.appendChild(mark);
    const r = el.getBoundingClientRect();
    const vw = viewportWidth();
    const left = clamp(r.left - 3, 0, vw - 4);
    const right = clamp(r.right + 3, left + 4, vw);
    mark.style.borderStyle = soft ? "dashed" : "solid";
    mark.style.background = soft ? "transparent" : "rgba(37,99,235,.08)";
    mark.style.boxShadow = soft ? "none" : "0 0 0 4px rgba(37,99,235,.14)";
    mark.style.width = Math.round(right - left) + "px";
    mark.style.height = Math.round(r.height + 6) + "px";
    placeAt(mark, left, r.top - 3);
    mark.style.display = "block";
  }
  function hideMark() {
    mark.style.display = "none";
    markEl = null;
    markSoft = false;
  }
  function setPinOpen(pin, open) {
    const dot = pin.firstChild;
    if (dot && dot.style) dot.style.background = open ? "#2563eb" : "#111318";
    pin.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function clearBubble() {
    if (bubble) bubble.remove();
    if (openRec) setPinOpen(openRec.pin, false);
    if (markSoft && !composer && !selecting) hideMark();
    bubble = null;
    openRec = null;
  }
  function clearComposer() {
    if (composer) composer.remove();
    composer = null;
    composerTarget = null;
    if (!selecting && !markSoft) hideMark();
  }
  function clearPins() {
    pinRecords.forEach((rec) => rec.pin.remove());
    pinRecords = [];
    clearBubble();
  }
  function commentKey(comment, fallbackIndex) {
    return String(comment && (comment.id || comment.createdAt) ? comment.id || comment.createdAt : fallbackIndex);
  }
  function authorLabel(comment) {
    return comment && comment.author && comment.author.displayName ? comment.author.displayName : "Usu\\u00e1rio Ravi";
  }
  function commentTime(comment) {
    if (!comment || !comment.createdAt) return "";
    const date = new Date(comment.createdAt);
    if (Number.isNaN(date.getTime())) return "";
    try {
      return date.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch {
      return date.toLocaleString();
    }
  }
  function anchorKey(target, fallbackIndex) {
    if (target && target.selector) return "selector:" + target.selector;
    const rect = target && target.rect;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      return ["rect", Math.round(rect.x / 8), Math.round(rect.y / 8), Math.round((rect.width || 0) / 8), Math.round((rect.height || 0) / 8)].join(":");
    }
    return "fallback:" + fallbackIndex;
  }
  function avatar(name) {
    const colors = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669", "#0891b2", "#4f46e5"];
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 9973;
    const a = make(
      "span",
      "display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:50%;background:" + colors[hash % colors.length] + ";color:#fff;font:700 11px/1 " + FONT,
      (name.trim().charAt(0) || "?").toUpperCase(),
    );
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  async function reloadAndReopen(key) {
    clearBubble();
    commentsLoaded = false;
    await loadComments(true);
    const rec = pinRecords.find((item) => item.thread.key === key);
    if (rec) showBubble(rec, false, false);
  }
  async function replyToThread(thread, text, sendButton, note) {
    const parent = thread.root;
    if (!parent || !parent.id) return;
    sendButton.disabled = true;
    setNote(note, "");
    busyMsg("Enviando resposta\\u2026");
    try {
      await postJson(d.commentsUrl, { action: "create", path: currentPath(), parentId: parent.id, body: text, target: parent.target }, "reply_failed");
      await reloadAndReopen(thread.key);
      okMsg("Resposta enviada");
    } catch (error) {
      const fail = failure("enviar a resposta", error);
      setNote(note, fail.text, "err");
      failNear(fail);
      sendButton.disabled = false;
      placeBubble();
    }
  }
  async function deleteComment(thread, comment, yes, msg) {
    if (!comment || !comment.id) return;
    yes.disabled = true;
    setNote(msg, "Apagando\\u2026", "");
    try {
      await postJson(d.commentsUrl, { action: "delete", path: currentPath(), commentId: comment.id }, "delete_failed");
      await reloadAndReopen(thread.key);
      okMsg("Coment\\u00e1rio apagado");
    } catch (error) {
      const fail = failure("apagar o coment\\u00e1rio", error);
      setNote(msg, fail.text, "err");
      failNear(fail);
      yes.disabled = false;
      placeBubble();
    }
  }
  function openDeleteConfirm(thread, comment, row) {
    const existing = row.querySelector('[data-ravi-operator-ui="delete-confirm"]');
    if (existing) {
      existing.remove();
      placeBubble();
      return;
    }
    const confirm = make(
      "div",
      "display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin:10px 0 0 32px;padding:10px;border-radius:10px;background:#fef2f2;color:#991b1b;font-size:12.5px;font-weight:600",
    );
    confirm.dataset.raviOperatorUi = "delete-confirm";
    confirm.setAttribute("role", "group");
    confirm.setAttribute("aria-label", "Confirmar exclus\\u00e3o");
    const text = make("span", "display:block;flex:1 1 100%;min-width:0", "Apagar este coment\\u00e1rio?");
    const msg = noteLine();
    msg.style.flex = "1 1 100%";
    msg.style.marginTop = "0";
    const cancel = button("Cancelar", "");
    const yes = button("Apagar", "danger");
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      confirm.remove();
      placeBubble();
    });
    yes.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void deleteComment(thread, comment, yes, msg);
    });
    confirm.append(text, msg, cancel, yes);
    row.appendChild(confirm);
    placeBubble();
    yes.focus({ preventScroll: true });
  }
  function createThreadMessage(thread, comment, index) {
    const row = make("div", "display:block;padding:12px 0;" + (index ? "border-top:1px solid rgba(15,23,42,.07)" : ""));
    const meta = make("div", "display:flex;align-items:center;gap:8px;min-width:0");
    const name = authorLabel(comment);
    const who = make("div", "display:block;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#64748b;font-size:12px");
    who.append(make("span", "font-weight:650;font-size:13px;color:#0f172a", name));
    const when = commentTime(comment);
    if (when) who.append(make("span", "margin-left:6px", when));
    const del = iconButton(P.trash, "Apagar coment\\u00e1rio", coarse() ? 34 : 26);
    del.style.color = "#94a3b8";
    del.style.marginRight = "-6px";
    del.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDeleteConfirm(thread, comment, row);
    });
    meta.append(avatar(name), who, del);
    const body = make("div", "display:block;margin:3px 0 0 32px;white-space:pre-wrap;overflow-wrap:anywhere;color:#1f2937", comment.body || "");
    row.append(meta, body);
    return row;
  }
  // Phones: scroll so there is room above the pin for the card; wide screens: keep the pin on screen.
  function revealPin(pin, cardH) {
    const r = pin.getBoundingClientRect();
    const top = occupiedTop();
    const vh = window.innerHeight;
    let want = null;
    if (narrowView()) {
      const ideal = Math.min(top + Math.min(cardH, 280) + 20, Math.round(vh * 0.62));
      if (r.top < ideal || r.bottom > vh - 60) want = ideal;
    } else if (r.top < top + 16 || r.bottom > vh - 120) {
      want = top + Math.round(vh * 0.2);
    }
    if (want !== null) jumpTo(Math.max(0, window.scrollY + r.top - want));
  }
  function placeBubble() {
    if (!bubble || !openRec) return;
    const card = bubble;
    const pin = openRec.pin;
    const list = card.raviList;
    const arrow = card.raviArrow;
    const vw = viewportWidth();
    const vh = window.innerHeight;
    const narrow = vw < 600;
    const w = narrow ? vw - 16 : Math.min(340, vw - 16);
    card.style.width = w + "px";
    list.style.maxHeight = "none";
    const minTop = occupiedTop() + 8;
    const maxBottom = vh - 8;
    const pr = pin.getBoundingClientRect();
    const targetEl = targetElement(openRec.thread.root && openRec.thread.root.target);
    const tr = targetEl ? targetEl.getBoundingClientRect() : null;
    const side = narrow ? "" : vw - pr.right >= w + 22 ? "right" : pr.left >= w + 22 ? "left" : "";
    let h = card.offsetHeight;
    const shrinkTo = (room) => {
      if (h > room) {
        list.style.maxHeight = Math.max(64, list.offsetHeight - (h - room)) + "px";
        h = card.offsetHeight;
      }
    };
    let left;
    let top;
    let mode;
    if (side) {
      shrinkTo(maxBottom - minTop);
      left = side === "right" ? pr.right + 10 : pr.left - 10 - w;
      top = clamp(pr.top - 16, minTop, Math.max(minTop, maxBottom - h));
      mode = side;
    } else {
      // Prefer above the pin so the commented element (below the pin) stays visible; else under the
      // element itself; else under the pin.
      const above = pr.top - 10 - minTop;
      const underTarget = tr && tr.bottom > pr.bottom ? maxBottom - (tr.bottom + 10) : -1;
      const below = maxBottom - (pr.bottom + 10);
      const need = Math.min(h, 200);
      if (above >= need) {
        shrinkTo(above);
        top = pr.top - 10 - h;
        mode = "above";
      } else if (underTarget >= need) {
        shrinkTo(underTarget);
        top = tr.bottom + 10;
        mode = "under";
      } else {
        shrinkTo(Math.max(below, above));
        mode = below >= above ? "below" : "above";
        top = mode === "below" ? pr.bottom + 10 : pr.top - 10 - h;
      }
      top = clamp(top, minTop, Math.max(minTop, maxBottom - h));
      left = narrow ? 8 : clamp(pr.left + pr.width / 2 - w / 2, 8, vw - w - 8);
    }
    left = clamp(left, 8, Math.max(8, vw - w - 8));
    arrow.style.cssText = BASE + "display:block;position:absolute;width:12px;height:12px;margin:0;background:#fff;border:1px solid rgba(15,23,42,.12);transform:rotate(45deg);pointer-events:none";
    let along;
    let extent;
    let attached = true;
    if (mode === "right" || mode === "left") {
      along = pr.top + pr.height / 2 - top - 6;
      extent = h;
      arrow.style.top = along + "px";
      if (mode === "right") {
        arrow.style.left = "-7px";
        arrow.style.borderTopWidth = "0";
        arrow.style.borderRightWidth = "0";
      } else {
        arrow.style.right = "-7px";
        arrow.style.borderBottomWidth = "0";
        arrow.style.borderLeftWidth = "0";
      }
    } else {
      along = pr.left + pr.width / 2 - left - 6;
      extent = w;
      arrow.style.left = along + "px";
      if (mode === "above") {
        arrow.style.bottom = "-7px";
        arrow.style.borderTopWidth = "0";
        arrow.style.borderLeftWidth = "0";
        attached = top + h <= pr.top - 4 && top + h >= pr.top - 14;
      } else {
        arrow.style.top = "-7px";
        arrow.style.borderRightWidth = "0";
        arrow.style.borderBottomWidth = "0";
        attached = mode === "below" && Math.abs(top - (pr.bottom + 10)) < 2;
      }
    }
    arrow.style.display = attached && along >= 10 && along <= extent - 22 ? "block" : "none";
    placeAt(card, left, top);
  }
  function showBubble(rec, viaKeyboard, reveal) {
    dropOk();
    clearBubble();
    clearComposer();
    if (selecting) stopSelect();
    const thread = rec.thread;
    const pin = rec.pin;
    const n = thread.messages.length;
    const card = cardShell("comment-bubble", "Coment\\u00e1rios");
    const arrow = make("span", "display:block");
    arrow.setAttribute("aria-hidden", "true");
    const header = cardHeader("Coment\\u00e1rios", plural(n, "mensagem", "mensagens"), () => {
      clearBubble();
      pin.focus({ preventScroll: true });
    }, "Fechar coment\\u00e1rios");
    const list = make("div", "display:block;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 14px");
    thread.messages.forEach((item, index) => list.appendChild(createThreadMessage(thread, item, index)));
    const reply = make("div", "display:block;flex:none;padding:10px 12px 12px;border-top:1px solid rgba(15,23,42,.08);border-radius:0 0 14px 14px;background:#f8fafc");
    reply.dataset.raviOperatorUi = "thread-reply";
    const replyRow = make("div", "display:flex;align-items:flex-end;gap:8px");
    const note = noteLine();
    const textarea = textArea("Responder\\u2026", "Responder", coarse() ? 40 : 32, 120, () => placeBubble());
    textarea.style.flex = "1 1 auto";
    textarea.style.width = "auto";
    const send = button("Enviar", "primary");
    const submit = () => {
      const text = (textarea.value || "").trim();
      if (!text) {
        setNote(note, "Escreva uma resposta primeiro.", "err");
        textarea.focus();
        placeBubble();
        return;
      }
      void replyToThread(thread, text, send, note);
    };
    send.addEventListener("click", submit);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    textarea.addEventListener("input", () => {
      if (note.dataset.kind === "err") setNote(note, "");
    });
    replyRow.append(textarea, send);
    reply.append(replyRow, note);
    card.append(arrow, header.head, list, reply);
    card.raviArrow = arrow;
    card.raviList = list;
    root.appendChild(card);
    bubble = card;
    openRec = rec;
    setPinOpen(pin, true);
    card.style.width = (narrowView() ? viewportWidth() - 16 : Math.min(340, viewportWidth() - 16)) + "px";
    if (reveal !== false) revealPin(pin, card.offsetHeight);
    const targetEl = targetElement(thread.root && thread.root.target);
    if (targetEl) moveMark(targetEl, true);
    placeBubble();
    card.style.visibility = "visible";
    if (viaKeyboard) header.close.focus({ preventScroll: true });
  }
  // Pins: a transparent hit area (32px on touch) around a small dark pill with the thread count,
  // clamped inside the viewport and below the bar. Returns whether any pin moved.
  function positionPins() {
    if (!pinRecords.length) return false;
    const vw = viewportWidth();
    const o = docOrigin();
    const size = coarse() ? 32 : 26;
    let moved = false;
    pinRecords.forEach((rec) => {
      const r = rectFromTarget(rec.thread.root && rec.thread.root.target, rec.thread.firstIndex);
      const left = clamp(r.x + Math.max(0, r.width) - size / 2 - 2, 2, vw - size - 2);
      const top = Math.max(barH + 2, r.y - size / 2 + 2);
      rec.docX = left;
      rec.docY = top;
      const l = Math.round(left - o.x) + "px";
      const t = Math.round(top - o.y) + "px";
      if (rec.pin.style.left !== l || rec.pin.style.top !== t) {
        rec.pin.style.left = l;
        rec.pin.style.top = t;
        moved = true;
      }
      const display = pinsHidden ? "none" : "flex";
      if (rec.pin.style.display !== display) rec.pin.style.display = display;
    });
    pinRecords.sort((a, b) => a.docY - b.docY || a.docX - b.docX);
    return moved;
  }
  function updateCounts() {
    const n = commentTotal;
    nextBtn.classList.toggle("err", commentsFailed);
    if (commentsFailed) {
      countEl.textContent = "!";
      countLabel.textContent = "";
      nextBtn.setAttribute("aria-label", "N\\u00e3o foi poss\\u00edvel carregar os coment\\u00e1rios. Tentar de novo");
      nextBtn.title = "Tentar carregar os coment\\u00e1rios de novo";
    } else {
      countEl.textContent = n == null ? "\\u2026" : String(n);
      countLabel.textContent = n == null ? "" : n === 1 ? "coment\\u00e1rio" : "coment\\u00e1rios";
      const label = n == null ? "Carregando coment\\u00e1rios" : n ? plural(n, "coment\\u00e1rio", "coment\\u00e1rios") + ". Ir para o pr\\u00f3ximo" : "Nenhum coment\\u00e1rio nesta p\\u00e1gina";
      nextBtn.setAttribute("aria-label", label);
      nextBtn.title = n ? "Ir para o pr\\u00f3ximo coment\\u00e1rio" : label;
    }
    const parts = ["Release " + (d.release ? "r" + d.release : "live")];
    if (d.version) parts.push("vers\\u00e3o " + d.version);
    if (n != null) parts.push(plural(n, "coment\\u00e1rio", "coment\\u00e1rios"));
    menuMeta.textContent = parts.join(" \\u00b7 ");
    fitBar();
  }
  function renderCommentPins(items) {
    clearPins();
    commentTotal = items.length;
    nextIndex = 0;
    updateCounts();
    const byId = new Map();
    items.forEach((comment, index) => byId.set(commentKey(comment, index), comment));
    const threads = new Map();
    items.forEach((comment, index) => {
      const key = commentKey(comment, index);
      const parentId = comment && typeof comment.parentId === "string" ? comment.parentId : "";
      const rootComment = parentId && byId.has(parentId) ? byId.get(parentId) : comment;
      const rootKey = parentId && byId.has(parentId) ? parentId : key;
      const threadKey = anchorKey(rootComment && rootComment.target, index);
      let thread = threads.get(threadKey);
      if (!thread) {
        thread = { key: threadKey, root: rootComment, rootKey, firstIndex: index, messages: [] };
        threads.set(threadKey, thread);
      }
      thread.messages.push(comment);
    });
    const size = coarse() ? 32 : 26;
    Array.from(threads.values()).forEach((thread) => {
      const n = thread.messages.length;
      const pin = make(
        "button",
        "display:flex;align-items:center;justify-content:center;position:absolute;z-index:2147483644;width:" + size + "px;height:" + size +
          "px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation",
      );
      pin.type = "button";
      pin.dataset.raviOperatorUi = "comment-pin";
      pin.className = "ravi-pages-comment-pin";
      pin.title = plural(n, "coment\\u00e1rio", "coment\\u00e1rios");
      pin.setAttribute("aria-label", plural(n, "coment\\u00e1rio", "coment\\u00e1rios") + ". Abrir conversa");
      pin.setAttribute("aria-expanded", "false");
      pin.append(
        make(
          "span",
          "display:flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border:2px solid #fff;border-radius:999px;background:#111318;color:#fff;box-shadow:0 4px 12px rgba(15,23,42,.32);font:700 11px/1 " +
            FONT + ";pointer-events:none;transition:transform .12s ease-out",
          String(n),
        ),
      );
      const rec = { pin, thread, docX: 0, docY: 0 };
      pin.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (openRec === rec) {
          clearBubble();
          return;
        }
        showBubble(rec, event.detail === 0, true);
      });
      root.appendChild(pin);
      pinRecords.push(rec);
    });
    positionPins();
  }
  async function loadComments(force, manual) {
    if (commentsLoaded && !force) return true;
    if (manual) busyMsg("Carregando coment\\u00e1rios\\u2026");
    try {
      const payload = await requestJson(
        d.commentsUrl + "?path=" + encodeURIComponent(currentPath()),
        { headers: { accept: "application/json" } },
        "comments_failed",
      );
      commentsLoaded = true;
      commentsFailed = false;
      renderCommentPins(Array.isArray(payload.comments) ? payload.comments : []);
      if (manual) okMsg("Coment\\u00e1rios atualizados");
      return true;
    } catch (error) {
      commentsFailed = true;
      updateCounts();
      failMsg(failure("carregar os coment\\u00e1rios", error));
      return false;
    }
  }
  function setPinsHidden(next) {
    pinsHidden = next;
    if (next) clearBubble();
    togglePinsLabel.textContent = next ? "Mostrar marcadores" : "Ocultar marcadores";
    togglePinsIcon.innerHTML = svg(next ? P.eye : P.eyeOff, 18, "ic");
    positionPins();
  }
  function goToNextThread(event) {
    closeMenu(null);
    if (commentsFailed) {
      void loadComments(true, true);
      return;
    }
    if (!pinRecords.length) {
      infoMsg(commentTotal == null ? "Carregando coment\\u00e1rios\\u2026" : "Nenhum coment\\u00e1rio nesta p\\u00e1gina ainda");
      return;
    }
    if (pinsHidden) setPinsHidden(false);
    const rec = pinRecords[nextIndex % pinRecords.length];
    nextIndex += 1;
    showBubble(rec, Boolean(event && event.detail === 0), true);
  }

  /* Selection mode and composer. Listeners sit on window in the capture phase so the page's own
     handlers do not run while an element is being picked. */
  function onHover(event) {
    if (!selecting || event.pointerType === "touch") return;
    const el = eventTarget(event);
    if (el && el !== markEl) moveMark(el, false);
  }
  function onPress(event) {
    if (!selecting) return;
    const el = eventTarget(event);
    if (!el) return;
    moveMark(el, false);
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function onBlock(event) {
    if (!selecting || !eventTarget(event)) return;
    if (event.type === "mousedown") event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function onPick(event) {
    if (!selecting) return;
    const el = eventTarget(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const rect = elementRect(el);
    const target = {
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 160),
      rect: { x: rect.x, y: Math.round((rect.y - barH) * 100) / 100, width: rect.width, height: rect.height },
    };
    stopSelect(true);
    openComposer(target, el);
  }
  const SELECT_EVENTS = [["pointermove", onHover], ["pointerdown", onPress], ["mousedown", onBlock], ["pointerup", onBlock], ["mouseup", onBlock], ["click", onPick]];
  function startSelect() {
    dropOk();
    closeMenu(null);
    clearBubble();
    clearComposer();
    selecting = true;
    ui.classList.add("selecting");
    pick.setAttribute("aria-pressed", "true");
    const fine = !coarse();
    selText.textContent = fine ? "Clique no item que voc\\u00ea quer comentar" : "Toque no item para comentar";
    announce(selText.textContent + (fine ? ". Esc ou Cancelar para sair." : ". Cancelar para sair."));
    // Touch: cursor:pointer makes iOS Safari deliver click on plain (non-interactive) elements.
    cursorStyle.textContent = fine ? "html,body,body *{cursor:crosshair!important}" : "body,body *{cursor:pointer!important}";
    (document.head || root).appendChild(cursorStyle);
    SELECT_EVENTS.forEach((item) => window.addEventListener(item[0], item[1], true));
    pickCancel.focus({ preventScroll: true });
  }
  function stopSelect(picked) {
    if (!selecting) return;
    selecting = false;
    ui.classList.remove("selecting");
    pick.setAttribute("aria-pressed", "false");
    cursorStyle.remove();
    SELECT_EVENTS.forEach((item) => window.removeEventListener(item[0], item[1], true));
    if (!picked) {
      hideMark();
      announce("Sele\\u00e7\\u00e3o cancelada");
    } else {
      srEl.textContent = "";
    }
    fitBar();
  }
  // Above the target, else below it; on open (reveal), when neither fits but the target and the
  // card fit together, the page scrolls the target up under the bar first. Always inside the
  // viewport and below the bar and any moved page header.
  function placeComposer(reveal) {
    if (!composer || !composerTarget) return;
    const vw = viewportWidth();
    const w = Math.min(320, vw - 16);
    // Width first: an unsized card (long context line) widens the layout and phones zoom out,
    // which would make the viewport height read below wrong.
    composer.style.width = w + "px";
    const vh = window.innerHeight;
    const h = composer.offsetHeight;
    const el = composerTarget.el && composerTarget.el.isConnected ? composerTarget.el : null;
    const targetRect = () => {
      if (el) return el.getBoundingClientRect();
      const r = rectFromTarget(composerTarget.target, 0);
      return { left: r.x - window.scrollX, top: r.y - window.scrollY, bottom: r.y - window.scrollY + r.height };
    };
    let er = targetRect();
    const minTop = occupiedTop() + 8;
    const maxTop = Math.max(minTop, vh - h - 8);
    const fits = () => er.top - 12 - h >= minTop || er.bottom + 12 <= maxTop;
    if (reveal && el && !fits() && minTop + (er.bottom - er.top) + 12 + h <= vh - 8) {
      jumpTo(Math.max(0, window.scrollY + er.top - minTop));
      er = targetRect();
    }
    if (el) moveMark(el, false);
    let top;
    if (er.top - 12 - h >= minTop) top = er.top - 12 - h;
    else if (er.bottom + 12 <= maxTop) top = er.bottom + 12;
    else top = er.top >= minTop && er.top + 48 <= maxTop ? er.top + 48 : maxTop;
    placeAt(composer, clamp(er.left, 8, Math.max(8, vw - w - 8)), clamp(top, minTop, maxTop));
  }
  async function saveComment(target, text, saveButton, note) {
    saveButton.disabled = true;
    setNote(note, "");
    busyMsg("Salvando coment\\u00e1rio\\u2026");
    try {
      await postJson(d.commentsUrl, { action: "create", path: currentPath(), body: text, target }, "comment_failed");
      clearComposer();
      commentsLoaded = false;
      await loadComments(true);
      okMsg("Coment\\u00e1rio salvo");
    } catch (error) {
      const fail = failure("salvar o coment\\u00e1rio", error);
      setNote(note, fail.text, "err");
      failNear(fail);
      saveButton.disabled = false;
      placeComposer();
    }
  }
  function openComposer(target, el) {
    clearComposer();
    clearBubble();
    const wrap = cardShell("comment-composer", "Novo coment\\u00e1rio");
    wrap.id = "ravi-pages-comment-composer";
    const header = cardHeader("Novo coment\\u00e1rio", "", () => {
      clearComposer();
      if (!minimized) pick.focus({ preventScroll: true });
    }, "Cancelar coment\\u00e1rio");
    const body = make("div", "display:block;padding:12px 14px 14px");
    // The rendered text (innerText) keeps block children apart: "Novos clientes 37", not "...clientes37".
    const shown = el && el.isConnected && typeof el.innerText === "string" ? el.innerText.trim().replace(/\\s+/g, " ") : target.text;
    if (shown) {
      body.append(make("div", "display:block;margin:0 0 8px;color:#64748b;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", "Em \\u201c" + shown.slice(0, 90) + "\\u201d"));
    }
    const textarea = textArea("Escreva um coment\\u00e1rio\\u2026", "Coment\\u00e1rio", coarse() ? 84 : 72, 160, () => placeComposer());
    const note = noteLine();
    const row = make("div", "display:flex;align-items:center;gap:8px;margin-top:10px");
    const hint = make("div", "display:block;flex:1 1 auto;min-width:0;color:#94a3b8;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", coarse() ? "" : (mac ? "\\u2318" : "Ctrl") + "+Enter envia");
    const cancel = button("Cancelar", "");
    const save = button("Comentar", "primary");
    const submit = () => {
      const text = (textarea.value || "").trim();
      if (!text) {
        setNote(note, "Escreva algo antes de enviar.", "err");
        textarea.focus();
        placeComposer();
        return;
      }
      void saveComment(target, text, save, note);
    };
    cancel.addEventListener("click", () => {
      clearComposer();
      if (!minimized) pick.focus({ preventScroll: true });
    });
    save.addEventListener("click", submit);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    row.append(hint, cancel, save);
    body.append(textarea, note, row);
    wrap.append(header.head, body);
    wrap.style.width = Math.min(320, viewportWidth() - 16) + "px";
    root.appendChild(wrap);
    composer = wrap;
    composerTarget = { target, el };
    placeComposer(true);
    wrap.style.visibility = "visible";
    try {
      textarea.focus({ preventScroll: true });
    } catch {
      textarea.focus();
    }
  }

  /* Bar fit, menu, visibility and password. */
  const FIT = ["t1", "t2", "t3", "t4", "t5", "t6"];
  function fitBar() {
    if (minimized || selecting || !host.isConnected) return;
    ui.classList.remove(...FIT);
    for (let i = 0; i < FIT.length; i += 1) {
      if (collapseBtn.getBoundingClientRect().right <= bar.getBoundingClientRect().right - 2) return;
      ui.classList.add(FIT[i]);
    }
  }
  function syncRelease() {
    releaseEl.textContent = releaseText();
    releaseEl.title = "Release " + (d.release || "live") + (d.version ? " \\u00b7 vers\\u00e3o " + d.version : "");
  }
  function syncVisibility(pending) {
    const v = pending || d.visibility;
    visWrap.dataset.v = v;
    visLabel.textContent = VIS[v] || v;
    visShort.textContent = VIS_SHORT[v] || v;
    const label = d.visibility === "password" ? "Trocar senha" : "Proteger com senha";
    managePasswordLabel.textContent = label + "\\u2026";
    passwordTitle.textContent = label;
    fitBar();
  }
  function openMenu(focusFirst) {
    dropOk();
    if (selecting) stopSelect();
    menuOpen = true;
    ui.classList.add("menu-open");
    menuBtn.setAttribute("aria-expanded", "true");
    updateCounts();
    if (focusFirst) setTimeout(() => managePassword.focus(), 0);
  }
  function closeMenu(focusTarget) {
    if (!menuOpen) return;
    const hadForm = ui.classList.contains("pw-open");
    menuOpen = false;
    pwFromSelect = false;
    ui.classList.remove("menu-open", "pw-open", "rl-open");
    rlToken += 1;
    passwordInput.value = "";
    menuBtn.setAttribute("aria-expanded", "false");
    if (hadForm && !select.disabled) {
      select.value = d.visibility;
      syncVisibility();
    }
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }
  function setHint(text, kind, invalid) {
    passwordHint.className = "hint" + (kind ? " " + kind : "");
    passwordHint.textContent = text;
    if (invalid) passwordInput.setAttribute("aria-invalid", "true");
    else passwordInput.removeAttribute("aria-invalid");
  }
  function openPasswordForm(fromSelect) {
    openMenu(false);
    pwFromSelect = Boolean(fromSelect);
    ui.classList.add("pw-open");
    passwordInput.value = "";
    setHint(
      d.visibility === "password" ? "Defina a nova senha, entre 8 e 128 caracteres." : "Entre 8 e 128 caracteres. Quem abrir a p\\u00e1gina vai precisar dela.",
      "",
    );
    syncVisibility(fromSelect ? "password" : "");
    setTimeout(() => passwordInput.focus({ preventScroll: true }), 30);
  }
  function closePasswordForm() {
    if (pwFromSelect) {
      closeMenu(select);
      return;
    }
    ui.classList.remove("pw-open");
    passwordInput.value = "";
    select.value = d.visibility;
    syncVisibility();
    managePassword.focus({ preventScroll: true });
  }
  async function applyVisibility(next) {
    if (next === d.visibility) {
      select.value = d.visibility;
      syncVisibility();
      return true;
    }
    const previousRelease = d.release;
    select.disabled = true;
    visWrap.classList.add("busy");
    syncVisibility(next);
    busyMsg("Atualizando visibilidade\\u2026");
    try {
      const payload = await postJson(d.visibilityUrl, { path: currentPath(), visibility: next }, "update_failed");
      d.visibility = (payload.route && (payload.route.effectiveVisibility || payload.route.visibility)) || next;
      const release = payload.release && payload.release.number;
      if (release) d.release = release;
      select.value = d.visibility;
      syncRelease();
      okMsg("P\\u00e1gina agora " + (VIS_NOW[d.visibility] || d.visibility) + (release && release !== previousRelease ? " \\u00b7 nova release r" + release : ""));
      return true;
    } catch (error) {
      select.value = d.visibility;
      failMsg(failure("mudar a visibilidade", error));
      return false;
    } finally {
      select.disabled = false;
      visWrap.classList.remove("busy");
      syncVisibility();
      updateCounts();
    }
  }
  async function savePassword() {
    const password = passwordInput.value;
    const size = Array.from(password).length;
    if (size < 8 || size > 128) {
      setHint("Use de 8 a 128 caracteres.", "err", true);
      passwordInput.focus();
      return;
    }
    const hadPassword = d.visibility === "password";
    passwordSave.disabled = true;
    passwordCancel.disabled = true;
    setHint("Salvando a senha\\u2026", "");
    try {
      await postJson(d.passwordUrl, { action: "set", path: currentPath(), scope: "route", password }, "password_update_failed");
      const updated = await applyVisibility("password");
      if (updated) {
        closeMenu(menuBtn);
        okMsg(hadPassword ? "Senha atualizada" : "Senha definida: a p\\u00e1gina agora pede senha");
      } else {
        setHint("A senha foi salva, mas a visibilidade n\\u00e3o mudou. Tente de novo.", "err");
      }
    } catch (error) {
      setHint(failure("definir a senha", error).text, "err");
    } finally {
      passwordSave.disabled = false;
      passwordCancel.disabled = false;
    }
  }
  function onVisibilityChange() {
    const next = select.value;
    if (next === "password") {
      openPasswordForm(true);
      return;
    }
    if (ui.classList.contains("pw-open")) closeMenu(null);
    void applyVisibility(next);
  }

  /* Release history: the site's releases, what changed in each (routes, files and lines) and a
     restore that re-activates an earlier release. A restore reloads the page on success. */
  const REASONS = {
    publish: "publica\\u00e7\\u00e3o",
    manual_release: "release manual",
    operator_visibility_update: "mudan\\u00e7a de visibilidade",
    cli_visibility_update: "visibilidade pela CLI",
  };
  const ROUTE_STATUS = { changed: "Alterada", added: "Nova", removed: "Removida" };
  const FILE_STATUS = { changed: "M", added: "A", removed: "D" };
  let rlData = null;
  let rlOpenId = "";
  let rlMode = "";
  let rlToken = 0;
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function rlButton(cls, text, onClick) {
    const btn = h("button", "btn " + cls, text);
    btn.type = "button";
    btn.addEventListener("click", onClick);
    return btn;
  }
  function shortDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    try {
      return date.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch {
      return date.toLocaleString();
    }
  }
  function sizeText(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }
  function releasesRequest(body, fallbackError) {
    return postJson(d.releasesUrl, Object.assign({ path: currentPath() }, body), fallbackError);
  }
  function rlNote(text, isError) {
    const note = h("p", "rl-note" + (isError ? " err" : ""), text);
    if (isError) note.setAttribute("role", "alert");
    return note;
  }
  function openReleases() {
    openMenu(false);
    ui.classList.add("rl-open");
    rlOpenId = "";
    rlMode = "";
    rlBody.replaceChildren(rlNote("Carregando releases\\u2026"));
    setTimeout(() => rlBack.focus({ preventScroll: true }), 30);
    void loadReleases();
  }
  function closeReleases() {
    ui.classList.remove("rl-open");
    rlToken += 1;
    releasesItem.focus({ preventScroll: true });
  }
  async function loadReleases() {
    const token = ++rlToken;
    try {
      const payload = await releasesRequest({ action: "list" }, "releases_failed");
      if (token !== rlToken) return;
      rlData = { releases: payload.releases || [], activeReleaseId: payload.activeReleaseId || "", routePath: (payload.currentRoute && payload.currentRoute.path) || "" };
      renderReleases();
    } catch (error) {
      if (token !== rlToken) return;
      rlBody.replaceChildren(rlNote(failure("carregar as releases", error).text, true));
    }
  }
  function renderReleases() {
    if (!rlData) return;
    const list = h("div", "rl-list");
    if (rlData.releases.length === 0) list.append(rlNote("Nenhuma release ainda."));
    rlData.releases.forEach((release) => list.append(releaseRow(release)));
    if (rlData.releases.length >= 30) list.append(rlNote("Mostrando as 30 mais recentes. As anteriores est\\u00e3o no Console."));
    rlBody.replaceChildren(list);
  }
  function releaseRow(release) {
    const live = release.id === rlData.activeReleaseId;
    const row = h("div", "rl-row");
    const top = h("div", "rl-top");
    const info = h("div", "rl-info");
    const head = h("div", "rl-name");
    head.append(h("span", "rl-num", "r" + release.number));
    const by = authorText(release.author);
    if (by) {
      const byEl = h("span", "rl-by", by);
      byEl.title = by;
      head.append(byEl);
    }
    if (live) head.append(h("span", "rl-live", "no ar"));
    else if (release.status === "failed") head.append(h("span", "rl-bad", "falhou"));
    info.append(head);
    const meta = [shortDate(release.createdAt), REASONS[release.reason] || release.reason || "", plural(release.routeCount || 0, "rota", "rotas")].filter(Boolean);
    info.append(h("div", "rl-meta", meta.join(" \\u00b7 ")));
    const acts = h("div", "rl-acts");
    const open = rlOpenId === release.id;
    const changes = rlButton("", "Mudan\\u00e7as", () => toggleRelease(release, "changes"));
    changes.setAttribute("aria-expanded", String(open && rlMode === "changes"));
    acts.append(changes);
    const canRestore = !live && release.status !== "failed" && release.status !== "draft" && (release.routeCount || 0) > 0 && rlData.activeReleaseId;
    if (canRestore) {
      const restore = rlButton("", "Restaurar", () => toggleRelease(release, "restore"));
      restore.setAttribute("aria-expanded", String(open && rlMode === "restore"));
      acts.append(restore);
    }
    top.append(info, acts);
    row.append(top);
    if (open) {
      const detail = h("div", "rl-detail");
      row.append(detail);
      if (rlMode === "restore") renderRestore(detail, release);
      else void renderChanges(detail, release, undefined, "O que mudou na r" + release.number + " em rela\\u00e7\\u00e3o \\u00e0 release anterior.");
    }
    return row;
  }
  function authorText(author) {
    if (!author) return "";
    if (author.via === "system") return "autom\\u00e1tica";
    const name = author.name || "algu\\u00e9m";
    return "por " + name + (author.via === "cli" ? " (CLI)" : "");
  }
  function toggleRelease(release, mode) {
    if (rlOpenId === release.id && rlMode === mode) {
      rlOpenId = "";
      rlMode = "";
    } else {
      rlOpenId = release.id;
      rlMode = mode;
    }
    renderReleases();
  }
  async function renderChanges(detail, release, baseReleaseId, caption) {
    const target = h("div", "rl-cmp");
    detail.prepend(rlNote(caption), target);
    target.append(rlNote("Comparando\\u2026"));
    const token = rlToken;
    try {
      const body = { action: "compare", releaseId: release.id };
      if (baseReleaseId !== undefined) body.baseReleaseId = baseReleaseId;
      const payload = await releasesRequest(body, "compare_failed");
      if (token !== rlToken || !target.isConnected) return;
      target.replaceChildren(...comparisonNodes(payload.comparison, release, baseReleaseId));
    } catch (error) {
      if (token !== rlToken || !target.isConnected) return;
      target.replaceChildren(rlNote(failure("comparar as releases", error).text, true));
    }
  }
  function comparisonNodes(cmp, release, baseReleaseId) {
    const s = cmp.summary;
    const parts = [];
    if (s.routesChanged) parts.push(plural(s.routesChanged, "rota alterada", "rotas alteradas"));
    if (s.routesAdded) parts.push(plural(s.routesAdded, "rota nova", "rotas novas"));
    if (s.routesRemoved) parts.push(plural(s.routesRemoved, "rota removida", "rotas removidas"));
    if (s.filesChanged) parts.push(plural(s.filesChanged, "arquivo alterado", "arquivos alterados"));
    if (s.filesAdded) parts.push(plural(s.filesAdded, "arquivo novo", "arquivos novos"));
    if (s.filesRemoved) parts.push(plural(s.filesRemoved, "arquivo removido", "arquivos removidos"));
    const span = cmp.base ? "r" + cmp.base.releaseNumber + " \\u2192 r" + cmp.target.releaseNumber : "r" + cmp.target.releaseNumber;
    const nodes = [h("p", "rl-sum", span + " \\u00b7 " + (parts.length ? parts.join(", ") : "nenhuma diferen\\u00e7a"))];
    const routes = cmp.routes.filter((route) => route.status !== "unchanged");
    // The page the operator is looking at comes first.
    routes.sort((a, b) => Number(b.path === rlData.routePath) - Number(a.path === rlData.routePath));
    routes.forEach((route) => nodes.push(routeNode(route, release, baseReleaseId)));
    return nodes;
  }
  function routeNode(route, release, baseReleaseId) {
    const box = h("div", "rt");
    const head = h("div", "rt-h");
    head.append(h("span", "pill " + route.status, ROUTE_STATUS[route.status] || route.status), h("span", "rt-p", route.path));
    if (route.path === rlData.routePath) head.append(h("span", "rt-here", "esta p\\u00e1gina"));
    const notes = [];
    const changes = route.changes || [];
    if (changes.includes("visibility")) notes.push((VIS[route.base.visibility] || route.base.visibility) + " \\u2192 " + (VIS[route.target.visibility] || route.target.visibility));
    if (changes.includes("content") && route.base && route.target && route.base.artifactVersionNumber && route.target.artifactVersionNumber) {
      notes.push("v" + route.base.artifactVersionNumber + " \\u2192 v" + route.target.artifactVersionNumber);
    }
    if (changes.includes("entrypoint")) notes.push("entrada " + route.base.entrypoint + " \\u2192 " + route.target.entrypoint);
    if (notes.length) head.append(h("span", "rt-n", notes.join(" \\u00b7 ")));
    box.append(head);
    const files = route.files || [];
    if (files.length) {
      const list = h("ul", "fl");
      files.slice(0, 60).forEach((file) => list.append(fileNode(file, route, release, baseReleaseId)));
      box.append(list);
      if (files.length > 60) box.append(rlNote("+" + (files.length - 60) + " arquivos"));
    }
    return box;
  }
  function fileNode(file, route, release, baseReleaseId) {
    const item = h("li", "");
    const btn = h("button", "fb");
    btn.type = "button";
    const before = file.base && file.base.sizeBytes;
    const after = file.target && file.target.sizeBytes;
    const size = file.status === "changed" && before != null && after != null && before !== after ? sizeText(before) + " \\u2192 " + sizeText(after) : sizeText(after != null ? after : before);
    btn.append(h("span", "fs " + file.status, FILE_STATUS[file.status] || "?"), h("span", "fp", file.path), h("span", "fz", size));
    btn.title = file.textDiffAvailable ? "Ver as linhas que mudaram" : "Arquivo bin\\u00e1rio ou grande: s\\u00f3 a mudan\\u00e7a \\u00e9 listada";
    if (!file.textDiffAvailable) btn.disabled = true;
    else btn.setAttribute("aria-expanded", "false");
    item.append(btn);
    let box = null;
    btn.addEventListener("click", async () => {
      if (box) {
        box.remove();
        box = null;
        btn.setAttribute("aria-expanded", "false");
        return;
      }
      btn.setAttribute("aria-expanded", "true");
      box = h("div", "df");
      box.append(h("div", "dgap", "Carregando\\u2026"));
      item.append(box);
      const mine = box;
      try {
        const body = { action: "file_diff", releaseId: release.id, routePath: route.path, matchType: route.matchType, file: file.path };
        if (baseReleaseId !== undefined) body.baseReleaseId = baseReleaseId;
        const payload = await releasesRequest(body, "file_diff_failed");
        if (box !== mine) return;
        mine.replaceChildren(...diffNodes(payload.fileDiff && payload.fileDiff.diff));
      } catch (error) {
        if (box !== mine) return;
        mine.replaceChildren(h("div", "dgap", failure("carregar o arquivo", error).text));
      }
    });
    return item;
  }
  function diffNodes(diff) {
    if (!diff || diff.kind === "unavailable") return [h("div", "dgap", "N\\u00e3o deu para ler os bytes deste arquivo.")];
    if (diff.kind === "binary") return [h("div", "dgap", "Arquivo bin\\u00e1rio: sem diff de linhas.")];
    if (diff.kind === "too_large") return [h("div", "dgap", "Mudou demais para mostrar linha a linha.")];
    if (!diff.hunks.length) return [h("div", "dgap", "S\\u00f3 mudaram quebras de linha.")];
    const nodes = [];
    diff.hunks.forEach((hunk, index) => {
      if (index > 0) nodes.push(h("div", "dgap", "\\u22ef"));
      hunk.lines.forEach((line) => {
        const row = h("div", "dl" + (line.type === "added" ? " add" : line.type === "removed" ? " del" : ""));
        row.append(
          h("span", "dn", line.baseLine == null ? "" : String(line.baseLine)),
          h("span", "dn", line.targetLine == null ? "" : String(line.targetLine)),
          h("span", "dsg", line.type === "added" ? "+" : line.type === "removed" ? "-" : " "),
          h("span", "dt", line.text),
        );
        nodes.push(row);
      });
    });
    if (diff.truncated) nodes.push(h("div", "dgap", "Diff cortado: " + diff.added + " linhas novas e " + diff.removed + " removidas no total."));
    return nodes;
  }
  function renderRestore(detail, release) {
    const acts = h("div", "rl-confirm");
    const hint = h("p", "rl-note", "");
    const go = rlButton("go", "Restaurar r" + release.number, async () => {
      go.disabled = true;
      cancel.disabled = true;
      hint.className = "rl-note";
      hint.textContent = "Restaurando r" + release.number + "\\u2026";
      try {
        await releasesRequest({ action: "restore", releaseId: release.id }, "restore_failed");
        hint.textContent = "r" + release.number + " est\\u00e1 no ar de novo. Recarregando\\u2026";
        okMsg("r" + release.number + " est\\u00e1 no ar de novo");
        setTimeout(() => location.reload(), 900);
      } catch (error) {
        hint.className = "rl-note err";
        hint.setAttribute("role", "alert");
        hint.textContent = restoreFailure(error);
        go.disabled = false;
        cancel.disabled = false;
      }
    });
    const cancel = rlButton("", "Cancelar", () => toggleRelease(release, "restore"));
    acts.append(go, cancel);
    const changes = h("div", "rl-after");
    detail.append(hint, acts, changes);
    void renderChanges(changes, release, rlData.activeReleaseId, "O que muda no ar se a r" + release.number + " voltar. A release atual continua no hist\\u00f3rico.");
  }
  function restoreFailure(error) {
    const code = error && error.message ? String(error.message) : "";
    if (code === "publish_unread_comments") return "H\\u00e1 coment\\u00e1rios n\\u00e3o lidos nas p\\u00e1ginas dessa release. Leia os coment\\u00e1rios e tente de novo.";
    if (code === "publish_validation_failed") return "Essa release n\\u00e3o pode voltar ao ar: os arquivos n\\u00e3o est\\u00e3o prontos ou uma rota com senha est\\u00e1 sem senha definida.";
    return failure("restaurar a release", error).text;
  }

  /* Minimize: drop every offset, keep the content steady, leave a handle on the top edge placed
     where it does not cover the page's links or buttons. Remembered per tab. */
  function placeHandle() {
    if (!minimized) return;
    const vw = viewportWidth();
    const w = expandBtn.offsetWidth || 44;
    const h = expandBtn.offsetHeight || 24;
    const fractions = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9, 0, 1];
    let best = null;
    expandBtn.style.pointerEvents = "none";
    // Score each slot: covering a link/button/input is much worse than covering plain text.
    const textCover = (el, left) => {
      let area = 0;
      const nodes = el.childNodes;
      for (let i = 0; i < nodes.length && i < 40; i += 1) {
        const node = nodes[i];
        if (node.nodeType !== 3 || !/\\S/.test(node.nodeValue || "")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        for (let j = 0; j < rects.length && j < 20; j += 1) {
          const r = rects[j];
          const ix = Math.min(r.right, left + w) - Math.max(r.left, left);
          const iy = Math.min(r.bottom, h) - Math.max(r.top, 0);
          if (ix > 0 && iy > 0) area += ix * iy;
        }
      }
      return area;
    };
    for (let i = 0; i < fractions.length; i += 1) {
      const left = clamp(Math.round(vw * fractions[i] - w / 2), 6, Math.max(6, vw - w - 6));
      const points = [[left + 2, 2], [left + w / 2, 2], [left + w - 2, 2], [left + 2, h - 2], [left + w / 2, h - 2], [left + w - 2, h - 2], [left + w / 2, h + 4]];
      let score = 0;
      const seen = [];
      points.forEach((p) => {
        const el = document.elementFromPoint(p[0], p[1]);
        if (!el || el === host || isOperatorElement(el)) return;
        if (el.closest && el.closest(INTERACTIVE)) score += 100000;
        else if (seen.indexOf(el) < 0) {
          seen.push(el);
          score += textCover(el, left);
        }
      });
      if (!best || score < best.score) best = { left, score };
      if (!score) break;
    }
    expandBtn.style.pointerEvents = "";
    expandBtn.style.left = best.left + "px";
  }
  function setMinimized(next, fromUser) {
    if (next === minimized) return;
    const y = window.scrollY;
    const before = barH;
    if (next) {
      closeMenu(null);
      if (selecting) stopSelect();
    }
    minimized = next;
    ui.classList.toggle("min", next);
    try {
      sessionStorage.setItem(MIN_KEY, next ? "1" : "0");
    } catch {}
    if (!next) appShell = null;
    applyOffset();
    if (y > 0 && barH !== before) jumpTo(Math.max(0, y + barH - before));
    relayout();
    if (fromUser) {
      (next ? expandBtn : collapseBtn).focus({ preventScroll: true });
      announce(next ? "Barra do Ravi Page minimizada" : "Barra do Ravi Page restaurada");
    }
  }
  function relayout() {
    applyOffset();
    fitBar();
    positionPins();
    if (markEl && markEl.isConnected) moveMark(markEl, markSoft);
    if (composer) placeComposer();
    if (bubble) placeBubble();
    if (minimized) placeHandle();
  }
  let layoutFrame = 0;
  function queueLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      positionPins();
      if (markEl && markEl.isConnected) moveMark(markEl, markSoft);
      if (composer) placeComposer();
      if (bubble) placeBubble();
    });
  }

  /* Print: drop the offsets and restore moved tops while printing. */
  function beforePrint() {
    if (printing) return;
    printing = true;
    restoreShifted();
    applyOffset();
  }
  function afterPrint() {
    if (!printing) return;
    printing = false;
    applyOffset();
  }

  /* Escape closes one layer per press: menu, selection, composer, thread. */
  function onKey(event) {
    // Escape during IME composition cancels the composition, not our layers.
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
    if (menuOpen) {
      closeMenu(pwFromSelect ? select : menuBtn);
      return;
    }
    if (selecting) {
      stopSelect();
      pick.focus({ preventScroll: true });
      return;
    }
    if (composer) {
      const hadFocus = composer.contains(document.activeElement);
      clearComposer();
      if (hadFocus && !minimized) pick.focus({ preventScroll: true });
      return;
    }
    if (bubble) {
      const pin = openRec && openRec.pin;
      const hadFocus = bubble.contains(document.activeElement);
      clearBubble();
      if (pin && hadFocus && pin.isConnected) pin.focus({ preventScroll: true });
    }
  }
  function onDocumentClick(event) {
    const path = event.composedPath ? event.composedPath() : [];
    if (menuOpen && !path.includes(panel) && !path.includes(menuBtn) && !path.includes(releaseEl)) closeMenu(null);
    if (bubble && !path.includes(bubble) && !isOperatorElement(event.target)) clearBubble();
  }

  hostEl.textContent = d.host || "Ravi Page";
  link.href = d.consoleUrl;
  linkMenu.href = d.consoleUrl;
  select.value = d.visibility;
  syncRelease();
  setPinsHidden(false);

  menuBtn.addEventListener("click", (event) => {
    if (menuOpen) closeMenu(null);
    else openMenu(event.detail === 0);
  });
  scrim.addEventListener("click", () => closeMenu(null));
  select.addEventListener("change", onVisibilityChange);
  managePassword.addEventListener("click", () => openPasswordForm(false));
  releasesItem.addEventListener("click", openReleases);
  releaseEl.addEventListener("click", () => {
    if (menuOpen && ui.classList.contains("rl-open")) closeMenu(releaseEl);
    else openReleases();
  });
  rlBack.addEventListener("click", closeReleases);
  passwordCancel.addEventListener("click", closePasswordForm);
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void savePassword();
  });
  togglePins.addEventListener("click", () => {
    setPinsHidden(!pinsHidden);
    closeMenu(null);
    okMsg(pinsHidden ? "Marcadores ocultos" : "Marcadores vis\\u00edveis");
  });
  refresh.addEventListener("click", () => {
    closeMenu(null);
    void loadComments(true, true);
  });
  linkMenu.addEventListener("click", () => closeMenu(null));
  pick.addEventListener("click", startSelect);
  pickCancel.addEventListener("click", () => {
    stopSelect();
    pick.focus({ preventScroll: true });
  });
  nextBtn.addEventListener("click", goToNextThread);
  collapseBtn.addEventListener("click", () => setMinimized(true, true));
  hideItem.addEventListener("click", () => setMinimized(true, true));
  expandBtn.addEventListener("click", () => setMinimized(false, true));
  status.addEventListener("click", () => say("", ""));
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", onDocumentClick, true);
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Height-only changes are the on-screen keyboard: keep open cards where they are.
      if (window.innerWidth === lastWidth) {
        if (minimized) placeHandle();
        return;
      }
      lastWidth = window.innerWidth;
      relayout();
    }, 150);
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("load", relayout);
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  const printQuery = window.matchMedia ? window.matchMedia("print") : null;
  if (printQuery && printQuery.addEventListener) printQuery.addEventListener("change", (event) => (event.matches ? beforePrint() : afterPrint()));

  try {
    minimized = sessionStorage.getItem(MIN_KEY) === "1";
  } catch {}
  ui.classList.toggle("min", minimized);
  root.appendChild(host);
  (document.head || root).appendChild(helperStyle);
  syncVisibility();
  updateCounts();
  applyOffset();
  fitBar();
  if (minimized) placeHandle();
  if (window.ResizeObserver && document.body) new ResizeObserver(queueLayout).observe(document.body);
  if (window.MutationObserver && document.body) {
    // Cheap per batch: a moved element whose inline top, position or classes changed (or whose
    // ancestor's classes did) is re-evaluated once, right away; anything else only matters once per
    // pending scan, so the operator-UI check stops after the first hit.
    observer = new MutationObserver((records) => {
      let relevant = Boolean(scanTimer);
      const again = new Set();
      const styled = new Set();
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        const target = record.target;
        if (record.type === "attributes") {
          if (target.nodeType !== 1) continue;
          const name = record.attributeName;
          // classList.add/toggle rewrite the attribute even when nothing changes (often on every
          // scroll event): those records say nothing.
          if (name === "class" && record.oldValue === target.getAttribute("class")) continue;
          const rec = shifted.size ? shifted.get(target) : null;
          if (rec) {
            if (minimized) continue;
            if (name === "class" || target.style.getPropertyValue("top") !== rec.top.applied) again.add(target);
            else styled.add(target);
            continue;
          }
          if (shells.size && name === "style" && shells.has(target)) continue;
          if (name === "class" && !minimized) {
            const inside = [];
            shifted.forEach((_, el) => {
              if (target !== el && target.contains(el)) inside.push(el);
            });
            // Only the ones pinned now; a later scan or scroll stop re-reads the rest.
            if (inside.length) pinnedNow(inside, false).forEach((el) => again.add(el));
            shells.forEach((_, el) => {
              if (target === el || target.contains(el)) shellsDirty = true;
            });
          }
          if (!relevant && !isOperatorElement(target)) relevant = true;
        } else if (!relevant && target.nodeType === 1 && !isOperatorElement(target)) {
          for (let j = 0; j < record.addedNodes.length; j += 1) {
            const node = record.addedNodes[j];
            if (node.nodeType === 1 && !isOperatorElement(node)) relevant = true;
          }
        }
      }
      styled.forEach((el) => {
        const rec = shifted.get(el);
        if (rec && !again.has(el) && getComputedStyle(el).position !== rec.kind) again.add(el);
      });
      if (again.size) {
        again.forEach(reapply);
        observer.takeRecords();
      }
      heightHint.clear();
      if (relevant) scheduleScan();
    });
    const watch = { attributes: true, attributeOldValue: true };
    observer.observe(document.body, Object.assign({ childList: true, subtree: true, attributeFilter: ["class", "style"] }, watch));
    // Classes on <html> (scroll-state flags many sites set there) can unpin or re-pin chrome too.
    observer.observe(root, Object.assign({ attributeFilter: ["class"] }, watch));
  }
  // Entrance animations and delayed reveals (a navbar sliding in from above) change no DOM: the
  // load and mutation scans ran while the header was still off its place, so look again once a
  // page animation or a layout-affecting transition ends.
  const settled = (event) => {
    const target = event.target;
    if (!target || target.nodeType !== 1 || target === host || isOperatorElement(target)) return;
    if (event.type === "transitionend" && !/^(top|inset|transform|translate|opacity|visibility|margin|height|max-height|display)/.test(event.propertyName || "")) return;
    // Soon (the mutation scan may have backed off for seconds), at most one scan at a time, and
    // without the dense in-bar rows (headers are wide; small fixed controls rarely animate in).
    if (!settleTimer) {
      settleTimer = setTimeout(() => {
        settleTimer = 0;
        if (minimized) return;
        shiftHeaders("scroll");
        fitShells(false);
        positionPins();
      }, 150);
    }
  };
  document.addEventListener("animationend", settled, true);
  document.addEventListener("transitionend", settled, true);
  if (current) current.remove();
  void loadComments(true);
})();
`;

  return `<script data-ravi-pages-toolbar="1">${script}</script>`;
}

function consolePageUrl(env: PagesWorkerEnv, projectId: string, siteId: string) {
  try {
    return new URL(`/p/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(siteId)}`, env.RAVI_CONSOLE_API_URL).toString();
  } catch {
    return "https://console.ravi.bot/projects";
  }
}

function appendVaryHeader(headers: Headers, value: string) {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }
  const values = current.split(",").map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) headers.set("vary", `${current}, ${value}`);
}

function safeResolvedHeaders(input: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  if (!input) return headers;

  for (const [key, value] of Object.entries(input)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "cache-control" ||
      normalized === "content-language" ||
      normalized === "content-length" ||
      normalized === "content-type" ||
      normalized === "etag"
    ) {
      headers.set(normalized, value);
    }
  }

  return headers;
}

function isRaviPagesApex(url: URL, env: PagesWorkerEnv): boolean {
  return url.hostname.toLowerCase() === (env.RAVI_PAGES_HOSTED_DOMAIN ?? RAVI_PAGES_APEX_HOST).toLowerCase();
}

function reservedRoute(url: URL): Response {
  return notFound();
}

function notFound(): Response {
  return errorPage({
    status: 404,
    eyebrow: "404",
    title: "Page not found",
    message: "This Ravi Page is not published here, or you do not have access to it.",
  });
}

function privateNotFound(options: { clearPagesSession?: boolean; extraClearCookies?: string[] } = {}): Response {
  const response = notFound();
  if (options.clearPagesSession) {
    response.headers.append("set-cookie", clearPagesSessionCookie());
  }
  for (const cookie of options.extraClearCookies ?? []) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

function clearPagesSessionCookie() {
  return `${PAGES_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function methodNotAllowed(): Response {
  return errorPage(
    {
      status: 405,
      eyebrow: "405",
      title: "Method not allowed",
      message: "Ravi Pages serves static sites through GET and HEAD requests.",
    },
    {
      allow: "GET, HEAD",
    },
  );
}

function serviceUnavailable(error: string): Response {
  void error;
  return errorPage({
    status: 503,
    eyebrow: "503",
    title: "Page temporarily unavailable",
    message: "Ravi Pages could not serve this page right now. Try again in a moment.",
  });
}

function standardPage(): Response {
  return htmlResponse(raviPagesHomeHtml(), {
    status: 200,
    headers: {
      "cache-control": "public, max-age=300",
    },
  });
}

function errorPage(
  input: {
    diagnostic?: string;
    eyebrow: string;
    message: string;
    status: number;
    title: string;
  },
  headers: Record<string, string> = {},
): Response {
  return htmlResponse(errorPageHtml(input), {
    status: input.status,
    headers: {
      ...noStoreHeaders(),
      ...headers,
    },
  });
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  applyDefaultSecurityHeaders(headers, "text/html; charset=utf-8");

  return new Response(html, {
    ...init,
    headers,
  });
}

function raviPagesHomeHtml(): string {
  return pageShell({
    eyebrow: "Ravi Pages",
    title: "Publish a page from any Ravi project.",
    message:
      "Ravi Pages turns a versioned artifact into a live URL with hosted routes, release history, visibility controls, and rollback.",
    body: `
      <section class="panel">
        <p class="label">Publish flow</p>
        <pre><code>ravi pages publish core ./site --route / --visibility public --entrypoint index.html</code></pre>
        <p>One command uploads your files, creates an immutable release, and activates the route on your project host.</p>
      </section>
      <section class="grid">
        <div><strong>Project-owned hosts</strong><span>Each project gets a clear <code>org-project.ravi.page</code> home.</span></div>
        <div><strong>Routes as pages</strong><span>Publish <code>/</code>, <code>/docs</code>, <code>/pitch</code>, or any static route.</span></div>
        <div><strong>Governed releases</strong><span>Visibility, audit, active versions, and private access stay in Console.</span></div>
      </section>
      <p class="action"><a href="https://console.ravi.bot/login">Open Ravi Console</a></p>
    `,
  });
}

function errorPageHtml(input: { diagnostic?: string; eyebrow: string; message: string; title: string }): string {
  const diagnostic = input.diagnostic
    ? `<p class="diagnostic">Reference: <code>${escapeHtml(input.diagnostic)}</code></p>`
    : "";
  return pageShell({
    eyebrow: input.eyebrow,
    title: input.title,
    message: input.message,
    body: `
      ${diagnostic}
      <section class="panel">
        <p class="label">Publishing with Ravi Pages</p>
        <pre><code>ravi pages publish &lt;project&gt; ./site --route / --visibility public</code></pre>
        <p>If this is your project, publish a route or check the active release in Ravi Console.</p>
      </section>
      <p class="action"><a href="https://console.ravi.bot/login">Open Ravi Console</a></p>
    `,
  });
}

function pageShell(input: { body: string; eyebrow: string; message: string; title: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.title)} · Ravi Pages</title>
    <style>
      :root { color-scheme: light; --ink: #17202a; --muted: #5f6f80; --line: #d8e0e7; --soft: #f5f8fb; --accent: #14635a; --accent-2: #b45d28; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #fbfcfd; color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
      main { width: min(920px, calc(100vw - 40px)); margin: 0 auto; padding: 72px 0 56px; }
      .mark { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid var(--line); background: #fff; color: var(--accent); font-weight: 760; }
      .eyebrow, .label { margin: 24px 0 10px; color: var(--accent); font-size: 12px; font-weight: 760; text-transform: uppercase; letter-spacing: .08em; }
      h1 { max-width: 760px; margin: 0; font-size: clamp(40px, 6vw, 72px); line-height: .98; letter-spacing: 0; }
      .lead { max-width: 660px; margin: 20px 0 0; color: var(--muted); font-size: 19px; line-height: 1.55; }
      .panel { margin-top: 34px; padding: 22px; border: 1px solid var(--line); background: #fff; border-radius: 8px; }
      pre { margin: 0 0 14px; padding: 14px; overflow-x: auto; border-radius: 6px; background: #10201e; color: #ecf8f4; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .92em; }
      .panel p { margin: 0; color: var(--muted); line-height: 1.55; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
      .grid div { padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
      .grid strong, .grid span { display: block; }
      .grid span { margin-top: 8px; color: var(--muted); line-height: 1.45; }
      .action { margin: 28px 0 0; }
      a { color: var(--accent); font-weight: 760; text-decoration-thickness: 2px; text-underline-offset: 3px; }
      .diagnostic { margin: 20px 0 0; color: var(--muted); }
      @media (max-width: 760px) { main { width: min(100vw - 28px, 920px); padding-top: 42px; } .grid { grid-template-columns: 1fr; } h1 { font-size: 42px; } }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">R</div>
      <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
      <h1>${escapeHtml(input.title)}</h1>
      <p class="lead">${escapeHtml(input.message)}</p>
      ${input.body}
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");

  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

function noStoreHeaders(): Record<string, string> {
  return {
    "cache-control": NO_STORE_CACHE,
  };
}
