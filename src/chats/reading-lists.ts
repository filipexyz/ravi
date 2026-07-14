import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import {
  dbGetChat,
  dbListChatIdsByContactIds,
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
    const normalized = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
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

function normalizeMatchMode(selector: Record<string, unknown>): SelectorMatchMode {
  const raw = stringValue(selector.tagMode) ?? stringValue(selector.tagsMode) ?? stringValue(selector.match);
  return raw === "any" || raw === "or" ? "any" : "all";
}

function normalizeTagTargets(selector: Record<string, unknown>): TagTarget[] {
  const raw = stringValue(selector.tagTarget) ?? stringValue(selector.tagsTarget) ?? stringValue(selector.assetType);
  if (raw === "chat" || raw === "chats") return ["chat"];
  if (raw === "contact" || raw === "contacts") return ["contact"];
  return ["contact"];
}

function selectorScope(selector: Record<string, unknown>): TagTarget {
  const raw = stringValue(selector.scope) ?? stringValue(selector.tagTarget) ?? stringValue(selector.tagsTarget);
  return raw === "chat" || raw === "chats" ? "chat" : "contact";
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

  const target = selectorScope(selector);
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

export function validateChatReadingListSelector(selectorValue: unknown): ChatReadingListSelectorValidation {
  const selector = isRecord(selectorValue) ? selectorValue : {};
  const issues: ChatReadingListSelectorIssue[] = [];
  const rawScope = stringValue(selector.scope) ?? stringValue(selector.tagTarget) ?? stringValue(selector.tagsTarget);
  const scope = selectorScope(selector);
  if (rawScope && !["contact", "contacts", "chat", "chats"].includes(rawScope)) {
    issues.push({
      code: "unsupported_scope",
      severity: "error",
      path: "scope",
      message: `Unsupported selector scope: ${rawScope}. Use contact or chat.`,
    });
  }

  const rawMatch = stringValue(selector.match) ?? stringValue(selector.tagMode) ?? stringValue(selector.tagsMode);
  const match = normalizeMatchMode(selector);
  if (rawMatch && !["all", "and", "any", "or"].includes(rawMatch)) {
    issues.push({
      code: "unsupported_match",
      severity: "error",
      path: "match",
      message: `Unsupported selector match mode: ${rawMatch}. Use all or any.`,
    });
  }

  const conditions = normalizeStructuredConditions(selector, issues);
  const positive = conditions.filter((condition) => condition.kind === "has-tag").length;
  const negative = conditions.filter((condition) => condition.kind === "not-has-tag").length;
  if (Array.isArray(selector.conditions) && selector.conditions.length === 0) {
    issues.push({
      code: "empty_conditions",
      severity: "error",
      path: "conditions",
      message: "Selector conditions cannot be empty.",
    });
  }
  if (conditions.length > 0 && LEGACY_TAG_KEYS.some((key) => key in selector)) {
    issues.push({
      code: "mixed_selector_syntax",
      severity: "error",
      message: "Do not mix conditions[] with legacy tag/tag-list fields in one selector.",
    });
  }
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

  const criteria = selectorCriteria(selector);
  const hasSupportedPredicates = conditions.length > 0 || hasCriteria(criteria);
  if (!hasSupportedPredicates) {
    issues.push({
      code: "no_supported_predicates",
      severity: "error",
      message:
        "Selector has no supported predicates. Use conditions, contactTags/tags, chatTags, contacts, chats, channel, instanceId, or chatType.",
    });
  }

  const valid = !issues.some((issue) => issue.severity === "error");
  return {
    valid,
    canApply: valid,
    riskLevel: valid ? "low" : "high",
    scope,
    match,
    conditions: {
      total: Array.isArray(selector.conditions) ? selector.conditions.length : 0,
      supported: conditions.length,
      positive,
      negative,
    },
    issues,
  };
}

function addTagsByMode(
  input: {
    selector: Record<string, unknown>;
    targets: TagTarget[];
    mode: SelectorMatchMode;
  },
  criteria: ReadingListSelectorCriteria,
): void {
  const genericAll = normalizeStringList(input.selector.allTags);
  const genericAny = normalizeStringList(input.selector.anyTags);
  const genericTags = normalizeStringList(input.selector.tag, input.selector.tags);
  const defaultGenericAll = input.mode === "all" ? genericTags : [];
  const defaultGenericAny = input.mode === "any" ? genericTags : [];

  if (input.targets.includes("contact")) {
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

  if (input.targets.includes("chat")) {
    criteria.chatAllTags.push(
      ...genericAll,
      ...defaultGenericAll,
      ...normalizeStringList(input.selector.chatTag, input.selector.chatTags, input.selector.allChatTags),
    );
    criteria.chatAnyTags.push(...genericAny, ...defaultGenericAny, ...normalizeStringList(input.selector.anyChatTags));
  }
}

function selectorCriteria(selector: Record<string, unknown>): ReadingListSelectorCriteria {
  const criteria: ReadingListSelectorCriteria = {
    chatIds: normalizeStringList(selector.chat, selector.chatId, selector.chats, selector.chatIds),
    contactIds: normalizeStringList(selector.contact, selector.contactId, selector.contacts, selector.contactIds),
    contactAllTags: [],
    contactAnyTags: [],
    chatAllTags: [],
    chatAnyTags: [],
    channel: stringValue(selector.channel),
    instanceId: stringValue(selector.instanceId) ?? stringValue(selector.instance),
    chatType: (stringValue(selector.chatType) ?? stringValue(selector.type)) as ChatType | undefined,
  };
  addTagsByMode(
    {
      selector,
      targets: normalizeTagTargets(selector),
      mode: normalizeMatchMode(selector),
    },
    criteria,
  );
  return criteria;
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
  const byContact = dbListChatIdsByContactIds({ contactIds: contactIdsList });
  const result = new Set<string>();
  for (const chatIds of byContact.values()) {
    for (const chatId of chatIds) result.add(chatId);
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

function eligibleChatIdsForSelector(selector: Record<string, unknown>): string[] {
  const criteria = selectorCriteria(selector);
  const issues: ChatReadingListSelectorIssue[] = [];
  const conditions = normalizeStructuredConditions(selector, issues);

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

  const conditionChats = chatsForTagConditions(conditions, normalizeMatchMode(selector));
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

export function inspectChatReadingList(list: ChatReadingListRecord): ChatReadingListInspectionResult {
  const selector = isRecord(list.selector) ? list.selector : {};
  const validation = validateChatReadingListSelector(selector);
  const mode = list.mode.trim().toLowerCase();
  if (mode !== "dynamic" && mode !== "hybrid") {
    validation.issues.push({
      code: "unsupported_list_mode",
      severity: "error",
      path: "mode",
      message: `Reading list ${list.name} is ${list.mode}; preview/recompute requires dynamic or hybrid mode.`,
    });
    validation.valid = false;
    validation.canApply = false;
    validation.riskLevel = "high";
  }

  const activeRows = activeReadingListMembers(list.id);
  const selectorRows = activeRows.filter((row) => row.source === "selector");
  const preservedRows = activeRows.filter((row) => row.source !== "selector");
  return {
    list,
    selector,
    validation,
    current: {
      total: activeRows.length,
      selector: selectorRows.length,
      preserved: preservedRows.length,
      chatIds: activeRows.map((row) => row.chat_id).sort(),
    },
  };
}

export function previewChatReadingListMembers(list: ChatReadingListRecord): ChatReadingListPreviewResult {
  const inspection = inspectChatReadingList(list);
  const activeRows = activeReadingListMembers(list.id);
  return {
    ...inspection,
    dryRun: true,
    diff: inspection.validation.canApply
      ? membershipDiff(eligibleChatIdsForSelector(inspection.selector), activeRows)
      : null,
  };
}

export function recomputeChatReadingListMembers(list: ChatReadingListRecord): ChatReadingListRecomputeResult {
  const preview = previewChatReadingListMembers(list);
  if (!preview.validation.canApply || !preview.diff) {
    const reasons = preview.validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(
      `Unsafe reading-list selector; recompute blocked. ${reasons} Run ravi chats lists preview ${list.id} --json before applying.`,
    );
  }
  const selector = preview.selector;
  const eligibleChatIds = preview.diff.eligibleChatIds;
  const database = getDb();
  const now = Date.now();

  const appliedDiff = executeWrite(
    database,
    () => {
      // Membership may change after a reviewed preview. Re-read it inside the
      // write transaction while keeping the already validated eligible set.
      const diff = membershipDiff(eligibleChatIds, activeReadingListMembers(list.id));
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
          .run(id, list.id, chatId, JSON.stringify({ selector, recomputedAt: now }), now);
      }

      for (const chatId of diff.removedChatIds) {
        database
          .prepare(
            "UPDATE chat_reading_list_members SET removed_at = ? WHERE list_id = ? AND chat_id = ? AND source = 'selector' AND removed_at IS NULL",
          )
          .run(now, list.id, chatId);
      }

      if (diff.added > 0 || diff.removed > 0) {
        database.prepare("UPDATE chat_reading_lists SET updated_at = ? WHERE id = ?").run(now, list.id);
      }
      return diff;
    },
    { label: "chats:recomputeReadingListMembers" },
  );

  return {
    list,
    selector,
    ...appliedDiff,
  };
}
