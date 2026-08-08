import "reflect-metadata";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";

import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { CLI_READ_TO_MUTATE_MIGRATIONS } from "../../permissions/command-access-kind-migration.js";
import type { ContextRecord } from "../../router/router-db.js";
import {
  buildCliCommandOperation,
  enforceCliCommandAuthorization,
  redactCommandAccessInput,
} from "../command-access.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata, type CommandAccessOptions } from "../decorators.js";
import { AgentsCommands } from "./agents.js";
import { ArtifactsCommands } from "./artifacts.js";
import { ChannelsCommands } from "./channels.js";
import { ChatReadingListCommands } from "./chats.js";
import { ContactsCommands } from "./contacts.js";
import { ContextCommands } from "./context.js";
import { CostCommands } from "./costs.js";
import { CrmFactCommands, CrmOpportunityCommands, CrmTaskCommands } from "./crm.js";
import { DaemonCommands } from "./daemon.js";
import { DbCommands } from "./db.js";
import { DevinSessionCommands } from "./devin.js";
import { GroupCommands } from "./group.js";
import { HooksCommands } from "./hooks.js";
import { ImageAtlasCommands } from "./image.js";
import { InboxCommands } from "./inbox.js";
import { InstancesCommands } from "./instances.js";
import { MetricsCommands } from "./metrics.js";
import { PagesCommands } from "./pages.js";
import {
  ProxCallsCommands,
  ProxCallsProfileCommands,
  ProxCallsToolCommands,
  ProxCallsVoiceAgentCommands,
} from "./prox-calls.js";
import { RuntimeCredentialsCommands } from "./runtime-credentials.js";
import { SdkOpenApiCommands } from "./sdk.js";
import { SessionFollowupCommands } from "./session-followups.js";
import { SessionRuntimeCommands } from "./sessions-runtime.js";
import { SessionCommands } from "./sessions.js";
import { SpecsCommands } from "./specs.js";
import { TagRulesCommands } from "./tag-rules.js";
import { ThreadCommands } from "./threads.js";
import { TranscribeCommands } from "./transcribe.js";
import { TriggersCommands } from "./triggers.js";
import { VideoCommands } from "./video.js";
import { WhatsAppDmCommands } from "./whatsapp-dm.js";
import { WorkObjectCommands } from "./work-objects.js";
import { WorkflowRunCommands } from "./workflows.js";

setDefaultTimeout(90_000);

interface AccessCase {
  label: string;
  group: string;
  command: string;
  target: Function;
  method: string;
  risk: CommandAccessOptions["risk"];
}

