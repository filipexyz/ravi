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
import { InboxCommands } from "./inbox.js";
import { MetricsCommands } from "./metrics.js";
import { SessionFollowupCommands } from "./session-followups.js";
import { SpecsCommands } from "./specs.js";
import { ThreadCommands } from "./threads.js";

setDefaultTimeout(90_000);

interface AccessCase {
  label: string;
  group: string;
  command: string;
  target: Function;
  method: string;
}

const ACCESS_CASES: AccessCase[] = [
  {
    label: "artifacts snapshot",
    group: "artifacts",
    command: "snapshot",
    target: ArtifactsCommands,
    method: "snapshot",
  },
  {
    label: "artifacts event",
    group: "artifacts",
    command: "event",
    target: ArtifactsCommands,
    method: "event",
  },
  { label: "inbox snooze", group: "inbox", command: "snooze", target: InboxCommands, method: "snooze" },
  {
    label: "sessions followups snooze",
    group: "sessions_followups",
    command: "snooze",
    target: SessionFollowupCommands,
    method: "snooze",
  },
  { label: "threads note", group: "threads", command: "note", target: ThreadCommands, method: "note" },
  { label: "threads close", group: "threads", command: "close", target: ThreadCommands, method: "close" },
  { label: "specs new", group: "specs", command: "new", target: SpecsCommands, method: "new" },
  { label: "metrics rollup", group: "metrics", command: "rollup", target: MetricsCommands, method: "rollup" },
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
      expect(access).toMatchObject({ kind: "mutate", risk: "medium" });
      if (!access) throw new Error(`Missing command access metadata for ${testCase.label}`);

      const effectFile = join(stateDir!, `${testCase.label.replaceAll(" ", "-")}.effect`);
      let handlerCalls = 0;
      const runEffect = () => {
        handlerCalls += 1;
        effectsDb!.run("INSERT INTO effects (operation) VALUES (?)", testCase.label);
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
