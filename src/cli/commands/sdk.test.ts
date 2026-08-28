import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitJson } from "../../sdk/openapi/index.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { getRegistry } from "../registry-snapshot.js";
import { SdkClientCommands, SdkDartCommands, SdkOpenApiCommands, SdkSwiftCommands } from "./sdk.js";

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

  it("writes to the canonical docs snapshot when --out is omitted", () => {
    const dir = makeTmpDir("emit-default");
    const originalCwd = process.cwd();
    const capture = captureConsole();
    try {
      process.chdir(dir);
      const result = new SdkOpenApiCommands().emit() as { status: string; path: string };
      const target = join(process.cwd(), "docs", "openapi.json");
      expect(result).toMatchObject({ status: "written", path: target });
      expect(JSON.parse(readFileSync(target, "utf8")).openapi).toBe("3.1.0");
    } finally {
      process.chdir(originalCwd);
      capture.restore();
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
    const capture = captureConsole();
    const original = process.exit;
    process.exit = (() => {
      throw new Error("__exit_called__");
    }) as typeof process.exit;
    try {
      expect(() => new SdkOpenApiCommands().emit("foo.json", true)).toThrow(
        /Pick exactly one destination|__exit_called__/,
      );
    } finally {
      process.exit = original;
      capture.restore();
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

  it.each([false, true])("keeps OpenAPI drift as exit 1 with --json=%s", (asJson) => {
    const dir = makeTmpDir("check-drift");
    const target = join(dir, "openapi.json");
    writeFileSync(target, `{"openapi":"3.1.0","paths":{}}\n`, "utf8");
    const capture = captureConsole();
    let failure: unknown;
    try {
      runWithContext({ suppressCliOutput: false }, () => new SdkOpenApiCommands().check(target, asJson));
    } catch (error) {
      failure = error;
    } finally {
      capture.restore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ code: "OPENAPI_DRIFT", exitCode: 1, op: "sdk openapi check" });
    const rendered = [...capture.lines, ...capture.errors].join("\n");
    expect(rendered).toMatch(/drift/i);
    expect(rendered).not.toContain("Error:");
  });

  it("requires --against", () => {
    const capture = captureConsole();
    const original = process.exit;
    process.exit = (() => {
      throw new Error("__exit_called__");
    }) as typeof process.exit;
    try {
      expect(() => new SdkOpenApiCommands().check()).toThrow(/--against|__exit_called__/);
    } finally {
      process.exit = original;
      capture.restore();
    }
  });
});

describe("SdkClientCommands", () => {
  it.each([false, true])("keeps TypeScript SDK drift as exit 1 with --json=%s", (asJson) => {
    const dir = makeTmpDir("client-drift");
    const capture = captureConsole();
    try {
      new SdkClientCommands().generate(dir, "9.9.9", true);
    } finally {
      capture.restore();
    }
    writeFileSync(join(dir, "client.ts"), "// drift\n", "utf8");

    const checkCapture = captureConsole();
    let failure: unknown;
    try {
      runWithContext({ suppressCliOutput: false }, () => new SdkClientCommands().check(dir, "9.9.9", asJson));
    } catch (error) {
      failure = error;
    } finally {
      checkCapture.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ code: "SDK_CLIENT_DRIFT", exitCode: 1, op: "sdk client check" });
    expect([...checkCapture.lines, ...checkCapture.errors].join("\n")).not.toContain("Error:");
  });
});

