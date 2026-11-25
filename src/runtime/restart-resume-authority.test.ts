// Acceptance test for filipexyz/ravi#987 review B1 (adapted from the reviewer's probe,
// reviews/probe-ravi-987-81eba24-authority.test.ts): a restart input must never hold more
// authority than the interrupted turn it resumes. Each case builds the runtime context of the
// original turn and of the restart input that the production code builds from what it recorded
// (attempt metadata for the boot sweep, snapshot metadata for the graceful continuation).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact } from "../contacts.js";
import { dbCreateAgent, dbUpdateAgent, dbUpsertChat } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { canWithCapabilities } from "../permissions/provider-runtime.js";
import { dbEnsureContactChatGrant } from "../permissions/contact-chat-grants.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { AgentConfig } from "../router/index.js";
import type { DaemonRestartSessionSnapshotRecord } from "../router/router-db.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import type { RuntimeTurnAttemptRecord } from "./crash-recovery-store.js";
import { createRuntimeContext } from "./context-registry.js";
import {
  CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY,
  captureRestartTurnAuthority,
  deliverDaemonRestartSessionEvent,
  normalizeRestartResumeSource,
  RESTART_TURN_AUTHORITY_METADATA_KEY,
} from "./daemon-restart-resume.js";
import { pickRuntimeTurnAuthorityEnvelope } from "./delivery-queue.js";
import { buildOrphanedRestartTurnInput, judgeRestartInterruptedAttempt } from "./restart-turn-recovery.js";
import { buildRuntimeRequestContext } from "./runtime-request-context.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";

let stateDir: string | null = null;
const agent: AgentConfig = { id: "probe-agent", cwd: "/tmp/probe-agent" };
const sessionKey = "agent:probe-agent:whatsapp:group:chat_probe_1";
const sessionName = "probe-group";
const runtimeResolution: TaskRuntimeResolution = {
  options: {},
  sources: { model: null, effort: null, thinking: null },
  hasTaskRuntimeContext: false,
};

type Ctx = ReturnType<typeof buildRuntimeRequestContext>["runtimeContext"];

type Path = "sweep" | "graceful";
let resumePath: Path = "sweep";

