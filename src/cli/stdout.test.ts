import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { writeJsonToStdout } from "./stdout.js";

describe("writeJsonToStdout", () => {
  it("resolves only after the complete JSON document reaches the stream", async () => {
    const chunks: Buffer[] = [];
    let completed = false;
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        setTimeout(() => {
          chunks.push(Buffer.from(chunk));
          completed = true;
          callback();
        }, 5);
      },
    });
    const payload = { value: "x".repeat(1024 * 1024) };

    const write = writeJsonToStdout(payload, stream);
    expect(completed).toBe(false);
    await write;

    const output = Buffer.concat(chunks).toString("utf8");
    expect(completed).toBe(true);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual(payload);
  });

  it("rejects when the stream cannot complete the write", async () => {
    const stream = {
      once: () => stream,
      removeListener: () => stream,
      write: (_chunk: unknown, callback: (error?: Error | null) => void) => {
        callback(new Error("output unavailable"));
        return false;
      },
    };

    await expect(writeJsonToStdout({ ok: true }, stream as never)).rejects.toThrow("output unavailable");
  });
});
