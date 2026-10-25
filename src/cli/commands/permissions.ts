/**
 * Permissions Commands - provider-runtime introspection only.
 *
 * Authorization and inspection are provider-runtime only.
 */

import "reflect-metadata";
import { z } from "zod";
import { getContact, removeContactTag, type Contact } from "../../contacts.js";
import {
  dbDeleteContactChatGrant,
  dbGetContactChatGrant,
  type ContactChatGrantScopeType,
} from "../../permissions/contact-chat-grants.js";
import {
  formatContactGrantScope,
  isUserOverlayActiveForChat,
  listContactGlobalProfileGrants,
  listContactProfileGrantsCoveringChat,
  listContactScopedProfileGrants,
  resolveContactChatOverlay,
  type ContactGrantScope,
  type ContactProfileGrant,
} from "../../permissions/contact-policy-permissions-provider.js";
import { dbGetChat, dbGetThreadParentChat, dbListChatsByRef, type ChatRecord } from "../../router/router-db.js";
import { revokeLiveRuntimeContextsForContactGrant } from "../../runtime/context-registry.js";
import { canonicalAssetIdsForTag, canonicalTagSlugsForAsset, tryNormalizeTagSlug } from "../../tags/index.js";
import { CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";
import { getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { strictCliOffsetPaginationSchema } from "../return-schemas.js";
import {
  isChatOnlyRuntimePermissions,
  readAgentRuntimePermissionsConfig,
} from "../../permissions/agent-default-capabilities-provider.js";
import {
  buildAuthorizationGuidance,
  formatCanonicalCapability,
  normalizeAuthorizationCapabilityInput,
  readPermissionTagCapabilities,
  type AuthorizationCapability,
  type AuthorizationSubject,
} from "../../permissions/authorization-guidance.js";
import { getPermissionDenial, type PermissionDenial } from "../../permissions/denials.js";
import {
  assertProviderOwnedPermissionTag as assertProviderOwnedPermissionProfile,
  capabilityListsEqual as grantCapabilityListsEqual,
  derivePermissionProfileSlugForCapability,
  ensureAgentCeilingCapability,
  grantContactProfile,
  labelFromProfile,
  normalizePermissionProfileSlug,
  upsertPermissionProfileDefinition,
} from "../../permissions/apply-grant.js";
import { dbGetTagDefinition } from "../../tags/index.js";
import type { TagDefinition } from "../../tags/types.js";
import type { OffsetPagination } from "../../utils/pagination.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import {
  getConfiguredCapabilityMaterializers,
  getConfiguredPermissionProviders,
} from "../../permissions/provider-registry.js";
import { authorizePermission, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const CHAT_OPTION_DESCRIPTION =
  "Scope contact grants to one chat (canonical chat id, platform chat id, or 'current'). Threads inherit their chat.";
const CHAT_TAG_OPTION_DESCRIPTION = "Scope contact grants to every chat carrying this chat tag";
const FORCE_OPTION_DESCRIPTION =
  "Explicitly use the global (all chats) contact scope. Prefer --chat; ask the human before going global.";

const providerSchema = z.object({
  id: z.string(),
  version: z.string(),
  required: z.boolean(),
});

const permissionsStatusReturnSchema = z.object({
  status: z.literal("provider-runtime"),
  mutationCommands: z.object({
    enabled: z.boolean(),
    message: z.string(),
  }),
  guidance: z.object({
    inspect: z.array(z.string()),
    recurringAccess: z.string(),
    breakGlass: z.string(),
  }),
  authorizationProviders: z.array(providerSchema),
  capabilityMaterializers: z.array(providerSchema),
});

const permissionProviderSubjectReturnSchema = z.object({
  type: z.string(),
  id: z.string(),
});

const permissionProviderDecisionReturnSchema = z.object({
  decision: z.enum(["allow", "deny", "needs_approval", "not_applicable"]),
  allowed: z.boolean(),
  providerId: z.string(),
  providerVersion: z.string(),
  reasonCode: z.string(),
  permission: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  requestId: z.string().optional(),
  durationMs: z.number().optional(),
  subject: permissionProviderSubjectReturnSchema.optional(),
  contextId: z.string().optional(),
  evidence: z
    .array(
      z.object({
        kind: z.string().optional(),
        message: z.string().optional(),
        source: z.string().optional(),
        providerId: z.string().optional(),
        permission: z.string().optional(),
        objectType: z.string().optional(),
        objectId: z.string().optional(),
      }),
    )
    .optional(),
});

const permissionsCheckReturnSchema = z.object({
  allowed: z.boolean(),
  decision: permissionProviderDecisionReturnSchema,
  guidance: z
    .object({
      canonicalCapability: z.string(),
      scope: z.string(),
      inspectCommands: z.array(z.string()),
      preferredPath: z.object({
        kind: z.string(),
        message: z.string(),
        allowCommand: z.string().optional(),
        suggestedTags: z.array(
          z.object({
            slug: z.string(),
            label: z.string(),
            description: z.string().optional(),
            capabilities: z.array(z.string()),
          }),
        ),
      }),
      candidateCapabilities: z.array(z.string()).optional(),
      rawCapabilityFallback: z.string(),
      breakGlass: z.string(),
      requestShape: z.object({
        subject: z.string().optional(),
        scope: z.string(),
        profileOrTag: z.string(),
        reason: z.string(),
        ttl: z.string(),
      }),
      nextSteps: z.array(z.string()),
    })
    .optional(),
  diagnosticNote: z.string().optional(),
});

const permissionsMaterializeReturnSchema = z.object({
  subject: z.object({
    type: z.string(),
    id: z.string(),
  }),
  capabilities: z.array(
    z.object({
      permission: z.string(),
      objectType: z.string(),
      objectId: z.string(),
      source: z.string().optional(),
    }),
  ),
  profile: z.string().optional(),
  guidance: z.object({
    recurringAccess: z.string(),
    breakGlass: z.string(),
    chatOnly: z.string().optional(),
  }),
});

const permissionCapabilityReturnSchema = z.object({
  permission: z.string(),
  objectType: z.string(),
  objectId: z.string(),
});

const permissionTargetReturnSchema = z.object({
  type: z.string(),
  id: z.string(),
});

const permissionAllowOperationReturnSchema = z.object({
  kind: z.string(),
  status: z.enum(["planned", "applied", "unchanged"]),
  target: z.string().optional(),
  capability: z.string().optional(),
  message: z.string(),
});

const permissionContactScopeReturnSchema = z.object({
  type: z.enum(["chat", "chat_tag", "global"]),
  label: z.string(),
  chatId: z.string().optional(),
  requestedChatId: z.string().optional(),
  threadChatId: z.string().optional(),
  channel: z.string().optional(),
  title: z.string().optional(),
  known: z.boolean().optional(),
  chatTag: z.string().optional(),
  taggedChatCount: z.number().optional(),
});

const permissionConfirmationReturnSchema = z.object({
  action: z.enum(["allow", "deny", "list"]),
  dryRun: z.boolean(),
  contacts: z.array(z.string()),
  agents: z.array(z.string()),
  scopes: z.array(z.string()),
  global: z.boolean(),
  force: z.boolean(),
  profile: z.string().optional(),
  capabilities: z.array(z.string()),
  message: z.string(),
});

const permissionsAllowReturnSchema = z.object({
  dryRun: z.boolean(),
  profile: z.string(),
  tagSlug: z.string(),
  label: z.string(),
  description: z.string().optional(),
  capabilities: z.array(permissionCapabilityReturnSchema),
  targets: z.array(permissionTargetReturnSchema),
  agentCeilings: z.array(z.string()),
  scopes: z.array(permissionContactScopeReturnSchema),
  force: z.boolean(),
  operations: z.array(permissionAllowOperationReturnSchema),
  changedCount: z.number(),
  confirmation: permissionConfirmationReturnSchema,
  hints: z.array(z.string()),
  nextCommand: z.string().optional(),
});

const permissionsDenyReturnSchema = z.object({
  dryRun: z.boolean(),
  profile: z.string(),
  tagSlug: z.string(),
  capabilities: z.array(permissionCapabilityReturnSchema),
  targets: z.array(permissionTargetReturnSchema),
  scopes: z.array(permissionContactScopeReturnSchema),
  force: z.boolean(),
  operations: z.array(permissionAllowOperationReturnSchema),
  changedCount: z.number(),
  confirmation: permissionConfirmationReturnSchema,
  hints: z.array(z.string()),
  nextCommand: z.string().optional(),
});

const permissionContactGrantReturnSchema = z.object({
  contact: z.string(),
  profile: z.string(),
  scope: z.string(),
  scopeType: z.enum(["chat", "chat_tag", "global"]),
  source: z.enum(["contact-chat-grant", "contact-tag"]),
  capabilities: z.array(z.string()),
});

const permissionContactChatOverlayReturnSchema = z.object({
  contact: z.string(),
  chat: z.string(),
  governed: z.boolean(),
  eligible: z.boolean(),
  capabilities: z.array(z.string()),
});

const permissionsListReturnSchema = z.object({
  targets: z.array(permissionTargetReturnSchema),
  scopes: z.array(permissionContactScopeReturnSchema),
  force: z.boolean(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  grants: z.array(permissionContactGrantReturnSchema),
  overlays: z.array(permissionContactChatOverlayReturnSchema),
  confirmation: permissionConfirmationReturnSchema,
  hints: z.array(z.string()),
});

const permissionsResolveReturnSchema = permissionsAllowReturnSchema.extend({
  denial: z.object({
    id: z.number(),
    missingCapability: z.string(),
    subject: z.string(),
    agentId: z.string().nullable(),
    sessionName: z.string().nullable(),
    contextId: z.string().nullable(),
  }),
  guidance: permissionsCheckReturnSchema.shape.guidance.optional(),
});

@Group({
  name: "permissions",
  description: "Inspect provider-runtime authorization",
  scope: "open",
})
export class PermissionsCommands {
  @Command({ name: "status", description: "Show the active provider-runtime permission chain" })
  @CommandAccess({ kind: "read", resource: "permissions", action: "status", risk: "low" })
  @Returns(permissionsStatusReturnSchema)
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const payload = {
      status: "provider-runtime" as const,
      mutationCommands: {
        enabled: true,
        message:
          "Permission mutation commands are provider-owned orchestration only; use dry-run first and --apply explicitly.",
      },
      guidance: {
        inspect: [
          "ravi permissions check --permission <perm> --object-type <type> --object-id <id>",
          "ravi permissions materialize --subject-type <type> --subject-id <id>",
          "ravi permissions resolve <denial-id>",
          "ravi permissions list --to contact:<id> --chat <chat-id>",
        ],
        recurringAccess:
          "Use ravi permissions allow <profile> --to agent:<agent-id> for recurring agent identity access.",
        breakGlass: "Do not ask for full-access unless the operator explicitly approves break-glass.",
      },
      authorizationProviders: getConfiguredPermissionProviders().map(serializeProvider),
      capabilityMaterializers: getConfiguredCapabilityMaterializers().map(serializeProvider),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log("permissions: provider-runtime");
    console.log("mutation commands: provider-owned orchestration enabled");
    console.log(`authorization providers: ${payload.authorizationProviders.map((item) => item.id).join(", ")}`);
    console.log(`capability materializers: ${payload.capabilityMaterializers.map((item) => item.id).join(", ")}`);
    console.log("next: use resolve <denial-id> or allow <profile> --apply for recurring access");
    return payload;
  }

  @Command({ name: "check", description: "Evaluate a provider-runtime permission request" })
  @CommandAccess({ kind: "read", resource: "permissions", action: "check", risk: "low" })
  @Returns(permissionsCheckReturnSchema)
  check(
    @Option({ flags: "--permission <permission>", description: "Permission/relation to check" }) permission?: string,
    @Option({ flags: "--object-type <type>", description: "Object type" }) objectType?: string,
    @Option({ flags: "--object-id <id>", description: "Object id" }) objectId?: string,
    @Option({ flags: "--local-operator", description: "Evaluate through explicit operator-control local path" })
    localOperator?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedPermission = requiredOption(permission, "--permission");
    const normalizedObjectType = requiredOption(objectType, "--object-type");
    const normalizedObjectId = requiredOption(objectId, "--object-id");
    const decision = authorizePermission({
      ...(localOperator === true ? { localOperator: true } : {}),
      permission: normalizedPermission,
      objectType: normalizedObjectType,
      objectId: normalizedObjectId,
    });
    const guidance = buildAuthorizationGuidance({
      capability: {
        permission: normalizedPermission,
        objectType: normalizedObjectType,
        objectId: normalizedObjectId,
      },
      scope: "diagnostic",
      includeProviderOwnedTags: true,
    });
    const diagnosticNote =
      !decision.allowed && decision.reasonCode === "no_permission_provider_configured"
        ? "This check has no subject or runtime context, so authorize cannot see agent-default-capabilities. Inspect with `ravi permissions materialize --subject-type agent --subject-id <id> --json`. Recurring grants use `ravi permissions allow <profile> --to agent:<id> --apply`."
        : undefined;
    const payload = {
      allowed: decision.allowed,
      decision,
      ...(!decision.allowed
        ? {
            guidance,
            ...(diagnosticNote ? { diagnosticNote } : {}),
          }
        : {}),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(decision.allowed ? "allowed" : "denied");
    console.log(`${decision.providerId}@${decision.providerVersion}: ${decision.reasonCode}`);
    if (!decision.allowed && payload.guidance) {
      if (payload.guidance.candidateCapabilities && payload.guidance.candidateCapabilities.length > 1) {
        console.log(`required candidates: ${payload.guidance.candidateCapabilities.join(", ")}`);
      }
      console.log(`missing capability: ${payload.guidance.canonicalCapability}`);
      console.log(`inspect: ${payload.guidance.inspectCommands[0]}`);
      console.log(`recurring: ${payload.guidance.preferredPath.message}`);
      if (payload.guidance.preferredPath.allowCommand) {
        console.log(`allow: ${payload.guidance.preferredPath.allowCommand}`);
      }
      console.log(`fallback: ${payload.guidance.rawCapabilityFallback}`);
      console.log(`break-glass: ${payload.guidance.breakGlass}`);
      if (payload.diagnosticNote) {
        console.log(`note: ${payload.diagnosticNote}`);
      }
    }
    return payload;
  }

  @Command({ name: "allow", description: "Plan or apply a provider-owned permission profile to subjects" })
  @CommandAccess({ kind: "mutate", resource: "permissions", action: "allow", risk: "medium" })
  @Returns(permissionsAllowReturnSchema)
  allow(
    @Arg("profile", { description: "Permission profile/tag name, with or without permission- prefix" }) profile: string,
    @Option({
      flags: "--to <subjects>",
      description:
        "Comma-separated subjects to receive the profile: agent:<id> (identity ceiling) or contact:<id> (user overlay; requires --chat, --chat-tag or --force).",
    })
    subjects?: string,
    @Option({
      flags: "--agent <ids>",
      description: "Comma-separated executor agents whose runtime ceiling must include the profile capabilities",
    })
    agentIds?: string,
    @Option({
      flags: "--capabilities <caps>",
      description: "Comma-separated capabilities, e.g. mutate:image:generate,execute:executable:curl",
    })
    capabilities?: string,
    @Option({ flags: "--label <label>", description: "Human label when creating/updating the profile tag" })
    label?: string,
    @Option({ flags: "--description <description>", description: "Description when creating/updating the profile tag" })
    description?: string,
    @Option({ flags: "--apply", description: "Apply the planned provider-owned mutations" })
    apply?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--chat <chat>", description: CHAT_OPTION_DESCRIPTION }) chat?: string,
    @Option({ flags: "--chat-tag <tag>", description: CHAT_TAG_OPTION_DESCRIPTION }) chatTag?: string,
    @Option({ flags: "--force", description: FORCE_OPTION_DESCRIPTION }) force?: boolean,
  ) {
    const payload = buildPermissionAllowPlan({
      profile,
      subjects,
      agentIds,
      capabilities,
      label,
      description,
      apply: apply === true,
      chat,
      chatTag,
      force: force === true,
      asJson,
    });

    if (asJson) {
      printJson(payload);
      return payload;
    }

    printPermissionAllowPlan(payload);
    return payload;
  }

  @Command({ name: "deny", description: "Plan or revoke a contact permission profile grant in a chat scope" })
  @CommandAccess({ kind: "mutate", resource: "permissions", action: "deny", risk: "medium" })
  @Returns(permissionsDenyReturnSchema)
  deny(
    @Arg("profile", { description: "Permission profile/tag name, with or without permission- prefix" }) profile: string,
    @Option({
      flags: "--to <subjects>",
      description: "Comma-separated contact:<id> subjects to revoke the profile from",
    })
    subjects?: string,
    @Option({ flags: "--chat <chat>", description: CHAT_OPTION_DESCRIPTION }) chat?: string,
    @Option({ flags: "--chat-tag <tag>", description: CHAT_TAG_OPTION_DESCRIPTION }) chatTag?: string,
    @Option({ flags: "--force", description: FORCE_OPTION_DESCRIPTION }) force?: boolean,
    @Option({ flags: "--apply", description: "Apply the planned provider-owned mutations" })
    apply?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const payload = buildPermissionDenyPlan({
      profile,
      subjects,
      chat,
      chatTag,
      force: force === true,
      apply: apply === true,
      asJson,
    });

    if (asJson) {
      printJson(payload);
      return payload;
    }

    printPermissionDenyPlan(payload);
    return payload;
  }

  @Command({ name: "list", description: "List contact permission profile grants in a chat scope" })
  @CommandAccess({ kind: "read", resource: "permissions", action: "list", risk: "low" })
  @Returns(permissionsListReturnSchema)
  list(
    @Option({ flags: "--to <subjects>", description: "Optional comma-separated contact:<id> subjects to filter by" })
    subjects?: string,
    @Option({ flags: "--chat <chat>", description: CHAT_OPTION_DESCRIPTION }) chat?: string,
    @Option({ flags: "--chat-tag <tag>", description: CHAT_TAG_OPTION_DESCRIPTION }) chatTag?: string,
    @Option({ flags: "--force", description: "List global (unscoped) contact grants instead of a chat scope" })
    force?: boolean,
    @Option({ flags: "--profile <profile>", description: "Only show grants for this permission profile" })
    profile?: string,
    @Option({ flags: "--limit <n>", description: "Page size for grants (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching grants to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const payload = buildPermissionListResult({
      subjects,
      chat,
      chatTag,
      force: force === true,
      profile,
      limit,
      offset,
      asJson,
    });

    if (asJson) {
      printJson(payload);
      return payload;
    }

    printPermissionListResult(payload);
    return payload;
  }

  @Command({ name: "resolve", description: "Plan or apply a provider-owned fix for a recorded permission denial" })
  @CommandAccess({ kind: "mutate", resource: "permissions", action: "resolve", risk: "medium" })
  @Returns(permissionsResolveReturnSchema)
  resolve(
    @Arg("denialId", { description: "Permission denial id" }) denialId: string,
    @Option({ flags: "--profile <profile>", description: "Permission profile/tag to use instead of the suggested one" })
    profile?: string,
    @Option({
      flags: "--capabilities <caps>",
      description: "Optional capabilities to merge into the profile; defaults to the denied capability",
    })
    capabilities?: string,
    @Option({ flags: "--apply", description: "Apply the planned provider-owned mutations" })
    apply?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--chat <chat>", description: CHAT_OPTION_DESCRIPTION }) chat?: string,
    @Option({ flags: "--chat-tag <tag>", description: CHAT_TAG_OPTION_DESCRIPTION }) chatTag?: string,
    @Option({ flags: "--force", description: FORCE_OPTION_DESCRIPTION }) force?: boolean,
  ) {
    const denial = requirePermissionDenial(denialId);
    const missingCapability = {
      permission: denial.relation,
      objectType: denial.objectType,
      objectId: denial.objectId,
    };
    const guidance = buildAuthorizationGuidance({
      capability: missingCapability,
      subject: { type: denial.subjectType, id: denial.subjectId },
      scope: "recurring",
      includeProviderOwnedTags: true,
    });
    const inferred = inferResolutionTargets(denial);
    const resolvedProfile =
      profile?.trim() || guidance.preferredPath.suggestedTags[0]?.slug || deriveProfileName(missingCapability);
    const hasExplicitScope = Boolean(chat?.trim() || chatTag?.trim() || force === true);
    const payload = {
      ...buildPermissionAllowPlan({
        profile: resolvedProfile,
        subjects: inferred.subjects,
        agentIds: inferred.agentIds,
        capabilities: capabilities ?? formatCanonicalCapability(missingCapability),
        label: labelFromProfile(resolvedProfile),
        description: `Provider-owned permission profile for ${formatCanonicalCapability(missingCapability)}.`,
        apply: apply === true,
        chat: hasExplicitScope ? chat : inferred.chat,
        chatTag: hasExplicitScope ? chatTag : undefined,
        force: hasExplicitScope ? force === true : false,
        asJson,
        op: "permissions resolve",
        commandPrefix: ["ravi", "permissions", "resolve", String(denial.id)],
      }),
      denial: {
        id: denial.id,
        missingCapability: formatCanonicalCapability(missingCapability),
        subject: `${denial.subjectType}:${denial.subjectId}`,
        agentId: denial.agentId,
        sessionName: denial.sessionName,
        contextId: denial.contextId,
      },
      guidance,
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(`denial: #${denial.id} ${payload.denial.missingCapability}`);
    printPermissionAllowPlan(payload);
    return payload;
  }

  @Command({ name: "materialize", description: "Materialize provider-runtime capabilities for a subject" })
  @CommandAccess({ kind: "read", resource: "permissions", action: "materialize", risk: "low" })
  @Returns(permissionsMaterializeReturnSchema)
  materialize(
    @Option({ flags: "--subject-type <type>", description: "Subject type" }) subjectType?: string,
    @Option({ flags: "--subject-id <id>", description: "Subject id" }) subjectId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedSubjectType = requiredOption(subjectType, "--subject-type");
    const normalizedSubjectId = requiredOption(subjectId, "--subject-id");
    const storedProfile =
      normalizedSubjectType === "agent"
        ? readAgentRuntimePermissionsConfig(normalizedSubjectId)
        : normalizedSubjectType === "agent_identity"
          ? readAgentRuntimePermissionsConfig(normalizedSubjectId.split(":")[0] ?? "")
          : null;
    const chatOnly = isChatOnlyRuntimePermissions(storedProfile);
    const payload = {
      subject: { type: normalizedSubjectType, id: normalizedSubjectId },
      capabilities: materializeSubjectCapabilities(normalizedSubjectType, normalizedSubjectId),
      ...(storedProfile?.profile || chatOnly ? { profile: storedProfile?.profile ?? "chat-only" } : {}),
      guidance: {
        recurringAccess:
          "Recurring access should come from provider-owned agent identity profiles/tags, not ad-hoc capability lists.",
        breakGlass: "full-access is break-glass and should be explicit.",
        ...(chatOnly
          ? {
              chatOnly:
                "chat-only is conversation only (no tools/shell/CLI groups). none/clear/off resets to the bootstrap minimum; it is not zero-authority.",
            }
          : {}),
      },
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (payload.capabilities.length === 0) {
      if (chatOnly) {
        console.log(
          `${normalizedSubjectType}:${normalizedSubjectId} is chat-only: conversation only, no tools/shell/CLI groups.`,
        );
        console.log("none/clear/off resets to the bootstrap minimum; it is not zero-authority.");
        return payload;
      }
      console.log(`${normalizedSubjectType}:${normalizedSubjectId} has no materialized capabilities.`);
      console.log("next: attach a provider-owned permission profile/tag, or add the narrowest explicit capability");
      return payload;
    }

    for (const capability of payload.capabilities) {
      console.log(
        `${capability.permission} ${capability.objectType}:${capability.objectId}` +
          (capability.source ? ` (${capability.source})` : ""),
      );
    }
    return payload;
  }
}

function serializeProvider(provider: { id: string; version: string; required: boolean }) {
  return {
    id: provider.id,
    version: provider.version,
    required: provider.required,
  };
}

interface ContactScopeInput {
  chat?: string;
  chatTag?: string;
  force: boolean;
  asJson?: boolean;
}

interface PermissionAllowInput extends Omit<ContactScopeInput, "force"> {
  profile: string;
  subjects?: string;
  agentIds?: string;
  capabilities?: string;
  label?: string;
  description?: string;
  apply: boolean;
  force?: boolean;
  op?: string;
  commandPrefix?: string[];
}

type ResolvedContactScope =
  | {
      type: "chat";
      label: string;
      chatId: string;
      requestedChatId: string;
      threadChatId?: string;
      channel?: string;
      title?: string;
      known: boolean;
      chatTags: string[];
    }
  | { type: "chat_tag"; label: string; chatTag: string; taggedChatCount: number }
  | { type: "global"; label: "global" };

interface PermissionConfirmation {
  action: "allow" | "deny" | "list";
  dryRun: boolean;
  contacts: string[];
  agents: string[];
  scopes: string[];
  global: boolean;
  force: boolean;
  profile?: string;
  capabilities: string[];
  message: string;
}

interface PermissionAllowOperation {
  kind: string;
  status: "planned" | "applied" | "unchanged";
  target?: string;
  capability?: string;
  message: string;
}

interface PermissionAllowPlan {
  dryRun: boolean;
  profile: string;
  tagSlug: string;
  label: string;
  description?: string;
  capabilities: AuthorizationCapability[];
  targets: AuthorizationSubject[];
  agentCeilings: string[];
  scopes: ReturnType<typeof serializeContactScope>[];
  force: boolean;
  operations: PermissionAllowOperation[];
  changedCount: number;
  confirmation: PermissionConfirmation;
  hints: string[];
  nextCommand?: string;
}

function buildPermissionAllowPlan(input: PermissionAllowInput): PermissionAllowPlan {
  const op = input.op ?? "permissions allow";
  const profile = requiredOption(input.profile, "profile");
  const tagSlug = normalizePermissionTagSlug(profile);
  const targets = parseSubjectRefs(input.subjects);
  const agentCeilings = parseCsv(input.agentIds);
  const operations: PermissionAllowOperation[] = [];
  const force = input.force === true;

  ensureSupportedTargets(targets);
  const contacts = resolveContactTargets(op, targets, input.asJson);
  const scopes =
    contacts.length > 0
      ? resolveContactScopes(op, { ...input, force }, { requireKnownChat: true, suggest: allowScopeSuggester(input) })
      : rejectScopeWithoutContacts(op, { ...input, force });
  const existingTag = dbGetTagDefinition(tagSlug);
  const explicitCapabilities = parseCapabilityList(input.capabilities);
  const capabilities = resolveProfileCapabilities(op, existingTag, explicitCapabilities, input.asJson);
  const label = input.label?.trim() || existingTag?.label || labelFromProfile(tagSlug);
  const description = input.description?.trim() || existingTag?.description;
  const governedBefore = new Map(scopes.map((scope) => [scope.label, isScopeGoverned(scope)]));

  planPermissionTagOperation({
    existingTag,
    tagSlug,
    label,
    description,
    capabilities,
    operations,
    apply: input.apply,
    explicitCapabilitiesProvided: explicitCapabilities !== undefined,
  });

  for (const contact of contacts) {
    for (const scope of scopes) {
      if (scope.type === "global") {
        planContactProfileOperation({ contact, tagSlug, operations, apply: input.apply });
      } else {
        planContactChatGrantOperation({ contact, tagSlug, scope, operations, apply: input.apply });
      }
    }
  }
  for (const target of targets) {
    if (target.type !== "agent") continue;
    for (const capability of capabilities) {
      planAgentCapabilityOperation({ agentId: target.id, capability, operations, apply: input.apply });
    }
  }

  for (const agentId of agentCeilings) {
    for (const capability of capabilities) {
      planAgentCapabilityOperation({ agentId, capability, operations, apply: input.apply, kind: "agent-ceiling" });
    }
  }

  const changedCount = operations.filter((operation) => operation.status === "applied").length;
  const contactRefs = contacts.map((contact) => `contact:${contact.id}`);
  const agentRefs = dedupeStrings([
    ...targets.filter((target) => target.type === "agent").map((target) => `agent:${target.id}`),
    ...agentCeilings.map((agentId) => `agent:${agentId}`),
  ]);
  const capabilityRefs = capabilities.map(formatCanonicalCapability);
  const payload: PermissionAllowPlan = {
    dryRun: !input.apply,
    profile,
    tagSlug,
    label,
    ...(description ? { description } : {}),
    capabilities,
    targets,
    agentCeilings,
    scopes: scopes.map(serializeContactScope),
    force,
    operations,
    changedCount,
    confirmation: buildConfirmation({
      action: "allow",
      dryRun: !input.apply,
      contacts: contactRefs,
      agents: agentRefs,
      scopes,
      force,
      profile: tagSlug,
      capabilities: capabilityRefs,
    }),
    hints: buildAllowHints({
      contacts: contactRefs,
      scopes,
      force,
      tagSlug,
      capabilityRefs,
      agentCeilings,
      governedBefore,
      apply: input.apply,
    }),
  };
  if (!input.apply) {
    payload.nextCommand = buildAllowApplyCommand(input);
  }
  return payload;
}

interface PermissionDenyInput extends ContactScopeInput {
  profile: string;
  subjects?: string;
  apply: boolean;
}

interface PermissionDenyPlan {
  dryRun: boolean;
  profile: string;
  tagSlug: string;
  capabilities: AuthorizationCapability[];
  targets: AuthorizationSubject[];
  scopes: ReturnType<typeof serializeContactScope>[];
  force: boolean;
  operations: PermissionAllowOperation[];
  changedCount: number;
  confirmation: PermissionConfirmation;
  hints: string[];
  nextCommand?: string;
}

function buildPermissionDenyPlan(input: PermissionDenyInput): PermissionDenyPlan {
  const op = "permissions deny";
  const profile = requiredOption(input.profile, "profile");
  const tagSlug = normalizePermissionTagSlug(profile);
  const existingTag = dbGetTagDefinition(tagSlug);
  const capabilities = existingTag ? readPermissionTagCapabilities(existingTag) : [];
  const targets = parseSubjectRefs(input.subjects);
  if (targets.length === 0 || targets.some((target) => target.type !== "contact")) {
    contractFail(op, "USAGE_ERROR", "permissions deny revokes contact grants; pass --to contact:<id>.", {
      asJson: input.asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        suggestedAction:
          "Pass --to contact:<id>. Agent identity ceilings are managed with `ravi agents permissions <agent>`.",
        acceptedFlags: ["--to contact:<id>", "--chat <chat-id|current>", "--chat-tag <tag>", "--force"],
      },
    });
  }
  const contacts = resolveContactTargets(op, targets, input.asJson);
  const scopes = resolveContactScopes(op, input, {
    requireKnownChat: false,
    suggest: (scopeFlags) => buildDenyCommand(input, scopeFlags),
  });
  const governedBefore = new Map(scopes.map((scope) => [scope.label, isScopeGoverned(scope)]));
  const operations: PermissionAllowOperation[] = [];

  for (const contact of contacts) {
    for (const scope of scopes) {
      if (scope.type === "global") {
        planContactProfileRevokeOperation({ contact, tagSlug, operations, apply: input.apply });
      } else {
        planContactChatGrantRevokeOperation({ contact, tagSlug, scope, operations, apply: input.apply });
      }
    }
  }

  const contactRefs = contacts.map((contact) => `contact:${contact.id}`);
  const capabilityRefs = capabilities.map(formatCanonicalCapability);
  const payload: PermissionDenyPlan = {
    dryRun: !input.apply,
    profile,
    tagSlug,
    capabilities,
    targets,
    scopes: scopes.map(serializeContactScope),
    force: input.force,
    operations,
    changedCount: operations.filter((operation) => operation.status === "applied").length,
    confirmation: buildConfirmation({
      action: "deny",
      dryRun: !input.apply,
      contacts: contactRefs,
      agents: [],
      scopes,
      force: input.force,
      profile: tagSlug,
      capabilities: capabilityRefs,
    }),
    hints: buildDenyHints({ contacts, scopes, tagSlug, governedBefore, apply: input.apply }),
  };
  if (!input.apply) {
    payload.nextCommand = [...buildDenyCommand(input, scopeFlagsFor(input)), "--apply"].join(" ");
  }
  return payload;
}

interface PermissionListInput extends ContactScopeInput {
  subjects?: string;
  profile?: string;
  limit?: string;
  offset?: string;
}

interface PermissionListResult {
  targets: AuthorizationSubject[];
  scopes: ReturnType<typeof serializeContactScope>[];
  force: boolean;
  total: number;
  pagination: OffsetPagination;
  grants: Array<{
    contact: string;
    profile: string;
    scope: string;
    scopeType: ContactGrantScope["type"];
    source: ContactProfileGrant["source"];
    capabilities: string[];
  }>;
  overlays: Array<{ contact: string; chat: string; governed: boolean; eligible: boolean; capabilities: string[] }>;
  confirmation: PermissionConfirmation;
  hints: string[];
}

function buildPermissionListResult(input: PermissionListInput): PermissionListResult {
  const op = "permissions list";
  const targets = parseSubjectRefs(input.subjects);
  if (targets.some((target) => target.type !== "contact")) {
    contractFail(op, "USAGE_ERROR", "permissions list filters contact grants; pass --to contact:<id>.", {
      asJson: input.asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        suggestedAction: "Inspect agent identity ceilings with `ravi permissions materialize --subject-type agent`.",
        acceptedFlags: ["--to contact:<id>", "--chat <chat-id|current>", "--chat-tag <tag>", "--force", "--profile"],
      },
    });
  }
  const contacts = resolveContactTargets(op, targets, input.asJson);
  const scopes = resolveContactScopes(op, input, {
    requireKnownChat: false,
    suggest: (scopeFlags) => buildListCommand(input, scopeFlags),
  });
  const profileSlug = input.profile?.trim() ? normalizePermissionTagSlug(input.profile) : null;
  const contactIds = contacts.map((contact) => contact.id);
  const grants: ContactProfileGrant[] = [];
  const overlays: PermissionListResult["overlays"] = [];

  for (const scope of scopes) {
    if (scope.type === "global") {
      grants.push(
        ...(contactIds.length > 0
          ? contactIds.flatMap((contactId) => listContactGlobalProfileGrants(contactId))
          : listContactGlobalProfileGrants()),
      );
    } else if (scope.type === "chat_tag") {
      const grantScope = { type: "chat_tag" as const, chatTag: scope.chatTag };
      grants.push(
        ...(contactIds.length > 0
          ? contactIds.flatMap((contactId) => listContactScopedProfileGrants({ contactId, scope: grantScope }))
          : listContactScopedProfileGrants({ scope: grantScope })),
      );
    } else {
      grants.push(
        ...(contactIds.length > 0
          ? contactIds.flatMap((contactId) => listContactProfileGrantsCoveringChat(scope, contactId))
          : listContactProfileGrantsCoveringChat(scope)),
      );
      for (const contactId of contactIds) {
        const overlay = resolveContactChatOverlay({ contactId, chatId: scope.chatId });
        grants.push(...overlay.grants.filter((grant) => grant.scope.type === "global"));
        overlays.push({
          contact: `contact:${overlay.contactId}`,
          chat: `chat:${overlay.scope.chatId}`,
          governed: overlay.active,
          eligible: overlay.eligible,
          capabilities: dedupeStrings(overlay.capabilities.map(formatCanonicalCapability)),
        });
      }
    }
  }

  const visibleGrants = dedupeGrants(grants).filter((grant) => !profileSlug || grant.profile === profileSlug);
  const page = paginateCliItems(visibleGrants, { limit: input.limit, offset: input.offset });
  const pagination = buildCliOffsetPagination({
    baseCommand: ["ravi", "permissions", "list"],
    limit: page.limit,
    offset: page.offset,
    returned: page.items.length,
    total: page.total,
    options: [
      "--to",
      input.subjects?.trim() || null,
      "--chat",
      input.chat?.trim() || null,
      "--chat-tag",
      input.chatTag?.trim() || null,
      "--profile",
      input.profile?.trim() || null,
      input.force ? "--force" : null,
    ],
  });
  const contactRefs = contacts.map((contact) => `contact:${contact.id}`);
  return {
    targets,
    scopes: scopes.map(serializeContactScope),
    force: input.force,
    total: page.total,
    pagination,
    grants: page.items.map((grant) => ({
      contact: `contact:${grant.contactId}`,
      profile: grant.profile,
      scope: formatContactGrantScope(grant.scope),
      scopeType: grant.scope.type,
      source: grant.source,
      capabilities: grant.capabilities,
    })),
    overlays,
    confirmation: buildConfirmation({
      action: "list",
      dryRun: false,
      contacts: contactRefs,
      agents: [],
      scopes,
      force: input.force,
      ...(profileSlug ? { profile: profileSlug } : {}),
      capabilities: dedupeStrings(page.items.flatMap((grant) => grant.capabilities)),
      count: page.items.length,
      total: page.total,
    }),
    hints: buildListHints({ scopes, contactIds, grants: visibleGrants, pagination }),
  };
}

function resolveContactTargets(op: string, targets: AuthorizationSubject[], asJson?: boolean): Contact[] {
  const contacts: Contact[] = [];
  for (const target of targets) {
    if (target.type !== "contact") continue;
    const contact = getContact(target.id);
    if (!contact) {
      contractFail(op, "CONTACT_NOT_FOUND", `Contact not found: ${target.id}`, {
        asJson,
        details: { suggestedAction: "Check the contact id with `ravi contacts find <query> --json`" },
      });
    }
    if (!contacts.some((existing) => existing.id === contact.id)) contacts.push(contact);
  }
  return contacts;
}

function rejectScopeWithoutContacts(op: string, input: ContactScopeInput): ResolvedContactScope[] {
  if (!input.chat?.trim() && !input.chatTag?.trim() && !input.force) return [];
  return contractFail(
    op,
    "USAGE_ERROR",
    "--chat, --chat-tag and --force scope contact grants; add --to contact:<id> or drop them.",
    {
      asJson: input.asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        suggestedAction:
          "Agent targets and --agent ceilings are not chat-scoped. Pass --to contact:<id> to grant a user in a chat.",
      },
    },
  );
}

function resolveContactScopes(
  op: string,
  input: ContactScopeInput,
  options: { requireKnownChat: boolean; suggest: (scopeFlags: string[]) => string[] },
): ResolvedContactScope[] {
  const chatRef = input.chat?.trim();
  const chatTagRef = input.chatTag?.trim();
  if (input.force && (chatRef || chatTagRef)) {
    contractFail(op, "USAGE_ERROR", "--force selects the global scope; it cannot be combined with --chat/--chat-tag.", {
      asJson: input.asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        suggestedAction: "Keep --chat/--chat-tag for a scoped grant (recommended), or use only --force for global.",
        suggestions: [options.suggest(scopeFlagsFor({ chat: chatRef, chatTag: chatTagRef, force: false })).join(" ")],
      },
    });
  }
  if (!input.force && !chatRef && !chatTagRef) {
    const currentChat = readCurrentChatId();
    const suggestions = [
      ...(currentChat ? [options.suggest(["--chat", shellArg(currentChat)]).join(" ")] : []),
      options.suggest(["--chat", "<chat-id>"]).join(" "),
      options.suggest(["--chat-tag", "<tag>"]).join(" "),
    ];
    contractFail(
      op,
      "CHAT_SCOPE_REQUIRED",
      "Contact permissions are chat-scoped: pass --chat <chat-id|current> or --chat-tag <tag>. Use --force only for an explicit global grant.",
      {
        asJson: input.asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          suggestedAction: currentChat
            ? `Ask the human whether this should apply only in this chat (--chat ${currentChat}) before considering --force.`
            : "Ask the human which chat/group this should apply to before considering --force.",
          suggestions,
          acceptedFlags: ["--chat <chat-id|current>", "--chat-tag <tag>", "--force"],
          ...(currentChat ? { currentChat } : {}),
        },
      },
    );
  }
  if (input.force) return [{ type: "global", label: "global" }];

  const scopes: ResolvedContactScope[] = [];
  if (chatRef) scopes.push(resolveChatScope(op, chatRef, { ...options, asJson: input.asJson }));
  if (chatTagRef) {
    const chatTag = tryNormalizeTagSlug(chatTagRef);
    if (!chatTag) {
      contractFail(op, "USAGE_ERROR", `Invalid chat tag: ${chatTagRef}`, {
        asJson: input.asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          suggestedAction: "Use a tag slug: lowercase letters, numbers, dots, underscores, colons or dashes.",
        },
      });
    }
    scopes.push({
      type: "chat_tag",
      label: `chat-tag:${chatTag}`,
      chatTag,
      taggedChatCount: canonicalAssetIdsForTag("chat", chatTag)?.length ?? 0,
    });
  }
  return scopes;
}

