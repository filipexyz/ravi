import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { InboxNatsPayload } from "../../inbox/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { KnowledgeClient } from "../client.js";
import { getKnowledgeGap, insertKnowledgeGap, updateGap } from "../gaps/store.js";
import { replaceMarkedPages } from "../mirror/store.js";
import type { KnowledgeMirrorSyncResult } from "../mirror/sync.js";
import type { ConsoleMirrorPage, ConsoleProposalView } from "../types.js";
import { handleKnowledgeInboxItem, resetKnowledgeInboxDebounce } from "./handler.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-inbox-");
  resetKnowledgeInboxDebounce();
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const NOW = Date.now();

/** A delivered `knowledge.gap.answered` item exactly as the InboxRunner publishes it. */
function gapAnsweredItem(proposalId: string, delivery: Partial<InboxNatsPayload["delivery"]> = {}): InboxNatsPayload {
  return {
    version: 1,
    eventId: "item_1",
    sequence: 7,
    dedupeKey: `knowledge:gap:${proposalId}:answered`,
    eventType: "knowledge.gap.answered",
    category: "knowledge",
    severity: "success",
    sensitivity: "metadata",
    title: "Knowledge gap answered",
    summary: null,
    organization: { id: "org_1" },
    project: { id: "proj-1" },
    source: { type: "knowledge_proposal", id: proposalId },
    actor: { type: "system", id: null },
    target: { type: "local_installation", id: "inst_1" },
    payload: { proposalId, projectId: "proj-1" },
    links: [
      { label: "card", url: `https://console.ravi.bot/k/${proposalId}` },
      { label: "faq", url: "https://acme.ravi.page/faq" },
    ],
    delivery: {
      subscriptionId: "sub_1",
      installationId: "inst_1",
      pollId: "poll_1",
      leaseId: null,
      localDeliveredAt: new Date(NOW).toISOString(),
      ...delivery,
    },
    occurredAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
  };
}

function marksChangedItem(): InboxNatsPayload {
  return {
    ...gapAnsweredItem("unused"),
    eventType: "knowledge.marks.changed",
    dedupeKey: "knowledge:marks:route-1:1",
    payload: { routeId: "route-1", action: "mark" },
    target: { type: "organization", id: "org_1" },
  };
}

function proposal(id: string): ConsoleProposalView {
  return {
    id,
    kind: "gap",
    status: "approved",
    projectId: "proj-1",
    title: null,
    body: "Vocês dão desconto pra ONG?",
    answer: "Sim, 10% para ONGs cadastradas.",
    faq: { url: "https://acme.ravi.page/faq", anchor: "desconto-ong" },
    waitingCount: 2,
    cardUrl: `https://console.ravi.bot/k/${id}`,
    createdAt: "2026-10-16T10:00:00Z",
    expiresAt: "2026-11-16T10:00:00Z",
    decidedAt: "2026-10-17T10:00:00Z",
  };
}

function client(requested: string[]): KnowledgeClient {
  return {
    async getProposal(id: string) {
      requested.push(id);
      return { proposal: proposal(id) };
    },
  } as unknown as KnowledgeClient;
}

function faqPage(instances: string[]): ConsoleMirrorPage {
  return {
    routeId: "route-faq",
    url: "https://acme.ravi.page/faq",
    host: "acme.ravi.page",
    path: "/faq",
    title: "Perguntas frequentes",
    documentId: "doc-faq",
    version: 1,
    approvedAt: null,
    instances,
    sections: [],
  };
}

function uploadedGap(instanceId: string, chatId: string, contactId: string, question = "Vocês dão desconto pra ONG?") {
  const { gap } = insertKnowledgeGap({
    agentId: "atendimento",
    instanceId,
    channel: "whatsapp",
    accountId: instanceId,
    chatId,
    contactId,
    sessionName: `s-${contactId}`,
    question,
  });
  updateGap(gap.id, { status: "uploaded", proposalId: "prop-1", uploadedAt: NOW });
  return gap;
}

