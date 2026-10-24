import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyWebFilters,
  parseSessionSpec,
  RAVI_SESSION_CALLBACK_ENV,
  RAVI_SESSION_TOKEN_ENV,
  type RaviSessionEventEntry,
  type RaviSessionSpec,
  type RunAgentTurn,
  readWorkerSessionEnv,
  runWorkerSession,
  toolPermission,
  WorkerSessionError,
} from "./worker-session.js";

const CALLBACK =
  "https://console.example.test/api/cloud-agents/ravi-provider/sessions/0b0c0d0e-0000-4000-8000-000000000001";
const TOKEN = "test-session-token-0123456789";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The Console's sealed spec as `GET inbox?spec=1` returns it (provider types). */
function consoleSpec(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "ravi_agent_1",
    agentVersion: 1,
    title: "triage run",
    agent: {
      name: "triage",
      description: "",
      system: "You triage requests.",
      model: "claude-sonnet-4-5",
      effort: "medium",
      webSearch: true,
      webFetch: true,
      web: { allowedDomains: ["docs.example.test"], blockedDomains: [] },
      mcpServers: [
        {
          name: "ravi",
          url: "https://console.example.test/api/mcp",
          permission: "ask",
          allowTools: ["ravi_projects_list"],
          askTools: [],
        },
      ],
      skills: [],
      officeSkills: [],
      customTools: [{ name: "ask_human", description: "Ask the person.", inputSchema: { type: "object" } }],
      workflows: false,
      metadata: {},
    },
    environment: { name: "env", type: "cloud", networking: "limited", allowedHosts: [], packages: {}, metadata: {} },
    skills: [
      {
        skillId: "s1",
        version: "1",
        directory: "triage-rules",
        displayTitle: "Rules",
        files: [{ path: "SKILL.md", content: "# Rules" }],
      },
      {
        skillId: "s2",
        version: "1",
        directory: "../escape",
        displayTitle: "Bad",
        files: [{ path: "SKILL.md", content: "x" }],
      },
      {
        skillId: "s3",
        version: "1",
        directory: "ok",
        displayTitle: "Bad path",
        files: [{ path: "../../etc/x", content: "x" }],
      },
    ],
    vaultIds: ["ravi_vault_1"],
    budgetCents: 500,
    resources: [],
    metadata: {},
    credentials: [
      {
        serverUrl: "https://console.example.test/api/mcp",
        accessToken: "mcp-access-token-1",
        accessTokenExpiresAt: "2026-10-23T11:00:00.000Z",
        refreshToken: "r",
        clientId: "c",
        tokenEndpoint: "https://console.example.test/oauth/token",
        vaultId: "ravi_vault_1",
        credentialId: "cred_1",
      },
    ],
    ...overrides,
  };
}

interface FakeCallback {
  fetch: typeof globalThis.fetch;
  inbox: Array<Record<string, unknown>>;
  events: RaviSessionEventEntry[];
  usage: Record<string, unknown> | null;
  outputs: Array<{ name: string | null; type: string | null; bytes: number }>;
  acked: string[];
  pulls: URL[];
  authorizations: Set<string | null>;
  status: string;
}

/**
 * A fake of the Console's callback routes. `react` runs after every events
 * post (the Console's side: approve, answer, end the session).
 */
