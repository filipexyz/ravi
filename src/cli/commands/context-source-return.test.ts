import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { contextSourceReturnSchema, contextWhoamiReturnSchema } from "./operational-return-schemas.js";
import type { ContextSource } from "../../router/router-db.js";

type SourceReturn = z.infer<typeof contextSourceReturnSchema>;
type MissingSourceKeys = Exclude<keyof ContextSource, keyof SourceReturn>;
type ExtraSourceKeys = Exclude<keyof SourceReturn, keyof ContextSource>;
type _AssertSchemaAcceptsContextSource = MissingSourceKeys extends never ? true : MissingSourceKeys;
type _AssertSchemaHasNoExtraSourceKeys = ExtraSourceKeys extends never ? true : ExtraSourceKeys;
const _sourceSchemaCoversRuntime: _AssertSchemaAcceptsContextSource = true;
const _sourceSchemaStaysAligned: _AssertSchemaHasNoExtraSourceKeys = true;
void _sourceSchemaCoversRuntime;
void _sourceSchemaStaysAligned;

/** The pre-fix contract that rejected WhatsApp DM source fields and triggered RETURN_SHAPE_ERROR. */
const legacyContextSourceReturnSchema = z
  .object({
    channel: z.string(),
    accountId: z.string(),
    chatId: z.string(),
    threadId: z.string().optional(),
  })
  .strict();

const whatsappDmSource: ContextSource = {
  channel: "whatsapp",
  accountId: "main",
  chatId: "5511999999999",
  instanceId: "whatsapp-baileys-main",
  canonicalChatId: "chat_whatsapp_5511999999999",
};

const legacySource: ContextSource = {
  channel: "whatsapp",
  accountId: "main",
  chatId: "5511999999999",
};

function whoamiDetailPayload(source: ContextSource | null) {
  return {
    contextId: "ctx_123",
    kind: "agent-runtime",
    status: "active" as const,
    agentId: "dev",
    sessionKey: "agent:dev:main",
    sessionName: "dev-main",
    createdAt: 1000,
    expiresAt: 2000,
    lastUsedAt: 1500,
    revokedAt: null,
    capabilitiesCount: 1,
    parentContextId: null,
    issuedFor: null,
    issuanceMode: null,
    source,
    metadata: { runtimeProvider: "codex" },
    capabilities: [{ permission: "execute", objectType: "group", objectId: "context" }],
    lineage: {
      parentContextId: null,
      parentContextKind: null,
      issuedFor: null,
      issuedAt: null,
      issuanceMode: null,
      approvalSource: null,
    },
  };
}

describe("context source return schema", () => {
  it("legacy source contract rejects instanceId and canonicalChatId from WhatsApp DMs", () => {
    const parsed = legacyContextSourceReturnSchema.safeParse(whatsappDmSource);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    expect(messages.some((message) => message.includes("instanceId"))).toBe(true);
    expect(messages.some((message) => message.includes("canonicalChatId"))).toBe(true);
  });

  it("accepts a whoami/detail payload with WhatsApp DM source fields that previously RETURN_SHAPE_ERROR'd", () => {
    const payload = whoamiDetailPayload(whatsappDmSource);
    const parsed = contextWhoamiReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    }
    expect(parsed.data.source).toEqual(whatsappDmSource);
  });

  it("still accepts a legacy whoami/detail payload without instanceId or canonicalChatId", () => {
    const payload = whoamiDetailPayload(legacySource);
    const parsed = contextWhoamiReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    }
    expect(parsed.data.source).toEqual(legacySource);
    expect(parsed.data.source).not.toHaveProperty("instanceId");
    expect(parsed.data.source).not.toHaveProperty("canonicalChatId");
  });

  it("still rejects unknown source keys under .strict()", () => {
    const parsed = contextSourceReturnSchema.safeParse({
      ...whatsappDmSource,
      extraKey: "nope",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((issue) => issue.message);
    expect(messages.some((message) => message.includes("Unrecognized key") && message.includes("extraKey"))).toBe(true);
  });
});
