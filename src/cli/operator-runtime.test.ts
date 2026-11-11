import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "./context.js";
import { isLocalRecoveryCommand, usesInstalledOperatorTransport } from "./operator-runtime.js";

const fixture = mkdtempSync(join(tmpdir(), "ravi-operator-provenance-"));
const homeDir = join(fixture, "home");
const stateDir = join(homeDir, ".ravi");
mkdirSync(stateDir, { recursive: true });

function packageFixture(name: string, marker?: "src" | ".git"): string {
  const root = join(fixture, name);
  mkdirSync(join(root, "dist", "bundle"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot" }));
  const entry = join(root, "dist", "bundle", "index.js");
  writeFileSync(entry, "");
  if (marker === "src") mkdirSync(join(root, marker));
  if (marker === ".git") writeFileSync(join(root, marker), "gitdir: ../checkout/.git");
  return entry;
}

const installed = packageFixture("installed");
const options = { modulePath: installed, homeDir, runtimeInvocation: false };

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("installed operator transport", () => {
  it("selects the gateway only for installed code targeting canonical real state", () => {
    expect(usesInstalledOperatorTransport({}, options)).toBe(true);
    expect(usesInstalledOperatorTransport({ RAVI_STATE_DIR: stateDir }, options)).toBe(true);
    const alias = join(fixture, "state-alias");
    symlinkSync(stateDir, alias);
    expect(usesInstalledOperatorTransport({ RAVI_STATE_DIR: alias }, options)).toBe(true);
    expect(usesInstalledOperatorTransport({ RAVI_STATE_DIR: join(fixture, "isolated") }, options)).toBe(false);
    expect(usesInstalledOperatorTransport({ HOME: join(fixture, "isolated-home") }, options)).toBe(false);
    expect(
      usesInstalledOperatorTransport({ HOME: join(fixture, "isolated-home"), RAVI_STATE_DIR: stateDir }, options),
    ).toBe(true);
  });

  it("does not promote source trees, worktrees or unknown code to an installed operator", () => {
    for (const marker of ["src", ".git"] as const) {
      expect(usesInstalledOperatorTransport({}, { ...options, modulePath: packageFixture(marker, marker) })).toBe(
        false,
      );
    }
    expect(usesInstalledOperatorTransport({}, { ...options, modulePath: join(fixture, "unknown.js") })).toBe(false);
  });

  it("does not replace explicit gateway or runtime authority with a local operator", () => {
    for (const key of [
      "RAVI_CONTEXT_KEY",
      "RAVI_GATEWAY_URL",
      "RAVI_SESSION_KEY",
      "RAVI_SESSION_NAME",
      "RAVI_AGENT_ID",
    ]) {
      expect(usesInstalledOperatorTransport({ [key]: "explicit-authority" }, options)).toBe(false);
    }
    expect(usesInstalledOperatorTransport({}, { ...options, runtimeInvocation: true })).toBe(false);
    for (const transport of ["tool", "gateway"] as const) {
      expect(
        runWithContext({ transport }, () => usesInstalledOperatorTransport({}, { modulePath: installed, homeDir })),
      ).toBe(false);
    }
  });

  it("limits offline recovery to service lifecycle and inspection", () => {
    for (const group of ["daemon", "channels"]) {
      for (const command of ["start", "stop", "restart", "status", "logs"]) {
        expect(isLocalRecoveryCommand(group, command)).toBe(true);
      }
      expect(isLocalRecoveryCommand(group, "run")).toBe(false);
    }
    expect(isLocalRecoveryCommand("daemon", "admin-key")).toBe(false);
    expect(isLocalRecoveryCommand("agents", "create")).toBe(false);
    expect(isLocalRecoveryCommand("unknown", "status")).toBe(false);
  });
});
