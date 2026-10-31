import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";
import { CliExpectedError } from "../expected-error.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { DecisionError, parseDecisionOwner } from "../../decisions/model.js";
import { validateDecisionAsk, validateDecisionAnswer } from "../../decisions/store.js";
import {
  resolveDecisionOrigin,
  requireVisibleDecision,
  visibleDecisions,
  validateDecisionMutation,
  askDecision,
  answerDecision,
  decisionHistory,
} from "../../decisions/service.js";
import {
  decisionDeliveries,
  reconcileDecisionDeliveries,
  resetFailedDecisionDeliveries,
  validateDeliveryResolution,
  resolveUncertainDecisionDelivery,
} from "../../decisions/delivery.js";

export const decisionSchema = z.object({
  id: z.string(),
  origin: z.object({
    type: z.enum(["task", "thread"]),
    id: z.string(),
    chatId: z.string().nullable(),
    sessionKey: z.string().nullable(),
  }),
  key: z.string(),
  status: z.enum(["open", "answered", "superseded"]),
  ownerType: z.enum(["human", "agent", "unassigned"]),
  ownerId: z.string().nullable(),
  ask: z.string(),
  askedBy: z.string().nullable(),
  askedAt: z.number(),
  answer: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: z.number().nullable(),
  blocks: z.boolean(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const deliverySchema = z.object({
  id: z.string(),
  decisionId: z.string(),
  kind: z.enum(["question", "answer"]),
  revision: z.number(),
  status: z.enum(["pending", "publishing", "published", "accepting", "delivered", "failed", "uncertain", "superseded"]),
  attempts: z.number(),
  nextAttemptAt: z.number(),
  lastError: z.string().nullable(),
  deliveredAt: z.number().nullable(),
});
const mutationSchema = z.object({
  decision: decisionSchema,
  created: z.boolean().optional(),
  deliveries: z.array(deliverySchema),
});
const detailSchema = mutationSchema.extend({
  history: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      actor: z.string().nullable(),
      snapshot: z.string(),
      createdAt: z.number(),
    }),
  ),
});

function output<T>(value: T, asJson: boolean | undefined, text: string): T {
  console.log(asJson ? JSON.stringify(value, null, 2) : text);
  return value;
}
async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DecisionError)
      throw new CliExpectedError(error.message, error.code, error.exitCode, error.suggestedAction);
    throw error;
  }
}

