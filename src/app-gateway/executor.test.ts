import "reflect-metadata";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseRaviAppCapability } from "../apps/command.js";
import { canAccessApp } from "../apps/permissions.js";
import type { RaviAppManifestRecord, RaviAppRunOptions, RaviAppRunResult } from "../apps/types.js";
import { canUseAnyCalendar, canUseCalendar, getCalendarScopeContext } from "../calendar/access.js";
import type { CalendarCalendar } from "../calendar/types.js";
import { getContext, runWithContext } from "../cli/context.js";
import { Command, CommandAccess, Group, Returns } from "../cli/decorators.js";
import { buildRegistry } from "../cli/registry-snapshot.js";
import type { ActorBinding } from "../cloud-auth/types.js";
import { canUseAnyMailbox, canUseMailMailbox, getMailScopeContext } from "../mailbox/access.js";
import { authorizationContext } from "../permissions/authorization-agent.js";
import {
  canonicalize,
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  resetExternalAuthorityCacheForTests,
} from "../permissions/external-authority-provider.js";
import { authorizePermission } from "../permissions/provider-runtime.js";
import { PERMISSION_PROVIDER_IDS_SETTING } from "../permissions/provider-registry.js";
import {
  canAccessSession,
  filterAccessibleSessions,
  filterVisibleAgents,
  getScopeContext,
  isLocalOperatorScope,
  isScopeEnforced,
} from "../permissions/scope.js";
import { type ContextRecord, dbGetContext, dbSetSetting } from "../router/router-db.js";
import type { SessionEntry } from "../router/types.js";
import { issueRuntimeContext } from "../runtime/context-registry.js";
import { resolveAuth } from "../sdk/gateway/auth.js";
import { dispatch } from "../sdk/gateway/dispatcher.js";
import {
  assertionClaims,
  createFakeJwks,
  createTestKey,
  grantClaims,
  signToken,
  TEST_AUDIENCE,
  TEST_INSTALLATION_ID,
  TEST_ISSUER,
  TEST_ORG_ID,
  TEST_PROJECT_ID,
  TEST_SITE_ID,
  TEST_TARGET_ID,
  TEST_USER_ID,
  type TestKey,
} from "../test/app-gateway-tokens.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { AppGatewayExecutor, type AppGatewayExecutorOptions } from "./executor.js";
import type { AppsInvokeFrame } from "./frames.js";
import { AppGatewayJwksClient } from "./jwks.js";

let grantKey: TestKey;
let assertionKey: TestKey;
let stateDir: string | null = null;
const SESSION = { installationId: TEST_INSTALLATION_ID, organizationId: TEST_ORG_ID, issuer: TEST_ISSUER };
const SECRET_STDERR = "stderr-secret-should-never-leave";

beforeAll(async () => {
  grantKey = await createTestKey("pages-app-target-exec");
  assertionKey = await createTestKey("pages-viewer-assertion-exec");
});

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-app-gateway-executor-");
});

