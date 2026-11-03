import { describe, expect, test } from "bun:test";

import {
  EXEC_CONTEXT_MAX_BYTES,
  execAuditMetadata,
  parseExecContextHeader,
  personalUseDenial,
  relayOrAutomationDenial,
  routineKey,
  safeExecContext,
  type ExecContextV1,
} from "./exec-context";

const OWNER = "8b0e3b9e-0b8a-4a53-9a5e-1f2a3b4c5d6e";
const TURN_KEY = "a".repeat(64);

function encode(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
}

function parsed(value: unknown) {
  return parseExecContextHeader(encode(value));
}

function context(overrides: Partial<ExecContextV1> = {}): ExecContextV1 {
  return { v: 1, speaker: { kind: "terminal" }, conversation: "terminal", ...overrides };
}

describe("exec context header", () => {
  test("a missing header is an older CLI, treated as the terminal", () => {
    const result = parseExecContextHeader(null);
    expect(result).toEqual({
      ok: true,
      legacyCli: true,
      context: { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" },
    });
  });

  test("parses a full version 1 context", () => {
    const value = {
      v: 1,
      agentId: "main",
      sessionName: "main-dm",
      routine: { kind: "cron", id: "job1" },
      speaker: { kind: "owner", contactId: "c_luis", consoleUserId: OWNER },
      conversation: "dm",
      turnKey: TURN_KEY,
      agentDisplayName: "Main",
    };
    const result = parsed(value);
    expect(result).toEqual({ ok: true, legacyCli: false, context: value as ExecContextV1 });
  });

  test("accepts padded base64url", () => {
    const padded = Buffer.from(JSON.stringify(context()), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    expect(parseExecContextHeader(padded)).toMatchObject({ ok: true, legacyCli: false });
  });

  test("fails closed on malformed, oversized or unknown headers", () => {
    expect(parseExecContextHeader("")).toEqual({ ok: false, reason: "not_base64url" });
    expect(parseExecContextHeader("not base64!")).toEqual({ ok: false, reason: "not_base64url" });
    expect(parseExecContextHeader(encode("{not json"))).toEqual({ ok: false, reason: "not_json" });
    expect(parseExecContextHeader(encode([1]))).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), v: 2 })).toEqual({ ok: false, reason: "unsupported_version" });
    expect(parsed({ speaker: { kind: "terminal" }, conversation: "terminal" })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
    expect(parsed({ ...context(), extra: true })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), speaker: { kind: "terminal", extra: 1 } })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), speaker: { kind: "stranger" } })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), conversation: "channel" })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), routine: { kind: "observer" } })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), turnKey: "ctx_1" })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), agentId: "line\nbreak" })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ ...context(), agentId: "" })).toEqual({ ok: false, reason: "invalid" });
    expect(parsed({ v: 1, conversation: "terminal" })).toEqual({ ok: false, reason: "invalid" });

    const oversized = encode({ ...context(), sessionName: "s".repeat(1600) });
    expect(oversized.length).toBeGreaterThan(EXEC_CONTEXT_MAX_BYTES);
    expect(parseExecContextHeader(oversized)).toEqual({ ok: false, reason: "too_large" });
    expect(parseExecContextHeader(Buffer.from([0xc3, 0x28]).toString("base64url"))).toEqual({
      ok: false,
      reason: "not_base64url",
    });
  });

  test("the safe context keeps labels and classification but never the turn key", () => {
    const value = context({
      agentId: "main",
      routine: { kind: "heartbeat" },
      speaker: { kind: "automation" },
      conversation: "automation",
      turnKey: TURN_KEY,
    });
    const safe = safeExecContext({ context: value, legacyCli: false });
    expect(safe).toEqual({
      v: 1,
      agentId: "main",
      routine: { kind: "heartbeat" },
      speaker: { kind: "automation" },
      conversation: "automation",
    });
    expect(JSON.stringify(safe)).not.toContain(TURN_KEY);
    expect(safeExecContext({ context: context(), legacyCli: true })).toMatchObject({ legacyCli: true });
  });

  test("audit metadata and routine keys", () => {
    const value = context({ agentId: "main", routine: { kind: "cron", id: "job1" }, speaker: { kind: "automation" } });
    expect(execAuditMetadata({ context: value, legacyCli: false }, "inst-1")).toEqual({
      agentId: "main",
      routineKind: "cron",
      conversation: "terminal",
      speakerKind: "automation",
      installationId: "inst-1",
    });
    expect(routineKey(value)).toBe("cron:job1");
    expect(routineKey(context({ routine: { kind: "heartbeat" } }))).toBe("heartbeat");
    expect(routineKey(context())).toBe("");
  });
});

