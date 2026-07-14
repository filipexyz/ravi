import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import {
  dbFindChatReadingList,
  dbGetChat,
  dbListChats,
  getDb,
  type ChatReadingListRecord,
  type ChatType,
} from "../router/router-db.js";
import { canonicalAssetIdsForTag } from "../tags/helpers.js";

type TagTarget = "contact" | "chat";
type SelectorMatchMode = "all" | "any";

interface ActiveReadingListMemberRow {
  id: string;
  chat_id: string;
  source: string;
}

interface ReadingListSelectorCriteria {
  chatIds: string[];
  contactIds: string[];
  contactAllTags: string[];
  contactAnyTags: string[];
  chatAllTags: string[];
  chatAnyTags: string[];
  channel?: string;
  instanceId?: string;
  chatType?: ChatType;
}

interface NormalizedTagCondition {
  kind: "has-tag" | "not-has-tag";
  tag: string;
  target: TagTarget;
}

interface ParsedReadingListSelector {
  selector: Record<string, unknown>;
  scope: TagTarget;
  match: SelectorMatchMode;
  conditions: NormalizedTagCondition[];
  criteria: ReadingListSelectorCriteria;
  issues: ChatReadingListSelectorIssue[];
  conditionCount: number;
}

export interface ChatReadingListSelectorIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface ChatReadingListSelectorValidation {
  valid: boolean;
  canApply: boolean;
  riskLevel: "low" | "high";
  scope: TagTarget;
  match: SelectorMatchMode;
  conditions: {
    total: number;
    supported: number;
    positive: number;
    negative: number;
  };
  issues: ChatReadingListSelectorIssue[];
}

export interface ChatReadingListMembershipDiff {
  eligibleChatIds: string[];
  addedChatIds: string[];
  removedChatIds: string[];
  keptChatIds: string[];
  preservedChatIds: string[];
  added: number;
  removed: number;
  kept: number;
  preserved: number;
  eligible: number;
}

export interface ChatReadingListPreviewResult {
  list: ChatReadingListRecord;
  selector: Record<string, unknown>;
  dryRun: true;
  validation: ChatReadingListSelectorValidation;
  current: {
    total: number;
    selector: number;
    preserved: number;
    chatIds: string[];
  };
  diff: ChatReadingListMembershipDiff | null;
}

export interface ChatReadingListInspectionResult {
  list: ChatReadingListRecord;
  selector: Record<string, unknown>;
  validation: ChatReadingListSelectorValidation;
  current: ChatReadingListPreviewResult["current"];
}

export interface ChatReadingListRecomputeResult extends ChatReadingListMembershipDiff {
  list: ChatReadingListRecord;
  selector: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(...values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushOne = (value: unknown): void => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const part of value.split(",")) pushOne(part);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    pushOne(value);
  };

  for (const value of values) visit(value);
  return result;
}

function invalidFieldIssue(issues: ChatReadingListSelectorIssue[], key: string, expected: string): void {
  issues.push({
    code: "invalid_selector_field",
    severity: "error",
    path: key,
    message: `Selector ${key} must be ${expected}.`,
  });
}

function canonicalAlias<T extends string>(input: {
  selector: Record<string, unknown>;
  keys: readonly string[];
  aliases: Readonly<Record<string, T>>;
  fallback: T;
  label: string;
  unsupportedCode: string;
  issues: ChatReadingListSelectorIssue[];
}): T {
  const resolved: Array<{ key: string; value: T }> = [];
  for (const key of input.keys) {
    if (!(key in input.selector)) continue;
    const raw = input.selector[key];
    if (typeof raw !== "string" || !raw.trim()) {
      invalidFieldIssue(input.issues, key, "a non-empty string");
      continue;
    }
    const value = input.aliases[raw.trim()];
    if (!value) {
      input.issues.push({
        code: input.unsupportedCode,
        severity: "error",
        path: key,
        message: `Selector ${input.label} uses an unsupported value.`,
      });
      continue;
    }
    resolved.push({ key, value });
  }
  const distinct = new Set(resolved.map((entry) => entry.value));
  if (distinct.size > 1) {
    input.issues.push({
      code: "conflicting_selector_aliases",
      severity: "error",
      path: resolved.map((entry) => entry.key).join(","),
      message: `Selector aliases for ${input.label} conflict; provide one canonical value.`,
    });
  }
  return resolved[0]?.value ?? input.fallback;
}

