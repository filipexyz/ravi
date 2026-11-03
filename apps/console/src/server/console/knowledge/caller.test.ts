import { describe, expect, test } from "bun:test";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";

import { parseKnowledgeExecContext, resolveKnowledgeOperator, type KnowledgeBindingLookup } from "./caller";
import type { KnowledgeRunInput } from "./retrieval-core";

const TURN_KEY = "a".repeat(64);

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function auth(overrides: Partial<CliAuthContext> = {}): CliAuthContext {
  return {
    accessTokenJti: "jti_1",
    user: { id: "user_1", primaryEmail: "dev@ravi.bot", displayName: "Dev", avatarUrl: null, status: "active" },
    organization: { id: "org_1", slug: "ravi", name: "Ravi", status: "active" },
    membership: { id: "membership_1", role: "owner", status: "active" },
    localInstallation: {
      id: "installation_1",
      name: "CLI",
      hostname: null,
      platform: null,
      raviVersion: null,
      status: "active",
      lastSeenAt: new Date("2026-10-17T12:00:00.000Z"),
    },
    cliSession: { id: "session_1", status: "active", expiresAt: new Date("2026-10-17T12:15:00.000Z"), lastUsedAt: null },
    scopes: ["console.knowledge.read"],
    ...overrides,
  };
}

function harness(binding: { consoleUserId: string } | null = null) {
  const runs: KnowledgeRunInput[] = [];
  const lookups: Array<Parameters<KnowledgeBindingLookup>[0]> = [];
  return {
    runs,
    lookups,
    deps: {
      findBinding: async (q: Parameters<KnowledgeBindingLookup>[0]) => {
        lookups.push(q);
        return binding;
      },
      writeDeniedRun: async (input: KnowledgeRunInput) => {
        runs.push(input);
        return { runId: "run_denied" };
      },
    },
  };
}

async function denial(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a denial");
}

