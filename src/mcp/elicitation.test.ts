import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { setApprovalGrantorRouterConfigForTest } from "../channels/slack/grantors.js";
import { getContactDetails } from "../contacts.js";
import {
  MAX_PERSON_ANSWER_OPTION_LENGTH,
  MAX_PERSON_ANSWER_QUESTION_LENGTH,
  setApprovalServiceDependenciesForTest,
  type PersonAnswerRequest,
  type PersonAnswerResult,
} from "../approval/service.js";
import { getApprovalRequest } from "../approval/store.js";
import {
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_WA_OWNER_PHONE,
  seedApprovalContact,
} from "../approval/test-support.js";
import type { ConnectorTurn, ConnectorTurnResult } from "../link/connector-turn.js";
import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import { type ContextRecord, dbUpsertChat, dbUpsertChatParticipant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { SlackMcpElicitationAnswer, SlackMcpElicitationAsk } from "../channels/slack/mcp-elicitation.js";
import type { AuthorizeMcpUseDeps } from "./authorize.js";
import {
  createMcpElicitationHandler,
  isSecretLookingField,
  type McpElicitationDeps,
  type McpElicitationField,
  mcpElicitationPersonOfTurn,
  planMcpElicitation,
  readMcpFieldAnswer,
  validateMcpElicitationContent,
} from "./elicitation.js";
import { MAX_ELICITATION_LABEL_CHARS, quoteMcpServerText } from "./elicitation-form.js";
import { McpGateway, type McpElicitationRequest } from "./gateway.js";
import { attachMcpServer, createMcpServer, setMcpConfigChangedEmitterForTests } from "./registry-db.js";
import { writeMcpServerSecret } from "./secrets.js";
import { FIXTURE_STDIO_SERVER, type HttpFixture, startHttpFixture } from "./test-fixtures/servers.js";
import { type McpElicitationTraceInput, setMcpTraceSinksForTests } from "./trace.js";

const AGENT = "main";
const OWNER_JID = `${APPROVAL_TEST_WA_OWNER_PHONE}@s.whatsapp.net`;
const SECRET_VALUE = "Atlas-Project-Value-77";

let stateDir: string | null = null;
let fixture: HttpFixture | null = null;
let gateway: McpGateway | null = null;
let traces: McpElicitationTraceInput[] = [];
let operatorOwn = true;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-mcp-elicitation-");
  setMcpConfigChangedEmitterForTests(() => {});
  setPermissionAuditPublisherForTest(() => {});
  traces = [];
  operatorOwn = true;
  setMcpTraceSinksForTests({ call: () => {}, catalog: () => {}, elicitation: (input) => traces.push(input) });
});