function resolveChatScope(
  op: string,
  chatRef: string,
  options: { requireKnownChat: boolean; asJson?: boolean },
): ResolvedContactScope {
  const current = chatRef === "current" ? readCurrentChatSource() : null;
  if (chatRef === "current" && !current) {
    contractFail(op, "USAGE_ERROR", "No current chat in this context; pass --chat <chat-id>.", {
      asJson: options.asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: { suggestedAction: "Find the chat id with `ravi chats list --json` and pass --chat <chat-id>." },
    });
  }
  const ref = current?.chatId ?? chatRef;
  const chat = findChatForScope(op, ref, { channel: current?.channel, instanceId: current?.instanceId }, options);
  if (!chat) {
    return {
      type: "chat",
      label: `chat:${ref}`,
      chatId: ref,
      requestedChatId: ref,
      known: false,
      chatTags: canonicalTagSlugsForAsset("chat", ref),
    };
  }
  const parent = dbGetThreadParentChat(chat);
  const container = parent ?? chat;
  return {
    type: "chat",
    label: `chat:${container.id}`,
    chatId: container.id,
    requestedChatId: ref,
    ...(parent ? { threadChatId: chat.id } : {}),
    channel: container.channel,
    ...(container.title ? { title: container.title } : {}),
    known: true,
    chatTags: canonicalTagSlugsForAsset("chat", container.id),
  };
}