afterEach(async () => {
  resetExternalAuthorityCacheForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const PRIVATE_MAILBOX = { id: "mbx-team", address: "Team@example.test", normalizedAddress: "team@example.test" };
const PRIVATE_CALENDAR = {
  id: "cal-team",
  name: "Team",
  providerCalendarId: null,
  visibility: "private",
  ownerType: "agent",
  ownerId: "main",
} as unknown as CalendarCalendar;
const MAIN_SESSION = { sessionKey: "agent:main:main", name: "main", updatedAt: 0 } as unknown as SessionEntry;

/** Every check a gateway-derived caller must fail, read from the ambient ToolContext. */
function gatewayAuthorityChecks(): Record<string, boolean | number> {
  const scope = getScopeContext();
  const mail = getMailScopeContext();
  const calendar = getCalendarScopeContext();
  return {
    localOperator: isLocalOperatorScope(scope),
    scopeEnforced: isScopeEnforced(scope),
    session: canAccessSession(scope, "agent:main:main"),
    sessions: filterAccessibleSessions(scope, [MAIN_SESSION]).length,
    agents: filterVisibleAgents(scope, [{ id: "main" }]).length,
    otherApp: canAccessApp("other-app", "use"),
    mailbox: canUseMailMailbox(mail, "read", PRIVATE_MAILBOX),
    anyMailbox: canUseAnyMailbox(mail, "read"),
    calendar: canUseCalendar(calendar, "read", PRIVATE_CALENDAR),
    anyCalendar: canUseAnyCalendar(calendar, "read"),
  };
}

const NO_AUTHORITY = {
  localOperator: false,
  scopeEnforced: true,
  session: false,
  sessions: 0,
  agents: 0,
  otherApp: false,
  mailbox: false,
  anyMailbox: false,
  calendar: false,
  anyCalendar: false,
};

/** The app-runtime child the App Router issues under the caller's context (`issueAppChildContext`). */
function issueAppChild(parent: ContextRecord, allow: string[]): ContextRecord {
  return issueRuntimeContext({
    parent,
    cliName: "app:slides",
    kind: "app-runtime",
    capabilities: allow.map(parseRaviAppCapability),
    inheritCapabilities: false,
    metadata: { appId: "slides", operationId: "slides.list", source: "app-router" },
  });
}

/** A command an app child may call through the SDK gateway; it reports the checks it runs under. */
@Group({ name: "gwprobe", description: "Gateway authority probe", scope: "open" })
class GatewayAuthorityProbeCommands {
  @Command({ name: "check", description: "Report authority checks for the calling context" })
  @CommandAccess({ kind: "read", resource: "gwprobe", action: "check", risk: "low" })
  @Returns(z.record(z.string(), z.union([z.boolean(), z.number()])))
  check() {
    return gatewayAuthorityChecks();
  }
}

const probeCommand = buildRegistry([GatewayAuthorityProbeCommands]).commands.find(
  (command) => command.fullName === "gwprobe.check",
)!;

/** Configures the external-authority provider with a signed assertion for `sub` that covers `use app:slides`. */
function configureExternalAuthority(dir: string, sub: string): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = {
    iss: "https://authority.example.test",
    sub,
    exp: Math.floor(Date.now() / 1000) + 300,
    scope: [{ permission: "use", objectType: "app", objectId: "slides" }],
  };
  const sig = signPayload(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64");
  const assertionPath = join(dir, "external-assertion.json");
  writeFileSync(assertionPath, JSON.stringify({ ...payload, sig }));
  dbSetSetting(PERMISSION_PROVIDER_IDS_SETTING, "operator-control,context-capabilities,external-authority");
  dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
  dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
}

function slidesManifest(
  operations: Record<string, unknown> = {},
  options: { allow?: string[]; providerOperation?: string; valid?: boolean } = {},
): RaviAppManifestRecord {
  return {
    id: "slides",
    valid: options.valid ?? true,
    errors: [],
    warnings: [],
    permissions: {
      required: [],
      optional: [],
      mutating: [],
      ...(options.providerOperation ? { provider: { operation: options.providerOperation } } : {}),
    },
    manifest: {
      id: "slides",
      context: { allow: options.allow ?? [] },
      operations: {
        "slides.list": {
          interface: "cli",
          command: "slides list {args} --json",
          mutating: false,
          gateway: { args: { options: ["--limit", "--cursor"], flags: ["--archived"], positional: 0 } },
        },
        "slides.get": {
          interface: "cli",
          command: "slides get {args} --json",
          mutating: false,
          gateway: { args: { positional: 1 } },
        },
        ...operations,
      },
    },
  } as unknown as RaviAppManifestRecord;
}

interface Harness {
  executor: AppGatewayExecutor;
  runs: Array<{ options: RaviAppRunOptions; context: ReturnType<typeof getContext> }>;
  settings: Map<string, string>;
  bindings: ActorBinding[];
  invoke(overrides?: Partial<AppsInvokeFrame>, claims?: { grant?: Record<string, unknown> }): Promise<unknown>;
}

async function harness(
  options: Partial<AppGatewayExecutorOptions> & { result?: Partial<RaviAppRunResult> } = {},
): Promise<Harness> {
  const jwks = createFakeJwks([grantKey, assertionKey]);
  const client = new AppGatewayJwksClient({ url: "https://console.ravi.test/jwks", fetch: jwks.fetch });
  const settings = new Map<string, string>([
    ["apps.gateway.allowed_operations", "slides:slides.list,slides:slides.get"],
  ]);
  const bindings: ActorBinding[] = [];
  const runs: Harness["runs"] = [];
  const executor = new AppGatewayExecutor({
    resolveKey: client.resolveKey,
    env: { ...process.env, RAVI_CONTEXT_KEY: "rctx_daemon_should_not_leak" },
    readSetting: (key) => settings.get(key) ?? null,
    listBindings: () => bindings,
    loadManifest: () => slidesManifest(),
    runApp: async (runOptions) => {
      runs.push({ options: runOptions, context: getContext() });
      return {
        ok: true,
        appId: "slides",
        operation: runOptions.operation ?? null,
        operationId: runOptions.operation ?? null,
        interface: "cli",
        mutating: false,
        status: "completed",
        durationMs: 1,
        result: { items: [{ id: "deck-1" }] },
        stdout: '{"items":[]}',
        stderr: SECRET_STDERR,
        command: "slides list --json",
        callerContextId: "ctx_parent",
        childContextId: "ctx_child",
        ...options.result,
      } as RaviAppRunResult;
    },
    ...options,
  });
  return {
    executor,
    runs,
    settings,
    bindings,
    async invoke(overrides = {}, claims = {}) {
      const now = Date.now();
      const frame: AppsInvokeFrame = {
        type: "apps.invoke",
        v: 1,
        requestId: crypto.randomUUID(),
        appId: "slides",
        operation: "slides.list",
        assertion: await signToken({ key: assertionKey, claims: assertionClaims(now), typ: "JWT" }),
        grant: await signToken({
          key: grantKey,
          claims: grantClaims(now, claims.grant),
          typ: "ravi-app-target+jwt",
        }),
        body: { args: ["--limit", "10"] },
        ...overrides,
      };
      return JSON.parse(await executor.handleInvoke(frame, SESSION, new AbortController().signal));
    },
  };
}

function errorOf(frame: unknown): string | undefined {
  return (frame as { error?: string }).error;
}

describe("Pages app gateway executor", () => {
  it("runs through the App Router in a gateway parent context and forwards only the result", async () => {
    const h = await harness();
    const frame = await h.invoke();
    expect(frame).toMatchObject({ type: "apps.result", v: 1, status: 200, body: { items: [{ id: "deck-1" }] } });
    const serialized = JSON.stringify(frame);
    for (const leaked of [SECRET_STDERR, "ctx_parent", "ctx_child", "slides list --json", "rctx_"]) {
      expect(serialized).not.toContain(leaked);
    }

    expect(h.runs).toHaveLength(1);
    const run = h.runs[0]!;
    expect(run.options).toMatchObject({
      appId: "slides",
      operation: "slides.list",
      args: ["--limit", "10"],
      json: true,
      execute: false,
      exactOperation: true,
      timeoutMs: 28_000,
      maxOutputBytes: 1_179_648,
    });
    expect(run.options.signal).toBeInstanceOf(AbortSignal);
    expect(run.options.env?.RAVI_CONTEXT_KEY).toBeUndefined();

    const ctx = run.context!;
    expect(ctx.agentId).toBe("pages-app-gateway");
    expect(ctx.transport).toBe("gateway");
    expect(ctx.suppressCliOutput).toBe(true);
    expect(ctx.context?.kind).toBe("pages-app-gateway");
    expect(ctx.context?.agentId).toBeUndefined();
    expect(ctx.context?.capabilities).toEqual([
      { permission: "use", objectType: "app", objectId: "slides", source: "pages-app-gateway" },
    ]);
    expect(ctx.context?.metadata).toEqual({
      actorPrincipal: `ravi_user:${TEST_USER_ID}`,
      surfacePrincipal: `pages_site:${TEST_SITE_ID}`,
      raviUserId: TEST_USER_ID,
      raviOrgId: TEST_ORG_ID,
      siteId: TEST_SITE_ID,
      projectId: TEST_PROJECT_ID,
      audience: TEST_AUDIENCE,
      appGatewayTargetId: TEST_TARGET_ID,
      requestId: expect.any(String),
      source: "pages-app-gateway",
    });
    expect(ctx.context!.expiresAt! - ctx.context!.createdAt).toBe(35_000);
    // Revoked once the run returned.
    expect(dbGetContext(ctx.context!.contextId)?.revokedAt).toBeGreaterThan(0);
    expect(h.executor.activeInvokes).toBe(0);
  });

  it("gives the parent and its app child no session, agent, mailbox, calendar, or other-app authority", async () => {
    let parentChecks: Record<string, unknown> = {};
    let childChecks: Record<string, unknown> = {};
    const seen = { childOwnApp: false };
    const h = await harness({
      loadManifest: () => slidesManifest({}, { allow: ["use:app:slides"] }),
      runApp: async () => {
        parentChecks = gatewayAuthorityChecks();
        const child = issueAppChild(getContext()!.context!, ["use:app:slides"]);
        // The app child process resolves only RAVI_CONTEXT_KEY: no agent id at all.
        runWithContext({ context: child, contextId: child.contextId }, () => {
          childChecks = gatewayAuthorityChecks();
          seen.childOwnApp = canAccessApp("slides", "use");
        });
        return { ok: true, status: "completed", result: null } as unknown as RaviAppRunResult;
      },
    });
    expect(await h.invoke()).toMatchObject({ type: "apps.result", body: null });
    expect(parentChecks).toEqual(NO_AUTHORITY);
    expect(childChecks).toEqual(NO_AUTHORITY);
    expect(seen.childOwnApp).toBe(true);
  });

  it("gives a gateway-derived context key no authority in a child ravi process or through the SDK gateway", async () => {
    const allow = ["use:app:slides", "execute:group:gwprobe"];
    let childKey: string | null = null;
    let release: (() => void) | null = null;
    const h = await harness({
      loadManifest: () => slidesManifest({}, { allow }),
      runApp: async () => {
        childKey = issueAppChild(getContext()!.context!, allow).contextKey;
        // Keep the invoke (and with it the parent context) open while the key is used.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true, status: "completed", result: null } as unknown as RaviAppRunResult;
      },
    });
    const invoking = h.invoke();
    for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(childKey).toStartWith("rctx_");

    // A child `ravi` process: no in-process ToolContext, only RAVI_CONTEXT_KEY in its environment.
    let cliChecks: Record<string, unknown> = {};
    process.env.RAVI_CONTEXT_KEY = childKey!;
    try {
      expect(getContext()?.context?.kind).toBe("app-runtime");
      expect(getContext()?.agentId).toBeUndefined();
      cliChecks = gatewayAuthorityChecks();
    } finally {
      delete process.env.RAVI_CONTEXT_KEY;
    }

    // An SDK-gateway call holding the same key, through its own auth and dispatcher.
    const auth = resolveAuth(
      new Request("http://127.0.0.1:7777/api/v1/gwprobe/check", {
        method: "POST",
        headers: { authorization: `Bearer ${childKey}` },
      }),
    );
    expect(auth.authenticated).toBe(true);
    const dispatched = await dispatch(probeCommand, {}, auth.context, {
      contextRecord: auth.contextRecord,
      emitAudit: () => {},
    });
    expect(dispatched.response.status).toBe(200);
    const sdkChecks = await dispatched.response.json();

    release!();
    expect(await invoking).toMatchObject({ type: "apps.result", body: null });
    expect(cliChecks).toEqual(NO_AUTHORITY);
    expect(sdkChecks).toEqual(NO_AUTHORITY);
  });

  it("decides the parent's checks from its context record, never as agent:pages-app-gateway", async () => {
    configureExternalAuthority(stateDir!, "agent:main");
    let checks: Record<string, unknown> = {};
    const h = await harness({
      runApp: async () => {
        const ctx = getContext()!;
        const decision = authorizePermission({
          context: authorizationContext(ctx.context!, ctx.agentId),
          permission: "use",
          objectType: "app",
          objectId: "slides",
        });
        checks = {
          ownApp: canAccessApp("slides", "use"),
          decidedBy: decision.providerId,
          // The external authority is live: the audit label as an agent subject is refused.
          labelAsAgent: authorizePermission({
            subject: { type: "agent", id: ctx.agentId! },
            permission: "use",
            objectType: "app",
            objectId: "slides",
          }).reasonCode,
          ...gatewayAuthorityChecks(),
        };
        return { ok: true, status: "completed", result: null } as unknown as RaviAppRunResult;
      },
    });
    expect(await h.invoke()).toMatchObject({ type: "apps.result", body: null });
    expect(checks).toEqual({
      ownApp: true,
      decidedBy: "context-capabilities",
      labelAsAgent: "external_assertion_subject_mismatch",
      ...NO_AUTHORITY,
    });
  });

  it("refuses grant, assertion, binding, and replay failures in order", async () => {
    const h = await harness();
    expect(errorOf(await h.invoke({}, { grant: { installation: "00000000-0000-4000-8000-000000000000" } }))).toBe(
      "app_gateway_grant_invalid",
    );
    expect(errorOf(await h.invoke({}, { grant: { raviOrgId: "00000000-0000-4000-8000-000000000000" } }))).toBe(
      "app_gateway_grant_invalid",
    );
    expect(errorOf(await h.invoke({}, { grant: { aud: "https://other.example" } }))).toBe(
      "app_gateway_assertion_invalid",
    );
    expect(errorOf(await h.invoke({ assertion: "a.b.c" }))).toBe("app_gateway_assertion_invalid");

    const requestId = crypto.randomUUID();
    // A refused invoke does not enter the replay set.
    expect(errorOf(await h.invoke({ requestId, grant: "x.y.z" }))).toBe("app_gateway_grant_invalid");
    expect(await h.invoke({ requestId })).toMatchObject({ type: "apps.result" });
    expect(errorOf(await h.invoke({ requestId }))).toBe("app_gateway_request_replayed");
    expect(h.runs).toHaveLength(1);
  });

  it("enforces grant scope, local allowlist, and require_link", async () => {
    const h = await harness();
    expect(errorOf(await h.invoke({ appId: "decks" }))).toBe("app_gateway_app_forbidden");
    expect(errorOf(await h.invoke({ operation: "slides.delete" }))).toBe("app_gateway_operation_forbidden");

    h.settings.set("apps.gateway.allowed_operations", "slides:slides.get");
    expect(errorOf(await h.invoke())).toBe("app_gateway_permission_denied");
    h.settings.set("apps.gateway.allowed_operations", "slides:*");
    expect(errorOf(await h.invoke())).toBe("app_gateway_permission_denied");
    h.settings.set("apps.gateway.allowed_operations", "slides:slides.list");

    h.settings.set("apps.gateway.require_link", "true");
    expect(errorOf(await h.invoke())).toBe("app_gateway_permission_denied");
    const link = {
      contactId: "contact-1",
      actorPrincipal: "contact:contact-1",
      consoleUserId: TEST_USER_ID,
      orgId: TEST_ORG_ID,
      installationId: TEST_INSTALLATION_ID,
    };
    h.bindings.push(link);
    expect(await h.invoke()).toMatchObject({ type: "apps.result" });
    expect(h.runs.at(-1)!.context!.context!.metadata!.actorPrincipal).toBe("contact:contact-1");

    // Two matching Links are ambiguous: no contact, so require_link refuses.
    h.bindings.push({ ...link, contactId: "contact-2" });
    expect(errorOf(await h.invoke())).toBe("app_gateway_permission_denied");
    expect(h.runs).toHaveLength(1);
  });

  it("runs only read-only operations with a gateway declaration", async () => {
    const cases: Array<[Record<string, unknown>, Partial<{ providerOperation: string; valid: boolean }>, string]> = [
      [
        { "slides.list": { interface: "cli", command: "slides list", mutating: true, gateway: { args: "none" } } },
        {},
        "app_gateway_operation_forbidden",
      ],
      [
        { "slides.list": { interface: "cli", command: "slides list", gateway: { args: "none" } } },
        {},
        "app_gateway_operation_forbidden",
      ],
      [
        { "slides.list": { interface: "cli", command: "slides list", mutating: false } },
        {},
        "app_gateway_operation_forbidden",
      ],
      [
        {
          "slides.list": {
            interface: "cli",
            command: "slides list",
            mutating: false,
            gateway: { args: { flags: ["--execute"] } },
          },
        },
        {},
        "app_gateway_operation_forbidden",
      ],
      [
        {
          "slides.list": {
            interface: "cli",
            command: "ravi {args}",
            mutating: false,
            gateway: { args: { positional: 2 } },
          },
        },
        {},
        "app_gateway_operation_forbidden",
      ],
      [
        {
          "slides.list": {
            interface: "cli",
            command: "slides {args} list",
            mutating: false,
            gateway: { args: { positional: 1 } },
          },
        },
        {},
        "app_gateway_operation_forbidden",
      ],
      [{}, { providerOperation: "slides.list" }, "app_gateway_operation_forbidden"],
      [{}, { valid: false }, "app_gateway_operation_failed"],
    ];
    for (const [operations, manifestOptions, code] of cases) {
      const h = await harness({ loadManifest: () => slidesManifest(operations, manifestOptions) });
      expect(errorOf(await h.invoke())).toBe(code);
      expect(h.runs).toHaveLength(0);
    }
    const missing = await harness({
      loadManifest: () => {
        throw new Error("App not found: slides");
      },
    });
    expect(errorOf(await missing.invoke())).toBe("app_gateway_operation_failed");
  });

  it("accepts only declared viewer argv and never spawns on refusal", async () => {
    const h = await harness();
    const refused: Array<[unknown, string]> = [
      [["--execute"], "payload_invalid"],
      [["--limit", "10", "--execute"], "payload_invalid"],
      [["delete"], "payload_invalid"],
      [["--limit=10"], "payload_invalid"],
      [["-l", "10"], "payload_invalid"],
      [["--limit"], "payload_invalid"],
      [["--limit", "--archived"], "payload_invalid"],
      [["--limit", "1", "--limit", "2"], "payload_invalid"],
      [["--", "x"], "payload_invalid"],
      [["a\u0000b"], "payload_invalid"],
      [Array.from({ length: 65 }, () => "--archived"), "payload_invalid"],
      [[1], "payload_invalid"],
      ["--limit 10", "payload_invalid"],
    ];
    for (const [args, code] of refused) {
      expect(errorOf(await h.invoke({ body: { args } as Record<string, unknown> }))).toBe(code);
    }
    expect(errorOf(await h.invoke({ body: { args: [], extra: true } }))).toBe("payload_invalid");
    expect(errorOf(await h.invoke({ operation: "slides.get", body: { args: ["deck-1", "deck-2"] } }))).toBe(
      "payload_invalid",
    );
    expect(h.runs).toHaveLength(0);

    expect(await h.invoke({ body: {} })).toMatchObject({ type: "apps.result" });
    expect(await h.invoke({ body: { args: ["--archived", "--cursor", "c1"] } })).toMatchObject({
      type: "apps.result",
    });
    expect(h.runs.map((run) => run.options.args)).toEqual([[], ["--archived", "--cursor", "c1"]]);

    const wide = await harness({
      loadManifest: () =>
        slidesManifest({
          "slides.list": {
            interface: "cli",
            command: "slides list {args}",
            mutating: false,
            gateway: { args: { options: ["--a", "--b", "--c", "--d", "--e", "--f", "--g", "--h"], positional: 1 } },
          },
        }),
    });
    const big = "v".repeat(8_192);
    const args = ["--a", big, "--b", big, "--c", big, "--d", big, "--e", big, "--f", big, "--g", big, "--h", big, big];
    expect(errorOf(await wide.invoke({ body: { args } }))).toBe("app_gateway_payload_too_large");
    expect(wide.runs).toHaveLength(0);
  });

  it("holds a concurrency slot until the run settles", async () => {
    let release: (() => void) | null = null;
    const h = await harness({
      maxConcurrency: 1,
      runApp: () =>
        new Promise<RaviAppRunResult>((resolve) => {
          release = () => resolve({ ok: true, status: "completed", result: 1 } as unknown as RaviAppRunResult);
        }),
    });
    const first = h.invoke();
    for (let i = 0; i < 50 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.executor.activeInvokes).toBe(1);
    expect(errorOf(await h.invoke())).toBe("app_gateway_rate_limited");
    release!();
    expect(await first).toMatchObject({ type: "apps.result", body: 1 });
    expect(h.executor.activeInvokes).toBe(0);
  });

  it("maps App Router outcomes without forwarding output", async () => {
    const cases: Array<[Partial<RaviAppRunResult>, string]> = [
      [{ ok: false, status: "failed", errorCode: "APP_OUTPUT_TOO_LARGE" }, "app_gateway_payload_too_large"],
      [{ ok: false, status: "failed", errorCode: "APP_OPERATION_TIMEOUT" }, "app_gateway_operation_failed"],
      [
        { ok: false, status: "blocked", errorCode: "APP_PERMISSION_PROVIDER_FAILED" },
        "app_gateway_operation_forbidden",
      ],
      [{ ok: false, status: "failed", errorCode: "PERMISSION_DENIED" }, "app_gateway_permission_denied"],
      [{ ok: false, status: "failed", errorCode: "APP_PERMISSION_PROVIDER_FAILED" }, "app_gateway_permission_denied"],
      [{ ok: false, status: "failed", errorCode: "not_found" }, "app_gateway_operation_failed"],
      [{ ok: false, status: "failed", errorCode: "APP_OPERATION_FAILED" }, "app_gateway_operation_failed"],
      [{ ok: true, status: "completed", result: { blob: "x".repeat(1_048_577) } }, "app_gateway_payload_too_large"],
    ];
    for (const [result, code] of cases) {
      const h = await harness({ result });
      const frame = await h.invoke();
      expect(errorOf(frame)).toBe(code);
      expect(JSON.stringify(frame)).not.toContain(SECRET_STDERR);
    }
    const nullBody = await harness({ result: { result: undefined } });
    expect(await nullBody.invoke()).toMatchObject({ type: "apps.result", body: null });
  });

  it("answers unavailable when the Console JWKS cannot be fetched", async () => {
    const h = await harness({
      resolveKey: new AppGatewayJwksClient({
        url: "https://console.ravi.test/jwks",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }).resolveKey,
    });
    expect(errorOf(await h.invoke())).toBe("app_gateway_unavailable");
  });
});

describe("Pages app gateway executor with the real App Router", () => {
  const originalCwd = process.cwd();
  let root: string | null = null;

  afterEach(() => {
    process.chdir(originalCwd);
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function writeSlidesApp(): void {
    root = mkdtempSync(join(tmpdir(), "ravi-app-gateway-app-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gateway-test" }));
    const appDir = join(root, "src", "apps", "slides");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "list.mjs"),
      `process.stderr.write(${JSON.stringify(SECRET_STDERR)});
console.log(JSON.stringify({ args: process.argv.slice(2), agent: process.env.RAVI_AGENT_ID ?? null, hasContextKey: Boolean(process.env.RAVI_CONTEXT_KEY) }));`,
    );
    writeFileSync(
      join(appDir, "ravi.app.json"),
      JSON.stringify({
        schema: "ravi.app/v1",
        id: "slides",
        name: "Slides",
        version: "0.1.0",
        description: "Slides.",
        interfaces: { cli: { command: "ravi slides", json: true } },
        context: { allow: [] },
        operations: {
          "slides.list": {
            interface: "cli",
            command: "bun list.mjs {args}",
            mutating: false,
            gateway: { args: { options: ["--limit"] } },
          },
        },
        permissions: { required: [], optional: [], mutating: [] },
      }),
    );
    process.chdir(root);
  }

  it("runs a declared cli operation end to end and returns only its JSON", async () => {
    writeSlidesApp();

    const h = await harness({ loadManifest: undefined, runApp: undefined });
    const frame = await h.invoke();
    expect(frame).toMatchObject({
      type: "apps.result",
      status: 200,
      body: { args: ["--limit", "10"], agent: null, hasContextKey: true },
    });
    expect(JSON.stringify(frame)).not.toContain(SECRET_STDERR);
  });

  it("serves an invoke when an external authority is configured for another agent", async () => {
    configureExternalAuthority(stateDir!, "agent:main");
    writeSlidesApp();

    const h = await harness({ loadManifest: undefined, runApp: undefined });
    expect(await h.invoke()).toMatchObject({
      type: "apps.result",
      status: 200,
      body: { args: ["--limit", "10"], agent: null, hasContextKey: true },
    });
  });
});