afterEach(async () => {
  await gateway?.stop();
  gateway = null;
  await fixture?.close();
  fixture = null;
  setMcpTraceSinksForTests({ call: null, catalog: null, elicitation: null });
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  setApprovalServiceDependenciesForTest();
  setApprovalGrantorRouterConfigForTest();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const authorize: AuthorizeMcpUseDeps = {
  isOperatorOwnTurn: () => operatorOwn,
  canUseTool: () => true,
};

function context(
  source: ContextRecord["source"] | null = { channel: "whatsapp", accountId: "main", chatId: OWNER_JID },
) {
  return {
    contextId: "ctx_elicit",
    contextKey: "rctx_elicit",
    kind: "agent-runtime",
    agentId: AGENT,
    sessionKey: "agent:main:main",
    sessionName: "main-session",
    ...(source ? { source } : {}),
    capabilities: [],
    metadata: {},
    createdAt: Date.now(),
  } satisfies ContextRecord;
}

const ownerTurn = (contactId = "c_owner", conversation: ConnectorTurn["conversation"] = "dm"): ConnectorTurnResult => ({
  ok: true,
  turn: { speaker: { kind: "owner", contactId }, conversation, actorPrincipal: `contact:${contactId}` },
});

const contactCandidate = (contactId = "c_friend"): ConnectorTurnResult => ({
  ok: false,
  error: new Error("not the owner") as never,
  actorPrincipal: `contact:${contactId}`,
  candidate: { speaker: { kind: "contact", contactId }, conversation: "group", actorPrincipal: `contact:${contactId}` },
});

function registerOauth(name = "console", audience: "operator" | "any" = "operator") {
  createMcpServer({ name, transport: "http", url: `https://${name}.example.com/mcp`, authKind: "oauth" });
  attachMcpServer({ agentId: AGENT, server: name, audience });
}

function registerPlain(name = "open", audience: "operator" | "any" = "any") {
  createMcpServer({ name, transport: "http", url: `https://${name}.example.com/mcp`, authKind: "none" });
  attachMcpServer({ agentId: AGENT, server: name, audience });
}

const CONFIRM_FORM = {
  mode: "form",
  message: "Add a row to a view. Nothing changes until you confirm.",
  requestedSchema: {
    type: "object",
    properties: { confirm: { type: "boolean", title: "Apply this change", default: false } },
    required: ["confirm"],
  },
} as const;

const PROFILE_FORM = {
  mode: "form",
  message: "Tell us about the project",
  requestedSchema: {
    type: "object",
    properties: {
      project: { type: "string", title: "Project name", minLength: 3 },
      size: { type: "integer", title: "Team size", minimum: 1, maximum: 50 },
      tier: { type: "string", title: "Tier", enum: ["free", "pro"], enumNames: ["Free", "Pro"] },
      notes: { type: "string", title: "Notes" },
    },
    required: ["project", "size", "tier"],
  },
} as const;

interface Harness {
  asked: PersonAnswerRequest[];
  rows: Array<Record<string, unknown>>;
  settled: Array<Record<string, unknown>>;
  waits: string[];
  handler: ReturnType<typeof createMcpElicitationHandler>;
}

/** A handler whose person answers from a script, one entry per question. */
function harness(
  answers: Array<string | PersonAnswerResult>,
  overrides: Partial<McpElicitationDeps> & { turn?: ConnectorTurnResult } = {},
): Harness {
  const asked: PersonAnswerRequest[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  const waits: string[] = [];
  const { turn, ...deps } = overrides;
  const handler = createMcpElicitationHandler({
    authorize,
    resolveTurn: () => turn ?? ownerTurn(),
    resolveTarget: (input) => ({
      channel: input.channel,
      accountId: input.accountId,
      chatId: `${input.contactId}@dm`,
    }),
    ask: async (request) => {
      asked.push(request);
      const next = answers.shift();
      if (next === undefined) return { status: "timeout", messageId: "q", reason: "expired", ignoredAnswers: 0 };
      if (typeof next !== "string") return next;
      const isChoice = (request.options ?? []).some((option) => option.toLowerCase() === next.toLowerCase());
      return {
        status: "answered",
        messageId: `q_${asked.length}`,
        contactId: request.expectedActor.contactId,
        answer: isChoice ? { kind: "choice", label: next } : { kind: "text", text: next },
        ignoredAnswers: 0,
      };
    },
    createRow: (input) => {
      rows.push(input as unknown as Record<string, unknown>);
    },
    settleRow: (input) => {
      settled.push(input as unknown as Record<string, unknown>);
    },
    newId: () => "row_1",
    ...deps,
  });
  return { asked, rows, settled, waits, handler };
}

function request(
  server: string,
  params: unknown,
  extra: Partial<McpElicitationRequest> & { waits?: string[]; ctx?: ContextRecord | null } = {},
): McpElicitationRequest {
  const { waits, ctx, ...rest } = extra;
  return {
    scope: {
      context: ctx === undefined ? context() : ctx,
      agentId: AGENT,
      ...(waits ? { approvalWait: { begin: () => waits.push("begin"), end: () => waits.push("end") } } : {}),
    },
    server,
    tool: "write_row",
    era: "modern",
    key: "confirm",
    params: params as McpElicitationRequest["params"],
    deadline: Date.now() + 120_000,
    ...rest,
  };
}

describe("planning a request", () => {
  it("declines secret-looking fields before anything is asked", () => {
    const form = (property: Record<string, unknown>, name = "value") =>
      planMcpElicitation({
        mode: "form",
        message: "m",
        requestedSchema: { type: "object", properties: { [name]: property } },
      });
    expect(form({ type: "string" }, "password")).toMatchObject({ ok: false, code: "secret_field" });
    expect(form({ type: "string", title: "API Token" })).toMatchObject({ ok: false, code: "secret_field" });
    expect(form({ type: "string" }, "zip_code")).toMatchObject({ ok: false, code: "secret_field" });
    expect(form({ type: "string" }, "cardNumber")).toMatchObject({ ok: false, code: "secret_field" });
    expect(form({ type: "string", format: "password" })).toMatchObject({ ok: false, code: "secret_field" });
    expect(form({ type: "string" }, "otp_value")).toMatchObject({ ok: false, code: "secret_field" });
    expect(form({ type: "string", title: "CVV" })).toMatchObject({ ok: false, code: "secret_field" });
    expect(isSecretLookingField("project", { type: "string", title: "Project" })).toBe(false);
  });

  it("declines forms Ravi does not serve", () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(planMcpElicitation({ mode: "form", requestedSchema: { type: "object", properties: many } })).toMatchObject({
      ok: false,
      code: "too_many_fields",
      fieldCount: 9,
    });
    const nested = { type: "object", properties: { a: { type: "object", properties: {} } } };
    expect(planMcpElicitation({ mode: "form", requestedSchema: nested })).toMatchObject({ code: "unsupported_form" });
    const array = { type: "object", properties: { a: { type: "array", items: { enum: ["x"] } } } };
    expect(planMcpElicitation({ mode: "form", requestedSchema: array })).toMatchObject({ code: "unsupported_form" });
    const pattern = { type: "object", properties: { a: { type: "string", pattern: "^(a+)+$" } } };
    expect(planMcpElicitation({ mode: "form", requestedSchema: pattern })).toMatchObject({ code: "unsupported_form" });
    const badRequired = { type: "object", properties: { a: { type: "string" } }, required: ["b"] };
    expect(planMcpElicitation({ mode: "form", requestedSchema: badRequired })).toMatchObject({
      code: "unsupported_form",
    });
    const badName = { type: "object", properties: { "a b": { type: "string" } } };
    expect(planMcpElicitation({ mode: "form", requestedSchema: badName })).toMatchObject({ code: "unsupported_form" });
    expect(planMcpElicitation({ mode: "sampling" })).toMatchObject({ ok: false, code: "unsupported_request" });
    expect(planMcpElicitation(null)).toMatchObject({ ok: false, code: "unsupported_request" });
  });

  it("accepts only an https URL without userinfo in URL mode", () => {
    const url = (value: string) => planMcpElicitation({ mode: "url", message: "Set the key", url: value });
    const ok = url("https://console.example.com/acme/secrets?x=1");
    expect(ok.ok && ok.mode === "url" && ok.url.host).toBe("console.example.com");
    expect(url("http://console.example.com/secrets")).toMatchObject({ ok: false, code: "unsafe_url" });
    expect(url("https://user:pass@console.example.com/")).toMatchObject({ ok: false, code: "unsafe_url" });
    expect(url("https://user@console.example.com/")).toMatchObject({ ok: false, code: "unsafe_url" });
    expect(url("javascript:alert(1)")).toMatchObject({ ok: false, code: "unsafe_url" });
    expect(url("not a url")).toMatchObject({ ok: false, code: "unsafe_url" });
  });
});

describe("validating answers against requestedSchema", () => {
  const plan = planMcpElicitation(PROFILE_FORM);
  if (!plan.ok || plan.mode !== "form") throw new Error("profile form must plan");
  const field = (name: string) => plan.fields.find((entry) => entry.name === name) as McpElicitationField;

  it("reads each kind and refuses what the schema does not allow", () => {
    expect(readMcpFieldAnswer(field("project"), "Atlas")).toEqual({ ok: true, value: "Atlas" });
    expect(readMcpFieldAnswer(field("project"), "At")).toMatchObject({ ok: false });
    expect(readMcpFieldAnswer(field("size"), "12")).toEqual({ ok: true, value: 12 });
    expect(readMcpFieldAnswer(field("size"), "1.5")).toMatchObject({ ok: false, hint: "um número inteiro" });
    expect(readMcpFieldAnswer(field("size"), "99")).toMatchObject({ ok: false, hint: "no máximo 50" });
    expect(readMcpFieldAnswer(field("size"), "twelve")).toMatchObject({ ok: false });
    expect(readMcpFieldAnswer(field("tier"), "Pro")).toEqual({ ok: true, value: "pro" });
    expect(readMcpFieldAnswer(field("tier"), "1")).toEqual({ ok: true, value: "free" });
    expect(readMcpFieldAnswer(field("tier"), "enterprise")).toMatchObject({ ok: false });
    expect(readMcpFieldAnswer(field("notes"), "-")).toEqual({ ok: true, skip: true });
    // A required field is never skipped: "-" is an answer like any other, and too short here.
    expect(readMcpFieldAnswer(field("project"), "-")).toMatchObject({ ok: false });

    const confirm = planMcpElicitation(CONFIRM_FORM);
    if (!confirm.ok || confirm.mode !== "form") throw new Error("confirm form must plan");
    expect(readMcpFieldAnswer(confirm.fields[0]!, "nao")).toEqual({ ok: true, value: false });
    expect(readMcpFieldAnswer(confirm.fields[0]!, "Sim")).toEqual({ ok: true, value: true });

    const formats = planMcpElicitation({
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          day: { type: "string", format: "date" },
          at: { type: "string", format: "date-time" },
          site: { type: "string", format: "uri" },
        },
      },
    });
    if (!formats.ok || formats.mode !== "form") throw new Error("formats must plan");
    const [email, day, at, site] = formats.fields as [
      McpElicitationField,
      McpElicitationField,
      McpElicitationField,
      McpElicitationField,
    ];
    expect(readMcpFieldAnswer(email, "ana@example.com")).toMatchObject({ ok: true });
    expect(readMcpFieldAnswer(email, "ana")).toMatchObject({ ok: false });
    expect(readMcpFieldAnswer(day, "2026-02-30")).toMatchObject({ ok: false });
    expect(readMcpFieldAnswer(day, "2026-02-28")).toMatchObject({ ok: true });
    expect(readMcpFieldAnswer(at, "2026-02-28T10:00Z")).toMatchObject({ ok: true });
    expect(readMcpFieldAnswer(at, "tomorrow")).toMatchObject({ ok: false });
    expect(readMcpFieldAnswer(site, "https://example.com/x")).toMatchObject({ ok: true });
    expect(readMcpFieldAnswer(site, "example")).toMatchObject({ ok: false });
  });

  it("checks the whole content before it is sent", () => {
    expect(validateMcpElicitationContent(plan.fields, { project: "Atlas", size: 3, tier: "pro" })).toBe(true);
    expect(validateMcpElicitationContent(plan.fields, { project: "Atlas", size: 3 })).toBe(false);
    expect(validateMcpElicitationContent(plan.fields, { project: "Atlas", size: 3, tier: "gold" })).toBe(false);
    expect(validateMcpElicitationContent(plan.fields, { project: "Atlas", size: "3", tier: "pro" })).toBe(false);
    expect(validateMcpElicitationContent(plan.fields, { project: "Atlas", size: 3, tier: "pro", extra: 1 })).toBe(
      false,
    );
    expect(validateMcpElicitationContent(plan.fields, { project: "At", size: 3, tier: "pro" })).toBe(false);
  });
});

