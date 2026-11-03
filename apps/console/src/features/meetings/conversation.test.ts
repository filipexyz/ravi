import { describe, expect, test } from "bun:test";

import {
  buildConversation,
  conversationSource,
  conversationText,
  emptyTranscriptCopy,
  findLinks,
  foldForSearch,
  isSearchable,
  itemAt,
  itemForMoment,
  lineAt,
  locate,
  parseMoment,
  recordingFromStored,
  recordingNeedsStored,
  recordingShowsSkeleton,
  searchConversation,
  textRuns,
} from "./conversation";
import type { Meeting, MeetingRecording, StoredTranscript, TranscriptSegment } from "./types";

function segment(
  speaker: string | null,
  speakerId: string | null,
  startSeconds: number | null,
  endSeconds: number | null,
  text: string,
  startedAt: string | null = null,
): TranscriptSegment {
  return { speaker, speakerId, isHost: null, startSeconds, endSeconds, startedAt, text };
}

function recording(input: Partial<Omit<MeetingRecording, "meeting">> & { recordingSeconds?: number | null } = {}): MeetingRecording {
  return {
    meeting: { recordingSeconds: input.recordingSeconds ?? null } as MeetingRecording["meeting"],
    transcript: input.transcript ?? { status: "done", segments: [] },
    participants: input.participants ?? [],
    chat: input.chat ?? [],
    media: input.media ?? [],
    recordings: input.recordings ?? [{ startedAt: null, completedAt: null, expiresAt: null }],
  };
}

const ana = (start: number, end: number, text: string) => segment("Ana", "1", start, end, text);
const bruno = (start: number, end: number, text: string) => segment("Bruno", "2", start, end, text);

