import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SLACK_STRANGER_USER,
  seedApprovalContact,
} from "../../approval/test-support.js";
import { planMcpElicitation, type McpElicitationField } from "../../mcp/elicitation-form.js";
import { MCP_ELICITATION_ROW_KEEP_MS } from "../../mcp/registry-db.js";
import { getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { SlackPrivateCard, SlackPrivateCardTarget } from "./private-card.js";
import { setApprovalGrantorRouterConfigForTest } from "./grantors.js";
import {
  askSlackMcpElicitation,
  bindSlackMcpElicitationView,
  buildMcpElicitationInvitation,
  buildMcpElicitationModal,
  claimSlackMcpElicitationAnswer,
  createSlackMcpElicitationRequest,
  getSlackMcpElicitationRequest,
  handleMcpElicitationEnvelope,
  isMcpElicitationEnvelope,
  MCP_ELICITATION_ANSWER_SUBJECT,
  MCP_ELICITATION_OPEN,
  MCP_ELICITATION_SUBMIT,
  MCP_ELICITATION_VALUE_ACTION,
  mcpElicitationFieldBlockId,
  readMcpElicitationSubmission,
  resolveSlackMcpElicitationSurface,
  settleSlackMcpElicitationRequest,
  SlackMcpElicitationError,
  type SlackMcpElicitationAsk,
  type SlackMcpElicitationHandlerDependencies,
  type SlackMcpElicitationRequest,
  type SlackMcpElicitationSurface,
} from "./mcp-elicitation.js";
import { SlackSocketModeService } from "./socket-mode.js";
import type { SlackSocketEnvelope } from "./types.js";

const ACCOUNT = "ws-main";
const CHAT = "C0ELICIT1";
const USER = APPROVAL_TEST_SLACK_OWNER_USER;
const OTHER_USER = APPROVAL_TEST_SLACK_STRANGER_USER;
const TEAM = "T0ELICIT";
const VIEW = "V0ELICIT1";
const NOW = 1_000_000;

let stateDir: string | null = null;

const surface: SlackMcpElicitationSurface = {
  accountId: ACCOUNT,
  instanceId: ACCOUNT,
  chatId: CHAT,
  userId: USER,
};

const PROFILE_FORM = {
  mode: "form",
  message: "Tell us about the project",
  requestedSchema: {
    type: "object",
    properties: {
      project: { type: "string", title: "Project name", minLength: 3 },
      size: { type: "integer", title: "Team size", minimum: 1, maximum: 50 },
      tier: { type: "string", title: "Tier", enum: ["free", "pro"], enumNames: ["Free", "Pro"] },
      live: { type: "boolean", title: "Go live now" },
      notes: { type: "string", title: "Notes", description: "Optional" },
    },
    required: ["project", "size", "tier", "live"],
  },
} as const;

function planFields(params: unknown = PROFILE_FORM): McpElicitationField[] {
  const plan = planMcpElicitation(params);
  if (!plan.ok || plan.mode !== "form") throw new Error("the fixture form must plan");
  return plan.fields;
}

function seedRequest(
  patch: Partial<Parameters<typeof createSlackMcpElicitationRequest>[0]> = {},
): SlackMcpElicitationRequest {
  return createSlackMcpElicitationRequest({
    surface,
    contactId: "c_owner",
    agentId: "main",
    approvalId: "row_1",
    server: "console",
    tool: "write_row",
    mode: "form",
    message: "Tell us about the project",
    fields: planFields(),
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    ...patch,
  } as Parameters<typeof createSlackMcpElicitationRequest>[0]);
}

/** A stream the test pushes into, as `nats.subscribe` hands one out. */
function eventChannel() {
  const queue: Array<{ topic: string; data: Record<string, unknown> }> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const iterator = (async function* () {
    while (!closed) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) yield next;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    iterator,
    push(data: Record<string, unknown>) {
      queue.push({ topic: MCP_ELICITATION_ANSWER_SUBJECT, data });
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
  };
}

function fieldValues(values: Record<string, unknown>, fields: readonly McpElicitationField[]) {
  const state: Record<string, unknown> = {};
  for (const [index, field] of fields.entries()) {
    if (!(field.name in values)) continue;
    state[mcpElicitationFieldBlockId(index)] = { [MCP_ELICITATION_VALUE_ACTION]: values[field.name] };
  }
  return state;
}

function openEnvelope(requestId: string, patch: Record<string, unknown> = {}): SlackSocketEnvelope {
  return {
    envelope_id: "env-open",
    type: "interactive",
    payload: {
      type: "block_actions",
      team: { id: TEAM },
      user: { id: USER },
      channel: { id: CHAT },
      trigger_id: "trigger-1",
      actions: [{ action_id: MCP_ELICITATION_OPEN, block_id: "ravi_mcp_elicit:invitation", value: requestId }],
      ...patch,
    },
  };
}

function submissionEnvelope(
  requestId: string,
  values: Record<string, unknown>,
  patch: Record<string, unknown> = {},
): SlackSocketEnvelope {
  return {
    envelope_id: "env-submit",
    type: "interactive",
    accepts_response_payload: true,
    payload: {
      type: "view_submission",
      team: { id: TEAM },
      user: { id: USER },
      view: {
        id: VIEW,
        callback_id: MCP_ELICITATION_SUBMIT,
        private_metadata: requestId,
        state: { values },
      },
      ...patch,
    },
  };
}

function closedEnvelope(requestId: string): SlackSocketEnvelope {
  return {
    envelope_id: "env-closed",
    type: "interactive",
    payload: {
      type: "view_closed",
      team: { id: TEAM },
      user: { id: USER },
      view: { id: VIEW, callback_id: MCP_ELICITATION_SUBMIT, private_metadata: requestId },
    },
  };
}

interface Harness {
  acks: Array<{ envelopeId: string; payload?: Record<string, unknown> }>;
  opens: Record<string, unknown>[];
  ephemeral: Record<string, unknown>[];
  published: Array<{ subject: string; data: Record<string, unknown> }>;
  client: {
    viewsOpen: ReturnType<typeof mock>;
    postEphemeral: ReturnType<typeof mock>;
  };
  dependencies: Partial<SlackMcpElicitationHandlerDependencies>;
  handle: (envelope: SlackSocketEnvelope) => Promise<boolean>;
}

function harness(options: { openFails?: boolean; publishFails?: boolean; now?: () => number } = {}): Harness {
  const acks: Harness["acks"] = [];
  const opens: Record<string, unknown>[] = [];
  const ephemeral: Record<string, unknown>[] = [];
  const published: Harness["published"] = [];
  const client = {
    viewsOpen: mock(async ({ view }: { view: Record<string, unknown> }) => {
      opens.push(view);
      return options.openFails ? { ok: false } : { ok: true, view: { id: VIEW } };
    }),
    postEphemeral: mock(async (input: Record<string, unknown>) => {
      ephemeral.push(input);
      return { ok: true, messageId: "1.1" };
    }),
  };
  const dependencies: Partial<SlackMcpElicitationHandlerDependencies> = {
    now: options.now ?? (() => NOW + 1_000),
    publish: async (subject, data) => {
      if (options.publishFails) throw new Error("nats down");
      published.push({ subject, data });
    },
  };
  return {
    acks,
    opens,
    ephemeral,
    published,
    client,
    dependencies,
    handle: (envelope) =>
      handleMcpElicitationEnvelope({
        envelope,
        accountId: ACCOUNT,
        instanceId: ACCOUNT,
        client: client as never,
        ack: async (envelopeId, payload) => {
          acks.push({ envelopeId, ...(payload ? { payload } : {}) });
        },
        dependencies,
      }),
  };
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-mcp-elicitation-");
  setApprovalGrantorRouterConfigForTest(() => null);
});

afterEach(async () => {
  setApprovalGrantorRouterConfigForTest();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("the stored request", () => {
  it("keeps what the person is asked and nothing of the answer", () => {
    const request = seedRequest();
    expect(request.id.startsWith("sme_")).toBe(true);
    expect(request.status).toBe("open");
    expect(request.fields.map((field) => field.name)).toEqual(["project", "size", "tier", "live", "notes"]);

    const row = getDb().prepare("SELECT * FROM mcp_elicitation_requests WHERE id = ?").get(request.id) as Record<
      string,
      unknown
    >;
    expect(row.user_id).toBe(USER);
    expect(row.contact_id).toBe("c_owner");
    expect(row.approval_id).toBe("row_1");
    expect(row.status).toBe("open");
    expect(JSON.stringify(row)).not.toContain("Atlas");
    expect(Object.keys(row)).not.toContain("content");
  });

  it("refuses a request it cannot serve", () => {
    expect(() => seedRequest({ expiresAt: NOW })).toThrow(SlackMcpElicitationError);
    expect(() =>
      seedRequest({ fields: Array.from({ length: 9 }, () => planFields()[0] as McpElicitationField) }),
    ).toThrow(SlackMcpElicitationError);
    expect(() => seedRequest({ mode: "url", fields: undefined, url: undefined } as never)).toThrow(
      SlackMcpElicitationError,
    );
    expect(() => seedRequest({ surface: { ...surface, userId: "nobody" } })).toThrow(SlackMcpElicitationError);
    expect(() => seedRequest({ surface: { ...surface, chatId: "x-chat" } })).toThrow(SlackMcpElicitationError);
  });

  it("binds one view for the bound user only, then takes one answer", () => {
    const request = seedRequest();
    expect(() =>
      bindSlackMcpElicitationView({
        id: request.id,
        accountId: ACCOUNT,
        userId: OTHER_USER,
        teamId: TEAM,
        viewId: VIEW,
        now: NOW + 1,
      }),
    ).toThrow(SlackMcpElicitationError);

    const bound = bindSlackMcpElicitationView({
      id: request.id,
      accountId: ACCOUNT,
      userId: USER,
      teamId: TEAM,
      viewId: VIEW,
      now: NOW + 1,
    });
    expect(bound.status).toBe("opened");
    expect(bound.viewId).toBe(VIEW);
    // One modal per request: a second open is refused.
    expect(() =>
      bindSlackMcpElicitationView({
        id: request.id,
        accountId: ACCOUNT,
        userId: USER,
        teamId: TEAM,
        viewId: "V0ELICIT2",
        now: NOW + 2,
      }),
    ).toThrow(SlackMcpElicitationError);

    // Another view's submission is not this request's answer.
    expect(() =>
      claimSlackMcpElicitationAnswer({
        id: request.id,
        accountId: ACCOUNT,
        userId: USER,
        viewId: "V0ELICIT2",
        action: "answered",
        now: NOW + 3,
      }),
    ).toThrow(SlackMcpElicitationError);

    const claimed = claimSlackMcpElicitationAnswer({
      id: request.id,
      accountId: ACCOUNT,
      userId: USER,
      viewId: VIEW,
      action: "answered",
      now: NOW + 4,
    });
    expect(claimed.status).toBe("answered");
    expect(() =>
      claimSlackMcpElicitationAnswer({
        id: request.id,
        accountId: ACCOUNT,
        userId: USER,
        viewId: VIEW,
        action: "answered",
        now: NOW + 5,
      }),
    ).toThrow(SlackMcpElicitationError);
  });

  it("keeps settled and expired rows for a day when a new request is stored", () => {
    const day = MCP_ELICITATION_ROW_KEEP_MS;
    const expired = seedRequest({ id: "sme_expired", expiresAt: NOW + 1_000 });
    const settled = seedRequest({ id: "sme_settled", expiresAt: NOW + 10 * day });
    settleSlackMcpElicitationRequest({ id: settled.id, status: "cancelled", now: NOW + 2_000 });
    // An hour later both are over, and both stay.
    seedRequest({ id: "sme_hour", createdAt: NOW + 60 * 60_000, expiresAt: NOW + 2 * 60 * 60_000 });
    expect(getSlackMcpElicitationRequest(expired.id)).not.toBeNull();
    expect(getSlackMcpElicitationRequest(settled.id)).not.toBeNull();
    // More than a day after they ended, the next insert drops them.
    const later = NOW + 2_000 + day + 1;
    const fresh = seedRequest({ id: "sme_later", createdAt: later, expiresAt: later + 60_000 });
    expect(getSlackMcpElicitationRequest(expired.id)).toBeNull();
    expect(getSlackMcpElicitationRequest(settled.id)).toBeNull();
    expect(getSlackMcpElicitationRequest(fresh.id)?.status).toBe("open");
  });

  it("refuses an expired request and keeps a settled one terminal", () => {
    const request = seedRequest();
    expect(() =>
      bindSlackMcpElicitationView({
        id: request.id,
        accountId: ACCOUNT,
        userId: USER,
        viewId: VIEW,
        now: request.expiresAt,
      }),
    ).toThrow(SlackMcpElicitationError);

    settleSlackMcpElicitationRequest({ id: request.id, status: "expired", now: NOW + 10 });
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("expired");
    expect(() =>
      bindSlackMcpElicitationView({ id: request.id, accountId: ACCOUNT, userId: USER, viewId: VIEW, now: NOW + 11 }),
    ).toThrow(SlackMcpElicitationError);
    // A settled request is not reopened by a later settle.
    settleSlackMcpElicitationRequest({ id: request.id, status: "cancelled", now: NOW + 12 });
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("expired");
  });
});

describe("the card and the modal", () => {
  it("maps string, number, boolean and enum fields into input blocks", () => {
    const request = seedRequest();
    const invitation = buildMcpElicitationInvitation(request);
    const button = (invitation.blocks.at(-1) as { elements: Record<string, unknown>[] }).elements[0];
    expect(button).toMatchObject({ action_id: MCP_ELICITATION_OPEN, value: request.id });
    expect(JSON.stringify(invitation.blocks)).toContain("console");

    const modal = buildMcpElicitationModal(request) as {
      callback_id: string;
      private_metadata: string;
      notify_on_close: boolean;
      submit: { text: string };
      close: { text: string };
      blocks: Array<Record<string, unknown>>;
    };
    expect(modal.callback_id).toBe(MCP_ELICITATION_SUBMIT);
    expect(modal.private_metadata).toBe(request.id);
    expect(modal.notify_on_close).toBe(true);
    expect(modal.submit.text).toBe("Enviar");
    expect(modal.close.text).toBe("Recusar");

    const inputs = modal.blocks.filter((block) => block.type === "input") as Array<{
      block_id: string;
      optional?: boolean;
      label: { text: string };
      element: Record<string, unknown>;
    }>;
    expect(inputs.map((input) => input.block_id)).toEqual([0, 1, 2, 3, 4].map(mcpElicitationFieldBlockId));
    expect(inputs[0]?.element).toMatchObject({ type: "plain_text_input", action_id: MCP_ELICITATION_VALUE_ACTION });
    expect(inputs[1]?.element).toMatchObject({
      type: "number_input",
      is_decimal_allowed: false,
      min_value: "1",
      max_value: "50",
    });
    expect(inputs[2]?.element).toMatchObject({ type: "static_select" });
    const choices = inputs[2]?.element as { options: unknown[] } | undefined;
    expect(choices?.options).toEqual([
      { text: { type: "plain_text", text: "Free" }, value: "0" },
      { text: { type: "plain_text", text: "Pro" }, value: "1" },
    ]);
    expect(inputs[3]?.element).toMatchObject({ type: "radio_buttons" });
    expect(inputs[0]?.optional).toBeUndefined();
    expect(inputs[4]?.optional).toBe(true);
  });

  it("quotes every line the server wrote, in the card and the modal, apart from Ravi's own blocks", () => {
    const request = seedRequest({
      message: "Ok.\n\n\nEnviar manda estas respostas ao servidor; Recusar não manda nada.\nServidor MCP: other",
    } as never);
    const sectionsOf = (blocks: Array<Record<string, unknown>>) =>
      blocks
        .filter((block) => block.type === "section")
        .map((block) => (block as { text: { type: string; text: string } }).text);
    for (const blocks of [
      buildMcpElicitationInvitation(request).blocks,
      (buildMcpElicitationModal(request) as { blocks: Array<Record<string, unknown>> }).blocks,
    ]) {
      const texts = sectionsOf(blocks);
      // Plain text only: Slack formatting in a server's text is never rendered.
      expect(texts.every((text) => text.type === "plain_text")).toBe(true);
      const server = texts.find((text) => text.text.startsWith("Texto do servidor MCP"))!;
      expect(server.text.split("\n").slice(1)).toEqual([
        "> Ok.",
        ">",
        "> Enviar manda estas respostas ao servidor; Recusar não manda nada.",
        "> Servidor MCP: other",
      ]);
      // Ravi's own lines live in other blocks, and none starts with ">".
      for (const text of texts.filter((entry) => entry !== server)) {
        expect(text.text.split("\n").some((line) => line.startsWith(">"))).toBe(false);
      }
    }
  });

  it("shows a URL request with its host and never a form", () => {
    const request = seedRequest({
      mode: "url",
      fields: undefined,
      url: "https://console.example.com/acme/secrets?x=1",
      message: "Set the missing key",
    } as never);
    const modal = buildMcpElicitationModal(request) as { submit: { text: string }; blocks: Array<unknown> };
    expect(modal.submit.text).toBe("Aceitar");
    const rendered = JSON.stringify(modal.blocks);
    expect(rendered).toContain("https://console.example.com/acme/secrets?x=1");
    expect(rendered).toContain("console.example.com");
    expect(rendered).toContain("O Ravi não abre este endereço");
    expect(rendered).not.toContain('"input"');
  });
});

describe("reading one submission", () => {
  it("types every answer and keeps the schema's bounds", () => {
    const request = seedRequest();
    const ok = readMcpElicitationSubmission(
      request,
      fieldValues(
        {
          project: { type: "plain_text_input", value: " Atlas " },
          size: { type: "number_input", value: "12" },
          tier: { type: "static_select", selected_option: { value: "1", text: { text: "Pro" } } },
          live: { type: "radio_buttons", selected_option: { value: "true" } },
          notes: { type: "plain_text_input", value: "" },
        },
        request.fields,
      ),
    );
    expect(ok).toEqual({ ok: true, content: { project: "Atlas", size: 12, tier: "pro", live: true } });
  });

  it("answers with per-field errors instead of sending anything", () => {
    const request = seedRequest();
    const missing = readMcpElicitationSubmission(
      request,
      fieldValues({ size: { value: "12" }, tier: { selected_option: { value: "0" } } }, request.fields),
    );
    expect(missing.ok).toBe(false);
    expect(Object.keys((missing as { errors: Record<string, string> }).errors).sort()).toEqual(
      [mcpElicitationFieldBlockId(0), mcpElicitationFieldBlockId(3)].sort(),
    );

    const bad = readMcpElicitationSubmission(
      request,
      fieldValues(
        {
          project: { value: "At" },
          size: { value: "99" },
          tier: { selected_option: { value: "7" } },
          live: { selected_option: { value: "maybe" } },
        },
        request.fields,
      ),
    );
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: Record<string, string> }).errors;
    expect(errors[mcpElicitationFieldBlockId(0)]).toContain("3 caracteres");
    expect(errors[mcpElicitationFieldBlockId(1)]).toContain("50");
    expect(errors[mcpElicitationFieldBlockId(2)]).toBeDefined();
    expect(errors[mcpElicitationFieldBlockId(3)]).toBeDefined();
  });

  it("checks a format and ignores a block the form did not ask for", () => {
    const request = seedRequest({
      fields: planFields({
        mode: "form",
        requestedSchema: { type: "object", properties: { email: { type: "string", format: "email" } } },
      }),
    });
    const wrong = readMcpElicitationSubmission(request, {
      [mcpElicitationFieldBlockId(0)]: { [MCP_ELICITATION_VALUE_ACTION]: { value: "ana" } },
      "ravi_mcp_elicit:f9": { [MCP_ELICITATION_VALUE_ACTION]: { value: "ignored" } },
    });
    expect(wrong).toMatchObject({ ok: false });
    const right = readMcpElicitationSubmission(request, {
      [mcpElicitationFieldBlockId(0)]: { [MCP_ELICITATION_VALUE_ACTION]: { value: "ana@example.com" } },
      "ravi_mcp_elicit:f9": { [MCP_ELICITATION_VALUE_ACTION]: { value: "ignored" } },
    });
    expect(right).toEqual({ ok: true, content: { email: "ana@example.com" } });
  });
});

describe("the modal in ravi-channels", () => {
  it("recognizes only its own envelopes", () => {
    expect(isMcpElicitationEnvelope(openEnvelope("sme_1"))).toBe(true);
    expect(isMcpElicitationEnvelope(submissionEnvelope("sme_1", {}))).toBe(true);
    expect(isMcpElicitationEnvelope(closedEnvelope("sme_1"))).toBe(true);
    // A payload that lost its callback is still this flow's, by its state keys.
    expect(
      isMcpElicitationEnvelope({
        envelope_id: "malformed",
        type: "interactive",
        payload: {
          type: "view_submission",
          view: { id: VIEW, state: { values: { [mcpElicitationFieldBlockId(0)]: {} } } },
        },
      }),
    ).toBe(true);
    expect(
      isMcpElicitationEnvelope({
        envelope_id: "other",
        type: "interactive",
        payload: { type: "block_actions", actions: [{ action_id: "ravi_thread_close" }] },
      }),
    ).toBe(false);
  });

  it("opens the modal for the bound user and binds its view", async () => {
    const request = seedRequest();
    const h = harness();
    expect(await h.handle(openEnvelope(request.id))).toBe(true);
    expect(h.opens).toHaveLength(1);
    expect(h.opens[0]).toMatchObject({ private_metadata: request.id, callback_id: MCP_ELICITATION_SUBMIT });
    expect(h.acks).toEqual([{ envelopeId: "env-open" }]);
    const stored = getSlackMcpElicitationRequest(request.id);
    expect(stored).toMatchObject({ status: "opened", viewId: VIEW, teamId: TEAM });
  });

  it("opens nothing for anyone but the bound user, or after expiry, or twice", async () => {
    const request = seedRequest();
    const other = harness();
    await other.handle(openEnvelope(request.id, { user: { id: OTHER_USER } }));
    expect(other.opens).toEqual([]);
    expect(other.ephemeral[0]).toMatchObject({ user: OTHER_USER, channel: CHAT });
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("open");

    const late = harness({ now: () => request.expiresAt + 1 });
    await late.handle(openEnvelope(request.id));
    expect(late.opens).toEqual([]);

    const first = harness();
    await first.handle(openEnvelope(request.id));
    const second = harness();
    await second.handle(openEnvelope(request.id));
    expect(second.opens).toEqual([]);
    expect(getSlackMcpElicitationRequest(request.id)?.viewId).toBe(VIEW);

    const unknown = harness();
    await unknown.handle(openEnvelope("sme_unknown"));
    expect(unknown.opens).toEqual([]);
  });

  it("publishes one validated answer and refuses a replay", async () => {
    const request = seedRequest();
    const h = harness();
    await h.handle(openEnvelope(request.id));
    const values = fieldValues(
      {
        project: { value: "Atlas" },
        size: { value: "12" },
        tier: { selected_option: { value: "1" } },
        live: { selected_option: { value: "false" } },
      },
      request.fields,
    );
    expect(await h.handle(submissionEnvelope(request.id, values))).toBe(true);
    expect(h.published).toEqual([
      {
        subject: MCP_ELICITATION_ANSWER_SUBJECT,
        data: {
          requestId: request.id,
          accountId: ACCOUNT,
          instanceId: ACCOUNT,
          userId: USER,
          action: "accept",
          content: { project: "Atlas", size: 12, tier: "pro", live: false },
        },
      },
    ]);
    const submitAck = h.acks.at(-1);
    expect(submitAck?.payload).toMatchObject({ response_action: "update" });
    expect(JSON.stringify(submitAck?.payload)).toContain("Resposta enviada");
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("answered");

    // A replayed submission publishes nothing more.
    await h.handle(submissionEnvelope(request.id, values));
    expect(h.published).toHaveLength(1);
    expect(JSON.stringify(h.acks.at(-1)?.payload)).toContain("não está mais disponível");
  });

  it("takes no submission from anyone but the bound user", async () => {
    const request = seedRequest();
    const h = harness();
    await h.handle(openEnvelope(request.id));
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("opened");
    const values = fieldValues(
      {
        project: { value: "Atlas" },
        size: { value: "12" },
        tier: { selected_option: { value: "1" } },
        live: { selected_option: { value: "false" } },
      },
      request.fields,
    );

    // The same modal, submitted by someone else: nothing is published and the request waits.
    expect(await h.handle(submissionEnvelope(request.id, values, { user: { id: OTHER_USER } }))).toBe(true);
    expect(h.published).toEqual([]);
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("opened");
    const ack = h.acks.at(-1)?.payload as { response_action?: string } | undefined;
    expect(ack?.response_action).toBe("update");
    expect(JSON.stringify(ack)).toContain("não está mais disponível");

    // The store refuses the claim on its own, whatever the handler checked first.
    let refusal: unknown;
    try {
      claimSlackMcpElicitationAnswer({
        id: request.id,
        accountId: ACCOUNT,
        userId: OTHER_USER,
        teamId: TEAM,
        viewId: VIEW,
        action: "answered",
        now: NOW + 2_000,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SlackMcpElicitationError);
    expect((refusal as SlackMcpElicitationError).code).toBe("BINDING_MISMATCH");
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("opened");

    // The bound user's own submission still answers it.
    await h.handle(submissionEnvelope(request.id, values));
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.data).toMatchObject({ userId: USER, action: "accept" });
  });

  it("answers an invalid field with Slack errors and keeps the request open", async () => {
    const request = seedRequest();
    const h = harness();
    await h.handle(openEnvelope(request.id));
    await h.handle(
      submissionEnvelope(
        request.id,
        fieldValues(
          {
            project: { value: "At" },
            size: { value: "12" },
            tier: { selected_option: { value: "0" } },
            live: { selected_option: { value: "true" } },
          },
          request.fields,
        ),
      ),
    );
    expect(h.published).toEqual([]);
    expect(h.acks.at(-1)?.payload).toMatchObject({ response_action: "errors" });
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("opened");
  });

  it("publishes a decline when the person closes the modal", async () => {
    const request = seedRequest();
    const h = harness();
    await h.handle(openEnvelope(request.id));
    expect(await h.handle(closedEnvelope(request.id))).toBe(true);
    expect(h.published[0]?.data).toMatchObject({ requestId: request.id, action: "decline" });
    expect(h.published[0]?.data.content).toBeUndefined();
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("declined");
  });

  it("tells the person when the answer could not be delivered", async () => {
    const request = seedRequest();
    const h = harness({ publishFails: true });
    await h.handle(openEnvelope(request.id));
    await h.handle(
      submissionEnvelope(
        request.id,
        fieldValues(
          {
            project: { value: "Atlas" },
            size: { value: "3" },
            tier: { selected_option: { value: "0" } },
            live: { selected_option: { value: "true" } },
          },
          request.fields,
        ),
      ),
    );
    expect(JSON.stringify(h.acks.at(-1)?.payload)).toContain("Não foi possível entregar");
  });

  it("submits a URL request without content", async () => {
    const request = seedRequest({
      mode: "url",
      fields: undefined,
      url: "https://console.example.com/acme",
    } as never);
    const h = harness();
    await h.handle(openEnvelope(request.id));
    await h.handle(submissionEnvelope(request.id, {}));
    expect(h.published[0]?.data).toMatchObject({ action: "accept" });
    expect(h.published[0]?.data.content).toBeUndefined();
  });

  it("is routed by the Socket Mode service", async () => {
    const request = seedRequest();
    const published: Array<Record<string, unknown>> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: ACCOUNT,
      instanceId: ACCOUNT,
      webClient: {
        viewsOpen: async () => ({ ok: true, view: { id: VIEW } }),
      } as never,
      mcpElicitationDependencies: {
        now: () => NOW + 1_000,
        publish: async (_subject, data) => {
          published.push(data);
        },
      },
    });
    const acks: string[] = [];
    expect(
      await service.handleEnvelope(openEnvelope(request.id), async (id) => {
        acks.push(id);
      }),
    ).toBe("processed");
    expect(getSlackMcpElicitationRequest(request.id)?.status).toBe("opened");
    expect(
      await service.handleEnvelope(closedEnvelope(request.id), async (id) => {
        acks.push(id);
      }),
    ).toBe("processed");
    expect(published[0]).toMatchObject({ requestId: request.id, action: "decline" });
  });
});