function findChatForScope(
  op: string,
  ref: string,
  hint: { channel?: string; instanceId?: string },
  options: { requireKnownChat: boolean; asJson?: boolean },
): ChatRecord | null {
  const direct = dbGetChat(ref);
  if (direct) return direct;
  const matches = dbListChatsByRef({ ref, channel: hint.channel, instanceId: hint.instanceId, limit: 10 });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    contractFail(op, "CHAT_AMBIGUOUS", `Chat reference ${ref} matches ${matches.length} chats; pass a canonical id.`, {
      asJson: options.asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        suggestedAction: "Re-run with --chat <canonical-chat-id> from the suggestions.",
        suggestions: matches.map((chat) => `${chat.id} (${chat.channel}${chat.title ? `: ${chat.title}` : ""})`),
      },
    });
  }
  if (options.requireKnownChat) {
    contractFail(op, "CHAT_NOT_FOUND", `Chat not found: ${ref}`, {
      asJson: options.asJson,
      details: { suggestedAction: "Find the chat id with `ravi chats list --json` and pass --chat <chat-id>." },
    });
  }
  return null;
}

function readCurrentChatSource(): { chatId: string; channel?: string; instanceId?: string } | null {
  const source = getContext()?.source;
  const chatId = cleanString(source?.canonicalChatId) ?? cleanString(source?.chatId);
  if (!chatId) return null;
  return {
    chatId,
    ...(cleanString(source?.channel) ? { channel: source!.channel } : {}),
    ...(cleanString(source?.instanceId) ? { instanceId: source!.instanceId } : {}),
  };
}

