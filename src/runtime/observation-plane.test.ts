import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbUpsertSessionParticipant, getDb } from "../router/router-db.js";
import { getOrCreateSession } from "../router/index.js";
import { dbCreateTagDefinition, dbUpsertTagBinding } from "../tags/index.js";
import {
  createObservationEvent,
  dbGetObserverRule,
  dbListObserverBindings,
  dbUpsertObserverRule,
  deliverObservationEvents,
  ensureObserverBindingsForSession,
  explainObserverRulesForSession,
  getObservationDebounceMs,
  migrateObservationCommandAccessGrants,
  reconcileObserverBindingsForSession,
  setObservationPromptPublisherForTests,
  validateObserverRules,
} from "./observation-plane.js";
import { classifyTurnProvenance } from "./turn-provenance.js";

let stateDir: string | null = null;
const publishedPrompts: Array<{
  sessionName: string;
  payload: Record<string, unknown>;
}> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("observation-plane-");
  publishedPrompts.length = 0;
  setObservationPromptPublisherForTests(async (sessionName, payload) => {
    publishedPrompts.push({ sessionName, payload });
  });
  dbCreateAgent({ id: "worker", cwd: "/tmp/worker" });
  dbCreateAgent({ id: "observer", cwd: "/tmp/observer" });
});

