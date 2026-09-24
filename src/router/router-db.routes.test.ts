/**
 * Route CRUD persistence: pattern normalize, dmScope updates, soft-delete.
 *
 * Each test uses an isolated Ravi state directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canonicalizeRouteIdentity } from "../utils/phone.js";
import {
  dbCreateAgent,
  dbCreateRoute,
  dbDeleteRoute,
  dbGetRoute,
  dbListDeletedRoutes,
  dbListRoutes,
  dbRestoreRoute,
  dbUpdateRoute,
  getDb,
} from "./router-db.js";

const TEST_AGENT = "test-route-agent";
const TEST_AGENT_B = "test-route-agent-b";
const TEST_ACCOUNT = "test-route-instance";
const LID_DIGITS = "224420715061374";
const LID_JID = `${LID_DIGITS}@lid`;
const LID_CANONICAL = `lid:${LID_DIGITS}`;

let stateDir: string | null = null;

function seedAgents(): void {
  dbCreateAgent({ id: TEST_AGENT, cwd: "/tmp/test-route-agent" });
  dbCreateAgent({ id: TEST_AGENT_B, cwd: "/tmp/test-route-agent-b" });
}

function rawRoute(pattern: string, accountId = TEST_ACCOUNT) {
  return getDb()
    .prepare("SELECT pattern, dm_scope, channel, policy, deleted_at FROM routes WHERE pattern = ? AND account_id = ?")
    .get(pattern, accountId) as
    | {
        pattern: string;
        dm_scope: string | null;
        channel: string | null;
        policy: string | null;
        deleted_at: number | null;
      }
    | undefined;
}

function rawRouteByAccount(accountId = TEST_ACCOUNT) {
  return getDb()
    .prepare("SELECT pattern, dm_scope, channel, policy, deleted_at FROM routes WHERE account_id = ?")
    .all(accountId) as Array<{
    pattern: string;
    dm_scope: string | null;
    channel: string | null;
    policy: string | null;
    deleted_at: number | null;
  }>;
}

describe("Route pattern normalize + dmScope updates", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-routes-test-");
    seedAgents();
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("stores @lid as lid:<digits> and updates dmScope without archiving (report allowlist+whatsapp)", () => {
    const created = dbCreateRoute({
      pattern: LID_JID,
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
      policy: "allowlist",
      channel: "whatsapp",
    });

    expect(created.pattern).toBe(LID_CANONICAL);
    expect(created.policy).toBe("allowlist");
    expect(created.channel).toBe("whatsapp");
    expect(dbGetRoute(LID_JID, TEST_ACCOUNT)?.pattern).toBe(LID_CANONICAL);
    expect(dbGetRoute(LID_CANONICAL, TEST_ACCOUNT)?.pattern).toBe(LID_CANONICAL);
    expect(dbGetRoute(`lid:${LID_DIGITS}@lid`, TEST_ACCOUNT)?.pattern).toBe(LID_CANONICAL);

    const updated = dbUpdateRoute(LID_JID, { dmScope: "per-account-channel-peer" }, TEST_ACCOUNT);

    expect(updated.pattern).toBe(LID_CANONICAL);
    expect(updated.dmScope).toBe("per-account-channel-peer");
    expect(updated.channel).toBe("whatsapp");
    expect(updated.policy).toBe("allowlist");
    expect(dbListRoutes(TEST_ACCOUNT)).toHaveLength(1);
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);

    const row = rawRoute(LID_CANONICAL);
    expect(row?.deleted_at).toBeNull();
    expect(row?.dm_scope).toBe("per-account-channel-peer");
    expect(row?.channel).toBe("whatsapp");
  });

  it("matches the CLI add+set sequence: canonicalize then persist, then set dmScope via @lid", () => {
    const storedPattern = canonicalizeRouteIdentity(LID_JID);
    dbCreateRoute({
      pattern: storedPattern,
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
      policy: "allowlist",
      channel: "whatsapp",
    });

    const routePattern = canonicalizeRouteIdentity(LID_JID);
    expect(dbGetRoute(routePattern, TEST_ACCOUNT)).not.toBeNull();

    const updated = dbUpdateRoute(routePattern, { dmScope: "per-account-channel-peer" }, TEST_ACCOUNT);
    expect(updated.dmScope).toBe("per-account-channel-peer");
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);
    expect(rawRoute(LID_CANONICAL)?.deleted_at).toBeNull();
  });

  it("finds mixed-case Slack and group patterns after create lowercasing", () => {
    dbCreateRoute({
      pattern: "U012ABCDEF",
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
    });
    dbCreateRoute({
      pattern: "group:C0BG33ZUWJC",
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
      channel: "slack",
    });

    expect(dbGetRoute("U012ABCDEF", TEST_ACCOUNT)?.pattern).toBe("u012abcdef");
    expect(dbGetRoute("u012abcdef", TEST_ACCOUNT)?.pattern).toBe("u012abcdef");
    expect(dbGetRoute("group:C0BG33ZUWJC", TEST_ACCOUNT)?.pattern).toBe("group:c0bg33zuwjc");
    expect(dbGetRoute("group:c0bg33zuwjc", TEST_ACCOUNT)?.pattern).toBe("group:c0bg33zuwjc");

    const updated = dbUpdateRoute("group:C0BG33ZUWJC", { dmScope: "per-channel-peer" }, TEST_ACCOUNT);
    expect(updated.dmScope).toBe("per-channel-peer");
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);
  });

  it("looks up a legacy @lid row that was stored without canonicalize", () => {
    getDb()
      .prepare(
        `INSERT INTO routes (pattern, account_id, agent_id, policy, priority, channel, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(LID_JID.toLowerCase(), TEST_ACCOUNT, TEST_AGENT, "allowlist", 0, "whatsapp", Date.now(), Date.now());

    expect(rawRoute(LID_JID.toLowerCase())?.pattern).toBe(LID_JID.toLowerCase());
    expect(dbGetRoute(LID_CANONICAL, TEST_ACCOUNT)).not.toBeNull();

    const updated = dbUpdateRoute(LID_CANONICAL, { dmScope: "per-account-channel-peer" }, TEST_ACCOUNT);
    expect(updated.dmScope).toBe("per-account-channel-peer");
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);

    const rows = rawRouteByAccount();
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].dm_scope).toBe("per-account-channel-peer");
    expect(normalizeStored(rows[0].pattern)).toBe(LID_CANONICAL);
  });

  it("uses the same canonical key for delete and restore as create/get", () => {
    dbCreateRoute({
      pattern: LID_JID,
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
      policy: "allowlist",
      channel: "whatsapp",
    });

    expect(dbDeleteRoute(LID_CANONICAL, TEST_ACCOUNT)).toBe(true);
    expect(dbGetRoute(LID_JID, TEST_ACCOUNT)).toBeNull();
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(1);

    expect(dbRestoreRoute(LID_JID, TEST_ACCOUNT)).toBe(true);
    expect(dbGetRoute(LID_CANONICAL, TEST_ACCOUNT)?.pattern).toBe(LID_CANONICAL);
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);
  });

  it("clears dmScope with null instead of throwing", () => {
    dbCreateRoute({
      pattern: LID_CANONICAL,
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
      dmScope: "per-peer",
    });

    const cleared = dbUpdateRoute(LID_CANONICAL, { dmScope: null }, TEST_ACCOUNT);
    expect(cleared.dmScope).toBeUndefined();
    expect(rawRoute(LID_CANONICAL)?.dm_scope).toBeNull();
  });

  it("updates agent without archiving, then updates only dmScope", () => {
    dbCreateRoute({
      pattern: LID_JID,
      accountId: TEST_ACCOUNT,
      agent: TEST_AGENT,
      policy: "allowlist",
      channel: "whatsapp",
    });

    const afterAgent = dbUpdateRoute(LID_CANONICAL, { agent: TEST_AGENT_B }, TEST_ACCOUNT);
    expect(afterAgent.agent).toBe(TEST_AGENT_B);
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);

    const afterScope = dbUpdateRoute(LID_JID, { dmScope: "per-account-channel-peer" }, TEST_ACCOUNT);
    expect(afterScope.agent).toBe(TEST_AGENT_B);
    expect(afterScope.dmScope).toBe("per-account-channel-peer");
    expect(dbListDeletedRoutes(TEST_ACCOUNT)).toHaveLength(0);
    expect(rawRoute(LID_CANONICAL)?.deleted_at).toBeNull();
  });
});

function normalizeStored(pattern: string): string {
  return canonicalizeRouteIdentity(pattern).toLowerCase();
}