function readCurrentChatId(): string | null {
  const current = readCurrentChatSource();
  if (!current) return null;
  return findChatSilently(current)?.id ?? current.chatId;
}

function findChatSilently(current: { chatId: string; channel?: string; instanceId?: string }): ChatRecord | null {
  const chat =
    dbGetChat(current.chatId) ??
    dbListChatsByRef({ ref: current.chatId, channel: current.channel, instanceId: current.instanceId, limit: 2 })[0] ??
    null;
  return chat ? (dbGetThreadParentChat(chat) ?? chat) : null;
}

function isScopeGoverned(scope: ResolvedContactScope): boolean {
  return scope.type === "chat" ? isUserOverlayActiveForChat(scope) : false;
}

function serializeContactScope(scope: ResolvedContactScope) {
  if (scope.type === "global") return { type: scope.type, label: scope.label };
  if (scope.type === "chat_tag") {
    return { type: scope.type, label: scope.label, chatTag: scope.chatTag, taggedChatCount: scope.taggedChatCount };
  }
  return {
    type: scope.type,
    label: scope.label,
    chatId: scope.chatId,
    requestedChatId: scope.requestedChatId,
    ...(scope.threadChatId ? { threadChatId: scope.threadChatId } : {}),
    ...(scope.channel ? { channel: scope.channel } : {}),
    ...(scope.title ? { title: scope.title } : {}),
    known: scope.known,
  };
}

