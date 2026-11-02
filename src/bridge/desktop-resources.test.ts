import { desktopSessionRead, desktopSessionConfigure } from "./desktop-session.js";
import { desktopWork } from "./desktop-work.js";
import { configStore } from "../config-store.js";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BridgeStore } from "./store.js";
import { BridgeService } from "./service.js";
import { withConsoleInvocation, type ConsoleInvocation } from "../sdk/gateway/console-context.js";
import { CONSOLE_PROTOCOL } from "../sdk/gateway/console-contract.js";
import { dbCreateAgent, dbUpsertChannel } from "../router/router-db.js";
import { dbCreateCronJob, dbGetCronJob } from "../cron/cron-db.js";
import {
  desktopLoops,
  desktopSetLoop,
  desktopChannels,
  desktopSetChannel,
  desktopComputer,
} from "./desktop-resources.js";
const notifications: string[] = [];
const notify = async (topic: string) => {
  notifications.push(topic);
};
function fixture(resource: string, action: string, kind: "read" | "mutate" = "read"): ConsoleInvocation {
  const store = new BridgeStore(":memory:"),
    enrollment = {
      id: randomUUID(),
      orgId: randomUUID(),
      installationId: randomUUID(),
      runtimeId: randomUUID(),
      issuer: "https://fixture.test",
      issuerPublicKey: "unused",
      issuerKeyId: "unused",
      epoch: 1,
      active: true,
    };
  store.putEnrollment(enrollment);
  const grant = {
    protocol: CONSOLE_PROTOCOL,
    orgId: enrollment.orgId,
    installationId: enrollment.installationId,
    enrollmentId: enrollment.id,
    epoch: 1,
    projectId: randomUUID(),
    connectionId: randomUUID(),
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    origin: { kind: "browser" as const, sessionId: "fixture" },
    operationId: randomUUID(),
    createdAt: Date.now(),
    requestDigest: "a".repeat(64),
    command: `${resource}.${action}`,
    access: { kind, resource, action },
    scope: { kind: "installation" as const },
    agents: [{ id: "desktop-fixture", capabilities: [], approvalCapabilities: [] }],
    canSend: true,
    canApprove: false,
    sub: randomUUID(),
    iss: enrollment.issuer,
    jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 30,
  };
  const service = new BridgeService(store, enrollment.runtimeId, "fixture", {
    agents: () => [],
    start: async () => {},
    cancel: () => false,
  });
  service.acceptDelegation(grant);
  return { grant, enrollment, service };
}
test("routine projection excludes other agents and secrets; mutations require the exact command and preserve native owner rules", async () => {
  dbCreateAgent({ id: "desktop-fixture", cwd: "/tmp" });
  dbCreateAgent({ id: "desktop-foreign", cwd: "/tmp" });
  const own = dbCreateCronJob({
    agentId: "desktop-fixture",
    name: "owned",
    enabled: false,
    message: "PRIVATE PROMPT",
    schedule: { type: "every", every: 86_400_000 },
  });
  dbCreateCronJob({
    agentId: "desktop-foreign",
    name: "foreign",
    enabled: false,
    message: "FOREIGN PROMPT",
    schedule: { type: "every", every: 86_400_000 },
  });
  const invalid = dbCreateCronJob({
    agentId: "desktop-fixture",
    name: "invalid shell owner",
    enabled: false,
    message: "",
    executionType: "shell",
    shellCommand: "PRIVATE SHELL",
    ownerPrincipal: "human:fixture",
    schedule: { type: "every", every: 86_400_000 },
  });
  const reader = fixture("desktop.loops", "list");
  const list = withConsoleInvocation(reader, () => desktopLoops());
  expect(list.some((row) => row.name === "owned")).toBe(true);
  expect(list.some((row) => row.name === "foreign")).toBe(false);
  expect(JSON.stringify(list)).not.toContain("PRIVATE");
  await expect(withConsoleInvocation(reader, () => desktopSetLoop(`cron:${own.id}`, true, notify))).rejects.toThrow(
    "CONSOLE_AUTHORITY_REQUIRED",
  );
  const writer = fixture("desktop.loops", "set-enabled", "mutate");
  await withConsoleInvocation(writer, () => desktopSetLoop(`cron:${own.id}`, true, notify));
  expect(dbGetCronJob(own.id)?.enabled).toBe(true);
  await withConsoleInvocation(writer, () => desktopSetLoop(`cron:${own.id}`, false, notify));
  expect(dbGetCronJob(own.id)?.enabled).toBe(false);
  await expect(withConsoleInvocation(writer, () => desktopSetLoop(`cron:${invalid.id}`, true, notify))).rejects.toThrow(
    "CRON_SHELL_NOT_OPERATOR",
  );
  expect(notifications).toContain("ravi.cron.refresh");
  reader.service.store.close();
  writer.service.store.close();
});
test("configured channels never expose credential references or claim an unobserved connection", async () => {
  dbUpsertChannel({ name: "desktop-channel", provider: "slack", enabled: false, credentialConnection: "SECRET REF" });
  const reader = fixture("desktop.channels", "list"),
    writer = fixture("desktop.channels", "set-enabled", "mutate");
  const list = await withConsoleInvocation(reader, () => desktopChannels(async () => []));
  expect(JSON.stringify(list)).not.toContain("SECRET");
  expect(list.find((row) => row.id === "desktop-channel")?.status).toBe("disabled");
  const changed = await withConsoleInvocation(writer, () => desktopSetChannel("desktop-channel", true, notify));
  expect(changed.find((row) => row.id === "desktop-channel")?.status).toBe("unknown");
  await withConsoleInvocation(writer, () => desktopSetChannel("desktop-channel", false, notify));
  reader.service.store.close();
  writer.service.store.close();
});
test("computer telemetry refuses an installation-wide grant without conversation authority", async () => {
  const reader = fixture("desktop.computer", "read");
  await expect(withConsoleInvocation(reader, () => desktopComputer(randomUUID()))).rejects.toThrow(
    "NOT_FOUND_OR_DENIED",
  );
  reader.service.store.close();
});

