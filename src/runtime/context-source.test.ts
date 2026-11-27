import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { approvalOrigin, runtimeCommandSource } from "./context-source.js";

const SRC = join(import.meta.dir, "..");
const borrowed = { channel: "slack", accountId: "main", chatId: "D-caller", threadId: "1.2" };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(SRC)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path))
    .sort();
}

describe("approval-only origin", () => {
  it("is never a command source and is the approval origin only when the turn has none of its own", () => {
    const relayed = { source: undefined, metadata: { approvalSource: borrowed, approvalSourceOnly: true } };
    expect(runtimeCommandSource(relayed)).toBeUndefined();
    expect(approvalOrigin(relayed)).toEqual(borrowed);

    const own = { channel: "whatsapp", accountId: "luis", chatId: "group" };
    const direct = { source: own, metadata: { approvalSource: borrowed } };
    expect(runtimeCommandSource(direct)).toEqual(own);
    expect(approvalOrigin(direct)).toEqual(own);

    // An older record that stored the borrowed origin in `source`, behind the marker.
    const legacy = { source: borrowed, metadata: { approvalSourceOnly: true } };
    expect(runtimeCommandSource(legacy)).toBeUndefined();
    expect(approvalOrigin(legacy)).toEqual(borrowed);

    expect(approvalOrigin({ source: undefined, metadata: { approvalSource: { channel: "slack" } } })).toBeUndefined();
    expect(approvalOrigin({ source: undefined, metadata: {} })).toBeUndefined();
  });

  // Closure: a relayed turn's borrowed origin lives only in `metadata.approvalSource`, so it can reach a
  // destination only through code that names that key. A new reader must go through `approvalOrigin`.
  it("is read only through approvalOrigin; the builder and the registry carry it, context info displays it", () => {
    expect(filesMatching(/metadata\??\.(approvalSource\b|\[\s*["']approvalSource["']\s*\])/)).toEqual([
      // `ravi context info` shows it as lineage text; it is never a destination there.
      "cli/commands/context.ts",
      "runtime/context-registry.ts",
      "runtime/context-source.ts",
      "runtime/runtime-request-context.ts",
    ]);
  });

  it("keeps the approval-only marker in the places that filter or carry it", () => {
    expect(filesMatching(/approvalSourceOnly/)).toEqual([
      "cli/context.ts",
      "runtime/context-registry.ts",
      "runtime/context-source.ts",
      "runtime/runtime-request-context.ts",
    ]);
  });

  it("is filtered by the consumers that used to read a turn's origin from the record", () => {
    for (const file of [
      "pr/context.ts",
      "cli/commands/context.ts",
      "cli/commands/credential-intake.ts",
      "credentials/broker.ts",
      "approval/service.ts",
      "cli/context.ts",
      "sdk/gateway/dispatcher.ts",
    ]) {
      expect(readFileSync(join(SRC, file), "utf8")).toContain("runtimeCommandSource(");
    }
  });
});