describe("who is asked", () => {
  it("names a person only for a resolved speaker in a direct chat or group", () => {
    expect(mcpElicitationPersonOfTurn(ownerTurn("c_owner"))).toEqual({ contactId: "c_owner", operator: true });
    expect(mcpElicitationPersonOfTurn(contactCandidate("c_friend"))).toEqual({
      contactId: "c_friend",
      operator: false,
    });
  });

  const noPersonTurns: Array<[string, ConnectorTurnResult]> = [
    [
      "cron",
      {
        ok: true,
        turn: {
          speaker: { kind: "automation" },
          conversation: "automation",
          routine: { kind: "cron", id: "job1" },
          actorPrincipal: "automation:cron:job1",
        },
      },
    ],
    [
      "heartbeat",
      {
        ok: true,
        turn: {
          speaker: { kind: "automation" },
          conversation: "automation",
          routine: { kind: "heartbeat" },
          actorPrincipal: "automation:heartbeat",
        },
      },
    ],
    [
      "trigger",
      {
        ok: false,
        error: new Error("trigger") as never,
        actorPrincipal: "automation:trigger:t1",
        triggerOwner: {
          id: "t1",
          ownerPrincipal: "operator",
          actsAsOperator: true,
          ownSession: true,
          answersToOwner: true,
        },
      },
    ],
    [
      "agent relay",
      {
        ok: false,
        error: new Error("relay") as never,
        actorPrincipal: "agent:other",
        delegatedRequester: {
          speaker: { kind: "owner", contactId: "c_owner" },
          conversation: "dm",
          actorPrincipal: "contact:c_owner",
        },
      },
    ],
    ["unknown", { ok: false, error: new Error("unknown") as never, actorPrincipal: "unknown" }],
    [
      "operator relay (no contact)",
      {
        ok: true,
        turn: { speaker: { kind: "owner" }, conversation: "terminal", actorPrincipal: "automation:operator:local" },
      },
    ],
    [
      "terminal",
      { ok: true, turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" } },
    ],
    ["delivery turn", { ok: false, error: new Error("delivery") as never, actorPrincipal: "automation:mcp-call:mc_1" }],
    [
      "ended",
      {
        ok: false,
        error: new Error("ended") as never,
        actorPrincipal: "contact:c_owner",
        ended: true,
        candidate: {
          speaker: { kind: "owner", contactId: "c_owner" },
          conversation: "dm",
          actorPrincipal: "contact:c_owner",
        },
      },
    ],
  ];

  for (const [name, turn] of noPersonTurns) {
    it(`declines a ${name} turn with nothing sent and no row`, async () => {
      registerPlain("open", "any");
      const h = harness(["Sim", "Enviar"], { turn });
      const result = await h.handler(request("open", CONFIRM_FORM));
      expect(result).toEqual({ action: "decline" });
      expect(h.asked).toEqual([]);
      expect(h.rows).toEqual([]);
      expect(traces[0]).toMatchObject({ action: "decline", reason: "no_person", questions: 0 });
    });
  }

  it("declines a contact's turn on a server that holds the operator's credential", async () => {
    registerOauth("console", "any");
    const h = harness(["Sim", "Enviar"], { turn: contactCandidate() });
    // A modern credentialed row widened to any: authorization lets the contact call, but nobody is asked.
    const result = await h.handler(request("console", CONFIRM_FORM));
    expect(result).toEqual({ action: "decline" });
    expect(h.asked).toEqual([]);
    expect(traces[0]).toMatchObject({ reason: "not_credential_principal" });
  });

  it("asks a contact on an audience-any server that holds no credential", async () => {
    registerPlain("open", "any");
    operatorOwn = false;
    const h = harness(["Sim"], { turn: contactCandidate("c_friend") });
    const result = await h.handler(request("open", CONFIRM_FORM));
    expect(result).toEqual({ action: "accept", content: { confirm: true } });
    expect(h.asked.map((entry) => entry.expectedActor.contactId)).toEqual(["c_friend"]);
  });

  it("declines a server with stored env values for a contact (they count as a credential)", async () => {
    createMcpServer({ name: "local", transport: "stdio", command: "/bin/true", envKeys: ["API_KEY"] });
    attachMcpServer({ agentId: AGENT, server: "local", audience: "any" });
    const h = harness(["Sim", "Enviar"], { turn: contactCandidate() });
    const result = await h.handler({ ...request("local", CONFIRM_FORM), era: "modern" });
    expect(result).toEqual({ action: "decline" });
    expect(h.asked).toEqual([]);
  });

  it("declines without a private surface: Slack, no source, no direct chat", async () => {
    registerOauth();
    const slack = harness(["Sim", "Enviar"]);
    expect(
      await slack.handler(
        request("console", CONFIRM_FORM, { ctx: context({ channel: "slack", accountId: "ws", chatId: "D1" }) }),
      ),
    ).toEqual({ action: "decline" });
    const noSource = harness(["Sim", "Enviar"]);
    expect(await noSource.handler(request("console", CONFIRM_FORM, { ctx: context(null) }))).toEqual({
      action: "decline",
    });
    const noChat = harness(["Sim", "Enviar"], { resolveTarget: () => null });
    expect(await noChat.handler(request("console", CONFIRM_FORM))).toEqual({ action: "decline" });
    expect([...slack.asked, ...noSource.asked, ...noChat.asked]).toEqual([]);
    expect(traces.map((trace) => trace.reason)).toEqual([
      "no_private_surface",
      "no_private_surface",
      "no_private_surface",
    ]);
  });

  it("declines when the call is not authorized on the elicitation surface", async () => {
    registerOauth();
    operatorOwn = false;
    const h = harness(["Sim", "Enviar"]);
    expect(await h.handler(request("console", CONFIRM_FORM))).toEqual({ action: "decline" });
    expect(await h.handler(request("console", CONFIRM_FORM, { ctx: null }))).toEqual({ action: "decline" });
    expect(h.asked).toEqual([]);
    expect(traces.map((trace) => trace.reason)).toEqual(["not_authorized", "not_authorized"]);
  });
});

describe("asking the operator", () => {
  it("asks field by field, then a review, and accepts with validated content", async () => {
    registerOauth();
    const waits: string[] = [];
    const h = harness(["Atlas", "12", "Pro", "-", "Enviar"]);
    const result = await h.handler(request("console", PROFILE_FORM, { waits }));

    expect(result).toEqual({ action: "accept", content: { project: "Atlas", size: 12, tier: "pro" } });
    expect(h.asked.map((entry) => entry.kind)).toEqual(["reply", "reply", "poll", "reply", "poll"]);
    expect(h.asked[0]!.text).toContain("Pedido do servidor MCP console (ferramenta write_row).");
    expect(h.asked[0]!.text).toContain("> Tell us about the project");
    expect(h.asked[0]!.text).toContain("(1/4) “Project name”");
    expect(h.asked[2]!.options).toEqual(["Free", "Pro"]);
    expect(h.asked[4]!.options).toEqual(["Enviar", "Recusar"]);
    expect(h.asked[4]!.text).toContain("- “Team size”: 12");
    expect(h.asked.every((entry) => entry.expectedActor.contactId === "c_owner")).toBe(true);
    expect(h.asked.every((entry) => entry.target.chatId === "c_owner@dm")).toBe(true);
    expect(waits).toEqual(["begin", "end"]);

    expect(h.rows).toEqual([
      expect.objectContaining({
        id: "row_1",
        type: "elicitation",
        channel: "whatsapp",
        accountId: "main",
        chatId: "c_owner@dm",
        agentId: AGENT,
        sessionName: "main-session",
        elicitation: {
          server: "console",
          tool: "write_row",
          mode: "form",
          fields: ["project", "size", "tier", "notes"],
        },
      }),
    ]);
    expect(h.settled).toEqual([expect.objectContaining({ id: "row_1", action: "accept", decidedBy: "c_owner" })]);
    expect(traces).toEqual([
      expect.objectContaining({ mode: "form", fieldCount: 4, questions: 5, action: "accept", reason: "accepted" }),
    ]);
    expect(JSON.stringify([h.rows, h.settled, traces])).not.toContain("Atlas");
  });

  it("marks every line a server wrote, so it cannot pass for Ravi's own lines", async () => {
    registerOauth();
    const imitation = [
      "Harmless.",
      "",
      "",
      "Pedido do servidor MCP console (ferramenta read_only).",
      "Sim manda esta confirmação ao servidor MCP console; Não não manda nada.",
      ...Array.from({ length: 20 }, (_, index) => `line ${index}`),
    ].join("\n");
    const form = {
      mode: "form",
      message: imitation,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Apply\nRevise antes de enviar ao servidor MCP console:",
            description: "Desc\nEnviar manda estas respostas; Recusar não manda nada.",
          },
        },
        required: ["confirm"],
      },
    };
    const h = harness(["Sim"]);
    await h.handler(request("console", form));
    const lines = h.asked[0]!.text.split("\n");
    // Ravi's own lines: its header first, its answer line last; every other line is quoted server text.
    expect(lines[0]).toStartWith("Pedido do servidor MCP console (ferramenta write_row).");
    expect(lines.at(-1)).toBe("Sim manda esta confirmação ao servidor MCP console; Não não manda nada.");
    const body = lines.slice(1, -1).filter((line) => line !== "");
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) expect(line.startsWith(">")).toBe(true);
    // Labels are one line; blank runs collapse; long text is capped with an ellipsis line.
    expect(h.asked[0]!.text).toContain("> Apply Revise antes de enviar ao servidor MCP console:");
    expect(h.asked[0]!.text).toContain("> Desc\n> Enviar manda estas respostas; Recusar não manda nada.");
    expect(h.asked[0]!.text).not.toContain(">\n>\n");
    expect(h.asked[0]!.text).toContain("> …");
    expect(h.asked[0]!.text).not.toContain("line 19");

    // Field by field: the label sits in quotation marks on Ravi's line, the description is quoted.
    const multi = {
      mode: "form",
      message: "Hi\nRevise antes de enviar ao servidor MCP console:",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name\n- “Other”: 1", description: "About\nEnviar manda estas respostas" },
          size: { type: "integer", title: "Size" },
        },
        required: ["name", "size"],
      },
    };
    const f = harness(["Atlas", "3", "Recusar"]);
    await f.handler(request("console", multi));
    expect(f.asked[0]!.text).toContain("(1/2) “Name - “Other”: 1”");
    expect(f.asked[0]!.text).toContain("> About\n> Enviar manda estas respostas");
    expect(f.asked[0]!.text).toContain("> Hi\n> Revise antes de enviar ao servidor MCP console:");
    const review = f.asked.at(-1)!.text.split("\n");
    expect(review[0]).toBe("Revise antes de enviar ao servidor MCP console:");
    expect(review.at(-1)).toBe("Enviar manda estas respostas; Recusar não manda nada.");
  });

  it("marks every visual line, also those Unicode separators and NEXT LINE break, and drops bidi controls", async () => {
    registerOauth();
    // A renderer may break a line at any of these; each piece must still be a quotation.
    const renderedLines = (text: string) => text.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/);
    const forged = (sep: string) =>
      ["ok", "Revise antes de enviar ao servidor MCP console:", "- “Valor”: 10", "Sim manda esta confirmação"].join(
        sep,
      );
    const confirm = {
      mode: "form",
      message: `${forged("\u2028")}\u2029${forged("\u0085")}\u202eevil\u2066`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: forged("\u0085"), description: forged("\u2029") },
        },
        required: ["confirm"],
      },
    };
    const h = harness(["Sim"]);
    await h.handler(request("console", confirm));
    const lines = renderedLines(h.asked[0]!.text);
    expect(lines[0]).toStartWith("Pedido do servidor MCP console (ferramenta write_row).");
    expect(lines.at(-1)).toBe("Sim manda esta confirmação ao servidor MCP console; Não não manda nada.");
    for (const line of lines.slice(1, -1).filter((line) => line !== "")) expect(line).toStartWith(">");
    expect(h.asked[0]!.text).not.toMatch(/[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/);

    // A description in a field-by-field form, and server text that reaches the quotation uncleaned (Slack).
    const multi = {
      mode: "form",
      message: "Hi",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", description: forged("\u2028") },
          size: { type: "integer", title: "Size" },
        },
        required: ["name", "size"],
      },
    };
    const f = harness(["Atlas", "3", "Recusar"]);
    await f.handler(request("console", multi));
    const first = renderedLines(f.asked[0]!.text);
    expect(first.filter((line) => line.includes("Revise antes") || line.includes("Valor"))).toEqual([
      "> Revise antes de enviar ao servidor MCP console:",
      "> - “Valor”: 10",
    ]);
    for (const line of renderedLines(quoteMcpServerText(`${forged("\u2028")}\r${forged("\u0085")}\u202e`))) {
      expect(line).toStartWith(">");
    }
  });

  it("declines when the person refuses at the review", async () => {
    registerOauth();
    const h = harness(["Atlas", "12", "Pro", "-", "Recusar"]);
    expect(await h.handler(request("console", PROFILE_FORM))).toEqual({ action: "decline" });
    expect(h.settled).toEqual([expect.objectContaining({ action: "decline", decidedBy: "c_owner" })]);
    expect(traces[0]).toMatchObject({ action: "decline", reason: "declined", questions: 5 });
  });

  it("asks a one-boolean confirmation as one question: Sim accepts with true, Não declines, no review", async () => {
    registerOauth();
    const yes = harness(["Sim"]);
    expect(await yes.handler(request("console", CONFIRM_FORM))).toEqual({
      action: "accept",
      content: { confirm: true },
    });
    expect(yes.asked).toHaveLength(1);
    expect(yes.asked[0]!.options).toEqual(["Sim", "Não"]);
    expect(yes.asked[0]!.text).toContain("Pedido do servidor MCP console (ferramenta write_row).");
    expect(yes.asked[0]!.text).toContain("> Add a row to a view. Nothing changes until you confirm.");
    expect(yes.asked[0]!.text).toContain("> Apply this change");
    expect(yes.asked[0]!.text).toContain("Sim manda esta confirmação ao servidor MCP console; Não não manda nada.");
    expect(traces[0]).toMatchObject({ action: "accept", reason: "accepted", questions: 1 });

    const no = harness(["Não"]);
    expect(await no.handler(request("console", CONFIRM_FORM))).toEqual({ action: "decline" });
    expect(no.asked).toHaveLength(1);
    expect(no.settled).toEqual([expect.objectContaining({ action: "decline", decidedBy: "c_owner" })]);
    expect(traces[1]).toMatchObject({ action: "decline", reason: "declined", questions: 1 });

    // An optional boolean, or a boolean beside other fields, keeps the field questions and the review.
    const optional = harness(["Sim", "Enviar"]);
    const optionalForm = {
      ...CONFIRM_FORM,
      requestedSchema: { ...CONFIRM_FORM.requestedSchema, required: [] },
    };
    expect(await optional.handler(request("console", optionalForm))).toEqual({
      action: "accept",
      content: { confirm: true },
    });
    expect(optional.asked).toHaveLength(2);
  });

  it("gives one round's questions one shared window, never past the call's budget", async () => {
    registerOauth();
    let clock = 1_000_000;
    const answerBy = clock + 4 * 60_000;
    const timeouts: number[] = [];
    // Each answer takes 100 s: the second question gets only what is left of the round.
    const h = harness([], {
      now: () => clock,
      ask: async (asked) => {
        timeouts.push(asked.timeoutMs ?? 0);
        clock += 100_000;
        return {
          status: "answered",
          messageId: `q_${timeouts.length}`,
          contactId: asked.expectedActor.contactId,
          answer: timeouts.length === 1 ? { kind: "text", text: "Atlas" } : { kind: "text", text: "12" },
          ignoredAnswers: 0,
        };
      },
    });
    const result = await h.handler(request("console", PROFILE_FORM, { deadline: clock + 30 * 60_000, answerBy }));
    expect(timeouts).toHaveLength(3);
    expect(timeouts[0]).toBe(4 * 60_000);
    expect(timeouts[1]).toBe(4 * 60_000 - 100_000);
    expect(timeouts[2]).toBe(4 * 60_000 - 200_000);
    // The fourth question would get less than the shortest wait: the round's time is up, nothing is sent.
    expect(result).toEqual({ action: "cancel" });
    expect(h.rows[0]).toMatchObject({ expiresAt: answerBy });

    // Without a round from the gateway, the handler still gives one round's time, not the call's whole budget.
    timeouts.length = 0;
    clock = 2_000_000;
    const alone = harness(["Sim"], { now: () => clock });
    await alone.handler(request("console", CONFIRM_FORM, { deadline: clock + 30 * 60_000 }));
    expect(alone.asked[0]!.timeoutMs).toBe(4 * 60_000);
  });

  it("asks again after an invalid answer, and cancels after a second one", async () => {
    registerOauth();
    const again = harness(["Atlas", "lots", "12", "Pro", "-", "Enviar"]);
    expect(await again.handler(request("console", PROFILE_FORM))).toEqual({
      action: "accept",
      content: { project: "Atlas", size: 12, tier: "pro" },
    });
    expect(again.asked[2]!.text).toContain("A resposta anterior não serviu: envie um número.");

    const twice = harness(["Atlas", "lots", "many"]);
    expect(await twice.handler(request("console", PROFILE_FORM))).toEqual({ action: "cancel" });
    expect(twice.settled).toEqual([expect.objectContaining({ action: "cancel" })]);
    expect(twice.settled[0]!.decidedBy).toBeUndefined();
    expect(traces[1]).toMatchObject({ action: "cancel", reason: "invalid_answer" });
  });

  it("answers cancel on a timeout, a send failure and a wrong actor, never content", async () => {
    registerOauth();
    const outcomes: PersonAnswerResult[] = [
      { status: "timeout", messageId: "q", reason: "expired", ignoredAnswers: 2 },
      { status: "send_failed", reason: "delivery_failed" },
      { status: "wrong_actor", reason: "target_not_actor_dm" },
    ];
    for (const outcome of outcomes) {
      const h = harness([outcome]);
      expect(await h.handler(request("console", CONFIRM_FORM))).toEqual({ action: "cancel" });
      expect(h.settled).toEqual([expect.objectContaining({ action: "cancel" })]);
    }
    expect(traces.map((trace) => trace.reason)).toEqual(["timeout", "send_failed", "wrong_actor"]);
  });

  it("cancels when the call is cancelled while the person is being asked", async () => {
    registerOauth();
    const controller = new AbortController();
    const waits: string[] = [];
    const h = harness([], {
      ask: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => {});
      },
    });
    const result = await h.handler(request("console", CONFIRM_FORM, { signal: controller.signal, waits }));
    expect(result).toEqual({ action: "cancel" });
    expect(waits).toEqual(["begin", "end"]);
    expect(traces[0]).toMatchObject({ reason: "cancelled" });
  });

  it("declines with nothing sent when the call has no time left to ask, and bounds each wait by the budget", async () => {
    registerOauth();
    const late = harness(["Sim", "Enviar"]);
    expect(await late.handler(request("console", CONFIRM_FORM, { deadline: Date.now() + 12_000 }))).toEqual({
      action: "decline",
    });
    expect(late.asked).toEqual([]);
    expect(traces[0]).toMatchObject({ reason: "no_time" });

    const bounded = harness(["Sim", "Enviar"]);
    await bounded.handler(request("console", CONFIRM_FORM, { deadline: Date.now() + 60_000 }));
    expect(bounded.asked[0]!.timeoutMs).toBeLessThanOrEqual(50_000);
    expect(bounded.asked[0]!.timeoutMs).toBeGreaterThan(40_000);
  });

  it("declines a secret-looking form and an unsafe URL before looking anyone up", async () => {
    registerOauth();
    const resolveTurn = () => {
      throw new Error("must not classify");
    };
    const h = harness([], { resolveTurn });
    const secret = {
      mode: "form",
      message: "m",
      requestedSchema: { type: "object", properties: { token: { type: "string" } } },
    };
    expect(await h.handler(request("console", secret))).toEqual({ action: "decline" });
    expect(await h.handler(request("console", { mode: "url", message: "go", url: "http://x.example.com" }))).toEqual({
      action: "decline",
    });
    expect(h.asked).toEqual([]);
    expect(traces.map((trace) => trace.reason)).toEqual(["secret_field", "unsafe_url"]);
  });

  it("URL mode shows the URL with its host on its own line and accepts on explicit consent, never fetching it", async () => {
    registerOauth();
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("");
    }) as typeof fetch;
    try {
      const url = "https://console.example.com/acme/p/p1/cloud/secrets";
      const h = harness(["Aceitar"]);
      const result = await h.handler(request("console", { mode: "url", message: "Cursor needs the key.", url }));
      expect(result).toEqual({ action: "accept" });
      expect(h.asked[0]!.text).toContain(`\n${url}\n`);
      expect(h.asked[0]!.text).toContain("\nconsole.example.com\n");
      expect(h.asked[0]!.options).toEqual(["Aceitar", "Recusar"]);
      expect(h.rows[0]).toMatchObject({ elicitation: { mode: "url", fields: [] } });
      expect(JSON.stringify([h.rows, traces])).not.toContain("secrets");

      const refused = harness(["Recusar"]);
      expect(await refused.handler(request("console", { mode: "url", message: "m", url }))).toEqual({
        action: "decline",
      });
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps values out of the stored row and the trace", async () => {
    registerOauth();
    const h = harness([SECRET_VALUE, "3", "Free", "-", "Enviar"], { createRow: undefined, settleRow: undefined });
    const result = await h.handler(request("console", PROFILE_FORM));
    expect(result).toMatchObject({ action: "accept", content: { project: SECRET_VALUE } });
    const row = getApprovalRequest("row_1");
    expect(row).toMatchObject({
      type: "elicitation",
      status: "decided",
      decision: "approved",
      decidedBy: "c_owner",
      elicitation: {
        server: "console",
        tool: "write_row",
        mode: "form",
        fields: ["project", "size", "tier", "notes"],
        action: "accept",
      },
    });
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(row)).not.toContain("Tell us about");
    expect(JSON.stringify(traces)).not.toContain(SECRET_VALUE);
  });
});

