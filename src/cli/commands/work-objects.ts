import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import { fail, getContext } from "../context.js";
import { jsonObjectSchema, jsonValueSchema } from "../return-schemas.js";
import {
  createWorkObjectRequestContext,
  executeWorkObjectAction,
  resolveWorkObject,
  suggestWorkObjectOptions,
  updateWorkObject,
  type WorkObjectExternalRef,
  type WorkObjectRequestContext,
} from "../../work-objects/index.js";

const workObjectExternalRefSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
});

const workObjectActionSchema = z.object({
  text: z.string(),
  actionId: z.string().optional(),
  value: z.string().optional(),
  style: z.enum(["primary", "danger"]).optional(),
  url: z.string().optional(),
  accessibilityLabel: z.string().optional(),
  processingState: z
    .object({
      enabled: z.boolean(),
      interstitialText: z.string().optional(),
    })
    .optional(),
});

const workObjectActionSetSchema = z.object({
  primaryActions: z.array(workObjectActionSchema).optional(),
  overflowActions: z.array(workObjectActionSchema).optional(),
});

const workObjectFieldSchema = z.object({
  value: jsonValueSchema.optional(),
  label: z.string().optional(),
  type: z.string().optional(),
  long: z.boolean().optional(),
  edit: jsonObjectSchema.optional(),
});

