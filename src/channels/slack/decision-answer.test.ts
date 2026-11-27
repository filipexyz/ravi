import { describe, expect, it } from "bun:test";
import {
  buildSlackDecisionAnswerModal,
  handleSlackDecisionAnswerSubmission,
  openSlackDecisionAnswerForm,
  parseSlackDecisionAnswerForm,
  parseSlackDecisionAnswerSubmission,
  slackDecisionAnswerOpenFromEnvelope,
  SLACK_DECISION_ANSWER_SCOPE_ACTION,
  SLACK_DECISION_ANSWER_SCOPE_BLOCK,
  SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID,
  SLACK_DECISION_ANSWER_TEXT_ACTION,
  SLACK_DECISION_ANSWER_TEXT_BLOCK,
} from "./decision-answer.js";
import { buildSlackThreadCard, SLACK_DECISION_ANSWER_ACTION_ID } from "./thread-card.js";
import type { OwnerCardAnswerInput, OwnerCardAnswerOutcome } from "../../decisions/owner-card.js";
import type { Decision } from "../../decisions/types.js";

const FORM = { decisionId: "dec_abc123", revision: 2, channelId: "C123", threadTs: "1713000000.000100" };

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
    // The fallback rendering offers it too.
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

function responderEnvelope(value = "dec_abc123:2"): Record<string, unknown> {
  return {
    envelope_id: "env-1",
    type: "interactive",
    payload: {
      type: "block_actions",
      trigger_id: "trig-1",
      user: { id: "UOWNER" },
      channel: { id: "C123" },
      container: { type: "message", channel_id: "C123", message_ts: "1713000000.000100" },
      message: { ts: "1713000000.000100" },
      actions: [{ action_id: SLACK_DECISION_ANSWER_ACTION_ID, value }],
    },
  };
}

describe("opening the form", () => {
  it("opens the form with the card's decision and the thread it is in", async () => {
    const opened: Record<string, unknown>[] = [];
    const acked: string[] = [];
    await openSlackDecisionAnswerForm({
      envelope: responderEnvelope() as never,
      client: {
        viewsOpen: async (input) => {
          opened.push(input as never);
          return { ok: true } as never;
        },
      },
      ack: (id) => void acked.push(id),
    });
    expect(acked).toEqual(["env-1"]);
    const view = (opened[0] as { view: Record<string, unknown>; triggerId: string }).view;
    expect((opened[0] as { triggerId: string }).triggerId).toBe("trig-1");
    expect(view.callback_id).toBe(SLACK_DECISION_ANSWER_SUBMIT_CALLBACK_ID);
    expect(parseSlackDecisionAnswerForm(view.private_metadata)).toEqual(FORM);
  });

  it("opens nothing for a button value that is not a decision", () => {
    for (const value of ["", "dec_abc123", "dec_abc123:0", "x:1", "dec_abc123:2:extra", "dec_a b:1"])
      expect(slackDecisionAnswerOpenFromEnvelope(responderEnvelope(value) as never)).toBeNull();
  });

  it("defaults the audience to this thread", () => {
    const modal = buildSlackDecisionAnswerModal(FORM) as { blocks: Array<Record<string, unknown>> };
    const scope = modal.blocks.find((b) => b.block_id === SLACK_DECISION_ANSWER_SCOPE_BLOCK) as {
      element: { initial_option: { value: string } };
    };
    expect(scope.element.initial_option.value).toBe("origin");
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
    stateValues: {
      [SLACK_DECISION_ANSWER_TEXT_BLOCK]: { [SLACK_DECISION_ANSWER_TEXT_ACTION]: { value: input.answer ?? "sonnet" } },
      [SLACK_DECISION_ANSWER_SCOPE_BLOCK]: {
        [SLACK_DECISION_ANSWER_SCOPE_ACTION]:
          input.scope === null ? {} : { selected_option: { value: input.scope ?? "origin" } },
      },
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
  });

  it("keeps anything but an explicit org choice in the thread", () => {
    for (const scope of [null, "origin", "agent:main", "ORG", "org-wide"])
      expect(parseSlackDecisionAnswerSubmission(submission({ scope }))?.scope).toBe("origin");
  });

  it("ignores other forms, other interactions and metadata that is not a decision form", () => {
    expect(parseSlackDecisionAnswerSubmission(submission({ callback: "ravi_credential_intake_submit" }))).toBeNull();
    expect(parseSlackDecisionAnswerSubmission(submission({ type: "block_actions" }))).toBeNull();
    for (const metadata of ["", "{}", "not json", JSON.stringify({ d: "dec_abc123", r: 0, c: "C123", t: "1.1" })])
      expect(parseSlackDecisionAnswerSubmission(submission({ metadata }))).toBeNull();
  });

  it("hands the core the verified sender and tells the person privately", async () => {
    const calls: OwnerCardAnswerInput[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const outcome: OwnerCardAnswerOutcome = {
      kind: "answered",
      decision: { id: FORM.decisionId, scope: { type: "org", id: null } } as Decision,
    };
    await handleSlackDecisionAnswerSubmission(submission({ scope: "org" }), {
      answer: async (input) => {
        calls.push(input);
        return outcome;
      },
      requestReply: (async (_subject: string, payload: Record<string, unknown>) => {
        sent.push(payload);
        return {};
      }) as never,
    });
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

  it("says privately why an answer was not recorded", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await handleSlackDecisionAnswerSubmission(submission(), {
      answer: async () => ({ kind: "refused", reason: "not_owner" }),
      requestReply: (async (_subject: string, payload: Record<string, unknown>) => {
        sent.push(payload);
        return {};
      }) as never,
    });
    expect(String(sent[0]!.text)).toContain("Só a pessoa responsável");
    expect(sent[0]!.privateTo).toEqual(["UOWNER"]);
  });
});
