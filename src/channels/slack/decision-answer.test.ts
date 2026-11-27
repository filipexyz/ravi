import { describe, expect, it } from "bun:test";
import {
  buildSlackDecisionAnswerModal,
  handleSlackDecisionAnswerSubmission,
  openSlackDecisionAnswerForm,
  parseSlackDecisionAnswerForm,
  parseSlackDecisionAnswerSubmission,
  slackDecisionAnswerFormErrors,
  slackDecisionAnswerOpenFromEnvelope,
  type SlackDecisionAnswerFormDependencies,
  SLACK_DECISION_ANSWER_SCOPE_ACTION,
  SLACK_DECISION_ANSWER_SCOPE_BLOCK,
  SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID,
  SLACK_DECISION_ANSWER_TEXT_ACTION,
  SLACK_DECISION_ANSWER_TEXT_BLOCK,
} from "./decision-answer.js";
import { buildSlackThreadCard, SLACK_DECISION_ANSWER_ACTION_ID } from "./thread-card.js";
import type { OwnerCardAnswerInput, OwnerCardAnswerOutcome } from "../../decisions/owner-card.js";
import type { DecisionCardForm } from "../../decisions/store.js";
import type { Decision } from "../../decisions/types.js";

const FORM = { decisionId: "dec_abc123", revision: 2, channelId: "C123", threadTs: "1713000000.000100" };
const SLACK = { accountId: "fixture-slack", instanceId: "fixture-slack" };

function buttons(blocks: readonly Record<string, unknown>[]) {
  return blocks.flatMap((block) =>
    Array.isArray(block.elements) ? (block.elements as Record<string, unknown>[]) : [],
  );
}

describe("Responder on the thread card", () => {
  it("is on a card waiting for a decision, carrying only the id and revision", () => {
    const card = buildSlackThreadCard("Decide\nBrief", {
      status: "waiting",
      controls: true,
      note: "Sonnet ou Opus?",
      decision: { id: "dec_abc123", revision: 2 },
    });
    const responder = buttons(card.blocks).find((b) => b.action_id === SLACK_DECISION_ANSWER_ACTION_ID);
    expect(responder?.value).toBe("dec_abc123:2");
    expect(buttons(card.fallbackBlocks).some((b) => b.action_id === SLACK_DECISION_ANSWER_ACTION_ID)).toBe(true);
  });

  it("is not on a card that is not waiting, nor on one without a decision for a person", () => {
    const open = buildSlackThreadCard("Decide\nBrief", {
      status: "open",
      controls: true,
      decision: { id: "dec_x", revision: 1 },
    });
    const waiting = buildSlackThreadCard("Decide\nBrief", { status: "waiting", controls: true, note: "?" });
    for (const card of [open, waiting])
      expect(buttons(card.blocks).some((b) => b.action_id === SLACK_DECISION_ANSWER_ACTION_ID)).toBe(false);
  });
});

function responderEnvelope(input: { value?: string; user?: string; ts?: string } = {}): Record<string, unknown> {
  const ts = input.ts ?? "1713000000.000100";
  return {
    envelope_id: "env-1",
    type: "interactive",
    payload: {
      type: "block_actions",
      trigger_id: "trig-1",
      user: { id: input.user ?? "UOWNER" },
      channel: { id: "C123" },
      container: { type: "message", channel_id: "C123", message_ts: ts },
      message: { ts },
      actions: [{ action_id: SLACK_DECISION_ANSWER_ACTION_ID, value: input.value ?? "dec_abc123:2" }],
    },
  };
}

const DECISION = {
  id: "dec_abc123",
  revision: 2,
  status: "open",
  ownerType: "human",
  ownerId: "contact-owner",
  ask: "Revisão em Sonnet ou Opus? <@U999> <https://x.example|clique>",
  origin: { type: "thread", id: "thread-req", chatId: "chat-1", sessionKey: "sk" },
} as unknown as Decision;

function formDeps(overrides: Partial<{ decision: Decision | null; thread: Record<string, unknown> | null }> = {}) {
  const recorded: DecisionCardForm[] = [];
  const deps: SlackDecisionAnswerFormDependencies = {
    getDecision: () => ("decision" in overrides ? overrides.decision! : DECISION),
    getThread: (() =>
      "thread" in overrides
        ? overrides.thread
        : { platformChatId: "C123", providerThreadId: "1713000000.000100", instanceId: "fixture-slack" }) as never,
    resolveSender: (input) => (input.senderId === "UOWNER" ? { ownerType: "contact", ownerId: "contact-owner" } : null),
    recordForm: (_decision, form) => {
      recorded.push(form);
    },
  };
  return { deps, recorded };
}

async function open(envelope: Record<string, unknown>, deps: SlackDecisionAnswerFormDependencies) {
  const opened: Array<{ triggerId: string; view: Record<string, unknown> }> = [];
  const acked: string[] = [];
  await openSlackDecisionAnswerForm({
    envelope: envelope as never,
    client: {
      viewsOpen: async (input) => {
        opened.push(input as never);
        return { ok: true, view: { id: "V-opened" } } as never;
      },
    },
    ack: (id) => {
      acked.push(id);
    },
    ...SLACK,
    dependencies: deps,
  });
  return { opened, acked };
}

