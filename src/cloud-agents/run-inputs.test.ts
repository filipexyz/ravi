import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLOUD_RUN_FILES_MAX,
  CLOUD_RUN_FILES_MAX_BYTES,
  cloudFileMimeType,
  type PreparedCloudRunFiles,
  prepareCloudRunFiles,
  sanitizeCloudFileName,
} from "./run-inputs.js";

const CWD = "/agents/dev";
const STATE = "/home/me/.ravi";

function deps(files: Record<string, string | number>, insideCwdOnly = false) {
  return {
    cwd: CWD,
    insideCwdOnly,
    stateDir: STATE,
    fileSize: (path: string) => {
      const entry = files[path];
      if (entry === undefined) return null;
      return typeof entry === "number" ? entry : Buffer.byteLength(entry);
    },
    readFile: (path: string) => {
      const entry = files[path];
      return typeof entry === "number" ? new Uint8Array(entry) : new TextEncoder().encode(entry ?? "");
    },
  };
}

describe("file names and types", () => {
  it("keeps the base name with safe characters only", () => {
    expect(sanitizeCloudFileName("/x/y/relatório final.pdf")).toBe("relatorio final.pdf");
    expect(sanitizeCloudFileName("../../.env")).toBe("env");
    expect(sanitizeCloudFileName("a$b;c.txt")).toBe("a_b_c.txt");
    expect(sanitizeCloudFileName("...")).toBe("file");
    const long = sanitizeCloudFileName(`${"x".repeat(300)}.csv`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".csv")).toBe(true);
  });

  it("maps common extensions and leaves the rest unknown", () => {
    expect(cloudFileMimeType("a.PDF")).toBe("application/pdf");
    expect(cloudFileMimeType("a.csv")).toBe("text/csv");
    expect(cloudFileMimeType("a.bin")).toBeUndefined();
  });
});

describe("prepareCloudRunFiles", () => {
  it("reads files relative to the cwd into base64 with sizes for the plan", () => {
    const result = prepareCloudRunFiles(
      ["notes.md", "/tmp/data.csv"],
      deps({ "/agents/dev/notes.md": "# Oi", "/tmp/data.csv": "a,b" }),
    ) as PreparedCloudRunFiles;
    expect(result.files).toEqual([
      { name: "notes.md", contentBase64: Buffer.from("# Oi").toString("base64"), mimeType: "text/markdown" },
      { name: "data.csv", contentBase64: Buffer.from("a,b").toString("base64"), mimeType: "text/csv" },
    ]);
    expect(result.summary).toEqual([
      { name: "notes.md", size: 4 },
      { name: "data.csv", size: 3 },
    ]);
    expect(result.totalBytes).toBe(7);
  });

  it("refuses hidden paths, Ravi's state and missing files", () => {
    expect(prepareCloudRunFiles([".env"], deps({ "/agents/dev/.env": "X" }))).toContain("hidden files");
    expect(prepareCloudRunFiles(["/home/me/.ssh/id"], deps({ "/home/me/.ssh/id": "X" }))).toContain("hidden files");
    expect(prepareCloudRunFiles(["sub/.git/config"], deps({ "/agents/dev/sub/.git/config": "X" }))).toContain(
      "hidden files",
    );
    expect(prepareCloudRunFiles(["nope.txt"], deps({}))).toContain("no such file");
  });

  it("a cwd under a dot folder still sends its own files, never the state dir", () => {
    const underDot = { ...deps({ "/home/me/.ravi/agents/dev/a.txt": "x" }), cwd: "/home/me/.ravi/agents/dev" };
    expect(prepareCloudRunFiles(["a.txt"], underDot)).toContain("Ravi's own state");
    const otherDot = { ...deps({ "/home/me/.work/dev/a.txt": "x" }), cwd: "/home/me/.work/dev" };
    expect(typeof prepareCloudRunFiles(["a.txt"], otherDot)).toBe("object");
  });

  it("in another person's turn, only files inside the agent's folder", () => {
    const files = { "/tmp/x.txt": "x", "/agents/dev/in.txt": "y" };
    expect(prepareCloudRunFiles(["/tmp/x.txt"], deps(files, true))).toContain("only files inside the agent's folder");
    expect(typeof prepareCloudRunFiles(["in.txt"], deps(files, true))).toBe("object");
  });

  it("enforces the count, total size and unique names", () => {
    const many = Array.from({ length: CLOUD_RUN_FILES_MAX + 1 }, (_, index) => `f${index}.txt`);
    expect(prepareCloudRunFiles(many, deps({}))).toContain(`at most ${CLOUD_RUN_FILES_MAX} files`);
    const big = { "/agents/dev/a.bin": CLOUD_RUN_FILES_MAX_BYTES, "/agents/dev/b.bin": 1 };
    expect(typeof prepareCloudRunFiles(["a.bin"], deps(big))).toBe("object");
    expect(prepareCloudRunFiles(["a.bin", "b.bin"], deps(big))).toContain("more than 3 MB");
    expect(
      prepareCloudRunFiles(["a/r.txt", "b/R.txt"], deps({ "/agents/dev/a/r.txt": "1", "/agents/dev/b/R.txt": "2" })),
    ).toContain("two files would be named");
  });

  it("judges a symlink by where it points and reads its target", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-run-files-"));
    try {
      const cwd = join(root, "agent");
      const state = join(root, "state");
      mkdirSync(join(cwd, ".secret"), { recursive: true });
      mkdirSync(state);
      writeFileSync(join(cwd, ".secret", "key.txt"), "hidden");
      writeFileSync(join(state, "ravi.db"), "state");
      writeFileSync(join(root, "outside.txt"), "outside");
      writeFileSync(join(cwd, "real.txt"), "visible");
      symlinkSync(join(cwd, ".secret", "key.txt"), join(cwd, "to-hidden.txt"));
      symlinkSync(join(state, "ravi.db"), join(cwd, "to-state.txt"));
      symlinkSync(join(root, "outside.txt"), join(cwd, "to-outside.txt"));
      symlinkSync(join(cwd, "real.txt"), join(cwd, "alias.txt"));
      const real = { cwd, insideCwdOnly: true, stateDir: state };

      expect(prepareCloudRunFiles(["to-hidden.txt"], real)).toContain("hidden files");
      expect(prepareCloudRunFiles(["to-state.txt"], real)).toContain("Ravi's own state");
      expect(prepareCloudRunFiles(["to-outside.txt"], real)).toContain("only files inside the agent's folder");
      const ok = prepareCloudRunFiles(["alias.txt"], real) as PreparedCloudRunFiles;
      expect(ok.files[0]).toMatchObject({
        name: "alias.txt",
        contentBase64: Buffer.from("visible").toString("base64"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