const ACCESS_CASES: AccessCase[] = [
  {
    label: "agents debounce",
    group: "agents",
    command: "debounce",
    target: AgentsCommands,
    method: "debounce",
    risk: "low",
  },
  {
    label: "agents spec-mode",
    group: "agents",
    command: "spec-mode",
    target: AgentsCommands,
    method: "specMode",
    risk: "low",
  },
  {
    label: "artifacts snapshot",
    group: "artifacts",
    command: "snapshot",
    target: ArtifactsCommands,
    method: "snapshot",
    risk: "medium",
  },
  {
    label: "artifacts event",
    group: "artifacts",
    command: "event",
    target: ArtifactsCommands,
    method: "event",
    risk: "medium",
  },
  {
    label: "channels probe",
    group: "channels",
    command: "probe",
    target: ChannelsCommands,
    method: "probe",
    risk: "high",
  },
  {
    label: "chats lists delta",
    group: "chats.lists",
    command: "delta",
    target: ChatReadingListCommands,
    method: "delta",
    risk: "low",
  },
  {
    label: "contacts note",
    group: "contacts",
    command: "note",
    target: ContactsCommands,
    method: "note",
    risk: "medium",
  },
  {
    label: "costs pricing",
    group: "costs",
    command: "pricing",
    target: CostCommands,
    method: "pricing",
    risk: "medium",
  },
  {
    label: "context authorize",
    group: "context",
    command: "authorize",
    target: ContextCommands,
    method: "authorize",
    risk: "high",
  },
  {
    label: "context issue",
    group: "context",
    command: "issue",
    target: ContextCommands,
    method: "issue",
    risk: "high",
  },
  {
    label: "crm opportunity move",
    group: "crm.opportunity",
    command: "move",
    target: CrmOpportunityCommands,
    method: "move",
    risk: "medium",
  },
  {
    label: "crm fact propose",
    group: "crm.fact",
    command: "propose",
    target: CrmFactCommands,
    method: "propose",
    risk: "medium",
  },
  {
    label: "crm fact confirm",
    group: "crm.fact",
    command: "confirm",
    target: CrmFactCommands,
    method: "confirm",
    risk: "medium",
  },
  {
    label: "crm task snooze",
    group: "crm.task",
    command: "snooze",
    target: CrmTaskCommands,
    method: "snooze",
    risk: "medium",
  },
  {
    label: "daemon uninstall",
    group: "daemon",
    command: "uninstall",
    target: DaemonCommands,
    method: "uninstall",
    risk: "destructive",
  },
  {
    label: "daemon env",
    group: "daemon",
    command: "env",
    target: DaemonCommands,
    method: "env",
    risk: "medium",
  },
  {
    label: "daemon logs",
    group: "daemon",
    command: "logs",
    target: DaemonCommands,
    method: "logs",
    risk: "destructive",
  },
  {
    label: "db locks",
    group: "db",
    command: "locks",
    target: DbCommands,
    method: "locks",
    risk: "medium",
  },
  {
    label: "devin sessions list",
    group: "devin.sessions",
    command: "list",
    target: DevinSessionCommands,
    method: "list",
    risk: "low",
  },
  {
    label: "devin sessions show",
    group: "devin.sessions",
    command: "show",
    target: DevinSessionCommands,
    method: "show",
    risk: "low",
  },
  {
    label: "devin sessions messages",
    group: "devin.sessions",
    command: "messages",
    target: DevinSessionCommands,
    method: "messages",
    risk: "low",
  },
  {
    label: "devin sessions attachments",
    group: "devin.sessions",
    command: "attachments",
    target: DevinSessionCommands,
    method: "attachments",
    risk: "low",
  },
  {
    label: "devin sessions insights",
    group: "devin.sessions",
    command: "insights",
    target: DevinSessionCommands,
    method: "insights",
    risk: "high",
  },
  {
    label: "devin sessions terminate",
    group: "devin.sessions",
    command: "terminate",
    target: DevinSessionCommands,
    method: "terminate",
    risk: "high",
  },
  {
    label: "hooks test",
    group: "hooks",
    command: "test",
    target: HooksCommands,
    method: "test",
    risk: "high",
  },
  {
    label: "image atlas split",
    group: "image.atlas",
    command: "split",
    target: ImageAtlasCommands,
    method: "split",
    risk: "medium",
  },
  {
    label: "inbox snooze",
    group: "inbox",
    command: "snooze",
    target: InboxCommands,
    method: "snooze",
    risk: "medium",
  },
  {
    label: "instances disconnect",
    group: "instances",
    command: "disconnect",
    target: InstancesCommands,
    method: "disconnect",
    risk: "medium",
  },
  {
    label: "pages visibility",
    group: "pages",
    command: "visibility",
    target: PagesCommands,
    method: "visibility",
    risk: "medium",
  },
  {
    label: "pages domains",
    group: "pages",
    command: "domains",
    target: PagesCommands,
    method: "domains",
    risk: "medium",
  },
  {
    label: "prox calls request",
    group: "prox.calls",
    command: "request",
    target: ProxCallsCommands,
    method: "request",
    risk: "high",
  },
  {
    label: "prox calls transcript",
    group: "prox.calls",
    command: "transcript",
    target: ProxCallsCommands,
    method: "transcript",
    risk: "low",
  },
  {
    label: "prox calls profiles configure",
    group: "prox.calls.profiles",
    command: "configure",
    target: ProxCallsProfileCommands,
    method: "configure",
    risk: "high",
  },
  {
    label: "prox calls voice-agents configure",
    group: "prox.calls.voice-agents",
    command: "configure",
    target: ProxCallsVoiceAgentCommands,
    method: "configure",
    risk: "medium",
  },
  {
    label: "prox calls voice-agents bind-tool",
    group: "prox.calls.voice-agents",
    command: "bind-tool",
    target: ProxCallsVoiceAgentCommands,
    method: "bindTool",
    risk: "medium",
  },
  {
    label: "prox calls voice-agents unbind-tool",
    group: "prox.calls.voice-agents",
    command: "unbind-tool",
    target: ProxCallsVoiceAgentCommands,
    method: "unbindTool",
    risk: "medium",
  },
  {
    label: "prox calls tools configure",
    group: "prox.calls.tools",
    command: "configure",
    target: ProxCallsToolCommands,
    method: "configure",
    risk: "medium",
  },
  {
    label: "prox calls tools bind",
    group: "prox.calls.tools",
    command: "bind",
    target: ProxCallsToolCommands,
    method: "bind",
    risk: "medium",
  },
  {
    label: "prox calls tools unbind",
    group: "prox.calls.tools",
    command: "unbind",
    target: ProxCallsToolCommands,
    method: "unbind",
    risk: "medium",
  },
  {
    label: "runtime credentials classify",
    group: "runtime.credentials",
    command: "classify",
    target: RuntimeCredentialsCommands,
    method: "classify",
    risk: "medium",
  },
  {
    label: "sdk openapi emit",
    group: "sdk.openapi",
    command: "emit",
    target: SdkOpenApiCommands,
    method: "emit",
    risk: "low",
  },
  {
    label: "sessions goal",
    group: "sessions",
    command: "goal",
    target: SessionCommands,
    method: "goal",
    risk: "medium",
  },
  {
    label: "sessions extend",
    group: "sessions",
    command: "extend",
    target: SessionCommands,
    method: "extend",
    risk: "medium",
  },
  {
    label: "sessions keep",
    group: "sessions",
    command: "keep",
    target: SessionCommands,
    method: "keep",
    risk: "medium",
  },
  {
    label: "sessions ask",
    group: "sessions",
    command: "ask",
    target: SessionCommands,
    method: "ask",
    risk: "high",
  },
  {
    label: "sessions answer",
    group: "sessions",
    command: "answer",
    target: SessionCommands,
    method: "answer",
    risk: "high",
  },
  {
    label: "sessions inform",
    group: "sessions",
    command: "inform",
    target: SessionCommands,
    method: "inform",
    risk: "high",
  },
  {
    label: "sessions followups snooze",
    group: "sessions_followups",
    command: "snooze",
    target: SessionFollowupCommands,
    method: "snooze",
    risk: "medium",
  },
  {
    label: "sessions runtime steer",
    group: "sessions.runtime",
    command: "steer",
    target: SessionRuntimeCommands,
    method: "steer",
    risk: "high",
  },
  {
    label: "sessions runtime follow-up",
    group: "sessions.runtime",
    command: "follow-up",
    target: SessionRuntimeCommands,
    method: "followUp",
    risk: "high",
  },
  {
    label: "sessions runtime interrupt",
    group: "sessions.runtime",
    command: "interrupt",
    target: SessionRuntimeCommands,
    method: "interrupt",
    risk: "high",
  },
  {
    label: "sessions runtime rollback",
    group: "sessions.runtime",
    command: "rollback",
    target: SessionRuntimeCommands,
    method: "rollback",
    risk: "destructive",
  },
  {
    label: "sessions runtime fork",
    group: "sessions.runtime",
    command: "fork",
    target: SessionRuntimeCommands,
    method: "fork",
    risk: "high",
  },
  {
    label: "threads note",
    group: "threads",
    command: "note",
    target: ThreadCommands,
    method: "note",
    risk: "medium",
  },
  {
    label: "threads close",
    group: "threads",
    command: "close",
    target: ThreadCommands,
    method: "close",
    risk: "medium",
  },
  {
    label: "transcribe file",
    group: "transcribe",
    command: "file",
    target: TranscribeCommands,
    method: "file",
    risk: "high",
  },
  {
    label: "specs new",
    group: "specs",
    command: "new",
    target: SpecsCommands,
    method: "new",
    risk: "medium",
  },
  {
    label: "tag-rules tick",
    group: "tag-rules",
    command: "tick",
    target: TagRulesCommands,
    method: "tick",
    risk: "high",
  },
  {
    label: "tag-rules evaluate",
    group: "tag-rules",
    command: "evaluate",
    target: TagRulesCommands,
    method: "evaluate",
    risk: "medium",
  },
  {
    label: "metrics rollup",
    group: "metrics",
    command: "rollup",
    target: MetricsCommands,
    method: "rollup",
    risk: "medium",
  },
  {
    label: "triggers test",
    group: "triggers",
    command: "test",
    target: TriggersCommands,
    method: "test",
    risk: "high",
  },
  {
    label: "video analyze",
    group: "video",
    command: "analyze",
    target: VideoCommands,
    method: "analyze",
    risk: "high",
  },
  {
    label: "whatsapp group join",
    group: "whatsapp.group",
    command: "join",
    target: GroupCommands,
    method: "join",
    risk: "high",
  },
  {
    label: "whatsapp dm read",
    group: "whatsapp.dm",
    command: "read",
    target: WhatsAppDmCommands,
    method: "read",
    risk: "medium",
  },
  {
    label: "whatsapp group leave",
    group: "whatsapp.group",
    command: "leave",
    target: GroupCommands,
    method: "leave",
    risk: "destructive",
  },
  {
    label: "whatsapp group description",
    group: "whatsapp.group",
    command: "description",
    target: GroupCommands,
    method: "description",
    risk: "high",
  },
  {
    label: "whatsapp group settings",
    group: "whatsapp.group",
    command: "settings",
    target: GroupCommands,
    method: "settings",
    risk: "high",
  },
  {
    label: "workflows release",
    group: "workflows.runs",
    command: "release",
    target: WorkflowRunCommands,
    method: "release",
    risk: "medium",
  },
  {
    label: "workflows skip",
    group: "workflows.runs",
    command: "skip",
    target: WorkflowRunCommands,
    method: "skip",
    risk: "medium",
  },
];

