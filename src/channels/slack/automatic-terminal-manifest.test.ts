import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getDb } from "../../router/router-db.js";
import { reserveSlackAutomaticOutput } from "./automatic-output-circuit.js";
import {
  assertSlackAutomaticTerminalPart,
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
  readSlackAutomaticTerminalMediaBytes,
  type SlackAutomaticTerminalManifestInput,
} from "./automatic-terminal-manifest.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("slack-terminal-manifest-");
  writeFileSync(join(stateDir, "a.png"), "original-a-bytes");
  writeFileSync(join(stateDir, "b.png"), "original-b-bytes");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function input(turnId = "turn-1"): SlackAutomaticTerminalManifestInput {
  return {
    turnId,
    sourceId: `source:${turnId}`,
    sourceReceivedAt: 1_000,
    scope: "installation:C123",
    kind: "final_answer",
    target: {
      channel: "slack",
      accountId: "account",
      instanceId: "installation",
      chatId: "C123",
      threadId: "1.000001",
    },
    text: "Complete response",
    media: [
      { type: "image", filePath: join(stateDir!, "a.png"), filename: "a.png", idempotencyKey: "image:a:hash-a" },
      { type: "image", filePath: join(stateDir!, "b.png"), filename: "b.png", idempotencyKey: "image:b:hash-b" },
    ],
  };
}