describe("asking on Slack", () => {
  const slackContext = () => context({ channel: "slack", accountId: "ws", instanceId: "ws", chatId: "C0ABC123" });
  const slackSurface = { accountId: "ws", instanceId: "ws", chatId: "C0ABC123", userId: "U0OWNER1" } as const;

  /** A handler whose Slack modal answers from one scripted outcome. */
  function slackHarness(answer: SlackMcpElicitationAnswer | Error, overrides: Partial<McpElicitationDeps> = {}) {
    const asks: SlackMcpElicitationAsk[] = [];
    const base = harness([], {
      resolveSlackSurface: () => slackSurface,
      askSlack: async (ask) => {
        asks.push(ask);
        if (answer instanceof Error) throw answer;
        return answer;
      },
      ...overrides,
    });
    return { ...base, asks };
  }

  it("asks the bound Slack user once, in one modal, and accepts validated content", async () => {
    registerOauth();
    const waits: string[] = [];
    const h = slackHarness({
      action: "accept",
      content: { project: "Atlas", size: 12, tier: "pro" },
      reason: "accepted",
    });
    const result = await h.handler(request("console", PROFILE_FORM, { waits, ctx: slackContext() }));

    expect(result).toEqual({ action: "accept", content: { project: "Atlas", size: 12, tier: "pro" } });
    // Nothing is asked as chat on Slack; the modal is the only question.
    expect(h.asked).toEqual([]);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({
      surface: slackSurface,
      server: "console",
      tool: "write_row",
      contactId: "c_owner",
      approvalId: "row_1",
      mode: "form",
      agentId: AGENT,
      sessionName: "main-session",
    });
    expect(h.asks[0]!.mode === "form" && h.asks[0]!.fields.map((field) => field.name)).toEqual([
      "project",
      "size",
      "tier",
      "notes",
    ]);
    expect(h.asks[0]!.deadline).toBeLessThan(Date.now() + 120_000);
    expect(waits).toEqual(["begin", "end"]);
    expect(h.rows).toEqual([
      expect.objectContaining({
        id: "row_1",
        type: "elicitation",
        channel: "slack",
        accountId: "ws",
        chatId: "C0ABC123",
        instanceId: "ws",
        elicitation: {
          server: "console",
          tool: "write_row",
          mode: "form",
          fields: ["project", "size", "tier", "notes"],
        },
      }),
    ]);
    expect(h.settled).toEqual([expect.objectContaining({ id: "row_1", action: "accept", decidedBy: "c_owner" })]);
    expect(traces).toEqual([
      expect.objectContaining({ mode: "form", fieldCount: 4, questions: 1, action: "accept", reason: "accepted" }),
    ]);
    expect(JSON.stringify([h.rows, h.settled, traces])).not.toContain("Atlas");
  });

  it("passes a URL request to the modal and accepts without content", async () => {
    registerOauth();
    const h = slackHarness({ action: "accept", reason: "accepted" });
    const url = "https://console.example.com/acme/p/p1/cloud/secrets";
    expect(await h.handler(request("console", { mode: "url", message: "m", url }, { ctx: slackContext() }))).toEqual({
      action: "accept",
    });
    expect(h.asks[0]).toMatchObject({ mode: "url", url });
    expect(h.rows[0]).toMatchObject({ elicitation: { mode: "url", fields: [] } });
  });

  it("carries the modal's own refusal, cancellation and failure", async () => {
    registerOauth();
    const declined = slackHarness({ action: "decline", reason: "declined" });
    expect(await declined.handler(request("console", CONFIRM_FORM, { ctx: slackContext() }))).toEqual({
      action: "decline",
    });
    expect(declined.settled[0]).toMatchObject({ action: "decline", decidedBy: "c_owner" });

    const timedOut = slackHarness({ action: "cancel", reason: "timeout" });
    expect(await timedOut.handler(request("console", CONFIRM_FORM, { ctx: slackContext() }))).toEqual({
      action: "cancel",
    });
    expect(timedOut.settled[0]!.decidedBy).toBeUndefined();

    const broken = slackHarness(new Error("slack is down"));
    expect(await broken.handler(request("console", CONFIRM_FORM, { ctx: slackContext() }))).toEqual({
      action: "cancel",
    });
    expect(traces.map((trace) => trace.reason)).toEqual(["declined", "timeout", "error"]);
  });

  it("cancels an accepted answer the schema does not allow", async () => {
    registerOauth();
    const h = slackHarness({
      action: "accept",
      content: { project: "Atlas", size: 999, tier: "pro" },
      reason: "accepted",
    });
    expect(await h.handler(request("console", PROFILE_FORM, { ctx: slackContext() }))).toEqual({ action: "cancel" });
    expect(traces[0]).toMatchObject({ action: "cancel", reason: "invalid_answer" });

    const extra = slackHarness({
      action: "accept",
      content: { project: "Atlas", size: 2, tier: "pro", surprise: "x" },
      reason: "accepted",
    });
    expect(await extra.handler(request("console", PROFILE_FORM, { ctx: slackContext() }))).toEqual({
      action: "cancel",
    });
  });

  it("declines when the person owns no Slack user in the workspace, with nothing asked", async () => {
    registerOauth();
    const h = slackHarness({ action: "accept", reason: "accepted" }, { resolveSlackSurface: () => null });
    expect(await h.handler(request("console", CONFIRM_FORM, { ctx: slackContext() }))).toEqual({ action: "decline" });
    expect(h.asks).toEqual([]);
    expect(h.rows).toEqual([]);
    expect(traces[0]).toMatchObject({ reason: "no_private_surface" });
  });

  it("never asks a Slack turn as chat, and never asks the Slack modal on another channel", async () => {
    registerOauth();
    const slack = slackHarness({ action: "accept", content: { confirm: true }, reason: "accepted" });
    await slack.handler(request("console", CONFIRM_FORM, { ctx: slackContext() }));
    expect(slack.asked).toEqual([]);

    const asks: SlackMcpElicitationAsk[] = [];
    const chat = harness(["Sim"], {
      resolveSlackSurface: () => slackSurface,
      askSlack: async (ask) => {
        asks.push(ask);
        return { action: "accept", reason: "accepted" };
      },
    });
    expect(await chat.handler(request("console", CONFIRM_FORM))).toEqual({
      action: "accept",
      content: { confirm: true },
    });
    expect(asks).toEqual([]);
    expect(chat.asked.map((entry) => entry.target.channel)).toEqual(["whatsapp"]);
  });
});