describe("opening the form", () => {
  it("opens the stored question for the owner on the real card and records the form", async () => {
    const { deps, recorded } = formDeps();
    const { opened, acked } = await open(responderEnvelope(), deps);
    expect(acked).toEqual(["env-1"]);
    const view = opened[0]!.view as {
      callback_id: string;
      private_metadata: string;
      blocks: Array<Record<string, unknown>>;
    };
    expect(view.callback_id).toBe(SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID);
    expect(parseSlackDecisionAnswerForm(view.private_metadata)).toEqual(FORM);
    // The stored question, as plain text: nothing in it renders as a mention or a link.
    expect(view.blocks[0]).toEqual({ type: "section", text: { type: "plain_text", text: DECISION.ask, emoji: false } });
    expect(recorded).toEqual([
      {
        formId: "V-opened",
        revision: 2,
        senderId: "UOWNER",
        channel: "slack",
        chatId: "C123",
        threadId: "1713000000.000100",
      },
    ]);
  });

  it("opens no form, and records nothing, for anyone but the owner, a copied button or an older card", async () => {
    const cases: Array<[Record<string, unknown>, ReturnType<typeof formDeps>]> = [
      [responderEnvelope({ user: "USTRANGER" }), formDeps()],
      // The same button pasted on another message of the channel.
      [responderEnvelope({ ts: "1713000999.000100" }), formDeps()],
      [responderEnvelope({ value: "dec_abc123:1" }), formDeps()],
      [responderEnvelope(), formDeps({ decision: { ...DECISION, status: "answered" } as Decision })],
      [responderEnvelope(), formDeps({ decision: { ...DECISION, ownerType: "agent" } as Decision })],
      [responderEnvelope(), formDeps({ decision: null })],
      [
        responderEnvelope(),
        formDeps({ thread: { platformChatId: "C123", providerThreadId: "1713000000.000100", instanceId: "other" } }),
      ],
    ];
    for (const [envelope, { deps, recorded }] of cases) {
      const { opened } = await open(envelope, deps);
      expect(opened).toHaveLength(1);
      expect(opened[0]!.view.callback_id).toBeUndefined();
      expect(opened[0]!.view.submit).toBeUndefined();
      expect(recorded).toEqual([]);
    }
  });

  it("reads nothing from a button value that is not a decision", () => {
    for (const value of ["", "dec_abc123", "dec_abc123:0", "x:1", "dec_abc123:2:extra", "dec_a b:1"])
      expect(slackDecisionAnswerOpenFromEnvelope(responderEnvelope({ value }) as never)).toBeNull();
  });

  it("defaults the audience to this thread", () => {
    const modal = buildSlackDecisionAnswerModal(FORM, "?") as { blocks: Array<Record<string, unknown>> };
    const scope = modal.blocks.find((b) => b.block_id === SLACK_DECISION_ANSWER_SCOPE_BLOCK) as {
      element: { initial_option: { value: string } };
    };
    expect(scope.element.initial_option.value).toBe("origin");
  });
});

function stateValues(answer: string, scope: string | null) {
  return {
    [SLACK_DECISION_ANSWER_TEXT_BLOCK]: { [SLACK_DECISION_ANSWER_TEXT_ACTION]: { value: answer } },
    [SLACK_DECISION_ANSWER_SCOPE_BLOCK]: {
      [SLACK_DECISION_ANSWER_SCOPE_ACTION]: scope === null ? {} : { selected_option: { value: scope } },
    },
  };
}

describe("the form before Slack closes it", () => {
  const envelope = (answer: string, scope: string | null) =>
    ({
      envelope_id: "env-3",
      payload: {
        type: "view_submission",
        view: { callback_id: SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID, state: { values: stateValues(answer, scope) } },
      },
    }) as never;

  it("keeps the draft of an empty answer, an org answer over the wide limit and an audience it never offers", () => {
    expect(slackDecisionAnswerFormErrors(envelope("  ", "origin"))).toHaveProperty(SLACK_DECISION_ANSWER_TEXT_BLOCK);
    expect(slackDecisionAnswerFormErrors(envelope("x".repeat(2001), "org"))).toHaveProperty(
      SLACK_DECISION_ANSWER_TEXT_BLOCK,
    );
    expect(slackDecisionAnswerFormErrors(envelope("sonnet", "agent:main"))).toHaveProperty(
      SLACK_DECISION_ANSWER_SCOPE_BLOCK,
    );
  });

  it("lets a long answer for the thread and a fitting org answer through", () => {
    expect(slackDecisionAnswerFormErrors(envelope("x".repeat(2500), "origin"))).toBeNull();
    expect(slackDecisionAnswerFormErrors(envelope("x".repeat(2000), "org"))).toBeNull();
    expect(slackDecisionAnswerFormErrors(envelope("sonnet", null))).toBeNull();
  });
});

