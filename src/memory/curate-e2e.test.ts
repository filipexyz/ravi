import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMessagesAfterId, saveMessage } from "../db.js";
import { getOrCreateSession, getSession, updateRuntimeProviderState, deleteSession } from "../router/sessions.js";
import { applyDeterministicGuard, markCurationMessageProcessed } from "./index.js";

/**
 * End-to-end proof of RM's correction: the curator no longer reads the "normal
 * history" — it reads each session's turns straight from the SQL `messages`
 * table (src/db.ts) via `getMessagesAfterId`, materializes only the delta, runs
 * the deterministic guard to write MEMORY.md, and advances the incremental-read
 * watermark so the NEXT cycle sees ONLY rows added after it.
 *
 * This drives the exact production functions the CLI `ravi memory guard` calls
 * (`applyDeterministicGuard` + `markCurationMessageProcessed`), against a real
 * ephemeral session seeded with no prior context, across two cadence cycles.
 */
describe("memory curation E2E — SQL messages read → guard write → watermark (ephemeral session)", () => {
  const tmpDirs: string[] = [];
  const sessionKeys: string[] = [];

  afterEach(() => {
    while (sessionKeys.length > 0) {
      const key = sessionKeys.pop();
      if (key) deleteSession(key);
    }
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads delta from SQL, guard writes MEMORY.md, watermark advances so cycle 2 only sees new rows", async () => {
    const sessionKey = `e2e-curate-${Date.now()}`;
    const sessionName = sessionKey;
    sessionKeys.push(sessionKey);
    const agentCwd = mkdtempSync(join(tmpdir(), "ravi-e2e-curate-"));
    tmpDirs.push(agentCwd);
    const memoryPath = join(agentCwd, "MEMORY.md");

    // Ephemeral session, no context, cadence 1 so every Stop fires.
    getOrCreateSession(sessionKey, "ravi-dev", agentCwd, {
      runtimeSessionParams: {
        memoryCuration: { turnCount: 0, lastCuratedTurn: 0, cadenceTurns: 1, lastCuratedMessageId: 0 },
      },
    });

    // ---- Cycle 1: seed real turns into the SQL messages table ----
    saveMessage(sessionName, "user", "meu nome de teste E2E e Ravi-QA");
    saveMessage(sessionName, "assistant", "anotado: usuario se chama Ravi-QA");

    // Curator read surface: SQL delta since watermark 0 = everything so far.
    const cycle1 = getMessagesAfterId(sessionName, 0);
    expect(cycle1).toHaveLength(2);
    expect(cycle1[0]!.content).toContain("Ravi-QA");
    const highestCycle1 = cycle1[cycle1.length - 1]!.id;

    // Deterministic guard write (what `ravi memory guard` invokes).
    const write1 = await applyDeterministicGuard({
      targetPath: memoryPath,
      expectedPriorContent: "",
      candidate: { content: "- Usuario de teste se chama Ravi-QA (E2E cycle 1)" },
      currentContent: "",
      telemetry: { agentId: "ravi-dev", cadenceTurn: 1, sessionKey, sessionName },
    });
    expect(write1.decision.outcome).toBe("written");
    expect(readFileSync(memoryPath, "utf-8")).toContain("Ravi-QA");

    // Advance the incremental-read watermark ONLY after a successful write.
    const sessionAfter1 = getSession(sessionKey);
    expect(sessionAfter1).not.toBeNull();
    const nextParams = markCurationMessageProcessed(sessionAfter1!, 1, highestCycle1);
    updateRuntimeProviderState(sessionKey, sessionAfter1!.runtimeProvider, {
      runtimeSessionParams: nextParams,
      ...(sessionAfter1!.providerSessionId ? { providerSessionId: sessionAfter1!.providerSessionId } : {}),
    });

    // ---- Cycle 2: new turns arrive; curator must read ONLY the delta ----
    saveMessage(sessionName, "user", "corrige: prefiro ser chamado de Ravi-Dev");
    saveMessage(sessionName, "assistant", "ok, passo a te chamar de Ravi-Dev");

    const sessionForCycle2 = getSession(sessionKey);
    const watermark = readWatermark(sessionForCycle2);
    expect(watermark).toBe(highestCycle1);

    const cycle2 = getMessagesAfterId(sessionName, watermark);
    expect(cycle2).toHaveLength(2);
    expect(cycle2.every((m) => m.id > highestCycle1)).toBe(true);
    expect(cycle2.map((m) => m.content).join("\n")).toContain("Ravi-Dev");
    // The old rows are NOT re-read — cost per cycle stays bounded by the delta.
    expect(cycle2.map((m) => m.content).join("\n")).not.toContain("Ravi-QA");

    const currentMemory = readFileSync(memoryPath, "utf-8");
    const write2 = await applyDeterministicGuard({
      targetPath: memoryPath,
      expectedPriorContent: currentMemory,
      candidate: { content: "- Correcao: chamar usuario de Ravi-Dev (E2E cycle 2)" },
      currentContent: currentMemory,
      telemetry: { agentId: "ravi-dev", cadenceTurn: 2, sessionKey, sessionName, hadUserCorrection: true },
    });
    expect(write2.decision.outcome).toBe("written");
    const finalMemory = readFileSync(memoryPath, "utf-8");
    expect(finalMemory).toContain("Ravi-QA");
    expect(finalMemory).toContain("Ravi-Dev");
  });
});

function readWatermark(session: { runtimeSessionParams?: Record<string, unknown> } | null): number {
  const memoryCuration = (session?.runtimeSessionParams?.memoryCuration ?? {}) as { lastCuratedMessageId?: number };
  return memoryCuration.lastCuratedMessageId ?? 0;
}
