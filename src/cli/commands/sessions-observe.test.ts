import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrCreateSession } from "../../router/index.js";
import { dbCreateAgent } from "../../router/router-db.js";
import {
  createObservationEvent,
  dbListObserverBindings,
  dbListObserverRules,
  deliverObservationEvents,
  setObservationPromptPublisherForTests,
} from "../../runtime/observation-plane.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext } from "../context.js";
import { CliExpectedError } from "../expected-error.js";
import { renameSessionName } from "../../router/sessions.js";
import { classifyTurnProvenance, isObserverOriginated } from "../../runtime/turn-provenance.js";

const { SessionCommands } = await import("./sessions.js");

let stateDir: string | null = null;
const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("sessions-observe-");
  published.length = 0;
  setObservationPromptPublisherForTests(async (sessionName, payload) => {
    published.push({ sessionName, payload });
  });
  dbCreateAgent({ id: "client-agent", cwd: "/tmp/client-agent" });
  dbCreateAgent({ id: "lead", cwd: "/tmp/lead" });
});

afterEach(async () => {
  setObservationPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function sessions() {
  const source = getOrCreateSession("client-group", "client-agent", "/tmp/client-agent", { name: "client-group" });
  const target = getOrCreateSession("lead-dm", "lead", "/tmp/lead", { name: "lead-dm" });
  return { source, target };
}

const ev = (sequence: number, type: string, turnId: string, extra: Record<string, unknown> = {}) =>
  createObservationEvent({ runId: `run-${turnId}`, sequence, type, turnId, ...extra });

describe("ravi sessions observe", () => {
  it("sends the observer a short Inform only when the observed turn goes wrong", async () => {
    const { source } = sessions();
    const result = new SessionCommands().observe("client-group", "lead-dm", undefined, undefined, true);
    expect(result).toMatchObject({
      observing: { source: "client-group", to: "lead-dm", mode: "alerts" },
    });
    // Attached at once, without waiting for the source to relaunch.
    expect(dbListObserverBindings({ sourceSessionKey: source.sessionKey, enabled: true })).toHaveLength(1);

    await deliverObservationEvents({
      sourceSessionName: "client-group",
      sourceSession: source,
      agentId: "client-agent",
      deliveryPolicies: ["end_of_turn"],
      events: [
        ev(1, "message.user", "ok-turn", { preview: "bom dia" }),
        ev(2, "message.assistant", "ok-turn", { preview: "Bom dia! Tudo pronto." }),
        ev(3, "turn.complete", "ok-turn"),
      ],
    });
    expect(published).toHaveLength(0);

    await deliverObservationEvents({
      sourceSessionName: "client-group",
      sourceSession: source,
      agentId: "client-agent",
      deliveryPolicies: ["end_of_turn"],
      events: [
        ev(1, "message.user", "bad-turn", { preview: "configura o omie" }),
        ev(2, "message.assistant", "bad-turn", { preview: "Checking the config..." }),
        ev(3, "message.assistant", "bad-turn", { preview: "Now updating the keys..." }),
        ev(4, "tool.end", "bad-turn", { payload: { toolName: "Bash" } }),
        ev(5, "turn.complete", "bad-turn"),
      ],
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.sessionName).toBe("lead-dm");
    // A normal Inform on the receiving session, not an observer-isolated `_observation` prompt.
    expect(published[0]?.payload._observation).toBeUndefined();
    const prompt = String(published[0]?.payload.prompt);
    expect(prompt.startsWith("[System] Inform: [from: ravi observer] [observation of client-group")).toBe(true);
    expect(prompt).toContain("⚠ turn.no_final_reply");
    expect(prompt).toContain("⚠ chat.narration (turn bad-turn): 2 agent messages in one turn");
    expect(prompt).toContain("user: configura o omie");
  });

  it("follows every turn with --follow, is idempotent, and stops with unobserve", async () => {
    const { source } = sessions();
    const commands = new SessionCommands();
    commands.observe("client-group", "lead-dm", undefined, true, true);
    commands.observe("client-group", "lead-dm", undefined, true, true);
    expect(dbListObserverRules().filter((rule) => rule.id.startsWith("observe:"))).toHaveLength(1);
    expect(commands.observing(true)).toMatchObject({
      observing: [{ source: "client-group", to: "lead-dm", mode: "follow", when: [] }],
    });

    await deliverObservationEvents({
      sourceSessionName: "client-group",
      sourceSession: source,
      agentId: "client-agent",
      deliveryPolicies: ["end_of_turn"],
      events: [
        ev(1, "message.user", "t1", { preview: "oi" }),
        ev(2, "message.assistant", "t1"),
        ev(3, "turn.complete", "t1"),
      ],
    });
    expect(published).toHaveLength(1);

    expect(commands.unobserve("client-group", "lead-dm", true)).toMatchObject({ removed: true });
    expect(dbListObserverBindings({ sourceSessionKey: source.sessionKey, enabled: true })).toHaveLength(0);
    await deliverObservationEvents({
      sourceSessionName: "client-group",
      sourceSession: source,
      agentId: "client-agent",
      deliveryPolicies: ["end_of_turn"],
      events: [ev(1, "message.user", "t2", { preview: "oi" }), ev(2, "turn.complete", "t2")],
    });
    expect(published).toHaveLength(1);
    expect(commands.observing(true)).toMatchObject({ observing: [], total: 0 });
  });

  it("marks the notice as observer-originated, so two sessions watching each other cannot loop", async () => {
    const { source } = sessions();
    const commands = new SessionCommands();
    commands.observe("client-group", "lead-dm", undefined, true, true);
    commands.observe("lead-dm", "client-group", undefined, true, true);
    await deliverObservationEvents({
      sourceSessionName: "client-group",
      sourceSession: source,
      agentId: "client-agent",
      deliveryPolicies: ["end_of_turn"],
      events: [ev(1, "message.user", "m1", { preview: "oi" }), ev(2, "turn.complete", "m1")],
    });
    expect(published).toHaveLength(1);
    const notice = published[0]!.payload as { _observationNotice?: { bindingId: string } };
    expect(notice._observationNotice?.bindingId).toBeTruthy();
    // The receiving turn is classified as an observer turn: the event loop emits no observation for it.
    expect(isObserverOriginated(classifyTurnProvenance({ prompt: notice as never }))).toBe(true);
  });

  it("survives renames and never delivers to a session that reuses an old name", async () => {
    const { source, target } = sessions();
    const commands = new SessionCommands();
    commands.observe("client-group", "lead-dm", undefined, true, true);
    renameSessionName(target.sessionKey, "lead-dm-renamed");
    // Another session now holds the receiver's old name.
    getOrCreateSession("lead-dm-impostor", "lead", "/tmp/lead", { name: "lead-dm" });
    await deliverObservationEvents({
      sourceSessionName: "client-group",
      sourceSession: source,
      agentId: "client-agent",
      deliveryPolicies: ["end_of_turn"],
      events: [ev(1, "message.user", "r1", { preview: "oi" }), ev(2, "turn.complete", "r1")],
    });
    expect(published.map((item) => item.sessionName)).toEqual(["lead-dm-renamed"]);
    expect(commands.observing(true)).toMatchObject({ observing: [{ source: "client-group", to: "lead-dm-renamed" }] });

    renameSessionName(source.sessionKey, "client-group-renamed");
    expect(commands.unobserve("client-group-renamed", "lead-dm-renamed", true)).toMatchObject({ removed: true });
    expect(commands.observing(true)).toMatchObject({ total: 0 });
  });

  it("refuses a trigger's own session as the receiver", () => {
    sessions();
    getOrCreateSession("agent:lead:trigger:t1:own", "lead", "/tmp/lead", undefined, { triggerRunner: true });
    const commands = new SessionCommands();
    expect(() =>
      runWithContext({}, () =>
        commands.observe("client-group", "agent:lead:trigger:t1:own", undefined, undefined, true),
      ),
    ).toThrow(/trigger's own session/);
  });

  it("reports flag misuse and unknown conditions as usage errors (exit 2)", () => {
    sessions();
    const commands = new SessionCommands();
    for (const call of [
      () => commands.observe("client-group", "lead-dm", "turn.vibes", undefined, true),
      () => commands.observe("client-group", "lead-dm", "turn.failed", true, true),
    ]) {
      try {
        call();
        throw new Error("expected a usage error");
      } catch (error) {
        expect(error).toBeInstanceOf(CliExpectedError);
        expect((error as CliExpectedError).exitCode).toBe(2);
        expect((error as CliExpectedError).code).toBe("USAGE_ERROR");
      }
    }
  });

  it("hides sessions a scoped caller cannot reach, on both ends", () => {
    sessions();
    const commands = new SessionCommands();
    const asClient = (fn: () => unknown) => () =>
      runWithContext({ agentId: "client-agent", sessionName: "client-group", sessionKey: "client-group" }, fn);
    // The client agent may not route its own session's notices into the lead's DM, nor watch it.
    expect(asClient(() => commands.observe("client-group", "lead-dm", undefined, undefined, true))).toThrow(
      /Session not found: lead-dm/,
    );
    expect(asClient(() => commands.observe("lead-dm", "client-group", undefined, undefined, true))).toThrow(
      /Session not found: lead-dm/,
    );
    expect(dbListObserverRules().filter((rule) => rule.id.startsWith("observe:"))).toHaveLength(0);
  });

  it("refuses to observe itself and rejects unknown conditions", () => {
    sessions();
    const commands = new SessionCommands();
    // An empty tool context makes `fail` throw the CLI error instead of exiting the process.
    const inCli = (fn: () => unknown) => () => runWithContext({}, fn);
    expect(inCli(() => commands.observe("lead-dm", "lead-dm", undefined, undefined, true))).toThrow(
      /cannot observe itself/,
    );
    expect(inCli(() => commands.observe("client-group", "lead-dm", "turn.vibes", undefined, true))).toThrow(
      /Unknown observer condition/,
    );
    expect(inCli(() => commands.observe("client-group", "lead-dm", "turn.failed", true, true))).toThrow(
      /either --follow/,
    );
  });
});
