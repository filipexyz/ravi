import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import { saveMessage } from "../db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { KnowledgeClient } from "./client.js";
import { RESEARCH_NEXT, runKnowledgeRead, runKnowledgeSearch, runKnowledgeWhy } from "./search.js";
import { getLocalRun } from "./store/local-runs.js";
import { lowestTierReadInTurn } from "./store/turn-reads.js";
import type { ConsoleSearchResponse, ConsoleSearchResult, KnowledgeTurn } from "./types.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-search-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const TURN: KnowledgeTurn = {
  audience: "operator",
  turnKey: "turn-1",
  sessionName: "dev-main",
  agentId: "dev",
  execContext: { v: 1, speaker: { kind: "owner" }, conversation: "dm" } as KnowledgeTurn["execContext"],
};

const NONCE = "a1b2c3d4e5f6";

function consoleResult(overrides: Partial<ConsoleSearchResult> = {}): ConsoleSearchResult {
  return {
    ref: "kc:11111111-2222-3333-4444-555555555555",
    kind: "page",
    trust: "published",
    project: { id: "p1", slug: "vendas", name: "Vendas" },
    source: { id: "s1", title: "FAQ", originKey: null },
    document: { id: "d1", version: 3, title: "FAQ de prazos" },
    text: "O prazo de entrega padrao e de 10 dias.",
    speakers: [],
    location: { kind: "page", host: "acme.ravi.page", path: "/faq", anchor: "prazo", heading: "Prazo" },
    url: "https://acme.ravi.page/faq#prazo",
    recordedAt: "2026-10-01T00:00:00.000Z",
    score: 0.9,
    next: ["ravi knowledge read kc:11111111-2222-3333-4444-555555555555 --around 1"],
    ...overrides,
  };
}

function fakeClient(search: KnowledgeClient["search"]): () => Promise<KnowledgeClient> {
  return async () => ({ search }) as unknown as KnowledgeClient;
}

function response(results: ConsoleSearchResult[]): ConsoleSearchResponse {
  return {
    runId: "kr:run-1",
    audience: "operator",
    query: { normalized: "prazo entrega", mode: "and" },
    results,
    withheld: { count: 1, reasons: { audience: 1 } },
    issues: [],
  };
}

function seedLocal() {
  saveMessage("dev-main", "user", "qual o prazo de entrega do pedido?", null, {
    channel: "whatsapp",
    chatId: "5511999990001@s.whatsapp.net",
  });
}

const base = { inGateway: () => false, nonce: () => NONCE };

