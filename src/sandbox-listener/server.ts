// The home daemon's sandbox listener: the loopback HTTP origin behind
// cloudflared that serves Gate-forwarded task commands for connected sandbox
// runs. Normative contract: Console `sandbox-gateway/listener` SPEC (§Request
// Checks, §Authorization And Dispatch, §Responses); OSS mirror
// `.ravi/specs/sandbox/listener`.
//
// It composes the 04a verifiers (Access JWT, Gate assertion, stored grant)
// with the SDK gateway's two lower pieces, `buildRouteTable` and `dispatch`
// with `source: "gateway"`, and never `handleGatewayRequest`: no `/_meta`, no
// streaming, no open-scope passthrough, no bearer. Authority comes only from
// the run's child context created by the host CLI (`run-context.ts`); the
// listener never mints it and never reads `Authorization`.
//
// node:http rather than `Bun.serve`: the Gate assertion is bound to the RAW
// request target, and a failed served-jti append must close the connection
// without any response, neither of which a `Request`/`Response` pair offers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { emitCliAuditEvent } from "../cli/audit.js";
import { getRegistry, type CommandRegistryEntry, type RegistrySnapshot } from "../cli/registry-snapshot.js";
import type { ContextRecord } from "../router/router-db.js";
import {
  getLiveSandboxRun,
  getLiveSandboxRunContext,
  SANDBOX_ACKNOWLEDGED_JTI_RETENTION_MS,
} from "../sandbox/run-context.js";
import {
  dbAppendServedJti,
  dbBumpSandboxRunRequest,
  dbGetSandboxRun,
  dbListRecentServedJtis,
  dbPruneAcknowledgedServedJtis,
} from "../sandbox/runs-db.js";
import { type AuditEvent, dispatch } from "../sdk/gateway/dispatcher.js";
import { buildRouteTable, type RouteTable } from "../sdk/gateway/route-table.js";
import { logger } from "../utils/logger.js";
import { getRaviStateDir } from "../utils/paths.js";
import { accessCertsUrl, verifyAccessAssertion } from "./access-jwt.js";
import type { SandboxListenerConfig } from "./config.js";
import {
  ACCESS_JWT_HEADER,
  canonicalizeStringList,
  isAllowlistedSandboxCommand,
  SANDBOX_GATE_ASSERTION_HEADER,
  SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS,
  SANDBOX_GATE_JWKS_PATH,
  SANDBOX_GATE_MARKER_HEADER,
  SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
  SANDBOX_GRANT_HEADER,
  SANDBOX_GRANT_JTI_RE,
  SANDBOX_GRANT_JWKS_PATH,
  SANDBOX_LISTENER_MARKER_HEADER,
  SANDBOX_REQUEST_ID_HEADER,
} from "./contract.js";
import { commandIdFromPath, GateAssertionReplayCache, verifyGateAssertion } from "./gate-assertion.js";
import { verifySandboxGrant } from "./grant.js";
import { JwksCache, type JwksFetch } from "./jwks-cache.js";

const log = logger.child("sandbox-listener");

export const SANDBOX_LISTENER_HOST = "127.0.0.1";
export const SANDBOX_LISTENER_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const SANDBOX_LISTENER_ERROR_SOURCE = "ravi-listener";

/** Gate-side ceilings (Console listener SPEC step 10); settings may lower them, never raise them. */
export const SANDBOX_LISTENER_DEFAULT_LIMITS = Object.freeze({
  perRunPerMinute: 30,
  globalPerMinute: 120,
  perRunConcurrency: 2,
  globalConcurrency: 8,
  dispatchTimeoutMs: 25_000,
});
export type SandboxListenerLimits = { -readonly [K in keyof typeof SANDBOX_LISTENER_DEFAULT_LIMITS]: number };

/**
 * How long after `servedAt` the verifier could still accept an assertion whose
 * `exp` was not recorded: the Gate's `iat` may run up to the skew ahead of
 * our clock, the assertion lives at most its max lifetime past that, and the
 * verifier accepts it until `exp` + the skew. Rows carrying `assertion_exp`
 * use the exact `exp` instead; this bound also sizes the preload query.
 */