let stateDir: string | null = null;
let effectsDb: Database | null = null;
let previousSuppressAuditEvents: string | undefined;

function contextFor(access: CommandAccessOptions, permission: "read" | "mutate"): ContextRecord {
  return {
    contextId: `ctx_access_kind_${permission}`,
    contextKey: `rctx_access_kind_${permission}`,
    kind: "test-runtime",
    agentId: "access-kind-test",
    capabilities: [{ permission, objectType: access.resource, objectId: access.action, source: "test" }],
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
}

function authorize(testCase: AccessCase, access: CommandAccessOptions, permission: "read" | "mutate") {
  const context = contextFor(access, permission);
  return runWithContext({ agentId: context.agentId, context }, () =>
    enforceCliCommandAuthorization({
      group: testCase.group,
      command: testCase.command,
      access,
      source: "gateway",
      scope: "open",
    }),
  );
}

describe("corrected mutating command access", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-command-access-kind-");
    effectsDb = new Database(join(stateDir, "effects.sqlite"), { create: true });
    effectsDb.run("CREATE TABLE effects (operation TEXT PRIMARY KEY)");
    previousSuppressAuditEvents = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  });

  afterEach(async () => {
    effectsDb?.close();
    effectsDb = null;
    if (previousSuppressAuditEvents === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAuditEvents;
    previousSuppressAuditEvents = undefined;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("keeps the compatibility migration inventory aligned with the authorization gate", () => {
    const expected = ACCESS_CASES.map((testCase) => {
      const access = getCommandAccessMetadata(testCase.target).get(testCase.method);
      if (!access) throw new Error(`Missing command access metadata for ${testCase.label}`);
      return `${access.resource}:${access.action}`;
    }).sort();
    const migrated = CLI_READ_TO_MUTATE_MIGRATIONS.map(({ resource, action }) => `${resource}:${action}`).sort();

    expect(migrated).toEqual(expected);
  });

  it("declares redaction for WhatsApp content and private identifiers in audit input", () => {
    const dmAccess = getCommandAccessMetadata(WhatsAppDmCommands);
    const dmSend = dmAccess.get("send");
    const dmRead = dmAccess.get("read");
    const dmAck = dmAccess.get("ack");
    expect(dmSend?.redactions).toEqual(expect.arrayContaining(["contact", "message"]));
    expect(dmRead?.redactions).toEqual(expect.arrayContaining(["contact"]));
    expect(dmAck?.redactions).toEqual(expect.arrayContaining(["contact", "messageId"]));

    const groupAccess = getCommandAccessMetadata(GroupCommands);
    const groupSend = groupAccess.get("send");
    const groupDescription = groupAccess.get("description");
    expect(groupSend?.redactions).toEqual(expect.arrayContaining(["groupId", "message", "mention"]));
    expect(groupDescription?.redactions).toEqual(expect.arrayContaining(["groupId", "text"]));

    const sensitiveAuditInputs: Array<{
      access: CommandAccessOptions | undefined;
      input: Record<string, string>;
    }> = [
      {
        access: dmSend,
        input: { contact: "SENTINEL_PRIVATE_PHONE", message: "SENTINEL_PRIVATE_DM_MESSAGE" },
      },
      { access: dmRead, input: { contact: "SENTINEL_PRIVATE_DM_JID" } },
      {
        access: dmAck,
        input: { contact: "SENTINEL_PRIVATE_ACK_JID", messageId: "SENTINEL_PRIVATE_MESSAGE_ID" },
      },
      {
        access: groupSend,
        input: {
          groupId: "SENTINEL_PRIVATE_GROUP_JID",
          message: "SENTINEL_PRIVATE_GROUP_MESSAGE",
          mention: "SENTINEL_PRIVATE_MENTION_PHONE",
        },
      },
      {
        access: groupDescription,
        input: { groupId: "SENTINEL_PRIVATE_DESCRIPTION_JID", text: "SENTINEL_PRIVATE_DESCRIPTION" },
      },
    ];

    for (const { access, input } of sensitiveAuditInputs) {
      const auditInput = redactCommandAccessInput(access, input);
      expect(Object.values(auditInput)).toEqual(Object.keys(input).map(() => "[REDACTED]"));
      expect(JSON.stringify(auditInput)).not.toContain("SENTINEL_PRIVATE");
    }
  });

  it("keeps arbitrary Work Object patches out of authorization and audit boundaries", () => {
    const updateAccess = getCommandAccessMetadata(WorkObjectCommands).get("update");
    expect(updateAccess?.redactions).toContain("values");
    if (!updateAccess) throw new Error("Missing command access metadata for work-objects update");

    const values = JSON.stringify({
      nested: { prompt: "PRIVATE_PROMPT_7YQ4" },
      apiKey: "sk-abcdefghijklmnop",
    });
    const input = { type: "task", id: "task-1", values };
    const operation = buildCliCommandOperation({
      group: "work-objects",
      command: "update",
      access: updateAccess,
      input,
      source: "tool",
    });
    const auditInput = redactCommandAccessInput(updateAccess, input);

    expect(operation.input).toEqual({ type: "task", id: "task-1", values: "[REDACTED]" });
    expect(auditInput).toEqual({ type: "task", id: "task-1", values: "[REDACTED]" });
    expect(JSON.stringify({ operation, auditInput })).not.toContain("PRIVATE_PROMPT_7YQ4");
    expect(JSON.stringify({ operation, auditInput })).not.toContain("sk-abcdefghijklmnop");
  });

  it("denies read capabilities before DB/FS effects and allows mutate capabilities", () => {
    for (const testCase of ACCESS_CASES) {
      const access = getCommandAccessMetadata(testCase.target).get(testCase.method);
      expect(access).toMatchObject({ kind: "mutate", risk: testCase.risk });
      if (!access) throw new Error(`Missing command access metadata for ${testCase.label}`);

      const effectFile = join(stateDir!, `${testCase.label.replaceAll(" ", "-")}.effect`);
      let handlerCalls = 0;
      const runEffect = () => {
        handlerCalls += 1;
        effectsDb!.run("INSERT INTO effects (operation) VALUES (?)", [testCase.label]);
        writeFileSync(effectFile, testCase.label, "utf8");
      };

      const denied = authorize(testCase, access, "read");
      if (denied.allowed) runEffect();

      expect(denied.allowed).toBe(false);
      expect(handlerCalls).toBe(0);
      expect(effectsDb!.query("SELECT operation FROM effects WHERE operation = ?").get(testCase.label)).toBeNull();
      expect(existsSync(effectFile)).toBe(false);

      const allowed = authorize(testCase, access, "mutate");
      if (allowed.allowed) runEffect();

      expect(allowed.allowed).toBe(true);
      expect(allowed.decision).toMatchObject({
        permission: "mutate",
        objectType: access.resource,
        objectId: access.action,
      });
      expect(handlerCalls).toBe(1);
      expect(effectsDb!.query("SELECT operation FROM effects WHERE operation = ?").get(testCase.label)).toEqual({
        operation: testCase.label,
      });
      expect(existsSync(effectFile)).toBe(true);
    }
  });
});