function fakeCallback(input: {
  spec?: unknown;
  items?: Array<Record<string, unknown>>;
  react?: (fake: FakeCallback, posted: RaviSessionEventEntry[]) => void;
  inboxStatus?: number;
}): FakeCallback {
  let seq = 0;
  const fake: FakeCallback = {
    inbox: (input.items ?? []).map((item) => ({ id: `rvi_${++seq}`, at: "2026-10-23T10:00:00.000Z", ...item })),
    events: [],
    usage: null,
    outputs: [],
    acked: [],
    pulls: [],
    authorizations: new Set(),
    status: "idle",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      fake.authorizations.add(new Headers(init?.headers).get("authorization"));
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (parsed.pathname.endsWith("/inbox")) {
        fake.pulls.push(parsed);
        if (input.inboxStatus) return json(input.inboxStatus, { error: { code: "AUTH_REQUIRED" } });
        const acks = (parsed.searchParams.get("ack") ?? "").split(",").filter(Boolean);
        fake.acked.push(...acks);
        fake.inbox = fake.inbox.filter((item) => !acks.includes(String(item.id)));
        return json(200, {
          session: { id: "s1", status: fake.status },
          items: fake.inbox,
          ...(parsed.searchParams.get("spec") === "1" ? { spec: input.spec ?? consoleSpec() } : {}),
        });
      }
      if (parsed.pathname.endsWith("/events")) {
        if (fake.status === "terminated") return json(409, { error: { code: "cloud_run_not_active" } });
        const body = JSON.parse(String(init?.body)) as {
          events: RaviSessionEventEntry[];
          usage: Record<string, unknown>;
        };
        expect(Object.keys(body).sort()).toEqual(["events", "usage"]);
        fake.events.push(...body.events);
        fake.usage = body.usage;
        input.react?.(fake, body.events);
        return json(200, { accepted: body.events.length });
      }
      if (parsed.pathname.endsWith("/outputs")) {
        const bytes = new Uint8Array(
          await new Response(init?.body as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
        ).byteLength;
        const headers = new Headers(init?.headers);
        fake.outputs.push({ name: headers.get("x-ravi-output-name"), type: headers.get("content-type"), bytes });
        return json(201, { output: { id: "rvo_1" } });
      }
      return json(404, {});
    }) as typeof globalThis.fetch,
  };
  return fake;
}

const push = (fake: FakeCallback, item: Record<string, unknown>) =>
  fake.inbox.push({ id: `rvi_${fake.inbox.length + 100}_${Math.random().toString(36).slice(2, 6)}`, at: "x", ...item });

/** Ends the session after the first turn's final idle status. */
function endAfterTurn(fake: FakeCallback, posted: RaviSessionEventEntry[]) {
  const ran = fake.events.some((entry) => entry.event.kind === "status" && entry.event.status === "running");
  const done = posted.some(
    (entry) =>
      entry.event.kind === "status" &&
      entry.event.status === "idle" &&
      entry.event.stopReason?.type !== "requires_action",
  );
  if (ran && done) fake.status = "terminated";
}

function sessionEnv(): NodeJS.ProcessEnv {
  return {
    [RAVI_SESSION_CALLBACK_ENV]: CALLBACK,
    [RAVI_SESSION_TOKEN_ENV]: TOKEN,
    ANTHROPIC_API_KEY: "model-key",
    HOME: "/home/user",
  };
}

const quick = { sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)), pollMs: 1, log: () => {} };

