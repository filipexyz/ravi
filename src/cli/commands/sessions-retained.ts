import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns, Scope } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";
import { fail } from "../context.js";
import { markLocalInboxItem } from "../../inbox/local-db.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import {
  RETAINED_START_TTL_MS,
  classifyRetainedStart,
  listRetainedStarts,
} from "../../runtime/start-admission-resume.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const retainedStartReturnSchema = z.object({
  itemId: z.string(),
  sessionName: z.string(),
  status: z.string(),
  refusedAt: z.string(),
  ageMinutes: z.number(),
  /** What the daemon will do on its next pass: resumed, superseded, expired or invalid. */
  plan: z.enum(["resumed", "superseded", "expired", "deferred", "failed", "invalid"]),
  preview: z.string(),
});

const retainedListReturnSchema = z.object({
  ttlMinutes: z.number(),
  total: z.number(),
  items: z.array(retainedStartReturnSchema),
});

const retainedResumeReturnSchema = z.object({
  ok: z.boolean(),
  itemId: z.string(),
  sessionName: z.string(),
  requeuedAt: z.string(),
});

function describe(item: ReturnType<typeof listRetainedStarts>[number], now: number) {
  const decision = classifyRetainedStart(item, now);
  const prompt = decision.envelope?.prompt.prompt ?? "";
  return {
    itemId: item.id,
    sessionName: decision.sessionName,
    status: item.status,
    refusedAt: new Date(decision.occurredAt).toISOString(),
    ageMinutes: Math.round((now - decision.occurredAt) / 60_000),
    // A claimed item may already have reached the provider; it is listed but never run again.
    plan: item.status === "assigned" ? ("failed" as const) : decision.outcome,
    preview: prompt.replace(/\s+/g, " ").slice(0, 120),
  };
}

@Group({
  name: "sessions.retained",
  description: "Requests refused for lack of runtime capacity and saved for resume",
})
export class SessionRetainedCommands {
  constructor(
    private readonly dependencies: {
      publishSessionPrompt: (sessionName: string, payload: Record<string, unknown>) => Promise<void>;
    } = { publishSessionPrompt },
  ) {}

  @Scope("admin")
  @Command({ name: "list", description: "List saved capacity refusals and what the daemon will do with each" })
  @CommandAccess({ kind: "read", resource: "sessions.retained", action: "list", risk: "low" })
  @Returns(retainedListReturnSchema)
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const now = Date.now();
    const items = listRetainedStarts().map((item) => describe(item, now));
    const payload = { ttlMinutes: RETAINED_START_TTL_MS / 60_000, total: items.length, items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (items.length === 0) {
      console.log("No saved capacity refusals.");
      return payload;
    }
    console.log(`\nSaved capacity refusals (${items.length}), oldest first:\n`);
    for (const item of items) {
      console.log(`- ${item.itemId}  ${item.sessionName}  ${item.ageMinutes} min  → ${item.plan}`);
      console.log(`  ${item.preview}`);
    }
    return payload;
  }

  @Scope("admin")
  @Command({
    name: "resume",
    description: "Put one saved request back on its session's prompt queue (dry-run unless --execute)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.retained",
    action: "resume",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(retainedResumeReturnSchema)
  async resume(
    @Arg("item", { description: "Inbox item id of the saved request" }) itemId: string,
    @Option({ flags: "--force", description: "Resume even if the session was served later or the request expired" })
    force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Requeue the request; default is a dry-run (exit 3)" })
    execute?: boolean,
  ) {
    const item = listRetainedStarts().find((candidate) => candidate.id === itemId);
    if (!item) {
      fail(`No open saved capacity refusal with id ${itemId}. See: ravi sessions retained list`);
      return;
    }
    const now = Date.now();
    const plan = describe(item, now);
    const decision = classifyRetainedStart(item, now);
    if (!decision.envelope) fail(`Saved request ${itemId} has no usable prompt envelope.`);
    if (item.status === "assigned") {
      fail(`Saved request ${itemId} was already claimed by a resume and may have run; it is not run twice.`);
    }
    if (!force && (decision.outcome === "superseded" || decision.outcome === "expired")) {
      fail(`Saved request ${itemId} is ${decision.outcome}; pass --force to requeue it anyway.`);
    }
    if (execute !== true) {
      contractDryRun("sessions retained resume", { ...plan, action: "requeue_prompt" }, { asJson });
    }
    const envelope = decision.envelope!;
    // Requeue through normal intake: admission, ordering and a fresh refusal receipt all behave as for a new prompt.
    await this.dependencies.publishSessionPrompt(
      envelope.sessionName,
      envelope.prompt as unknown as Record<string, unknown>,
    );
    const requeuedAt = new Date().toISOString();
    markLocalInboxItem(item.id, "done", {
      eventType: "resume_requeued",
      actorType: "unknown",
      payload: { status: "done", outcome: "requeued", requeuedAt, forced: Boolean(force) },
    });
    const result = { ok: true, itemId: item.id, sessionName: envelope.sessionName, requeuedAt };
    if (asJson) printJson(result);
    else console.log(`✓ Requeued ${item.id} on ${envelope.sessionName}.`);
    return result;
  }
}
