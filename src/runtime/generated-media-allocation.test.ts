import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import * as outputHandoff from "../channels/output-handoff.js";
import { reportErrorDiagnostic } from "../utils/error-reporting.js";
import {
  createGeneratedMediaAllocator,
  type GeneratedMediaAllocation,
  GeneratedMediaAllocationError,
  type GeneratedMediaFileHandle,
  type GeneratedMediaFileStat,
  type GeneratedMediaFileSystem,
} from "./generated-media-allocation.js";

interface VirtualFile {
  dev: number;
  ino: number;
  kind: "file" | "symlink" | "directory";
  bytes: Buffer;
}

interface FileOperation {
  op: "open" | "stat" | "write" | "close" | "lstat" | "unlink";
  filePath: string;
  flags?: string;
  mode?: number;
}

function ioError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Every file, replacement and removal is virtual; no native fixture or physical cleanup is used. */
class VirtualFiles implements GeneratedMediaFileSystem {
  readonly files = new Map<string, VirtualFile>();
  readonly operations: FileOperation[] = [];
  nextInode = 1;
  statError?: Error;
  writeError?: Error;
  closeError?: Error;
  lstatError?: Error;
  unlinkError?: Error;
  onWrite?: (filePath: string) => void;

  private snapshot(file: VirtualFile): GeneratedMediaFileStat {
    const { dev, ino, kind } = file;
    return { dev, ino, isFile: () => kind === "file", isSymbolicLink: () => kind === "symlink" };
  }

  async open(filePath: string, flags: "wx", mode: number): Promise<GeneratedMediaFileHandle> {
    this.operations.push({ op: "open", filePath, flags, mode });
    if (this.files.has(filePath)) throw ioError("EEXIST");
    const file: VirtualFile = { dev: 1, ino: this.nextInode++, kind: "file", bytes: Buffer.alloc(0) };
    this.files.set(filePath, file);
    return {
      stat: async () => {
        this.operations.push({ op: "stat", filePath });
        if (this.statError) throw this.statError;
        return this.snapshot(file);
      },
      writeFile: async (bytes) => {
        this.operations.push({ op: "write", filePath });
        this.onWrite?.(filePath);
        if (this.writeError) throw this.writeError;
        file.bytes = Buffer.from(bytes);
      },
      close: async () => {
        this.operations.push({ op: "close", filePath });
        if (this.closeError) throw this.closeError;
      },
    };
  }

  async lstat(filePath: string): Promise<GeneratedMediaFileStat> {
    this.operations.push({ op: "lstat", filePath });
    if (this.lstatError) throw this.lstatError;
    const file = this.files.get(filePath);
    if (!file) throw ioError("ENOENT");
    return this.snapshot(file);
  }

  async unlink(filePath: string): Promise<void> {
    this.operations.push({ op: "unlink", filePath });
    if (this.unlinkError) throw this.unlinkError;
    if (!this.files.delete(filePath)) throw ioError("ENOENT");
  }
}

const virtualDirectory = "/virtual/generated-media";
const firstUUID = "00000000-0000-4000-8000-000000000001";
const attachment = {
  type: "image" as const,
  filename: "ravi-generated-media-session-image-hash.png",
  mimeType: "image/png",
  idempotencyKey: "runtime.generated_media:session:item:hash",
  source: "runtime.generated_media",
};

function fixture() {
  const fs = new VirtualFiles();
  let nextUUID = 1;
  const allocator = createGeneratedMediaAllocator({
    fs,
    tmpdir: () => virtualDirectory,
    randomUUID: () => `00000000-0000-4000-8000-${(nextUUID++).toString(16).padStart(12, "0")}`,
  });
  const allocate = () => allocator.allocate({ bytes: Buffer.from("same image bytes"), attachment });
  return { fs, allocator, allocate };
}

async function allocationFailure(promise: Promise<unknown>): Promise<GeneratedMediaAllocationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GeneratedMediaAllocationError) return error;
    throw error;
  }
  throw new Error("Expected allocation failure");
}

