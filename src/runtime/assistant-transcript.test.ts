import { describe, expect, it } from "bun:test";
import {
  coalesceAssistantTextBlocks,
  looksLikeEmptyJoinMash,
  peelPersistedAssistantPrefix,
  resolveVisibleAssistantUtterances,
  splitEmptyJoinedAssistantUtterances,
} from "./assistant-transcript.js";

describe("assistant transcript empty-join mash", () => {
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
    expect(resolveVisibleAssistantUtterances("primeiro?", existing)).toEqual([]);
    expect(resolveVisibleAssistantUtterances("Part one.", [])).toEqual(["Part one."]);
    expect(resolveVisibleAssistantUtterances("Part one.\n\nPart two.", [])).toEqual(["Part one.\n\nPart two."]);
  });

  it("does not invent a Flutter-style unmash of a single clean greeting", () => {
    expect(resolveVisibleAssistantUtterances("Oi. No que você quer trabalhar?", [])).toEqual([
      "Oi. No que você quer trabalhar?",
    ]);
  });
});