function buildConfirmation(input: {
  action: PermissionConfirmation["action"];
  dryRun: boolean;
  contacts: string[];
  agents: string[];
  scopes: ResolvedContactScope[];
  force: boolean;
  profile?: string;
  capabilities: string[];
  count?: number;
  total?: number;
}): PermissionConfirmation {
  const scopeLabels = input.scopes.map((scope) => scope.label);
  const global = input.scopes.some((scope) => scope.type === "global");
  return {
    action: input.action,
    dryRun: input.dryRun,
    contacts: input.contacts,
    agents: input.agents,
    scopes: scopeLabels,
    global,
    force: input.force,
    ...(input.profile ? { profile: input.profile } : {}),
    capabilities: input.capabilities,
    message: confirmationMessage({ ...input, scopeLabels, global }),
  };
}

function confirmationMessage(input: {
  action: PermissionConfirmation["action"];
  dryRun: boolean;
  contacts: string[];
  agents: string[];
  scopeLabels: string[];
  global: boolean;
  profile?: string;
  count?: number;
  total?: number;
}): string {
  const where = input.global ? "globally (all chats, --force)" : `only in ${input.scopeLabels.join(" and ")}`;
  const who = input.contacts.join(", ");
  if (input.action === "list") {
    const filter = who ? ` for ${who}` : "";
    const count = input.count ?? 0;
    const listed = input.total !== undefined && input.total > count ? `${count} of ${input.total}` : `${count}`;
    return `Listed ${listed} contact grant(s)${filter} ${input.global ? "in the global scope" : `covering ${input.scopeLabels.join(" and ")}`}.`;
  }
  const verb =
    input.action === "allow" ? (input.dryRun ? "Would grant" : "Granted") : input.dryRun ? "Would revoke" : "Revoked";
  const parts: string[] = [];
  if (who) {
    const preposition = input.action === "allow" ? "to" : "from";
    parts.push(`${verb} ${input.profile} ${preposition} ${who} ${where}${input.global ? "" : " (not global)"}.`);
  }
  if (input.agents.length > 0) {
    parts.push(
      `${input.dryRun ? "Would ensure" : "Ensured"} ${input.agents.join(", ")} ceiling includes ${input.profile}.`,
    );
  }
  return parts.join(" ") || `No contact or agent targets for ${input.profile}.`;
}

