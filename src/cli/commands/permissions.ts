/**
 * Permissions Commands - provider-runtime introspection only.
 *
 * Authorization and inspection are provider-runtime only.
 */

import "reflect-metadata";
import { z } from "zod";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
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
    enabled: z.literal(false),
    message: z.string(),
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
        enabled: false as const,
        message: "Permission mutation commands are not available on this provider-runtime inspection surface.",
      },
      authorizationProviders: getConfiguredPermissionProviders().map(serializeProvider),
      capabilityMaterializers: getConfiguredCapabilityMaterializers().map(serializeProvider),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log("permissions: provider-runtime");
    console.log("mutation commands: disabled");
    console.log(`authorization providers: ${payload.authorizationProviders.map((item) => item.id).join(", ")}`);
    console.log(`capability materializers: ${payload.capabilityMaterializers.map((item) => item.id).join(", ")}`);
    return payload;
  }

  @Command({ name: "check", description: "Evaluate a provider-runtime permission request" })
  @CommandAccess({ kind: "read", resource: "permissions", action: "check", risk: "low" })
  @Returns(permissionsCheckReturnSchema)
  check(
    @Option({ flags: "--permission <permission>", description: "Permission/relation to check" }) permission?: string,
    @Option({ flags: "--object-type <type>", description: "Object type" }) objectType?: string,
    @Option({ flags: "--object-id <id>", description: "Object id" }) objectId?: string,
    @Option({ flags: "--local-operator", description: "Evaluate as explicit local operator" })
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
    const payload = { allowed: decision.allowed, decision };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(decision.allowed ? "allowed" : "denied");
    console.log(`${decision.providerId}@${decision.providerVersion}: ${decision.reasonCode}`);
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
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (payload.capabilities.length === 0) {
      console.log(`${normalizedSubjectType}:${normalizedSubjectId} has no materialized capabilities.`);
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

function requiredOption(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Missing required option ${name}`);
  }
  return normalized;
}