describe("runKnowledgeSearch", () => {
  it("merges Console and local results, fences each with the call nonce and records the run", async () => {
    seedLocal();
    let sentProject: string | undefined;
    const payload = await runKnowledgeSearch(
      { query: "prazo entrega", project: "vendas", turn: TURN },
      {
        ...base,
        openClient: fakeClient(async (body) => {
          sentProject = body.project;
          return response([consoleResult()]);
        }),
      },
    );
    expect(sentProject).toBe("vendas");
    expect(payload.nonce).toBe(NONCE);
    expect(payload.runId).toBe("kr:run-1");
    expect(payload.withheld?.count).toBe(1);
    expect(payload.issues).toEqual([]);
    expect(payload.results.map((result) => result.origin).sort()).toEqual(["console", "local"]);
    for (const result of payload.results) {
      expect(result.excerpt.startsWith(`<<<RAVI_KNOWLEDGE ${NONCE} trust=${result.trust}`)).toBe(true);
      expect(result.excerpt.endsWith(`RAVI_KNOWLEDGE ${NONCE}>>>`)).toBe(true);
    }
    expect(payload.next).toContain("ravi knowledge why --last");
    expect(payload.next).toContain(`ravi knowledge read ${payload.results[0]?.ref} --around 2`);
    expect(payload.next).not.toContain(RESEARCH_NEXT);
    expect(payload.localRunId.startsWith("kl:")).toBe(true);
    const run = getLocalRun(payload.localRunId);
    expect(run?.consoleRunId).toBe("kr:run-1");
    expect(run?.lowestTier).toBe("said");
    expect(run?.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run)).not.toContain("prazo");
    expect(lowestTierReadInTurn("turn-1")).toBe("said");
  });

  it("Console down gives local results plus console_unavailable: <code>", async () => {
    seedLocal();
    const payload = await runKnowledgeSearch(
      { query: "prazo", turn: TURN },
      {
        ...base,
        openClient: fakeClient(async () => {
          throw new CloudAuthError("SERVER_UNAVAILABLE", "down", { status: 503 });
        }),
      },
    );
    expect(payload.issues).toEqual(["console_unavailable: SERVER_UNAVAILABLE"]);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.origin).toBe("local");
    expect(payload.runId).toBeNull();
  });

  it("an old Console without Knowledge is unavailable too", async () => {
    const payload = await runKnowledgeSearch(
      { query: "prazo", turn: TURN },
      {
        ...base,
        openClient: fakeClient(async () => {
          throw new CloudAuthError("KNOWLEDGE_UNAVAILABLE", "no route", { status: 404 });
        }),
      },
    );
    expect(payload.issues).toEqual(["console_unavailable: KNOWLEDGE_UNAVAILABLE"]);
  });

  it("no login gives console_not_logged_in and still searches locally", async () => {
    seedLocal();
    const payload = await runKnowledgeSearch({ query: "prazo", turn: TURN }, { ...base, openClient: async () => null });
    expect(payload.issues).toEqual(["console_not_logged_in"]);
    expect(payload.results).toHaveLength(1);
  });

  it("zero results suggest the counterpart re-search", async () => {
    const payload = await runKnowledgeSearch(
      { query: "inexistente", turn: TURN },
      { ...base, openClient: fakeClient(async () => response([])) },
    );
    expect(payload.results).toEqual([]);
    expect(payload.next).toEqual(["ravi knowledge why --last", RESEARCH_NEXT]);
    expect(lowestTierReadInTurn("turn-1")).toBeNull();
  });

  it("a bad --project is an error, never a silent local fallback", async () => {
    seedLocal();
    const error = await runKnowledgeSearch(
      { query: "prazo", project: "nope", turn: TURN },
      {
        ...base,
        openClient: fakeClient(async () => {
          throw new CloudAuthError("NOT_FOUND", "project not found", { status: 404 });
        }),
      },
    ).catch((caught: unknown) => caught);
    expect(isCloudAuthError(error) && error.code).toBe("NOT_FOUND");
  });

  it("--local-only skips the Console", async () => {
    seedLocal();
    let called = false;
    const payload = await runKnowledgeSearch(
      { query: "prazo", localOnly: true, turn: TURN },
      {
        ...base,
        openClient: async () => {
          called = true;
          return null;
        },
      },
    );
    expect(called).toBe(false);
    expect(payload.issues).toEqual([]);
    expect(payload.results).toHaveLength(1);
  });

  it("rejects an empty or stopword-only query as PAYLOAD_INVALID", async () => {
    for (const query of ["", "   ", "de o a"]) {
      const error = await runKnowledgeSearch({ query, turn: TURN }, base).catch((caught: unknown) => caught);
      expect(isCloudAuthError(error) && error.code).toBe("PAYLOAD_INVALID");
    }
  });
});

describe("runKnowledgeRead and runKnowledgeWhy", () => {
  it("reads a local ref with the focus marker and explains the last run", async () => {
    seedLocal();
    saveMessage("dev-main", "assistant", "o prazo e de 10 dias", null, { agentId: "dev", channel: "whatsapp" });
    const search = await runKnowledgeSearch({ query: "prazo entrega", localOnly: true, turn: TURN }, base);
    const ref = search.results[0]?.ref ?? "";
    expect(ref.startsWith("km:")).toBe(true);
    const read = await runKnowledgeRead({ ref, around: 1, turn: TURN }, base);
    expect(read.trust).toBe("said");
    expect(read.excerpt).toContain("▶ ");
    expect(read.runId?.startsWith("kl:")).toBe(true);
    const why = await runKnowledgeWhy({ last: true, turn: TURN }, { ...base, openClient: async () => null });
    expect(why.runs).toHaveLength(1);
    expect(why.runs[0]?.citations.map((citation) => citation.ref)).toEqual([ref]);
  });

  it("a missing local ref is NOT_FOUND and a malformed ref is PAYLOAD_INVALID", async () => {
    const missing = await runKnowledgeRead({ ref: "km:999", turn: TURN }, base).catch((caught: unknown) => caught);
    expect(isCloudAuthError(missing) && missing.code).toBe("NOT_FOUND");
    const bad = await runKnowledgeRead({ ref: "zz:1", turn: TURN }, base).catch((caught: unknown) => caught);
    expect(isCloudAuthError(bad) && bad.code).toBe("PAYLOAD_INVALID");
  });
});
