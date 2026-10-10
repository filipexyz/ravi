import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { runWithContext } from "../cli/context.js";
import { cloudErrorToContractError } from "../cli/cloud-error-contract.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { join } from "node:path";
import { dbCreateCronJob } from "../cron/cron-db.js";
import { JobsRunner } from "../jobs/runner.js";
import { dbCreateJob } from "../jobs/store.js";
import { TriggerRunner } from "../triggers/runner.js";
import type { Trigger } from "../triggers/types.js";
import type { ContextRecord } from "../router/router-db.js";
import { writeCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import {
  dbCanonicalizeDmChatForContact,
  dbCreateAgent,
  dbCreateRoute,
  dbCreateSessionChatSubscription,
  dbGetAgent,
  dbUpsertChat,
} from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import {
  ADMIN_BOOTSTRAP_AGENT_ID,
  ADMIN_BOOTSTRAP_KIND,
  createRuntimeContext,
  issueRuntimeContext,
  revokeRuntimeContext,
} from "../runtime/context-registry.js";
import { buildSessionRelayTurnOrigin, spawnedAutomationEnv } from "../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  buildAgentExecContext,
  buildExecContext,
  classifyConnectorTurn,
  decodeExecContextHeader,
  encodeExecContextHeader,
  EXEC_CONTEXT_MAX_BYTES,
  resolveConnectorExecRoute,
  resolveConnectorTurn,
  resolveCronOwnerPrincipalForCurrentTurn,
  resolveOperatorTurn,
  type ConnectorExecRouteDeps,
  type ConnectorExecRouteResult,
  type ConnectorTurnDeps,
} from "./connector-turn.js";
import { readAgentConnectorMode, type ConnectorUseMode, writeAgentConnectorMode } from "./connector-mode.js";

const OWNER = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" } satisfies ConnectorTurnDeps;

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-connector-turn-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function turnContext(metadata: Record<string, unknown>, extra: { sessionName?: string } = {}): ContextRecord {
  return createRuntimeContext({
    kind: "turn-runtime",
    agentId: "main",
    sessionName: extra.sessionName ?? "main-session",
    metadata: { actorResolution: "resolved", executorAgentId: "main", ...metadata },
  });
}

function envFor(context: ContextRecord): NodeJS.ProcessEnv {
  return { RAVI_CONTEXT_KEY: context.contextKey };
}

function classify(context: ContextRecord, deps: ConnectorTurnDeps = {}) {
  return resolveConnectorTurn({ ...OWNER, env: envFor(context), ...deps });
}

