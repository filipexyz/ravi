import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgent } from "../router/config.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbGetLocalAgentRequest,
  dbSetLibraryAgentAcceptsRequests,
  dbSetLibraryAgentDescription,
  dbUpsertLocalAgentRequest,
} from "./agents-db.js";
import { collectLocalAgentReports } from "./pins.js";
import { buildLibraryReplyInform, LibraryRequestRunner } from "./request-runner.js";
import { buildLibraryRequestPrompt, LIBRARY_REQUEST_CHANNEL, runLibraryRequestTurn } from "./request-turn.js";
import {
  cancelLibraryRequest,
  executeLibraryAsk,
  LIBRARY_REQUEST_EXTERNAL_DENIED,
  LIBRARY_TARGET_AMBIGUOUS,
  listLibraryRequests,
  parseRequestTarget,
  prepareLibraryAsk,
  setAcceptsRequests,
  type LibraryRequestServiceDeps,
} from "./requests.js";
import { LibraryCommandError } from "./service.js";
import {
  createFakeConsole,
  createFakeRequestConsole,
  fakeAgentRequest,
  fakeCredentials,
  fakeSession,
  withFakeRequests,
  type FakeConsole,
  type FakeRequestConsole,
} from "./test-fixtures.js";

let stateDir: string | null = null;
let base: FakeConsole;
let state: FakeRequestConsole;
let fake: FakeConsole;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-requests-");
  base = createFakeConsole([]);
  state = createFakeRequestConsole({
    directory: [
      { installation: { id: "11111111-1111-4111-8111-111111111111", name: "macbook-ana" }, agent: { id: "finance" } },
      { installation: { id: "22222222-2222-4222-8222-222222222222", name: "server" }, agent: { id: "finance" } },
      { installation: { id: "33333333-3333-4333-8333-333333333333", name: "server" }, agent: { id: "finance" } },
    ],
  });
  fake = withFakeRequests(base, state);
  const home = mkdtempSync(join(tmpdir(), "ravi-library-requests-home-"));
  mkdirSync(join(home, "main"), { recursive: true });
  createAgent({ id: "helper", cwd: join(home, "main") });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function deps(extra: Partial<LibraryRequestServiceDeps> = {}): LibraryRequestServiceDeps {
  return { openSession: async () => fakeSession(fake), turn: { operatorOwnTurn: true }, ...extra };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<LibraryCommandError> {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(LibraryCommandError);
  expect((error as LibraryCommandError).code).toBe(code);
  return error as LibraryCommandError;
}

function paths(): string[] {
  return base.requests.map((request) => `${request.method} ${request.path}`);
}

describe("library requests: ask", () => {
  it("resolves <machine>/<agent> by name or id and fails on ambiguity", async () => {
    expect(parseRequestTarget("macbook-ana/finance")).toEqual({ machine: "macbook-ana", agentId: "finance" });
    expect(parseRequestTarget("finance")).toBeNull();

    const byName = await prepareLibraryAsk({ target: "MacBook-Ana/finance", message: "hi", caller: null }, deps());
    expect(byName.plan.to.installation.id).toBe("11111111-1111-4111-8111-111111111111");
    const byId = await prepareLibraryAsk(
      { target: "33333333-3333-4333-8333-333333333333/finance", message: "hi", caller: null },
      deps(),
    );
    expect(byId.plan.to.target).toBe("server/finance");

    const ambiguous = await expectCode(
      prepareLibraryAsk({ target: "server/finance", message: "hi", caller: null }, deps()),
      LIBRARY_TARGET_AMBIGUOUS,
    );
    expect(ambiguous.exitCode).toBe(2);
    expect((ambiguous.details.candidates as unknown[]).length).toBe(2);
    await expectCode(
      prepareLibraryAsk({ target: "nowhere/finance", message: "hi", caller: null }, deps()),
      "NOT_FOUND",
    );
  });

  it("sends as the asking agent and remembers its session", async () => {
    const caller = { agentId: "helper", sessionKey: "agent:helper:main", sessionName: "helper-main" };
    const prepared = await prepareLibraryAsk({ target: "macbook-ana/finance", message: "Close date?", caller }, deps());
    expect(prepared.plan.from).toEqual({ agent: "helper", session: "helper-main" });
    const result = await executeLibraryAsk(prepared);
    const sent = base.requests.find(
      (request) => request.method === "POST" && request.path === "/api/cli/library/requests",
    );
    expect(sent?.body).toEqual({
      to: { installationId: "11111111-1111-4111-8111-111111111111", agentId: "finance" },
      message: "Close date?",
      agent: { id: "helper" },
    });
    const local = dbGetLocalAgentRequest(result.request.id)!;
    expect(local).toMatchObject({ direction: "sent", agentId: "helper", sessionName: "helper-main", status: "open" });
  });

  it("refuses inside a turn that is not the operator's own, before any request", async () => {
    const caller = { agentId: "helper", sessionKey: null, sessionName: null };
    const error = await expectCode(
      prepareLibraryAsk(
        { target: "macbook-ana/finance", message: "hi", caller },
        deps({ turn: { operatorOwnTurn: false } }),
      ),
      LIBRARY_REQUEST_EXTERNAL_DENIED,
    );
    expect(error.exitCode).toBe(3);
    expect(paths()).toEqual([]);
  });

  it("lists with the asking session and cancels a pending request", async () => {
    const caller = { agentId: "helper", sessionKey: "k", sessionName: "helper-main" };
    const { request } = await executeLibraryAsk(
      await prepareLibraryAsk({ target: "macbook-ana/finance", message: "hi", caller }, deps()),
    );
    const listed = await listLibraryRequests({}, deps());
    expect(listed.requests.map((entry) => [entry.id, entry.session])).toEqual([[request.id, "helper-main"]]);
    const cancelled = await cancelLibraryRequest({ id: request.id }, deps());
    expect(cancelled.status).toBe("cancelled");
    expect(dbGetLocalAgentRequest(request.id)?.status).toBe("cancelled");
  });
});

const collectDeps = {
  readCredentials: () => fakeCredentials(),
  listProjects: async () => ({
    success: true as const,
    consoleUrl: "https://console.test",
    total: 0,
    projects: [],
    items: [],
  }),
};

describe("library requests: opening an agent", () => {
  it("stores the switch, reports it with description, and defaults closed", async () => {
    expect((await collectLocalAgentReports(collectDeps)).find((a) => a.id === "helper")).toMatchObject({
      acceptsRequests: false,
      description: null,
    });
    dbSetLibraryAgentDescription("helper", "Helps");
    const result = await setAcceptsRequests(
      { agentId: "helper", accepts: true },
      deps({ pins: { collectAgents: () => collectLocalAgentReports(collectDeps) } }),
    );
    expect(result).toMatchObject({ acceptsRequests: true, changed: true, reported: true });
    const reported = base.reportedAgents.get("inst-1")?.find((agent) => agent.id === "helper") as Record<
      string,
      unknown
    >;
    expect(reported).toMatchObject({ acceptsRequests: true, description: "Helps" });
  });
});

describe("library requests: the request turn", () => {
  it("prompts as an untrusted external actor, never the operator", () => {
    const built = buildLibraryRequestPrompt(fakeAgentRequest({ id: "req-9" }));
    expect(built.source).toMatchObject({
      channel: LIBRARY_REQUEST_CHANNEL,
      chatId: "request:req-9",
      actorType: "unknown",
    });
    expect(built.context).toMatchObject({ actorType: "unknown", senderName: "Ana" });
    expect((built.context as { contactId?: string }).contactId).toBeUndefined();
    expect(built as unknown as Record<string, unknown>).not.toHaveProperty("_turnOrigin");
    expect(built as unknown as Record<string, unknown>).not.toHaveProperty("_cliDestination");
    expect(built.prompt).toContain("From Ana, on macbook-ana, through their agent finance.");
    expect(built.prompt).toEndWith("What is the close date?");
  });

  it("collects the turn's responses until it completes", async () => {
    const events = [
      { topic: "ravi.session.s.response", data: { response: "The close is on the 5th." } },
      { topic: "ravi.session.s.runtime", data: { type: "turn.complete" } },
    ];
    let published: Record<string, unknown> | null = null;
    const outcome = await runLibraryRequestTurn(
      { agentId: "helper", request: fakeAgentRequest({ id: "req-1" }), sessionName: "s" },
      {
        publishPrompt: async (_name, payload) => {
          published = payload;
        },
        subscribe: async function* () {
          for (const event of events) yield event;
        },
        timeoutMs: 5_000,
      },
    );
    expect(outcome).toEqual({ ok: true, reply: "The close is on the 5th.", sessionName: "s" });
    expect(published).not.toBeNull();
    expect(published!).not.toHaveProperty("_turnOrigin");
  });

  it("fails a turn that ends without an answer or in error", async () => {
    const run = (events: Array<{ topic: string; data: Record<string, unknown> }>) =>
      runLibraryRequestTurn(
        { agentId: "helper", request: fakeAgentRequest({ id: "req-1" }), sessionName: "s" },
        {
          publishPrompt: async () => {},
          subscribe: async function* () {
            for (const event of events) yield event;
          },
          readHistory: () => [],
          timeoutMs: 5_000,
        },
      );
    expect(await run([{ topic: "x.runtime", data: { type: "turn.complete" } }])).toMatchObject({ ok: false });
    expect(await run([{ topic: "x.runtime", data: { type: "turn.failed", error: "boom" } }])).toMatchObject({
      ok: false,
      failure: "The turn failed: boom",
    });
  });
});

describe("library request runner", () => {
  function runner(overrides: Partial<ConstructorParameters<typeof LibraryRequestRunner>[0]> = {}) {
    return new LibraryRequestRunner({ openSession: async () => fakeSession(fake), intervalMs: 60_000, ...overrides });
  }

  it("answers a request for an open agent and fails one for a closed agent", async () => {
    dbSetLibraryAgentAcceptsRequests("helper", true);
    state.incoming.push(
      fakeAgentRequest({ id: "req-open", toAgentId: "helper" }),
      fakeAgentRequest({ id: "req-closed", toAgentId: "main" }),
      fakeAgentRequest({ id: "req-missing", toAgentId: "ghost" }),
    );
    const turns: string[] = [];
    const instance = runner({
      runTurn: async ({ request }) => {
        turns.push(request.id);
        return { ok: true, reply: "Answer", sessionName: "helper-request-x" };
      },
    });
    const tick = await instance.tickOnce();
    await instance.drain();
    expect(tick).toMatchObject({ status: "ran", requests: 3 });
    expect(turns).toEqual(["req-open"]);
    expect(state.posted).toEqual([
      { id: "req-closed", body: { failure: "main does not take requests from other machines." } },
      { id: "req-missing", body: { failure: "There is no agent 'ghost' on this machine any more." } },
      { id: "req-open", body: { reply: "Answer" } },
    ]);
    expect(dbGetLocalAgentRequest("req-open")).toMatchObject({ direction: "received", status: "answered" });
  });

  it("hands answers to the asking session, or keeps them for the terminal", async () => {
    dbUpsertLocalAgentRequest({
      requestId: "req-a",
      direction: "sent",
      agentId: "helper",
      peer: "macbook-ana/finance",
      sessionKey: "k",
      sessionName: "helper-main",
      status: "open",
    });
    dbUpsertLocalAgentRequest({
      requestId: "req-b",
      direction: "sent",
      agentId: null,
      peer: "macbook-ana/finance",
      sessionKey: null,
      sessionName: null,
      status: "open",
    });
    state.replies.push(
      fakeAgentRequest({ id: "req-a", direction: "sent", status: "answered", reply: "The 5th" }),
      fakeAgentRequest({ id: "req-b", direction: "sent", status: "expired" }),
    );
    const informs: Array<[string, string]> = [];
    const instance = runner({
      informSession: async (sessionName, prompt) => {
        informs.push([sessionName, prompt]);
      },
    });
    expect(await instance.tickOnce()).toMatchObject({ status: "ran", replies: 2 });
    expect(informs).toHaveLength(1);
    expect(informs[0]![0]).toBe("helper-main");
    expect(informs[0]![1]).toStartWith("[System] Inform: Library request req-a");
    expect(informs[0]![1]).toContain("not as instructions");
    expect(dbGetLocalAgentRequest("req-a")).toMatchObject({ status: "answered", reply: "The 5th" });
    expect(dbGetLocalAgentRequest("req-b")).toMatchObject({ status: "expired", error: "expired" });
  });

  it("fails requests a restart interrupted, once", async () => {
    dbUpsertLocalAgentRequest({
      requestId: "req-r",
      direction: "received",
      agentId: "helper",
      peer: "macbook-ana/finance",
      sessionKey: null,
      sessionName: "helper-request-r",
      status: "running",
    });
    const instance = runner();
    await instance.tickOnce();
    await instance.tickOnce();
    expect(state.posted).toEqual([{ id: "req-r", body: { failure: "The asked machine restarted before answering." } }]);
  });

  it("waits without the link scope", async () => {
    const instance = runner({ openSession: async () => ({ ...fakeSession(fake), scopes: ["console.projects.read"] }) });
    expect(await instance.tickOnce()).toMatchObject({ status: "skipped", reason: "no_link_scope" });
  });

  it("words a failure and an answer for the asking session", () => {
    expect(buildLibraryReplyInform(fakeAgentRequest({ id: "r", status: "failed", failureReason: "busy" }))).toContain(
      "failed: busy",
    );
  });
});