function buildAllowHints(input: {
  contacts: string[];
  scopes: ResolvedContactScope[];
  force: boolean;
  tagSlug: string;
  capabilityRefs: string[];
  agentCeilings: string[];
  governedBefore: Map<string, boolean>;
  apply: boolean;
}): string[] {
  if (input.contacts.length === 0) return [];
  const hints: string[] = [];
  if (input.force) {
    const currentChat = readCurrentChatId();
    hints.push(
      `Global contact grant (--force): ${input.contacts.join(", ")} gets ${input.tagSlug} in every chat governed by contact grants. ` +
        `Safer default: confirm with the human whether this should apply only in a specific chat/group` +
        (currentChat ? ` (e.g. --chat ${currentChat}).` : " (--chat <chat-id>)."),
    );
    hints.push(
      "Global grants do not govern a chat by themselves; they only apply where a chat-scoped or chat-tag grant exists.",
    );
  }
  for (const scope of input.scopes) {
    if (scope.type === "chat") {
      if (scope.threadChatId) {
        hints.push(
          `chat:${scope.threadChatId} is a thread; the grant is stored on its chat ${scope.label} and inherited.`,
        );
      }
      if (!input.governedBefore.get(scope.label)) {
        hints.push(
          `${scope.label} ${input.apply ? "is now" : "would become"} governed by contact grants: tool caps there become ` +
            "agent_ceiling ∩ contact_chat_caps, and senders without a grant covering this chat get no tool capabilities.",
        );
      }
    } else if (scope.type === "chat_tag") {
      hints.push(
        `${scope.label} covers ${scope.taggedChatCount} chat(s) currently tagged ${scope.chatTag}; each becomes governed by contact grants.`,
      );
    }
  }
  if (input.agentCeilings.length === 0) {
    hints.push(
      `Contact grants never exceed the executor agent ceiling. Pass --agent <id> to ensure the agent can use ${input.capabilityRefs.join(", ")}.`,
    );
  }
  return hints;
}

function buildDenyHints(input: {
  contacts: Contact[];
  scopes: ResolvedContactScope[];
  tagSlug: string;
  governedBefore: Map<string, boolean>;
  apply: boolean;
}): string[] {
  const hints: string[] = [];
  for (const scope of input.scopes) {
    if (scope.type === "chat" && !scope.known) {
      hints.push(`${scope.label} is not a known chat; only an exact stored grant on that id can be revoked.`);
    }
    if (scope.type !== "chat") continue;
    const revokedHere = (grant: ContactProfileGrant) =>
      grant.profile === input.tagSlug &&
      grant.scope.type === "chat" &&
      grant.scope.chatId === scope.chatId &&
      input.contacts.some((contact) => contact.id === grant.contactId);
    const governedAfter = input.apply
      ? isUserOverlayActiveForChat(scope)
      : listContactProfileGrantsCoveringChat(scope).some((grant) => !revokedHere(grant));
    for (const contact of input.contacts) {
      const remaining = [
        ...listContactProfileGrantsCoveringChat(scope, contact.id),
        ...listContactGlobalProfileGrants(contact.id),
      ].filter((grant) => grant.profile === input.tagSlug && !revokedHere(grant));
      for (const grant of remaining) {
        hints.push(
          grant.scope.type === "global" && !governedAfter
            ? `contact:${contact.id} keeps a global ${input.tagSlug} grant; it only applies in chats governed by a chat or chat-tag grant.`
            : `contact:${contact.id} still receives ${input.tagSlug} in ${scope.label} through ${formatContactGrantScope(grant.scope)}.`,
        );
      }
    }
    if (input.governedBefore.get(scope.label) && !governedAfter) {
      hints.push(
        input.apply
          ? `${scope.label} is no longer governed by contact grants; turns there use the agent identity again.`
          : `${scope.label} would no longer be governed by contact grants; turns there would use the agent identity again.`,
      );
    }
  }
  return hints;
}

function buildListHints(input: {
  scopes: ResolvedContactScope[];
  contactIds: string[];
  grants: ContactProfileGrant[];
  pagination: OffsetPagination;
}): string[] {
  const hints: string[] = [];
  for (const scope of input.scopes) {
    if (scope.type !== "chat") continue;
    if (scope.threadChatId) {
      hints.push(`chat:${scope.threadChatId} is a thread; showing grants of its chat ${scope.label}.`);
    }
    if (!isUserOverlayActiveForChat(scope)) {
      hints.push(`${scope.label} is not governed by contact grants; turns there use the agent identity.`);
    }
    if (input.contactIds.length === 0 && listContactGlobalProfileGrants().length > 0) {
      hints.push("Global contact grants also apply in governed chats; list them with `ravi permissions list --force`.");
    }
  }
  if (input.grants.length === 0) {
    hints.push("No contact grants match this scope.");
  }
  if (input.pagination.nextCommand) {
    hints.push(`More grants match this scope; next page: ${input.pagination.nextCommand}`);
  }
  return hints;
}