function expectBlocked(result: ReturnType<typeof resolveConnectorTurn>, code: string): CloudAuthError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a blocked turn");
  expect(result.error).toBeInstanceOf(CloudAuthError);
  expect(result.error.code).toBe(code as CloudAuthError["code"]);
  expect(result.error.exitCode).toBe(3);
  return result.error;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("connector turn classification", () => {
  it("treats a call without RAVI_CONTEXT_KEY as the terminal", () => {
    const result = resolveConnectorTurn({ ...OWNER, env: {} });

    expect(result).toEqual({
      ok: true,
      turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" },
    });
  });

  it("fails closed on runtime session env without a context key", () => {
    expectBlocked(
      resolveConnectorTurn({ ...OWNER, env: { RAVI_SESSION_NAME: "main-session" } }),
      "CONNECTOR_SPEAKER_NOT_OWNER",
    );
  });

  it("fails closed when the context key does not resolve", () => {
    expectBlocked(
      resolveConnectorTurn({ ...OWNER, env: { RAVI_CONTEXT_KEY: "rctx_missing" } }),
      "CONNECTOR_SPEAKER_NOT_OWNER",
    );

    const context = turnContext({
      actorPrincipal: "automation:operator:local",
      agentIdentityCompartment: "workspace:default",
    });
    revokeRuntimeContext(context.contextId);
    expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
  });

  it("lets the operator's own `ravi sessions send` turn act as the owner", () => {
    const context = turnContext({
      actorPrincipal: "automation:operator:local",
      agentIdentityCompartment: "workspace:default",
      turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
    });

    expect(classify(context)).toEqual({
      ok: true,
      turn: {
        actorPrincipal: "automation:operator:local",
        speaker: { kind: "owner" },
        conversation: "terminal",
        agentId: "main",
        sessionName: "main-session",
        turnKey: sha256(context.contextId),
      },
    });
  });

  it("treats the operator's relay with the admin key like the terminal relay", () => {
    const context = turnContext({
      actorPrincipal: `agent:${ADMIN_BOOTSTRAP_AGENT_ID}`,
      agentIdentityCompartment: "workspace:default",
      turnOrigin: buildSessionRelayTurnOrigin("ask", { agentId: ADMIN_BOOTSTRAP_AGENT_ID }),
    });

    const result = classify(context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn).toMatchObject({ speaker: { kind: "owner" }, conversation: "terminal" });
  });

  it("refuses operator-looking relays that are not a direct send or ask", () => {
    // A runtime goal wakes the session with `execute` and no caller.
    const goalWake = turnContext({
      actorPrincipal: "automation:operator:local",
      agentIdentityCompartment: "workspace:default",
      turnOrigin: buildSessionRelayTurnOrigin("execute"),
    });
    const inform = turnContext({
      actorPrincipal: "automation:operator:local",
      agentIdentityCompartment: "workspace:default",
      turnOrigin: buildSessionRelayTurnOrigin("inform"),
    });
    const noOrigin = turnContext({
      actorPrincipal: "automation:operator:local",
      agentIdentityCompartment: "workspace:default",
    });
    // An agent called "bootstrap" relaying from its own session is an agent.
    const bootstrapAgentSession = turnContext({
      actorPrincipal: `agent:${ADMIN_BOOTSTRAP_AGENT_ID}`,
      agentIdentityCompartment: "workspace:default",
      turnOrigin: buildSessionRelayTurnOrigin("send", {
        agentId: ADMIN_BOOTSTRAP_AGENT_ID,
        sessionKey: "agent:bootstrap:main",
        sessionName: "bootstrap-main",
      }),
    });
    // The origin must name the same principal.
    const mismatched = turnContext({
      actorPrincipal: "automation:operator:local",
      agentIdentityCompartment: "workspace:default",
      turnOrigin: buildSessionRelayTurnOrigin("send", { agentId: "helper" }),
    });

    for (const context of [goalWake, inform, noOrigin, bootstrapAgentSession, mismatched]) {
      expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
    }
  });

  it("classifies the goal wake turn the runtime builds as not the owner", () => {
    // Same envelope `RuntimeHostSubscriptions` publishes when a goal activates.
    const origin = buildSessionRelayTurnOrigin("execute");
    expect(origin.principal).toEqual({ type: "automation", id: "operator:local" });

    const context = turnContext({
      actorPrincipal: `${origin.principal.type}:${origin.principal.id}`,
      agentIdentityCompartment: "workspace:default",
      turnOrigin: origin,
    });

    expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
  });

  it("lets the owner's own linked direct chat act as the owner", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_luis",
      consoleUserId: "user_luis",
      consoleOrgId: "org_1",
      agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
    });

    const result = classify(context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn).toMatchObject({
      actorPrincipal: "contact:c_luis",
      speaker: { kind: "owner", contactId: "c_luis", consoleUserId: "user_luis" },
      conversation: "dm",
    });
  });

  it("refuses a contact linked to another Console user with the chat line to send", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_ana",
      consoleUserId: "user_ana",
      consoleOrgId: "org_1",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    });

    const error = expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");

    expect(error.details).toMatchObject({
      source: "connector-turn",
      chatLine: "I can't use Luis's Gmail for your request.",
      chatLinePt: "Não posso usar o Gmail de Luis para o seu pedido.",
      replyTo: "same_chat",
    });
    expect(error.message).toContain(`"I can't use Luis's Gmail for your request."`);
  });

  it("refuses the owner's Console user from another organization", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_luis",
      consoleUserId: "user_luis",
      consoleOrgId: "org_other",
      agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
    });

    expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
  });

  it("refuses an unlinked contact and points at ravi link", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_new",
      agentIdentityCompartment: "dm:5511777777777@s.whatsapp.net",
    });

    const error = expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");

    expect(error.message).toContain("ravi link");
    expect(error.details?.chatLine).toBe("I can't use Luis's Gmail for your request.");
  });

  it("refuses an unresolved sender (missing_contact / unknown)", () => {
    const context = turnContext({
      actorPrincipal: "unknown",
      actorResolution: "missing_contact",
      agentIdentityCompartment: "dm:5511666666666@s.whatsapp.net",
    });

    expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
  });

  it("refuses a contact turn without a verified resolution even when the user matches", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_luis",
      actorResolution: "not_applicable",
      consoleUserId: "user_luis",
      agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
    });

    expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
  });

  it("refuses a relay from another agent and session-relay automation", () => {
    expectBlocked(
      classify(turnContext({ actorPrincipal: "agent:helper", agentIdentityCompartment: "workspace:default" })),
      "CONNECTOR_SPEAKER_NOT_OWNER",
    );
    expectBlocked(
      classify(
        turnContext({
          actorPrincipal: "automation:session:agent:helper:main",
          agentIdentityCompartment: "workspace:default",
        }),
      ),
      "CONNECTOR_SPEAKER_NOT_OWNER",
    );
  });

  it.each([
    "automation:trigger:tr_1",
    "automation:observer:binding_1",
    "automation:session-followup",
    "automation:daemon-restart",
  ])("refuses %s", (actorPrincipal) => {
    const compartmentId = actorPrincipal.slice("automation:".length);
    const context = turnContext({ actorPrincipal, agentIdentityCompartment: `automation:${compartmentId}` });

    expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");
  });

  it("lets the heartbeat run as a routine", () => {
    const context = turnContext({
      actorPrincipal: "automation:heartbeat",
      agentIdentityCompartment: "automation:heartbeat",
    });

    const result = classify(context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn).toMatchObject({
      speaker: { kind: "automation" },
      conversation: "automation",
      routine: { kind: "heartbeat" },
    });
  });

  describe("cron routines", () => {
    function cronTurn(jobId: string) {
      return turnContext({
        actorPrincipal: `automation:cron:${jobId}`,
        agentIdentityCompartment: `automation:cron:${jobId}`,
      });
    }

    function createJob(ownerPrincipal?: string) {
      return dbCreateCronJob({
        name: `connector-turn-${Math.random()}`,
        schedule: { type: "every", every: 60_000 },
        message: "summarize my inbox",
        ...(ownerPrincipal ? { ownerPrincipal } : {}),
      });
    }

    it("runs as the operator when the job owner is the operator", () => {
      const job = createJob("operator");

      const result = classify(cronTurn(job.id));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.turn).toMatchObject({
        speaker: { kind: "automation" },
        conversation: "automation",
        routine: { kind: "cron", id: job.id },
      });
    });

    it("treats a legacy job without owner as the operator's", () => {
      const job = createJob();

      expect(classify(cronTurn(job.id)).ok).toBe(true);
    });

    it("refuses a job created by a contact", () => {
      const job = createJob("contact:c_ana");

      const error = expectBlocked(classify(cronTurn(job.id)), "CONNECTOR_SPEAKER_NOT_OWNER");
      expect(error.message).toContain("contact:c_ana");
    });

    it("refuses a job that no longer exists", () => {
      expectBlocked(classify(cronTurn("gone1234")), "CONNECTOR_SPEAKER_NOT_OWNER");
    });

    it("runs a job created by the owner's own linked contact (for example while logged out)", () => {
      writeCachedActorBinding({
        contactId: "c_luis",
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        orgId: "org_1",
        installationId: "inst_1",
      });
      const job = createJob("contact:c_luis");

      expect(classify(cronTurn(job.id)).ok).toBe(true);
      expectBlocked(classify(cronTurn(job.id), { activeUserId: "user_other" }), "CONNECTOR_SPEAKER_NOT_OWNER");
    });
  });

  describe("processes the daemon spawns for automations", () => {
    function createJob(ownerPrincipal?: string) {
      return dbCreateCronJob({
        name: `connector-turn-shell-${Math.random()}`,
        schedule: { type: "every", every: 60_000 },
        message: "",
        executionType: "shell",
        shellCommand: "ravi gmail list --json",
        ...(ownerPrincipal ? { ownerPrincipal } : {}),
      });
    }

    it("never classifies a shell trigger's env as the terminal", () => {
      expectBlocked(
        resolveConnectorTurn({ ...OWNER, env: { RAVI_TRIGGER_ID: "trg_1", pm_id: "0" } }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
      expectBlocked(
        resolveConnectorTurn({
          ...OWNER,
          env: { RAVI_TRIGGER_ID: "trg_1", ...spawnedAutomationEnv("trigger", "trg_1") },
        }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
    });

    it("refuses a job started with `ravi jobs run`", () => {
      const error = expectBlocked(
        resolveConnectorTurn({ ...OWNER, env: spawnedAutomationEnv("job", "job_1") }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
      expect(error.message).toContain("automation:job:job_1");
    });

    it("checks a shell cron against the job's owner", () => {
      const operatorJob = createJob("operator");
      const contactJob = createJob("contact:c_bob");

      const allowed = resolveConnectorTurn({ ...OWNER, env: spawnedAutomationEnv("cron", operatorJob.id) });
      expect(allowed).toEqual({
        ok: true,
        turn: {
          actorPrincipal: `automation:cron:${operatorJob.id}`,
          speaker: { kind: "automation" },
          conversation: "automation",
          routine: { kind: "cron", id: operatorJob.id },
        },
      });
      expectBlocked(
        resolveConnectorTurn({ ...OWNER, env: spawnedAutomationEnv("cron", contactJob.id) }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
    });

    it("records a cron created inside a spawned automation as owned by that automation", () => {
      const contactJob = createJob("contact:c_bob");

      expect(
        resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: spawnedAutomationEnv("cron", contactJob.id) }),
      ).toBe(`automation:cron:${contactJob.id}`);
      expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: spawnedAutomationEnv("job", "job_1") })).toBe(
        "automation:job:job_1",
      );
    });

    it("classifies the env the trigger and jobs runners build for their commands", () => {
      const triggerRunner = new TriggerRunner() as unknown as {
        buildShellEnv(
          trigger: Trigger,
          event: { topic: string; data: unknown },
          source: undefined,
          eventFile: string,
          dataFile: string,
        ): Record<string, string>;
      };
      const triggerEnv = triggerRunner.buildShellEnv(
        { id: "trg_1", name: "ticket" } as Trigger,
        { topic: "ravi.test", data: {} },
        undefined,
        "/tmp/event.json",
        "/tmp/data.json",
      );
      expect(triggerEnv.RAVI_AUTOMATION_PRINCIPAL).toBe("automation:trigger:trg_1");
      expectBlocked(
        resolveConnectorTurn({ ...OWNER, env: { ...process.env, ...triggerEnv } }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );

      const spawned: { env: Record<string, string> | null } = { env: null };
      const jobsRunner = new JobsRunner({
        spawnCommand: (_command, _cwd, _logPath, env) => {
          spawned.env = env;
          return { pid: null, onExit: () => {} };
        },
      });
      (jobsRunner as unknown as { running: boolean }).running = true;
      const job = dbCreateJob({
        command: "ravi gmail list --json",
        cwd: null,
        logPath: join(stateDir ?? "/tmp", "job.log"),
        origin: "agent",
      });
      expect(jobsRunner.startJob(job.id)).toBe(true);
      expect(spawned.env).toEqual({ RAVI_AUTOMATION_PRINCIPAL: `automation:job:${job.id}` });
      expectBlocked(
        resolveConnectorTurn({ ...OWNER, env: { ...process.env, ...(spawned.env ?? {}) } }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
    });

    it("lets a context key win over the automation marker", () => {
      const context = turnContext({
        actorPrincipal: "contact:c_ana",
        consoleUserId: "user_ana",
        agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
      });
      const operatorJob = createJob("operator");

      expectBlocked(
        resolveConnectorTurn({
          ...OWNER,
          env: { ...envFor(context), ...spawnedAutomationEnv("cron", operatorJob.id) },
        }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
    });
  });

  describe("group compartments", () => {
    it("blocks the owner in a group and tells the agent to answer privately", () => {
      const context = turnContext({
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        consoleOrgId: "org_1",
        agentIdentityCompartment: "chat:120363012345678901@g.us",
      });

      const error = expectBlocked(classify(context), "CONNECTOR_GROUP_BLOCKED");

      expect(error.details).toMatchObject({ chatLine: "I'll send this to you privately.", replyTo: "same_chat" });
      expect(error.message).toContain("direct chat");
    });

    it("blocks someone else in a group with the other-person line", () => {
      const context = turnContext({
        actorPrincipal: "contact:c_ana",
        consoleUserId: "user_ana",
        agentIdentityCompartment: "chat:120363012345678901@g.us",
      });

      const error = expectBlocked(classify(context), "CONNECTOR_GROUP_BLOCKED");
      expect(error.details?.chatLine).toBe("I can't use Luis's Gmail for your request.");
    });

    it("blocks routines and operator relays that answer into a group", () => {
      dbUpsertChat({ channel: "whatsapp", instanceId: "", platformChatId: "120363@g.us", chatType: "group" });

      expectBlocked(
        classify(turnContext({ actorPrincipal: "automation:heartbeat", agentIdentityCompartment: "chat:120363@g.us" })),
        "CONNECTOR_GROUP_BLOCKED",
      );
      expectBlocked(
        classify(
          turnContext({
            actorPrincipal: "automation:operator:local",
            agentIdentityCompartment: "chat:120363@g.us",
            turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
          }),
        ),
        "CONNECTOR_GROUP_BLOCKED",
      );
    });
  });

  describe("routines that answer into a direct chat", () => {
    const OWNER_JID = "5511999999999@s.whatsapp.net";
    const ANA_JID = "5511888888888@s.whatsapp.net";

    function directChat(platformChatId: string, contactId: string) {
      const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "", platformChatId, chatType: "dm" });
      return dbCanonicalizeDmChatForContact({ chatId: chat.id, contactId, platformChatId });
    }

    function bind(contactId: string, consoleUserId: string, orgId = "org_1") {
      writeCachedActorBinding({
        contactId,
        actorPrincipal: `contact:${contactId}`,
        consoleUserId,
        orgId,
        installationId: "inst_1",
      });
    }

    // What the heartbeat runner publishes: the main session's last chat as
    // `source`, no `context`, so the compartment is `chat:<lastTo>`.
    function heartbeatTurn(chatId: string) {
      return turnContext({
        actorPrincipal: "automation:heartbeat",
        agentIdentityCompartment: `chat:${chatId}`,
        actorMetadata: { channel: "whatsapp", chatId, automationId: "heartbeat" },
      });
    }

    it("lets the heartbeat answer into the owner's own direct chat", () => {
      directChat(OWNER_JID, "c_luis");
      bind("c_luis", "user_luis");

      const result = classify(heartbeatTurn(OWNER_JID));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.turn).toMatchObject({
        speaker: { kind: "automation" },
        conversation: "dm",
        routine: { kind: "heartbeat" },
      });
    });

    it("lets an operator cron answer into the owner's direct chat, found by the canonical chat id too", () => {
      const chat = directChat(OWNER_JID, "c_luis");
      bind("c_luis", "user_luis");
      const job = dbCreateCronJob({
        name: `connector-turn-dm-${Math.random()}`,
        schedule: { type: "every", every: 60_000 },
        message: "summarize my inbox",
        ownerPrincipal: "operator",
      });

      const result = classify(
        turnContext({
          actorPrincipal: `automation:cron:${job.id}`,
          agentIdentityCompartment: `chat:${chat.id}`,
          actorMetadata: { channel: "whatsapp", canonicalChatId: chat.id },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.turn).toMatchObject({ conversation: "dm", routine: { kind: "cron", id: job.id } });
    });

    it("blocks a routine answering into someone else's direct chat", () => {
      directChat(ANA_JID, "c_ana");
      bind("c_ana", "user_ana");

      expectBlocked(classify(heartbeatTurn(ANA_JID)), "CONNECTOR_GROUP_BLOCKED");
    });

    it("blocks a routine answering into a direct chat whose contact is not linked or is linked in another org", () => {
      directChat(OWNER_JID, "c_luis");
      expectBlocked(classify(heartbeatTurn(OWNER_JID)), "CONNECTOR_GROUP_BLOCKED");

      bind("c_luis", "user_luis", "org_other");
      expectBlocked(classify(heartbeatTurn(OWNER_JID)), "CONNECTOR_GROUP_BLOCKED");
    });

    it("blocks a routine answering into a chat Ravi does not know", () => {
      expectBlocked(classify(heartbeatTurn("5511000000000@s.whatsapp.net")), "CONNECTOR_GROUP_BLOCKED");
    });

    it("applies the same rule to a `dm:` compartment", () => {
      directChat(ANA_JID, "c_ana");
      bind("c_ana", "user_ana");

      expectBlocked(
        classify(turnContext({ actorPrincipal: "automation:heartbeat", agentIdentityCompartment: `dm:${ANA_JID}` })),
        "CONNECTOR_GROUP_BLOCKED",
      );
    });
  });

  describe("lineage", () => {
    it("lets a derived cli-runtime child inherit the actor of its turn", () => {
      const parent = turnContext({
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      });
      const child = issueRuntimeContext({ parent, cliName: "external-cli" });
      expect(child.metadata?.actorPrincipal).toBeUndefined();

      const result = classify(child);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.turn).toMatchObject({ speaker: { kind: "owner", contactId: "c_luis" }, conversation: "dm" });
      expect(result.turn.turnKey).toBe(sha256(parent.contextId));
    });

    it("keeps refusing someone else through a derived child", () => {
      const parent = turnContext({
        actorPrincipal: "contact:c_ana",
        consoleUserId: "user_ana",
        agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
      });
      const child = issueRuntimeContext({ parent, cliName: "external-cli" });

      expectBlocked(classify(child), "CONNECTOR_SPEAKER_NOT_OWNER");
    });

    it("fails closed when no context in the lineage carries an actor", () => {
      const orphan = createRuntimeContext({
        kind: "cli-runtime",
        agentId: "main",
        metadata: { parentContextId: "ctx_pruned_parent" },
      });
      const root = createRuntimeContext({ kind: "cli-runtime", agentId: "main", metadata: {} });

      expectBlocked(classify(orphan), "CONNECTOR_SPEAKER_NOT_OWNER");
      expectBlocked(classify(root), "CONNECTOR_SPEAKER_NOT_OWNER");
    });

    it("fails closed when an ancestor turn has ended", () => {
      const parent = turnContext({
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      });
      const child = issueRuntimeContext({ parent, cliName: "external-cli" });
      // Turn rotation revokes the previous turn without cascading to children.
      revokeRuntimeContext(parent.contextId, { cascade: false, reason: "turn_context_rotated" });

      const error = expectBlocked(classify(child), "CONNECTOR_SPEAKER_NOT_OWNER");
      expect(error.message).toContain("already ended");
    });

    it("fails closed when an ancestor expired", () => {
      const parent = turnContext({
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      });
      const child = issueRuntimeContext({ parent, cliName: "external-cli" });

      const expiredParent = { ...parent, expiresAt: Date.now() - 1 };

      const error = expectBlocked(
        classify(child, { getContextById: (id) => (id === parent.contextId ? expiredParent : null) }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
      expect(error.message).toContain("already ended");
    });

    it("fails closed when a projected actor's source turn has ended", () => {
      const source = turnContext({
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      });
      const projected = createRuntimeContext({
        kind: "cli-runtime",
        agentId: "main",
        metadata: {
          actorPrincipal: "contact:c_luis",
          actorResolution: "resolved",
          consoleUserId: "user_luis",
          actorProjection: { source: "delegated-session-turn", sourceContextId: source.contextId },
        },
      });
      expect(classify(projected).ok).toBe(true);

      revokeRuntimeContext(source.contextId, { cascade: false });
      // Whatever happens to the projection itself, a dead source never lends its actor.
      const result = resolveConnectorTurn({
        ...OWNER,
        runtimeContext: { present: true, record: projected },
      });
      expectBlocked(result, "CONNECTOR_SPEAKER_NOT_OWNER");
    });

    it("reads the compartment of a projected session actor from its source turn", () => {
      const source = turnContext({
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        agentIdentityCompartment: "chat:120363012345678901@g.us",
      });
      const projected = createRuntimeContext({
        kind: "cli-runtime",
        agentId: "main",
        metadata: {
          parentContextId: "ctx_admin",
          actorPrincipal: "contact:c_luis",
          actorResolution: "resolved",
          consoleUserId: "user_luis",
          actorProjection: { source: "delegated-session-turn", sourceContextId: source.contextId },
        },
      });

      expectBlocked(classify(projected), "CONNECTOR_GROUP_BLOCKED");
    });
  });

  describe("in-process tool and gateway calls", () => {
    it("uses the tool context instead of the process env", () => {
      const context = turnContext({
        actorPrincipal: "contact:c_ana",
        consoleUserId: "user_ana",
        agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
      });

      const result = runWithContext({ transport: "tool", context, contextId: context.contextId }, () =>
        resolveConnectorTurn({ ...OWNER, env: {} }),
      );

      expectBlocked(result, "CONNECTOR_SPEAKER_NOT_OWNER");
    });

    function ensureBootstrapAgent() {
      if (!dbGetAgent(ADMIN_BOOTSTRAP_AGENT_ID))
        dbCreateAgent({ id: ADMIN_BOOTSTRAP_AGENT_ID, cwd: stateDir ?? "/tmp" });
    }

    it("treats the operator's admin key over the gateway (SDK) as the terminal", () => {
      ensureBootstrapAgent();
      const admin = createRuntimeContext({
        kind: ADMIN_BOOTSTRAP_KIND,
        agentId: ADMIN_BOOTSTRAP_AGENT_ID,
        capabilities: [{ permission: "admin", objectType: "system", objectId: "*", source: "config:admin-bootstrap" }],
        metadata: { bootstrap: true },
      });
      const child = issueRuntimeContext({ parent: admin, cliName: "sdk-tool" });

      for (const context of [admin, child]) {
        const result = runWithContext({ transport: "gateway", context, contextId: context.contextId }, () =>
          resolveConnectorTurn({ ...OWNER, env: {} }),
        );
        expect(result).toEqual({
          ok: true,
          turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" },
        });
      }
      expect(resolveConnectorTurn({ ...OWNER, env: envFor(admin) }).ok).toBe(true);
      expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: envFor(admin) })).toBe("operator");
    });

    it("does not treat an admin-bootstrap kind without the admin capability, or a revoked one, as the operator", () => {
      ensureBootstrapAgent();
      const weak = createRuntimeContext({ kind: ADMIN_BOOTSTRAP_KIND, agentId: ADMIN_BOOTSTRAP_AGENT_ID });
      expectBlocked(classify(weak), "CONNECTOR_SPEAKER_NOT_OWNER");

      const admin = createRuntimeContext({
        kind: ADMIN_BOOTSTRAP_KIND,
        agentId: ADMIN_BOOTSTRAP_AGENT_ID,
        capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }],
      });
      const child = issueRuntimeContext({ parent: admin, cliName: "sdk-tool" });
      revokeRuntimeContext(admin.contextId, { cascade: false });
      expectBlocked(classify(child), "CONNECTOR_SPEAKER_NOT_OWNER");
    });

    it("fails closed for a gateway call without a context record", () => {
      const result = runWithContext({ transport: "gateway" }, () => resolveConnectorTurn({ ...OWNER, env: {} }));

      expectBlocked(result, "CONNECTOR_SPEAKER_NOT_OWNER");
    });
  });

  it("classifyConnectorTurn throws the policy error", () => {
    const context = turnContext({ actorPrincipal: "agent:helper", agentIdentityCompartment: "workspace:default" });

    expect(() => classifyConnectorTurn({ ...OWNER, env: envFor(context) })).toThrow(CloudAuthError);
  });

  it("maps a turn block to an exit-3 contract error carrying the chat lines", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_ana",
      consoleUserId: "user_ana",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    });
    const error = expectBlocked(classify(context), "CONNECTOR_SPEAKER_NOT_OWNER");

    const contract = cloudErrorToContractError("gmail list", error);

    expect(contract.exitCode).toBe(3);
    expect(contract.message).toContain("I can't use Luis's Gmail for your request.");
    expect(contract.envelope().error).toMatchObject({
      code: "CONNECTOR_SPEAKER_NOT_OWNER",
      chatLine: "I can't use Luis's Gmail for your request.",
      chatLinePt: "Não posso usar o Gmail de Luis para o seu pedido.",
      replyTo: "same_chat",
    });
  });

  it("falls back to a neutral owner label without a name", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_ana",
      consoleUserId: "user_ana",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    });

    const error = expectBlocked(classify(context, { ownerName: null }), "CONNECTOR_SPEAKER_NOT_OWNER");
    expect(error.details?.chatLine).toBe("I can't use my owner's Gmail for your request.");
    expect(error.details?.chatLinePt).toBe("Não posso usar o Gmail do meu dono para o seu pedido.");
  });
});