describe("through the person-bound answer service", () => {
  it("ignores another sender's reply and takes the operator's own, in their direct chat", async () => {
    registerOauth();
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
    const owner = seedApprovalContact({ phone: APPROVAL_TEST_WA_OWNER_PHONE, name: "Owner", tags: [] });
    seedApprovalContact({ phone: APPROVAL_TEST_STRANGER_PHONE, name: "Stranger", tags: [] });
    const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "main", platformChatId: OWNER_JID, chatType: "dm" });
    const identity = getContactDetails(owner.id)?.platformIdentities.find(
      (entry) => entry.normalizedPlatformUserId === APPROVAL_TEST_WA_OWNER_PHONE,
    );
    dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: owner.id,
      ...(identity ? { platformIdentityId: identity.id } : {}),
      rawPlatformUserId: APPROVAL_TEST_WA_OWNER_PHONE,
      normalizedPlatformUserId: APPROVAL_TEST_WA_OWNER_PHONE,
      role: "member",
      source: "inbound_message",
    });

    const sent: Array<Record<string, unknown>> = [];
    const events = [
      // q_1: the one-question confirmation; a stranger answers first, then the owner.
      {
        topic: "ravi.inbound.reply",
        data: { targetMessageId: "q_1", text: "1", senderId: APPROVAL_TEST_STRANGER_PHONE, accountId: "main" },
      },
      {
        topic: "ravi.inbound.reply",
        data: { targetMessageId: "q_1", text: "Sim", senderId: APPROVAL_TEST_WA_OWNER_PHONE, accountId: "main" },
      },
    ];
    setApprovalServiceDependenciesForTest({
      requestReply: (async <T>(_topic: string, data: Record<string, unknown>) => {
        sent.push(data);
        return { messageId: `q_${sent.length}` } as T;
      }) as never,
      nats: {
        emit: async () => {},
        subscribe: ((...topics: unknown[]) =>
          (async function* () {
            for (const event of events) if (topics.includes(event.topic)) yield event;
          })()) as never,
      },
    });

    const handler = createMcpElicitationHandler({
      authorize,
      resolveTurn: () => ownerTurn(owner.id),
      questionTimeoutMs: 1_000,
      minQuestionMs: 100,
    });
    const result = await handler(request("console", CONFIRM_FORM));

    expect(result).toEqual({ action: "accept", content: { confirm: true } });
    expect(sent).toHaveLength(1);
    expect(sent.every((entry) => entry.to === OWNER_JID && entry.channel === "whatsapp")).toBe(true);
    expect(String(sent[0]!.text)).toContain("Apply this change");
  });
});