describe("meeting conversation", () => {
  test("consecutive lines from one speaker read as one turn, a chat message splits it", () => {
    const conversation = buildConversation(
      recording({
        transcript: { status: "done", segments: [ana(0, 2, "Oi"), ana(2, 4, "tudo bem?"), bruno(5, 6, " Tudo. "), ana(9, 10, ""), ana(11, 14, "Vamos lá")] },
        chat: [
          { sender: "Bruno", senderId: "2", atSeconds: 8, sentAt: null, to: "everyone", text: "link aqui" },
          { sender: "Bruno", senderId: "2", atSeconds: 20, sentAt: null, to: "only_bot", text: "não grava isso" },
        ],
      }),
    );
    expect(conversation.items.slice(0, 4).map((item) => (item.kind === "turn" ? item.lines.map((line) => line.text).join(" ") : `chat: ${item.text}`))).toEqual([
      "Oi tudo bem?",
      "Tudo.",
      "chat: link aqui",
      "Vamos lá",
    ]);
    expect(conversation.lines.map((line) => line.turnId)).toEqual(["t0", "t0", "t1", "t3"]);
    expect(conversationText(conversation)).toBe(
      "[00:00] Ana: Oi tudo bem?\n\n[00:05] Bruno: Tudo.\n\n[00:08] Bruno (chat): link aqui\n\n[00:11] Ana: Vamos lá\n\n[00:20] Bruno (private message): não grava isso",
    );
  });

  test("two people with the same name stay apart", () => {
    const conversation = buildConversation(
      recording({ transcript: { status: "done", segments: [segment("Ana", "1", 0, 1, "Oi"), segment("Ana", "2", 4, 5, "Oi, Ana")] } }),
    );
    expect(conversation.items).toHaveLength(2);
    expect(conversation.speakers).toHaveLength(2);
  });

  test("talk time ranks people and gives speakers colors; silent people get none", () => {
    const conversation = buildConversation(
      recording({
        participants: [
          { id: "1", name: "Ana", isHost: true },
          { id: "2", name: "Bruno", isHost: false },
          { id: "3", name: "Carla", isHost: false },
        ],
        transcript: { status: "done", segments: [ana(0, 10, "a"), bruno(10, 40, "b")] },
        chat: [{ sender: "Carla", senderId: "3", atSeconds: 20, sentAt: null, to: "everyone", text: "oi" }],
      }),
    );
    expect(conversation.speakers.map((speaker) => [speaker.name, speaker.tone, Math.round(speaker.share * 100), speaker.chatCount])).toEqual([
      ["Bruno", 0, 75, 0],
      ["Ana", 1, 25, 0],
      ["Carla", null, 0, 1],
    ]);
    expect(conversation.speakerByKey.get("id:1")?.isHost).toBe(true);
  });

  test("the call's length is the longest of the file, the transcript and the chat", () => {
    expect(buildConversation(recording({ recordingSeconds: 600, transcript: { status: "done", segments: [ana(0, 30, "a")] } })).duration).toBe(600);
    expect(buildConversation(recording({ transcript: { status: "done", segments: [ana(0, 30, "a")] } })).duration).toBe(30);
  });

  test("a recording in parts is placed on one clock by absolute time", () => {
    const conversation = buildConversation(
      recording({
        recordings: [
          { startedAt: "2026-10-13T12:00:00Z", completedAt: "2026-10-13T12:10:00Z", expiresAt: null },
          { startedAt: "2026-10-13T12:20:00Z", completedAt: "2026-10-13T12:25:00Z", expiresAt: null },
        ],
        transcript: {
          status: "done",
          segments: [
            segment("Ana", "1", 30, 35, "primeira parte", "2026-10-13T12:00:30Z"),
            segment("Ana", "1", 5, 8, "segunda parte", "2026-10-13T12:20:05Z"),
          ],
        },
      }),
    );
    expect(conversation.seekable).toBe(true);
    expect(conversation.parts.map((part) => [part.offset, part.duration])).toEqual([
      [0, 600],
      [1200, 300],
    ]);
    expect(conversation.lines.map((line) => [line.start, line.end])).toEqual([
      [30, 35],
      [1205, 1208],
    ]);
    expect(conversation.duration).toBe(1500);
    expect(locate(conversation.parts, 1205)).toEqual({ part: 1, local: 5 });
    expect(locate(conversation.parts, 30)).toEqual({ part: 0, local: 30 });
  });

  test("parts without start times run end to end, in the order the API lists them", () => {
    const conversation = buildConversation(
      recording({
        recordings: [
          { startedAt: null, completedAt: null, expiresAt: null },
          { startedAt: null, completedAt: null, expiresAt: null },
        ],
        transcript: {
          status: "done",
          segments: [ana(0, 3, "Parte um, começo."), bruno(10, 14, "Parte um, resposta."), ana(4, 6, "Parte dois, começo."), bruno(12, 15, "Parte dois, resposta.")],
        },
        chat: [
          { sender: "Ana", senderId: "1", atSeconds: 11, sentAt: null, to: "everyone", text: "chat um" },
          { sender: "Ana", senderId: "1", atSeconds: 5, sentAt: null, to: "everyone", text: "chat dois" },
        ],
      }),
    );
    expect(conversation.seekable).toBe(false);
    expect(conversation.parts.map((part) => part.offset)).toEqual([0, 14]);
    expect(conversationText(conversation)).toBe(
      [
        "[00:00] Ana: Parte um, começo.",
        "[00:10] Bruno: Parte um, resposta.",
        "[00:11] Ana (chat): chat um",
        "[00:18] Ana: Parte dois, começo.",
        "[00:19] Ana (chat): chat dois",
        "[00:26] Bruno: Parte dois, resposta.",
      ].join("\n\n"),
    );
    expect(locate(conversation.parts, 5)).toEqual({ part: 0, local: 5 });
    expect(locate(conversation.parts, 20)).toEqual({ part: 1, local: 6 });
  });

  test("a line without an absolute time is placed by its part, and then nothing seeks", () => {
    const conversation = buildConversation(
      recording({
        recordings: [
          { startedAt: "2026-10-13T12:00:00Z", completedAt: "2026-10-13T12:10:00Z", expiresAt: null },
          { startedAt: "2026-10-13T12:20:00Z", completedAt: "2026-10-13T12:25:00Z", expiresAt: null },
        ],
        transcript: { status: "done", segments: [segment("Ana", "1", 30, 35, "um", "2026-10-13T12:00:30Z"), ana(5, 8, "dois sem hora")] },
      }),
    );
    expect(conversation.seekable).toBe(false);
    expect(conversation.lines.map((line) => line.start)).toEqual([30, 1205]);
  });

  test("what is being said at a moment, and where to scroll for it", () => {
    const conversation = buildConversation(recording({ transcript: { status: "done", segments: [ana(2, 4, "a"), bruno(5, 9, "b"), ana(12, 15, "c")] } }));
    expect(lineAt(conversation.lines, 0)).toBeNull();
    expect(lineAt(conversation.lines, 3)?.text).toBe("a");
    expect(lineAt(conversation.lines, 10)?.text).toBe("b");
    expect(lineAt(conversation.lines, 100)?.text).toBe("c");
    expect(itemAt(conversation.items, 6)?.id).toBe("t1");
    expect(itemAt(conversation.items, 0)?.id).toBe("t0");
  });

  test("a line without a start doesn't throw off the line at a moment", () => {
    const segments = Array.from({ length: 40 }, (_, index) =>
      index === 12 ? segment("Ana", "1", null, null, "sem hora") : segment(index % 2 ? "Ana" : "Bruno", index % 2 ? "1" : "2", index * 10, index * 10 + 8, `fala ${index}`),
    );
    const conversation = buildConversation(recording({ transcript: { status: "done", segments } }));
    for (let index = 0; index < 40; index++) {
      if (index === 12) continue;
      expect(lineAt(conversation.lines, index * 10 + 4)?.text).toBe(`fala ${index}`);
    }
  });

  test("search ignores case and accents and points back into the original text", () => {
    expect(foldForSearch("Transcrição").folded).toBe("transcricao");
    const conversation = buildConversation(
      recording({
        transcript: { status: "done", segments: [ana(0, 3, "A transcrição ficou boa. TRANSCRICAO de novo"), bruno(4, 5, "nada")] },
        chat: [{ sender: "Bruno", senderId: "2", atSeconds: 6, sentAt: null, to: null, text: "Transcrição no chat" }],
      }),
    );
    const matches = searchConversation(conversation.items, "transcricao");
    expect(matches.map((match) => [match.pieces, match.time])).toEqual([
      [[{ lineId: "l0", from: 2, to: 13 }], 0],
      [[{ lineId: "l0", from: 25, to: 36 }], 0],
      [[{ lineId: null, from: 0, to: 11 }], 6],
    ]);
    expect(searchConversation(conversation.items, "a")).toEqual([]);
  });

  test("search ranges stay right after emoji, and Hangul isn't split into letters", () => {
    const pieces = (text: string, query: string) => {
      const conversation = buildConversation(
        recording({ chat: [{ sender: "Ana", senderId: "1", atSeconds: 1, sentAt: null, to: null, text }] }),
      );
      return searchConversation(conversation.items, query).map((match) => text.slice(match.pieces[0]!.from, match.pieces[0]!.to));
    };
    expect(pieces("👍 o link do relatório está aqui", "relatorio")).toEqual(["relatório"]);
    expect(pieces("🎉🎉🎉 done done", "done")).toEqual(["done", "done"]);
    expect(pieces("😀😀 ok", "😀")).toEqual(["😀", "😀"]);
    expect(pieces("😀😀 ok", "😀😀")).toEqual(["😀😀"]);
    expect(foldForSearch("한국").folded).toBe("한국");
    expect(pieces("한국 회의, 가한", "가한")).toEqual(["가한"]);
    expect(pieces("한국 회의, 가한", "가하")).toEqual([]);
    // Hangul written as separate jamo still finds, and is found by, the composed syllables.
    expect(pieces("\u1112\u1161\u11AB\u1100\u116E\u11A8 회의", "한국")).toEqual(["\u1112\u1161\u11AB\u1100\u116E\u11A8"]);
  });

  test("one Chinese, Japanese or Korean character is enough to search", () => {
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable(" é ")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
    expect(isSearchable("회")).toBe(true);
    expect(isSearchable("会")).toBe(true);
    expect(isSearchable("か")).toBe(true);
  });

  test("a time past the end of a part of known length starts the next part", () => {
    const conversation = buildConversation(
      recording({
        recordings: [
          { startedAt: "2026-10-01T10:00:00Z", completedAt: "2026-10-01T10:00:10Z", expiresAt: null },
          { startedAt: null, completedAt: null, expiresAt: null },
        ],
        transcript: { status: "done", segments: [ana(0, 2, "Primeira"), bruno(30, 32, "Segunda")] },
      }),
    );
    expect(conversation.lines.map((line) => line.start)).toEqual([0, 40]);
  });

  test("a phrase is found across the lines of one turn", () => {
    const conversation = buildConversation(
      recording({ transcript: { status: "done", segments: [ana(0, 2, "Vamos fechar o"), ana(2, 4, "lançamento hoje")] } }),
    );
    const [match, ...rest] = searchConversation(conversation.items, "o lancamento");
    expect(rest).toEqual([]);
    expect(match).toEqual({
      index: 0,
      itemId: "t0",
      time: 0,
      pieces: [
        { lineId: "l0", from: 13, to: 14 },
        { lineId: "l1", from: 0, to: 10 },
      ],
    });
  });

  test("links in the chat stay whole, with a search match inside them", () => {
    const text = "Planilha: https://docs.example.com/limites (ver aba 2). E https://pt.wikipedia.org/wiki/Ravi_(nome), ok?";
    expect(findLinks(text).map((link) => link.href)).toEqual(["https://docs.example.com/limites", "https://pt.wikipedia.org/wiki/Ravi_(nome)"]);
    expect(findLinks("javascript:alert(1) data:text/html,x http:// https://")).toEqual([]);
    const link = findLinks(text)[0]!;
    const from = text.indexOf("limites");
    expect(textRuns(text, [{ from, to: from + 7, index: 3 }], [link])).toEqual([
      { text: "Planilha: ", match: null, href: null },
      { text: "https://docs.example.com/", match: null, href: link.href },
      { text: "limites", match: 3, href: link.href },
      { text: text.slice(link.to), match: null, href: null },
    ]);
  });

  test("a ?t= moment reads as seconds, a clock or units", () => {
    expect(parseMoment("95")).toBe(95);
    expect(parseMoment("1:35")).toBe(95);
    expect(parseMoment("1:02:09")).toBe(3729);
    expect(parseMoment("105:30")).toBe(6330);
    expect(parseMoment("16.7")).toBe(16.7);
    expect(parseMoment("1m35s")).toBe(95);
    expect(parseMoment("abc")).toBeNull();
    expect(parseMoment("")).toBeNull();
    expect(parseMoment(null)).toBeNull();
  });
});