describe("the daemon's surface and wait", () => {
  it("finds the Slack user of the person, and nothing else", () => {
    const contact = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Owner",
      tags: [],
      slack: { userId: USER, instanceId: ACCOUNT },
    });
    expect(
      resolveSlackMcpElicitationSurface({
        source: { channel: "slack", accountId: ACCOUNT, chatId: CHAT, threadId: "1712345678.123456" },
        contactId: contact.id,
      }),
    ).toEqual({ accountId: ACCOUNT, chatId: CHAT, threadTs: "1712345678.123456", userId: USER });
    // Another person, another channel and a chat id Slack never issues have no surface.
    expect(
      resolveSlackMcpElicitationSurface({
        source: { channel: "slack", accountId: ACCOUNT, chatId: CHAT },
        contactId: "c_nobody",
      }),
    ).toBeNull();
    expect(
      resolveSlackMcpElicitationSurface({
        source: { channel: "whatsapp", accountId: ACCOUNT, chatId: CHAT },
        contactId: contact.id,
      }),
    ).toBeNull();
    expect(
      resolveSlackMcpElicitationSurface({
        source: { channel: "slack", accountId: ACCOUNT, chatId: "not-a-chat" },
        contactId: contact.id,
      }),
    ).toBeNull();
  });

  function ask(patch: Partial<SlackMcpElicitationAsk> = {}): SlackMcpElicitationAsk {
    return {
      surface,
      server: "console",
      tool: "write_row",
      contactId: "c_owner",
      agentId: "main",
      approvalId: "row_1",
      mode: "form",
      message: "Tell us about the project",
      fields: planFields(),
      deadline: Date.now() + 5_000,
      ...patch,
    } as SlackMcpElicitationAsk;
  }

  /** The whole round trip: the card is delivered, then the person answers in Slack. */
  function askWith(
    answer: (request: SlackMcpElicitationRequest, channelEvents: ReturnType<typeof eventChannel>) => Promise<void>,
    patch: Partial<SlackMcpElicitationAsk> = {},
  ) {
    const events = eventChannel();
    const cards: Array<{ target: SlackPrivateCardTarget; card: SlackPrivateCard }> = [];
    const promise = askSlackMcpElicitation(ask(patch), {
      nats: { subscribe: (() => events.iterator) as never },
      deliver: async (target, card) => {
        cards.push({ target, card });
        const requestId = String(
          ((card.blocks.at(-1) as { elements: Array<{ value?: string }> }).elements[0] ?? {}).value,
        );
        const request = getSlackMcpElicitationRequest(requestId);
        if (!request) throw new Error("the request must be stored before the card");
        await answer(request, events);
      },
    });
    return { promise, cards, events };
  }

  /** What `ravi-channels` does with the modal, against the real store. */
  async function answerInSlack(
    request: SlackMcpElicitationRequest,
    events: ReturnType<typeof eventChannel>,
    values: Record<string, unknown>,
    action: "answered" | "declined" = "answered",
  ) {
    const published: Array<Record<string, unknown>> = [];
    const h = harness({ now: () => Date.now() });
    h.dependencies.publish = async (_subject, data) => {
      published.push(data);
      events.push(data);
    };
    await h.handle(openEnvelope(request.id));
    if (action === "declined") await h.handle(closedEnvelope(request.id));
    else await h.handle(submissionEnvelope(request.id, fieldValues(values, request.fields)));
    return published;
  }

  it("accepts the submitted form", async () => {
    const run = askWith((request, events) =>
      answerInSlack(request, events, {
        project: { value: "Atlas" },
        size: { value: "12" },
        tier: { selected_option: { value: "1" } },
        live: { selected_option: { value: "true" } },
        notes: { value: "later" },
      }).then(() => undefined),
    );
    const answer = await run.promise;
    expect(answer).toEqual({
      action: "accept",
      content: { project: "Atlas", size: 12, tier: "pro", live: true, notes: "later" },
      reason: "accepted",
    });
    expect(run.cards[0]?.target).toMatchObject({ accountId: ACCOUNT, chatId: CHAT, userId: USER });
    run.events.close();
  });

  it("declines when the person closes the modal", async () => {
    const run = askWith((request, events) => answerInSlack(request, events, {}, "declined").then(() => undefined));
    expect(await run.promise).toEqual({ action: "decline", reason: "declined" });
    run.events.close();
  });

  it("accepts a URL request on consent, with no content", async () => {
    const run = askWith((request, events) => answerInSlack(request, events, {}).then(() => undefined), {
      mode: "url",
      url: "https://console.example.com/acme",
      fields: undefined,
    } as never);
    expect(await run.promise).toEqual({ action: "accept", reason: "accepted" });
    run.events.close();
  });

  it("ignores an answer the row does not prove", async () => {
    const run = askWith(
      async (request, events) => {
        // Another Slack user, and a request nobody claimed: neither is an answer.
        events.push({ requestId: request.id, accountId: ACCOUNT, userId: OTHER_USER, action: "accept", content: {} });
        events.push({ requestId: request.id, accountId: ACCOUNT, userId: USER, action: "accept", content: {} });
        events.push({ requestId: "sme_other", accountId: ACCOUNT, userId: USER, action: "accept", content: {} });
      },
      { deadline: Date.now() + 400 },
    );
    expect(await run.promise).toEqual({ action: "cancel", reason: "timeout" });
    run.events.close();
  });

  it("cancels on a timeout and leaves the request expired", async () => {
    const run = askWith(async () => {}, { deadline: Date.now() + 300 });
    expect(await run.promise).toEqual({ action: "cancel", reason: "timeout" });
    const row = getDb().prepare("SELECT status FROM mcp_elicitation_requests").get() as { status: string };
    expect(row.status).toBe("expired");
    run.events.close();
  });

  it("cancels when the call is cancelled, without content", async () => {
    const controller = new AbortController();
    const run = askWith(
      async () => {
        controller.abort();
      },
      { signal: controller.signal },
    );
    expect(await run.promise).toEqual({ action: "cancel", reason: "cancelled" });
    expect(
      getSlackMcpElicitationRequest(
        (getDb().prepare("SELECT id FROM mcp_elicitation_requests").get() as { id: string }).id,
      )?.status,
    ).toBe("cancelled");
    run.events.close();
  });

  it("cancels when the card was not delivered, and asks nobody again", async () => {
    const events = eventChannel();
    const answer = await askSlackMcpElicitation(ask(), {
      nats: { subscribe: (() => events.iterator) as never },
      deliver: async () => {
        throw new Error("slack refused");
      },
    });
    expect(answer).toEqual({ action: "cancel", reason: "send_failed" });
    const row = getDb().prepare("SELECT status FROM mcp_elicitation_requests").get() as { status: string };
    expect(row.status).toBe("cancelled");
    events.close();
  });

  it("cancels an answer that does not fit the plan", async () => {
    const run = askWith(async (request, events) => {
      // The row is claimed as answered, but the published content is not the form's.
      bindSlackMcpElicitationView({
        id: request.id,
        accountId: ACCOUNT,
        userId: USER,
        teamId: TEAM,
        viewId: VIEW,
        now: Date.now(),
      });
      claimSlackMcpElicitationAnswer({
        id: request.id,
        accountId: ACCOUNT,
        userId: USER,
        viewId: VIEW,
        action: "answered",
        now: Date.now(),
      });
      events.push({
        requestId: request.id,
        accountId: ACCOUNT,
        userId: USER,
        action: "accept",
        content: { project: "Atlas", size: 999, tier: "pro", live: true },
      });
    });
    expect(await run.promise).toEqual({ action: "cancel", reason: "invalid_answer" });
    run.events.close();
  });

  it("cancels with nothing stored when the surface is not one Slack issues", async () => {
    const events = eventChannel();
    const deliver = mock(async () => {});
    const answer = await askSlackMcpElicitation(ask({ surface: { ...surface, userId: "someone" } }), {
      nats: { subscribe: (() => events.iterator) as never },
      deliver,
    });
    expect(answer).toEqual({ action: "cancel", reason: "no_private_surface" });
    expect(deliver).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM mcp_elicitation_requests").get()).toEqual({ n: 0 });
    events.close();
  });
});