describe("worker session environment and spec", () => {
  it("needs the callback URL and token, https (or local http), without credentials or a query", () => {
    expect(() => readWorkerSessionEnv({})).toThrow(WorkerSessionError);
    const invalid = (url: string) => () =>
      readWorkerSessionEnv({ [RAVI_SESSION_CALLBACK_ENV]: url, [RAVI_SESSION_TOKEN_ENV]: TOKEN });
    expect(invalid("http://console.example.test/x")).toThrow("must be an https URL");
    expect(invalid("https://u:p@console.example.test/x")).toThrow("must be an https URL");
    expect(invalid("https://console.example.test/x?a=1")).toThrow("must be an https URL");
    expect(
      readWorkerSessionEnv({
        [RAVI_SESSION_CALLBACK_ENV]: "http://localhost:3000/s/1/",
        [RAVI_SESSION_TOKEN_ENV]: TOKEN,
      }),
    ).toEqual({ callbackUrl: "http://localhost:3000/s/1", token: TOKEN });
  });

  it("parses the Console's spec: MCP credentials as headers, ask_human, budget and safe skills only", () => {
    const spec = parseSessionSpec(consoleSpec())!;
    expect(spec).toMatchObject({
      title: "triage run",
      model: "claude-sonnet-4-5",
      effort: "medium",
      askHuman: true,
      askHumanDescription: "Ask the person.",
      budgetUsd: 5,
      web: { allowedDomains: ["docs.example.test"], blockedDomains: [] },
    });
    expect(spec.mcpServers).toEqual([
      {
        name: "ravi",
        url: "https://console.example.test/api/mcp",
        headers: { Authorization: "Bearer mcp-access-token-1" },
        permission: "ask",
        allowTools: ["ravi_projects_list"],
        askTools: [],
      },
    ]);
    expect(spec.skills).toEqual([{ directory: "triage-rules", files: [{ path: "SKILL.md", content: "# Rules" }] }]);
    expect(parseSessionSpec({ agent: {} })).toBeNull();
    const plain = parseSessionSpec(
      consoleSpec({ budgetCents: 0, agent: { ...consoleSpec().agent, customTools: [] } }),
    )!;
    expect(plain.askHuman).toBe(false);
    expect(plain.budgetUsd).toBeNull();
  });

  it("tool permissions: built-ins run, MCP tools follow their server, unknown servers are refused", () => {
    const spec = parseSessionSpec(consoleSpec())!;
    expect(toolPermission(spec, "Bash")).toBe("allow");
    expect(toolPermission(spec, "mcp__ravi__ravi_projects_list")).toBe("allow");
    expect(toolPermission(spec, "mcp__ravi__ravi_pages_ship")).toBe("ask");
    expect(toolPermission(spec, "mcp__other__x")).toBe("deny");
    expect(toolPermission(spec, "mcp__ravi_session__ask_human")).toBe("allow");
    const allow: RaviSessionSpec = {
      ...spec,
      mcpServers: [{ ...spec.mcpServers[0]!, permission: "allow", askTools: ["ravi_mail_send"] }],
    };
    expect(toolPermission(allow, "mcp__ravi__ravi_pages_ship")).toBe("allow");
    expect(toolPermission(allow, "mcp__ravi__ravi_mail_send")).toBe("ask");
    expect(toolPermission({ ...spec, webSearch: false }, "WebSearch")).toBe("deny");
  });

  it("web filters: WebFetch outside the allowed domains is refused; WebSearch gets the list", () => {
    const spec = parseSessionSpec(consoleSpec())!;
    expect(applyWebFilters(spec, "WebFetch", { url: "https://evil.test/x" })).toMatchObject({ behavior: "deny" });
    expect(applyWebFilters(spec, "WebFetch", { url: "https://api.docs.example.test/x" })).toMatchObject({
      behavior: "allow",
    });
    expect(applyWebFilters(spec, "WebSearch", { query: "q" })).toEqual({
      behavior: "allow",
      updatedInput: { query: "q", allowed_domains: ["docs.example.test"] },
    });
    const blocked = { ...spec, web: { allowedDomains: [], blockedDomains: ["evil.test"] } };
    expect(applyWebFilters(blocked, "WebFetch", { url: "https://www.evil.test/" })).toMatchObject({ behavior: "deny" });

    // An entry with a path covers that path and below, on the domain and its subdomains.
    const paths = { ...spec, web: { allowedDomains: ["*.example.org/api"], blockedDomains: ["docs.test/private/"] } };
    const fetch = (url: string) => applyWebFilters(paths, "WebFetch", { url }).behavior;
    expect(fetch("https://example.org/api")).toBe("allow");
    expect(fetch("https://v2.example.org/api/users")).toBe("allow");
    expect(fetch("https://example.org/apikeys")).toBe("deny");
    expect(fetch("https://example.org/")).toBe("deny");
    const blockedPath = { ...spec, web: { allowedDomains: [], blockedDomains: ["docs.test/private/"] } };
    expect(applyWebFilters(blockedPath, "WebFetch", { url: "https://docs.test/private/x" }).behavior).toBe("deny");
    expect(applyWebFilters(blockedPath, "WebFetch", { url: "https://docs.test/public" }).behavior).toBe("allow");
  });
});

