import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { writePrivateTranscriptCopy } from "./pre-compact.js";

describe("PreCompact transcript copy", () => {
  it("is a 0600 file in a fresh 0700 directory, whatever the umask", () => {
    const previous = process.umask(0o022);
    let dir: string | undefined;
    try {
      const copy = writePrivateTranscriptCopy("agent:main:dm:5511900000000", "[User] segredo");
      dir = copy.dir;
      expect(dirname(copy.path)).toBe(copy.dir);
      expect(copy.dir.startsWith(tmpdir())).toBe(true);
      expect(statSync(copy.dir).mode & 0o777).toBe(0o700);
      expect(statSync(copy.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(copy.path, "utf8")).toBe("[User] segredo");
    } finally {
      process.umask(previous);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});