describe("cron owner for the creating turn", () => {
  it("is the operator from the terminal and from the owner's own chat", () => {
    expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: {} })).toBe("operator");

    const owner = turnContext({
      actorPrincipal: "contact:c_luis",
      consoleUserId: "user_luis",
      agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
    });
    expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: envFor(owner) })).toBe("operator");
  });

  it("is the operator when the owner asks in a group", () => {
    const ownerInGroup = turnContext({
      actorPrincipal: "contact:c_luis",
      consoleUserId: "user_luis",
      agentIdentityCompartment: "chat:120363012345678901@g.us",
    });

    expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: envFor(ownerInGroup) })).toBe("operator");
  });

  it("is the creating actor otherwise", () => {
    const other = turnContext({
      actorPrincipal: "contact:c_ana",
      consoleUserId: "user_ana",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    });
    const heartbeat = turnContext({
      actorPrincipal: "automation:heartbeat",
      agentIdentityCompartment: "automation:heartbeat",
    });

    expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: envFor(other) })).toBe("contact:c_ana");
    expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: envFor(heartbeat) })).toBe("automation:heartbeat");
    expect(resolveCronOwnerPrincipalForCurrentTurn({ ...OWNER, env: { RAVI_CONTEXT_KEY: "rctx_missing" } })).toBe(
      "unknown",
    );
  });
});