@Group({
  name: "decisions",
  description: "Explicit questions and immutable answers owned by tasks or threads",
  scope: "open",
})
export class DecisionsCommands {
  @Command({ name: "ask", description: "Ask or update one open question on an explicit origin" })
  @CommandAccess({ kind: "mutate", resource: "decisions", action: "ask", risk: "medium", requiresConfirmation: true })
  @Returns(mutationSchema)
  async ask(
    @Option({ flags: "--task <id>", description: "Originating task" }) task?: string,
    @Option({ flags: "--thread <session>", description: "Managed thread child session or lifecycle id" })
    thread?: string,
    @Option({ flags: "--key <key>", description: "Stable question key within the origin" }) key?: string,
    @Option({ flags: "--ask <text>", description: "Explicit question" }) ask?: string,
    @Option({
      flags: "--owner <owner>",
      description: "human:<contact>|agent:<id>|unassigned; ownership is not approval authority",
    })
    owner?: string,
    @Option({ flags: "--blocks", description: "Blocks work; a human-owned task decision derives parked" })
    blocks?: boolean,
    @Option({ flags: "--json", description: "Print JSON" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Required for a thread: publishes the question" }) execute?: boolean,
  ) {
    return run(async () => {
      const input = validateDecisionAsk({ key: key ?? "", ask: ask ?? "", ...parseDecisionOwner(owner), blocks });
      const origin = resolveDecisionOrigin(task, thread);
      validateDecisionMutation(origin, "ask");
      if (origin.type === "thread" && !execute)
        contractDryRun("decisions ask", { originType: origin.type, originId: origin.id, key: input.key }, { asJson });
      const result = await askDecision(origin, input);
      if (origin.type === "thread") await reconcileDecisionDeliveries(undefined, result.decision.id);
      return output(
        { ...result, deliveries: decisionDeliveries(result.decision.id) },
        asJson,
        `${result.decision.id} [${result.decision.key}]: ${result.decision.ask}`,
      );
    });
  }

  @Command({ name: "answer", description: "Record an immutable answer; thread answers resume the waiting work" })
  @CommandAccess({
    kind: "mutate",
    resource: "decisions",
    action: "answer",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(mutationSchema)
  async answer(
    @Arg("id", { description: "Decision id from ask/list" }) id: string,
    @Option({ flags: "--text <text>", description: "Explicit outcome" }) text?: string,
    @Option({ flags: "--by <label>", description: "Additional provenance only; never authority" }) by?: string,
    @Option({ flags: "--json", description: "Print JSON" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Required for a thread: queues work in the waiting session" })
    execute?: boolean,
  ) {
    return run(async () => {
      const answer = validateDecisionAnswer(text ?? "");
      const current = requireVisibleDecision(id);
      validateDecisionMutation(current.origin, "answer", current);
      if (current.origin.type === "thread" && !execute)
        contractDryRun(
          "decisions answer",
          { decisionId: id, originType: current.origin.type, originId: current.origin.id },
          { asJson },
        );
      const decision = await answerDecision(id, answer, by);
      if (decision.origin.type === "thread") await reconcileDecisionDeliveries(undefined, id);
      return output(
        { decision, deliveries: decisionDeliveries(id) },
        asJson,
        `Answer recorded for ${id}. Delivery: ${decisionDeliveries(id).find((d) => d.kind === "answer")?.status ?? "not requested"}`,
      );
    });
  }

  @Command({ name: "show", description: "Read a decision, its immutable history and delivery state" })
  @CommandAccess({ kind: "read", resource: "decisions", action: "show", risk: "low" })
  @Returns(detailSchema)
  async show(
    @Arg("id", { description: "Decision id" }) id: string,
    @Option({ flags: "--json", description: "Print JSON" }) asJson?: boolean,
  ) {
    return run(() => {
      const decision = requireVisibleDecision(id);
      return output(
        { decision, deliveries: decisionDeliveries(id), history: decisionHistory(id) },
        asJson,
        `${id} [${decision.status}] ${decision.ask}\n${decision.answer ?? "Waiting for an explicit answer."}\n${decisionDeliveries(
          id,
        )
          .map((d) => `${d.kind}: ${d.status}`)
          .join("\n")}`,
      );
    });
  }

  @Command({ name: "list", description: "Read visible decisions; open only unless --all" })
  @CommandAccess({ kind: "read", resource: "decisions", action: "list", risk: "low" })
  @Returns(z.object({ decisions: z.array(decisionSchema), pagination: strictCliOffsetPaginationSchema }))
  async list(
    @Option({ flags: "--task <id>", description: "Filter to a task" }) task?: string,
    @Option({ flags: "--thread <session>", description: "Filter to a thread" }) thread?: string,
    @Option({ flags: "--all", description: "Include answered history" }) all?: boolean,
    @Option({ flags: "--json", description: "Print JSON" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default 50, maximum 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Page offset" }) offset?: string,
  ) {
    return run(() => {
      const page = paginateCliItems(
        visibleDecisions(task || thread ? resolveDecisionOrigin(task, thread) : undefined, !all),
        { limit, offset },
      );
      const decisions = page.items;
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "decisions", "list"],
        limit: page.limit,
        offset: page.offset,
        total: page.total,
        returned: decisions.length,
        options: ["--task", task, "--thread", thread, all && "--all"],
      });
      return output(
        { decisions, pagination },
        asJson,
        decisions.map((d) => `${d.id} [${d.status}] ${d.ask}`).join("\n") || "No decisions.",
      );
    });
  }

  @Command({ name: "retry", description: "Retry a failed thread delivery without recording another answer" })
  @CommandAccess({ kind: "mutate", resource: "decisions", action: "retry", risk: "medium", requiresConfirmation: true })
  @Returns(mutationSchema)
  async retry(
    @Arg("id", { description: "Decision id" }) id: string,
    @Option({ flags: "--json", description: "Print JSON" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Actually retry publication" }) execute?: boolean,
  ) {
    return run(async () => {
      const decision = requireVisibleDecision(id);
      validateDecisionMutation(decision.origin, "retry", decision);
      if (decision.origin.type !== "thread")
        throw new CliExpectedError("Task decisions do not deliver by default.", "USAGE_ERROR", 2);
      if (decisionDeliveries(id).some((d) => d.status === "uncertain" || d.status === "accepting"))
        throw new DecisionError(
          "DECISION_DELIVERY_UNCERTAIN",
          "Inspect the session trace before continuing; admission is uncertain.",
        );
      if (!execute) contractDryRun("decisions retry", { decisionId: id }, { asJson });
      resetFailedDecisionDeliveries(id);
      await reconcileDecisionDeliveries(undefined, id);
      return output({ decision, deliveries: decisionDeliveries(id) }, asJson, `Delivery check complete for ${id}.`);
    });
  }
  @Command({
    name: "resolve-delivery",
    description: "Local operator recovery of uncertain runtime admission using trace evidence",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "decisions",
    action: "resolve-delivery",
    risk: "high",
    requiresConfirmation: true,
    localOperator: true,
  })
  @Returns(mutationSchema)
  async resolveDelivery(
    @Arg("id", { description: "Decision id with uncertain answer delivery" }) id: string,
    @Option({
      flags: "--outcome <outcome>",
      description: "received or not_received, established by operator inspection",
    })
    outcome?: string,
    @Option({ flags: "--evidence <text>", description: "Trace reference and finding; stored in audit history" })
    evidence?: string,
    @Option({ flags: "--json", description: "Print JSON" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Record the resolution; not_received makes delivery retryable" })
    execute?: boolean,
  ) {
    return run(async () => {
      const decision = requireVisibleDecision(id);
      validateDeliveryResolution(id, outcome ?? "", evidence ?? "");
      if (!execute) contractDryRun("decisions resolve-delivery", { decisionId: id, outcome }, { asJson });
      resolveUncertainDecisionDelivery(id, outcome!, evidence!);
      await reconcileDecisionDeliveries(undefined, id);
      return output(
        { decision, deliveries: decisionDeliveries(id) },
        asJson,
        `Delivery resolution recorded for ${id}.`,
      );
    });
  }
}
