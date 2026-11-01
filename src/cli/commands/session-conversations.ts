import {
  conversationSchema,
  historySchema,
  snapshotSchema,
  journalSchema,
  createdSchema,
  acceptedSchema,
  cancelledSchema,
  decidedSchema,
  receiptSchema,
  deliveryBarrierSchema,
  replyToSchema,
} from "../../bridge/schemas.js";
import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Returns, Option } from "../decorators.js";
import { contractFail } from "../agent-contract.js";
import { currentConsoleInvocation, consoleInvocationLive } from "../../sdk/gateway/console-context.js";
import { BridgeError, type BridgeRequest } from "../../bridge/protocol.js";

const id = z.string().uuid();
/** Private session storage adapter, shared by CLI, SDK and Console through the dispatcher.
 * Local agent/operator contexts deliberately do not confer another person's ownership.
 */
function invoke(command: BridgeRequest["command"], input: Record<string, unknown>): unknown {
  const invocation = currentConsoleInvocation();
  if (!invocation || !consoleInvocationLive(invocation))
    contractFail(
      "sessions conversations",
      "CONSOLE_AUTHORITY_REQUIRED",
      "A current signed Console delegation is required",
    );
  const { grant, enrollment, service } = invocation;
  if (
    input.projectId !== grant.projectId ||
    input.requestId !== grant.operationId ||
    input.createdAt !== grant.createdAt
  )
    contractFail("sessions conversations", "INVALID_DELEGATION", "Invocation identity does not match the delegation");
  if (
    "conversationId" in input &&
    (grant.scope.kind !== "session" || grant.scope.conversationId !== input.conversationId)
  )
    contractFail("sessions conversations", "NOT_FOUND_OR_DENIED", "Session is outside the delegation");
  try {
    return service.executeAuthorized({ ...input, command } as BridgeRequest, grant, enrollment);
  } catch (error) {
    if (error instanceof BridgeError)
      contractFail("sessions conversations", error.code, error.code, { details: { effectState: error.effectState } });
    throw error;
  }
}