describe("parseKnowledgeExecContext", () => {
  test("no header is a legacy terminal (null context)", () => {
    expect(parseKnowledgeExecContext(null)).toEqual({ ok: true, context: null });
  });

  test("a malformed header fails closed", () => {
    expect(parseKnowledgeExecContext("not base64!")).toEqual({ ok: false });
    expect(parseKnowledgeExecContext(encode("just a string"))).toEqual({ ok: false });
    expect(parseKnowledgeExecContext(Buffer.from("{nope", "utf8").toString("base64url"))).toEqual({ ok: false });
    expect(parseKnowledgeExecContext(encode({ v: 2, speaker: { kind: "terminal" }, conversation: "terminal" }))).toEqual({
      ok: false,
    });
    // Strict: unknown fields are refused.
    expect(
      parseKnowledgeExecContext(encode({ v: 1, speaker: { kind: "terminal" }, conversation: "terminal", extra: true })),
    ).toEqual({ ok: false });
  });

  test("speaker.consoleUserId is accepted and dropped; agentDisplayName is accepted", () => {
    const parsed = parseKnowledgeExecContext(
      encode({
        v: 1,
        agentId: "main",
        agentDisplayName: "Ravi Main",
        speaker: { kind: "owner", contactId: "ct_1", consoleUserId: "someone-else" },
        conversation: "dm",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.context) throw new Error("expected a context");
    expect(parsed.context.speaker).toEqual({ kind: "owner", contactId: "ct_1" });
    expect(JSON.stringify(parsed.context)).not.toContain("someone-else");
    expect(parsed.context.agentDisplayName).toBe("Ravi Main");
  });

  test("turnKey must be 64 hex characters", () => {
    const base = { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" };
    expect(parseKnowledgeExecContext(encode({ ...base, turnKey: TURN_KEY })).ok).toBe(true);
    expect(parseKnowledgeExecContext(encode({ ...base, turnKey: "abc" }))).toEqual({ ok: false });
    expect(parseKnowledgeExecContext(encode({ ...base, turnKey: `${"g".repeat(64)}` }))).toEqual({ ok: false });
  });

  test("a header of 2048 bytes is accepted and 2049 bytes are refused", () => {
    const headerOf = (sessionLength: number, labelLength: number) =>
      encode({
        v: 1,
        agentId: "a".repeat(200),
        agentDisplayName: "d".repeat(labelLength),
        sessionName: "s".repeat(sessionLength),
        routine: { kind: "cron", id: "r".repeat(200) },
        speaker: { kind: "owner", contactId: "c".repeat(200), consoleUserId: "u".repeat(200) },
        conversation: "dm",
        turnKey: TURN_KEY,
      });
    const find = (length: number) => {
      for (let session = 1; session <= 500; session += 1) {
        for (let label = 1; label <= 200; label += 1) {
          const header = headerOf(session, label);
          if (header.length === length) return header;
        }
      }
      throw new Error(`no header of ${length} bytes`);
    };
    expect(parseKnowledgeExecContext(find(2048)).ok).toBe(true);
    // Unpadded base64url is never 1 mod 4 long, so 2049 bytes is the same
    // valid context padded: 2048 bytes still parse, 2049 are refused.
    const base = find(2047);
    expect(parseKnowledgeExecContext(`${base}=`).ok).toBe(true);
    expect(parseKnowledgeExecContext(`${base}==`)).toEqual({ ok: false });
  });
});

describe("resolveKnowledgeOperator", () => {
  test("row 1: no header, or the terminal, is the operator", async () => {
    const h = harness();
    const none = await resolveKnowledgeOperator({ auth: auth(), header: null, requestId: "r" }, h.deps);
    expect(none).toMatchObject({ audience: "operator", localInstallationId: "installation_1", turnKey: null });
    expect(none.workspace).toEqual({
      mode: "workos",
      user: { id: "user_1" },
      organization: { id: "org_1" },
      membership: { role: "owner" },
      authorization: { installationId: "installation_1", sessionId: "session_1", bindingId: null, accessTokenJti: "jti_1" },
    });
    expect(none.callerJson).toMatchObject({ surface: "cli", speaker: { kind: "terminal" }, conversation: "terminal" });

    const terminal = await resolveKnowledgeOperator(
      { auth: auth(), header: encode({ v: 1, speaker: { kind: "terminal" }, conversation: "terminal", turnKey: TURN_KEY }), requestId: "r" },
      h.deps,
    );
    expect(terminal.turnKey).toBe(TURN_KEY);
    expect(h.runs).toHaveLength(0);
  });

  test("row 2: the owner without a contact (operator relay) in a DM or the terminal", async () => {
    const h = harness();
    for (const conversation of ["dm", "terminal"]) {
      const caller = await resolveKnowledgeOperator(
        { auth: auth(), header: encode({ v: 1, speaker: { kind: "owner" }, conversation }), requestId: "r" },
        h.deps,
      );
      expect(caller.audience).toBe("operator");
    }
    expect(h.lookups).toHaveLength(0);
  });

  test("row 3: the owner's DM with a contact needs a binding to this very user", async () => {
    const header = encode({ v: 1, agentId: "main", speaker: { kind: "owner", contactId: "ct_1" }, conversation: "dm", sessionName: "main-dm" });

    const bound = harness({ consoleUserId: "user_1" });
    const caller = await resolveKnowledgeOperator({ auth: auth(), header, requestId: "r" }, bound.deps);
    expect(caller.callerJson).toMatchObject({ speaker: { kind: "owner" }, conversation: "dm", agentId: "main", sessionName: "main-dm" });
    expect(JSON.stringify(caller.callerJson)).not.toContain("ct_1");
    expect(bound.lookups).toEqual([{ installationId: "installation_1", organizationId: "org_1", contactId: "ct_1" }]);

    for (const binding of [null, { consoleUserId: "user_2" }]) {
      const h = harness(binding);
      const error = await denial(resolveKnowledgeOperator({ auth: auth(), header, requestId: "r" }, h.deps));
      expect(error).toBeInstanceOf(CliApiError);
      expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_TURN_NOT_OPERATOR", details: { reason: "binding" } });
      expect(h.runs).toHaveLength(1);
      expect(h.runs[0]).toMatchObject({ status: "denied", audience: "operator", localInstallationId: "installation_1", citations: [] });
      expect(h.runs[0]?.queryText).toBeNull();
    }
  });

  test("row 4: the operator's cron, answered in the owner's DM or as automation", async () => {
    const h = harness();
    for (const conversation of ["automation", "dm"]) {
      const caller = await resolveKnowledgeOperator(
        {
          auth: auth(),
          header: encode({ v: 1, routine: { kind: "cron", id: "job_1" }, speaker: { kind: "automation" }, conversation }),
          requestId: "r",
        },
        h.deps,
      );
      expect(caller.callerJson).toMatchObject({ routine: { kind: "cron", id: "job_1" } });
    }
    expect(h.runs).toHaveLength(0);
  });

  test("row 5: groups, heartbeats, triggers, contacts and agents are refused", async () => {
    const cases = [
      { v: 1, speaker: { kind: "owner" }, conversation: "group" },
      { v: 1, speaker: { kind: "owner", contactId: "ct_1" }, conversation: "group" },
      { v: 1, routine: { kind: "heartbeat" }, speaker: { kind: "automation" }, conversation: "automation" },
      { v: 1, routine: { kind: "trigger", id: "t" }, speaker: { kind: "automation" }, conversation: "dm" },
      { v: 1, routine: { kind: "cron" }, speaker: { kind: "automation" }, conversation: "group" },
      { v: 1, speaker: { kind: "contact", contactId: "ct_9" }, conversation: "dm" },
      { v: 1, speaker: { kind: "agent" }, conversation: "dm" },
      { v: 1, speaker: { kind: "terminal" }, conversation: "dm" },
    ];
    for (const context of cases) {
      const h = harness({ consoleUserId: "user_1" });
      const error = await denial(resolveKnowledgeOperator({ auth: auth(), header: encode(context), requestId: "r" }, h.deps));
      expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_TURN_NOT_OPERATOR", details: { reason: "audience" } });
      expect(h.runs).toHaveLength(1);
      expect(h.lookups).toHaveLength(0);
    }
  });

  test("a malformed header is 400 PAYLOAD_INVALID", async () => {
    const h = harness();
    const error = await denial(resolveKnowledgeOperator({ auth: auth(), header: "%%%", requestId: "r" }, h.deps));
    expect(error).toMatchObject({ status: 400, code: "PAYLOAD_INVALID" });
    expect(h.runs).toHaveLength(0);
  });

  test("a failing denied-run write still answers 403", async () => {
    const error = await denial(
      resolveKnowledgeOperator(
        { auth: auth(), header: encode({ v: 1, speaker: { kind: "agent" }, conversation: "dm" }), requestId: "r" },
        {
          writeDeniedRun: async () => {
            throw new Error("db down");
          },
        },
      ),
    );
    expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_TURN_NOT_OPERATOR" });
  });
});