function dedupeGrants(grants: ContactProfileGrant[]): ContactProfileGrant[] {
  const seen = new Set<string>();
  return grants.filter((grant) => {
    const key = `${grant.contactId}|${grant.profile}|${formatContactGrantScope(grant.scope)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scopeFlagsFor(input: { chat?: string; chatTag?: string; force?: boolean }): string[] {
  const flags: string[] = [];
  if (input.chat?.trim()) flags.push("--chat", shellArg(input.chat.trim()));
  if (input.chatTag?.trim()) flags.push("--chat-tag", shellArg(input.chatTag.trim()));
  if (input.force) flags.push("--force");
  return flags;
}

function allowScopeSuggester(input: PermissionAllowInput): (scopeFlags: string[]) => string[] {
  return (scopeFlags) =>
    input.commandPrefix
      ? [...input.commandPrefix, ...scopeFlags]
      : [...buildAllowCommandParts({ ...input, chat: undefined, chatTag: undefined, force: false }), ...scopeFlags];
}

function buildDenyCommand(input: PermissionDenyInput, scopeFlags: string[]): string[] {
  const parts = ["ravi", "permissions", "deny", shellArg(input.profile)];
  if (input.subjects?.trim()) parts.push("--to", shellArg(input.subjects.trim()));
  return [...parts, ...scopeFlags];
}

function buildListCommand(input: PermissionListInput, scopeFlags: string[]): string[] {
  const parts = ["ravi", "permissions", "list"];
  if (input.subjects?.trim()) parts.push("--to", shellArg(input.subjects.trim()));
  if (input.profile?.trim()) parts.push("--profile", shellArg(input.profile.trim()));
  return [...parts, ...scopeFlags];
}

function resolveProfileCapabilities(
  op: string,
  existingTag: TagDefinition | null,
  explicitCapabilities: AuthorizationCapability[] | undefined,
  asJson?: boolean,
): AuthorizationCapability[] {
  const existingCapabilities = existingTag ? readPermissionTagCapabilities(existingTag) : [];
  const capabilities = dedupeCapabilities([...(existingCapabilities ?? []), ...(explicitCapabilities ?? [])]);
  if (capabilities.length === 0) {
    contractFail(
      op,
      "USAGE_ERROR",
      "No capabilities found for this profile. Provide --capabilities <permission>:<objectType>:<objectId> to create or bootstrap it.",
      {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Re-run with --capabilities <permission>:<objectType>:<objectId>." },
      },
    );
  }
  return capabilities;
}

function planPermissionTagOperation(input: {
  existingTag: TagDefinition | null;
  tagSlug: string;
  label: string;
  description?: string;
  capabilities: AuthorizationCapability[];
  operations: PermissionAllowOperation[];
  apply: boolean;
  explicitCapabilitiesProvided: boolean;
}): void {
  if (input.apply) {
    // Provider-owned profile upsert lives in src/permissions/apply-grant.ts so
    // the CLI and the Slack grant card share one rule.
    const result = upsertPermissionProfileDefinition({
      profile: input.tagSlug,
      capabilities: input.capabilities,
      label: input.label,
      ...(input.description ? { description: input.description } : {}),
      explicitCapabilities: input.explicitCapabilitiesProvided,
      updatedBy: "permissions.allow",
    });
    input.operations.push({
      kind: "profile",
      status: result.status,
      target: result.tagSlug,
      message: result.message,
    });
    return;
  }

  if (input.existingTag) {
    assertProviderOwnedPermissionProfile(input.tagSlug, input.existingTag.kind, input.existingTag.source);
    const current = readPermissionTagCapabilities(input.existingTag);
    const shouldUpdate =
      input.explicitCapabilitiesProvided ||
      input.label !== input.existingTag.label ||
      (input.description ?? undefined) !== (input.existingTag.description ?? undefined) ||
      !capabilityListsEqual(current, input.capabilities);
    if (!shouldUpdate) {
      input.operations.push({
        kind: "profile",
        status: "unchanged",
        target: input.tagSlug,
        message: "Provider-owned permission profile already matches the requested capabilities.",
      });
      return;
    }
    input.operations.push({
      kind: "profile",
      status: "planned",
      target: input.tagSlug,
      message: "Would update provider-owned permission profile.",
    });
    return;
  }

  input.operations.push({
    kind: "profile",
    status: "planned",
    target: input.tagSlug,
    message: "Would create provider-owned permission profile.",
  });
}

function planContactProfileOperation(input: {
  contact: Contact;
  tagSlug: string;
  operations: PermissionAllowOperation[];
  apply: boolean;
}): void {
  const target = `contact:${input.contact.id}`;
  if (input.contact.tags.includes(input.tagSlug)) {
    input.operations.push({
      kind: "contact-profile-global",
      status: "unchanged",
      target,
      message: "Contact already has the global permission profile tag.",
    });
    return;
  }
  if (input.apply) {
    // Contact scoped grants live in src/permissions/apply-grant.ts: the CLI and
    // the Slack grant card must not grow two versions of this rule.
    const result = grantContactProfile({
      contactId: input.contact.id,
      profile: input.tagSlug,
      scope: { type: "global" },
      createdBy: "permissions.allow",
    });
    input.operations.push({
      kind: "contact-profile-global",
      status: result.status,
      target,
      message: result.message,
    });
    return;
  }
  input.operations.push({
    kind: "contact-profile-global",
    status: "planned",
    target,
    message: "Would attach global permission profile tag through contact policy (--force).",
  });
}

function planContactProfileRevokeOperation(input: {
  contact: Contact;
  tagSlug: string;
  operations: PermissionAllowOperation[];
  apply: boolean;
}): void {
  const target = `contact:${input.contact.id}`;
  if (!input.contact.tags.includes(input.tagSlug)) {
    input.operations.push({
      kind: "contact-profile-global",
      status: "unchanged",
      target,
      message: "Contact does not have the global permission profile tag.",
    });
    return;
  }
  if (input.apply) {
    removeContactTag(input.contact.id, input.tagSlug);
    const revoked = revokeLiveRuntimeContextsForContactGrant(input.contact.id, `${input.tagSlug}@global`);
    input.operations.push({
      kind: "contact-profile-global",
      status: "applied",
      target,
      message: `Removed global permission profile tag from contact policy (--force).${liveContextsRevokedSuffix(revoked.length)}`,
    });
    return;
  }
  input.operations.push({
    kind: "contact-profile-global",
    status: "planned",
    target,
    message: "Would remove global permission profile tag from contact policy (--force).",
  });
}

function planContactChatGrantOperation(input: {
  contact: Contact;
  tagSlug: string;
  scope: Exclude<ResolvedContactScope, { type: "global" }>;
  operations: PermissionAllowOperation[];
  apply: boolean;
}): void {
  const key = contactChatGrantKey(input.contact, input.tagSlug, input.scope);
  const target = `contact:${input.contact.id}@${input.scope.label}`;
  if (dbGetContactChatGrant(key)) {
    input.operations.push({
      kind: "contact-chat-grant",
      status: "unchanged",
      target,
      message: `Contact already has the permission profile in ${input.scope.label}.`,
    });
    return;
  }
  if (input.apply) {
    const result = grantContactProfile({
      contactId: input.contact.id,
      profile: input.tagSlug,
      scope: contactGrantScopeRef(input.scope),
      createdBy: "permissions.allow",
    });
    input.operations.push({
      kind: "contact-chat-grant",
      status: result.status,
      target,
      message: result.message,
    });
    return;
  }
  input.operations.push({
    kind: "contact-chat-grant",
    status: "planned",
    target,
    message: `Would grant the permission profile to the contact only in ${input.scope.label}.`,
  });
}

function contactGrantScopeRef(
  scope: Exclude<ResolvedContactScope, { type: "global" }>,
): { type: "chat"; chatId: string } | { type: "chat_tag"; chatTag: string } {
  return scope.type === "chat" ? { type: "chat", chatId: scope.chatId } : { type: "chat_tag", chatTag: scope.chatTag };
}

function planContactChatGrantRevokeOperation(input: {
  contact: Contact;
  tagSlug: string;
  scope: Exclude<ResolvedContactScope, { type: "global" }>;
  operations: PermissionAllowOperation[];
  apply: boolean;
}): void {
  const key = contactChatGrantKey(input.contact, input.tagSlug, input.scope);
  const target = `contact:${input.contact.id}@${input.scope.label}`;
  if (!dbGetContactChatGrant(key)) {
    input.operations.push({
      kind: "contact-chat-grant",
      status: "unchanged",
      target,
      message: `Contact has no ${input.tagSlug} grant stored on ${input.scope.label}.`,
    });
    return;
  }
  if (input.apply) {
    dbDeleteContactChatGrant(key);
    const revoked = revokeLiveRuntimeContextsForContactGrant(input.contact.id, `${input.tagSlug}@${input.scope.label}`);
    input.operations.push({
      kind: "contact-chat-grant",
      status: "applied",
      target,
      message: `Revoked the permission profile from the contact in ${input.scope.label}.${liveContextsRevokedSuffix(revoked.length)}`,
    });
    return;
  }
  input.operations.push({
    kind: "contact-chat-grant",
    status: "planned",
    target,
    message: `Would revoke the permission profile from the contact in ${input.scope.label}.`,
  });
}

function liveContextsRevokedSuffix(count: number): string {
  return count > 0 ? ` Revoked ${count} live turn context(s) that used this grant.` : "";
}

function contactChatGrantKey(
  contact: Contact,
  profileSlug: string,
  scope: Exclude<ResolvedContactScope, { type: "global" }>,
): { contactId: string; profileSlug: string; scopeType: ContactChatGrantScopeType; scopeId: string } {
  return {
    contactId: contact.id,
    profileSlug,
    scopeType: scope.type,
    scopeId: scope.type === "chat" ? scope.chatId : scope.chatTag,
  };
}

function planAgentCapabilityOperation(input: {
  agentId: string;
  capability: AuthorizationCapability;
  operations: PermissionAllowOperation[];
  apply: boolean;
  kind?: string;
}): void {
  const capability = formatCanonicalCapability(input.capability);
  if (input.apply) {
    const result = ensureAgentCeilingCapability({
      agentId: input.agentId,
      capability: input.capability,
    });
    input.operations.push({
      kind: input.kind ?? "agent-profile",
      status: result.status,
      target: result.target,
      capability: result.capability,
      message: result.message,
    });
    return;
  }
  input.operations.push({
    kind: input.kind ?? "agent-profile",
    status: "planned",
    target: `agent:${input.agentId}`,
    capability,
    message: "Would ensure agent runtime ceiling includes this capability.",
  });
}

function printPermissionAllowPlan(payload: PermissionAllowPlan): void {
  console.log(payload.dryRun ? "permission allow plan" : "permission allow applied");
  console.log(`profile: ${payload.tagSlug}`);
  console.log(`capabilities: ${payload.capabilities.map(formatCanonicalCapability).join(", ")}`);
  if (payload.targets.length > 0) {
    console.log(`targets: ${payload.targets.map((target) => `${target.type}:${target.id}`).join(", ")}`);
  }
  if (payload.agentCeilings.length > 0) {
    console.log(`agent ceilings: ${payload.agentCeilings.map((agentId) => `agent:${agentId}`).join(", ")}`);
  }
  printScopedMutationTail(payload);
}

function printPermissionDenyPlan(payload: PermissionDenyPlan): void {
  console.log(payload.dryRun ? "permission deny plan" : "permission deny applied");
  console.log(`profile: ${payload.tagSlug}`);
  console.log(`targets: ${payload.targets.map((target) => `${target.type}:${target.id}`).join(", ")}`);
  printScopedMutationTail(payload);
}

function printScopedMutationTail(payload: {
  scopes: Array<{ label: string }>;
  operations: PermissionAllowOperation[];
  confirmation: PermissionConfirmation;
  hints: string[];
  nextCommand?: string;
}): void {
  if (payload.scopes.length > 0) {
    console.log(`scope: ${payload.scopes.map((scope) => scope.label).join(", ")}`);
  }
  for (const operation of payload.operations) {
    const target = operation.target ? ` ${operation.target}` : "";
    const capability = operation.capability ? ` ${operation.capability}` : "";
    console.log(`- ${operation.status} ${operation.kind}${target}${capability}: ${operation.message}`);
  }
  console.log(`confirmation: ${payload.confirmation.message}`);
  for (const hint of payload.hints) {
    console.log(`hint: ${hint}`);
  }
  if (payload.nextCommand) {
    console.log(`apply: ${payload.nextCommand}`);
  }
}

function printPermissionListResult(payload: PermissionListResult): void {
  console.log(`scope: ${payload.scopes.map((scope) => scope.label).join(", ")}`);
  if (payload.grants.length === 0) {
    console.log("no contact grants");
  }
  for (const grant of payload.grants) {
    console.log(
      `- ${grant.contact} ${grant.profile} @ ${grant.scope}: ${grant.capabilities.join(", ") || "(no caps)"}`,
    );
  }
  for (const overlay of payload.overlays) {
    console.log(
      `overlay ${overlay.contact} @ ${overlay.chat}: ${overlay.governed ? "governed" : "not governed"}; contact_chat_caps=${overlay.capabilities.join(", ") || "(none)"}`,
    );
  }
  console.log(`confirmation: ${payload.confirmation.message}`);
  for (const hint of payload.hints) {
    console.log(`hint: ${hint}`);
  }
}

function normalizePermissionTagSlug(profile: string): string {
  return normalizePermissionProfileSlug(profile);
}

function parseCapabilityList(value: string | undefined): AuthorizationCapability[] | undefined {
  if (value === undefined) return undefined;
  const capabilities = value
    .split(",")
    .map((item) => normalizeAuthorizationCapabilityInput(item))
    .filter((item): item is AuthorizationCapability => item !== null);
  if (capabilities.length === 0) {
    throw new Error("No valid capabilities found. Use <permission>:<objectType>:<objectId>.");
  }
  return dedupeCapabilities(capabilities);
}

function parseSubjectRefs(value: string | undefined): AuthorizationSubject[] {
  return dedupeSubjects(
    parseCsv(value).map((ref) => {
      const parsed = parseSubjectRef(ref);
      if (!parsed) {
        throw new Error(`Invalid subject reference: ${ref}. Use <type>:<id>.`);
      }
      return parsed;
    }),
  );
}

function parseSubjectRef(ref: string | undefined | null): AuthorizationSubject | null {
  const normalized = ref?.trim();
  if (!normalized) return null;
  const sep = normalized.indexOf(":");
  if (sep <= 0 || sep === normalized.length - 1) return null;
  return {
    type: normalized.slice(0, sep),
    id: normalized.slice(sep + 1),
  };
}

function ensureSupportedTargets(targets: AuthorizationSubject[]): void {
  const unsupported = targets.find((target) => !["agent", "contact"].includes(target.type));
  if (unsupported) {
    throw new Error(
      `Unsupported permission target ${unsupported.type}:${unsupported.id}. This command currently supports contact:<id> and agent:<id>.`,
    );
  }
}

function parseCsv(value: string | undefined): string[] {
  return dedupeStrings(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function dedupeCapabilities(capabilities: AuthorizationCapability[]): AuthorizationCapability[] {
  const seen = new Set<string>();
  const result: AuthorizationCapability[] = [];
  for (const capability of capabilities) {
    const key = formatCanonicalCapability(capability);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function dedupeSubjects(subjects: AuthorizationSubject[]): AuthorizationSubject[] {
  const seen = new Set<string>();
  const result: AuthorizationSubject[] = [];
  for (const subject of subjects) {
    const key = `${subject.type}:${subject.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(subject);
  }
  return result;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function capabilityListsEqual(a: AuthorizationCapability[], b: AuthorizationCapability[]): boolean {
  return grantCapabilityListsEqual(a, b);
}

function deriveProfileName(capability: AuthorizationCapability): string {
  return derivePermissionProfileSlugForCapability(capability);
}

function buildAllowApplyCommand(input: PermissionAllowInput): string {
  return [...buildAllowCommandParts(input), ...scopeFlagsFor(input), "--apply"].join(" ");
}

function buildAllowCommandParts(input: PermissionAllowInput): string[] {
  const parts = ["ravi", "permissions", "allow", shellArg(input.profile)];
  if (input.subjects?.trim()) parts.push("--to", shellArg(input.subjects.trim()));
  if (input.agentIds?.trim()) parts.push("--agent", shellArg(input.agentIds.trim()));
  if (input.capabilities?.trim()) parts.push("--capabilities", shellArg(input.capabilities.trim()));
  if (input.label?.trim()) parts.push("--label", shellArg(input.label.trim()));
  if (input.description?.trim()) parts.push("--description", shellArg(input.description.trim()));
  return parts;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@,-]+$/.test(value) ? value : JSON.stringify(value);
}

function requirePermissionDenial(value: string): PermissionDenial {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Invalid denial id: ${value}`);
  }
  const denial = getPermissionDenial(id);
  if (!denial) {
    throw new Error(`Permission denial not found: ${id}`);
  }
  return denial;
}

function inferResolutionTargets(denial: PermissionDenial): { subjects?: string; agentIds?: string; chat?: string } {
  const context = isRecord(denial.detail?.context) ? denial.detail.context : undefined;
  const executorAgentId = cleanString(context?.executorAgentId) ?? cleanString(denial.agentId);
  const isAgentIdentityContext =
    cleanString(context?.authorityMode) === "agent-identity" || Boolean(cleanString(context?.agentIdentityPrincipal));
  const overlayActor = parseSubjectRef(cleanString(context?.actorPrincipal));
  const overlayChat = cleanString(context?.userOverlayChat)?.replace(/^chat:/, "");

  if (
    cleanString(context?.actorAuthorizationMode) === "user-overlay" &&
    overlayActor?.type === "contact" &&
    overlayChat
  ) {
    return {
      subjects: `contact:${overlayActor.id}`,
      ...(executorAgentId ? { agentIds: executorAgentId } : {}),
      chat: overlayChat,
    };
  }

  if (executorAgentId && (isAgentIdentityContext || denial.subjectType === "agent")) {
    return {
      subjects: `agent:${executorAgentId}`,
    };
  }

  const actorPrincipal = parseSubjectRef(cleanString(context?.actorPrincipal));
  const subjects = dedupeSubjects([
    ...(actorPrincipal && actorPrincipal.type === "contact" ? [actorPrincipal] : []),
    ...(denial.subjectType === "contact" ? [{ type: denial.subjectType, id: denial.subjectId }] : []),
  ]);
  const agentIds = dedupeStrings([...(executorAgentId ? [executorAgentId] : [])]);
  return {
    ...(subjects.length > 0 ? { subjects: subjects.map((subject) => `${subject.type}:${subject.id}`).join(",") } : {}),
    ...(agentIds.length > 0 ? { agentIds: agentIds.join(",") } : {}),
  };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredOption(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Missing required option ${name}`);
  }
  return normalized;
}
