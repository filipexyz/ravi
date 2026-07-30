import { z } from "zod";
import type { ContextSource } from "../../router/router-db.js";
import { ChannelBackendOpaqueIdSchema, ChannelBackendWireKindSchema } from "../backend.js";
import { NativeLocalAgentActionDescriptorSchema, type NativeLocalAgentActionDescriptor } from "./driver.js";

export const MAX_NATIVE_LOCAL_AGENT_ACTIONS_PER_TURN = 32;

export const NativeLocalAgentActionTurnMetadataSchema = z
  .object({
    source: z
      .object({
        channelKind: ChannelBackendWireKindSchema,
        channelInstanceId: ChannelBackendOpaqueIdSchema,
        accountId: ChannelBackendOpaqueIdSchema,
      })
      .strict(),
    descriptors: z
      .array(NativeLocalAgentActionDescriptorSchema)
      .max(MAX_NATIVE_LOCAL_AGENT_ACTIONS_PER_TURN)
      .superRefine((descriptors, context) => {
        const seen = new Set<string>();
        for (const [index, descriptor] of descriptors.entries()) {
          if (seen.has(descriptor.toolName)) {
            context.addIssue({
              code: "custom",
              path: [index, "toolName"],
              message: "turn-scoped local Agent action names must be unique",
            });
          }
          seen.add(descriptor.toolName);
        }
      }),
  })
  .strict();

export type NativeLocalAgentActionTurnMetadata = z.infer<typeof NativeLocalAgentActionTurnMetadataSchema>;

export function resolveNativeLocalAgentActionTurnMetadata(
  input: unknown,
  source: Pick<ContextSource, "channel" | "accountId"> | undefined,
): NativeLocalAgentActionTurnMetadata | undefined {
  if (source === undefined) return undefined;
  const parsed = NativeLocalAgentActionTurnMetadataSchema.safeParse(input);
  if (!parsed.success) return undefined;
  if (parsed.data.source.channelKind !== source.channel || parsed.data.source.accountId !== source.accountId) {
    return undefined;
  }
  if (
    parsed.data.descriptors.some(
      (descriptor) =>
        descriptor.sourceAccountId !== undefined && descriptor.sourceAccountId !== parsed.data.source.accountId,
    )
  ) {
    return undefined;
  }
  return structuredClone(parsed.data);
}

export function mergeNativeLocalAgentActionDescriptors(
  collections: readonly (readonly NativeLocalAgentActionDescriptor[])[],
): NativeLocalAgentActionDescriptor[] {
  const unique = new Map<
    string,
    { readonly descriptor: NativeLocalAgentActionDescriptor; readonly fingerprint: string; ambiguous: boolean }
  >();
  for (const collection of collections) {
    for (const descriptorInput of collection) {
      const descriptor = NativeLocalAgentActionDescriptorSchema.parse(descriptorInput);
      const fingerprint = canonicalJson(descriptor);
      const existing = unique.get(descriptor.toolName);
      if (existing === undefined) {
        unique.set(descriptor.toolName, { descriptor, fingerprint, ambiguous: false });
        continue;
      }
      if (existing.fingerprint !== fingerprint) existing.ambiguous = true;
    }
  }
  return [...unique.values()]
    .filter(({ ambiguous }) => !ambiguous)
    .map(({ descriptor }) => structuredClone(descriptor))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