describe("personal connection use", () => {
  test("the terminal, the owner and the owner's routines may use it", () => {
    expect(personalUseDenial(context(), OWNER)).toBeNull();
    expect(personalUseDenial(context({ speaker: { kind: "owner" }, conversation: "dm" }), OWNER)).toBeNull();
    expect(
      personalUseDenial(context({ speaker: { kind: "contact", consoleUserId: OWNER }, conversation: "dm" }), OWNER),
    ).toBeNull();
    for (const kind of ["cron", "heartbeat"] as const) {
      expect(
        personalUseDenial(
          context({ speaker: { kind: "automation" }, conversation: "automation", routine: { kind } }),
          OWNER,
        ),
      ).toBeNull();
    }
  });

  test("groups are blocked for every speaker", () => {
    expect(personalUseDenial(context({ conversation: "group" }), OWNER)).toBe("connector_group_blocked");
    expect(personalUseDenial(context({ speaker: { kind: "owner" }, conversation: "group" }), OWNER)).toBe(
      "connector_group_blocked",
    );
  });

  test("other agents, other automations and other people are not the owner", () => {
    expect(personalUseDenial(context({ speaker: { kind: "agent" } }), OWNER)).toBe("connector_speaker_not_owner");
    expect(personalUseDenial(context({ speaker: { kind: "automation" } }), OWNER)).toBe("connector_speaker_not_owner");
    expect(
      personalUseDenial(context({ speaker: { kind: "automation" }, routine: { kind: "trigger", id: "t" } }), OWNER),
    ).toBe("connector_speaker_not_owner");
    expect(
      personalUseDenial(context({ speaker: { kind: "contact", consoleUserId: "someone-else" }, conversation: "dm" }), OWNER),
    ).toBe("connector_speaker_not_owner");
    expect(personalUseDenial(context({ speaker: { kind: "contact" }, conversation: "dm" }), OWNER)).toBe(
      "connector_speaker_not_owner",
    );
    expect(personalUseDenial(context({ speaker: { kind: "contact", consoleUserId: OWNER } }), null)).toBe(
      "connector_speaker_not_owner",
    );
  });

  test("a context that contradicts itself fails closed", () => {
    // Named as someone else's Console user: not the owner, whatever the kind says.
    for (const kind of ["owner", "terminal", "automation"] as const) {
      expect(
        personalUseDenial(
          context({ speaker: { kind, consoleUserId: "someone-else" }, conversation: "dm", routine: { kind: "cron" } }),
          OWNER,
        ),
      ).toBe("connector_speaker_not_owner");
    }
    expect(
      personalUseDenial(context({ speaker: { kind: "owner", consoleUserId: OWNER }, conversation: "dm" }), OWNER),
    ).toBeNull();
    // A trigger never acts with a personal account, whoever the speaker is.
    for (const kind of ["owner", "terminal", "automation"] as const) {
      expect(personalUseDenial(context({ speaker: { kind }, routine: { kind: "trigger", id: "t" } }), OWNER)).toBe(
        "connector_speaker_not_owner",
      );
    }
  });
});

describe("shared organization account use", () => {
  test("people in a conversation and the operator's routines; never relays, triggers or other automations", () => {
    expect(relayOrAutomationDenial(context({ speaker: { kind: "contact", contactId: "c1" }, conversation: "dm" }))).toBeNull();
    // Anyone may be the speaker: the account is nobody's own.
    expect(
      relayOrAutomationDenial(context({ speaker: { kind: "contact", consoleUserId: "someone-else" }, conversation: "group" })),
    ).toBeNull();
    expect(relayOrAutomationDenial(context({ speaker: { kind: "automation" }, routine: { kind: "cron", id: "d" } }))).toBeNull();
    expect(relayOrAutomationDenial(context({ speaker: { kind: "automation" }, routine: { kind: "heartbeat" } }))).toBeNull();
    expect(relayOrAutomationDenial(context({ speaker: { kind: "agent" } }))).toBe("connector_speaker_not_owner");
    expect(relayOrAutomationDenial(context({ speaker: { kind: "automation" } }))).toBe("connector_speaker_not_owner");
    for (const kind of ["owner", "contact", "automation"] as const) {
      expect(relayOrAutomationDenial(context({ speaker: { kind }, routine: { kind: "trigger", id: "t" } }))).toBe(
        "connector_speaker_not_owner",
      );
    }
  });
});
