import "reflect-metadata";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";

import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { ContextRecord } from "../../router/router-db.js";
import { enforceCliCommandAuthorization } from "../command-access.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata, type CommandAccessOptions } from "../decorators.js";
import { ArtifactsCommands } from "./artifacts.js";
import { ChannelsCommands } from "./channels.js";
import { ContactsCommands } from "./contacts.js";
import { ContextCommands } from "./context.js";
import { CrmFactCommands, CrmOpportunityCommands, CrmTaskCommands } from "./crm.js";
import { DaemonCommands } from "./daemon.js";
import { DevinSessionCommands } from "./devin.js";
import { GroupCommands } from "./group.js";
import { HooksCommands } from "./hooks.js";
import { ImageAtlasCommands } from "./image.js";
import { InboxCommands } from "./inbox.js";
import { InstancesCommands } from "./instances.js";
import { MetricsCommands } from "./metrics.js";
import { PagesCommands } from "./pages.js";
import { ProxCallsCommands } from "./prox-calls.js";
import { SessionFollowupCommands } from "./session-followups.js";
import { SessionRuntimeCommands } from "./sessions-runtime.js";
import { SessionCommands } from "./sessions.js";
import { SpecsCommands } from "./specs.js";
import { ThreadCommands } from "./threads.js";
import { TranscribeCommands } from "./transcribe.js";
import { TriggersCommands } from "./triggers.js";
import { VideoCommands } from "./video.js";
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
    label: "contacts note",
    group: "contacts",
    command: "note",
    target: ContactsCommands,
    method: "note",
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