test("conversation configuration and work remain subject-bound and cannot use read authority for a write", () => {
  dbCreateAgent({ id: "desktop-config", cwd: "/tmp", provider: "codex", model: "fixture-model" });
  configStore.refresh();
  const reader = fixture("desktop.session", "read"),
    id = randomUUID(),
    store = reader.service.store;
  reader.grant.agents = [{ id: "desktop-config", capabilities: [], approvalCapabilities: [] }];
  reader.grant.scope = { kind: "session", conversationId: id };
  store.db
    .query("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(
      id,
      reader.enrollment.id,
      reader.grant.sub,
      reader.grant.projectId,
      "desktop-config",
      `console-${id}`,
      `agent:desktop-config:console:${id}`,
      "Own fixture",
      0,
      Date.now(),
    );
  const before = withConsoleInvocation(reader, () => desktopSessionRead(id));
  expect(before.model).toBe("fixture-model");
  expect(() => withConsoleInvocation(reader, () => desktopSessionConfigure(id, "fixture-model", "low"))).toThrow(
    "CONSOLE_AUTHORITY_REQUIRED",
  );
  reader.grant.command = "desktop.session.configure";
  reader.grant.access = { kind: "mutate", resource: "desktop.session", action: "configure" };
  expect(withConsoleInvocation(reader, () => desktopSessionConfigure(id, "fixture-model", "low"))).toMatchObject({
    model: "fixture-model",
    effort: "low",
  });
  expect(() => withConsoleInvocation(reader, () => desktopSessionConfigure(id, "unadvertised", "high"))).toThrow(
    "MODEL_NOT_AVAILABLE",
  );
  reader.grant.command = "desktop.work.list";
  reader.grant.access = { kind: "read", resource: "desktop.work", action: "list" };
  expect(withConsoleInvocation(reader, () => desktopWork(id))).toEqual([]);
  const messageId = randomUUID(),
    turnId = randomUUID();
  store.db
    .query("INSERT INTO messages VALUES (?,?,?,?,?,?)")
    .run(messageId, id, "user", "Review the report", turnId, Date.now());
  store.db.query("INSERT INTO turn_targets VALUES (?,?,?)").run(turnId, "desktop-config", messageId);
  store.db
    .query("INSERT INTO turns (id,conversation_id,status,lease_until,authority,created_at) VALUES (?,?,?,?,?,?)")
    .run(turnId, id, "running", Date.now() + 30000, "{}", Date.now());
  for (const [status, state] of [
    ["running", "working"],
    ["queued", "working"],
    ["awaiting_approval", "needs_you"],
    ["completed", "done"],
    ["cancelled", "done"],
    ["failed", "done"],
    ["authorization_expired", "done"],
    ["interrupted_unknown", "done"],
  ]) {
    store.db.query("UPDATE turns SET status=? WHERE id=?").run(status!, turnId);
    const [work] = withConsoleInvocation(reader, () => desktopWork(id));
    expect(work).toMatchObject({ id: turnId, state, statusLabel: status!.replaceAll("_", " ") });
    if (status === "interrupted_unknown") expect(work!.summary).toContain("Outcome unconfirmed");
  }
  reader.grant.sub = randomUUID();
  reader.service.acceptDelegation(reader.grant);
  expect(() => withConsoleInvocation(reader, () => desktopWork(id))).toThrow("NOT_FOUND_OR_DENIED");
  store.close();
});