const REPLAY_UNKNOWN_EXP_KEEP_SECONDS =
  SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS + 2 * SANDBOX_GRANT_CLOCK_SKEW_SECONDS;
const REPLAY_PRELOAD_WINDOW_MS = REPLAY_UNKNOWN_EXP_KEEP_SECONDS * 1000;

/** How often a running listener drops acknowledged served jtis past retention. */
export const SANDBOX_SERVED_JTI_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export type SandboxListenerErrorCode =
  | "body_invalid"
  | "argument_invalid"
  | "access_invalid"
  | "gate_assertion_invalid"
  | "grant_invalid"
  | "grant_revoked"
  | "command_not_allowed"
  | "resource_forbidden"
  | "not_found"
  | "payload_too_large"
  | "host_mismatch"
  | "rate_limited"
  | "jwks_unavailable"
  | "tunnel_drift"
  | "timeout";

export interface SandboxListenerOutcome {
  requestId: string | null;
  runId: string | null;
  cmd: string | null;
  status: number;
  /** Listener refusal code; null when the dispatcher's own response was passed through. */
  code: SandboxListenerErrorCode | null;
  /** Verifier reason behind a refusal (diagnostics; never sent to the client). */
  reason?: string;
}

export interface SandboxListenerDeps {
  /** JWKS fetch (tests inject a fake origin; the daemon uses global fetch). */
  fetch?: JwksFetch;
  /** Clock in Unix milliseconds. */
  now?: () => number;
  /** Listener start in Unix seconds; defaults to `now()` at start. Tests only. */
  listenerStartedAt?: number;
  registry?: RegistrySnapshot;
  /** Audit sink override (tests). The default emits the standard CLI audit event. */
  emitAudit?: (event: AuditEvent, meta: { runId: string; requestId: string }) => Promise<void> | void;
  /** Directory for the 0600 persisted JWKS files; `null` disables persistence. */
  jwksPersistDir?: string | null;
  limits?: Partial<SandboxListenerLimits>;
  /** Served-jti append override (tests make it fail). */
  appendServedJti?: typeof dbAppendServedJti;
  /** Acknowledged served-jti prune period; defaults to `SANDBOX_SERVED_JTI_PRUNE_INTERVAL_MS` (tests shorten it). */
  servedJtiPruneIntervalMs?: number;
  onOutcome?: (outcome: SandboxListenerOutcome) => void;
}

export interface StartSandboxListenerOptions {
  port: number;
  /** Must be `127.0.0.1`; there is no override. */
  host?: string;
  config: SandboxListenerConfig;
  deps?: SandboxListenerDeps;
}

export interface SandboxListenerHandle {
  host: string;
  port: number;
  url: string;
  /** Unix seconds. */
  startedAt: number;
  isDriftLatched(): boolean;
  /** 05a/05b: a latched listener refuses every request with 503 `tunnel_drift`. */
  setDriftLatched(latched: boolean): void;
  stop(): Promise<void>;
}

