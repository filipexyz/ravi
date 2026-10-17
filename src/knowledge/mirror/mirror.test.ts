import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import type { InstanceConfig } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { KnowledgeClient } from "../client.js";
import { getKnowledgeGap, insertKnowledgeGap, updateGap } from "../gaps/store.js";
import { getKnowledgeDb, setKnowledgeFts5ForcedOff } from "../store/db.js";
import type { ConsoleMirror, ConsoleMirrorPage, ConsoleProposalCreate, ConsoleProposalView } from "../types.js";
import {
  listMarkedSectionsForInstance,
  listMarkedUrlsForInstance,
  listRaviHosts,
  replaceMarkedPages,
} from "./store.js";
import { buildGapAnswerText, syncKnowledgeMirror } from "./sync.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-mirror-");
});

afterEach(async () => {
  setKnowledgeFts5ForcedOff(false);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const NOW = Date.UTC(2026, 9, 17, 12);
const HOUR = 60 * 60_000;

function page(overrides: Partial<ConsoleMirrorPage> = {}): ConsoleMirrorPage {
  return {
    routeId: "route-politica",
    url: "https://acme.ravi.page/politica",
    host: "acme.ravi.page",
    path: "/politica",
    title: "Política",
    documentId: "doc-1",
    version: 3,
    approvedAt: "2026-10-16T10:00:00Z",
    instances: ["wa-main"],
    sections: [
      { stableKey: "h:Trocas", heading: "Trocas", anchor: "trocas", text: "Trocas em até 30 dias com nota fiscal." },
      { stableKey: "h:Frete", heading: "Frete", anchor: "frete", text: "Frete grátis acima de 200 reais." },
    ],
    ...overrides,
  };
}

function mirror(pages: ConsoleMirrorPage[], raviHosts = ["acme.ravi.page", "ajuda.acme.com.br"]): ConsoleMirror {
  return { generatedAt: new Date(NOW).toISOString(), ttlSeconds: 86_400, raviHosts, pages };
}

function instance(name: string, channel = "whatsapp", extra: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name,
    channel,
    dmPolicy: "open",
    groupPolicy: "closed",
    contactIntakeMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as InstanceConfig;
}

function proposalView(overrides: Partial<ConsoleProposalView> = {}): ConsoleProposalView {
  return {
    id: "prop-1",
    kind: "gap",
    status: "approved",
    projectId: "proj-1",
    title: null,
    body: "Vocês dão desconto pra ONG?",
    answer: "Sim, 10% para ONGs cadastradas.",
    faq: { url: "https://acme.ravi.page/faq", anchor: "voces-dao-desconto-pra-ong" },
    waitingCount: 1,
    cardUrl: "https://console.ravi.bot/k/prop-1",
    createdAt: "2026-10-16T10:00:00Z",
    expiresAt: "2026-11-16T10:00:00Z",
    decidedAt: "2026-10-17T10:00:00Z",
    ...overrides,
  };
}

type FakeClientState = {
  mirrorBodies: Array<{ instances: Array<{ id: string; label: string; channel: string }> }>;
  proposals: ConsoleProposalCreate[];
};

function fakeClient(options: {
  mirror?: ConsoleMirror | Error;
  proposal?: ConsoleProposalView;
  state?: FakeClientState;
}): { client: KnowledgeClient; state: FakeClientState } {
  const state = options.state ?? { mirrorBodies: [], proposals: [] };
  const client = {
    consoleUrl: "https://console.ravi.bot",
    orgId: "org_1",
    installationId: "inst_1",
    scopes: [],
    async mirror(body: { instances: Array<{ id: string; label: string; channel: string }> }) {
      state.mirrorBodies.push(body);
      if (options.mirror instanceof Error) throw options.mirror;
      return options.mirror ?? mirror([]);
    },
    async createProposal(body: ConsoleProposalCreate) {
      state.proposals.push(body);
      return { proposal: proposalView({ id: `prop-${state.proposals.length}`, status: "pending" }), deduped: false };
    },
    async getProposal(id: string) {
      return { proposal: options.proposal ?? proposalView({ id }) };
    },
  } as unknown as KnowledgeClient;
  return { client, state };
}

function gap(question = "Vocês dão desconto pra ONG?", instanceId = "wa-main") {
  return insertKnowledgeGap({
    agentId: "atendimento",
    instanceId,
    channel: "whatsapp",
    accountId: instanceId,
    chatId: "5511999990000@s.whatsapp.net",
    contactId: "contact-1",
    sessionName: "atendimento-dm",
    question,
  }).gap;
}

describe("mirror store", () => {
  it("replaceMarkedPages is atomic: a throw mid-way keeps the old rows", () => {
    replaceMarkedPages(mirror([page()]), NOW);
    expect(listMarkedUrlsForInstance("wa-main", NOW)).toEqual([{ host: "acme.ravi.page", path: "/politica" }]);

    const broken = page({ routeId: "route-b", url: null as unknown as string });
    expect(() => replaceMarkedPages(mirror([page({ routeId: "route-a", path: "/a" }), broken]), NOW + 1)).toThrow();

    expect(listMarkedUrlsForInstance("wa-main", NOW)).toEqual([{ host: "acme.ravi.page", path: "/politica" }]);
    expect(listMarkedSectionsForInstance({ instanceId: "wa-main", query: "trocas", limit: 3, now: NOW })).toHaveLength(
      1,
    );
    expect(listRaviHosts(NOW)).toEqual(["acme.ravi.page", "ajuda.acme.com.br"]);
  });

  it("finds sections by instance and hides expired pages and hosts", () => {
    replaceMarkedPages(mirror([page()]), NOW);
    const hits = listMarkedSectionsForInstance({
      instanceId: "wa-main",
      query: "Posso fazer trocas?",
      limit: 3,
      now: NOW,
    });
    expect(hits).toEqual([
      {
        id: expect.any(Number),
        url: "https://acme.ravi.page/politica",
        anchor: "trocas",
        heading: "Trocas",
        text: "Trocas em até 30 dias com nota fiscal.",
        version: 3,
      },
    ]);
    expect(listMarkedSectionsForInstance({ instanceId: "tg-main", query: "trocas", limit: 3, now: NOW })).toEqual([]);

    const later = NOW + 25 * HOUR;
    expect(listMarkedSectionsForInstance({ instanceId: "wa-main", query: "trocas", limit: 3, now: later })).toEqual([]);
    expect(listMarkedUrlsForInstance("wa-main", later)).toEqual([]);
    expect(listRaviHosts(later)).toEqual([]);
  });

  it("works with the LIKE fallback when FTS5 is off", () => {
    setKnowledgeFts5ForcedOff(true);
    replaceMarkedPages(mirror([page()]), NOW);
    const hits = listMarkedSectionsForInstance({ instanceId: "wa-main", query: "frete gratis", limit: 3, now: NOW });
    expect(hits.map((hit) => hit.anchor)).toEqual(["frete"]);
  });
});

describe("syncKnowledgeMirror", () => {
  it("sends instances by name and round-trips raviHosts", async () => {
    const { client, state } = fakeClient({ mirror: mirror([page()]) });
    const result = await syncKnowledgeMirror({
      client,
      now: NOW,
      listInstances: () => [
        instance("wa-main"),
        instance("tg-suporte", "telegram", { instanceId: "8a6f2c1e-uuid" }),
        instance("old", "whatsapp", { enabled: false }),
      ],
      project: () => "acme",
    });
    expect(result).toMatchObject({ pages: 1, gapsUploaded: 0, issues: [], ok: true });
    expect(state.mirrorBodies).toEqual([
      {
        instances: [
          { id: "wa-main", label: "wa-main (whatsapp)", channel: "whatsapp" },
          { id: "tg-suporte", label: "tg-suporte (telegram)", channel: "telegram" },
        ],
      },
    ]);
    expect(listRaviHosts(NOW)).toEqual(["acme.ravi.page", "ajuda.acme.com.br"]);
  });

  it("keeps the current mirror while the Console is unavailable, then drops it after expiry", async () => {
    replaceMarkedPages(mirror([page()]), NOW);
    const down = fakeClient({ mirror: new CloudAuthError("SERVER_UNAVAILABLE", "down") }).client;

    const soon = await syncKnowledgeMirror({
      client: down,
      now: NOW + HOUR,
      listInstances: () => [instance("wa-main")],
    });
    expect(soon.ok).toBe(false);
    expect(soon.issues).toEqual(["console_unavailable: SERVER_UNAVAILABLE"]);
    expect(listMarkedUrlsForInstance("wa-main", NOW + HOUR)).toHaveLength(1);

    const late = NOW + 25 * HOUR;
    await syncKnowledgeMirror({ client: down, now: late, listInstances: () => [instance("wa-main")] });
    expect(getKnowledgeDb().prepare("SELECT COUNT(*) AS n FROM knowledge_marked_pages").get()).toEqual({ n: 0 });
    expect(listRaviHosts(late)).toEqual([]);
  });

  it("uploads pending gaps with the question hash as dedupeKey and gap:<id> as idempotencyKey", async () => {
    const pending = gap();
    const { client, state } = fakeClient({ mirror: mirror([]) });
    const result = await syncKnowledgeMirror({
      client,
      now: NOW,
      listInstances: () => [instance("wa-main")],
      project: () => "acme",
    });
    expect(result.gapsUploaded).toBe(1);
    expect(state.proposals).toEqual([
      {
        kind: "gap",
        project: "acme",
        title: null,
        body: "Vocês dão desconto pra ONG?",
        evidence: [],
        supersedes: null,
        requestedAudience: { kind: "contacts", instanceId: "wa-main", label: "wa-main (whatsapp)" },
        dedupeKey: pending.questionHash,
        idempotencyKey: `gap:${pending.id}`,
      },
    ]);
    expect(getKnowledgeGap(pending.id)).toMatchObject({ status: "uploaded", proposalId: "prop-1", uploadedAt: NOW });
  });

  it("drops a gap with an invalid instance id and one the Console refuses as PAYLOAD_INVALID", async () => {
    const badInstance = gap("Pergunta um?", "wa main/x");
    const refused = gap("Pergunta dois?");
    const { client, state } = fakeClient({ mirror: mirror([]) });
    (client as unknown as { createProposal: () => Promise<never> }).createProposal = async () => {
      state.proposals.push({} as ConsoleProposalCreate);
      throw Object.assign(new Error("bad"), { code: "PAYLOAD_INVALID" });
    };
    const result = await syncKnowledgeMirror({ client, now: NOW, listInstances: () => [], project: () => "acme" });
    expect(state.proposals).toHaveLength(1);
    expect(getKnowledgeGap(badInstance.id)?.status).toBe("dropped");
    expect(getKnowledgeGap(refused.id)?.status).toBe("dropped");
    expect(result.issues).toContain("gap_dropped: instance_id_invalid");
  });

  it("leaves gaps pending without knowledge.project", async () => {
    const pending = gap();
    const { client, state } = fakeClient({ mirror: mirror([]) });
    const result = await syncKnowledgeMirror({ client, now: NOW, listInstances: () => [], project: () => null });
    expect(result.issues).toEqual(["gaps_pending_no_project"]);
    expect(state.proposals).toEqual([]);
    expect(getKnowledgeGap(pending.id)?.status).toBe("pending");
  });

  it("step 4 notifies an answered gap once its /faq URL appears in the mirror", async () => {
    const answered = gap();
    updateGap(answered.id, { status: "answered", proposalId: "prop-1" });
    const sent: Array<Record<string, string>> = [];
    const deliver = async (payload: { channel: string; accountId: string; to: string; text: string }) => {
      sent.push(payload);
    };

    const before = fakeClient({ mirror: mirror([page()]) }).client;
    await syncKnowledgeMirror({ client: before, now: NOW, listInstances: () => [instance("wa-main")], deliver });
    expect(sent).toEqual([]);
    expect(getKnowledgeGap(answered.id)?.status).toBe("answered");

    const faqPage = page({ routeId: "route-faq", url: "https://acme.ravi.page/faq", path: "/faq", sections: [] });
    const after = fakeClient({ mirror: mirror([page(), faqPage]) }).client;
    await syncKnowledgeMirror({ client: after, now: NOW, listInstances: () => [instance("wa-main")], deliver });
    await syncKnowledgeMirror({ client: after, now: NOW, listInstances: () => [instance("wa-main")], deliver });
    expect(sent).toEqual([
      {
        channel: "whatsapp",
        accountId: "wa-main",
        to: "5511999990000@s.whatsapp.net",
        text: 'Oi! Sobre a sua pergunta "Vocês dão desconto pra ONG?": Sim, 10% para ONGs cadastradas.\nMais detalhes: https://acme.ravi.page/faq#voces-dao-desconto-pra-ong',
      },
    ]);
    expect(getKnowledgeGap(answered.id)?.status).toBe("notified");
  });

  it("truncates the question to 200 characters in the answer text", () => {
    const text = buildGapAnswerText({ question: "a".repeat(300), answer: "Sim.", link: "https://x.ravi.page/faq#a" });
    const quoted = text.slice(text.indexOf('"') + 1, text.indexOf('":'));
    expect([...quoted]).toHaveLength(200);
  });
});