describe("questions that fit what one person-bound question carries", () => {
  /** The owner's real direct chat, and a service whose owner answers each question in turn. */
  function ownerAnswers(replies: string[]): { ownerId: string; sent: Array<Record<string, unknown>> } {
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
    const owner = seedApprovalContact({ phone: APPROVAL_TEST_WA_OWNER_PHONE, name: "Owner", tags: [] });
    const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "main", platformChatId: OWNER_JID, chatType: "dm" });
    const identity = getContactDetails(owner.id)?.platformIdentities.find(
      (entry) => entry.normalizedPlatformUserId === APPROVAL_TEST_WA_OWNER_PHONE,
    );
    dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: owner.id,
      ...(identity ? { platformIdentityId: identity.id } : {}),
      rawPlatformUserId: APPROVAL_TEST_WA_OWNER_PHONE,
      normalizedPlatformUserId: APPROVAL_TEST_WA_OWNER_PHONE,
      role: "member",
      source: "inbound_message",
    });
    const sent: Array<Record<string, unknown>> = [];
    setApprovalServiceDependenciesForTest({
      requestReply: (async <T>(_topic: string, data: Record<string, unknown>) => {
        sent.push(data);
        return { messageId: `q_${sent.length}` } as T;
      }) as never,
      nats: {
        emit: async () => {},
        subscribe: ((...topics: unknown[]) => {
          const index = sent.length;
          return (async function* () {
            const text = replies[index - 1];
            if (text === undefined || !topics.includes("ravi.inbound.reply")) return;
            yield {
              topic: "ravi.inbound.reply",
              data: { targetMessageId: `q_${index}`, text, senderId: APPROVAL_TEST_WA_OWNER_PHONE, accountId: "main" },
            };
          })();
        }) as never,
      },
    });
    return { ownerId: owner.id, sent };
  }

  function realHandler(ownerId: string) {
    return createMcpElicitationHandler({
      authorize,
      resolveTurn: () => ownerTurn(ownerId),
      questionTimeoutMs: 1_000,
      minQuestionMs: 100,
    });
  }

  it("cuts an enum choice longer than 100 characters to a label that is sent, and reads numeric labels as labels", async () => {
    registerOauth();
    const long = "x".repeat(120);
    // q_1: the long choice by position; q_2: the label "1" (not the first choice "5"); q_3: the review.
    const { ownerId, sent } = ownerAnswers(["1", "1", "enviar"]);
    const result = await realHandler(ownerId)(
      request("console", {
        mode: "form",
        message: "Pick a plan",
        requestedSchema: {
          type: "object",
          properties: {
            plan: { type: "string", title: "Plan", enum: [long, "short"] },
            seats: { type: "string", title: "Seats", enum: ["5", "10", "1"] },
          },
          required: ["plan", "seats"],
        },
      }),
    );

    expect(result).toEqual({ action: "accept", content: { plan: long, seats: "1" } });
    expect(sent).toHaveLength(3);
    const firstQuestion = String(sent[0]!.text);
    const shown = firstQuestion.split("\n").find((line) => line.startsWith("1. "));
    expect(shown?.length).toBe("1. ".length + 100);
    expect(shown?.endsWith("…")).toBe(true);
    expect(traces[0]).toMatchObject({ action: "accept", reason: "accepted" });
  });

  it("sends a URL question with a long message and a 2048-character URL, cutting only the message", async () => {
    registerOauth();
    // A long host is shown twice (in the URL and on its own line), which pushes the whole past 4000.
    const host = `${["a", "b", "c", "d"].map((letter) => letter.repeat(60)).join(".")}.example.com`;
    const prefix = `https://${host}/`;
    const url = `${prefix}${"p".repeat(2048 - prefix.length)}`;
    expect(url).toHaveLength(2048);
    const { ownerId, sent } = ownerAnswers(["aceitar"]);
    const result = await realHandler(ownerId)(request("console", { mode: "url", message: "m".repeat(1500), url }));

    expect(result).toEqual({ action: "accept" });
    expect(sent).toHaveLength(1);
    const text = String(sent[0]!.text);
    expect(text).toContain(`\n${url}\n`);
    expect(text).toContain(`\n${host}\n`);
    expect(text).toContain("m…\n");
    expect(text.split("\n\n1. Aceitar")[0]!.length).toBeLessThanOrEqual(MAX_PERSON_ANSWER_QUESTION_LENGTH);
  });

  it("declines a URL whose parsed form is longer than 2048 characters", () => {
    // Each space becomes %20 when parsed: 1428 characters given, 2828 shown.
    const raw = `https://console.example.com/${" x".repeat(700)}`;
    expect(raw.length).toBeLessThanOrEqual(2048);
    expect(planMcpElicitation({ mode: "url", message: "m", url: raw })).toMatchObject({
      ok: false,
      code: "unsafe_url",
    });
  });

  it("cuts every label to what a person-bound question takes, and reads a numeric label as a label", () => {
    expect(MAX_ELICITATION_LABEL_CHARS).toBeLessThanOrEqual(MAX_PERSON_ANSWER_OPTION_LENGTH);
    const plan = planMcpElicitation({
      mode: "form",
      requestedSchema: { type: "object", properties: { seats: { type: "string", enum: ["5", "10", "1"] } } },
    });
    if (!plan.ok || plan.mode !== "form") throw new Error("seats form must plan");
    const seats = plan.fields[0]!;
    expect(readMcpFieldAnswer(seats, "1")).toEqual({ ok: true, value: "1" });
    expect(readMcpFieldAnswer(seats, "10")).toEqual({ ok: true, value: "10" });
    expect(readMcpFieldAnswer(seats, "2")).toEqual({ ok: true, value: "10" });
  });
});

