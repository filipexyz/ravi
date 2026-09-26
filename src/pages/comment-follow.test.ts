import { describe, expect, it } from "bun:test";
import { evaluateFilter, validateFilter } from "../triggers/filter.js";
import { buildTriggerPrompt } from "../triggers/prompt.js";
import type { Trigger, TriggerInput } from "../triggers/index.js";
import { watchEventFromInboxPayload } from "../watch/events.js";
import type { InboxNatsPayload } from "../inbox/types.js";
import {
  PAGE_COMMENT_CREATED_TOPIC,
  buildPageCommentTriggerInput,
  ensurePageCommentFollow,
  ensurePageCommentTrigger,
  pageCommentBindingFromShip,
  pageCommentFilter,
  pageCommentMatchesEvent,
  pageCommentTriggerName,
} from "./comment-follow.js";

const PAGE_ID = "site_1";
const ORG_ID = "org_1";
const PROJECT_ID = "proj_1";

const binding = { pageId: PAGE_ID, orgId: ORG_ID, projectId: PROJECT_ID };

describe("page comment follow", () => {
  it("builds a fail-closed filter for page, org, and project ids", () => {
    const filter = pageCommentFilter(binding);

    expect(validateFilter(filter)).toEqual({ ok: true });
    expect(pageCommentTriggerName(PAGE_ID)).toBe(`page-comment:${PAGE_ID}`);
    expect(pageCommentMatchesEvent(binding, watchData(PAGE_ID, ORG_ID, PROJECT_ID))).toBe(true);
    expect(pageCommentMatchesEvent(binding, { pageId: PAGE_ID, orgId: ORG_ID, projectId: PROJECT_ID })).toBe(true);
    expect(
      pageCommentMatchesEvent(binding, {
        payload: { siteId: PAGE_ID, organizationId: ORG_ID, projectId: PROJECT_ID },
      }),
    ).toBe(true);
    expect(pageCommentMatchesEvent(binding, watchData("site_other", ORG_ID, PROJECT_ID))).toBe(false);
    expect(pageCommentMatchesEvent(binding, watchData(PAGE_ID, "org_other", PROJECT_ID))).toBe(false);
    expect(pageCommentMatchesEvent(binding, watchData(PAGE_ID, ORG_ID, "proj_other"))).toBe(false);
    expect(pageCommentMatchesEvent(binding, watchData(PAGE_ID, ORG_ID, PROJECT_ID, { authorId: "creator" }))).toBe(
      true,
    );

    const unquoted = `data.pageId == ${PAGE_ID}`;
    expect(validateFilter(unquoted).ok).toBe(false);
    expect(evaluateFilter(unquoted, { pageId: PAGE_ID })).toBe(false);
  });

  it("quotes page ids that contain spaces or quotes", () => {
    const awkward = { pageId: 'site "alpha"', orgId: "org 1" };
    const filter = pageCommentFilter(awkward);
    expect(validateFilter(filter).ok).toBe(true);
    expect(pageCommentMatchesEvent(awkward, { payload: { pageId: 'site "alpha"', orgId: "org 1" } })).toBe(true);
    expect(pageCommentMatchesEvent(awkward, { payload: { pageId: "site alpha", orgId: "org 1" } })).toBe(false);
  });

  it("binds the stable site id from publish and ignores a project slug", () => {
    expect(
      pageCommentBindingFromShip({
        site: { id: "site_from_list", slug: "weekly-report" },
        ensuredSite: { id: "site_ensured", slug: "weekly-report" },
        publish: {
          site: { id: "site_published", slug: "weekly-report", projectId: "proj_real" },
          artifact: { projectId: "proj_artifact" },
        },
        organizationId: "org_1",
        projectId: null,
      }),
    ).toEqual({ pageId: "site_published", orgId: "org_1", projectId: "proj_real" });

    expect(
      pageCommentBindingFromShip({
        site: { slug: "weekly-report" },
        projectId: "not-an-id-but-explicit-scope-id",
      }),
    ).toBeNull();
  });

  it("creates a creator-bound trigger once and reuses it without rebinding", async () => {
    const stored: Trigger[] = [];
    const deps = memoryDeps(stored);
    const first = await ensurePageCommentTrigger(binding, { agentId: "creator", sessionName: "main-session" }, deps);
    const second = await ensurePageCommentTrigger(binding, { agentId: "someone-else" }, deps);

    expect(first.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected triggers");
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.trigger.id).toBe(first.trigger.id);
    expect(second.trigger.agentId).toBe("creator");
    expect(stored).toHaveLength(1);
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]).toMatchObject({
      name: `page-comment:${PAGE_ID}`,
      topic: PAGE_COMMENT_CREATED_TOPIC,
      agentId: "creator",
      session: "main",
      cooldownMs: 30_000,
      messageSource: "catalog",
      replySession: "main-session",
    });
    expect(validateFilter(deps.created[0]?.filter).ok).toBe(true);
    expect(deps.refreshes).toBe(1);
  });

  it("does not persist an invalid generated filter", async () => {
    const stored: Trigger[] = [];
    const deps = memoryDeps(stored);
    const result = await ensurePageCommentTrigger(
      binding,
      { agentId: "creator" },
      {
        ...deps,
        buildFilter: () => "data.pageId == site_1",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid filter");
    expect(result.warning).toContain("invalid");
    expect(validateFilter(result.filter).ok).toBe(false);
    expect(deps.created).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it("repairs an invalid stored filter and leaves a valid custom filter alone", async () => {
    const stored: Trigger[] = [
      fakeTrigger({
        id: "trg_bad",
        name: pageCommentTriggerName(PAGE_ID),
        agentId: "creator",
        filter: "data.pageId == site_1",
      }),
    ];
    const repaired = await ensurePageCommentTrigger(binding, { agentId: "someone-else" }, memoryDeps(stored));
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error("expected repair");
    expect(repaired.reused).toBe(true);
    expect(repaired.trigger.agentId).toBe("creator");
    expect(validateFilter(repaired.trigger.filter).ok).toBe(true);
    expect(pageCommentMatchesEvent(binding, watchData(PAGE_ID, ORG_ID, PROJECT_ID))).toBe(true);

    const custom = `data.payload.pageId == ${JSON.stringify(PAGE_ID)}`;
    stored[0] = fakeTrigger({
      id: "trg_custom",
      name: pageCommentTriggerName(PAGE_ID),
      agentId: "creator",
      filter: custom,
    });
    const leftAlone = await ensurePageCommentTrigger(binding, { agentId: "someone-else" }, memoryDeps(stored));
    if (!leftAlone.ok) throw new Error("expected reuse");
    expect(leftAlone.trigger.filter).toBe(custom);
  });

  it("skips ship follow when the page id or creator is missing, and records a gone creator", async () => {
    const missingPage = await ensurePageCommentFollow(
      { site: { slug: "weekly-report" } },
      { getCreator: () => ({ agentId: "creator" }), agentExists: () => true },
    );
    expect(missingPage).toMatchObject({ ok: false, skipped: "missing_page" });

    const missingCreator = await ensurePageCommentFollow(
      { site: { id: PAGE_ID }, organizationId: ORG_ID, projectId: PROJECT_ID },
      { getCreator: () => null },
    );
    expect(missingCreator).toMatchObject({
      ok: false,
      skipped: "missing_creator",
      pageId: PAGE_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
    });
    expect(validateFilter(missingCreator.filter).ok).toBe(true);

    const stored: Trigger[] = [];
    const gone = await ensurePageCommentFollow(
      { publish: { site: { id: PAGE_ID } }, organizationId: ORG_ID },
      { ...memoryDeps(stored), getCreator: () => ({ agentId: "gone-creator" }), agentExists: () => false },
    );
    expect(gone).toMatchObject({
      ok: false,
      skipped: "unbound_agent",
      agentId: "gone-creator",
      triggerId: stored[0]?.id,
    });
    expect(stored[0]?.agentId).toBe("gone-creator");
  });

  it("wakes with a catalog prompt that includes the comment and omits the raw event dump", () => {
    const input = buildPageCommentTriggerInput(binding, { agentId: "creator" });
    const event = watchEventFromInboxPayload(
      inbox({
        pageId: PAGE_ID,
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        body: "please fix the chart",
        url: "https://weekly.ravi.page/",
      }),
    );
    const prompt = buildTriggerPrompt(
      {
        name: input.name,
        topic: input.topic,
        message: input.message,
        messageSource: input.messageSource,
        messageTemplateId: input.messageTemplateId,
      },
      { topic: input.topic, data: event },
    );

    expect(prompt.startsWith("[Trigger: page-comment:site_1]")).toBe(true);
    expect(prompt).toContain(`Event: ${PAGE_COMMENT_CREATED_TOPIC}`);
    expect(prompt).toContain("please fix the chart");
    expect(prompt).toContain("https://weekly.ravi.page/");
    expect(prompt.includes("Data:")).toBe(false);
  });
});

function watchData(
  pageId: string,
  orgId: string,
  projectId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { payload: { pageId, orgId, projectId, ...extra }, pageId, orgId, projectId };
}

function memoryDeps(stored: Trigger[]) {
  const created: TriggerInput[] = [];
  let refreshes = 0;
  const deps = {
    created,
    get refreshes() {
      return refreshes;
    },
    listTriggers: () => stored,
    createTrigger: (input: TriggerInput) => {
      created.push(input);
      const trigger = fakeTrigger({
        id: `trg_${stored.length + 1}`,
        ...input,
      });
      stored.push(trigger);
      return trigger;
    },
    updateTrigger: (id: string, updates: { filter?: string | null }) => {
      const index = stored.findIndex((trigger) => trigger.id === id);
      const current = stored[index];
      if (!current) throw new Error(`missing ${id}`);
      const next = { ...current, ...updates, filter: updates.filter ?? undefined };
      stored[index] = next;
      return next;
    },
    emitTriggersRefresh: async () => {
      refreshes += 1;
    },
    agentExists: () => true,
  };
  return deps;
}

function fakeTrigger(overrides: Partial<Trigger> & { name: string }): Trigger {
  return {
    id: "trg_1",
    topic: PAGE_COMMENT_CREATED_TOPIC,
    message: "message",
    session: "main",
    enabled: true,
    cooldownMs: 30_000,
    fireCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function inbox(payload: Record<string, unknown>): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_1",
    sequence: 1,
    dedupeKey: "page-comment:item_1",
    eventType: "page.comment.created",
    category: "pages",
    severity: "info",
    sensitivity: "private",
    title: "Comment",
    summary: "A comment",
    organization: { id: "org_1" },
    project: { id: "proj_1" },
    source: { type: "console" },
    actor: { type: "user", id: "user_1" },
    target: { type: "page", id: PAGE_ID },
    payload,
    links: [],
    delivery: {
      subscriptionId: "sub_1",
      installationId: "ins_1",
      pollId: "poll_1",
      leaseId: "lease_1",
      localDeliveredAt: "2026-09-26T00:00:00.000Z",
    },
    occurredAt: "2026-09-26T00:00:00.000Z",
    createdAt: "2026-09-26T00:00:00.000Z",
  };
}
