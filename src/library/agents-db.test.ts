import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbGetLibraryAgentState, dbSetLibraryAgentAcceptsRequests, dbSetLibraryAgentListed } from "./agents-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-agents-db-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("library agents: directory listing", () => {
  it("migrates a table without `listed`: only agents open to requests stay listed", () => {
    const legacy = new Database(join(stateDir!, "ravi.db"));
    legacy.exec(`
      CREATE TABLE library_agents (
        agent_id             TEXT PRIMARY KEY,
        description          TEXT,
        accepts_requests     INTEGER NOT NULL DEFAULT 0 CHECK(accepts_requests IN (0,1)),
        origin_ref           TEXT,
        origin_version       INTEGER,
        origin_content_hash  TEXT,
        agents_md_sha256     TEXT,
        heartbeat_md_sha256  TEXT,
        origin_profile       TEXT,
        origin_skills_json   TEXT,
        installed_at         INTEGER,
        updated_at           INTEGER NOT NULL
      );
      INSERT INTO library_agents (agent_id, description, accepts_requests, updated_at)
      VALUES ('aberto', 'Answers', 1, 100), ('descrito', 'Only described', 0, 100);
    `);
    legacy.close();

    expect(dbGetLibraryAgentState("aberto")).toMatchObject({ listed: true, acceptsRequests: true });
    expect(dbGetLibraryAgentState("descrito")).toMatchObject({ listed: false, acceptsRequests: false });
  });

  it("defaults unlisted; opening to requests lists, unlisting closes", () => {
    dbSetLibraryAgentAcceptsRequests("a", false);
    expect(dbGetLibraryAgentState("a")).toMatchObject({ listed: false, acceptsRequests: false });

    dbSetLibraryAgentAcceptsRequests("a", true);
    expect(dbGetLibraryAgentState("a")).toMatchObject({ listed: true, acceptsRequests: true });

    dbSetLibraryAgentAcceptsRequests("a", false);
    expect(dbGetLibraryAgentState("a")).toMatchObject({ listed: true, acceptsRequests: false });

    dbSetLibraryAgentAcceptsRequests("a", true);
    dbSetLibraryAgentListed("a", false);
    expect(dbGetLibraryAgentState("a")).toMatchObject({ listed: false, acceptsRequests: false });
  });
});