afterEach(async () => {
  setObservationPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function writeObserverProfile(profileId: string, files: Record<string, string>): void {
  if (!stateDir) throw new Error("missing isolated state");
  const profileDir = join(stateDir, "observers", "profiles", profileId);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(profileDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

describe("Observation Plane", () => {
  it("migrates exact legacy CLI read grants in rules and durable bindings", () => {
    const session = getOrCreateSession("grant-migration-source", "worker", "/tmp/worker", {
      name: "grant-migration-source",
    });
    dbUpsertObserverRule({
      id: "grant-migration",
      scope: "session",
      sourceSession: "grant-migration-source",
      observerAgentId: "observer",
      observerMode: "report",
      permissionGrants: ["read:agents:debounce", "read:agents:*"],
    });
    ensureObserverBindingsForSession({ sessionName: "grant-migration-source", session });

    expect(migrateObservationCommandAccessGrants()).toEqual({
      changedRules: 1,
      changedBindings: 1,
      addedGrants: 4,
      ambiguousGrants: 0,
    });
    const expectedGrants = [
      "read:agents:debounce",
      "read:agents:*",
      "mutate:agents:debounce",
      "mutate:agents:spec-mode",
    ];
    const ruleGrants = dbGetObserverRule("grant-migration")?.permissionGrants;
    const bindingGrants = dbListObserverBindings({ sourceSessionKey: session.sessionKey })[0]?.permissionGrants;
    expect(ruleGrants).toHaveLength(expectedGrants.length);
    expect(ruleGrants).toEqual(expect.arrayContaining(expectedGrants));
    expect(bindingGrants).toHaveLength(expectedGrants.length);
    expect(bindingGrants).toEqual(expect.arrayContaining(expectedGrants));

    expect(migrateObservationCommandAccessGrants()).toEqual({
      changedRules: 0,
      changedBindings: 0,
      addedGrants: 0,
      ambiguousGrants: 0,
    });
  });

  it("creates one idempotent observer binding for a matched agent rule", () => {
    const session = getOrCreateSession("source-session", "worker", "/tmp/worker", { name: "source-session" });
    dbUpsertObserverRule({
      id: "task-progress",
      scope: "agent",
      sourceAgentId: "worker",
      observerAgentId: "observer",
      observerRole: "task-progress",
      observerMode: "summarize",
      eventTypes: ["message.user", "turn.complete"],
    });

    const first = ensureObserverBindingsForSession({
      sessionName: "source-session",
      session,
    });
    const second = ensureObserverBindingsForSession({
      sessionName: "source-session",
      session,
    });

    expect(first.created).toHaveLength(1);
    expect(first.bindings[0]).toMatchObject({
      sourceSessionKey: "source-session",
      observerAgentId: "observer",
      observerRole: "task-progress",
    });
    expect(second.created).toHaveLength(0);
    expect(dbListObserverBindings({ sourceSessionKey: "source-session" })).toHaveLength(1);
  });

  it("defers turn selectors and excludes a cron running in the main session", async () => {
    const session = getOrCreateSession("agent:worker:main", "worker", "/tmp/worker", { name: "main" });
    const rule = dbUpsertObserverRule({
      id: "interactive-followups",
      scope: "global",
      observerAgentId: "observer",
      observerRole: "interactive-followups",
      observerMode: "summarize",
      eventTypes: ["turn.complete"],
      selector: `turn.background == "false"`,
    });
    const attached = ensureObserverBindingsForSession({ sessionName: "main", session });

    expect(rule.selector).toBe(`turn.background == "false"`);
    expect(attached.bindings).toHaveLength(1);
    expect(attached.skipped).toHaveLength(0);

    const cronResult = await deliverObservationEvents({
      sourceSessionName: "main",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-main-cron",
          sequence: 1,
          type: "turn.complete",
          turn: classifyTurnProvenance({ prompt: { prompt: "cron", _cron: true, _jobId: "job-1" } }),
        }),
      ],
    });
    expect(cronResult.delivered).toHaveLength(0);
    expect(publishedPrompts).toHaveLength(0);

    const humanResult = await deliverObservationEvents({
      sourceSessionName: "main",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-main-human",
          sequence: 1,
          type: "turn.complete",
          turn: classifyTurnProvenance({ source: { actorType: "contact" } }),
        }),
      ],
    });
    expect(humanResult.delivered).toHaveLength(1);
    expect(publishedPrompts).toHaveLength(1);
  });

  it("evaluates source-only selectors before creating a binding", () => {
    const session = getOrCreateSession("source-selector", "worker", "/tmp/worker", { name: "source-selector" });
    session.channel = "slack";
    dbUpsertObserverRule({
      id: "whatsapp-only",
      scope: "global",
      observerAgentId: "observer",
      observerRole: "whatsapp-only",
      selector: `source.channel == "whatsapp"`,
    });

    const result = ensureObserverBindingsForSession({ sessionName: "source-selector", session });
    expect(result.bindings).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("selector_mismatch");
  });

  it("keeps legacy sourceExclusions metadata as compatibility input", () => {
    const session = getOrCreateSession("agent:worker:cron:legacy", "worker", "/tmp/worker", {
      name: "legacy-cron",
    });
    dbUpsertObserverRule({
      id: "legacy-exclusions",
      observerAgentId: "observer",
      observerRole: "legacy-exclusions",
      metadata: { sourceExclusions: { sessionKeyFragments: [":cron:"] } },
    });

    const result = ensureObserverBindingsForSession({ sessionName: "legacy-cron", session });
    expect(result.bindings).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("excluded_source_session_key_fragment");
  });

  it("rejects unknown sourceExclusions keys and fails closed for persisted legacy metadata", async () => {
    expect(() =>
      dbUpsertObserverRule({
        id: "unknown-source-exclusion",
        observerAgentId: "observer",
        metadata: { sourceExclusions: { sessionKeyPrefixes: ["agent:worker:"] } },
      }),
    ).toThrow("Observer metadata.sourceExclusions.sessionKeyPrefixes is not supported");

    dbUpsertObserverRule({
      id: "persisted-unknown-source-exclusion",
      observerAgentId: "observer",
    });
    getDb()
      .prepare("UPDATE observer_rules SET metadata_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ sourceExclusions: { sessionKeyPrefixes: ["agent:worker:"] } }),
        "persisted-unknown-source-exclusion",
      );

    const validation = validateObserverRules();
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContainEqual({
      ruleId: "persisted-unknown-source-exclusion",
      message: expect.stringContaining("Observer metadata.sourceExclusions.sessionKeyPrefixes is not supported"),
    });

    const session = getOrCreateSession("invalid-exclusions-source", "worker", "/tmp/worker", {
      name: "invalid-exclusions-source",
    });
    const reconcile = ensureObserverBindingsForSession({
      sessionName: "invalid-exclusions-source",
      session,
    });
    expect(reconcile.created).toHaveLength(0);
    expect(reconcile.skipped).toContainEqual({
      ruleId: "persisted-unknown-source-exclusion",
      reason: "invalid_source_exclusions",
    });

    dbUpsertObserverRule({
      id: "legacy-binding-exclusions",
      scope: "session",
      sourceSession: "invalid-exclusions-source",
      observerAgentId: "observer",
      observerRole: "legacy-binding-exclusions",
      eventTypes: ["turn.complete"],
    });
    const binding = ensureObserverBindingsForSession({
      sessionName: "invalid-exclusions-source",
      session,
    }).created[0];
    expect(binding).toBeDefined();
    getDb()
      .prepare("UPDATE observer_bindings SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify({ sourceExclusions: { sessionKeyPrefixes: ["agent:worker:"] } }), binding!.id);

    const delivery = await deliverObservationEvents({
      sourceSessionName: "invalid-exclusions-source",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-invalid-source-exclusions",
          sequence: 1,
          type: "turn.complete",
        }),
      ],
    });
    expect(delivery.delivered).toHaveLength(0);
    expect(delivery.skipped).toContainEqual({
      bindingId: binding!.id,
      reason: "invalid_source_exclusions",
    });
    expect(publishedPrompts).toHaveLength(0);
  });

  it("rejects invalid or out-of-bound observer selectors", () => {
    expect(() =>
      dbUpsertObserverRule({
        id: "invalid-selector",
        observerAgentId: "observer",
        selector: `secret.token == "nope"`,
      }),
    ).toThrow("Invalid observer selector");
  });

  it("reconciles and disables durable bindings that no longer match", () => {
    const session = getOrCreateSession("reconcile-source", "worker", "/tmp/worker", {
      name: "reconcile-source",
    });
    session.channel = "slack";
    dbUpsertObserverRule({
      id: "reconcile-rule",
      observerAgentId: "observer",
      observerRole: "reconcile-role",
      selector: `source.channel == "slack"`,
    });
    ensureObserverBindingsForSession({ sessionName: "reconcile-source", session });
    dbUpsertObserverRule({
      id: "reconcile-rule",
      observerAgentId: "observer",
      selector: `source.channel == "whatsapp"`,
    });

    const result = reconcileObserverBindingsForSession({
      sessionName: "reconcile-source",
      session,
      mode: "full-reconcile",
    });
    expect(result.bindings).toHaveLength(0);
    expect(result.disabled).toHaveLength(1);
    expect(dbListObserverBindings({ sourceSessionKey: session.sessionKey })[0]?.enabled).toBe(false);
  });

  it("refreshes a binding to the default profile after the rule clears its explicit profile", () => {
    const session = getOrCreateSession("profile-clear-source", "worker", "/tmp/worker", {
      name: "profile-clear-source",
    });
    dbUpsertObserverRule({
      id: "profile-clear-rule",
      scope: "session",
      sourceSession: "profile-clear-source",
      observerAgentId: "observer",
      observerRole: "profile-clear",
      observerProfileId: "tasks",
    });
    ensureObserverBindingsForSession({ sessionName: "profile-clear-source", session });
    expect(dbListObserverBindings({ sourceSessionKey: session.sessionKey })[0]?.observerProfileId).toBe("tasks");

    const updatedRule = dbUpsertObserverRule({
      id: "profile-clear-rule",
      observerAgentId: "observer",
      observerProfileId: null,
    });
    expect(updatedRule.observerProfileId).toBeUndefined();

    const result = reconcileObserverBindingsForSession({
      sessionName: "profile-clear-source",
      session,
      mode: "refresh-profile",
    });

    expect(result.refreshedProfiles).toHaveLength(1);
    expect(result.refreshedProfiles[0]?.observerProfileId).toBe("default");
    expect(dbListObserverBindings({ sourceSessionKey: session.sessionKey })[0]?.observerProfileId).toBe("default");
  });

  it("matches contact-tagged observer rules via session participants", () => {
    const tag = dbCreateTagDefinition({
      slug: "new-contact",
      label: "New Contact",
    });
    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "contact",
      assetId: "contact-abc",
    });
    const session = getOrCreateSession("contact-session", "worker", "/tmp/worker", { name: "contact-session" });
    dbUpsertSessionParticipant({
      sessionKey: session.sessionKey,
      ownerType: "contact",
      ownerId: "contact-abc",
      role: "human",
    });
    dbUpsertObserverRule({
      id: "new-contact-watcher",
      scope: "tag",
      tagTargetType: "contact",
      tagSlug: tag.slug,
      observerAgentId: "observer",
      observerRole: "new-contact-watch",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "contact-session",
      session,
    });
    const explanation = explainObserverRulesForSession("contact-session");

    expect(result.created).toHaveLength(1);
    expect(explanation.source?.contactIds).toContain("contact-abc");
    expect(explanation.source?.tags).toContainEqual({
      targetType: "contact",
      slug: "new-contact",
      assetId: "contact-abc",
      inherited: false,
    });
  });

  it("matches inherited tag-scoped rules against source agent tags", () => {
    const tag = dbCreateTagDefinition({
      slug: "quality-watch",
      label: "Quality Watch",
    });
    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "agent",
      assetId: "worker",
    });
    const session = getOrCreateSession("tagged-source", "worker", "/tmp/worker", { name: "tagged-source" });
    dbUpsertObserverRule({
      id: "quality",
      scope: "tag",
      tagTargetType: "agent",
      tagSlug: tag.slug,
      tagInherited: true,
      observerAgentId: "observer",
      observerRole: "quality",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "tagged-source",
      session,
    });
    const explanation = explainObserverRulesForSession("tagged-source");

    expect(result.created).toHaveLength(1);
    expect(result.bindings[0]?.eventTypes).toEqual([
      "message.assistant",
      "message.user",
      "turn.complete",
      "turn.failed",
      "turn.interrupt",
    ]);
    expect(explanation.source?.tags).toContainEqual({
      targetType: "agent",
      slug: "quality-watch",
      assetId: "worker",
      inherited: true,
    });
    expect(explanation.rules[0]).toMatchObject({
      matched: true,
      reason: "tag:agent:quality-watch:inherited",
    });
  });

  it("does not inherit tags across source boundaries unless the rule opts in", () => {
    const tag = dbCreateTagDefinition({
      slug: "policy-watch",
      label: "Policy Watch",
    });
    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "agent",
      assetId: "worker",
    });
    const session = getOrCreateSession("tag-inheritance-source", "worker", "/tmp/worker", {
      name: "tag-inheritance-source",
    });
    dbUpsertObserverRule({
      id: "policy",
      scope: "tag",
      tagTargetType: "agent",
      tagSlug: tag.slug,
      observerAgentId: "observer",
      observerRole: "policy",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "tag-inheritance-source",
      session,
    });
    const explanation = explainObserverRulesForSession("tag-inheritance-source");

    expect(result.created).toHaveLength(0);
    expect(explanation.rules[0]).toMatchObject({
      matched: false,
      reason: "tag_mismatch",
    });
  });

  it("allows ordinary tags as observer rule selectors", () => {
    const tag = dbCreateTagDefinition({
      slug: "ordinary-watch",
      label: "Ordinary Watch",
    });

    expect(
      dbUpsertObserverRule({
        id: "ordinary-watch-rule",
        scope: "tag",
        tagTargetType: "session",
        tagSlug: tag.slug,
        observerAgentId: "observer",
        observerRole: "ordinary-watch",
        observerMode: "summarize",
      }),
    ).toMatchObject({
      scope: "tag",
      tagSlug: "ordinary-watch",
      observerRole: "ordinary-watch",
    });
  });

  it("preserves disabled observer rules across ordinary upserts", () => {
    const disabled = dbUpsertObserverRule({
      id: "disabled-quality",
      enabled: false,
      observerAgentId: "observer",
      observerRole: "disabled-quality",
      observerMode: "summarize",
    });
    expect(disabled.enabled).toBe(false);

    const updated = dbUpsertObserverRule({
      id: "disabled-quality",
      observerAgentId: "observer",
      observerModel: "gpt-5.4-mini",
    });

    expect(updated.enabled).toBe(false);
    expect(updated.observerModel).toBe("gpt-5.4-mini");
  });

  it("delivers selected end-of-turn events to observer sessions asynchronously", async () => {
    const session = getOrCreateSession("deliver-source", "worker", "/tmp/worker", { name: "deliver-source" });
    dbUpsertObserverRule({
      id: "turn-summary",
      scope: "global",
      observerAgentId: "observer",
      observerRole: "turn-summary",
      observerMode: "summarize",
      eventTypes: ["turn.complete"],
    });
    ensureObserverBindingsForSession({
      sessionName: "deliver-source",
      session,
    });

    const result = await deliverObservationEvents({
      sourceSessionName: "deliver-source",
      sourceSession: session,
      agentId: "worker",
      runId: "run-test",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "message.user",
          preview: "ignored by filter",
        }),
        createObservationEvent({
          runId: "run-test",
          sequence: 2,
          type: "turn.complete",
          turnId: "turn-deliver",
          payload: { responseChars: 10 },
        }),
      ],
    });

    expect(result.delivered).toHaveLength(1);
    expect(publishedPrompts).toHaveLength(1);
    expect(publishedPrompts[0]?.sessionName).toMatch(/^obs:/);
    expect(publishedPrompts[0]?.payload._agentId).toBe("observer");
    expect(publishedPrompts[0]?.payload._observation).toMatchObject({ sourceTurnIds: ["turn-deliver"] });
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Turn Completed");
    expect(String(publishedPrompts[0]?.payload.prompt)).not.toContain('{"id"');
    expect(String(publishedPrompts[0]?.payload.prompt)).not.toContain("ignored by filter");
  });

  it("claims delivery ids durably and releases the claim when publishing fails", async () => {
    const session = getOrCreateSession("dedupe-source", "worker", "/tmp/worker", { name: "dedupe-source" });
    dbUpsertObserverRule({
      id: "dedupe-rule",
      observerAgentId: "observer",
      observerRole: "dedupe-role",
      observerMode: "summarize",
      eventTypes: ["turn.complete"],
    });
    ensureObserverBindingsForSession({ sessionName: "dedupe-source", session });
    const event = createObservationEvent({
      runId: "run-dedupe",
      sequence: 1,
      type: "turn.complete",
    });

    let attempts = 0;
    setObservationPromptPublisherForTests(async (sessionName, payload) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary publish failure");
      publishedPrompts.push({ sessionName, payload });
    });
    await expect(
      deliverObservationEvents({
        sourceSessionName: "dedupe-source",
        sourceSession: session,
        agentId: "worker",
        events: [event],
      }),
    ).rejects.toThrow("temporary publish failure");

    const retry = await deliverObservationEvents({
      sourceSessionName: "dedupe-source",
      sourceSession: session,
      agentId: "worker",
      events: [event],
    });
    const duplicate = await deliverObservationEvents({
      sourceSessionName: "dedupe-source",
      sourceSession: session,
      agentId: "worker",
      events: [event],
    });

    expect(retry.delivered).toHaveLength(1);
    expect(duplicate.delivered).toHaveLength(0);
    expect(duplicate.skipped[0]?.reason).toBe("events_already_delivered");
    expect(attempts).toBe(2);
  });

  it("uses rule-selected Markdown profiles and snapshots them on bindings", async () => {
    writeObserverProfile("compact", {
      "PROFILE.md": `---
id: compact
version: "1"
label: Compact Observer
description: Compact test renderer.
defaults:
  eventTypes:
    - turn.complete
  deliveryPolicy: end_of_turn
  mode: summarize
templates:
  delivery:
    end_of_turn: ./delivery/end.md
    realtime: ./delivery/realtime.md
    debounce: ./delivery/debounce.md
  events:
    default: ./events/default.md
    turn.complete: ./events/complete.md
rendererHints:
  label: Compact
---

# Compact Observer
`,
      "delivery/end.md": "## Compact Delivery\n\n{{events.rendered}}\n\nProfile: {{profile.id}}",
      "delivery/realtime.md": "## Realtime\n\n{{events.rendered}}",
      "delivery/debounce.md": "## Debounce\n\n{{events.rendered}}",
      "events/default.md": "### Default\n\n{{event.preview}}",
      "events/complete.md": "### Compact Complete\n\n{{event.payloadSummary}}",
    });
    const session = getOrCreateSession("profile-source", "worker", "/tmp/worker", { name: "profile-source" });
    dbUpsertObserverRule({
      id: "compact-rule",
      scope: "session",
      sourceSession: "profile-source",
      observerAgentId: "observer",
      observerRole: "compact",
      observerProfileId: "compact",
    });
    ensureObserverBindingsForSession({
      sessionName: "profile-source",
      session,
    });

    await deliverObservationEvents({
      sourceSessionName: "profile-source",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "turn.complete",
          payload: { responseChars: 7 },
        }),
      ],
    });

    const binding = dbListObserverBindings({ sourceSessionKey: "profile-source" })[0];
    expect(binding?.observerProfileId).toBe("compact");
    expect(binding?.observerProfileVersion).toBe("1");
    expect(binding?.observerMode).toBe("summarize");
    expect(binding?.eventTypes).toEqual(["turn.complete"]);
    expect(binding?.observerProfileSnapshotMarkdown).toContain("Compact Observer");
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("## Compact Delivery");
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("### Compact Complete");
  });

  it("delivers observation events only to the requested delivery policies", async () => {
    const session = getOrCreateSession("policy-source", "worker", "/tmp/worker", { name: "policy-source" });
    dbUpsertObserverRule({
      id: "realtime-watch",
      scope: "session",
      sourceSession: "policy-source",
      observerAgentId: "observer",
      observerRole: "realtime-watch",
      observerMode: "summarize",
      deliveryPolicy: "realtime",
      eventTypes: ["message.user"],
    });
    dbUpsertObserverRule({
      id: "debounce-watch",
      scope: "session",
      sourceSession: "policy-source",
      observerAgentId: "observer",
      observerRole: "debounce-watch",
      observerMode: "summarize",
      deliveryPolicy: "debounce",
      debounceMs: 250,
      eventTypes: ["message.user"],
    });
    dbUpsertObserverRule({
      id: "turn-watch",
      scope: "session",
      sourceSession: "policy-source",
      observerAgentId: "observer",
      observerRole: "turn-watch",
      observerMode: "summarize",
      deliveryPolicy: "end_of_turn",
      eventTypes: ["message.user"],
    });
    ensureObserverBindingsForSession({
      sessionName: "policy-source",
      session,
    });
    const event = createObservationEvent({
      runId: "run-test",
      sequence: 1,
      type: "message.user",
    });

    expect(
      getObservationDebounceMs({
        sourceSessionName: "policy-source",
        sourceSession: session,
        agentId: "worker",
        eventTypes: ["message.user"],
      }),
    ).toBe(250);

    await deliverObservationEvents({
      sourceSessionName: "policy-source",
      sourceSession: session,
      agentId: "worker",
      events: [event],
      deliveryPolicies: ["realtime"],
    });
    expect(publishedPrompts).toHaveLength(1);
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Observer role: realtime-watch");

    publishedPrompts.length = 0;
    await deliverObservationEvents({
      sourceSessionName: "policy-source",
      sourceSession: session,
      agentId: "worker",
      events: [event],
      deliveryPolicies: ["end_of_turn"],
    });
    expect(publishedPrompts).toHaveLength(1);
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Observer role: turn-watch");
  });

  it("carries observer runtime provider and model overrides into delivery prompts", async () => {
    const session = getOrCreateSession("runtime-source", "worker", "/tmp/worker", { name: "runtime-source" });
    const rule = dbUpsertObserverRule({
      id: "cheap-reporter",
      scope: "session",
      sourceSession: "runtime-source",
      observerAgentId: "observer",
      observerRuntimeProviderId: "codex",
      observerModel: "gpt-5.4-mini",
      observerRole: "cheap-reporter",
      observerMode: "report",
      eventTypes: ["turn.complete"],
      permissionGrants: ["tasks.report", "use:tool:tasks_done"],
    });
    expect(rule.observerRuntimeProviderId).toBe("codex");
    expect(rule.observerModel).toBe("gpt-5.4-mini");
    ensureObserverBindingsForSession({
      sessionName: "runtime-source",
      session,
    });

    await deliverObservationEvents({
      sourceSessionName: "runtime-source",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "turn.complete",
        }),
      ],
    });

    const binding = dbListObserverBindings({
      sourceSessionKey: "runtime-source",
    })[0];
    expect(binding?.observerRuntimeProviderId).toBe("codex");
    expect(binding?.observerModel).toBe("gpt-5.4-mini");
    expect(binding?.permissionGrants).toEqual(["tasks.report", "use:tool:tasks_done"]);
    expect(binding?.observerProfileId).toBe("default");
    expect(binding?.observerProfileSnapshotMarkdown).toContain("Observer Profile Snapshot");
    expect(publishedPrompts[0]?.payload._runtimeProviderId).toBe("codex");
    expect(publishedPrompts[0]?.payload._runtimeModel).toBe("gpt-5.4-mini");
    expect((publishedPrompts[0]?.payload._observation as Record<string, unknown> | undefined)?.profileId).toBe(
      "default",
    );
    expect(
      (publishedPrompts[0]?.payload._observation as Record<string, unknown> | undefined)?.permissionGrants,
    ).toEqual(["tasks.report", "use:tool:tasks_done"]);
  });

  it("includes rule instructions from metadata in observer prompts", async () => {
    const session = getOrCreateSession("instruction-source", "worker", "/tmp/worker", { name: "instruction-source" });
    dbUpsertObserverRule({
      id: "main-reporter",
      scope: "session",
      sourceSession: "instruction-source",
      observerAgentId: "observer",
      observerRole: "main-reporter",
      observerMode: "report",
      eventTypes: ["turn.complete"],
      metadata: {
        instructions: "Summarize the source work and run `ravi sessions inform main ...`.",
      },
    });
    ensureObserverBindingsForSession({
      sessionName: "instruction-source",
      session,
    });

    await deliverObservationEvents({
      sourceSessionName: "instruction-source",
      sourceSession: session,
      agentId: "worker",
      events: [
        createObservationEvent({
          runId: "run-test",
          sequence: 1,
          type: "turn.complete",
        }),
      ],
    });

    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("Observer instructions:");
    expect(String(publishedPrompts[0]?.payload.prompt)).toContain("ravi sessions inform main");
  });

  it("does not create bindings for observer prompts", () => {
    const session = getOrCreateSession("obs-source", "worker", "/tmp/worker", {
      name: "obs-source",
    });
    dbUpsertObserverRule({
      id: "global-observer",
      scope: "global",
      observerAgentId: "observer",
      observerRole: "global-observer",
      observerMode: "summarize",
    });

    const result = ensureObserverBindingsForSession({
      sessionName: "obs-source",
      session,
      prompt: {
        prompt: "observe",
        _observation: {
          sourceSessionKey: "source",
          sourceSessionName: "source",
          bindingId: "binding",
          ruleId: "rule",
          role: "role",
          mode: "observe",
          eventIds: [],
        },
      },
    });

    expect(result.bindings).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("observer_session");
  });
});