describe("runWorkerSession", () => {
  it("runs a turn, waits for a person on an ask tool, reports usage and acknowledges the inbox", async () => {
    const fake = fakeCallback({
      items: [{ type: "message", text: "Publish the weekly page" }],
      react: (state, posted) => {
        const waiting = posted.find(
          (entry) => entry.event.kind === "status" && entry.event.stopReason?.type === "requires_action",
        );
        if (waiting?.event.kind === "status" && waiting.event.stopReason?.type === "requires_action") {
          push(state, { type: "confirmation", toolUseId: waiting.event.stopReason.eventIds[0], allow: true });
        }
        endAfterTurn(state, posted);
      },
    });
    const env = sessionEnv();
    const seen: Array<Record<string, string>> = [];
    const decisions: unknown[] = [];
    const runTurn: RunAgentTurn = async function* (turn) {
      seen.push(turn.env);
      expect(turn.prompt).toBe("Publish the weekly page");
      expect(turn.maxBudgetUsd).toBe(5);
      yield { type: "system", session_id: "sdk-session-1" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "On it." }] } };
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "mcp__ravi__ravi_pages_ship", input: { title: "Weekly" } },
          ],
        },
      };
      decisions.push(
        await turn.canUseTool("mcp__ravi__ravi_pages_ship", { title: "Weekly" }, { toolUseID: "toolu_1" }),
      );
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "shipped" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.0421,
        duration_ms: 3_200,
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 1200,
            outputTokens: 300,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 10,
          },
        },
      };
    };
    const result = await runWorkerSession({ env, fetch: fake.fetch, runTurn, ...quick });

    expect(result).toMatchObject({ status: "terminated", turns: 1 });
    expect(decisions).toEqual([{ behavior: "allow", updatedInput: { title: "Weekly" } }]);
    // The agent never sees the callback credentials; the model key stays for the runtime.
    expect(env[RAVI_SESSION_TOKEN_ENV]).toBeUndefined();
    expect(seen[0]![RAVI_SESSION_TOKEN_ENV]).toBeUndefined();
    expect(seen[0]![RAVI_SESSION_CALLBACK_ENV]).toBeUndefined();
    expect(seen[0]!.ANTHROPIC_API_KEY).toBe("model-key");
    expect([...fake.authorizations]).toEqual([`Bearer ${TOKEN}`]);
    expect(fake.pulls[0]!.searchParams.get("spec")).toBe("1");
    expect(fake.acked.length).toBeGreaterThanOrEqual(2);

    const kinds = fake.events.map((entry) =>
      entry.event.kind === "status"
        ? `status:${entry.event.status}:${entry.event.stopReason?.type ?? "-"}`
        : entry.event.kind,
    );
    expect(kinds).toEqual([
      "status:idle:end_turn",
      "status:running:-",
      "message",
      "tool_use",
      "status:idle:requires_action",
      "status:running:-",
      "tool_result",
      "status:idle:end_turn",
    ]);
    const toolUse = fake.events.find((entry) => entry.event.kind === "tool_use")!;
    expect(toolUse).toMatchObject({
      id: "toolu_1",
      event: { tool: "ravi_pages_ship", server: "ravi", permission: "ask" },
    });
    expect(new Set(fake.events.map((entry) => entry.id)).size).toBe(fake.events.length);
    expect(fake.events.every((entry) => !entry.id.startsWith("rvc_"))).toBe(true);
    expect(fake.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      listCostCents: 4.21,
      activeSeconds: 3.2,
    });
  });

  it("a denied write is refused with the person's reason", async () => {
    const fake = fakeCallback({
      items: [{ type: "message", text: "Send the mail" }],
      react: (state, posted) => {
        for (const entry of posted) {
          if (entry.event.kind === "status" && entry.event.stopReason?.type === "requires_action") {
            push(state, {
              type: "confirmation",
              toolUseId: entry.event.stopReason.eventIds[0],
              allow: false,
              message: "not today",
            });
          }
        }
        endAfterTurn(state, posted);
      },
    });
    let decision: unknown;
    const runTurn: RunAgentTurn = async function* (turn) {
      decision = await turn.canUseTool("mcp__ravi__ravi_mail_send", {}, { toolUseID: "toolu_9" });
      decision = { first: decision, unknown: await turn.canUseTool("mcp__other__x", {}, { toolUseID: "toolu_10" }) };
      yield { type: "result", subtype: "success" };
    };
    await runWorkerSession({ env: sessionEnv(), fetch: fake.fetch, runTurn, ...quick });
    expect(decision).toEqual({
      first: { behavior: "deny", message: "A person denied this action: not today" },
      unknown: { behavior: "deny", message: "x is not available to this agent." },
    });
  });

  it("ask_human posts a custom_tool_use and returns the person's answer", async () => {
    const fake = fakeCallback({
      items: [{ type: "message", text: "Book the room" }],
      react: (state, posted) => {
        for (const entry of posted) {
          if (entry.event.kind === "custom_tool_use") {
            push(state, { type: "custom_tool_result", toolUseId: entry.id, text: "Room B", isError: false });
          }
        }
        endAfterTurn(state, posted);
      },
    });
    let answer = "";
    const runTurn: RunAgentTurn = async function* (turn) {
      answer = await turn.askHuman!({ question: "Which room?", options: ["Room A", "Room B"] });
      yield { type: "result", subtype: "success" };
    };
    await runWorkerSession({ env: sessionEnv(), fetch: fake.fetch, runTurn, ...quick });
    expect(answer).toBe("Room B");
    const asked = fake.events.find((entry) => entry.event.kind === "custom_tool_use")!;
    expect(asked.event).toEqual({
      kind: "custom_tool_use",
      tool: "ask_human",
      input: { question: "Which room?", options: ["Room A", "Room B"] },
    });
  });

  it("uploads the turn's outputs once, named in x-ravi-output-name", async () => {
    const outputsDir = mkdtempSync(join(tmpdir(), "ravi-session-outputs-"));
    tempDirs.push(outputsDir);
    const fake = fakeCallback({ items: [{ type: "message", text: "Write the report" }], react: endAfterTurn });
    const runTurn: RunAgentTurn = async function* () {
      mkdirSync(join(outputsDir, "charts"), { recursive: true });
      writeFileSync(join(outputsDir, "report.pdf"), "pdf-bytes");
      writeFileSync(join(outputsDir, "charts", "a.png"), "png");
      yield { type: "result", subtype: "success" };
    };
    const result = await runWorkerSession({ env: sessionEnv(), fetch: fake.fetch, runTurn, outputsDir, ...quick });
    expect(result.outputsUploaded).toBe(2);
    expect(fake.outputs).toEqual([
      { name: "charts%2Fa.png", type: "image/png", bytes: 3 },
      { name: "report.pdf", type: "application/pdf", bytes: 9 },
    ]);
  });

  it("a failed output upload is tried again before completion, or reported missing", async () => {
    const outputsDir = mkdtempSync(join(tmpdir(), "ravi-session-outputs-"));
    tempDirs.push(outputsDir);
    const runTurn: RunAgentTurn = async function* () {
      writeFileSync(join(outputsDir, "report.pdf"), "pdf-bytes");
      yield { type: "result", subtype: "success" };
    };
    /** Fails the first `times` output uploads with a 503. */
    const flaky = (fake: FakeCallback, times: number) => {
      let failures = 0;
      return (async (url: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(url)).pathname.endsWith("/outputs") && failures < times) {
          failures += 1;
          return new Response("{}", { status: 503 });
        }
        return fake.fetch(url, init);
      }) as typeof globalThis.fetch;
    };

    const recovers = fakeCallback({ items: [{ type: "message", text: "Write the report" }], react: endAfterTurn });
    await runWorkerSession({ env: sessionEnv(), fetch: flaky(recovers, 2), runTurn, outputsDir, ...quick });
    expect(recovers.outputs.map((output) => output.name)).toEqual(["report.pdf"]);
    expect(recovers.events.some((entry) => entry.event.kind === "error")).toBe(false);

    rmSync(join(outputsDir, "report.pdf"));
    const fails = fakeCallback({ items: [{ type: "message", text: "Write the report" }], react: endAfterTurn });
    await runWorkerSession({ env: sessionEnv(), fetch: flaky(fails, 99), runTurn, outputsDir, ...quick });
    const kinds = fails.events.map((entry) => entry.event.kind);
    const error = fails.events.find((entry) => entry.event.kind === "error")!;
    expect(error.event).toMatchObject({ errorType: "output_upload_failed", retrying: false });
    expect((error.event as { message: string }).message).toContain("report.pdf");
    // Reported before the final idle status.
    expect(kinds.lastIndexOf("error")).toBeLessThan(kinds.lastIndexOf("status"));
  });

  it("the final status a failed post kept goes out while the session is idle", async () => {
    const fake = fakeCallback({ items: [{ type: "message", text: "Hi" }], react: endAfterTurn });
    const runTurn: RunAgentTurn = async function* () {
      yield { type: "result", subtype: "success" };
    };
    let failNext = false;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith("/events")) {
        const body = JSON.parse(String(init?.body)) as { events: RaviSessionEventEntry[] };
        const final = body.events.some(
          (entry) => entry.event.kind === "status" && entry.event.status === "idle" && fake.events.length > 1,
        );
        // The first post carrying the turn's final status fails once.
        if (final && !failNext) {
          failNext = true;
          return new Response("{}", { status: 502 });
        }
      }
      return fake.fetch(url, init);
    }) as typeof globalThis.fetch;
    await runWorkerSession({ env: sessionEnv(), fetch, runTurn, ...quick });
    expect(failNext).toBe(true);
    const last = fake.events.at(-1)!;
    expect(last.event).toEqual({ kind: "status", status: "idle", stopReason: { type: "end_turn" } });
  });

  it("an interrupt aborts the running turn", async () => {
    const fake = fakeCallback({
      items: [{ type: "message", text: "Loop forever" }],
      react: (state, posted) => {
        if (posted.some((entry) => entry.event.kind === "status" && entry.event.status === "running")) {
          push(state, { type: "interrupt" });
        }
        endAfterTurn(state, posted);
      },
    });
    const runTurn: RunAgentTurn = async function* (turn) {
      await new Promise<void>((resolve) => turn.abortController.signal.addEventListener("abort", () => resolve()));
      yield { type: "result", subtype: "error_during_execution" };
    };
    await runWorkerSession({ env: sessionEnv(), fetch: fake.fetch, runTurn, ...quick });
    const last = fake.events.at(-1)!;
    expect(last.event).toEqual({ kind: "status", status: "idle", stopReason: { type: "other", raw: "interrupted" } });
  });

  it("a spent budget stops before the runtime starts", async () => {
    const fake = fakeCallback({
      spec: consoleSpec({ budgetCents: 1 }),
      items: [
        { type: "message", text: "a" },
        { type: "message", text: "b" },
      ],
    });
    let turns = 0;
    const runTurn: RunAgentTurn = async function* () {
      turns += 1;
      yield { type: "result", subtype: "success", total_cost_usd: 0.02 };
    };
    let posts = 0;
    const counted = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await fake.fetch(url, init);
      if (String(url).endsWith("/events")) {
        posts += 1;
        if (
          fake.events.some(
            (entry) => entry.event.kind === "status" && entry.event.stopReason?.type === "budget_reached",
          )
        ) {
          fake.status = "terminated";
        }
      }
      return response;
    }) as typeof globalThis.fetch;
    await runWorkerSession({ env: sessionEnv(), fetch: counted, runTurn, ...quick });
    expect(turns).toBe(1);
    expect(posts).toBeGreaterThan(0);
    expect(
      fake.events.some((entry) => entry.event.kind === "error" && entry.event.errorType === "budget_reached"),
    ).toBe(true);
  });

  it("a refused token on the first pull is SESSION_UNAUTHORIZED; a session gone later ends the loop", async () => {
    const refused = fakeCallback({ inboxStatus: 401 });
    await expect(runWorkerSession({ env: sessionEnv(), fetch: refused.fetch, ...quick })).rejects.toMatchObject({
      code: "SESSION_UNAUTHORIZED",
    });
    const fake = fakeCallback({});
    let pulls = 0;
    const gone = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/inbox") && ++pulls > 2) return new Response("{}", { status: 410 });
      return fake.fetch(url, init);
    }) as typeof globalThis.fetch;
    const result = await runWorkerSession({ env: sessionEnv(), fetch: gone, ...quick });
    expect(result).toMatchObject({ status: "terminated", turns: 0 });
  });
});