function strictStringAlias(
  selector: Record<string, unknown>,
  keys: readonly string[],
  issues: ChatReadingListSelectorIssue[],
): string | undefined {
  const resolved: Array<{ key: string; value: string }> = [];
  for (const key of keys) {
    if (!(key in selector)) continue;
    const value = stringValue(selector[key]);
    if (!value) {
      invalidFieldIssue(issues, key, "a non-empty string");
      continue;
    }
    resolved.push({ key, value });
  }
  if (new Set(resolved.map((entry) => entry.value)).size > 1) {
    issues.push({
      code: "conflicting_selector_aliases",
      severity: "error",
      path: resolved.map((entry) => entry.key).join(","),
      message: `Selector aliases ${resolved.map((entry) => entry.key).join("/")} conflict.`,
    });
  }
  return resolved[0]?.value;
}

function validateStringListFields(
  selector: Record<string, unknown>,
  keys: readonly string[],
  issues: ChatReadingListSelectorIssue[],
): void {
  const validListValue = (value: unknown): boolean =>
    typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
  for (const key of keys) {
    if (key in selector && !validListValue(selector[key])) {
      invalidFieldIssue(issues, key, "a string or an array of strings");
    }
  }
}

const LEGACY_TAG_KEYS = [
  "tag",
  "tags",
  "allTags",
  "anyTags",
  "contactTag",
  "contactTags",
  "allContactTags",
  "anyContactTags",
  "chatTag",
  "chatTags",
  "allChatTags",
  "anyChatTags",
] as const;

function normalizeStructuredConditions(
  selector: Record<string, unknown>,
  target: TagTarget,
  issues: ChatReadingListSelectorIssue[],
): NormalizedTagCondition[] {
  if (!("conditions" in selector)) return [];
  if (!Array.isArray(selector.conditions)) {
    issues.push({
      code: "invalid_conditions",
      severity: "error",
      path: "conditions",
      message: "Selector conditions must be an array.",
    });
    return [];
  }
  const conditions: NormalizedTagCondition[] = [];
  selector.conditions.forEach((raw, index) => {
    const path = `conditions[${index}]`;
    if (!isRecord(raw)) {
      issues.push({ code: "invalid_condition", severity: "error", path, message: `${path} must be an object.` });
      return;
    }
    const kind = stringValue(raw.kind);
    const tag = stringValue(raw.tag);
    if (kind !== "has-tag" && kind !== "not-has-tag") {
      issues.push({
        code: "unsupported_condition_kind",
        severity: "error",
        path: `${path}.kind`,
        message: `${path}.kind must be has-tag or not-has-tag.`,
      });
      return;
    }
    if (!tag) {
      issues.push({
        code: "missing_condition_tag",
        severity: "error",
        path: `${path}.tag`,
        message: `${path}.tag is required.`,
      });
      return;
    }
    conditions.push({ kind, tag, target });
  });
  return conditions;
}

function addTagsByMode(
  input: {
    selector: Record<string, unknown>;
    target: TagTarget;
    mode: SelectorMatchMode;
  },
  criteria: ReadingListSelectorCriteria,
): void {
  const genericAll = normalizeStringList(input.selector.allTags);
  const genericAny = normalizeStringList(input.selector.anyTags);
  const genericTags = normalizeStringList(input.selector.tag, input.selector.tags);
  const defaultGenericAll = input.mode === "all" ? genericTags : [];
  const defaultGenericAny = input.mode === "any" ? genericTags : [];

  if (input.target === "contact") {
    criteria.contactAllTags.push(
      ...genericAll,
      ...defaultGenericAll,
      ...normalizeStringList(input.selector.contactTag, input.selector.contactTags, input.selector.allContactTags),
    );
    criteria.contactAnyTags.push(
      ...genericAny,
      ...defaultGenericAny,
      ...normalizeStringList(input.selector.anyContactTags),
    );
  }

  if (input.target === "chat") {
    criteria.chatAllTags.push(
      ...genericAll,
      ...defaultGenericAll,
      ...normalizeStringList(input.selector.chatTag, input.selector.chatTags, input.selector.allChatTags),
    );
    criteria.chatAnyTags.push(...genericAny, ...defaultGenericAny, ...normalizeStringList(input.selector.anyChatTags));
  }
}

