/**
 * Permissions Commands - provider-runtime introspection only.
 *
 * Authorization and inspection are provider-runtime only.
 */

import "reflect-metadata";
import { z } from "zod";
import { addContactTag, getContact } from "../../contacts.js";
import { ensureAgentRuntimeCapability } from "../../permissions/agent-default-capabilities-provider.js";
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
  dbCreateTagDefinition,
  dbGetTagDefinition,
  dbUpdateTagDefinition,
  normalizeTagSlug,
} from "../../tags/index.js";
import type { TagDefinition } from "../../tags/types.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import {
  getConfiguredCapabilityMaterializers,
  getConfiguredPermissionProviders,
} from "../../permissions/provider-registry.js";
import { authorizePermission, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

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
        suggestedTags: z.array(
          z.object({
            slug: z.string(),
            label: z.string(),
            description: z.string().optional(),
            capabilities: z.array(z.string()),
          }),
        ),
      }),
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
  guidance: z.object({
    recurringAccess: z.string(),
    breakGlass: z.string(),
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

const permissionsAllowReturnSchema = z.object({
  dryRun: z.boolean(),
  profile: z.string(),
  tagSlug: z.string(),
  label: z.string(),
  description: z.string().optional(),
  capabilities: z.array(permissionCapabilityReturnSchema),
  targets: z.array(permissionTargetReturnSchema),
  agentCeilings: z.array(z.string()),
  operations: z.array(permissionAllowOperationReturnSchema),
  changedCount: z.number(),
  nextCommand: z.string().optional(),
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
    const payload = {
      allowed: decision.allowed,
      decision,
      ...(!decision.allowed
        ? {
            guidance,
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
      console.log(`missing capability: ${payload.guidance.canonicalCapability}`);
      console.log(`inspect: ${payload.guidance.inspectCommands[0]}`);
      console.log(`recurring: ${payload.guidance.preferredPath.message}`);
      console.log(`fallback: ${payload.guidance.rawCapabilityFallback}`);
      console.log(`break-glass: ${payload.guidance.breakGlass}`);
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
        "Comma-separated subjects to receive the profile. Prefer agent:<id>; contact:<id> is legacy/user-overlay.",
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
  ) {
    const payload = buildPermissionAllowPlan({
      profile,
      subjects,
      agentIds,
      capabilities,
      label,
      description,
      apply: apply === true,
    });

    if (asJson) {
      printJson(payload);
      return payload;
    }

    printPermissionAllowPlan(payload);
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
    const payload = {
      ...buildPermissionAllowPlan({
        profile: resolvedProfile,
        subjects: inferred.subjects,
        agentIds: inferred.agentIds,
        capabilities: capabilities ?? formatCanonicalCapability(missingCapability),
        label: labelFromProfile(resolvedProfile),
        description: `Provider-owned permission profile for ${formatCanonicalCapability(missingCapability)}.`,
        apply: apply === true,
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
    const payload = {
      subject: { type: normalizedSubjectType, id: normalizedSubjectId },
      capabilities: materializeSubjectCapabilities(normalizedSubjectType, normalizedSubjectId),
      guidance: {
        recurringAccess:
          "Recurring access should come from provider-owned agent identity profiles/tags, not ad-hoc capability lists.",
        breakGlass: "full-access is break-glass and should be explicit.",
      },
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (payload.capabilities.length === 0) {
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

interface PermissionAllowInput {
  profile: string;
  subjects?: string;
  agentIds?: string;
  capabilities?: string;
  label?: string;
  description?: string;
  apply: boolean;
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
  operations: PermissionAllowOperation[];
  changedCount: number;
  nextCommand?: string;
}

function buildPermissionAllowPlan(input: PermissionAllowInput): PermissionAllowPlan {
  const profile = requiredOption(input.profile, "profile");
  const tagSlug = normalizePermissionTagSlug(profile);
  const existingTag = dbGetTagDefinition(tagSlug);
  const explicitCapabilities = parseCapabilityList(input.capabilities);
  const capabilities = resolveProfileCapabilities(existingTag, explicitCapabilities);
  const targets = parseSubjectRefs(input.subjects);
  const agentCeilings = parseCsv(input.agentIds);
  const label = input.label?.trim() || existingTag?.label || labelFromProfile(tagSlug);
  const description = input.description?.trim() || existingTag?.description;
  const operations: PermissionAllowOperation[] = [];

  ensureSupportedTargets(targets);
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

  for (const target of targets) {
    if (target.type === "contact") {
      planContactProfileOperation({ target, tagSlug, operations, apply: input.apply });
    } else if (target.type === "agent") {
      for (const capability of capabilities) {
        planAgentCapabilityOperation({ agentId: target.id, capability, operations, apply: input.apply });
      }
    }
  }

  for (const agentId of agentCeilings) {
    for (const capability of capabilities) {
      planAgentCapabilityOperation({ agentId, capability, operations, apply: input.apply, kind: "agent-ceiling" });
    }
  }

  const changedCount = operations.filter((operation) => operation.status === "applied").length;
  const payload: PermissionAllowPlan = {
    dryRun: !input.apply,
    profile,
    tagSlug,
    label,
    ...(description ? { description } : {}),
    capabilities,
    targets,
    agentCeilings,
    operations,
    changedCount,
  };
  if (!input.apply) {
    payload.nextCommand = buildAllowApplyCommand(input);
  }
  return payload;
}

function resolveProfileCapabilities(
  existingTag: TagDefinition | null,
  explicitCapabilities: AuthorizationCapability[] | undefined,
): AuthorizationCapability[] {
  const existingCapabilities = existingTag ? readPermissionTagCapabilities(existingTag) : [];
  const capabilities = dedupeCapabilities([...(existingCapabilities ?? []), ...(explicitCapabilities ?? [])]);
  if (capabilities.length === 0) {
    throw new Error(
      "No capabilities found for this profile. Provide --capabilities <permission>:<objectType>:<objectId> to create or bootstrap it.",
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
  if (input.existingTag) {
    assertProviderOwnedPermissionTag(input.existingTag);
    const current = readPermissionTagCapabilities(input.existingTag);
    const sameCapabilities = capabilityListsEqual(current, input.capabilities);
    const shouldUpdate =
      input.explicitCapabilitiesProvided ||
      input.label !== input.existingTag.label ||
      (input.description ?? undefined) !== (input.existingTag.description ?? undefined) ||
      !sameCapabilities;
    if (!shouldUpdate) {
      input.operations.push({
        kind: "profile",
        status: "unchanged",
        target: input.tagSlug,
        message: "Provider-owned permission profile already matches the requested capabilities.",
      });
      return;
    }
    if (input.apply) {
      dbUpdateTagDefinition({
        slug: input.tagSlug,
        label: input.label,
        description: input.description ?? null,
        kind: "system",
        source: "permissions",
        metadata: mergePermissionTagMetadata(input.existingTag.metadata, input.capabilities),
        updatedBy: "permissions.allow",
      });
      input.operations.push({
        kind: "profile",
        status: "applied",
        target: input.tagSlug,
        message: "Updated provider-owned permission profile.",
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

  if (input.apply) {
    dbCreateTagDefinition({
      slug: input.tagSlug,
      label: input.label,
      description: input.description,
      kind: "system",
      source: "permissions",
      metadata: permissionTagMetadata(input.capabilities),
      createdBy: "permissions.allow",
    });
    input.operations.push({
      kind: "profile",
      status: "applied",
      target: input.tagSlug,
      message: "Created provider-owned permission profile.",
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
  target: AuthorizationSubject;
  tagSlug: string;
  operations: PermissionAllowOperation[];
  apply: boolean;
}): void {
  const contact = getContact(input.target.id);
  if (!contact) {
    throw new Error(`Contact not found: ${input.target.id}`);
  }
  const target = `contact:${contact.id}`;
  if (contact.tags.includes(input.tagSlug)) {
    input.operations.push({
      kind: "contact-profile",
      status: "unchanged",
      target,
      message: "Contact already has the permission profile tag.",
    });
    return;
  }
  if (input.apply) {
    addContactTag(contact.phone, input.tagSlug);
    input.operations.push({
      kind: "contact-profile",
      status: "applied",
      target,
      message: "Attached permission profile tag through contact policy.",
    });
    return;
  }
  input.operations.push({
    kind: "contact-profile",
    status: "planned",
    target,
    message: "Would attach permission profile tag through contact policy.",
  });
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
    const result = ensureAgentRuntimeCapability(input.agentId, input.capability);
    if (!result.agent) {
      throw new Error(`Agent not found: ${input.agentId}`);
    }
    input.operations.push({
      kind: input.kind ?? "agent-profile",
      status: result.changed ? "applied" : "unchanged",
      target: `agent:${input.agentId}`,
      capability,
      message: result.changed
        ? "Added capability to agent runtime ceiling."
        : "Agent runtime ceiling already includes this capability.",
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
  for (const operation of payload.operations) {
    const target = operation.target ? ` ${operation.target}` : "";
    const capability = operation.capability ? ` ${operation.capability}` : "";
    console.log(`- ${operation.status} ${operation.kind}${target}${capability}: ${operation.message}`);
  }
  if (payload.nextCommand) {
    console.log(`apply: ${payload.nextCommand}`);
  }
}

function normalizePermissionTagSlug(profile: string): string {
  const base = profile
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) {
    throw new Error("Permission profile name is required.");
  }
  return normalizeTagSlug(base.startsWith("permission-") ? base : `permission-${base}`);
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

function assertProviderOwnedPermissionTag(tag: TagDefinition): void {
  if (tag.kind !== "system" || tag.source !== "permissions") {
    throw new Error(
      `Tag ${tag.slug} is not provider-owned by permissions; refusing to mutate it as an authorization profile.`,
    );
  }
}

function capabilityListsEqual(a: AuthorizationCapability[], b: AuthorizationCapability[]): boolean {
  const left = a.map(formatCanonicalCapability).sort();
  const right = b.map(formatCanonicalCapability).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function permissionTagMetadata(capabilities: AuthorizationCapability[]): Record<string, unknown> {
  return {
    permissions: {
      capabilities: capabilities.map(formatCanonicalCapability),
    },
  };
}

function mergePermissionTagMetadata(
  metadata: Record<string, unknown> | undefined,
  capabilities: AuthorizationCapability[],
): Record<string, unknown> {
  const previousPermissions = isRecord(metadata?.permissions) ? metadata.permissions : {};
  return {
    ...(metadata ?? {}),
    permissions: {
      ...previousPermissions,
      capabilities: capabilities.map(formatCanonicalCapability),
    },
  };
}

function labelFromProfile(profile: string): string {
  const slug = profile.startsWith("permission-") ? profile.slice("permission-".length) : profile;
  return slug
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveProfileName(capability: AuthorizationCapability): string {
  return `permission-${capability.permission}-${capability.objectType}-${capability.objectId}`;
}

function buildAllowApplyCommand(input: PermissionAllowInput): string {
  const parts = ["ravi", "permissions", "allow", shellArg(input.profile)];
  if (input.subjects?.trim()) parts.push("--to", shellArg(input.subjects.trim()));
  if (input.agentIds?.trim()) parts.push("--agent", shellArg(input.agentIds.trim()));
  if (input.capabilities?.trim()) parts.push("--capabilities", shellArg(input.capabilities.trim()));
  if (input.label?.trim()) parts.push("--label", shellArg(input.label.trim()));
  if (input.description?.trim()) parts.push("--description", shellArg(input.description.trim()));
  parts.push("--apply");
  return parts.join(" ");
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

function inferResolutionTargets(denial: PermissionDenial): { subjects?: string; agentIds?: string } {
  const context = isRecord(denial.detail?.context) ? denial.detail.context : undefined;
  const executorAgentId = cleanString(context?.executorAgentId) ?? cleanString(denial.agentId);
  const isAgentIdentityContext =
    cleanString(context?.authorityMode) === "agent-identity" || Boolean(cleanString(context?.agentIdentityPrincipal));

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
