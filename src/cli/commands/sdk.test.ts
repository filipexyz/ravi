import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitJson } from "../../sdk/openapi/index.js";
import { getRegistry } from "../registry-snapshot.js";
import { SdkOpenApiCommands } from "./sdk.js";

function makeTmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ravi-sdk-${label}-`));
}

function captureConsole(): { lines: string[]; errors: string[]; restore(): void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  return {
    lines,
    errors,
    restore() {
      console.log = log;
      console.error = err;
    },
  };
}

function captureStdout(): { chunks: string[]; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore() {
      process.stdout.write = original;
    },
  };
}

describe("SdkOpenApiCommands.emit", () => {
  it("writes the spec to a file when --out is provided", () => {
    const dir = makeTmpDir("emit");
    try {
      const target = join(dir, "openapi.json");
      const capture = captureConsole();
      try {
        new SdkOpenApiCommands().emit(target);
      } finally {
        capture.restore();
      }
      const onDisk = readFileSync(target, "utf8");
      expect(onDisk.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(onDisk);
      expect(parsed.openapi).toBe("3.1.0");
      expect(typeof parsed.info.version).toBe("string");
      expect(capture.lines.join("\n")).toContain(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints to stdout when --stdout is provided", () => {
    const stdout = captureStdout();
    let result: { status: string } | undefined;
    try {
      result = new SdkOpenApiCommands().emit(undefined, true) as { status: string };
    } finally {
      stdout.restore();
    }
    const out = stdout.chunks.join("");
    const parsed = JSON.parse(out);
    expect(parsed.openapi).toBe("3.1.0");
    expect(result?.status).toBe("stdout");
  });

  it("rejects --out and --stdout together", () => {
    const console = captureConsole();
    try {
      expect(() => new SdkOpenApiCommands().emit("foo.json", true)).toThrow(/Pick exactly one destination/);
    } finally {
      console.restore();
    }
  });
});

describe("SdkOpenApiCommands.check", () => {
  it("returns drift=false when stored matches the live registry", () => {
    const dir = makeTmpDir("check-clean");
    try {
      const target = join(dir, "openapi.json");
      writeFileSync(target, `${emitJson(getRegistry())}\n`, "utf8");
      const capture = captureConsole();
      let payload: { drift: boolean; path: string } | undefined;
      try {
        payload = new SdkOpenApiCommands().check(target, true) as { drift: boolean; path: string };
      } finally {
        capture.restore();
      }
      expect(payload?.drift).toBe(false);
      expect(payload?.path).toBe(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when stored drifts from the live registry", () => {
    const dir = makeTmpDir("check-drift");
    const target = join(dir, "openapi.json");
    writeFileSync(target, `{"openapi":"3.1.0","paths":{}}\n`, "utf8");
    const capture = captureConsole();
    const original = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("__exit_called__");
    }) as typeof process.exit;
    try {
      expect(() => new SdkOpenApiCommands().check(target)).toThrow(/__exit_called__/);
    } finally {
      process.exit = original;
      capture.restore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(exitCode).toBe(1);
    expect(capture.errors.join("\n")).toMatch(/drift/i);
  });

  it("requires --against", () => {
    const capture = captureConsole();
    try {
      expect(() => new SdkOpenApiCommands().check()).toThrow(/--against/);
    } finally {
      capture.restore();
    }
  });
});
