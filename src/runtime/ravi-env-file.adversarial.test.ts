import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as writer from "./ravi-env-file.js";

// Execute the actual consumer without importing daemon.ts and starting services.
// A change to the loader's boundaries intentionally requires updating this test.
const daemonSource = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
const loaderStart = daemonSource.indexOf("function loadEnvFile()");
const loaderEnd = daemonSource.indexOf("\nloadEnvFile();", loaderStart);
if (loaderStart < 0 || loaderEnd < 0) throw new Error("Daemon env-loader fixture is out of date");
const daemonLoader = new Function(
  "process",
  "join",
  "getRaviStateDir",
  "existsSync",
  "readFileSync",
  "log",
  `${daemonSource.slice(loaderStart, loaderEnd)}\nloadEnvFile();`,
);
const writerPath = new URL("./ravi-env-file.ts", import.meta.url).pathname;

function loadWithDaemon(stateDir: string): Record<string, string> {
  const processFixture = { env: {} as Record<string, string> };
  daemonLoader(processFixture, join, () => stateDir, existsSync, readFileSync, { info() {} });
  return processFixture.env;
}

type ChildResult = { ok: boolean; code?: string; message?: string };

// No inherited runtime secrets or automatic .env loading enter these processes.
function runChild(source: string, cwd: string, timeout = 4_000): string {
  const child = spawnSync([process.execPath, "--no-env-file", "--eval", source], {
    cwd,
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  return child.stdout.toString().trim();
}

function operationSource(stateDir: string, operation: string, key: string, value: string): string {
  return `
    const writer = await import(${JSON.stringify(writerPath)});
    try {
      writer[${JSON.stringify(operation)}](${JSON.stringify(key)}, ${JSON.stringify(value)}, { RAVI_STATE_DIR: ${JSON.stringify(stateDir)} });
      console.log(JSON.stringify({ok: true}));
    } catch (error) {
      console.log(JSON.stringify({ok: false, code: error.code, message: error.message}));
    }
  `;
}

describe("ravi-env-file adversarial regressions", () => {
  let root: string;
  let stateDir: string;
  let envFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    // macOS /var and /tmp are platform aliases, not adversarial ancestors.
    root = mkdtempSync(join(realpathSync(tmpdir()), "ravi-env-adversarial-"));
    stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    envFile = join(stateDir, ".env");
    env = { RAVI_STATE_DIR: stateDir };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(content: string): void {
    writeFileSync(envFile, content, { mode: 0o600 });
  }

  function expectUnchangedRejection(operation: () => unknown, before: string): void {
    expect(operation).toThrow();
    expect(readFileSync(envFile, "utf8")).toBe(before);
    expect(env.CODEX_HOME).toBeUndefined();
  }

  for (const value of [
    "say \"hi\" and 'hello'",
    "C:\\synthetic\\folder\\token",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The consumer must preserve literal placeholders.
    "$SYNTHETIC ${NOT_EXPANDED} #hash=literal",
    "  leading and trailing spaces  ",
    "ação-東京-🔑",
    '"entirely quoted"',
    "'single quotes'",
    " ",
  ]) {
    it(`round-trips literal consumer bytes for ${JSON.stringify(value)}`, () => {
      writer.setRaviEnvKey("CODEX_HOME", value, env);
      expect(loadWithDaemon(stateDir).CODEX_HOME).toBe(value);
      expect(writer.getRaviEnvKey("CODEX_HOME", env).value).toBe(value);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    });
  }

  it("patches only the target assignment and preserves mixed newlines, formatting and final bytes", () => {
    const prefix = '# heading  \r\n\nSIBLING_ONE = \'say "hi"\'\r\nSIBLING_TWO="C:\\literal\\path"\n';
    const suffix = "HASH_DOLLAR=$UNCHANGED # literal=value\r\nLOWER_case=ação\r\nLAST=without-newline";
    seed(`${prefix}CODEX_HOME=/synthetic/old\r\n${suffix}`);
    const beforeLoaded = loadWithDaemon(stateDir);
    writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env);
    const after = readFileSync(envFile, "utf8");
    expect(after).toBe(`${prefix}CODEX_HOME=/synthetic/new\r\n${suffix}`);
    expect(loadWithDaemon(stateDir)).toEqual({ ...beforeLoaded, CODEX_HOME: "/synthetic/new" });
  });

  it("unsets only the target physical line without reserializing its siblings", () => {
    const prefix = "# keep spaces  \r\nQUOTED='two \"quotes\"'\r\n";
    const suffix = "BACKSLASH=C:\\literal\\path\nLAST=$literal #=end";
    seed(`${prefix}CODEX_HOME=/synthetic/old\r\n${suffix}`);
    writer.unsetRaviEnvKey("CODEX_HOME", env);
    expect(readFileSync(envFile, "utf8")).toBe(prefix + suffix);
  });

  it("adds after a file without trailing LF while preserving every existing byte", () => {
    const before = "# retained\r\nQUOTED='say \"hi\"'\r\nLAST=$literal #x=y";
    seed(before);
    const loaded = loadWithDaemon(stateDir);
    writer.addRaviEnvKey("CODEX_HOME", "/synthetic/new", env);
    expect(readFileSync(envFile, "utf8").startsWith(before)).toBe(true);
    expect(loadWithDaemon(stateDir)).toEqual({ ...loaded, CODEX_HOME: "/synthetic/new" });
  });

  it("keeps unrelated duplicate assignments byte-for-byte or rejects without writing", () => {
    const before = "SIBLING=first\r\nSIBLING='last \\\\ literal'\r\n";
    seed(before);
    const loaded = loadWithDaemon(stateDir);
    try {
      writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env);
    } catch {
      expect(readFileSync(envFile, "utf8")).toBe(before);
      return;
    }
    expect(readFileSync(envFile, "utf8").startsWith(before)).toBe(true);
    expect(loadWithDaemon(stateDir)).toEqual({ ...loaded, CODEX_HOME: "/synthetic/new" });
  });

  it("preserves export syntax according to the real consumer or rejects it unchanged", () => {
    const before = 'export SIBLING="literal $VALUE"\r\n';
    seed(before);
    const loaded = loadWithDaemon(stateDir);
    try {
      writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env);
    } catch {
      expect(readFileSync(envFile, "utf8")).toBe(before);
      return;
    }
    expect(readFileSync(envFile, "utf8").startsWith(before)).toBe(true);
    expect(loadWithDaemon(stateDir)).toEqual({ ...loaded, CODEX_HOME: "/synthetic/new" });
  });

  for (const before of [
    'MULTILINE="first\nCODEX_HOME=not-an-assignment\nlast"\n',
    "BROKEN='unterminated\n",
    "CODEX_HOME=first\nCODEX_HOME=second\n",
  ]) {
    it(`rejects ambiguous existing syntax without editing: ${JSON.stringify(before)}`, () => {
      seed(before);
      expectUnchangedRejection(() => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env), before);
      expectUnchangedRejection(() => writer.unsetRaviEnvKey("CODEX_HOME", env), before);
      expectUnchangedRejection(() => writer.addRaviEnvKey("CODEX_HOME", "/synthetic/new", env), before);
    });
  }

  for (const value of [
    "first\nsecond",
    "first\rsecond",
    "first\0second",
    "first\uFEFFsecond",
    "first\u2028second",
    "first\u2029second",
    "first\uD800second",
  ]) {
    it(`rejects an unrepresentable value without editing: ${JSON.stringify(value)}`, () => {
      const before = "SIBLING=unchanged\n";
      seed(before);
      expectUnchangedRejection(() => writer.setRaviEnvKey("CODEX_HOME", value, env), before);
    });
  }

  for (const existing of ["", "/synthetic/existing"]) {
    it(`add-only refuses an existing ${existing ? "populated" : "empty"} key`, () => {
      const before = `CODEX_HOME=${existing}\nSIBLING=unchanged\n`;
      seed(before);
      expectUnchangedRejection(() => writer.addRaviEnvKey("CODEX_HOME", "/synthetic/new", env), before);
    });
  }

  function interleavedWriters(operation: "setRaviEnvKey" | "addRaviEnvKey", sameKey: boolean) {
    seed("SIBLING=unchanged\n");
    const firstKey = "CODEX_HOME";
    const secondKey = sameKey ? firstKey : "GROK_HOME";
    const secondSource = operationSource(stateDir, operation, secondKey, "/synthetic/second");
    const source = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const original = {...fs};
      const target = ${JSON.stringify(envFile)};
      const originalStat = original.statSync(target);
      let armed = true;
      let second;
      mock.module("node:fs", () => ({...original, readFileSync(path, options) {
        const bytes = original.readFileSync(path, options);
        const stat = typeof path === "number" ? original.fstatSync(path) : undefined;
        const matches = path === target || (stat?.ino === originalStat.ino && stat?.dev === originalStat.dev);
        if (armed && matches) {
          armed = false;
          const child = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", ${JSON.stringify(secondSource)}], {
            cwd: ${JSON.stringify(root)}, env: {PATH: "/usr/bin:/bin"}, stdout: "pipe", stderr: "pipe", timeout: 2000
          });
          if (child.exitCode !== 0) throw new Error("Second writer process failed");
          second = JSON.parse(child.stdout.toString());
        }
        return bytes;
      }}));
      const writer = await import(${JSON.stringify(writerPath)});
      let first;
      try {
        writer[${JSON.stringify(operation)}](${JSON.stringify(firstKey)}, "/synthetic/first", {RAVI_STATE_DIR: ${JSON.stringify(stateDir)}});
        first = {ok: true};
      } catch (error) { first = {ok: false, code: error.code}; }
      console.log(JSON.stringify({interleaved: !armed, first, second}));
    `;
    return JSON.parse(runChild(source, root)) as {
      interleaved: boolean;
      first: ChildResult;
      second: ChildResult;
    };
  }

  it("does not lose successful writes when another process writes a different key", () => {
    const result = interleavedWriters("setRaviEnvKey", false);
    expect(result.interleaved).toBe(true);
    expect(result.first.ok || result.second.ok).toBe(true);
    const loaded = loadWithDaemon(stateDir);
    expect(loaded.SIBLING).toBe("unchanged");
    if (result.first.ok) expect(loaded.CODEX_HOME).toBe("/synthetic/first");
    else expect(result.first.code).toMatch(/BUSY|CONFLICT/);
    if (result.second.ok) expect(loaded.GROK_HOME).toBe("/synthetic/second");
    else expect(result.second.code).toMatch(/BUSY|CONFLICT/);
  });

  it("allows exactly one add-only winner across processes for the same key", () => {
    const result = interleavedWriters("addRaviEnvKey", true);
    expect(result.interleaved).toBe(true);
    expect(Number(result.first.ok) + Number(result.second.ok)).toBe(1);
    const winner = result.first.ok ? "/synthetic/first" : "/synthetic/second";
    expect(loadWithDaemon(stateDir).CODEX_HOME).toBe(winner);
    expect(loadWithDaemon(stateDir).SIBLING).toBe("unchanged");
  });

  it("detects a noncooperating process edit after the captured snapshot before rename", () => {
    seed("SIBLING=original\n");
    const edited = "SIBLING=external\n";
    const source = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const original = {...fs};
      const target = ${JSON.stringify(envFile)};
      const initial = original.statSync(target);
      let armed = true;
      mock.module("node:fs", () => ({...original, readFileSync(path, options) {
        const bytes = original.readFileSync(path, options);
        const stat = typeof path === "number" ? original.fstatSync(path) : undefined;
        if (armed && (path === target || (stat?.ino === initial.ino && stat?.dev === initial.dev))) {
          armed = false;
          const edit = ${JSON.stringify(`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(envFile)}, ${JSON.stringify(edited)});`)};
          const child = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", edit], {
            cwd: ${JSON.stringify(root)}, env: {PATH: "/usr/bin:/bin"}, stdout: "pipe", stderr: "pipe", timeout: 2000
          });
          if (child.exitCode !== 0) throw new Error("External editor process failed");
        }
        return bytes;
      }}));
      const writer = await import(${JSON.stringify(writerPath)});
      let result;
      try {
        writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", {RAVI_STATE_DIR: ${JSON.stringify(stateDir)}});
        result = {ok: true};
      } catch (error) { result = {ok: false, code: error.code}; }
      console.log(JSON.stringify({interleaved: !armed, ...result}));
    `;
    const result = JSON.parse(runChild(source, root));
    expect(result.interleaved).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/CONFLICT/);
    expect(readFileSync(envFile, "utf8")).toBe(edited);
  });

  it("rejects a symlink target without replacing the link or editing its target", () => {
    const outside = join(root, "outside");
    writeFileSync(outside, "SIBLING=unchanged\n", { mode: 0o600 });
    symlinkSync(outside, envFile);
    expect(() => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env)).toThrow();
    expect(lstatSync(envFile).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("SIBLING=unchanged\n");
  });

  it("rejects a symlink state directory without writing or chmod of the target", () => {
    const alias = join(root, "state-link");
    symlinkSync(stateDir, alias);
    const originalMode = statSync(stateDir).mode;
    expect(() => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", { RAVI_STATE_DIR: alias })).toThrow();
    expect(existsSync(envFile)).toBe(false);
    expect(statSync(stateDir).mode).toBe(originalMode);
  });

  it("rejects a symlink in an ancestor, even with a regular state directory below it", () => {
    const alias = join(root, "ancestor-link");
    const physical = join(root, "physical");
    mkdirSync(physical, { mode: 0o700 });
    const nested = join(physical, "nested");
    mkdirSync(nested, { mode: 0o700 });
    symlinkSync(physical, alias);
    expect(() =>
      writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", { RAVI_STATE_DIR: join(alias, "nested") }),
    ).toThrow();
    expect(existsSync(join(nested, ".env"))).toBe(false);
  });

  it("rejects a multiply-linked target without changing either pathname", () => {
    seed("SIBLING=unchanged\n");
    const alias = join(root, "hardlink");
    linkSync(envFile, alias);
    expect(() => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env)).toThrow();
    expect(readFileSync(envFile, "utf8")).toBe("SIBLING=unchanged\n");
    expect(readFileSync(alias, "utf8")).toBe("SIBLING=unchanged\n");
    expect(statSync(envFile).nlink).toBe(2);
  });

  it("rejects a FIFO promptly rather than opening it for a blocking read", () => {
    const fifo = spawnSync(["/usr/bin/mkfifo", envFile], { stdout: "pipe", stderr: "pipe" });
    expect(fifo.exitCode).toBe(0);
    const result = JSON.parse(
      runChild(operationSource(stateDir, "setRaviEnvKey", "CODEX_HOME", "/synthetic/new"), root, 2_000),
    );
    expect(result.ok).toBe(false);
    expect(lstatSync(envFile).isFIFO()).toBe(true);
  });

  it("refuses an insecure existing directory without silently chmodding it", () => {
    chmodSync(stateDir, 0o777);
    expect(() => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env)).toThrow();
    expect(statSync(stateDir).mode & 0o777).toBe(0o777);
    expect(existsSync(envFile)).toBe(false);
  });

  it("refuses an insecure existing env file without silently chmodding it", () => {
    seed("SIBLING=unchanged\n");
    chmodSync(envFile, 0o666);
    expect(() => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env)).toThrow();
    expect(readFileSync(envFile, "utf8")).toBe("SIBLING=unchanged\n");
    expect(statSync(envFile).mode & 0o777).toBe(0o666);
  });

  it("fails closed on an orphan lock instead of stealing or deleting it", () => {
    const before = "SIBLING=unchanged\n";
    seed(before);
    const lock = `${envFile}.lock`;
    writeFileSync(lock, "synthetic-orphan-lock", { mode: 0o600 });
    utimesSync(lock, new Date("2000-01-01"), new Date("2000-01-01"));
    const oldLock = statSync(lock);
    for (const operation of [
      () => writer.setRaviEnvKey("CODEX_HOME", "/synthetic/new", env),
      () => writer.addRaviEnvKey("CODEX_HOME", "/synthetic/new", env),
      () => writer.unsetRaviEnvKey("CODEX_HOME", env),
    ]) {
      expectUnchangedRejection(operation, before);
      expect(readFileSync(lock, "utf8")).toBe("synthetic-orphan-lock");
      expect(statSync(lock).ino).toBe(oldLock.ino);
      expect(statSync(lock).mtimeMs).toBe(oldLock.mtimeMs);
    }
  });

  it("does not follow, overwrite or clean up a preexisting temporary symlink", () => {
    const before = "SIBLING=unchanged\n";
    seed(before);
    const outside = join(root, "outside-temp-target");
    const canary = "synthetic-private-outside-canary";
    writeFileSync(outside, canary, { mode: 0o600 });
    const temporary = `${envFile}.synthetic-collision.tmp`;
    symlinkSync(outside, temporary);
    const source = `
      import * as crypto from "node:crypto";
      import { mock } from "bun:test";
      const original = {...crypto};
      mock.module("node:crypto", () => ({...original, randomUUID: () => "synthetic-collision"}));
      ${operationSource(stateDir, "setRaviEnvKey", "CODEX_HOME", "/synthetic/new")}
    `;
    const result = JSON.parse(runChild(source, root)) as ChildResult;
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(canary);
    expect(readFileSync(envFile, "utf8")).toBe(before);
    expect(readFileSync(outside, "utf8")).toBe(canary);
    expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
    expect(existsSync(`${envFile}.lock`)).toBe(false);
  });

  it("detects replacement of the parent directory before commit", () => {
    const before = "SIBLING=original\n";
    const replacement = "SIBLING=replacement\n";
    seed(before);
    const moved = join(root, "moved-state");
    const source = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const original = {...fs};
      let swapped = false;
      mock.module("node:fs", () => ({...original, writeFileSync(path, ...args) {
        const result = original.writeFileSync(path, ...args);
        if (!swapped && typeof path === "number") {
          swapped = true;
          original.renameSync(${JSON.stringify(stateDir)}, ${JSON.stringify(moved)});
          original.mkdirSync(${JSON.stringify(stateDir)}, {mode: 0o700});
          original.writeFileSync(${JSON.stringify(envFile)}, ${JSON.stringify(replacement)}, {mode: 0o600});
        }
        return result;
      }}));
      ${operationSource(stateDir, "setRaviEnvKey", "CODEX_HOME", "/synthetic/new")}
      console.log(JSON.stringify({swapped}));
    `;
    const lines = runChild(source, root).split("\n");
    expect(JSON.parse(lines[0]!).ok).toBe(false);
    expect(JSON.parse(lines[1]!).swapped).toBe(true);
    expect(readFileSync(envFile, "utf8")).toBe(replacement);
    expect(readFileSync(join(moved, ".env"), "utf8")).toBe(before);
  });
});