@Group({
  name: "sessions.conversations",
  description: "Owner-scoped private sessions with durable execution receipts",
  scope: "resource",
})
export class SessionConversationCommands {
  @Command({
    name: "team-create",
    description: "Create a new shared conversation with explicitly authorized people and agents",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.conversations",
    action: "team-create",
    risk: "high",
    localOperator: false,
    consoleOnly: true,
    consoleScope: "project",
  })
  @Returns(createdSchema)
  teamCreate(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("title", { required: true, schema: z.string().trim().min(1).max(120) }) title: string,
    @Arg("agentIds", {
      required: true,
      schema: z
        .array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/))
        .min(2)
        .max(6),
    })
    agentIds: string[],
    @Arg("personIds", { required: true, schema: z.array(id).max(30) }) personIds: string[],
  ) {
    return invoke("team-create", { projectId, requestId, createdAt, title, agentIds, personIds });
  }
  @Command({ name: "agents", description: "agents.list in the authorized private session store" })
  @CommandAccess({
    kind: "read",
    resource: "sessions.conversations",
    action: "agents",
    risk: "low",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "project",
  })
  @Returns(z.array(z.object({ id: z.string(), name: z.string() })))
  agents(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("agents", { projectId, requestId, createdAt });
  }
  @Command({ name: "list", description: "conversations.list in the authorized private session store" })
  @CommandAccess({
    kind: "read",
    resource: "sessions.conversations",
    action: "list",
    risk: "low",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "project",
  })
  @Returns(z.array(conversationSchema))
  list(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Option({
      flags: "--limit <n>",
      description: "Page size (default 100, max 100)",
      schema: z.number().int().min(1).max(100).optional(),
    })
    limit = 100,
    @Option({
      flags: "--offset <n>",
      description: "Skip authorized conversations",
      schema: z.number().int().min(0).optional(),
    })
    offset = 0,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("list", { projectId, requestId, createdAt, limit, offset });
  }
  @Command({ name: "create", description: "conversations.create in the authorized private session store" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.conversations",
    action: "create",
    risk: "medium",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "project",
  })
  @Returns(createdSchema)
  create(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("agentId", { required: true, schema: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }) agentId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("create", { projectId, requestId, createdAt, agentId });
  }
  @Command({ name: "open", description: "conversations.open in the authorized private session store" })
  @CommandAccess({
    kind: "read",
    resource: "sessions.conversations",
    action: "open",
    risk: "low",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(snapshotSchema)
  open(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("open", { projectId, requestId, createdAt, conversationId });
  }
  @Command({ name: "history", description: "messages.list in the authorized private session store" })
  @CommandAccess({
    kind: "read",
    resource: "sessions.conversations",
    action: "history",
    risk: "low",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(historySchema)
  history(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Arg("before", { required: true, schema: id.nullable() }) before: string | null,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("history", { projectId, requestId, createdAt, conversationId, before });
  }
  @Command({ name: "send", description: "messages.send in the authorized private session store" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.conversations",
    action: "send",
    risk: "high",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(acceptedSchema)
  send(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Arg("text", { required: true, schema: z.string().min(1).max(16384) }) text: string,
    @Arg("expectedVersion", { required: true, schema: z.number().int().nonnegative() }) expectedVersion: number,
    @Option({
      flags: "--barrier <barrier>",
      description: "Delivery barrier: after_tool, after_reply, after_task or record_only",
      schema: deliveryBarrierSchema.optional(),
    })
    barrier: z.infer<typeof deliveryBarrierSchema> = "after_tool",
    @Option({ flags: "--reply-to <json>", description: "Quoted message context", schema: replyToSchema.optional() })
    replyTo?: z.infer<typeof replyToSchema>,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("send", {
      projectId,
      requestId,
      createdAt,
      conversationId,
      text,
      expectedVersion,
      barrier,
      ...(replyTo ? { replyTo } : {}),
    });
  }
  @Command({ name: "events", description: "events.read in the authorized private session store" })
  @CommandAccess({
    kind: "read",
    resource: "sessions.conversations",
    action: "events",
    risk: "low",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(journalSchema)
  events(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Arg("cursor", { required: true, schema: z.string().max(1500).nullable() }) cursor: string | null,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("events", { projectId, requestId, createdAt, conversationId, cursor });
  }
  @Command({ name: "renew", description: "lease.renew in the authorized private session store" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.conversations",
    action: "renew",
    risk: "medium",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(z.object({ renewed: z.boolean(), conversationId: id }))
  renew(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("renew", { projectId, requestId, createdAt, conversationId });
  }
  @Command({ name: "cancel", description: "turns.cancel in the authorized private session store" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.conversations",
    action: "cancel",
    risk: "medium",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(cancelledSchema)
  cancel(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Arg("turnId", { required: true, schema: id }) turnId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("cancel", { projectId, requestId, createdAt, conversationId, turnId });
  }
  @Command({ name: "decide", description: "approvals.decide in the authorized private session store" })
  @CommandAccess({
    kind: "mutate",
    resource: "sessions.conversations",
    action: "decide",
    risk: "high",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "session",
    resourceId: "conversationId",
  })
  @Returns(decidedSchema)
  decide(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("conversationId", { required: true, schema: id }) conversationId: string,
    @Arg("approvalId", { required: true, schema: id }) approvalId: string,
    @Arg("decision", { required: true, schema: z.enum(["approve", "reject"]) }) decision: "approve" | "reject",
    @Arg("expectedVersion", { required: true, schema: z.number().int().positive() }) expectedVersion: number,
    @Arg("actionDigest", { required: true, schema: z.string().length(64) }) actionDigest: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("decide", {
      projectId,
      requestId,
      createdAt,
      conversationId,
      approvalId,
      decision,
      expectedVersion,
      actionDigest,
    });
  }
  @Command({ name: "receipt", description: "requests.get in the authorized private session store" })
  @CommandAccess({
    kind: "read",
    resource: "sessions.conversations",
    action: "receipt",
    risk: "low",
    redactions: ["text"],
    localOperator: false,
    consoleOnly: true,
    consoleScope: "project",
  })
  @Returns(receiptSchema)
  receipt(
    @Arg("projectId", { required: true, schema: id }) projectId: string,
    @Arg("requestId", { required: true, schema: id }) requestId: string,
    @Arg("createdAt", { required: true, schema: z.number().int().positive() }) createdAt: number,
    @Arg("targetRequestId", { required: true, schema: id }) targetRequestId: string,
    @Option({ flags: "--json", description: "Print structured result" }) _asJson = false,
  ) {
    return invoke("receipt", { projectId, requestId, createdAt, targetRequestId });
  }
}