describe("the transcript Ravi kept", () => {
  const stored: StoredTranscript = {
    segments: [
      { speaker: "Ana", speakerId: "1", t: 0, text: "Bom dia a todos." },
      { speaker: "Ana", speakerId: "1", t: 20, text: "Vamos ao orçamento." },
      { speaker: "Bruno", speakerId: "2", t: 95, text: "O prazo é sexta." },
      { speaker: "Ana", speakerId: "1", t: 130, text: "Combinado." },
    ],
    documentVersion: 1,
    retainUntil: "2027-10-01T00:00:00.000Z",
  };
  const gone = recording({ transcript: { status: "none", segments: [] }, recordings: [] });

  test("conversationSource picks the stored transcript when the recording's is gone", () => {
    expect(conversationSource(gone, stored)).toBe("stored");
    expect(conversationSource(null, stored)).toBe("stored");
    expect(conversationSource(recording({ transcript: { status: "done", segments: [ana(0, 2, "Oi")] } }), stored)).toBe("recording");
    expect(conversationSource(recording({ transcript: { status: "processing", segments: [] } }), stored)).toBe("recording");
    expect(conversationSource(gone, null)).toBe("recording");
    expect(conversationSource(null, { ...stored, segments: [] })).toBe("none");
  });

  test("itemForMoment finds the item for ?t= in the stored segments", () => {
    const conversation = buildConversation(recordingFromStored({ recordingSeconds: 140 } as Meeting, stored));
    expect(conversation.seekable).toBe(true);
    expect(conversation.lines.map((line) => line.start)).toEqual([0, 20, 95, 130]);
    const at = (moment: string) => itemForMoment(conversation.lines, conversation.items, parseMoment(moment)!);
    const bruno = conversation.items.find((item) => item.kind === "turn" && item.speaker === "id:2");
    expect(at("1:40")).toBe(bruno!);
    expect(at("25")).toBe(conversation.items[0]!);
    expect(at("2:15")).toBe(conversation.items.at(-1)!);
  });

  test("a failed background refresh keeps the loaded recording on screen", () => {
    const loaded = recording({ transcript: { status: "done", segments: [ana(0, 2, "Oi")] } });
    // The refresh failed, but the recording that already loaded still has lines: no kept transcript, no skeleton.
    expect(recordingNeedsStored({ data: loaded, isError: true })).toBe(false);
    expect(recordingShowsSkeleton({ recording: { data: loaded, isPending: false }, stored: { data: undefined, isPending: true }, needsStored: false })).toBe(false);
    // Only a first load that fails asks for the kept transcript, and waits for it.
    expect(recordingNeedsStored({ data: undefined, isError: true })).toBe(true);
    expect(recordingShowsSkeleton({ recording: { data: undefined, isPending: false }, stored: { data: undefined, isPending: true }, needsStored: true })).toBe(true);
    expect(recordingShowsSkeleton({ recording: { data: undefined, isPending: false }, stored: { data: stored, isPending: false }, needsStored: true })).toBe(false);
    expect(recordingShowsSkeleton({ recording: { data: undefined, isPending: true }, stored: { data: undefined, isPending: false }, needsStored: false })).toBe(true);
    // A recording with no lines (done, or gone) asks for it; one still being transcribed does not.
    expect(recordingNeedsStored({ data: gone, isError: false })).toBe(true);
    expect(recordingNeedsStored({ data: recording({ transcript: { status: "processing", segments: [] } }), isError: true })).toBe(false);
  });

  test("emptyTranscriptCopy never says nobody spoke when a transcript was kept", () => {
    expect(emptyTranscriptCopy(gone, stored)).toBeNull();
    expect(emptyTranscriptCopy(null, stored)).toBeNull();
    expect(emptyTranscriptCopy(gone, null)?.text).toBe("This call's recording and transcript are no longer available.");
    expect(emptyTranscriptCopy(gone, null)?.text).not.toContain("Nobody spoke");
    expect(emptyTranscriptCopy(recording({ transcript: { status: "done", segments: [] } }), null)?.text).toBe("Nobody spoke in this call.");
    expect(emptyTranscriptCopy(recording({ transcript: { status: "failed", segments: [] } }), null)?.tone).toBe("warn");
    expect(emptyTranscriptCopy(recording({ transcript: { status: "done", segments: [ana(0, 2, "Oi")] } }), null)).toBeNull();
  });
});