function submission(
  input: { answer?: string; scope?: string | null; metadata?: string; callback?: string; type?: string } = {},
) {
  return {
    provider: "slack",
    source: "slack.socket_mode",
    interactionType: input.type ?? "view_submission",
    accountId: "fixture-slack",
    instanceId: "fixture-slack",
    userId: "UOWNER",
    viewId: "V1",
    envelopeId: "env-2",
    viewCallbackId: input.callback ?? SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID,
    viewPrivateMetadata:
      input.metadata ?? JSON.stringify({ d: FORM.decisionId, r: FORM.revision, c: FORM.channelId, t: FORM.threadTs }),
    stateValues: stateValues(input.answer ?? "sonnet", input.scope === undefined ? "origin" : input.scope),
  };
}

const OPENED: DecisionCardForm = {
  formId: "V1",
  revision: 2,
  senderId: "UOWNER",
  channel: "slack",
  chatId: "C123",
  threadId: "1713000000.000100",
};

function answerDeps(input: { form?: DecisionCardForm | null; outcome?: OwnerCardAnswerOutcome } = {}) {
  const calls: OwnerCardAnswerInput[] = [];
  const sent: Array<Record<string, unknown>> = [];
  return {
    calls,
    sent,
    deps: {
      answer: async (call: OwnerCardAnswerInput) => {
        calls.push(call);
        return (
          input.outcome ?? {
            kind: "answered" as const,
            decision: { id: FORM.decisionId, scope: { type: "origin", id: null } } as Decision,
          }
        );
      },
      requestReply: (async (_subject: string, payload: Record<string, unknown>) => {
        sent.push(payload);
        return {};
      }) as never,
      findForm: () => ("form" in input ? (input.form ?? null) : OPENED),
    },
  };
}

describe("the submitted form", () => {
  it("reads the answer, the audience and the verified sender", () => {
    expect(parseSlackDecisionAnswerSubmission(submission({ scope: "org" }))).toMatchObject({
      form: FORM,
      answer: "sonnet",
      scope: "org",
      userId: "UOWNER",
      viewId: "V1",
    });
    expect(parseSlackDecisionAnswerSubmission(submission({ scope: null }))?.scope).toBe("origin");
    for (const scope of ["agent:main", "ORG", "org-wide"])
      expect(parseSlackDecisionAnswerSubmission(submission({ scope }))?.scope).toBe("invalid");
  });

  it("ignores other forms, other interactions and metadata that is not a decision form", () => {
    expect(parseSlackDecisionAnswerSubmission(submission({ callback: "ravi_credential_intake_submit" }))).toBeNull();
    expect(parseSlackDecisionAnswerSubmission(submission({ type: "block_actions" }))).toBeNull();
    for (const metadata of ["", "{}", "not json", JSON.stringify({ d: "dec_abc123", r: 0, c: "C123", t: "1.1" })])
      expect(parseSlackDecisionAnswerSubmission(submission({ metadata }))).toBeNull();
  });

  it("answers nothing from a form the runner did not open from the card for this person", async () => {
    for (const form of [
      null,
      { ...OPENED, senderId: "USTRANGER" },
      { ...OPENED, revision: 1 },
      { ...OPENED, chatId: "C999" },
      { ...OPENED, threadId: "1713000999.000100" },
      { ...OPENED, channel: "whatsapp" },
    ]) {
      const { calls, sent, deps } = answerDeps({ form });
      const outcome = await handleSlackDecisionAnswerSubmission(submission(), deps);
      expect(outcome).toEqual({ kind: "refused", reason: "not_this_form" });
      expect(calls).toEqual([]);
      expect(String(sent[0]!.text)).toContain("não veio do cartão");
    }
  });

  it("refuses an audience the form never offers without asking the core", async () => {
    const { calls, deps } = answerDeps();
    expect(await handleSlackDecisionAnswerSubmission(submission({ scope: "agent:main" }), deps)).toEqual({
      kind: "refused",
      reason: "invalid_scope",
    });
    expect(calls).toEqual([]);
  });

  it("hands the core the verified sender and tells the person privately", async () => {
    const { calls, sent, deps } = answerDeps({
      outcome: { kind: "answered", decision: { id: FORM.decisionId, scope: { type: "org", id: null } } as Decision },
    });
    await handleSlackDecisionAnswerSubmission(submission({ scope: "org" }), deps);
    expect(calls[0]).toMatchObject({
      decisionId: FORM.decisionId,
      revision: FORM.revision,
      answer: "sonnet",
      scope: "org",
      actor: { channel: "slack", senderId: "UOWNER", accountId: "fixture-slack", instanceId: "fixture-slack" },
      interactionRef: "slack:view:V1",
    });
    expect(sent[0]).toMatchObject({ to: "C123", threadId: FORM.threadTs, privateTo: ["UOWNER"] });
    expect(String(sent[0]!.text)).toContain("toda a org");
  });

  it("says privately why the core did not record an answer", async () => {
    const { sent, deps } = answerDeps({ outcome: { kind: "refused", reason: "not_owner" } });
    await handleSlackDecisionAnswerSubmission(submission(), deps);
    expect(String(sent[0]!.text)).toContain("Só a pessoa responsável");
    expect(sent[0]!.privateTo).toEqual(["UOWNER"]);
  });
});