describe("knowledge.gap.answered", () => {
  it("reads the nested proposal id, syncs first, then sends one PT-BR answer per claimed gap", async () => {
    const longQuestion = `Vocês dão desconto pra ONG? ${"x".repeat(250)}`;
    const a = uploadedGap("wa-main", "5511900000001@s.whatsapp.net", "contact-a", longQuestion);
    const b = uploadedGap("wa-main", "5511900000002@s.whatsapp.net", "contact-b");
    const other = uploadedGap("wa-vendas", "5511900000003@s.whatsapp.net", "contact-c");
    const events: string[] = [];
    const requested: string[] = [];
    const sent: Array<{ channel: string; accountId: string; to: string; text: string }> = [];

    await handleKnowledgeInboxItem(gapAnsweredItem("prop-1"), {
      client: client(requested),
      sync: async (): Promise<KnowledgeMirrorSyncResult> => {
        events.push("sync");
        expect(getKnowledgeGap(a.id)?.status).toBe("answered");
        replaceMarkedPages({ pages: [faqPage(["wa-main"])], raviHosts: ["acme.ravi.page"] }, NOW);
        return { pages: 1, gapsUploaded: 0, issues: [], ok: true };
      },
      deliver: async (payload) => {
        events.push("send");
        sent.push(payload);
      },
    });

    expect(requested).toEqual(["prop-1"]);
    expect(events).toEqual(["sync", "send", "send"]);
    const truncated = [...longQuestion].slice(0, 199).join("");
    expect(sent).toEqual([
      {
        channel: "whatsapp",
        accountId: "wa-main",
        to: "5511900000001@s.whatsapp.net",
        text: `Oi! Sobre a sua pergunta "${truncated}…": Sim, 10% para ONGs cadastradas.\nMais detalhes: https://acme.ravi.page/faq#desconto-ong`,
      },
      {
        channel: "whatsapp",
        accountId: "wa-main",
        to: "5511900000002@s.whatsapp.net",
        text: 'Oi! Sobre a sua pergunta "Vocês dão desconto pra ONG?": Sim, 10% para ONGs cadastradas.\nMais detalhes: https://acme.ravi.page/faq#desconto-ong',
      },
    ]);
    expect(getKnowledgeGap(a.id)?.status).toBe("notified");
    expect(getKnowledgeGap(b.id)?.status).toBe("notified");
    // The other instance's mirror lacks the /faq URL: it waits for mirror sync step 4.
    expect(getKnowledgeGap(other.id)?.status).toBe("answered");
  });

  it("sends nothing and leaves the gaps answered when the sync fails", async () => {
    const a = uploadedGap("wa-main", "5511900000001@s.whatsapp.net", "contact-a");
    replaceMarkedPages({ pages: [faqPage(["wa-main"])], raviHosts: [] }, NOW);
    const sent: unknown[] = [];
    await handleKnowledgeInboxItem(gapAnsweredItem("prop-1"), {
      client: client([]),
      sync: async () => ({ pages: 0, gapsUploaded: 0, issues: ["console_unavailable: SERVER_UNAVAILABLE"], ok: false }),
      deliver: async (payload) => {
        sent.push(payload);
      },
    });
    expect(sent).toEqual([]);
    expect(getKnowledgeGap(a.id)?.status).toBe("answered");
  });

  it("sends nothing for a replayed item", async () => {
    uploadedGap("wa-main", "5511900000001@s.whatsapp.net", "contact-a");
    const sent: unknown[] = [];
    const deps = {
      client: client([]),
      sync: async (): Promise<KnowledgeMirrorSyncResult> => {
        replaceMarkedPages({ pages: [faqPage(["wa-main"])], raviHosts: [] }, NOW);
        return { pages: 1, gapsUploaded: 0, issues: [], ok: true };
      },
      deliver: async (payload: unknown) => {
        sent.push(payload);
      },
    };
    await handleKnowledgeInboxItem(gapAnsweredItem("prop-1"), deps);
    await handleKnowledgeInboxItem(gapAnsweredItem("prop-1", { replayed: true, replayCount: 1 }), deps);
    expect(sent).toHaveLength(1);
  });
});

describe("knowledge.marks.changed", () => {
  it("two events within a minute give one sync", async () => {
    let syncs = 0;
    let now = NOW;
    const deps = {
      sync: async (): Promise<KnowledgeMirrorSyncResult> => {
        syncs += 1;
        return { pages: 0, gapsUploaded: 0, issues: [], ok: true };
      },
      now: () => now,
      schedule: () => ({ cancel: () => {} }),
    };
    await handleKnowledgeInboxItem(marksChangedItem(), deps);
    now += 30_000;
    await handleKnowledgeInboxItem(marksChangedItem(), deps);
    expect(syncs).toBe(1);
    now += 31_000;
    await handleKnowledgeInboxItem(marksChangedItem(), deps);
    expect(syncs).toBe(2);
  });

  it("arms one trailing sync for events inside the window", async () => {
    let syncs = 0;
    let now = NOW;
    const armed: Array<{ run: () => void; delayMs: number }> = [];
    const deps = {
      sync: async (): Promise<KnowledgeMirrorSyncResult> => {
        syncs += 1;
        return { pages: 0, gapsUploaded: 0, issues: [], ok: true };
      },
      now: () => now,
      schedule: (run: () => void, delayMs: number) => {
        armed.push({ run, delayMs });
        return { cancel: () => {} };
      },
    };
    await handleKnowledgeInboxItem(marksChangedItem(), deps);
    now += 20_000;
    await handleKnowledgeInboxItem(marksChangedItem(), deps);
    now += 10_000;
    await handleKnowledgeInboxItem(marksChangedItem(), deps);
    expect(syncs).toBe(1);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.delayMs).toBe(40_000);

    now += 30_000;
    armed[0]?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncs).toBe(2);
  });
});
