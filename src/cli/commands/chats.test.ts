import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { recomputeChatReadingListMembers, validateChatReadingListSelector } from "../../chats/reading-lists.js";
import {
  dbCreateChatReadingList,
  dbGetChatMessage,
  dbListChatIdsByContactIds,
  dbListChatReadingListMembers,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertChatParticipant,
  getDb,
} from "../../router/router-db.js";
import { attachTagSlugsToAsset } from "../../tags/helpers.js";
import { getArgsMetadata, getCommandAccessMetadata } from "../decorators.js";
import { ChatReadingListCommands, ChatsCommands } from "./chats.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-chats-cli-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

function captureJson(run: () => void): Record<string, unknown> {
  return JSON.parse(captureLogs(run)) as Record<string, unknown>;
}

describe("ChatsCommands --json", () => {
  it("reads durable chat messages and manages list cursors with scoped readers", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
      title: "Maria",
      rawProvenance: { provider: "omni", rawChatId: "5511999999999@s.whatsapp.net" },
    });

    const first = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "primeira" },
      rawProvenance: { rawPayload: { messageSecret: "secret-value", deviceListMetadata: { senderKeyHash: "hash" } } },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    }).message;

    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-2",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "segunda" },
      providerTimestamp: 1_700_000_001_000,
      ingestedAt: 1_700_000_001_100,
    });

    const chats = new ChatsCommands();
    const lists = new ChatReadingListCommands();

    const readPayload = captureJson(() => {
      chats.read(chat.id, undefined, undefined, undefined, "10", undefined, undefined, true);
    });
    expect(readPayload.total).toBe(2);
    expect(JSON.stringify(readPayload)).not.toContain("messageSecret");
    expect((readPayload.messages as Array<Record<string, unknown>>)[0]!.rawProvenance).toBeUndefined();

    const rawReadPayload = captureJson(() => {
      chats.read(chat.id, undefined, undefined, undefined, "10", undefined, undefined, true, true);
    });
    expect(JSON.stringify(rawReadPayload)).toContain("messageSecret");

    const createdPayload = captureJson(() => {
      lists.create("crm-analysis-pending", "agent:ravi-crm", "CRM analysis queue", undefined, undefined, true);
    });
    expect((createdPayload.list as Record<string, unknown>).ownerType).toBe("agent");

    captureJson(() => {
      lists.add("crm-analysis-pending", chat.id, undefined, undefined, "test", undefined, true);
    });

    const initialDelta = captureJson(() => {
      lists.delta("crm-analysis-pending", chat.id, "agent:crm-observer", undefined, undefined, "10", false, true);
    });
    expect(initialDelta.newMessageCount).toBe(2);
    expect(initialDelta.events).toEqual([]);
    expect(initialDelta.editedMessageCount).toBe(0);
    expect(initialDelta.deletedMessageCount).toBe(0);
    expect(initialDelta.participantChanges).toEqual([]);

    captureJson(() => {
      lists.markRead(
        "crm-analysis-pending",
        chat.id,
        first.id,
        "agent:crm-observer",
        undefined,
        undefined,
        "test",
        true,
      );
    });

    const members = captureJson(() => {
      lists.members("crm-analysis-pending", "agent:crm-observer", undefined, undefined, true);
    });
    const member = (members.members as Array<Record<string, unknown>>)[0]!;
    expect(member.unreadMessageCount).toBe(1);
  });

  it("recomputes dynamic reading-list selectors as JSON", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999911@s.whatsapp.net",
      chatType: "dm",
      title: "Tagged contact",
    });
    dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: "contact_tagged",
      source: "test",
    });
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: "contact_tagged",
      tags: ["crm-cli-dynamic"],
      source: "test",
    });
    const dynamicList = dbCreateChatReadingList({
      name: "crm-cli-dynamic",
      ownerType: "agent",
      ownerId: "crm",
      mode: "dynamic",
      selector: { tags: ["crm-cli-dynamic"] },
    });

    const lists = new ChatReadingListCommands();
    const previewPayload = captureJson(() => {
      lists.preview(dynamicList.id, "agent:crm", true);
    });
    const preview = previewPayload.preview as Record<string, unknown>;
    const previewDiff = preview.diff as Record<string, unknown>;
    expect(preview.dryRun).toBe(true);
    expect((preview.validation as Record<string, unknown>).canApply).toBe(true);
    expect(previewDiff.added).toBe(1);
    expect(previewDiff.addedChatIds).toBeUndefined();
    expect((preview.current as Record<string, unknown>).chatIds).toBeUndefined();
    expect(dbListChatReadingListMembers({ listId: (previewPayload.list as Record<string, string>).id }).total).toBe(0);

    const payload = captureJson(() => {
      lists.recompute(dynamicList.id, "agent:crm", true);
    });

    expect((payload.recompute as Record<string, unknown>).eligible).toBe(1);
    expect((payload.recompute as Record<string, unknown>).added).toBe(1);
    expect((payload.recompute as Record<string, unknown>).addedChatIds).toBeUndefined();
  });

  it("explains and blocks match:any selectors that contain negative conditions without writing", () => {
    const list = dbCreateChatReadingList({
      name: "sde-cobranca-unsafe",
      ownerType: "system",
      ownerId: "ravi",
      mode: "dynamic",
      selector: {
        scope: "contact",
        match: "any",
        conditions: [
          { kind: "has-tag", tag: "cobranca:em-aberto" },
          { kind: "has-tag", tag: "boleto:emitido" },
          { kind: "has-tag", tag: "boleto:vence-em-2d" },
          { kind: "has-tag", tag: "boleto:vence-hoje" },
          { kind: "not-has-tag", tag: "sinal:optout" },
          { kind: "not-has-tag", tag: "lifecycle:perdido" },
          { kind: "not-has-tag", tag: "perfil:colaborador" },
        ],
      },
    });

    const lists = new ChatReadingListCommands();
    const showPayload = captureJson(() => {
      lists.show(list.id, undefined, true);
    });
    expect((showPayload.validation as Record<string, unknown>).canApply).toBe(false);

    const previewPayload = captureJson(() => {
      lists.preview(list.id, undefined, true);
    });
    const preview = previewPayload.preview as Record<string, unknown>;
    const validation = preview.validation as Record<string, unknown>;
    expect(validation.canApply).toBe(false);
    expect(validation.riskLevel).toBe("high");
    expect(preview.diff).toBeNull();
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_any_with_negative", severity: "error", path: "match" }),
      ]),
    );
    expect(() => lists.recompute(list.id, undefined, true)).toThrow(/unsafe_any_with_negative/);
    expect(dbListChatReadingListMembers({ listId: list.id }).total).toBe(0);
  });

  it("previews a safe positive-and-exclusion selector without materializing members", () => {
    const safeChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999912@s.whatsapp.net",
      chatType: "dm",
      title: "Safe billing contact",
    });
    const excludedChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999913@s.whatsapp.net",
      chatType: "dm",
      title: "Opted-out billing contact",
    });
    dbUpsertChatParticipant({ chatId: safeChat.id, contactId: "contact_safe", source: "test" });
    dbUpsertChatParticipant({ chatId: excludedChat.id, contactId: "contact_excluded", source: "test" });
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: "contact_safe",
      tags: ["cobranca:em-aberto"],
      source: "test",
    });
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: "contact_excluded",
      tags: ["cobranca:em-aberto", "sinal:optout"],
      source: "test",
    });
    const list = dbCreateChatReadingList({
      name: "sde-cobranca-safe",
      ownerType: "system",
      ownerId: "ravi",
      mode: "dynamic",
      selector: {
        scope: "contact",
        match: "all",
        conditions: [
          { kind: "has-tag", tag: "cobranca:em-aberto" },
          { kind: "not-has-tag", tag: "sinal:optout" },
        ],
      },
    });

    const lists = new ChatReadingListCommands();
    const payload = captureJson(() => lists.preview(list.id, undefined, true));
    const preview = payload.preview as Record<string, unknown>;
    const diff = preview.diff as Record<string, unknown>;
    expect((preview.validation as Record<string, unknown>).canApply).toBe(true);
    expect(diff.eligible).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.eligibleChatIds).toBeUndefined();
    expect(dbListChatReadingListMembers({ listId: list.id }).total).toBe(0);
  });

  it("scopes show, preview and recompute authorization to the requested list", () => {
    const access = getCommandAccessMetadata(ChatReadingListCommands);
    for (const command of ["show", "preview", "recompute"]) {
      expect(access.get(command)).toMatchObject({
        resource: "chats.lists",
        resourceId: "listId",
        requireConcreteResource: true,
        resourceIdPattern: "^crl_[0-9a-f]{24}$",
        input: ["listId", "owner"],
      });
      const [listArg] = getArgsMetadata(ChatReadingListCommands.prototype, command);
      expect(listArg?.name).toBe("listId");
      expect(listArg?.schema?.safeParse("sde-cobranca").success).toBe(false);
      expect(listArg?.schema?.safeParse("crl_0123456789abcdef01234567").success).toBe(true);
    }
  });

  it("omits raw selector and metadata from every public show and preview nesting", () => {
    const scopeSentinel = "contact_secret_scope";
    const matchSentinel = "contact_secret_match";
    const chatTypeSentinel = "chat_secret_type";
    const modeSentinel = "list_secret_mode";
    const nameSentinel = "list_secret_name";
    const list = dbCreateChatReadingList({
      name: "private-selector-refs",
      ownerType: "system",
      ownerId: "other",
      visibility: "private",
      mode: "dynamic",
      selector: {
        scope: scopeSentinel,
        match: matchSentinel,
        chatType: chatTypeSentinel,
        chatIds: ["chat_secret"],
        contactIds: ["contact_secret"],
      },
      metadata: { sourceChatId: "metadata_chat_secret", contactId: "metadata_contact_secret" },
    });
    const lists = new ChatReadingListCommands();

    const showPayload = captureJson(() => lists.show(list.id, "system:other", true));
    const previewPayload = captureJson(() => lists.preview(list.id, "system:other", true));
    for (const payload of [showPayload, previewPayload]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("chat_secret");
      expect(serialized).not.toContain("contact_secret");
      expect(serialized).not.toContain("metadata_chat_secret");
      expect(serialized).not.toContain("metadata_contact_secret");
      expect(serialized).not.toContain(scopeSentinel);
      expect(serialized).not.toContain(matchSentinel);
      expect(serialized).not.toContain(chatTypeSentinel);
    }
    expect((showPayload.list as Record<string, unknown>).selector).toBeUndefined();
    expect((showPayload.list as Record<string, unknown>).metadata).toBeUndefined();
    expect((previewPayload.list as Record<string, unknown>).selector).toBeUndefined();
    expect((previewPayload.preview as Record<string, unknown>).selector).toBeUndefined();
    expect(
      ((previewPayload.preview as Record<string, unknown>).list as Record<string, unknown>).metadata,
    ).toBeUndefined();

    getDb()
      .prepare("UPDATE chat_reading_lists SET name = ?, mode = ?, updated_at = ? WHERE id = ?")
      .run(nameSentinel, modeSentinel, Date.now() + 1, list.id);

    let recomputeError = "";
    try {
      lists.recompute(list.id, "system:other", true);
    } catch (error) {
      recomputeError = error instanceof Error ? error.message : String(error);
    }
    expect(recomputeError).toContain("Unsafe reading-list selector");
    expect(recomputeError).not.toContain(scopeSentinel);
    expect(recomputeError).not.toContain(matchSentinel);
    expect(recomputeError).not.toContain(chatTypeSentinel);
    expect(recomputeError).not.toContain(modeSentinel);
    expect(recomputeError).not.toContain(nameSentinel);
  });

  it("rejects name-based refs before show, preview, or recompute resolution", () => {
    const lists = new ChatReadingListCommands();
    expect(() => lists.show("same-name", "system:one", true)).toThrow(/canonical crl_/);
    expect(() => lists.preview("same-name", "system:two", true)).toThrow(/canonical crl_/);
    expect(() => lists.recompute("same-name", "system:two", true)).toThrow(/canonical crl_/);
  });

  it("never resolves a canonical list id through a same-named different list", () => {
    const authorizedButMissingId = "crl_0123456789abcdef01234567";
    const differentList = dbCreateChatReadingList({
      name: authorizedButMissingId,
      ownerType: "system",
      ownerId: "other",
      visibility: "private",
      mode: "dynamic",
      selector: { chatIds: ["chat_secret_fallback"] },
    });
    expect(differentList.id).not.toBe(authorizedButMissingId);

    const lists = new ChatReadingListCommands();
    expect(() => lists.show(authorizedButMissingId, "system:other", true)).toThrow(/Reading list not found/);
    expect(() => lists.preview(authorizedButMissingId, "system:other", true)).toThrow(/Reading list not found/);
    expect(() => lists.recompute(authorizedButMissingId, "system:other", true)).toThrow(/Reading list not found/);
  });

  it("does not truncate contact-tag exclusions after 500 related chats", () => {
    const excludedContactId = "contact_optout_many_chats";
    const positiveContactId = "contact_billing_candidate";
    const chats = Array.from({ length: 501 }, (_, index) => {
      const chat = dbUpsertChat({
        channel: "whatsapp",
        instanceId: "instance-1",
        platformChatId: `5511888${String(index).padStart(6, "0")}@s.whatsapp.net`,
        chatType: "dm",
        title: `Opt-out chat ${index}`,
      });
      dbUpsertChatParticipant({ chatId: chat.id, contactId: excludedContactId, source: "test" });
      return chat;
    });
    const firstPage = new Set(
      dbListChatIdsByContactIds({ contactIds: [excludedContactId] }).get(excludedContactId) ?? [],
    );
    expect(firstPage.size).toBe(500);
    const beyondDefaultLimit = chats.find((chat) => !firstPage.has(chat.id));
    expect(beyondDefaultLimit).toBeDefined();
    dbUpsertChatParticipant({
      chatId: beyondDefaultLimit!.id,
      contactId: positiveContactId,
      source: "test",
    });
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: positiveContactId,
      tags: ["cobranca:em-aberto"],
      source: "test",
    });
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: excludedContactId,
      tags: ["sinal:optout"],
      source: "test",
    });
    const list = dbCreateChatReadingList({
      name: "sde-cobranca-many-optouts",
      ownerType: "system",
      ownerId: "ravi",
      mode: "dynamic",
      selector: {
        scope: "contact",
        match: "all",
        conditions: [
          { kind: "has-tag", tag: "cobranca:em-aberto" },
          { kind: "not-has-tag", tag: "sinal:optout" },
        ],
      },
    });

    const payload = captureJson(() => new ChatReadingListCommands().preview(list.id, undefined, true));
    const preview = payload.preview as Record<string, unknown>;
    const diff = preview.diff as Record<string, unknown>;
    expect(diff.eligible).toBe(0);
    expect(diff.added).toBe(0);
    expect(dbListChatReadingListMembers({ listId: list.id }).total).toBe(0);
  });

  it("revalidates the persisted selector inside the recompute transaction", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511777000001@s.whatsapp.net",
      chatType: "dm",
      title: "Stale selector candidate",
    });
    dbUpsertChatParticipant({ chatId: chat.id, contactId: "contact_stale", source: "test" });
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: "contact_stale",
      tags: ["cobranca:em-aberto"],
      source: "test",
    });
    const staleSafeList = dbCreateChatReadingList({
      name: "stale-selector-list",
      ownerType: "system",
      ownerId: "ravi",
      mode: "dynamic",
      selector: { contactTags: ["cobranca:em-aberto"] },
    });
    getDb()
      .prepare("UPDATE chat_reading_lists SET selector_json = ?, updated_at = ? WHERE id = ?")
      .run(
        JSON.stringify({
          scope: "contact",
          match: "any",
          conditions: [
            { kind: "has-tag", tag: "cobranca:em-aberto" },
            { kind: "not-has-tag", tag: "sinal:optout" },
          ],
        }),
        Date.now() + 1,
        staleSafeList.id,
      );

    expect(() => recomputeChatReadingListMembers(staleSafeList)).toThrow(/unsafe_any_with_negative/);
    expect(dbListChatReadingListMembers({ listId: staleSafeList.id }).total).toBe(0);
  });

  it("fails closed when the exact reading list disappears before transactional recompute", () => {
    const original = dbCreateChatReadingList({
      name: "authorized-list",
      ownerType: "system",
      ownerId: "ravi",
      mode: "dynamic",
      selector: { chatIds: ["chat-original"] },
    });
    getDb()
      .prepare("UPDATE chat_reading_lists SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), original.id);
    const substitute = dbCreateChatReadingList({
      name: original.id,
      ownerType: "system",
      ownerId: "ravi",
      mode: "dynamic",
      selector: { chatIds: ["chat-substitute"] },
    });

    expect(() => recomputeChatReadingListMembers(original)).toThrow(`Reading list not found: ${original.id}`);
    expect(dbListChatReadingListMembers({ listId: substitute.id }).total).toBe(0);
  });

  it("uses one canonical parser for structured and legacy chat-tag selectors", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511777000002@s.whatsapp.net",
      chatType: "dm",
      title: "Chat-tag candidate",
    });
    attachTagSlugsToAsset({ assetType: "chat", assetId: chat.id, tags: ["fila:chat"], source: "test" });
    const structured = dbCreateChatReadingList({
      name: "structured-chat-scope",
      mode: "dynamic",
      selector: { scope: "chat", match: "all", conditions: [{ kind: "has-tag", tag: "fila:chat" }] },
    });
    const legacy = dbCreateChatReadingList({
      name: "legacy-chat-asset-type",
      mode: "dynamic",
      selector: { assetType: "chat", tags: ["fila:chat"] },
    });
    const lists = new ChatReadingListCommands();
    for (const list of [structured, legacy]) {
      const payload = captureJson(() => lists.preview(list.id, undefined, true));
      const preview = payload.preview as Record<string, unknown>;
      expect((preview.validation as Record<string, unknown>).scope).toBe("chat");
      expect((preview.diff as Record<string, unknown>).eligible).toBe(1);
    }

    const invalid = validateChatReadingListSelector({
      scope: 42,
      match: false,
      chatType: "bogus",
      tags: ["fila:chat"],
    });
    expect(invalid.canApply).toBe(false);
    expect(invalid.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["invalid_selector_field", "unsupported_chat_type"]),
    );
    const conflicting = validateChatReadingListSelector({
      scope: "contact",
      assetType: "chat",
      tags: ["fila:chat"],
    });
    expect(conflicting.canApply).toBe(false);
    expect(conflicting.issues.map((issue) => issue.code)).toContain("conflicting_selector_aliases");
  });

  it("reports malformed selector fields without evaluating membership", () => {
    const validation = validateChatReadingListSelector({
      scope: "account",
      match: "xor",
      conditions: "not-an-array",
    });

    expect(validation.canApply).toBe(false);
    expect(validation.riskLevel).toBe("high");
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "unsupported_scope",
        "unsupported_match",
        "invalid_conditions",
        "no_supported_predicates",
      ]),
    );
  });

  it("reports unsupported, incomplete, empty and negative-only conditions", () => {
    const unsupported = validateChatReadingListSelector({
      scope: "contact",
      match: "all",
      conditions: [
        { kind: "contains", tag: "cobranca:em-aberto" },
        { kind: "has-tag" },
        { kind: "not-has-tag", tag: "sinal:optout" },
      ],
    });
    expect(unsupported.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unsupported_condition_kind", "missing_condition_tag", "negative_only_selector"]),
    );

    const empty = validateChatReadingListSelector({ scope: "contact", match: "all", conditions: [] });
    expect(empty.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["empty_conditions", "no_supported_predicates"]),
    );
  });

  it("rejects mixed structured and legacy syntax while accepting either syntax alone", () => {
    const mixed = validateChatReadingListSelector({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "cobranca:em-aberto" }],
      contactTags: ["boleto:emitido"],
    });
    expect(mixed.canApply).toBe(false);
    expect(mixed.issues.map((issue) => issue.code)).toContain("mixed_selector_syntax");

    expect(
      validateChatReadingListSelector({
        scope: "contact",
        match: "all",
        conditions: [{ kind: "has-tag", tag: "cobranca:em-aberto" }],
      }).canApply,
    ).toBe(true);
    expect(validateChatReadingListSelector({ contactTags: ["cobranca:em-aberto"] }).canApply).toBe(true);
  });

  it("backfills provider timestamps from raw message provenance", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
      title: "Maria",
      rawProvenance: { provider: "omni", rawChatId: "5511999999999@s.whatsapp.net" },
    });

    const originalMessageTimestamp = 1_761_059_699;
    const collapsedTimestamp = 1_777_777_777_000;
    const collapsed = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-history-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "antiga" },
      rawProvenance: {
        source: "omni.message.received",
        rawPayload: { messageTimestamp: originalMessageTimestamp },
      },
      providerTimestamp: collapsedTimestamp,
      ingestedAt: collapsedTimestamp,
    }).message;

    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-history-2",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "ja correta" },
      rawProvenance: {
        source: "omni.message.received",
        rawPayload: { messageTimestamp: originalMessageTimestamp + 1 },
      },
      providerTimestamp: (originalMessageTimestamp + 1) * 1000,
      ingestedAt: collapsedTimestamp + 1,
    });

    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-no-raw-ts",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "sem timestamp bruto" },
      rawProvenance: { source: "omni.message.received", rawPayload: { pushName: "Maria" } },
      providerTimestamp: collapsedTimestamp + 2,
      ingestedAt: collapsedTimestamp + 2,
    });

    const chats = new ChatsCommands();
    const dryRun = captureJson(() => chats.backfillProviderTimestamps(undefined, undefined, undefined, true));
    expect(dryRun).toMatchObject({
      dryRun: true,
      scanned: 2,
      candidates: 2,
      skipped: 0,
      unchanged: 1,
      wouldUpdate: 1,
      updated: 0,
    });
    expect(dbGetChatMessage(collapsed.id)?.providerTimestamp).toBe(collapsedTimestamp);

    const applied = captureJson(() => chats.backfillProviderTimestamps(undefined, true, undefined, true));
    expect(applied).toMatchObject({
      dryRun: false,
      scanned: 2,
      candidates: 2,
      skipped: 0,
      unchanged: 1,
      wouldUpdate: 1,
      updated: 1,
    });
    expect(dbGetChatMessage(collapsed.id)?.providerTimestamp).toBe(originalMessageTimestamp * 1000);

    const secondApply = captureJson(() => chats.backfillProviderTimestamps(undefined, true, undefined, true));
    expect(secondApply).toMatchObject({
      dryRun: false,
      unchanged: 2,
      wouldUpdate: 0,
      updated: 0,
    });
  });
});