const STRING_LIST_FIELDS = [
  "chat",
  "chatId",
  "chats",
  "chatIds",
  "contact",
  "contactId",
  "contacts",
  "contactIds",
  ...LEGACY_TAG_KEYS,
] as const;

function selectorCriteria(
  selector: Record<string, unknown>,
  scope: TagTarget,
  match: SelectorMatchMode,
  issues: ChatReadingListSelectorIssue[],
): ReadingListSelectorCriteria {
  validateStringListFields(selector, STRING_LIST_FIELDS, issues);
  const channel = strictStringAlias(selector, ["channel"], issues);
  const instanceId = strictStringAlias(selector, ["instanceId", "instance"], issues);
  const chatType = strictStringAlias(selector, ["chatType", "type"], issues);
  if (chatType && !["dm", "group", "room", "thread", "channel", "unknown"].includes(chatType)) {
    issues.push({
      code: "unsupported_chat_type",
      severity: "error",
      path: "chatType",
      message: "Selector chatType uses an unsupported value.",
    });
  }
  const criteria: ReadingListSelectorCriteria = {
    chatIds: normalizeStringList(selector.chat, selector.chatId, selector.chats, selector.chatIds),
    contactIds: normalizeStringList(selector.contact, selector.contactId, selector.contacts, selector.contactIds),
    contactAllTags: [],
    contactAnyTags: [],
    chatAllTags: [],
    chatAnyTags: [],
    channel,
    instanceId,
    chatType: chatType as ChatType | undefined,
  };
  addTagsByMode(
    {
      selector,
      target: scope,
      mode: match,
    },
    criteria,
  );
  return criteria;
}

function parseReadingListSelector(selectorValue: unknown): ParsedReadingListSelector {
  const selector = isRecord(selectorValue) ? selectorValue : {};
  const issues: ChatReadingListSelectorIssue[] = [];
  if (!isRecord(selectorValue)) {
    issues.push({
      code: "invalid_selector",
      severity: "error",
      message: "Selector must be an object.",
    });
  }
  const scope = canonicalAlias<TagTarget>({
    selector,
    keys: ["scope", "tagTarget", "tagsTarget", "assetType"],
    aliases: { contact: "contact", contacts: "contact", chat: "chat", chats: "chat" },
    fallback: "contact",
    label: "scope",
    unsupportedCode: "unsupported_scope",
    issues,
  });
  const match = canonicalAlias<SelectorMatchMode>({
    selector,
    keys: ["match", "tagMode", "tagsMode"],
    aliases: { all: "all", and: "all", any: "any", or: "any" },
    fallback: "all",
    label: "match mode",
    unsupportedCode: "unsupported_match",
    issues,
  });
  const conditions = normalizeStructuredConditions(selector, scope, issues);
  const conditionCount = Array.isArray(selector.conditions) ? selector.conditions.length : 0;
  if (Array.isArray(selector.conditions) && selector.conditions.length === 0) {
    issues.push({
      code: "empty_conditions",
      severity: "error",
      path: "conditions",
      message: "Selector conditions cannot be empty.",
    });
  }
  if ("conditions" in selector && LEGACY_TAG_KEYS.some((key) => key in selector)) {
    issues.push({
      code: "mixed_selector_syntax",
      severity: "error",
      message: "Do not mix conditions[] with legacy tag/tag-list fields in one selector.",
    });
  }
  const positive = conditions.filter((condition) => condition.kind === "has-tag").length;
  const negative = conditions.filter((condition) => condition.kind === "not-has-tag").length;
  if (match === "any" && negative > 0) {
    issues.push({
      code: "unsafe_any_with_negative",
      severity: "error",
      path: "match",
      message:
        "match:any cannot be combined with not-has-tag: each negative branch matches almost the entire scope and can over-expand the list.",
    });
  }
  if (negative > 0 && positive === 0) {
    issues.push({
      code: "negative_only_selector",
      severity: "error",
      path: "conditions",
      message: "A selector with exclusions must include at least one positive has-tag condition.",
    });
  }
  const criteria = selectorCriteria(selector, scope, match, issues);
  if (conditions.length === 0 && !hasCriteria(criteria)) {
    issues.push({
      code: "no_supported_predicates",
      severity: "error",
      message:
        "Selector has no supported predicates. Use conditions, contactTags/tags, chatTags, contacts, chats, channel, instanceId, or chatType.",
    });
  }
  return { selector, scope, match, conditions, criteria, issues, conditionCount };
}

