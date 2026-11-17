import { describe, expect, it } from "bun:test";
import {
  classifyVisibleAssistantUtterances,
  coalesceAssistantTextBlocks,
  looksLikeEmptyJoinMash,
  peelPersistedAssistantPrefix,
  resolveVisibleAssistantUtterances,
  splitEmptyJoinedAssistantUtterances,
} from "./assistant-transcript.js";

describe("assistant transcript empty-join mash", () => {
  it("preserves a bridge turn's complete response even when it extends earlier text", () => {
    expect(
      classifyVisibleAssistantUtterances("BRIDGE_TEST_APPROVED", ["BRIDGE_TEST"], { structuredTurn: true }),
    ).toEqual({ utterances: ["BRIDGE_TEST_APPROVED"] });
    expect(classifyVisibleAssistantUtterances("Olá.Olá", ["Olá."], { structuredTurn: true })).toEqual({
      utterances: ["Olá.Olá"],
    });
    expect(classifyVisibleAssistantUtterances("BRIDGE_TEST", ["BRIDGE_TEST"], { structuredTurn: true })).toEqual({
      utterances: ["BRIDGE_TEST"],
    });
    expect(
      classifyVisibleAssistantUtterances("BRIDGE_TEST", [], {
        structuredTurn: true,
        alreadyDeliveredThisTurn: ["BRIDGE_TEST"],
      }),
    ).toEqual({ utterances: [], skipReason: "same_turn_replay" });
  });
  it("detects the live primeiro?Olá empty-join pattern", () => {
    expect(looksLikeEmptyJoinMash("primeiro?Olá")).toBe(true);
    expect(looksLikeEmptyJoinMash("ok.Pong")).toBe(true);
    expect(looksLikeEmptyJoinMash("Olá. A conexão")).toBe(false);
    expect(looksLikeEmptyJoinMash("Hello. World")).toBe(false);
    expect(looksLikeEmptyJoinMash("Part one.\n\nPart two.")).toBe(false);
  });

  it("splits empty-joined utterances and keeps spaced sentences intact", () => {
    expect(splitEmptyJoinedAssistantUtterances("primeiro?Olá")).toEqual(["primeiro?", "Olá"]);
    expect(splitEmptyJoinedAssistantUtterances("Olá. A conexão")).toEqual(["Olá. A conexão"]);
    expect(splitEmptyJoinedAssistantUtterances("Part one.\n\nPart two.")).toEqual(["Part one.\n\nPart two."]);
    expect(
      splitEmptyJoinedAssistantUtterances(
        "A conexão foi restabelecida.Olá. A conexão foi restabelecida.Oi. No que você quer trabalhar?",
      ),
    ).toEqual(["A conexão foi restabelecida.", "Olá. A conexão foi restabelecida.", "Oi. No que você quer trabalhar?"]);
  });

  it("coalesces token-like blocks but keeps empty-joined utterances apart", () => {
    expect(coalesceAssistantTextBlocks(["ola", " mundo"])).toEqual(["ola mundo"]);
    expect(coalesceAssistantTextBlocks(["Hello ", "world"])).toEqual(["Hello world"]);
    expect(coalesceAssistantTextBlocks(["primeiro?", "Olá"])).toEqual(["primeiro?", "Olá"]);
    expect(coalesceAssistantTextBlocks(["primeiro?Olá"])).toEqual(["primeiro?Olá"]);
    expect(coalesceAssistantTextBlocks(["A1_LIVESTR_X", "A2_LIVESTR_X", "A3_LIVESTR_X"])).toEqual([
      "A1_LIVESTR_X",
      "A2_LIVESTR_X",
      "A3_LIVESTR_X",
    ]);
    expect(coalesceAssistantTextBlocks(["A1", "_LIVE", "STR", "_X"])).toEqual(["A1_LIVESTR_X"]);
    expect(splitEmptyJoinedAssistantUtterances("A1_LIVESTR_XA2_LIVESTR_XA3_LIVESTR_X")).toEqual([
      "A1_LIVESTR_XA2_LIVESTR_XA3_LIVESTR_X",
    ]);
  });

  it("peels already-persisted assistant history from a mashed blob", () => {
    expect(peelPersistedAssistantPrefix("primeiro?OláOi. No que você quer trabalhar?", ["primeiro?", "Olá"])).toBe(
      "Oi. No que você quer trabalhar?",
    );
    expect(peelPersistedAssistantPrefix("primeiro?Olá", ["primeiro?", "Olá"])).toBe("");
    expect(peelPersistedAssistantPrefix("primeiro?\n\nOlá\n\nOi.", ["primeiro?", "Olá"])).toBe("Oi.");
    expect(peelPersistedAssistantPrefix("Tô aqui.", ["Tô aqui."])).toBe("Tô aqui.");
    expect(peelPersistedAssistantPrefix("Tô aqui.Olá de novo", ["Tô aqui."])).toBe("Olá de novo");
  });

  it("resolves only the new clean utterance from a live mashed insert", () => {
    const greeting = "Olá. A conexão foi restabelecida.";
    const existing = [greeting, "primeiro?", "Olá", "ok.", "pong"];
    expect(
      resolveVisibleAssistantUtterances(
        `${greeting}${greeting}primeiro?Oláok.pongOi. No que você quer trabalhar?`,
        existing,
      ),
    ).toEqual(["Oi. No que você quer trabalhar?"]);
    expect(resolveVisibleAssistantUtterances("primeiro?Olá", ["primeiro?"])).toEqual(["Olá"]);
    expect(resolveVisibleAssistantUtterances("primeiro?Olá", existing)).toEqual([]);
    expect(resolveVisibleAssistantUtterances("primeiro?", existing)).toEqual(["primeiro?"]);
    expect(resolveVisibleAssistantUtterances("Part one.", [])).toEqual(["Part one."]);
    expect(resolveVisibleAssistantUtterances("Part one.\n\nPart two.", [])).toEqual(["Part one.\n\nPart two."]);
  });

  it("delivers a new-turn exact repeat of an earlier assistant phrase", () => {
    expect(resolveVisibleAssistantUtterances("Tô aqui.", ["Tô aqui."])).toEqual(["Tô aqui."]);
    expect(resolveVisibleAssistantUtterances("Tô aqui.", ["Tô aqui.", "Olá"])).toEqual(["Tô aqui."]);
    expect(classifyVisibleAssistantUtterances("Tô aqui.", ["Tô aqui."])).toEqual({
      utterances: ["Tô aqui."],
    });
  });

  it("keeps mash peel for prefixed history plus new text", () => {
    expect(resolveVisibleAssistantUtterances("Tô aqui.Olá de novo", ["Tô aqui."])).toEqual(["Olá de novo"]);
    expect(classifyVisibleAssistantUtterances("primeiro?Olá", ["primeiro?", "Olá"])).toEqual({
      utterances: [],
      skipReason: "mashed_replay",
    });
  });

  it("suppresses a same-turn replay of an already delivered utterance", () => {
    expect(
      resolveVisibleAssistantUtterances("Tô aqui.", ["Tô aqui."], { alreadyDeliveredThisTurn: ["Tô aqui."] }),
    ).toEqual([]);
    expect(
      classifyVisibleAssistantUtterances("Tô aqui.", ["Tô aqui."], { alreadyDeliveredThisTurn: ["Tô aqui."] }),
    ).toEqual({
      utterances: [],
      skipReason: "same_turn_replay",
    });
  });

  it("does not invent a Flutter-style unmash of a single clean greeting", () => {
    expect(resolveVisibleAssistantUtterances("Oi. No que você quer trabalhar?", [])).toEqual([
      "Oi. No que você quer trabalhar?",
    ]);
  });

  it("keeps initials such as R.M. inside one WhatsApp reply", () => {
    const reply =
      "Não é bug de contagem — é atribuição. O R.M. tem 727 ações em 30 dias.\n\n" +
      "1. **Linkar o R.M.** ao Console.\n\nO que eu recomendo: linkar o R.M. e conferir se o número sobe.";
    expect(looksLikeEmptyJoinMash(reply)).toBe(false);
    expect(splitEmptyJoinedAssistantUtterances(reply)).toEqual([reply]);
    expect(resolveVisibleAssistantUtterances(reply, [])).toEqual([reply]);
    expect(looksLikeEmptyJoinMash("Falei com a equipe da U.S.A.Hoje")).toBe(false);
    expect(looksLikeEmptyJoinMash("(R.M.) confirmou")).toBe(false);
    // A real mash next to initials still splits.
    expect(splitEmptyJoinedAssistantUtterances("O R.M. confirmou.Olá de novo")).toEqual([
      "O R.M. confirmou.",
      "Olá de novo",
    ]);
  });
});