// The restart input the production code publishes for the interrupted turn `original`:
// - sweep: the attempt records the turn's envelope at start; the boot sweep judges it and
//   builds the verify resume from the record;
// - graceful: the shutdown snapshot records the envelope; the boot continues the turn from it.
async function resumePromptFor(original: Record<string, unknown>): Promise<Record<string, unknown>> {
  const recorded = captureRestartTurnAuthority(pickRuntimeTurnAuthorityEnvelope(original as never));
  const source = original.source as Record<string, unknown> | undefined;
  if (resumePath === "sweep") {
    const attempt = {
      attemptId: "attempt-probe",
      sessionKey,
      sessionName,
      provider: "codex",
      status: "running",
      originKind: original._turnOrigin ? "agent" : "human",
      source: source ?? null,
      startedTool: true,
      materializedOutput: false,
      taskBarrierTaskId: null,
      metadata: { [RESTART_TURN_AUTHORITY_METADATA_KEY]: recorded },
    } as unknown as RuntimeTurnAttemptRecord;
    const verdict = judgeRestartInterruptedAttempt(attempt, { hasLaterAttempt: () => false });
    if (verdict.kind !== "resume") throw new Error(`expected a resume verdict, got ${verdict.kind}`);
    return buildOrphanedRestartTurnInput({ restartEpoch: "epoch-probe", reason: "supervised_restart", verdict });
  }
  const published: Record<string, unknown>[] = [];
  await deliverDaemonRestartSessionEvent(
    {
      restartEpoch: "epoch-probe",
      reason: "supervised_restart",
      sessionName,
      sessionKey,
      kind: "active",
      snapshot: {
        restartEpoch: "epoch-probe",
        sessionKey,
        sessionName,
        agentId: agent.id,
        runtimeProvider: "codex",
        activity: "tool_running",
        nonIdle: true,
        lastActivityAt: 1,
        stoppedAt: 1,
        pendingMessageCount: 0,
        metadata: {
          live: true,
          [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue",
          [RESTART_TURN_AUTHORITY_METADATA_KEY]: recorded,
        },
        createdAt: 1,
        updatedAt: 1,
      } as DaemonRestartSessionSnapshotRecord,
    },
    {
      hasDelivery: () => false,
      markDelivered: () => undefined,
      publish: async (_sessionName, payload) => {
        published.push(payload);
      },
      isTerminalTaskSession: () => false,
      resolveSource: () => (source ? normalizeRestartResumeSource(source) : undefined),
    },
  );
  if (published.length !== 1) throw new Error("expected one published restart input");
  return published[0]!;
}

function build(prompt: Record<string, unknown>, resolvedSource: Record<string, unknown> | undefined): Ctx {
  return buildRuntimeRequestContext({
    dbSessionKey: sessionKey,
    sessionName,
    sessionCwd: agent.cwd,
    agent,
    prompt: prompt as never,
    ...(resolvedSource ? { resolvedSource: resolvedSource as never } : {}),
    runtimeProviderId: "codex",
    model: "gpt-5",
    runtimeResolution,
  }).runtimeContext;
}

function signature(ctx: Ctx): string[] {
  return ctx.capabilities.map((c) => `${c.permission}:${c.objectType}:${c.objectId}`).sort();
}

function view(label: string, ctx: Ctx) {
  const can = (p: string, t: string, o: string) => canWithCapabilities(ctx.capabilities, p as never, t as never, o);
  return {
    label,
    principal: ctx.metadata?.actorPrincipal ?? null,
    relayNarrowing: ctx.metadata?.relayNarrowing ?? null,
    withheld: ctx.metadata?.actorBreakGlassWithheld ?? null,
    capCount: ctx.capabilities.length,
    Bash: can("use", "tool", "Bash"),
    Read: can("use", "tool", "Read"),
    curl: can("execute", "executable", "curl"),
    adminSystem: can("admin", "system", "*"),
    execAny: can("execute", "executable", "*"),
  };
}

describe.each(["sweep", "graceful"] as const)(
  "a %s restart input holds no more authority than the turn it resumes",
  (path) => {
    beforeEach(async () => {
      stateDir = await createIsolatedRaviState("ravi-restart-resume-authority-");
      resumePath = path;
    });
    afterEach(async () => {
      await cleanupIsolatedRaviState(stateDir);
      stateDir = null;
    });

    // `sessions send` / `thread-send` attach the TARGET's reply source: a chat, no actor.
    const relaySource = { channel: "whatsapp", accountId: "main", chatId: "120363400000000099@g.us" };

    it("V1 relay narrowed to a contact's caps (inform): original vs resumed", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const overlayCaller = createRuntimeContext({
        kind: "turn-runtime",
        agentId: agent.id,
        sessionKey,
        sessionName,
        capabilities: [{ permission: "use", objectType: "tool", objectId: "Bash", source: "test" }],
        metadata: { actorAuthorizationMode: "user-overlay", actorPrincipal: "contact:ana" },
      });
      const originalPrompt = {
        prompt: "[System] Inform: do the narrowed thing",
        source: relaySource,
        _turnOrigin: buildSessionRelayTurnOrigin("inform", {
          agentId: agent.id,
          sessionKey,
          sessionName,
          contextId: overlayCaller.contextId,
        }),
      };
      const original = build(originalPrompt, relaySource);
      const resumed = build(await resumePromptFor(originalPrompt), relaySource);
      expect(canWithCapabilities(original.capabilities, "use", "tool", "Read")).toBe(false);
      expect(canWithCapabilities(resumed.capabilities, "use", "tool", "Read")).toBe(false);
      expect(signature(resumed)).toEqual(signature(original));
    });

    it("V2 relay from a person held below break-glass, full-access agent: original vs resumed", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const heldCaller = createRuntimeContext({
        kind: "turn-runtime",
        agentId: agent.id,
        sessionKey,
        sessionName,
        capabilities: [
          { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
          { permission: "deny_admin", objectType: "system", objectId: "*", source: "test" },
          { permission: "deny_execute", objectType: "executable", objectId: "*", source: "test" },
        ],
        metadata: { actorAuthorizationMode: "invoke-only", actorPrincipal: "contact:ana" },
      });
      const originalPrompt = {
        prompt: "[System] Inform: do the held thing",
        source: relaySource,
        _turnOrigin: buildSessionRelayTurnOrigin("inform", {
          agentId: agent.id,
          sessionKey,
          sessionName,
          contextId: heldCaller.contextId,
        }),
      };
      const original = build(originalPrompt, relaySource);
      const resumed = build(await resumePromptFor(originalPrompt), relaySource);
      expect(canWithCapabilities(original.capabilities, "admin", "system", "*")).toBe(false);
      expect(canWithCapabilities(resumed.capabilities, "admin", "system", "*")).toBe(false);
    });

    it("V3 control: a granted person's own turn keeps its caps through the same resume", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, {
        defaults: { runtimePermissions: { capabilities: ["mutate:image:generate", "execute:executable:curl"] } },
      });
      dbCreateTagDefinition({
        slug: "permission-image",
        label: "Image",
        kind: "system",
        source: "permissions",
        metadata: { permissions: { capabilities: ["mutate:image:generate", "mutate:mail:send"] } },
      });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const chat = dbUpsertChat({
        channel: "whatsapp",
        instanceId: "main",
        platformChatId: "120363400000000098@g.us",
        chatType: "group",
        title: "probe",
      });
      const ana = createContact({ phone: "5511900000098", name: "Ana" });
      dbEnsureContactChatGrant({
        contactId: ana.id,
        profileSlug: "permission-image",
        scopeType: "chat",
        scopeId: chat.id,
      });
      const humanSource = {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363400000000098@g.us",
        actorType: "contact",
        contactId: ana.id,
      };
      const originalPrompt = { prompt: "hi", source: humanSource };
      const original = build(originalPrompt, humanSource);
      const resumed = build(await resumePromptFor(originalPrompt), humanSource);
      const sig = (ctx: Ctx) => ctx.capabilities.map((c) => `${c.permission}:${c.objectType}:${c.objectId}`).sort();
      expect(sig(resumed)).toEqual(sig(original));
    });

    it("V4 control: an ungoverned-chat person keeps the break-glass deny through the same resume", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const ana = createContact({ phone: "5511900000097", name: "Ana" });
      const humanSource = {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363400000000097@g.us",
        actorType: "contact",
        contactId: ana.id,
      };
      const originalPrompt = { prompt: "hi", source: humanSource };
      const original = build(originalPrompt, humanSource);
      const resumed = build(await resumePromptFor(originalPrompt), humanSource);
      expect(canWithCapabilities(resumed.capabilities, "admin", "system", "*")).toBe(
        canWithCapabilities(original.capabilities, "admin", "system", "*"),
      );
    });

    it("V5 the same resume with NO recorded source (task / cli / console turn)", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const originalPrompt = { prompt: "task turn" };
      const original = build(originalPrompt, undefined);
      const resumed = build(await resumePromptFor(originalPrompt), undefined);
      const allows = (ctx: Ctx) => signature(ctx).filter((capability) => !capability.startsWith("deny_"));
      // Nothing the resumed turn may do that the original turn could not.
      expect(allows(resumed).filter((capability) => !allows(original).includes(capability))).toEqual([]);
    });

    it("V6 unresolved external sender: original vs resumed", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const strangerSource = {
        channel: "whatsapp",
        accountId: "main",
        chatId: "5511900000096@s.whatsapp.net",
        actorType: "unknown",
        rawSenderId: "5511900000096",
        normalizedSenderId: "5511900000096",
      };
      const originalPrompt = { prompt: "hi", source: strangerSource };
      const original = build(originalPrompt, strangerSource);
      const resumed = build(await resumePromptFor(originalPrompt), strangerSource);
      expect(view("r", resumed).capCount).toBe(view("o", original).capCount);
    });

    it("V7 relay from an unrestricted caller (operator): original vs resumed", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const plainCaller = createRuntimeContext({
        kind: "turn-runtime",
        agentId: agent.id,
        sessionKey,
        capabilities: [],
        metadata: { actorAuthorizationMode: "invoke-only" },
      });
      const originalPrompt = {
        prompt: "[System] Inform: operator relay",
        source: relaySource,
        _turnOrigin: buildSessionRelayTurnOrigin("inform", {
          agentId: agent.id,
          sessionKey,
          sessionName,
          contextId: plainCaller.contextId,
        }),
      };
      const original = build(originalPrompt, relaySource);
      const resumed = build(await resumePromptFor(originalPrompt), relaySource);
      expect(view("r", resumed).capCount).toBe(view("o", original).capCount);
    });

    it("V8 real Slack thread-child source (actorType agent) with a held relay: original vs resumed", async () => {
      dbCreateAgent({ id: agent.id, cwd: agent.cwd });
      dbUpdateAgent(agent.id, { defaults: { runtimePermissions: { profile: "full-access" } } });
      getOrCreateSession(sessionKey, agent.id, agent.cwd, { name: sessionName });
      const heldCaller = createRuntimeContext({
        kind: "turn-runtime",
        agentId: agent.id,
        sessionKey,
        sessionName,
        capabilities: [
          { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
          { permission: "deny_admin", objectType: "system", objectId: "*", source: "test" },
          { permission: "deny_execute", objectType: "executable", objectId: "*", source: "test" },
        ],
        metadata: { actorAuthorizationMode: "invoke-only", actorPrincipal: "contact:ana" },
      });
      // shape of buildSlackThreadChildSource() in thread-lifecycle.ts
      const threadSource = {
        channel: "slack",
        accountId: "ravi-slack",
        chatId: "C0THREAD",
        threadId: "1795568258.050489",
        sourceMessageId: "1795568258.050489",
        actorType: "agent",
        actorAgentId: agent.id,
      };
      for (const action of ["inform", "execute"] as const) {
        const originalPrompt = {
          prompt: "[System] relay",
          source: threadSource,
          _turnOrigin: buildSessionRelayTurnOrigin(action, {
            agentId: agent.id,
            sessionKey,
            sessionName,
            contextId: heldCaller.contextId,
          }),
        };
        const original = build(originalPrompt, threadSource);
        const resumed = build(await resumePromptFor(originalPrompt), threadSource);
        expect(canWithCapabilities(original.capabilities, "admin", "system", "*")).toBe(false);
        // Must stay false for a resume to hold no more than the turn it resumes.
        expect(canWithCapabilities(resumed.capabilities, "admin", "system", "*")).toBe(false);
        expect(resumed.metadata?.actorBreakGlassWithheld).toEqual(original.metadata?.actorBreakGlassWithheld);
        expect(signature(resumed)).toEqual(signature(original));
      }
    });
  },
);
