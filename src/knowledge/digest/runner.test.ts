import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { KnowledgeClient } from "../client.js";
import type { ConsoleDigest } from "../types.js";
import { buildMorningDigestText, localClock, runMorningDigestTick } from "./runner.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-digest-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const SAMPLE: ConsoleDigest = {
  generatedAt: "2026-10-17T11:00:00Z",
  unanswered: [
    {
      id: "prop-1",
      question: "desconto pra ONG?",
      waitingCount: 2,
      cardUrl: "https://console.ravi.bot/k/prop-1",
      createdAt: "2026-10-16T10:00:00Z",
      project: { id: "p", slug: "acme", name: "Acme" },
    },
    {
      id: "prop-2",
      question: "Vocês entregam\nem Campinas?",
      waitingCount: 1,
      cardUrl: "https://console.ravi.bot/k/prop-2",
      createdAt: "2026-10-16T11:00:00Z",
      project: null,
    },
    {
      id: "prop-3",
      question: "Tem nota fiscal?",
      waitingCount: 1,
      cardUrl: "https://console.ravi.bot/k/prop-3",
      createdAt: "2026-10-16T12:00:00Z",
      project: null,
    },
  ],
  pending: { notes: 0, corrections: 0, transcripts: 0 },
  suspendedMarks: [
    {
      routeId: "route-1",
      url: "https://acme.ravi.page/politica",
      reason: "new_version",
      cardUrl: "https://console.ravi.bot/k/routes/route-1",
    },
  ],
};

const EMPTY: ConsoleDigest = {
  generatedAt: "2026-10-17T11:00:00Z",
  unanswered: [],
  pending: { notes: 0, corrections: 0, transcripts: 0 },
  suspendedMarks: [],
};

describe("buildMorningDigestText", () => {
  it("writes the exact PT-BR text for a sample digest", () => {
    expect(buildMorningDigestText({ digest: SAMPLE, learned: { items: 12, subjects: 5 }, issues: [] })).toBe(
      [
        "Bom dia! Knowledge de hoje:",
        "• 3 perguntas sem resposta",
        '  1. "desconto pra ONG?" (2 esperando) → https://console.ravi.bot/k/prop-1',
        '  2. "Vocês entregam em Campinas?" → https://console.ravi.bot/k/prop-2',
        '  3. "Tem nota fiscal?" → https://console.ravi.bot/k/prop-3',
        "• 12 coisas aprendidas sobre 5 contatos",
        "• 1 página marcada precisa de nova aprovação → https://console.ravi.bot/k/routes/route-1",
      ].join("\n"),
    );
  });

  it("omits zero lines and uses the singular", () => {
    expect(
      buildMorningDigestText({ digest: null, learned: { items: 1, subjects: 1 }, issues: ["console_not_logged_in"] }),
    ).toBe(
      [
        "Bom dia! Knowledge de hoje:",
        "• 1 coisa aprendida sobre 1 contato",
        "(Console indisponível: só as contagens locais)",
      ].join("\n"),
    );
  });

  it("returns null when everything is zero", () => {
    expect(buildMorningDigestText({ digest: EMPTY, learned: { items: 0, subjects: 0 }, issues: [] })).toBeNull();
    expect(buildMorningDigestText({ digest: null, learned: { items: 0, subjects: 0 }, issues: ["x"] })).toBeNull();
  });
});

describe("runMorningDigestTick", () => {
  const owner = {
    channel: "whatsapp",
    accountId: "wa-main",
    to: "5511999990000@s.whatsapp.net",
    chatId: "c",
    contactId: "luis",
  };
  const settings = () => ({ digestTime: "08:00", digestTimezone: "America/Sao_Paulo" });
  // 2026-10-17 08:30 in São Paulo (UTC-3).
  const MORNING = Date.UTC(2026, 9, 17, 11, 30);

  function deps(sent: Array<{ to: string; text: string }>, now: number, digest: ConsoleDigest = SAMPLE) {
    return {
      now,
      settings,
      owner: () => owner,
      countLearned: () => ({ items: 12, subjects: 5 }),
      client: { digest: async () => digest } as unknown as KnowledgeClient,
      deliver: async (payload: { channel: string; accountId: string; to: string; text: string }) => {
        sent.push(payload);
      },
    };
  }

  it("sends once per local day, to the owner, at or after the configured time", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    expect(await runMorningDigestTick(deps(sent, Date.UTC(2026, 9, 17, 10, 59)))).toBe("not_due");
    expect(await runMorningDigestTick(deps(sent, MORNING))).toBe("sent");
    expect(await runMorningDigestTick(deps(sent, MORNING + 3 * 60 * 60_000))).toBe("already_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "whatsapp", accountId: "wa-main", to: owner.to });
    expect(await runMorningDigestTick(deps(sent, MORNING + 24 * 60 * 60_000))).toBe("sent");
    expect(sent).toHaveLength(2);
  });

  it("marks nothing sent when the Console digest fails, so the next tick retries", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const failing = {
      ...deps(sent, MORNING),
      client: {
        digest: async () => {
          throw Object.assign(new Error("down"), { code: "CONSOLE_UNAVAILABLE" });
        },
      } as unknown as KnowledgeClient,
    };
    expect(await runMorningDigestTick(failing)).toBe("failed");
    expect(sent).toEqual([]);
    expect(await runMorningDigestTick(deps(sent, MORNING + 60_000))).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when everything is zero or there is no owner", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    expect(await runMorningDigestTick({ ...deps(sent, MORNING), owner: () => null })).toBe("no_owner");
    expect(
      await runMorningDigestTick({ ...deps(sent, MORNING, EMPTY), countLearned: () => ({ items: 0, subjects: 0 }) }),
    ).toBe("nothing");
    expect(sent).toEqual([]);
  });

  it("computes the local date and time in the zone", () => {
    expect(localClock(MORNING, "America/Sao_Paulo")).toEqual({ date: "2026-10-17", minutes: 8 * 60 + 30 });
    expect(localClock(Date.UTC(2026, 9, 17, 1, 0), "America/Sao_Paulo")).toEqual({
      date: "2026-10-16",
      minutes: 22 * 60,
    });
  });
});
