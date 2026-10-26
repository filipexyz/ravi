import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRouterDb, dbSetSetting } from "../../router/router-db.js";
import { listSignals, raiseSignal } from "../../signals/service.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { SignalsCommands } from "./signals.js";

let root = "";
const originalStateDir = process.env.RAVI_STATE_DIR;
const commands = new SignalsCommands();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ravi-signals-cli-"));
  process.env.RAVI_STATE_DIR = join(root, ".ravi");
  dbSetSetting("signals.enabled", "true");
});

afterEach(() => {
  closeRouterDb();
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

async function quiet<T>(run: () => T | Promise<T>): Promise<{ result?: T; error?: ContractError }> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return { result: await run() };
  } catch (caught) {
    if (!(caught instanceof ContractError)) throw caught;
    return { error: caught };
  } finally {
    console.log = log;
    console.error = error;
  }
}

interface RaiseFlags {
  kind?: string;
  scope?: string;
  title?: string;
  severity?: string;
  clearProbe?: string;
  clearExpr?: string;
  clearProducerResolve?: boolean;
  clearDecay?: string;
  ttl?: string;
  source?: string;
}

function raise(key: string, flags: RaiseFlags) {
  return commands.raise(
    key,
    flags.kind as string,
    flags.scope as string,
    flags.title as string,
    flags.severity,
    undefined,
    undefined,
    flags.clearProbe,
    flags.clearExpr,
    undefined,
    undefined,
    undefined,
    flags.clearProducerResolve,
    flags.clearDecay,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    flags.ttl,
    undefined,
    undefined,
    undefined,
    undefined,
    flags.source,
    true,
  );
}

const agentTurn = { sessionName: "main-session", sessionKey: "agent:main:main-session", agentId: "main" };

describe("signals CLI contract", () => {
  it("exits 2 and writes nothing for a raise without a clear rule", async () => {
    const { error } = await quiet(() => raise("cli.none", { kind: "fact", scope: "install", title: "No rule" }));
    expect(error?.exitCode).toBe(2);
    expect(error?.code).toBe("USAGE_ERROR");
    expect(listSignals({ key: "cli.none" })).toHaveLength(0);
  });

  it("exits 2 for a judgment with page and for an unknown probe", async () => {
    const judgment = await quiet(() =>
      raise("cli.judgment", { kind: "judgment", scope: "install", title: "Loud", severity: "page", clearDecay: "1h" }),
    );
    expect(judgment.error?.exitCode).toBe(2);
    const probe = await quiet(() =>
      raise("cli.probe", {
        kind: "fact",
        scope: "install",
        title: "Typo",
        clearProbe: "host.dsk",
        clearExpr: "free_pct >= 20",
      }),
    );
    expect(probe.error?.exitCode).toBe(2);
    expect(listSignals({ state: "non_terminal" })).toHaveLength(0);
  });

  it("exits 2 for a fact raised from an agent turn and leaves the stored row unchanged", async () => {
    raiseSignal({
      key: "cli.fact",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      title: "Original",
      clearWhen: { type: "producer_resolve", ttl_ms: 60_000 },
    });
    const { error } = await quiet(() =>
      runWithContext(agentTurn, () =>
        raise("cli.fact", { kind: "fact", scope: "install", title: "Hijack", clearProducerResolve: true, ttl: "1h" }),
      ),
    );
    expect(error?.exitCode).toBe(2);
    expect(listSignals({ key: "cli.fact" })[0]?.title).toBe("Original");
  });

  it("exits 2 for a cross-owner raise", async () => {
    await quiet(() =>
      raise("cli.owner", {
        kind: "fact",
        scope: "install",
        title: "Mine",
        clearProducerResolve: true,
        ttl: "1h",
        source: "producer.a",
      }),
    );
    const { error } = await quiet(() =>
      raise("cli.owner", {
        kind: "fact",
        scope: "install",
        title: "Theirs",
        clearProducerResolve: true,
        ttl: "1h",
        source: "producer.b",
      }),
    );
    expect(error?.exitCode).toBe(2);
    expect(listSignals({ key: "cli.owner" })[0]?.title).toBe("Mine");
  });

  it("answers NOT_FOUND (exit 1) for a missing record, and exit 2 for mute on a resolved one", async () => {
    const missing = await quiet(() => commands.show("sig_missing", true));
    expect(missing.error?.exitCode).toBe(1);
    expect(missing.error?.code).toBe("NOT_FOUND");

    const { signal } = raiseSignal({
      key: "cli.resolved",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      title: "Done",
      clearWhen: { type: "producer_resolve", ttl_ms: 60_000 },
    });
    await quiet(() => commands.resolve(signal.id, "fixed", undefined, true));
    const muted = await quiet(() => commands.mute(signal.id, "1h", undefined, undefined, true));
    expect(muted.error?.exitCode).toBe(2);
    expect(listSignals({ key: "cli.resolved" })[0]?.state).toBe("resolved");
  });

  it("dry-runs the tick with exit 3 and delivers nothing", async () => {
    const { error } = await quiet(() => commands.tick(undefined, true));
    expect(error?.exitCode).toBe(3);
    expect(error?.code).toBe("WRITE_REQUIRES_EXECUTE");
    const executed = await quiet(() => commands.tick(true, true));
    expect(executed.result?.executed).toBe(true);
  });

  it("defaults an agent's scope to its own agent and owns the record as that agent", async () => {
    const { result } = await quiet(() =>
      runWithContext(agentTurn, () =>
        raise("cli.agent", { kind: "judgment", title: "Contact cooled", clearDecay: "72h", source: "spoof" }),
      ),
    );
    expect(result?.signal.scopeType).toBe("agent");
    expect(result?.signal.scopeId).toBe("main");
    expect(result?.signal.producerId).toBe("agent:main");
  });
});