describe("SdkSwiftCommands", () => {
  it("generates Swift SDK files and check reports no drift", () => {
    const dir = makeTmpDir("swift-generate");
    try {
      const capture = captureConsole();
      let generated: { status: string; files: { file: string; path: string }[] } | undefined;
      try {
        generated = new SdkSwiftCommands().generate(dir, "9.9.9", true) as {
          status: string;
          files: { file: string; path: string }[];
        };
      } finally {
        capture.restore();
      }

      expect(generated?.status).toBe("written");
      expect(generated?.files.map((entry) => entry.file).sort()).toEqual([
        "RaviClient.generated.swift",
        "RaviSchemas.generated.swift",
        "RaviStreaming.generated.swift",
        "RaviTypes.generated.swift",
        "RaviVersion.generated.swift",
      ]);
      expect(readFileSync(join(dir, "RaviClient.generated.swift"), "utf8")).toContain("public final class RaviClient");
      expect(readFileSync(join(dir, "RaviTypes.generated.swift"), "utf8")).toContain("public typealias");

      const checkCapture = captureConsole();
      let checked: { drift: unknown[] } | undefined;
      try {
        checked = new SdkSwiftCommands().check(dir, "9.9.9", true) as { drift: unknown[] };
      } finally {
        checkCapture.restore();
      }
      expect(checked?.drift).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("keeps Swift SDK drift as exit 1 with --json=%s", (asJson) => {
    const dir = makeTmpDir("swift-drift");
    try {
      const capture = captureConsole();
      try {
        new SdkSwiftCommands().generate(dir, "9.9.9", true);
      } finally {
        capture.restore();
      }
      writeFileSync(join(dir, "RaviClient.generated.swift"), "// drift\n", "utf8");

      const checkCapture = captureConsole();
      let failure: unknown;
      try {
        runWithContext({ suppressCliOutput: false }, () => new SdkSwiftCommands().check(dir, "9.9.9", asJson));
      } catch (error) {
        failure = error;
      } finally {
        checkCapture.restore();
      }
      expect(failure).toBeInstanceOf(ContractError);
      expect(failure).toMatchObject({ code: "SDK_SWIFT_DRIFT", exitCode: 1, op: "sdk swift check" });
      expect([...checkCapture.lines, ...checkCapture.errors].join("\n")).not.toContain("Error:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SdkDartCommands", () => {
  it("generates Dart SDK files and check reports no drift", () => {
    const dir = makeTmpDir("dart-generate");
    try {
      const capture = captureConsole();
      let generated: { status: string; files: { file: string; path: string }[] } | undefined;
      try {
        generated = new SdkDartCommands().generate(dir, "9.9.9", true) as {
          status: string;
          files: { file: string; path: string }[];
        };
      } finally {
        capture.restore();
      }

      expect(generated?.status).toBe("written");
      expect(generated?.files.map((entry) => entry.file).sort()).toEqual([
        "ravi_client.generated.dart",
        "ravi_schemas.generated.dart",
        "ravi_streaming.generated.dart",
        "ravi_types.generated.dart",
        "ravi_version.generated.dart",
      ]);
      expect(readFileSync(join(dir, "ravi_client.generated.dart"), "utf8")).toContain("class RaviClient");
      expect(readFileSync(join(dir, "ravi_types.generated.dart"), "utf8")).toContain("typedef");

      const checkCapture = captureConsole();
      let checked: { drift: unknown[] } | undefined;
      try {
        checked = new SdkDartCommands().check(dir, "9.9.9", true) as { drift: unknown[] };
      } finally {
        checkCapture.restore();
      }
      expect(checked?.drift).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("keeps Dart SDK drift as exit 1 with --json=%s", (asJson) => {
    const dir = makeTmpDir("dart-drift");
    try {
      const capture = captureConsole();
      try {
        new SdkDartCommands().generate(dir, "9.9.9", true);
      } finally {
        capture.restore();
      }
      writeFileSync(join(dir, "ravi_client.generated.dart"), "// drift\n", "utf8");

      const checkCapture = captureConsole();
      let failure: unknown;
      try {
        runWithContext({ suppressCliOutput: false }, () => new SdkDartCommands().check(dir, "9.9.9", asJson));
      } catch (error) {
        failure = error;
      } finally {
        checkCapture.restore();
      }
      expect(failure).toBeInstanceOf(ContractError);
      expect(failure).toMatchObject({ code: "SDK_DART_DRIFT", exitCode: 1, op: "sdk dart check" });
      expect([...checkCapture.lines, ...checkCapture.errors].join("\n")).not.toContain("Error:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