function selectorValidation(parsed: ParsedReadingListSelector): ChatReadingListSelectorValidation {
  const positive = parsed.conditions.filter((condition) => condition.kind === "has-tag").length;
  const negative = parsed.conditions.filter((condition) => condition.kind === "not-has-tag").length;
  const valid = !parsed.issues.some((issue) => issue.severity === "error");
  return {
    valid,
    canApply: valid,
    riskLevel: valid ? "low" : "high",
    scope: parsed.scope,
    match: parsed.match,
    conditions: {
      total: parsed.conditionCount,
      supported: parsed.conditions.length,
      positive,
      negative,
    },
    issues: parsed.issues,
  };
}

export function validateChatReadingListSelector(selectorValue: unknown): ChatReadingListSelectorValidation {
  return selectorValidation(parseReadingListSelector(selectorValue));
}

function hasCriteria(criteria: ReadingListSelectorCriteria): boolean {
  return Boolean(
    criteria.chatIds.length ||
      criteria.contactIds.length ||
      criteria.contactAllTags.length ||
      criteria.contactAnyTags.length ||
      criteria.chatAllTags.length ||
      criteria.chatAnyTags.length ||
      criteria.channel ||
      criteria.instanceId ||
      criteria.chatType,
  );
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}

function unionSets(sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const set of sets) {
    for (const value of set) result.add(value);
  }
  return result;
}

function subtractSet(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) {
    if (!right.has(value)) result.add(value);
  }
  return result;
}

function taggedAssetIds(assetType: "contact" | "chat", tags: string[], mode: SelectorMatchMode): Set<string> | null {
  const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (normalizedTags.length === 0) return null;
  const sets = normalizedTags.map((tag) => new Set(canonicalAssetIdsForTag(assetType, tag) ?? []));
  if (sets.length === 0) return null;
  if (mode === "any") return unionSets(sets);
  return sets.slice(1).reduce((acc, set) => intersectSets(acc, set), sets[0] ?? new Set<string>());
}

function chatsForContactIds(contactIds: Iterable<string>): Set<string> {
  const contactIdsList = [...new Set([...contactIds].map((id) => id.trim()).filter(Boolean))];
  const result = new Set<string>();
  const database = getDb();
  const chunkSize = 250;
  for (let index = 0; index < contactIdsList.length; index += chunkSize) {
    const chunk = contactIdsList.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `
        SELECT DISTINCT related.chat_id AS chat_id
        FROM (
          SELECT cp.chat_id AS chat_id
          FROM chat_participants cp
          WHERE cp.contact_id IN (${placeholders})

          UNION

          SELECT cm.chat_id AS chat_id
          FROM chat_messages cm
          WHERE cm.contact_id IN (${placeholders})
        ) related
        WHERE related.chat_id IS NOT NULL
        ORDER BY related.chat_id ASC
      `,
      )
      .all(...chunk, ...chunk) as Array<{ chat_id: string }>;
    for (const row of rows) result.add(row.chat_id);
  }
  return result;
}

function chatsForChatIds(chatIds: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const chatId of chatIds) {
    const chat = dbGetChat(chatId.trim());
    if (chat) result.add(chat.id);
  }
  return result;
}

