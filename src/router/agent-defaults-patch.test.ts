import { describe, expect, it } from "bun:test";
import { mergeAgentDefaultsPatch, rebaseAgentDefaultsObject } from "./agent-defaults-patch.js";

const FULL_ACCESS = {
  profile: "full-access",
  capabilities: [{ permission: "view", objectType: "agent", objectId: "*" }],
};

describe("mergeAgentDefaultsPatch (agents set <id> defaults)", () => {
  it("keeps runtimePermissions and unrelated keys when the patch only carries TTS keys (27/11 overlay write)", () => {
    const current = { runtimePermissions: FULL_ACCESS, stickers: { enabled: true }, tts_voice: "old" };
    const patch = { tts_provider: "elevenlabs", tts_voice: "new", tts_model: "eleven_multilingual_v2" };

    const merged = mergeAgentDefaultsPatch("main", current, patch);

    expect(merged.runtimePermissions).toEqual(FULL_ACCESS);
    expect(merged.stickers).toEqual({ enabled: true });
    expect(merged.tts_voice).toBe("new");
    expect(merged.tts_provider).toBe("elevenlabs");
    expect(merged.tts_model).toBe("eleven_multilingual_v2");
  });

  it("removes a key when the patch value is null", () => {
    const merged = mergeAgentDefaultsPatch("main", { tts_voice: "x", tts_lang: "pt-br" }, { tts_voice: null });
    expect(Object.hasOwn(merged, "tts_voice")).toBe(false);
    expect(merged.tts_lang).toBe("pt-br");
  });

  it("does not mutate the current object", () => {
    const current = { tts_voice: "x" };
    mergeAgentDefaultsPatch("main", current, { tts_voice: "y" });
    expect(current.tts_voice).toBe("x");
  });

  it("refuses a patch that changes runtimePermissions", () => {
    expect(() =>
      mergeAgentDefaultsPatch("main", { runtimePermissions: FULL_ACCESS }, { runtimePermissions: { profile: "none" } }),
    ).toThrow(/agents permissions main/);
  });

  it("refuses a patch that removes runtimePermissions with null", () => {
    expect(() =>
      mergeAgentDefaultsPatch("main", { runtimePermissions: FULL_ACCESS }, { runtimePermissions: null }),
    ).toThrow(/cannot change runtimePermissions/);
  });

  it("refuses a patch that adds runtimePermissions where none existed", () => {
    expect(() => mergeAgentDefaultsPatch("other", {}, { runtimePermissions: FULL_ACCESS })).toThrow(
      /cannot change runtimePermissions/,
    );
  });

  it("accepts an identical runtimePermissions value (round-trip of a full read) as a no-op", () => {
    const current = { runtimePermissions: FULL_ACCESS, tts_voice: "x" };
    const reordered = { capabilities: FULL_ACCESS.capabilities, profile: "full-access" };
    const merged = mergeAgentDefaultsPatch("main", current, { runtimePermissions: reordered, tts_voice: "y" });
    expect(merged.runtimePermissions).toEqual(FULL_ACCESS);
    expect(merged.tts_voice).toBe("y");
  });

  it("starts from an empty object when the agent has no defaults", () => {
    expect(mergeAgentDefaultsPatch("main", null, { tts_voice: "y" })).toEqual({ tts_voice: "y" });
  });
});

describe("rebaseAgentDefaultsObject (deep three-way merge)", () => {
  it("keeps two writers' changes to different entries of the same top-level key", () => {
    const base = { modelBroker: { brokerId: "a", profileRef: "p1" } };
    const current = { modelBroker: { brokerId: "a", profileRef: "p1", required: true } };
    const next = { modelBroker: { brokerId: "b", profileRef: "p1" } };
    expect(rebaseAgentDefaultsObject(current, base, next)).toEqual({
      modelBroker: { brokerId: "b", profileRef: "p1", required: true },
    });
  });

  it("keeps two capabilities granted concurrently (arrays merge as sets)", () => {
    const git = { permission: "execute", objectType: "executable", objectId: "git" };
    const gh = { permission: "execute", objectType: "executable", objectId: "gh" };
    const jq = { permission: "execute", objectType: "executable", objectId: "jq" };
    const base = { runtimePermissions: { profile: "explicit-only", capabilities: [git] } };
    const current = { runtimePermissions: { profile: "explicit-only", capabilities: [git, gh] } };
    const next = { runtimePermissions: { profile: "explicit-only", capabilities: [git, jq] } };
    expect(rebaseAgentDefaultsObject(current, base, next)).toEqual({
      runtimePermissions: { profile: "explicit-only", capabilities: [git, gh, jq] },
    });
  });

  it("drops an element the writer removed and keeps one another writer added", () => {
    const base = { tags: ["a", "b"] };
    const current = { tags: ["a", "b", "c"] };
    const next = { tags: ["a"] };
    expect(rebaseAgentDefaultsObject(current, base, next)).toEqual({ tags: ["a", "c"] });
  });

  it("leaves the stored row alone when the writer changed nothing", () => {
    const current = { tts_voice: "y", stickers: { enabled: true } };
    expect(rebaseAgentDefaultsObject(current, { tts_voice: "x" }, { tts_voice: "x" })).toEqual(current);
  });

  it("removes a top-level key the writer removed and returns null when nothing is left", () => {
    expect(
      rebaseAgentDefaultsObject({ modelBroker: { brokerId: "b" } }, { modelBroker: { brokerId: "b" } }, null),
    ).toBe(null);
  });

  it("a leaf change wins over the stored value", () => {
    expect(rebaseAgentDefaultsObject({ tts_voice: "y" }, { tts_voice: "x" }, { tts_voice: "z" })).toEqual({
      tts_voice: "z",
    });
  });
});
