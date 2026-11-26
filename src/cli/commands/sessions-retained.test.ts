import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getDb } from "../../router/router-db.js";
import { listLocalInboxItems, markLocalInboxItem } from "../../inbox/local-db.js";
import { preserveRejectedRuntimeStart } from "../../runtime/start-admission-inbox.js";
import { RETAINED_START_TTL_MS } from "../../runtime/start-admission-resume.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata } from "../decorators.js";
import { SessionRetainedCommands } from "./sessions-retained.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-retained-");
  spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  mock.restore();
  await cleanupIsolatedRaviState(stateDir);
});

function save(sessionName: string, prompt: string) {
  return preserveRejectedRuntimeStart({
    key: `runtime-start:${sessionName}:${prompt}`,
    sessionName,
    prompt: { prompt },
    capacity: {
      lane: "background",
      reason: "concurrency_limit",
      active: 1,
      reserved: 0,
      max: 1,
      backgroundLimit: 1,
      queuePosition: null,
      occupants: [],
      largestConsumer: null,
    },
  }).item;
}

function command() {
  const published: Array<{ sessionName: string; prompt: unknown }> = [];
  return {
    published,
    cmd: new SessionRetainedCommands({
      publishSessionPrompt: async (sessionName, payload) => {
        published.push({ sessionName, prompt: payload.prompt });
      },
    }),
  };
}

async function contractError(run: () => Promise<unknown> | unknown) {
  let caught: unknown;
  try {
    await runWithContext({}, () => run());
  } catch (error) {
    caught = error;
  }
  return caught;
}

describe("ravi sessions retained", () => {
  it("lists saved refusals oldest first with what the daemon will do", () => {
    const old = save("a", "velho");
    getDb()
      .prepare("UPDATE inbox_items SET occurred_at = ? WHERE id = ?")
      .run(Date.now() - RETAINED_START_TTL_MS - 1, old.id);
    const fresh = save("b", "novo");
    const payload = command().cmd.list(true);
    expect(payload.items.map((item) => [item.itemId, item.plan])).toEqual([
      [old.id, "expired"],
      [fresh.id, "resumed"],
    ]);
  });

  it("resume is a dry-run by default: exit 3, nothing published, item still open", async () => {
    const item = save("a", "pedido");
    const { cmd, published } = command();
    const error = await contractError(() => cmd.resume(item.id, false, true, false));
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).exitCode).toBe(3);
    expect(published).toEqual([]);
    expect(listLocalInboxItems({ sourceDomain: "system" }).map((i) => i.id)).toEqual([item.id]);
    expect(getCommandAccessMetadata(SessionRetainedCommands).get("resume")?.requiresConfirmation).toBe(true);
  });

  it("resume --execute requeues the saved prompt on its session and closes the alert", async () => {
    const item = save("a", "pedido");
    const { cmd, published } = command();
    const result = await runWithContext({}, () => cmd.resume(item.id, false, true, true));
    expect(result).toMatchObject({ ok: true, itemId: item.id, sessionName: "a" });
    expect(published).toEqual([{ sessionName: "a", prompt: "pedido" }]);
    expect(listLocalInboxItems({ sourceDomain: "system" })).toHaveLength(0);
  });

  it("refuses an expired request without --force", async () => {
    const item = save("a", "velho");
    getDb()
      .prepare("UPDATE inbox_items SET occurred_at = ? WHERE id = ?")
      .run(Date.now() - RETAINED_START_TTL_MS - 1, item.id);
    const { cmd, published } = command();
    expect(await contractError(() => cmd.resume(item.id, false, true, true))).toBeDefined();
    expect(published).toEqual([]);
    await runWithContext({}, () => cmd.resume(item.id, true, true, true));
    expect(published).toHaveLength(1);
  });

  it("never requeues a request a resume already claimed, even with --force", async () => {
    const item = save("a", "pedido");
    markLocalInboxItem(item.id, "assigned", { eventType: "resume_claimed" });
    const { cmd, published } = command();
    expect(await contractError(() => cmd.resume(item.id, true, true, true))).toBeDefined();
    expect(published).toEqual([]);
  });
});