function chatsForFilters(criteria: ReadingListSelectorCriteria): Set<string> | null {
  if (!criteria.channel && !criteria.instanceId && !criteria.chatType) return null;
  const result = new Set<string>();
  let offset = 0;
  const limit = 500;
  while (true) {
    const page = dbListChats({
      channel: criteria.channel,
      instanceId: criteria.instanceId,
      chatType: criteria.chatType,
      limit,
      offset,
    });
    for (const item of page.items) result.add(item.chat.id);
    if (page.items.length === 0 || offset + page.items.length >= page.total) break;
    offset += page.items.length;
  }
  return result;
}

function chatsForTagConditions(conditions: NormalizedTagCondition[], match: SelectorMatchMode): Set<string> | null {
  const positives = conditions.filter((condition) => condition.kind === "has-tag");
  if (positives.length === 0) return null;
  const positiveSets = positives.map((condition) => {
    const assetIds = taggedAssetIds(condition.target, [condition.tag], "all") ?? new Set<string>();
    return condition.target === "contact" ? chatsForContactIds(assetIds) : chatsForChatIds(assetIds);
  });
  const included =
    match === "any"
      ? unionSets(positiveSets)
      : positiveSets.slice(1).reduce((acc, set) => intersectSets(acc, set), positiveSets[0] ?? new Set<string>());

  const excludedSets = conditions
    .filter((condition) => condition.kind === "not-has-tag")
    .map((condition) => {
      const assetIds = taggedAssetIds(condition.target, [condition.tag], "all") ?? new Set<string>();
      return condition.target === "contact" ? chatsForContactIds(assetIds) : chatsForChatIds(assetIds);
    });
  return subtractSet(included, unionSets(excludedSets));
}

function eligibleChatIdsForSelector(parsed: ParsedReadingListSelector): string[] {
  const { criteria, conditions, match } = parsed;
  const sets: Set<string>[] = [];
  if (criteria.chatIds.length > 0) sets.push(chatsForChatIds(criteria.chatIds));
  if (criteria.contactIds.length > 0) sets.push(chatsForContactIds(criteria.contactIds));

  const allTaggedContacts = taggedAssetIds("contact", criteria.contactAllTags, "all");
  if (allTaggedContacts) sets.push(chatsForContactIds(allTaggedContacts));
  const anyTaggedContacts = taggedAssetIds("contact", criteria.contactAnyTags, "any");
  if (anyTaggedContacts) sets.push(chatsForContactIds(anyTaggedContacts));

  const allTaggedChats = taggedAssetIds("chat", criteria.chatAllTags, "all");
  if (allTaggedChats) sets.push(chatsForChatIds(allTaggedChats));
  const anyTaggedChats = taggedAssetIds("chat", criteria.chatAnyTags, "any");
  if (anyTaggedChats) sets.push(chatsForChatIds(anyTaggedChats));

  const filteredChats = chatsForFilters(criteria);
  if (filteredChats) sets.push(filteredChats);

  const conditionChats = chatsForTagConditions(conditions, match);
  if (conditionChats) sets.push(conditionChats);

  const eligible = sets.slice(1).reduce((acc, set) => intersectSets(acc, set), sets[0] ?? new Set<string>());
  return [...eligible].sort();
}

function activeReadingListMembers(listId: string): ActiveReadingListMemberRow[] {
  return getDb()
    .prepare(
      `
      SELECT id, chat_id, source
      FROM chat_reading_list_members
      WHERE list_id = ? AND removed_at IS NULL
      ORDER BY added_at ASC, id ASC
    `,
    )
    .all(listId) as ActiveReadingListMemberRow[];
}

function membershipDiff(
  eligibleChatIds: string[],
  activeRows: ActiveReadingListMemberRow[],
): ChatReadingListMembershipDiff {
  const eligible = new Set(eligibleChatIds);
  const activeByChatId = new Map(activeRows.map((row) => [row.chat_id, row]));
  const addedChatIds = eligibleChatIds.filter((chatId) => !activeByChatId.has(chatId)).sort();
  const removedChatIds = activeRows
    .filter((row) => row.source === "selector" && !eligible.has(row.chat_id))
    .map((row) => row.chat_id)
    .sort();
  const keptChatIds = activeRows
    .filter((row) => row.source === "selector" && eligible.has(row.chat_id))
    .map((row) => row.chat_id)
    .sort();
  const preservedChatIds = activeRows
    .filter((row) => row.source !== "selector")
    .map((row) => row.chat_id)
    .sort();
  return {
    eligibleChatIds,
    addedChatIds,
    removedChatIds,
    keptChatIds,
    preservedChatIds,
    added: addedChatIds.length,
    removed: removedChatIds.length,
    kept: keptChatIds.length,
    preserved: preservedChatIds.length,
    eligible: eligibleChatIds.length,
  };
}