describe("X-Ravi-Exec-Context", () => {
  it("encodes the classified turn as base64url JSON version 1", () => {
    const header = encodeExecContextHeader(
      buildExecContext({
        actorPrincipal: "automation:cron:job1",
        speaker: { kind: "automation" },
        conversation: "automation",
        routine: { kind: "cron", id: "job1" },
        agentId: "main",
        sessionName: "main-session",
        turnKey: sha256("ctx_1"),
      }),
    );

    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeExecContextHeader(header)).toEqual({
      v: 1,
      agentId: "main",
      sessionName: "main-session",
      routine: { kind: "cron", id: "job1" },
      speaker: { kind: "automation" },
      conversation: "automation",
      turnKey: sha256("ctx_1"),
    });
  });

  it("encodes the terminal without agent fields and never carries the actor principal", () => {
    const header = encodeExecContextHeader(
      buildExecContext({ actorPrincipal: "terminal", speaker: { kind: "terminal" }, conversation: "terminal" }),
    );

    expect(decodeExecContextHeader(header)).toEqual({ v: 1, speaker: { kind: "terminal" }, conversation: "terminal" });
  });

  it("drops optional labels to stay within 2 KB", () => {
    const header = encodeExecContextHeader(
      buildExecContext({
        actorPrincipal: "contact:c_luis",
        speaker: { kind: "owner", contactId: "c_luis", consoleUserId: "user_luis" },
        conversation: "dm",
        agentId: "main",
        sessionName: "s".repeat(3000),
        turnKey: sha256("ctx_1"),
      }),
    );

    expect(header.length).toBeLessThanOrEqual(EXEC_CONTEXT_MAX_BYTES);
    expect(decodeExecContextHeader(header)).toEqual({
      v: 1,
      agentId: "main",
      speaker: { kind: "owner", contactId: "c_luis", consoleUserId: "user_luis" },
      conversation: "dm",
      turnKey: sha256("ctx_1"),
    });
  });
});