const workObjectCustomFieldSchema = workObjectFieldSchema.extend({
  key: z.string(),
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const workObjectSchema = z.object({
  url: z.string(),
  externalRef: workObjectExternalRefSchema,
  title: z.string(),
  kind: z.string().optional(),
  entityType: z.string().optional(),
  displayId: z.string().optional(),
  displayType: z.string().optional(),
  productName: z.string().optional(),
  productIconUrl: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  metadataLastModified: z.number().optional(),
  revision: z.string().optional(),
  attributes: jsonObjectSchema.optional(),
  fields: z.record(z.string(), workObjectFieldSchema).optional(),
  actions: workObjectActionSetSchema.optional(),
  displayOrder: z.array(z.string()).optional(),
  customFields: z.array(workObjectCustomFieldSchema).optional(),
});

const workObjectResolveReturnSchema = z.object({
  providerId: z.string(),
  result: workObjectSchema,
});

const workObjectUpdateResultSchema = z.object({
  object: workObjectSchema.optional(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
  formError: z.string().optional(),
  revision: z.string().optional(),
});

const workObjectActionResultSchema = z.object({
  object: workObjectSchema.optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

const workObjectUpdateReturnSchema = z.object({
  providerId: z.string(),
  result: workObjectUpdateResultSchema,
});

const workObjectActionReturnSchema = z.object({
  providerId: z.string(),
  result: workObjectActionResultSchema,
});

const workObjectSuggestReturnSchema = z.object({
  providerId: z.string(),
  result: z.array(z.object({ text: z.string(), value: z.string() })),
});

// ============================================================
// Manual v2 contract helpers (error envelope).
// Text mode keeps the legacy `fail()` behavior; `--json` emits the
// {success:false, error:{code, ...}} envelope. Exit taxonomy:
// 1 not-found/provider · 2 usage · 3 policy (write brake / dry-run).
//
// SCOPE NOTE: Work Objects are provider-owned external references resolved
// through domain adapters; there is no cheap local enumeration across
// adapters, so WORK_OBJECT_NOT_FOUND carries a suggestedAction pointing to
// the adapter-backed listing (tasks today) instead of `suggestions`.
// Braked op: `action` executes an opaque provider actionId whose blast
// radius the CLI cannot inspect. `update` stays unbraked (declared): it is a
// field-validated patch with an optimistic `--revision` guard.
// ============================================================

function failWorkObjectNotFound(op: string, ref: string, asJson?: boolean): never {
  contractFail(op, "WORK_OBJECT_NOT_FOUND", `Work Object not found: ${ref}`, {
    asJson,
    details: {
      suggestedAction:
        "Check the reference (URL or type:id). Task-backed objects use --type task --id <task-id>; list ids with: ravi tasks list --json",
    },
  });
}

@Group({
  name: "work-objects",
  description: "Resolve and mutate generic Work Objects through Ravi domain adapters",
  scope: "open",
})
export class WorkObjectCommands {
  @Command({ name: "resolve", description: "Resolve a Work Object by URL or external reference" })
  @CommandAccess({
    kind: "read",
    resource: "work-objects",
    action: "resolve",
    risk: "low",
    input: ["target", "type", "id"],
  })
  @Returns(workObjectResolveReturnSchema)
  async resolve(
    @Arg("target", { required: false, description: "URL or object id" }) target?: string,
    @Option({ flags: "--type <type>", description: "External reference type, e.g. task" }) type?: string,
    @Option({ flags: "--id <id>", description: "External reference id" }) id?: string,
    @Option({ flags: "--url <url>", description: "Object URL to resolve" }) url?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const input = buildResolveInput({ target, type, id, url });
    const result = await resolveWorkObject(input, buildCommandContext());
    if (!result) {
      failWorkObjectNotFound("work-objects resolve", describeResolveInput(input), asJson);
    }
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printResolved(result.result);
    return result;
  }

  @Command({ name: "update", description: "Apply a structured patch to a Work Object" })
  @CommandAccess({
    kind: "mutate",
    resource: "work-objects",
    action: "update",
    risk: "medium",
    input: ["type", "id", "values"],
    redactions: ["values"],
  })
  @Returns(workObjectUpdateReturnSchema)
  async update(
    @Arg("type", { description: "External reference type, e.g. task" }) type: string,
    @Arg("id", { description: "External reference id" }) id: string,
    @Option({ flags: "--values <json>", description: "Patch values as JSON object" }) valuesJson?: string,
    @Option({ flags: "--revision <revision>", description: "Optional optimistic revision" }) revision?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const values = parseJsonObject(valuesJson, "--values");
    const result = await updateWorkObject(
      requireRef(type, id),
      {
        values,
        ...(revision?.trim() ? { revision: revision.trim() } : {}),
      },
      buildCommandContext(),
    );
    if (!result) {
      // No adapter handled the external reference — the object cannot exist
      // for this CLI, so the not-found envelope applies.
      failWorkObjectNotFound("work-objects update", `${type}:${id}`, asJson);
    }
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printMutation(result.result);
    return result;
  }

  @Command({ name: "action", description: "Execute one Work Object action" })
  @CommandAccess({
    kind: "mutate",
    resource: "work-objects",
    action: "action",
    risk: "medium",
    requiresConfirmation: true,
    input: ["type", "id", "actionId"],
  })
  @Returns(workObjectActionReturnSchema)
  async action(
    @Arg("type", { description: "External reference type, e.g. task" }) type: string,
    @Arg("id", { description: "External reference id" }) id: string,
    @Arg("actionId", { description: "Action id, e.g. task.comment" }) actionId: string,
    @Option({ flags: "--value <value>", description: "Optional action value" }) value?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually execute the provider action; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const ref = requireRef(type, id);
    const normalizedActionId = requireNonEmpty(actionId, "actionId");
    const normalizedValue = value?.trim() || undefined;
    if (execute !== true) {
      // Write brake (Manual v2 7.8): the actionId is executed by a domain
      // adapter and its semantics are opaque to the CLI (it may complete,
      // archive, or fail external work) — dry-run by default and exit 3
      // BEFORE any adapter call.
      contractDryRun(
        "work-objects action",
        {
          ref,
          actionId: normalizedActionId,
          valuePresent: normalizedValue !== undefined,
        },
        { asJson },
      );
    }
    const result = await executeWorkObjectAction(
      ref,
      {
        actionId: normalizedActionId,
        ...(normalizedValue ? { value: normalizedValue } : {}),
      },
      buildCommandContext(),
    );
    if (!result) {
      failWorkObjectNotFound("work-objects action", `${type}:${id}`, asJson);
    }
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printMutation(result.result);
    return result;
  }

  @Command({ name: "suggest", description: "Suggest selectable options for a Work Object field" })
  @CommandAccess({
    kind: "read",
    resource: "work-objects",
    action: "suggest",
    risk: "low",
    input: ["type", "id", "fieldId"],
  })
  @Returns(workObjectSuggestReturnSchema)
  async suggest(
    @Arg("type", { description: "External reference type, e.g. task" }) type: string,
    @Arg("id", { description: "External reference id" }) id: string,
    @Arg("fieldId", { description: "Field id, e.g. status" }) fieldId: string,
    @Option({ flags: "--query <text>", description: "Optional suggestion filter" }) query?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await suggestWorkObjectOptions(
      requireRef(type, id),
      {
        fieldId: requireNonEmpty(fieldId, "fieldId"),
        ...(query?.trim() ? { query: query.trim() } : {}),
      },
      buildCommandContext(),
    );
    if (!result) {
      failWorkObjectNotFound("work-objects suggest", `${type}:${id}`, asJson);
    }
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else {
      for (const option of result.result) console.log(`${option.value}\t${option.text}`);
    }
    return result;
  }
}

function buildResolveInput(input: { target?: string; type?: string; id?: string; url?: string }): {
  url?: string;
  externalRef?: WorkObjectExternalRef;
} {
  const target = input.target?.trim();
  const url = input.url?.trim() || (target && looksLikeUrl(target) ? target : undefined);
  const id = input.id?.trim() || (target && !looksLikeUrl(target) ? target : undefined);
  const type = input.type?.trim();

  if (url) return { url };
  if (id) {
    return {
      externalRef: {
        id,
        ...(type ? { type } : {}),
      },
    };
  }
  fail("Provide a URL, --url, or --id.");
}

function describeResolveInput(input: { url?: string; externalRef?: WorkObjectExternalRef }): string {
  if (input.url) return input.url;
  if (input.externalRef) {
    return input.externalRef.type ? `${input.externalRef.type}:${input.externalRef.id}` : input.externalRef.id;
  }
  return "(empty reference)";
}

function buildCommandContext(): WorkObjectRequestContext {
  const ctx = getContext();
  const instanceId = ctx?.source?.accountId ?? "cli";
  const channel = {
    channel: ctx?.source?.channel ?? "cli",
    instanceId,
    ...(ctx?.source?.chatId ? { channelId: ctx.source.chatId } : {}),
    ...(ctx?.source?.threadId ? { threadTs: ctx.source.threadId } : {}),
  };
  const metadata: Record<string, unknown> = {};
  if (ctx?.contextId) metadata.contextId = ctx.contextId;
  if (ctx?.sessionKey) metadata.sessionKey = ctx.sessionKey;
  if (ctx?.sessionName) metadata.sessionName = ctx.sessionName;
  if (ctx?.agentId) metadata.agentId = ctx.agentId;

  return createWorkObjectRequestContext({
    instanceId,
    channel,
    actor: ctx?.agentId ? { id: ctx.agentId, username: ctx.agentId, displayName: ctx.agentId } : { id: "cli" },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
}

function requireRef(type: string, id: string): WorkObjectExternalRef {
  return {
    type: requireNonEmpty(type, "type"),
    id: requireNonEmpty(id, "id"),
  };
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) fail(`${label} is required.`);
  return trimmed;
}

function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes("/");
}

function printResolved(object: {
  title: string;
  externalRef: WorkObjectExternalRef;
  status?: string;
  url: string;
}): void {
  console.log(`Work Object: ${object.title}`);
  console.log(`  Ref: ${object.externalRef.type ?? "-"}:${object.externalRef.id}`);
  if (object.status) console.log(`  Status: ${object.status}`);
  console.log(`  URL: ${object.url}`);
}

function printMutation(result: unknown): void {
  if (result && typeof result === "object" && "message" in result && typeof result.message === "string") {
    console.log(result.message);
    return;
  }
  if (result && typeof result === "object" && "fieldErrors" in result) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("Work Object updated.");
}