function inspectReadingListWithParsed(list: ChatReadingListRecord): {
  inspection: ChatReadingListInspectionResult;
  parsed: ParsedReadingListSelector;
  activeRows: ActiveReadingListMemberRow[];
} {
  const parsed = parseReadingListSelector(list.selector);
  const validation = selectorValidation(parsed);
  const mode = list.mode.trim().toLowerCase();
  if (mode !== "dynamic" && mode !== "hybrid") {
    validation.issues.push({
      code: "unsupported_list_mode",
      severity: "error",
      path: "mode",
      message: "Reading-list mode must be dynamic or hybrid for preview/recompute.",
    });
    validation.valid = false;
    validation.canApply = false;
    validation.riskLevel = "high";
  }

  const activeRows = activeReadingListMembers(list.id);
  const selectorRows = activeRows.filter((row) => row.source === "selector");
  const preservedRows = activeRows.filter((row) => row.source !== "selector");
  return {
    parsed,
    activeRows,
    inspection: {
      list,
      selector: parsed.selector,
      validation,
      current: {
        total: activeRows.length,
        selector: selectorRows.length,
        preserved: preservedRows.length,
        chatIds: activeRows.map((row) => row.chat_id).sort(),
      },
    },
  };
}

export function inspectChatReadingList(list: ChatReadingListRecord): ChatReadingListInspectionResult {
  return inspectReadingListWithParsed(list).inspection;
}

export function previewChatReadingListMembers(list: ChatReadingListRecord): ChatReadingListPreviewResult {
  const { inspection, parsed, activeRows } = inspectReadingListWithParsed(list);
  return {
    ...inspection,
    dryRun: true,
    diff: inspection.validation.canApply ? membershipDiff(eligibleChatIdsForSelector(parsed), activeRows) : null,
  };
}

export function recomputeChatReadingListMembers(list: ChatReadingListRecord): ChatReadingListRecomputeResult {
  const database = getDb();
  return executeWrite(
    database,
    () => {
      const currentList = dbFindChatReadingList({ ref: list.id });
      if (!currentList) throw new Error(`Reading list not found: ${list.id}`);
      const { inspection, parsed, activeRows } = inspectReadingListWithParsed(currentList);
      if (!inspection.validation.canApply) {
        const reasons = inspection.validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
        throw new Error(
          `Unsafe reading-list selector; recompute refused. ${reasons} Run ravi chats lists preview ${currentList.id} --json before applying.`,
        );
      }

      const selector = parsed.selector;
      const diff = membershipDiff(eligibleChatIdsForSelector(parsed), activeRows);
      const now = Date.now();
      for (const chatId of diff.addedChatIds) {
        const id = `crlm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        database
          .prepare(
            `
            INSERT INTO chat_reading_list_members (
              id, list_id, chat_id, source, reason, priority, metadata_json, added_at, removed_at
            )
            VALUES (?, ?, ?, 'selector', 'selector_recompute', 0, ?, ?, NULL)
          `,
          )
          .run(id, currentList.id, chatId, JSON.stringify({ selector, recomputedAt: now }), now);
      }

      for (const chatId of diff.removedChatIds) {
        database
          .prepare(
            "UPDATE chat_reading_list_members SET removed_at = ? WHERE list_id = ? AND chat_id = ? AND source = 'selector' AND removed_at IS NULL",
          )
          .run(now, currentList.id, chatId);
      }

      if (diff.added > 0 || diff.removed > 0) {
        database.prepare("UPDATE chat_reading_lists SET updated_at = ? WHERE id = ?").run(now, currentList.id);
      }
      return { list: currentList, selector, ...diff };
    },
    { label: "chats:recomputeReadingListMembers" },
  );
}