describe("per-agent connector mode", () => {
  const LUIS_DM = {
    actorPrincipal: "contact:c_luis",
    consoleUserId: "user_luis",
    consoleOrgId: "org_1",
    agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
  };
  const LUIS_GROUP = { ...LUIS_DM, agentIdentityCompartment: "chat:120363012345678901@g.us" };
  const ANA_DM = {
    actorPrincipal: "contact:c_ana",
    consoleUserId: "user_ana",
    consoleOrgId: "org_1",
    agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
  };
  const ANA_GROUP = { ...ANA_DM, agentIdentityCompartment: "chat:120363012345678901@g.us" };
  const NEW_DM = { actorPrincipal: "contact:c_new", agentIdentityCompartment: "dm:5511777777777@s.whatsapp.net" };
  const HEARTBEAT = { actorPrincipal: "automation:heartbeat", agentIdentityCompartment: "automation:heartbeat" };

  const RELAY = {
    actorPrincipal: "automation:operator:local",
    agentIdentityCompartment: "workspace:default",
    turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
  };

  // The session check of `person_asking` has its own tests below, on the
  // router tables; here every direct chat is the person's own session.
  function route(
    metadata: Record<string, unknown> | null,
    mode: ConnectorUseMode,
    extra: Partial<Pick<ConnectorExecRouteDeps, "useShared" | "isPrivateDirectSession">> = {},
  ): ConnectorExecRouteResult {
    return resolveConnectorExecRoute({
      ...OWNER,
      env: metadata ? envFor(turnContext(metadata)) : {},
      provider: "google",
      getAgentMode: () => mode,
      getAgentDisplayName: () => "Main agent",
      isPrivateDirectSession: () => true,
      ...extra,
    });
  }

  function expectRoute(result: ConnectorExecRouteResult, mode: ConnectorUseMode) {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a route, got ${result.error.code}`);
    expect(result.route.mode).toBe(mode);
    return result.route.turn;
  }

  function expectRefused(result: ConnectorExecRouteResult, code: string): CloudAuthError {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`expected a refusal, got ${result.route.mode}`);
    expect(result.error.code).toBe(code as CloudAuthError["code"]);
    return result.error;
  }

  describe("owner (default)", () => {
    it("keeps the owner's table: the owner's turns and routines use the owner's connection", () => {
      expectRoute(route(null, "owner"), "owner");
      expect(expectRoute(route(LUIS_DM, "owner"), "owner").speaker).toMatchObject({
        kind: "owner",
        consoleUserId: "user_luis",
      });
      expectRoute(route(HEARTBEAT, "owner"), "owner");
    });

    it("refuses everyone else, in direct chats and in groups", () => {
      expectRefused(route(ANA_DM, "owner"), "CONNECTOR_SPEAKER_NOT_OWNER");
      expectRefused(route(NEW_DM, "owner"), "CONNECTOR_SPEAKER_NOT_OWNER");
      expectRefused(route(ANA_GROUP, "owner"), "CONNECTOR_GROUP_BLOCKED");
      expectRefused(route(LUIS_GROUP, "owner"), "CONNECTOR_GROUP_BLOCKED");
    });
  });

  describe("person asking", () => {
    it("sends a contact linked to another Console user to agent exec, without that user id", () => {
      const turn = expectRoute(route(ANA_DM, "person_asking"), "person_asking");

      expect(turn).toMatchObject({
        agentId: "main",
        agentDisplayName: "Main agent",
        actorPrincipal: "contact:c_ana",
        speaker: { kind: "contact", contactId: "c_ana" },
        conversation: "dm",
      });
      expect(turn.speaker.consoleUserId).toBeUndefined();
    });

    it("sends an unlinked contact too: the Worker answers connector_not_linked", () => {
      const turn = expectRoute(route(NEW_DM, "person_asking"), "person_asking");
      expect(turn.speaker).toEqual({ kind: "contact", contactId: "c_new" });
    });

    it("keeps groups blocked, with the line for the person asking", () => {
      const error = expectRefused(route(ANA_GROUP, "person_asking"), "CONNECTOR_GROUP_BLOCKED");

      expect(error.exitCode).toBe(3);
      expect(error.details).toMatchObject({
        source: "connector-turn",
        chatLine: "I can only use your Gmail in a direct chat with me. Ask me there.",
        chatLinePt: "Só posso usar o seu Gmail numa conversa direta comigo. Me peça por lá.",
        replyTo: "same_chat",
      });
    });

    it("keeps the owner's own turns and routines on the owner's connection", () => {
      expectRoute(route(null, "person_asking"), "owner");
      expectRoute(route(LUIS_DM, "person_asking"), "owner");
      expectRoute(route(HEARTBEAT, "person_asking"), "owner");
      expectRefused(route(LUIS_GROUP, "person_asking"), "CONNECTOR_GROUP_BLOCKED");
    });

    it("refuses an unresolved sender", () => {
      expectRefused(
        route(
          {
            actorPrincipal: "unknown",
            actorResolution: "missing_contact",
            agentIdentityCompartment: NEW_DM.agentIdentityCompartment,
          },
          "person_asking",
        ),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
      expectRefused(
        route({ ...ANA_DM, actorResolution: "not_applicable" }, "person_asking"),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
    });

    it("refuses a direct chat whose session is not the person's alone, with the line for them", () => {
      const error = expectRefused(
        route(ANA_DM, "person_asking", { isPrivateDirectSession: () => false }),
        "CONNECTOR_GROUP_BLOCKED",
      );

      expect(error.exitCode).toBe(3);
      expect(error.details).toMatchObject({
        source: "connector-turn",
        chatLine: "I can't use your Gmail in this conversation.",
        chatLinePt: "Não posso usar o seu Gmail nesta conversa.",
        replyTo: "same_chat",
      });
      expect(error.message).toContain("dmScope per-peer");
    });
  });

  describe("person asking needs a session of the person's own", () => {
    const ANA_KEY = "agent:main:whatsapp:wa-main:dm:5511888888888";
    const ANA_JID = "5511888888888@s.whatsapp.net";
    const BOB_JID = "5511777777777@s.whatsapp.net";

    function askingRoute(input: {
      sessionKey?: string;
      sessionName?: string;
      metadata?: Record<string, unknown>;
    }): ConnectorExecRouteResult {
      if (input.sessionKey) getOrCreateSession(input.sessionKey, "main", stateDir ?? "/tmp");
      const context = createRuntimeContext({
        kind: "turn-runtime",
        agentId: "main",
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        sessionName: input.sessionName ?? "ana-dm",
        metadata: { actorResolution: "resolved", executorAgentId: "main", ...(input.metadata ?? ANA_DM) },
      });
      return resolveConnectorExecRoute({
        ...OWNER,
        env: envFor(context),
        provider: "google",
        getAgentMode: () => "person_asking",
        getAgentDisplayName: () => "Main agent",
      });
    }

    function directChat(platformChatId: string, contactId: string) {
      const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "", platformChatId, chatType: "dm" });
      return dbCanonicalizeDmChatForContact({ chatId: chat.id, contactId, platformChatId });
    }

    it("uses the person's account in a direct-chat session of their own", () => {
      for (const sessionKey of [ANA_KEY, "agent:main:dm:5511888888888", "agent:main:whatsapp:dm:5511888888888"]) {
        expectRoute(askingRoute({ sessionKey }), "person_asking");
      }
    });

    it("refuses the session all direct chats share (dmScope main), a group key and an unknown session", () => {
      for (const sessionKey of ["agent:main:main", "agent:main:whatsapp:group:120363", "custom-session", undefined]) {
        const error = expectRefused(askingRoute({ sessionKey }), "CONNECTOR_GROUP_BLOCKED");
        expect(error.details?.chatLine).toBe("I can't use your Gmail in this conversation.");
      }
    });

    it("refuses a session a route sends chats into by name", () => {
      dbCreateRoute({ pattern: "*", accountId: "wa-main", agent: "main", session: "team-inbox" });

      expectRefused(askingRoute({ sessionKey: ANA_KEY, sessionName: "team-inbox" }), "CONNECTOR_GROUP_BLOCKED");
      expectRoute(askingRoute({ sessionKey: ANA_KEY, sessionName: "ana-dm" }), "person_asking");
    });

    it("refuses a session another person's chat is attached to", () => {
      getOrCreateSession(ANA_KEY, "main", stateDir ?? "/tmp");
      const anaChat = directChat(ANA_JID, "c_ana");
      dbCreateSessionChatSubscription({ sessionKey: ANA_KEY, chatId: anaChat.id, role: "primary" });

      // Her own chat, named by its canonical id or by the platform id.
      expectRoute(
        askingRoute({ sessionKey: ANA_KEY, metadata: { ...ANA_DM, agentIdentityCompartment: `dm:${anaChat.id}` } }),
        "person_asking",
      );
      expectRoute(askingRoute({ sessionKey: ANA_KEY }), "person_asking");

      const bobChat = directChat(BOB_JID, "c_bob");
      dbCreateSessionChatSubscription({ sessionKey: ANA_KEY, chatId: bobChat.id, role: "input" });
      expectRefused(askingRoute({ sessionKey: ANA_KEY }), "CONNECTOR_GROUP_BLOCKED");
    });

    it("refuses when the turn's contexts name different sessions", () => {
      getOrCreateSession(ANA_KEY, "main", stateDir ?? "/tmp");
      getOrCreateSession("agent:main:whatsapp:wa-main:dm:5511777777777", "main", stateDir ?? "/tmp");
      const parent = createRuntimeContext({
        kind: "turn-runtime",
        agentId: "main",
        sessionKey: ANA_KEY,
        sessionName: "ana-dm",
        metadata: { actorResolution: "resolved", executorAgentId: "main", ...ANA_DM },
      });
      const child = createRuntimeContext({
        kind: "cli-runtime",
        agentId: "main",
        sessionKey: "agent:main:whatsapp:wa-main:dm:5511777777777",
        sessionName: "bob-dm",
        metadata: { parentContextId: parent.contextId },
      });

      const error = expectRefused(
        resolveConnectorExecRoute({
          ...OWNER,
          env: envFor(child),
          provider: "google",
          getAgentMode: () => "person_asking",
        }),
        "CONNECTOR_GROUP_BLOCKED",
      );
      expect(error.message).toContain("shares its session with other people");
    });
  });

  describe("shared", () => {
    it("sends contacts in direct chats and in groups to the shared account with the real conversation", () => {
      expect(expectRoute(route(ANA_DM, "shared"), "shared")).toMatchObject({
        speaker: { kind: "contact", contactId: "c_ana" },
        conversation: "dm",
      });
      expect(expectRoute(route(NEW_DM, "shared"), "shared").conversation).toBe("dm");
      expect(expectRoute(route(ANA_GROUP, "shared"), "shared").conversation).toBe("group");
    });

    it("keeps the owner's routines on the owner's connection, and sends routines into someone else's chat", () => {
      expect(expectRoute(route(HEARTBEAT, "shared"), "owner")).toMatchObject({
        speaker: { kind: "automation" },
        conversation: "automation",
        routine: { kind: "heartbeat" },
      });
      const job = dbCreateCronJob({
        name: "inbox digest",
        schedule: { type: "every", every: 3_600_000 },
        message: "summarize my inbox",
        ownerPrincipal: "operator",
      });
      const cron = {
        actorPrincipal: `automation:cron:${job.id}`,
        agentIdentityCompartment: `automation:cron:${job.id}`,
      };
      expect(expectRoute(route(cron, "shared"), "owner").routine).toEqual({ kind: "cron", id: job.id });

      dbUpsertChat({ channel: "whatsapp", instanceId: "", platformChatId: "120363@g.us", chatType: "group" });
      const intoGroup = { actorPrincipal: "automation:heartbeat", agentIdentityCompartment: "chat:120363@g.us" };
      expect(expectRoute(route(intoGroup, "shared"), "shared").conversation).toBe("group");
      // --shared changes nothing there: it already uses the shared account.
      expect(expectRoute(route(intoGroup, "shared", { useShared: true }), "shared").conversation).toBe("group");
      expect(expectRoute(route(ANA_DM, "shared", { useShared: true }), "shared").conversation).toBe("dm");
    });

    it("keeps the owner's own turns on their own connection unless they pass --shared in a chat", () => {
      expectRoute(route(LUIS_DM, "shared"), "owner");
      expectRoute(route(null, "shared"), "owner");
      expectRoute(route(RELAY, "shared"), "owner");

      const shared = expectRoute(route(LUIS_DM, "shared", { useShared: true }), "shared");
      expect(shared.speaker).toEqual({ kind: "owner", contactId: "c_luis", consoleUserId: "user_luis" });
      expect(buildAgentExecContext(shared).speaker).toEqual({ kind: "owner", contactId: "c_luis" });
      expect(expectRoute(route(LUIS_GROUP, "shared", { useShared: true }), "shared").conversation).toBe("group");
    });

    it("refuses --shared where no grant can apply: the terminal, the operator's relay, a routine posting nowhere", () => {
      expect(expectRefused(route(null, "shared", { useShared: true }), "PAYLOAD_INVALID").message).toContain(
        "only in a chat",
      );
      for (const metadata of [RELAY, HEARTBEAT]) {
        const error = expectRefused(route(metadata, "shared", { useShared: true }), "PAYLOAD_INVALID");
        expect(error.message).toContain("works only in a chat");
        expect(error.message.length).toBeLessThanOrEqual(200);
      }
    });
  });

  it.each(["owner", "person_asking", "shared"] as const)(
    "in %s mode keeps agent relays, triggers and ended turns blocked",
    (mode) => {
      expectRefused(
        route({ actorPrincipal: "agent:helper", agentIdentityCompartment: "workspace:default" }, mode),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
      expectRefused(
        route({ actorPrincipal: "automation:trigger:tr_1", agentIdentityCompartment: "automation:trigger:tr_1" }, mode),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
      expectRefused(
        resolveConnectorExecRoute({
          ...OWNER,
          env: { RAVI_CONTEXT_KEY: "rctx_missing" },
          provider: "google",
          getAgentMode: () => mode,
        }),
        "CONNECTOR_SPEAKER_NOT_OWNER",
      );
    },
  );

  it("--shared on an agent without a shared account is a usage error, and never unblocks a contact", () => {
    const error = expectRefused(route(LUIS_DM, "owner", { useShared: true }), "PAYLOAD_INVALID");
    expect(error.message).toContain("ravi connectors mode main google shared --execute");
    expect(error.message.length).toBeLessThanOrEqual(200);

    const terminal = expectRefused(route(null, "shared", { useShared: true }), "PAYLOAD_INVALID");
    expect(terminal.message).toContain("only in a chat with an agent in shared mode");

    expectRefused(route(ANA_DM, "owner", { useShared: true }), "CONNECTOR_SPEAKER_NOT_OWNER");
    expectRefused(route(ANA_DM, "person_asking", { useShared: true }), "CONNECTOR_SPEAKER_NOT_OWNER");
    expectRefused(route(HEARTBEAT, "owner", { useShared: true }), "PAYLOAD_INVALID");
  });

  it("reads the stored mode of the executing agent, and an unknown value is owner", () => {
    // The isolated state already has the default agent `main`.
    const agentName = dbGetAgent("main")?.name;
    const context = turnContext(ANA_DM);
    const deps = { ...OWNER, env: envFor(context), provider: "google", isPrivateDirectSession: () => true };

    expectRefused(resolveConnectorExecRoute(deps), "CONNECTOR_SPEAKER_NOT_OWNER");

    writeAgentConnectorMode("main", "google", "person_asking");
    const turn = expectRoute(resolveConnectorExecRoute(deps), "person_asking");
    expect(turn.agentDisplayName).toBe(agentName);
    expect(readAgentConnectorMode("helper", "google")).toBe("owner");

    writeAgentConnectorMode("main", "google", "owner");
    expectRefused(resolveConnectorExecRoute(deps), "CONNECTOR_SPEAKER_NOT_OWNER");
    expect(readAgentConnectorMode("main", "google", () => "everyone")).toBe("owner");
    expect(
      readAgentConnectorMode("main", "google", () => {
        throw new Error("db closed");
      }),
    ).toBe("owner");
  });

  describe("who may change a mode", () => {
    function operator(metadata: Record<string, unknown> | null) {
      return resolveOperatorTurn({
        ...OWNER,
        env: metadata ? envFor(turnContext(metadata)) : {},
        action: "change how this agent uses connected accounts",
      });
    }

    it("is the terminal and the owner's own direct chat", () => {
      expect(operator(null).ok).toBe(true);
      expect(operator(LUIS_DM).ok).toBe(true);
    });

    it("sends the owner who asks in a group to their own chat", () => {
      const result = operator(LUIS_GROUP);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONNECTOR_GROUP_BLOCKED");
      expect(result.error.exitCode).toBe(3);
      expect(result.error.details).toMatchObject({
        chatLine: "Ask me in our private chat and I'll change it.",
        chatLinePt: "Me peça no nosso chat privado que eu mudo.",
        replyTo: "same_chat",
      });
    });

    it("is never a contact or a routine", () => {
      for (const metadata of [ANA_DM, NEW_DM, HEARTBEAT, ANA_GROUP]) {
        const result = operator(metadata);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.code).toBe("CONNECTOR_SPEAKER_NOT_OWNER");
        expect(result.error.exitCode).toBe(3);
        expect(result.error.details).toMatchObject({
          chatLine: "Only Luis can change that.",
          chatLinePt: "Só Luis pode mudar isso.",
          replyTo: "same_chat",
        });
      }
    });
  });

  describe("agent exec header", () => {
    it("carries the agent and the contact id, never a Console user id", () => {
      const header = encodeExecContextHeader(
        buildAgentExecContext({
          actorPrincipal: "contact:c_ana",
          speaker: { kind: "contact", contactId: "c_ana", consoleUserId: "user_ana" },
          conversation: "dm",
          agentId: "main",
          agentDisplayName: "Main agent",
          sessionName: "main-session",
          turnKey: sha256("ctx_1"),
        }),
        { keepAgentId: true },
      );

      const decoded = decodeExecContextHeader(header);
      expect(decoded).toEqual({
        v: 1,
        agentId: "main",
        sessionName: "main-session",
        speaker: { kind: "contact", contactId: "c_ana" },
        conversation: "dm",
        turnKey: sha256("ctx_1"),
        agentDisplayName: "Main agent",
      });
      expect(JSON.stringify(decoded)).not.toContain("consoleUserId");
    });

    it("never drops the agent id: a header still too large fails closed", () => {
      const header = encodeExecContextHeader(
        buildAgentExecContext({
          actorPrincipal: "contact:c_ana",
          speaker: { kind: "contact", contactId: "c_ana" },
          conversation: "dm",
          agentId: "main",
          agentDisplayName: "Main agent",
          sessionName: "s".repeat(3000),
        }),
        { keepAgentId: true },
      );
      expect(decodeExecContextHeader(header)).toEqual({
        v: 1,
        agentId: "main",
        speaker: { kind: "contact", contactId: "c_ana" },
        conversation: "dm",
      });

      expect(() =>
        encodeExecContextHeader(
          buildAgentExecContext({
            actorPrincipal: "contact:c_ana",
            speaker: { kind: "contact", contactId: "c_ana" },
            conversation: "dm",
            agentId: "a".repeat(3000),
          }),
          { keepAgentId: true },
        ),
      ).toThrow("too large");
    });
  });
});