describe("private generated-media allocation", () => {
  it("exclusively creates distinct private paths without changing display names or semantic keys", async () => {
    const { fs, allocate } = fixture();
    const first = await allocate();
    const second = await allocate();
    expect(first.attachment.filePath).toBe(join(virtualDirectory, `ravi-generated-media-${firstUUID}.png`));
    expect(second.attachment.filePath).not.toBe(first.attachment.filePath);
    for (const allocated of [first, second]) {
      expect(allocated.attachment).toMatchObject(attachment);
      expect(fs.files.get(allocated.attachment.filePath)?.bytes.toString()).toBe("same image bytes");
      expect(Object.isFrozen(allocated.attachment)).toBe(true);
    }
    expect(fs.operations.filter((operation) => operation.op === "open")).toEqual([
      { op: "open", filePath: first.attachment.filePath, flags: "wx", mode: 0o600 },
      { op: "open", filePath: second.attachment.filePath, flags: "wx", mode: 0o600 },
    ]);
    expect(fs.operations.filter((operation) => operation.op === "close")).toHaveLength(2);
  });

  it.each([
    { filename: "../../display.PNG", extension: ".png" },
    { filename: "image.jpeg", extension: ".jpeg" },
    { filename: "image.p$ng", extension: "" },
    { filename: "image.verylongextension", extension: "" },
    { filename: "image.png/../../outside", extension: "" },
  ])("keeps only a safe extension from $filename in the private path", async ({ filename, extension }) => {
    const { allocator } = fixture();
    const allocated = await allocator.allocate({
      bytes: Buffer.from("bytes"),
      attachment: { ...attachment, filename },
    });
    expect(allocated.attachment.filename).toBe(filename);
    expect(allocated.attachment.filePath).toBe(join(virtualDirectory, `ravi-generated-media-${firstUUID}${extension}`));
  });

  it("rejects an exclusive-create collision without overwriting or cleaning the existing file", async () => {
    const { fs, allocate } = fixture();
    const filePath = join(virtualDirectory, `ravi-generated-media-${firstUUID}.png`);
    const existing: VirtualFile = { dev: 1, ino: 100, kind: "file", bytes: Buffer.from("existing") };
    fs.files.set(filePath, existing);
    await expect(allocate()).rejects.toThrow("EEXIST");
    expect(fs.files.get(filePath)).toBe(existing);
    expect(existing.bytes.toString()).toBe("existing");
    expect(fs.operations).toEqual([{ op: "open", filePath, flags: "wx", mode: 0o600 }]);
  });

  it("rejects forged, copied and serialized tokens and descriptor aliases without filesystem I/O", async () => {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    const owner = {};
    const operations = fs.operations.length;
    const forged = [
      {} as GeneratedMediaAllocation,
      { ...allocated.allocation },
      JSON.parse(JSON.stringify(allocated.allocation)) as GeneratedMediaAllocation,
    ];
    for (const allocation of forged) {
      expect(() => allocator.adopt({ ...allocated, allocation }, owner)).toThrow();
      expect(() => allocator.retain(allocation, owner)).toThrow();
      expect(allocator.prepareDiscard(allocation, owner)).toBeUndefined();
      expect(allocator.prepareUnadoptedDiscard(allocation)).toBeUndefined();
    }
    expect(() => allocator.adopt({ ...allocated, attachment: { ...allocated.attachment } }, owner)).toThrow();
    const foreignAllocator = createGeneratedMediaAllocator({ fs });
    expect(() => foreignAllocator.adopt(allocated, owner)).toThrow();
    expect(foreignAllocator.prepareUnadoptedDiscard(allocated.allocation)).toBeUndefined();
    expect(fs.operations).toHaveLength(operations);
    allocator.adopt(allocated, owner);
  });

  it("permits only one owner and never disposes an adopted member through the unadopted path", async () => {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    const owner = {};
    const otherOwner = {};
    allocator.adopt(allocated, owner);
    allocator.adopt(allocated, owner);
    const operations = fs.operations.length;
    expect(() => allocator.adopt(allocated, otherOwner)).toThrow();
    expect(() => allocator.retain(allocated.allocation, otherOwner)).toThrow();
    expect(allocator.prepareDiscard(allocated.allocation, otherOwner)).toBeUndefined();
    expect(allocator.prepareUnadoptedDiscard(allocated.allocation)).toBeUndefined();
    expect(fs.operations).toHaveLength(operations);
    expect(fs.files.has(allocated.attachment.filePath)).toBe(true);
    expect(allocator.prepareDiscard(allocated.allocation, owner)).toBeDefined();
  });

  it("disposes only a fresh semantic duplicate, leaving the accepted live member intact", async () => {
    const { fs, allocator, allocate } = fixture();
    const accepted = await allocate();
    const duplicate = await allocate();
    allocator.adopt(accepted, {});
    expect(accepted.attachment.idempotencyKey).toBe(duplicate.attachment.idempotencyKey);
    expect(allocator.prepareUnadoptedDiscard(accepted.allocation)).toBeUndefined();
    const discard = allocator.prepareUnadoptedDiscard(duplicate.allocation)!;
    const first = discard();
    expect(discard()).toBe(first);
    expect(await first).toEqual({ status: "released", filePath: duplicate.attachment.filePath });
    expect(fs.files.has(accepted.attachment.filePath)).toBe(true);
    expect(fs.files.has(duplicate.attachment.filePath)).toBe(false);
    expect(fs.operations.filter((operation) => operation.op === "unlink")).toEqual([
      { op: "unlink", filePath: duplicate.attachment.filePath },
    ]);
  });

  it("claims synchronously and runs one cached disposal after the caller invokes it", async () => {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    const owner = {};
    allocator.adopt(allocated, owner);
    const operations = fs.operations.length;
    const discard = allocator.prepareDiscard(allocated.allocation, owner)!;
    expect(fs.operations).toHaveLength(operations);
    expect(allocator.prepareDiscard(allocated.allocation, owner)).toBeUndefined();
    expect(() => allocator.adopt(allocated, owner)).toThrow();
    expect(() => allocator.retain(allocated.allocation, owner)).toThrow();
    const first = discard();
    expect(discard()).toBe(first);
    const result = await first;
    expect(result).toEqual({ status: "released", filePath: allocated.attachment.filePath });
    expect(await discard()).toBe(result);
    expect(fs.operations.slice(operations).map((operation) => operation.op)).toEqual(["lstat", "unlink"]);
  });

  it("pins final or other-transport allocations against deferred discard and re-adoption", async () => {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    const owner = {};
    allocator.adopt(allocated, owner);
    const operations = fs.operations.length;
    allocator.retain(allocated.allocation, owner);
    allocator.retain(allocated.allocation, owner);
    allocator.adopt(allocated, owner);
    expect(allocator.prepareDiscard(allocated.allocation, owner)).toBeUndefined();
    expect(allocator.prepareUnadoptedDiscard(allocated.allocation)).toBeUndefined();
    expect(() => allocator.adopt(allocated, {})).toThrow();
    expect(fs.operations).toHaveLength(operations);
    expect(fs.files.has(allocated.attachment.filePath)).toBe(true);
  });

  it.each(["dev", "ino", "symlink", "directory"] as const)(
    "rejects an observed %s replacement before attempting removal",
    async (replacementKind) => {
      const { fs, allocator, allocate } = fixture();
      const allocated = await allocate();
      const filePath = allocated.attachment.filePath;
      const original = fs.files.get(filePath)!;
      const replacement: VirtualFile = { ...original };
      if (replacementKind === "dev") replacement.dev++;
      else if (replacementKind === "ino") replacement.ino++;
      else replacement.kind = replacementKind;
      fs.files.set(filePath, replacement);
      const discard = allocator.prepareUnadoptedDiscard(allocated.allocation)!;
      const result = await discard();
      expect(result).toEqual({
        status: "rejected",
        filePath,
        reason: replacementKind === "dev" || replacementKind === "ino" ? "identity_changed" : "not_regular_file",
      });
      expect(await discard()).toBe(result);
      expect(fs.operations.filter((operation) => operation.op === "unlink")).toHaveLength(0);
      expect(fs.files.get(filePath)).toBe(replacement);
    },
  );

  it.each(["lstat", "unlink"] as const)("settles ENOENT during %s without another attempt", async (operation) => {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    if (operation === "lstat") fs.files.delete(allocated.attachment.filePath);
    else fs.unlinkError = ioError("ENOENT");
    const discard = allocator.prepareUnadoptedDiscard(allocated.allocation)!;
    const first = discard();
    const result = await first;
    expect(result).toEqual({ status: "already_missing", filePath: allocated.attachment.filePath });
    expect(discard()).toBe(first);
    expect(await discard()).toBe(result);
    expect(fs.operations.filter((entry) => entry.op === "lstat")).toHaveLength(1);
    expect(fs.operations.filter((entry) => entry.op === "unlink")).toHaveLength(operation === "unlink" ? 1 : 0);
  });

  it.each(["lstat", "unlink"] as const)("exposes %s errors with one bounded attempt", async (operation) => {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    const failure = ioError("EACCES");
    if (operation === "lstat") fs.lstatError = failure;
    else fs.unlinkError = failure;
    const discard = allocator.prepareUnadoptedDiscard(allocated.allocation)!;
    const result = await discard();
    expect(result).toEqual({
      status: "failed",
      filePath: allocated.attachment.filePath,
      reason: operation === "lstat" ? "stat_failed" : "unlink_failed",
      error: failure,
    });
    fs.lstatError = undefined;
    fs.unlinkError = undefined;
    expect(await discard()).toBe(result);
    expect(fs.operations.filter((entry) => entry.op === "lstat")).toHaveLength(1);
    expect(fs.operations.filter((entry) => entry.op === "unlink")).toHaveLength(operation === "unlink" ? 1 : 0);
    expect(fs.files.has(allocated.attachment.filePath)).toBe(true);
  });

  it("closes and disposes its own failed write while preserving the original error", async () => {
    const { fs, allocate } = fixture();
    fs.writeError = ioError("ENOSPC");
    const error = await allocationFailure(allocate());
    expect(error.cause).toBe(fs.writeError);
    expect(error.cleanup.status).toBe("released");
    expect(fs.files.size).toBe(0);
    expect(fs.operations.map((operation) => operation.op)).toEqual([
      "open",
      "stat",
      "write",
      "close",
      "lstat",
      "unlink",
    ]);
  });

  it("makes write, close and disposal failures observable without replacing the original cause", async () => {
    const { fs, allocate } = fixture();
    fs.writeError = ioError("ENOSPC");
    fs.closeError = ioError("EIO");
    fs.unlinkError = ioError("EACCES");
    const error = await allocationFailure(allocate());
    expect(error.cause).toBe(fs.writeError);
    expect(error.closeError).toBe(fs.closeError);
    expect(error.cleanup).toMatchObject({ status: "failed", reason: "unlink_failed", error: fs.unlinkError });
    expect(fs.operations.filter((operation) => operation.op === "close")).toHaveLength(1);
    expect(fs.operations.filter((operation) => operation.op === "unlink")).toHaveLength(1);
  });

  it("does not publish an allocation whose file handle failed to close", async () => {
    const { fs, allocate } = fixture();
    fs.closeError = ioError("EIO");
    const error = await allocationFailure(allocate());
    expect(error.cause).toBe(fs.closeError);
    expect(error.closeError).toBe(fs.closeError);
    expect(error.cleanup.status).toBe("released");
    expect(fs.operations.filter((operation) => operation.op === "close")).toHaveLength(1);
  });

  it("retains the file when initial handle identity cannot be captured", async () => {
    const { fs, allocate } = fixture();
    fs.statError = ioError("EIO");
    const error = await allocationFailure(allocate());
    expect(error.cause).toBe(fs.statError);
    expect(error.cleanup).toMatchObject({ status: "rejected", reason: "identity_unavailable" });
    expect(fs.operations.map((operation) => operation.op)).toEqual(["open", "stat", "close"]);
    expect(fs.files.size).toBe(1);
  });

  it("rejects disposal of a replacement after a failed write", async () => {
    const { fs, allocate } = fixture();
    fs.writeError = ioError("ENOSPC");
    fs.onWrite = (filePath) => {
      fs.files.set(filePath, { dev: 2, ino: 200, kind: "file", bytes: Buffer.from("replacement") });
    };
    const error = await allocationFailure(allocate());
    expect(error.cause).toBe(fs.writeError);
    expect(error.cleanup).toMatchObject({ status: "rejected", reason: "identity_changed" });
    expect(fs.operations.filter((operation) => operation.op === "unlink")).toHaveLength(0);
    expect(fs.files.get(error.cleanup.filePath)?.bytes.toString()).toBe("replacement");
  });
});