export async function startSandboxListener(options: StartSandboxListenerOptions): Promise<SandboxListenerHandle> {
  const host = options.host ?? SANDBOX_LISTENER_HOST;
  if (host !== SANDBOX_LISTENER_HOST) {
    throw new Error(`The sandbox listener binds ${SANDBOX_LISTENER_HOST} only (got ${host}); there is no override.`);
  }
  const { config } = options;
  if (!config.accessClientId) {
    throw new Error("The sandbox listener refuses to start without gateway.access.clientId (common_name pin).");
  }
  if (!config.installationId || !config.consoleIssuer || !config.tunnelHostname) {
    throw new Error("The sandbox listener needs installationId, consoleIssuer and tunnelHostname.");
  }

  const deps = options.deps ?? {};
  const now = deps.now ?? Date.now;
  const startedAt = deps.listenerStartedAt ?? Math.floor(now() / 1000);
  const limits = resolveLimits(deps.limits);
  const persistDir =
    deps.jwksPersistDir === null ? null : (deps.jwksPersistDir ?? join(getRaviStateDir(), "sandbox-listener"));
  const jwks = (name: string, url: string) =>
    new JwksCache({
      url,
      fetch: deps.fetch,
      now,
      ...(persistDir ? { persistPath: join(persistDir, `jwks-${name}.json`) } : {}),
    });
  const state: ListenerState = {
    config,
    now,
    startedAt,
    limits,
    table: buildRouteTable(deps.registry ?? getRegistry()),
    accessJwks: jwks("access", accessCertsUrl(config.accessTeamDomain)),
    gateJwks: jwks("gate", `${config.consoleIssuer}${SANDBOX_GATE_JWKS_PATH}`),
    grantJwks: jwks("grant", `${config.consoleIssuer}${SANDBOX_GRANT_JWKS_PATH}`),
    replayCache: new GateAssertionReplayCache(),
    driftLatched: config.driftLatched,
    globalBucket: new TokenBucket(limits.globalPerMinute),
    runBuckets: new Map(),
    inflightGlobal: 0,
    inflightByRun: new Map(),
    appendServedJti: deps.appendServedJti ?? dbAppendServedJti,
    emitAudit: deps.emitAudit,
    onOutcome: deps.onOutcome,
  };

  // The daemon prunes expired and revoked runs at every start
  // (`pruneSandboxRunsAtStart`), listener or not. Recent served jtis close the
  // replay window a restart would otherwise reopen: each is kept exactly as
  // long as the verifier could still accept its assertion (`exp` + skew,
  // which `remember` adds), or, without a recorded `exp`, for the widest
  // window `servedAt` allows.
  const nowSeconds = Math.floor(now() / 1000);
  for (const served of dbListRecentServedJtis(now(), REPLAY_PRELOAD_WINDOW_MS)) {
    const expSeconds =
      served.assertionExp ??
      Math.floor(served.servedAt / 1000) + REPLAY_UNKNOWN_EXP_KEEP_SECONDS - SANDBOX_GRANT_CLOCK_SKEW_SECONDS;
    state.replayCache.remember(served.jti, expSeconds, nowSeconds);
  }

  // Acknowledged jtis have reached Console; keep them only for the retention
  // window (which covers the replay window) while the listener runs.
  const pruneTimer = setInterval(() => {
    try {
      const pruned = dbPruneAcknowledgedServedJtis(now() - SANDBOX_ACKNOWLEDGED_JTI_RETENTION_MS);
      if (pruned > 0) log.info("Pruned acknowledged served jtis", { pruned });
    } catch (error) {
      log.warn("Acknowledged served-jti prune failed", { error });
    }
  }, deps.servedJtiPruneIntervalMs ?? SANDBOX_SERVED_JTI_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  const server = createServer((req, res) => {
    void handleRequest(state, req, res);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(pruneTimer);
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  log.info("Sandbox listener ready", {
    host,
    port,
    tunnelHostname: config.tunnelHostname,
    replayPreloaded: state.replayCache.size,
    driftLatched: state.driftLatched,
  });

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    startedAt,
    isDriftLatched: () => state.driftLatched,
    setDriftLatched(latched) {
      state.driftLatched = latched;
      log.warn("Sandbox listener drift latch changed", { driftLatched: latched });
    },
    async stop() {
      clearInterval(pruneTimer);
      await closeServer(server);
      log.info("Sandbox listener stopped", { port });
    },
  };
}

interface ListenerState {
  config: SandboxListenerConfig;
  now: () => number;
  startedAt: number;
  limits: SandboxListenerLimits;
  table: RouteTable;
  accessJwks: JwksCache;
  gateJwks: JwksCache;
  grantJwks: JwksCache;
  replayCache: GateAssertionReplayCache;
  driftLatched: boolean;
  globalBucket: TokenBucket;
  runBuckets: Map<string, TokenBucket>;
  inflightGlobal: number;
  inflightByRun: Map<string, number>;
  appendServedJti: typeof dbAppendServedJti;
  emitAudit: SandboxListenerDeps["emitAudit"];
  onOutcome: SandboxListenerDeps["onOutcome"];
}

type Refusal = {
  status: number;
  code: SandboxListenerErrorCode;
  reason?: string;
  /** Refused before any token was verified (Host or routing): marked, never queued as served. */
  unqueued?: boolean;
};
type Passthrough = { status: number; body: string; code: null };
type Decision = Refusal | Passthrough;
/** `null`: the socket was destroyed mid-request; nothing is answered or queued. */
type DecisionOrClosed = Decision | null;

const refuse = (status: number, code: SandboxListenerErrorCode, reason?: string): Refusal => ({ status, code, reason });
const refuseUnqueued = (status: number, code: SandboxListenerErrorCode, reason?: string): Refusal => ({
  status,
  code,
  reason,
  unqueued: true,
});

interface RequestTrack {
  runId: string | null;
  cmd: string | null;
  /** The verified Gate assertion's `exp`, recorded with the served jti so a restart preloads it exactly. */
  assertionExp: number | null;
}

async function handleRequest(state: ListenerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = singleHeader(req, SANDBOX_REQUEST_ID_HEADER);
  const validRequestId = requestId !== null && SANDBOX_GRANT_JTI_RE.test(requestId) ? requestId : null;
  const cmd = commandIdFromPath(req.url ?? "");
  const track: RequestTrack = { runId: null, cmd, assertionExp: null };

  let decision: DecisionOrClosed;
  try {
    decision = await decide(state, req, track);
  } catch (error) {
    log.error("Sandbox listener request failed", { requestId: validRequestId, runId: track.runId, cmd, error });
    decision = { status: 500, body: errorBody("internal_error", validRequestId), code: null };
  }
  if (decision === null) {
    log.warn("Sandbox listener closed a request without a response", { requestId: validRequestId, cmd });
    return;
  }

  // A marked response is "served": the jti is queued for Console BEFORE the
  // response is written, and a failed append closes the connection instead.
  // Refusals at the `Host` check or at routing come before any token is read
  // and are marked but never queued: a local process or a DNS-rebinding page
  // could otherwise flood the queue into `jtiOverflow` and push out the jtis
  // the Gate really admitted.
  if (validRequestId && !(decision.code !== null && decision.unqueued)) {
    try {
      state.appendServedJti({
        jti: validRequestId,
        runId: track.runId,
        status: decision.status,
        servedAt: state.now(),
        assertionExp: track.assertionExp,
      });
    } catch (error) {
      log.error("Served-jti append failed; closing without a response", { requestId: validRequestId, error });
      // The socket, not the response: under Bun `res.destroy()` after an
      // async gap still flushes an empty 200, which the Gate would pass on.
      const socket = req.socket ?? res.socket;
      if (socket) socket.destroy();
      else res.destroy();
      return;
    }
  }

  const body = decision.code === null ? decision.body : errorBody(decision.code, validRequestId);
  res.writeHead(decision.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    [SANDBOX_LISTENER_MARKER_HEADER.toLowerCase()]: "1",
    "content-length": Buffer.byteLength(body),
    ...(decision.status === 429 ? { "retry-after": "1" } : {}),
    // Nothing more should follow an oversized request on this connection.
    ...(decision.status === 413 ? { connection: "close" } : {}),
  });
  res.end(body);

  const outcome: SandboxListenerOutcome = {
    requestId: validRequestId,
    runId: track.runId,
    cmd,
    status: decision.status,
    code: decision.code,
    ...(decision.code !== null && decision.reason ? { reason: decision.reason } : {}),
  };
  // Logs carry request id, run id, command and outcome only: never a token.
  log.info("Sandbox listener request", outcome);
  state.onOutcome?.(outcome);
}

async function decide(state: ListenerState, req: IncomingMessage, track: RequestTrack): Promise<DecisionOrClosed> {
  const { config } = state;
  if (state.driftLatched) return refuse(503, "tunnel_drift");

  // 1. Host is this installation's tunnel hostname.
  // Steps 1 and 2 run before any token is verified: their refusals are not queued.
  if (singleHeader(req, "host")?.toLowerCase() !== config.tunnelHostname) return refuseUnqueued(421, "host_mismatch");

  // 2. POST on an allowlisted command route, carrying the Gate's routing marker.
  const rawTarget = req.url ?? "";
  const cmdId = commandIdFromPath(rawTarget);
  if (req.method !== "POST" || !cmdId || !isAllowlistedSandboxCommand(cmdId)) return refuseUnqueued(404, "not_found");
  if (singleHeader(req, SANDBOX_GATE_MARKER_HEADER) !== "1") {
    return refuseUnqueued(404, "not_found", "gate_marker_missing");
  }
  const entry = state.table.byPath.get(rawTarget);
  if (!entry) return refuseUnqueued(404, "not_found", "route_missing");

  // 3. Body size.
  // The oversized body is drained before the 413 goes out: answering with
  // unread bytes still arriving either resets the connection before the
  // client reads the response or leaves them to be parsed as the next
  // request on a kept-alive socket. Past the drain bound the socket is
  // destroyed and nothing is answered.
  const body = await readBody(req, SANDBOX_LISTENER_MAX_BODY_BYTES);
  if (body === "aborted") return null;
  if (body === "too_large") return refuse(413, "payload_too_large");

  const nowDate = new Date(state.now());
  const requestId = singleHeader(req, SANDBOX_REQUEST_ID_HEADER);

  // 4. Access JWT: the Gate's service token reached us through Access.
  const access = await verifyAccessAssertion(singleHeader(req, ACCESS_JWT_HEADER), {
    teamDomain: config.accessTeamDomain,
    aud: config.accessAud,
    jwks: state.accessJwks,
    serviceTokenClientId: config.accessClientId,
    now: nowDate,
  });
  if (!access.ok) {
    if (access.reason === "key_set_unavailable") return refuse(503, "jwks_unavailable", access.reason);
    return refuse(401, "access_invalid", access.reason);
  }

  // 5. Gate assertion, bound to this exact request; the run record is looked up only after the signature.
  const assertion = await verifyGateAssertion(singleHeader(req, SANDBOX_GATE_ASSERTION_HEADER), {
    jwks: state.gateJwks,
    installationId: config.installationId,
    resolveRun: (runId) => {
      const run = dbGetSandboxRun(runId);
      return run ? { runId: run.runId, grantSha256: run.grantSha256 } : null;
    },
    request: { method: req.method, target: rawTarget, body, requestId },
    listenerStartedAt: state.startedAt,
    replayCache: state.replayCache,
    now: nowDate,
  });
  if (!assertion.ok) {
    if (assertion.reason === "key_set_unavailable") return refuse(503, "jwks_unavailable", assertion.reason);
    if (assertion.reason === "run_unknown") return refuse(401, "grant_revoked", assertion.reason);
    return refuse(401, "gate_assertion_invalid", assertion.reason);
  }
  track.runId = assertion.run.runId;
  track.assertionExp = assertion.claims.exp;

  // 6. The Gate never forwards the grant; the stored one is re-verified. Present at all, even empty, is refused.
  if (hasHeader(req, SANDBOX_GRANT_HEADER)) return refuse(400, "body_invalid", "grant_header_present");
  const run = getLiveSandboxRun(assertion.run.runId, state.now());
  if (!run) return refuse(401, "grant_revoked", "run_inactive");
  const grant = await verifySandboxGrant(run.grantJws, {
    consoleIssuer: config.consoleIssuer,
    installationId: config.installationId,
    jwks: state.grantJwks,
    now: nowDate,
  });
  if (!grant.ok) {
    if (grant.reason === "key_set_unavailable") return refuse(503, "jwks_unavailable", grant.reason);
    return refuse(401, "grant_invalid", grant.reason);
  }

  // 7. Run binding: the record equals the stored grant's claims and our own org/installation.
  const claims = grant.claims;
  if (
    grant.runId !== run.runId ||
    claims.jti !== run.jti ||
    claims.agent !== run.agentId ||
    (claims.task ?? null) !== run.homeTaskId ||
    !sameList(canonicalizeStringList(claims.caps), run.caps) ||
    !sameList(canonicalizeStringList(claims.cmds), run.cmds) ||
    claims.org !== run.org ||
    claims.inst !== run.installationId ||
    run.installationId !== config.installationId
  ) {
    return refuse(401, "grant_revoked", "run_binding_mismatch");
  }

  // 8. Command within the grant (the static allowlist was applied at step 2); never a superadmin command.
  if (!run.cmds.includes(cmdId) || entry.scope === "superadmin") return refuse(403, "command_not_allowed");

  // 9. Body: a flat object of the command's declared fields, with the home task as `taskId`.
  const parsed = parseJsonObject(body);
  if (!parsed) return refuse(400, "body_invalid", "body_not_object");
  const declaredFields = new Set([...entry.args.map((arg) => arg.name), ...entry.options.map((opt) => opt.name)]);
  for (const key of Object.keys(parsed)) {
    if (key === "cwd" || !declaredFields.has(key)) return refuse(400, "body_invalid", "unknown_field");
  }
  if (!("taskId" in parsed)) return refuse(400, "body_invalid", "task_id_missing");
  if (typeof parsed.taskId !== "string") return refuse(400, "argument_invalid", "task_id_type");
  if (parsed.taskId !== run.homeTaskId) return refuse(403, "resource_forbidden", "task_mismatch");

  // 10. Limits.
  const runBucket = bucketFor(state, run.runId);
  const nowMs = state.now();
  if (!state.globalBucket.take(nowMs) || !runBucket.take(nowMs)) return refuse(429, "rate_limited");
  const inflightRun = state.inflightByRun.get(run.runId) ?? 0;
  if (state.inflightGlobal >= state.limits.globalConcurrency || inflightRun >= state.limits.perRunConcurrency) {
    return refuse(429, "rate_limited", "concurrency");
  }

  // 11. The run's child context is live.
  const child = getLiveSandboxRunContext(run, state.now());
  if (!child) return refuse(401, "grant_revoked", "context_inactive");

  // 12. Dispatch from the child, concrete resource only, never the operator, never a superadmin command.
  // The slots belong to the dispatch, not to the response: a 504 answers at
  // the timeout, but the command keeps running and holds its per-run and
  // global slots until it actually settles, so a timed-out command cannot be
  // stacked under a fresh request.
  state.inflightGlobal += 1;
  state.inflightByRun.set(run.runId, inflightRun + 1);
  const dispatching = Promise.resolve()
    .then(() => dispatchAsRun(state, entry, parsed, child, { runId: run.runId, requestId: requestId ?? "" }))
    .finally(() => releaseSlots(state, run.runId));
  const response = await withTimeout(dispatching, state.limits.dispatchTimeoutMs);
  // 13. Count the request against the run.
  dbBumpSandboxRunRequest(run.runId, state.now());
  if (response === TIMEOUT) {
    // Nobody awaits the late outcome; log it rather than leave a rejection unhandled.
    dispatching.catch((error) =>
      log.warn("Timed-out sandbox dispatch failed", { runId: run.runId, cmd: cmdId, error }),
    );
    return refuse(504, "timeout");
  }
  if (response.status === 400) return refuse(400, "argument_invalid", "dispatch_usage_error");
  if (response.status === 403) return refuse(403, "resource_forbidden", "dispatch_denied");
  return { status: response.status, body: await response.text(), code: null };
}

function releaseSlots(state: ListenerState, runId: string): void {
  state.inflightGlobal -= 1;
  const remaining = (state.inflightByRun.get(runId) ?? 1) - 1;
  if (remaining <= 0) state.inflightByRun.delete(runId);
  else state.inflightByRun.set(runId, remaining);
}

function dispatchAsRun(
  state: ListenerState,
  entry: CommandRegistryEntry,
  body: Record<string, unknown>,
  child: ContextRecord,
  meta: { runId: string; requestId: string },
): Promise<Response> {
  // Concrete-resource semantics only: group, wildcard and semantic capabilities never satisfy the check.
  const strictEntry: CommandRegistryEntry = {
    ...entry,
    ...(entry.access ? { access: { ...entry.access, requireConcreteResource: true } } : {}),
  };
  const emitAudit = async (event: AuditEvent) => {
    if (state.emitAudit) {
      await state.emitAudit(event, meta);
      return;
    }
    // The production audit carries the run and request ids too, so an audit
    // line joins the listener log and Console's report on the same keys.
    await emitCliAuditEvent({
      ...event,
      status: "completed",
      closeLazyConnection: false,
      runId: meta.runId,
      requestId: meta.requestId,
    });
  };
  return dispatch(
    strictEntry,
    body,
    { agentId: child.agentId, contextId: child.contextId, context: child },
    {
      contextRecord: child,
      cwd: undefined,
      emitAudit,
    },
  ).then((result) => result.response);
}

const TIMEOUT = Symbol("timeout");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorBody(code: string, requestId: string | null): string {
  return JSON.stringify({ error: { code, requestId, source: SANDBOX_LISTENER_ERROR_SOURCE } });
}

/**
 * One header value, or null when absent or empty. Under Bun's node:http a
 * header sent more than once collapses to its LAST value (no comma join, no
 * array), so a duplicate is indistinguishable from a single header here; the
 * `Host` check therefore sees the last `Host` line (pinned by the wire-variant
 * test). Every check that matters is a signed token, not a header shape.
 */
function singleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/** Whether the header was sent at all, empty value included (raw header lines, case-insensitive). */
function hasHeader(req: IncomingMessage, name: string): boolean {
  const lower = name.toLowerCase();
  if (req.headers[lower] !== undefined) return true;
  const raw = req.rawHeaders ?? [];
  for (let index = 0; index < raw.length; index += 2) if (raw[index]?.toLowerCase() === lower) return true;
  return false;
}

/** How much past the limit is discarded, and for how long, before the socket is simply destroyed. */
const BODY_DRAIN_MAX_BYTES = 8 * 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;

/**
 * The exact bytes received; `too_large` once more than `maxBytes` arrived and
 * the rest was drained; `aborted` when the client errored, kept sending past
 * the drain bound or stalled past the read timeout (the socket is destroyed).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | "too_large" | "aborted"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (value: Uint8Array | "too_large" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === "aborted") req.socket?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => settle("aborted"), BODY_READ_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes + BODY_DRAIN_MAX_BYTES) settle("aborted");
      else if (total > maxBytes) chunks.length = 0;
      else chunks.push(chunk);
    });
    req.on("end", () => settle(total > maxBytes ? "too_large" : new Uint8Array(Buffer.concat(chunks))));
    req.on("error", () => settle("aborted"));
    req.on("close", () => settle("aborted"));
  });
}

function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resolveLimits(overrides: Partial<SandboxListenerLimits> | undefined): SandboxListenerLimits {
  const limits = { ...SANDBOX_LISTENER_DEFAULT_LIMITS } as SandboxListenerLimits;
  for (const key of Object.keys(limits) as (keyof SandboxListenerLimits)[]) {
    const value = overrides?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) limits[key] = Math.min(value, limits[key]);
  }
  return limits;
}

function bucketFor(state: ListenerState, runId: string): TokenBucket {
  let bucket = state.runBuckets.get(runId);
  if (!bucket) {
    bucket = new TokenBucket(state.limits.perRunPerMinute);
    state.runBuckets.set(runId, bucket);
    // Idle runs do not accumulate buckets forever.
    if (state.runBuckets.size > 1024) {
      for (const [id, candidate] of state.runBuckets) {
        if (candidate.idleFor(state.now()) > 120_000) state.runBuckets.delete(id);
      }
    }
  }
  return bucket;
}

/** `perMinute` tokens, refilled continuously, burst at most `perMinute`. */
class TokenBucket {
  private tokens: number;
  private updatedAt: number | null = null;

  constructor(private readonly perMinute: number) {
    this.tokens = perMinute;
  }

  take(now: number): boolean {
    if (this.updatedAt !== null) {
      this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.updatedAt) * this.perMinute) / 60_000);
    }
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  idleFor(now: number): number {
    return this.updatedAt === null ? Number.POSITIVE_INFINITY : now - this.updatedAt;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    const closeAll = (server as Server & { closeAllConnections?: () => void }).closeAllConnections;
    if (typeof closeAll === "function") closeAll.call(server);
  });
}