describe("in the gateway", () => {
  async function registerFixture() {
    fixture = startHttpFixture();
    createMcpServer({ name: "fixture", transport: "http", url: fixture.url, authKind: "none" });
    await writeMcpServerSecret("fixture", { url: fixture.url });
    attachMcpServer({ agentId: AGENT, server: "fixture", audience: "operator" });
  }

  async function registerLegacyStdio() {
    createMcpServer({
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE_STDIO_SERVER, "--legacy-only", "--starts", join(stateDir!, "starts.txt")],
      envKeys: ["FIXTURE_TOKEN"],
    });
    await writeMcpServerSecret("local", { env: { FIXTURE_TOKEN: "env-value-0123" } });
    attachMcpServer({ agentId: AGENT, server: "local" });
  }

  function personGateway(answers: string[], seen: string[] = []) {
    const h = harness(answers);
    gateway = new McpGateway({
      subscribe: false,
      refreshTickMs: 0,
      closeGraceMs: 200,
      authorize,
      elicit: async (request) => {
        seen.push(`${request.era}:${request.server}/${request.tool}:${request.key}`);
        return h.handler(request);
      },
    });
    return { gateway, h };
  }

  it("answers a modern input_required with the operator's accepted form", async () => {
    await registerFixture();
    const seen: string[] = [];
    const { gateway: gw, h } = personGateway(["Sim"], seen);
    const result = await gw.call(
      { context: context(), agentId: AGENT },
      { server: "fixture", tool: "deploy", arguments: { env: "prod" }, surface: "claude" },
    );
    expect(result).toMatchObject({ ok: true, rounds: 1, content: [{ type: "text", text: "deployed to prod" }] });
    expect(seen).toEqual(["modern:fixture/deploy:confirm"]);
    // A one-boolean confirmation is one question, with no review step.
    expect(h.asked).toHaveLength(1);
  });

  it("answers a legacy server request when exactly one call is in flight", async () => {
    await registerLegacyStdio();
    const seen: string[] = [];
    const { gateway: gw } = personGateway(["Sim", "Enviar"], seen);
    const result = await gw.call(
      { context: context(), agentId: AGENT },
      { server: "local", tool: "deploy", arguments: { env: "x" }, surface: "cli" },
    );
    expect(result).toMatchObject({ ok: true, era: "legacy", content: [{ type: "text", text: "deployed to x" }] });
    expect(seen).toEqual(["legacy:local/deploy:legacy"]);
  });

  it("declines an ambiguous legacy request (two calls in flight) without asking anyone", async () => {
    await registerLegacyStdio();
    const seen: string[] = [];
    const { gateway: gw, h } = personGateway(["Sim", "Enviar"], seen);
    // Open the connection first so both calls share it.
    expect((await gw.refresh("local"))?.era).toBe("legacy");
    const slow = gw.call(
      { context: context(), agentId: AGENT },
      { server: "local", tool: "slow", arguments: { ms: 1_500 }, surface: "cli" },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const deploy = await gw.call(
      { context: context(), agentId: AGENT },
      { server: "local", tool: "deploy", arguments: { env: "y" }, surface: "cli" },
    );
    expect(deploy).toMatchObject({ ok: true, content: [{ type: "text", text: "answer: decline" }] });
    expect(seen).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(await slow).toMatchObject({ ok: true, content: [{ type: "text", text: "slow done" }] });
  });
});
