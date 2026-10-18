import { afterEach, beforeEach, describe, expect, it } from "bun:test";

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