describe("frozen Slack automatic terminal", () => {
  it("freezes unavailable media without losing text or valid siblings, and never revives that member", () => {
    const source = input();
    unlinkSync(source.media[0]!.filePath);
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    expect(frozen.mediaFingerprints).toHaveLength(2);
    expect(frozen.mediaAvailabilityErrors).toEqual(["file_unavailable", null]);
    expect(frozen.mediaByteFingerprints[0]).toBeNull();
    expect(assertSlackAutomaticTerminalPart(frozen, { type: "text", text: source.text })).toBe(
      `${frozen.responseId}:text`,
    );
    expect(readSlackAutomaticTerminalMediaBytes(frozen, { index: 1, media: source.media[1]! }).toString()).toBe(
      "original-b-bytes",
    );
    writeFileSync(source.media[0]!.filePath, "original-a-bytes");
    const stored = getSlackAutomaticTerminalManifest(frozen.responseId)!;
    expect(() => readSlackAutomaticTerminalMediaBytes(stored, { index: 0, media: source.media[0]! })).toThrow(
      "unavailable",
    );
    expect(() => freezeSlackAutomaticTerminalManifest(source)).toThrow("identity conflict");
  });

  it("admits complete long text and multiple attachments without adding a content cap", () => {
    const source = input();
    source.text = "Full paragraph.\n".repeat(10_000) + "FINAL_MARKER";
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    expect(assertSlackAutomaticTerminalPart(frozen, { type: "text", text: source.text })).toBe(
      `${frozen.responseId}:text`,
    );
    for (const [index, media] of source.media.entries()) {
      expect(assertSlackAutomaticTerminalPart(frozen, { type: "media", index, media })).toBe(
        `${frozen.responseId}:media:${index}`,
      );
    }
    expect(freezeSlackAutomaticTerminalManifest(source)).toEqual(frozen);
    const stored = getDb().prepare("SELECT manifest_json FROM slack_automatic_terminal_manifests").get() as {
      manifest_json: string;
    };
    expect(stored.manifest_json).not.toContain("FINAL_MARKER");
    expect(stored.manifest_json).not.toContain(stateDir!);
    expect(stored.manifest_json).not.toContain("original-a-bytes");
    expect(stored.manifest_json.length).toBeLessThan(2_000);
  });

  it("rejects text changes, appended/replaced attachments and a second terminal outcome", () => {
    const source = input();
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    expect(() => assertSlackAutomaticTerminalPart(frozen, { type: "text", text: "Incomplete prefix" })).toThrow(
      "not part",
    );
    const replacement = { ...source.media[0]!, caption: "new content" };
    expect(() => assertSlackAutomaticTerminalPart(frozen, { type: "media", index: 0, media: replacement })).toThrow(
      "not part",
    );
    expect(() => freezeSlackAutomaticTerminalManifest({ ...source, media: [...source.media, replacement] })).toThrow(
      "identity conflict",
    );
    expect(() => freezeSlackAutomaticTerminalManifest({ ...source, kind: "safe_error", text: "Error" })).toThrow(
      "identity conflict",
    );
    expect(() => freezeSlackAutomaticTerminalManifest({ ...source, sourceId: "newer-human-source" })).toThrow(
      "identity conflict",
    );
    expect(getSlackAutomaticTerminalManifest(frozen.responseId)).toEqual(frozen);
  });

  it("uses one terminal reservation for every part and never reuses its identities for another response", () => {
    const source = input();
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    const reserve = () =>
      reserveSlackAutomaticOutput({
        idempotencyKey: frozen.responseId,
        requestFingerprint: frozen.requestFingerprint,
        scope: frozen.scope,
        sourceId: frozen.sourceId,
        sourceReceivedAt: frozen.sourceReceivedAt,
        now: 1_001,
      });
    const original = reserve();
    expect(original.status).toBe("allowed");
    for (const [index, media] of source.media.entries()) {
      assertSlackAutomaticTerminalPart(frozen, { type: "media", index, media });
      expect(reserve()).toEqual(original);
    }
    const count = getDb().prepare("SELECT COUNT(*) AS count FROM slack_automatic_output_decisions").get() as {
      count: number;
    };
    expect(count.count).toBe(1);
    const next = freezeSlackAutomaticTerminalManifest(input("turn-2"));
    expect(next.responseId).not.toBe(frozen.responseId);
    expect(next.requestFingerprint).not.toBe(frozen.requestFingerprint);
    expect(assertSlackAutomaticTerminalPart(next, { type: "media", index: 0, media: source.media[0]! })).not.toBe(
      assertSlackAutomaticTerminalPart(frozen, { type: "media", index: 0, media: source.media[0]! }),
    );
  });

  it("keeps the frozen target/source independent of later object or session-target changes", () => {
    const source = input();
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    source.target.chatId = "CANOTHER";
    source.sourceId = "later-human";
    source.media[0]!.filename = "changed.png";
    const stored = getSlackAutomaticTerminalManifest(frozen.responseId)!;
    expect(stored.target.chatId).toBe("C123");
    expect(stored.sourceId).toBe("source:turn-1");
    expect(() =>
      assertSlackAutomaticTerminalPart(stored, { type: "media", index: 0, media: source.media[0]! }),
    ).toThrow("not part");
  });

  it("treats cancellation as a closed terminal with no deliverable parts", () => {
    const cancelled = freezeSlackAutomaticTerminalManifest({ ...input(), kind: "cancelled", text: "", media: [] });
    expect(() => assertSlackAutomaticTerminalPart(cancelled, { type: "text", text: "" })).toThrow("Cancelled");
    expect(() => freezeSlackAutomaticTerminalManifest(input())).toThrow("identity conflict");
  });

  it("freezes actual bytes and rejects changes under an unchanged path, descriptor and declared hash", () => {
    const source = input();
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    expect(readSlackAutomaticTerminalMediaBytes(frozen, { index: 0, media: source.media[0]! }).toString()).toBe(
      "original-a-bytes",
    );
    writeFileSync(source.media[0]!.filePath, "replacement-bytes-under-same-reference");
    expect(() => readSlackAutomaticTerminalMediaBytes(frozen, { index: 0, media: source.media[0]! })).toThrow(
      "bytes changed",
    );
    expect(() => freezeSlackAutomaticTerminalManifest(source)).toThrow("identity conflict");
    expect(getSlackAutomaticTerminalManifest(frozen.responseId)).toEqual(frozen);
  });

  it("uses declared media order so identical descriptors remain distinct parts", () => {
    const source = input();
    source.media = [source.media[0]!, { ...source.media[0]! }];
    const frozen = freezeSlackAutomaticTerminalManifest(source);
    expect(frozen.mediaFingerprints[0]).toBe(frozen.mediaFingerprints[1]);
    expect(frozen.mediaByteFingerprints[0]).toBe(frozen.mediaByteFingerprints[1]);
    const first = assertSlackAutomaticTerminalPart(frozen, { type: "media", index: 0, media: source.media[0]! });
    const second = assertSlackAutomaticTerminalPart(frozen, { type: "media", index: 1, media: source.media[1]! });
    expect(first).not.toBe(second);
    expect(() =>
      assertSlackAutomaticTerminalPart(frozen, { type: "media", index: 2, media: source.media[0]! }),
    ).toThrow("ordinal");
    expect(() =>
      assertSlackAutomaticTerminalPart(frozen, { type: "media", index: -1, media: source.media[0]! }),
    ).toThrow("ordinal");
  });
});
