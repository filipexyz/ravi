import { describe, expect, it } from "bun:test";
import { capabilityItemKey, mergeAgentDefaultsPatch, rebaseAgentDefaultsObject } from "./agent-defaults-patch.js";

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

  it("keeps two first grants made from a snapshot without a capability list (Devin #1059)", () => {
    const gh = { permission: "execute", objectType: "executable", objectId: "gh" };
    const jq = { permission: "execute", objectType: "executable", objectId: "jq" };
    const base = { runtimePermissions: { profile: "explicit-only" } };
    const current = { runtimePermissions: { profile: "explicit-only", capabilities: [gh] } };
    const next = { runtimePermissions: { profile: "explicit-only", capabilities: [jq] } };
    expect(rebaseAgentDefaultsObject(current, base, next)).toEqual({
      runtimePermissions: { profile: "explicit-only", capabilities: [gh, jq] },
    });
  });

  it("keeps two first runtimePermissions writes made from a snapshot without the key", () => {
    const gh = { permission: "execute", objectType: "executable", objectId: "gh" };
    const jq = { permission: "execute", objectType: "executable", objectId: "jq" };
    const current = { tts_voice: "x", runtimePermissions: { profile: "explicit-only", capabilities: [gh] } };
    const next = { tts_voice: "x", runtimePermissions: { profile: "explicit-only", capabilities: [jq] } };
    expect(rebaseAgentDefaultsObject(current, { tts_voice: "x" }, next)).toEqual({
      tts_voice: "x",
      runtimePermissions: { profile: "explicit-only", capabilities: [gh, jq] },
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

  it("a revocation applies when another writer re-wrote the capability list as objects (review B1 of #1059)", () => {
    const base = { runtimePermissions: { profile: "explicit-only", capabilities: ["use:tool:Bash", "view:agent:*"] } };
    const next = { runtimePermissions: { profile: "explicit-only", capabilities: ["view:agent:*"] } };
    const current = {
      runtimePermissions: {
        profile: "explicit-only",
        capabilities: [
          { permission: "use", objectType: "tool", objectId: "Bash" },
          { permission: "view", objectType: "agent", objectId: "*" },
          { permission: "view", objectType: "agent", objectId: "other" },
        ],
      },
    };
    const merged = rebaseAgentDefaultsObject(current, base, next) as {
      runtimePermissions: { capabilities: unknown[] };
    };
    const keys = merged.runtimePermissions.capabilities.map(capabilityItemKey);
    expect(keys).not.toContain("cap:use:tool:Bash");
    expect(keys.sort()).toEqual(["cap:view:agent:*", "cap:view:agent:other"]);
  });

  it("a revocation applies when the reader saw objects and the stored list is strings", () => {
    const bash = { permission: "use", objectType: "tool", objectId: "Bash" };
    const view = { permission: "view", objectType: "agent", objectId: "*" };
    const base = { runtimePermissions: { profile: "explicit-only", capabilities: [bash, view] } };
    const next = { runtimePermissions: { profile: "explicit-only", capabilities: [view] } };
    const current = {
      runtimePermissions: { profile: "explicit-only", capabilities: ["use:tool:Bash", "view:agent:*", "use:skill:x"] },
    };
    const merged = rebaseAgentDefaultsObject(current, base, next) as {
      runtimePermissions: { capabilities: unknown[] };
    };
    expect(merged.runtimePermissions.capabilities.map(capabilityItemKey).sort()).toEqual([
      "cap:use:skill:x",
      "cap:view:agent:*",
    ]);
  });

  it("the same capability granted in two formats lands once (review N2 of #1059)", () => {
    const base = { runtimePermissions: { profile: "explicit-only", capabilities: [] as unknown[] } };
    const current = { runtimePermissions: { profile: "explicit-only", capabilities: ["execute:executable:gh"] } };
    const next = {
      runtimePermissions: {
        profile: "explicit-only",
        capabilities: [{ permission: "execute", objectType: "executable", objectId: "gh" }],
      },
    };
    const merged = rebaseAgentDefaultsObject(current, base, next) as {
      runtimePermissions: { capabilities: unknown[] };
    };
    expect(merged.runtimePermissions.capabilities).toEqual(["execute:executable:gh"]);
  });

  it("a pure reorder stands when nobody else wrote (review N1 of #1059)", () => {
    expect(rebaseAgentDefaultsObject({ order: ["a", "b"] }, { order: ["a", "b"] }, { order: ["b", "a"] })).toEqual({
      order: ["b", "a"],
    });
  });

  it("capabilityItemKey treats string and object forms as the same capability", () => {
    expect(capabilityItemKey("view:agent:team:alpha")).toBe(
      capabilityItemKey({ permission: "view", objectType: "agent", objectId: "team:alpha" }),
    );
    expect(capabilityItemKey("not-a-capability")).toBe(JSON.stringify("not-a-capability"));
  });
});