describe("accepted-recorder media disposal", () => {
  /**
   * Executes the source projector with a synthetic recorder-return boundary, NOT a real
   * SQLite COMMIT. Registry, schemas and sinks are fakes; no provider or actual send runs.
   * The real allocator uses only VirtualFiles. Native filesystem access only reads source.
   */
  const source = ts.createSourceFile(
    "runtime-events.ts",
    readFileSync(new URL("../channels/runtime-events.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = [
    "recordAndEmit",
    "recordedRuntimeEvent",
    "prepareTerminalOutput",
    "reportAutomaticMediaDisposalFailure",
    "isTerminalState",
  ]
    .map((name) => {
      const matches = source.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name?.text === name);
      expect(matches).toHaveLength(1);
      return matches[0]!.getText(source);
    })
    .join("\n");
  const compiled = ts.transpileModule(`${functions}\nmodule.exports = { recordAndEmit };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error)).toEqual([]);

  type Stage = "record" | "callback" | "payload" | "schema" | "event" | "output" | "logger";
  type State = "failed" | "interrupted" | "completed";
  async function projectorFixture(dependencies: Record<string, unknown> = {}) {
    const { fs, allocator, allocate } = fixture();
    const allocated = await allocate();
    const binding = { turnId: "virtual-turn", sessionKey: "virtual-session" };
    const reply = {
      origin: { binding },
      ownedMediaAllocations: new Set([allocated.allocation]),
      media: [allocated.attachment],
      mediaKeys: new Set([allocated.attachment.idempotencyKey]),
    };
    allocator.adopt(allocated, reply);
    const faults: Partial<Record<Stage, Error>> = {};
    const trace: string[] = [];
    const logs: unknown[] = [];
    let pending = true;
    let pendingReply = reply;
    const step = (stage: Stage) => {
      trace.push(stage);
      if (faults[stage]) throw faults[stage];
    };
    const unlink = fs.unlink.bind(fs);
    fs.unlink = async (filePath) => {
      trace.push("unlink");
      await unlink(filePath);
    };
    const module = {
      exports: {} as {
        recordAndEmit: (input: Record<string, unknown>) => Promise<{ dispatchError?: unknown } | undefined>;
      },
    };
    runInNewContext(compiled.outputText, {
      module,
      isDeepStrictEqual,
      generatedMediaAllocations: allocator,
      ChannelBackendRuntimeOwnershipLostError: class extends Error {},
      channelRuntimeGenerationId: "virtual-generation",
      CHANNEL_BACKEND_PROTOCOL: "virtual-backend",
      CHANNEL_BACKEND_SCHEMA_VERSION: 1,
      CHANNEL_RUNTIME_EVENTS_PROTOCOL: "virtual-runtime",
      CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION: 1,
      semanticEventId: (...parts: string[]) => parts.join(":"),
      channelTextContent: (text: string) => ({ blocks: [{ type: "text", text }] }),
      ChannelOutputEnvelopeSchema: { parse: (value: unknown) => value },
      KnownChannelRuntimeEventSchema: {
        parse: (value: unknown) => {
          step("schema");
          return value;
        },
      },
      dbRecordChannelBackendRuntimeEvent: (input: { slackTerminalManifest?: unknown }) => {
        step("record");
        trace.push("accepted"); // Synthetic successful return, not a database transaction.
        return {
          runtime: { lastSequence: 1, lastDeltaSequence: 0 },
          slackTerminalManifest: input.slackTerminalManifest,
        };
      },
      discardSlackAutomaticPendingReply: (supplied: unknown) => {
        expect(supplied).toBe(binding); // Both compared bindings keep their original realm and identity.
        trace.push("detach");
        if (!pending) return undefined;
        pending = false;
        return pendingReply;
      },
      channelBackendEgressRequester: undefined,
      channelOutputSinks: {
        tryEmitWithHandoff: async () => {
          step("output");
          return { emitted: true, confirmation: undefined };
        },
      },
      log: {
        warn: (_message: string, details: unknown) => {
          logs.push(details);
          step("logger");
        },
      },
      ...dependencies,
    });
    const terminal = (state: State, overrides: Record<string, unknown> = {}) =>
      module.exports.recordAndEmit({
        metadata: { binding, target: { channelKind: "slack", connectionId: "virtual", conversationId: "virtual" } },
        state,
        kind: state === "interrupted" ? "turn.interrupted" : "turn.terminal_output",
        occurredAt: 1000,
        assistantText: state === "completed" ? "Final answer" : undefined,
        safeError: state === "failed" ? { code: "INTERNAL" } : undefined,
        prepareTerminalManifest: () => ({ kind: state === "completed" ? "final_answer" : "cancelled" }),
        afterRecordEvent: () => step("callback"),
        payload: () => {
          step("payload");
          return {};
        },
        sinks: {
          tryEmit: async () => {
            step("event");
            return true;
          },
        },
        ...overrides,
      });
    return {
      fs,
      allocator,
      allocate,
      allocated,
      binding,
      reply,
      faults,
      trace,
      logs,
      terminal,
      pending: () => pending,
      replacePendingReply: (replacement: typeof reply) => {
        pendingReply = replacement;
        pending = true;
      },
    };
  }

  it.each([
    { state: "failed" as const, direct: false },
    { state: "interrupted" as const, direct: false },
    { state: "interrupted" as const, direct: true },
  ])("disposes accepted $state exactly once (direct cancellation: $direct)", async ({ state, direct }) => {
    const h = await projectorFixture();
    const overrides = direct ? { afterRecordEvent: undefined, prepareTerminalManifest: undefined } : {};
    await h.terminal(state, overrides);
    expect(h.trace.filter((stage) => stage === "unlink")).toHaveLength(1);
    expect(h.trace.indexOf("unlink")).toBeGreaterThan(h.trace.indexOf("accepted"));
    expect(h.trace.indexOf("unlink")).toBeGreaterThan(h.trace.indexOf("event"));
    expect(h.trace.includes("callback")).toBe(!direct);
    expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(false);
    expect(h.pending()).toBe(false);
    expect(h.reply.media).toEqual([]);
    expect(h.reply.mediaKeys.size).toBe(0);
    expect(h.reply.ownedMediaAllocations.size).toBe(0);
    await h.terminal(state, overrides);
    expect(h.trace.filter((stage) => stage === "unlink")).toHaveLength(1);
  });

  it.each(["callback", "payload", "schema"] as const)(
    "disposes after an accepted %s exception without replacing it",
    async (stage) => {
      const h = await projectorFixture();
      const original = new Error(stage);
      h.faults[stage] = original;
      await expect(h.terminal("failed")).rejects.toBe(original);
      expect(h.trace.indexOf(stage)).toBeGreaterThan(h.trace.indexOf("accepted"));
      expect(h.trace.filter((item) => item === "unlink")).toHaveLength(1);
      expect(h.pending()).toBe(false);
      expect(h.fs.files.size).toBe(0);
    },
  );

  it.each(["owner", "recorder"] as const)("retains pending media on %s rejection", async (rejection) => {
    const h = await projectorFixture();
    if (rejection === "owner") expect(await h.terminal("failed", { mayWrite: () => false })).toBeUndefined();
    else {
      h.faults.record = new Error("recorder rejected");
      await expect(h.terminal("failed")).rejects.toBe(h.faults.record);
    }
    expect(h.trace).not.toContain("accepted");
    expect(h.trace).not.toContain("unlink");
    expect(h.pending()).toBe(true);
    expect(h.reply.media).toHaveLength(1);
    expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(true);
  });

  it("retains completed final allocations even when a sink fails", async () => {
    const h = await projectorFixture();
    h.faults.event = new Error("unknown delivery");
    expect((await h.terminal("completed"))?.dispatchError).toBe(h.faults.event);
    expect(h.trace).not.toContain("unlink");
    expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(true);
    expect(h.allocator.prepareDiscard(h.allocated.allocation, h.reply)).toBeUndefined();
  });

  it("attempts both sinks, preserves the first error and observes cleanup failure despite a broken logger", async () => {
    const h = await projectorFixture();
    h.faults.event = new Error("first sink");
    h.faults.output = new Error("second sink");
    h.faults.logger = new Error("logger");
    h.fs.unlinkError = ioError("EACCES");
    expect((await h.terminal("failed"))?.dispatchError).toBe(h.faults.event);
    expect(h.trace).toContain("event");
    expect(h.trace).toContain("output");
    expect(h.trace.indexOf("unlink")).toBeGreaterThan(h.trace.indexOf("output"));
    expect(h.trace.filter((stage) => stage === "unlink")).toHaveLength(1);
    expect(h.logs).toEqual([expect.objectContaining({ status: "failed", error: h.fs.unlinkError })]);
  });

  describe("terminal recovery and private media ownership join", () => {
    /**
     * The source projector, recovery/readback comparisons, commit acknowledgement,
     * text handoff and private allocator are real. Only the synchronous DB/witness
     * boundary, schemas, registry, timers and sinks (including logging) are simulated.
     * This is NOT SQL COMMIT evidence; terminal-projection-recovery.test.ts supplies that separately.
     * No router DB import, native fixture, filesystem removal or provider send runs.
     */
    const recoveryCompiled = ["terminal-projection-recovery.ts", "terminal-output-handoff.ts"].map((filename) => {
      const moduleSource = ts.createSourceFile(
        filename,
        readFileSync(new URL(`../channels/${filename}`, import.meta.url), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const moduleText = moduleSource.statements
        .filter((statement) => !ts.isImportDeclaration(statement))
        .map((statement) => statement.getText(moduleSource))
        .join("\n");
      return ts.transpileModule(moduleText, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        reportDiagnostics: true,
      });
    });
    expect(
      recoveryCompiled
        .flatMap((compiledModule) => compiledModule.diagnostics ?? [])
        .filter((item) => item.category === ts.DiagnosticCategory.Error),
    ).toEqual([]);

    type Boundary = "accepted" | "readback" | "refused" | "unknown" | "uncommitted";
    async function joinedFixture(boundary: Boundary, loseOwner = false) {
      const receipt = {
        id: "virtual-receipt",
        turnId: "virtual-turn",
        channelInstanceId: "virtual-instance",
        agentId: "virtual-agent",
        chatId: "virtual-chat",
        messageId: "virtual-message",
        sessionKey: "virtual-session",
        sessionName: "virtual-session",
        idempotencyKey: "virtual-request",
        requestFingerprint: "virtual-request-fingerprint",
        initialRequestId: "virtual-ingress",
        external: { channelKind: "slack", conversationId: "virtual-conversation" },
        prompt: "virtual prompt",
        acceptedAt: 1,
      };
      let runtime: Record<string, unknown> = {
        turnId: receipt.turnId,
        state: "running",
        runtimeGenerationId: "virtual-generation",
        lastSequence: 1,
        lastDeltaSequence: 0,
        updatedAt: 2,
      };
      let manifest: { responseId: string; requestFingerprint: string } | undefined;
      let owns = true;
      let recordCalls = 0;
      let snapshots = 0;
      const persistenceStates: string[] = [];
      const outputStates: string[] = [];
      const delays: number[] = [];
      const persistenceError = new Error(
        boundary === "refused" ? "Slack automatic terminal manifest identity conflict" : "ambiguous recorder outcome",
      );
      const database = {
        inTransaction: false,
        transaction: (read: () => unknown) => ({
          deferred: () => {
            snapshots += 1;
            if (boundary === "unknown" && snapshots > 1) throw new Error("readback unavailable");
            return read();
          },
        }),
        prepare: () => ({
          get: () =>
            manifest
              ? {
                  response_id: manifest.responseId,
                  request_fingerprint: manifest.requestFingerprint,
                  manifest_json: JSON.stringify(manifest),
                }
              : null,
        }),
      };
      const dependencies = {
        Error,
        isDeepStrictEqual,
        ...outputHandoff,
        logger: { child: () => ({ warn: () => undefined }) },
        reportErrorDiagnostic,
        ChannelBackendRuntimeOwnershipLostError: class extends Error {},
        ChannelOutputEnvelopeSchema: { parse: (value: unknown) => structuredClone(value) },
        getDb: () => database,
        dbGetChannelBackendIngressReceiptByTurnId: () => receipt,
        dbGetChannelBackendRuntimeState: () => runtime,
        dbGetChatMessage: () => null,
        dbRecordChannelBackendRuntimeEvent: (operation: Record<string, unknown>) => {
          recordCalls += 1;
          if (boundary === "refused" || boundary === "unknown") throw persistenceError;
          runtime = {
            ...runtime,
            state: operation.state,
            lastSequence: 2,
            updatedAt: operation.occurredAt,
            terminalError: operation.terminalError,
          };
          manifest = operation.slackTerminalManifest as typeof manifest;
          if (loseOwner) owns = false;
          if (boundary === "uncommitted") database.inTransaction = true;
          if (boundary !== "accepted") throw persistenceError;
          return { receipt, runtime, slackTerminalManifest: manifest };
        },
        setTimeout: (resume: () => void, delay: number) => {
          delays.push(delay);
          queueMicrotask(resume);
        },
      };
      const recoveryExports: Record<string, unknown> = {};
      for (const compiledModule of recoveryCompiled) {
        const module = { exports: {} as Record<string, unknown> };
        runInNewContext(compiledModule.outputText, { ...dependencies, module, exports: module.exports });
        Object.assign(recoveryExports, module.exports);
      }
      const h = await projectorFixture(recoveryExports);
      const terminal = (state: State, overrides: Record<string, unknown> = {}) =>
        h.terminal(state, {
          terminalRecovery: {
            mayRecover: () => owns,
            onState: (outcome: { status: string }) => persistenceStates.push(outcome.status),
            onOutputState: (outcome: { status: string }) => outputStates.push(outcome.status),
          },
          prepareTerminalManifest: () => ({
            responseId: "virtual-response",
            requestFingerprint: "virtual-manifest-fingerprint",
            turnId: receipt.turnId,
            kind: state === "completed" ? "final_answer" : "cancelled",
          }),
          ...overrides,
        });
      return {
        ...h,
        terminal,
        persistenceError,
        persistenceStates,
        outputStates,
        delays,
        recordCalls: () => recordCalls,
        snapshots: () => snapshots,
      };
    }

    it.each([
      { boundary: "accepted" as const, throwsUndefined: false },
      { boundary: "readback" as const, throwsUndefined: false },
      { boundary: "accepted" as const, throwsUndefined: true },
      { boundary: "readback" as const, throwsUndefined: true },
    ])(
      "captures before callback and awaits one cleanup after $boundary and owner loss (throw undefined: $throwsUndefined)",
      async ({ boundary, throwsUndefined }) => {
        const h = await joinedFixture(boundary, true);
        const original = throwsUndefined ? undefined : new Error("callback after owner loss");
        let callbacks = 0;
        let settled = false;
        let releaseCleanup!: () => void;
        let markCleanupStarted!: () => void;
        const cleanupStarted = new Promise<void>((resolve) => {
          markCleanupStarted = resolve;
        });
        const cleanupGate = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        const unlink = h.fs.unlink.bind(h.fs);
        h.fs.unlink = async (filePath) => {
          markCleanupStarted();
          await cleanupGate;
          await unlink(filePath);
        };
        const outcome = h
          .terminal("failed", {
            afterRecordEvent: () => {
              callbacks += 1;
              expect(h.reply.ownedMediaAllocations.size).toBe(0);
              expect(h.reply.media).toEqual([]);
              expect(h.reply.mediaKeys.size).toBe(0);
              expect(h.fs.operations.some((operation) => operation.op === "lstat")).toBe(false);
              throw original;
            },
          })
          .then(
            () => ({ rejected: false, error: undefined }),
            (error: unknown) => ({ rejected: true, error }),
          )
          .finally(() => {
            settled = true;
          });
        try {
          expect(await Promise.race([cleanupStarted.then(() => "cleanup"), outcome.then(() => "settled")])).toBe(
            "cleanup",
          );
          expect(settled).toBe(false);
          expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(true);
          expect(callbacks).toBe(1);
          expect(h.persistenceStates).toEqual(["recorded"]);
        } finally {
          releaseCleanup();
        }
        const result = await outcome;
        expect(result.rejected).toBe(true);
        expect(result.error).toBe(original);
        expect(callbacks).toBe(1);
        expect(h.persistenceStates).toEqual(["recorded"]);
        expect(h.recordCalls()).toBe(1);
        expect(h.snapshots()).toBe(boundary === "readback" ? 2 : 1);
        expect(h.delays).toEqual([]);
        expect(h.trace.filter((stage) => stage === "detach")).toHaveLength(1);
        expect(h.trace.filter((stage) => stage === "unlink")).toHaveLength(1);
        expect(h.trace).not.toContain("event");
        expect(h.trace).not.toContain("output");
        expect(h.fs.files.size).toBe(0);
        expect(h.allocator.prepareDiscard(h.allocated.allocation, h.reply)).toBeUndefined();
      },
    );

    it.each(["refused", "unknown", "uncommitted"] as const)(
      "does not acquire disposal authority at the simulated %s DB boundary",
      async (boundary) => {
        const h = await joinedFixture(boundary);
        await expect(h.terminal("failed")).rejects.toMatchObject({
          cause: h.persistenceError,
          outcome: { status: boundary === "refused" ? "non_retryable" : "outcome_unknown" },
        });
        expect(h.recordCalls()).toBe(1);
        expect(h.persistenceStates).not.toContain("recorded");
        expect(h.delays).toEqual(boundary === "refused" ? [] : [100]);
        expect(h.trace).toEqual([]);
        expect(h.pending()).toBe(true);
        expect(h.reply.ownedMediaAllocations.has(h.allocated.allocation)).toBe(true);
        expect(h.reply.media).toHaveLength(1);
        expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(true);
        expect(h.fs.operations.some((operation) => operation.op === "lstat" || operation.op === "unlink")).toBe(false);
      },
    );

    it("never captures a successor installed by the callback or retries the acknowledged terminal", async () => {
      const h = await joinedFixture("readback", true);
      const next = await h.allocate();
      const successor = {
        origin: { binding: { ...h.binding, turnId: "successor-turn" } },
        ownedMediaAllocations: new Set([next.allocation]),
        media: [next.attachment],
        mediaKeys: new Set([next.attachment.idempotencyKey]),
      };
      h.allocator.adopt(next, successor);
      await h.terminal("interrupted", { afterRecordEvent: () => h.replacePendingReply(successor) });
      await expect(h.terminal("interrupted")).rejects.toMatchObject({ outcome: { errorCode: "ALREADY_TERMINAL" } });
      expect(h.recordCalls()).toBe(1);
      expect(h.trace.filter((stage) => stage === "detach")).toHaveLength(1);
      expect(h.fs.operations.filter((operation) => operation.op === "unlink")).toEqual([
        { op: "unlink", filePath: h.allocated.attachment.filePath },
      ]);
      expect(h.pending()).toBe(true);
      expect(successor.ownedMediaAllocations.has(next.allocation)).toBe(true);
      expect(successor.media).toEqual([next.attachment]);
      expect(h.fs.files.has(next.attachment.filePath)).toBe(true);
    });

    it("does not capture an allocation returned under another binding", async () => {
      const h = await joinedFixture("accepted");
      h.reply.origin.binding = { ...h.binding, sessionKey: "other-session" };
      await h.terminal("interrupted");
      expect(h.persistenceStates).toEqual(["recorded"]);
      expect(h.trace.filter((stage) => stage === "callback")).toHaveLength(1);
      expect(h.reply.ownedMediaAllocations.has(h.allocated.allocation)).toBe(true);
      expect(h.reply.media).toHaveLength(1);
      expect(h.trace).not.toContain("unlink");
      expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(true);
    });

    it.each(["failed", "completed"] as const)(
      "keeps independent sinks and %s media settlement when output delivery is unknown",
      async (state) => {
        const h = await joinedFixture("accepted");
        h.faults.event = new Error("notification failure");
        h.faults.output = new Error("unknown output delivery");
        expect((await h.terminal(state))?.dispatchError).toBe(h.faults.event);
        expect(h.recordCalls()).toBe(1);
        expect(h.persistenceStates).toEqual(["recorded"]);
        expect(h.outputStates).toEqual(["outcome_unknown"]);
        expect(h.trace.filter((stage) => stage === "callback")).toHaveLength(1);
        expect(h.trace.filter((stage) => stage === "event")).toHaveLength(1);
        expect(h.trace.filter((stage) => stage === "output")).toHaveLength(1);
        expect(h.delays).toEqual([]);
        expect(h.trace.filter((stage) => stage === "unlink")).toHaveLength(state === "failed" ? 1 : 0);
        expect(h.fs.files.has(h.allocated.attachment.filePath)).toBe(state === "completed");
        expect(h.allocator.prepareDiscard(h.allocated.allocation, h.reply)).toBeUndefined();
      },
    );
  });
});
