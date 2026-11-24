import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSetup, type SetupSteps, stateIsReady } from "./setup.js";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const originalLog = console.log;
afterEach(() => {
  console.log = originalLog;
});

/** Runs the wizard with recording steps; `stateReady` is what the daemon step left behind. */
async function runRecorded(stateReady: boolean): Promise<{ calls: string[]; output: string }> {
  const calls: string[] = [];
  const lines: string[] = [];
  const step = (name: string) => async () => {
    calls.push(name);
  };
  const steps: SetupSteps = {
    omni: step("omni"),
    environment: step("environment"),
    daemon: step("daemon"),
    stateReady: async () => {
      calls.push("stateReady");
      return stateReady;
    },
    agent: step("agent"),
    settings: step("settings"),
  };
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  await runSetup(steps);
  console.log = originalLog;
  return { calls, output: lines.join("\n").replace(ANSI, "") };
}

describe("runSetup order", () => {
  it("starts the daemon before any step that reads state", async () => {
    const { calls } = await runRecorded(true);

    // On a new machine the daemon creates the state database and the CLI never does, so a step that reads
    // the agent or the settings before the daemon has run ends the wizard with STATE_SCHEMA_NOT_READY.
    expect(calls).toEqual(["omni", "environment", "daemon", "stateReady", "agent", "settings"]);
    expect(calls.indexOf("agent")).toBeGreaterThan(calls.indexOf("daemon"));
    expect(calls.indexOf("settings")).toBeGreaterThan(calls.indexOf("daemon"));
  });

  it("says the setup is complete when the state is ready", async () => {
    const { output } = await runRecorded(true);

    expect(output).toContain("Configuração completa!");
    expect(output).not.toContain("Configuração incompleta");
  });

  it("skips the agent and settings, and says so, when the daemon did not prepare the state", async () => {
    const { calls, output } = await runRecorded(false);

    expect(calls).toEqual(["omni", "environment", "daemon", "stateReady"]);
    expect(output).toContain("Configuração incompleta");
    expect(output).not.toContain("Configuração completa!");
    expect(output).toContain("ravi daemon logs");
    expect(output).toContain("ravi setup");
  });
});

describe("stateIsReady", () => {
  it("is true when the state can be read", async () => {
    expect(await stateIsReady(() => "America/Sao_Paulo")).toBe(true);
    expect(await stateIsReady(async () => null)).toBe(true);
  });

  it("is false while the state is not prepared, also when that refusal is the cause of another error", async () => {
    const notReady = Object.assign(new Error("STATE_SCHEMA_NOT_READY: ravi.db does not exist"), {
      code: "STATE_SCHEMA_NOT_READY",
    });

    expect(
      await stateIsReady(() => {
        throw notReady;
      }),
    ).toBe(false);
    expect(
      await stateIsReady(async () => {
        throw new Error("wrapped", { cause: notReady });
      }),
    ).toBe(false);
  });

  it("does not hide any other failure as 'not ready yet'", async () => {
    await expect(
      stateIsReady(() => {
        throw new Error("disk I/O error");
      }),
    ).rejects.toThrow("disk I/O error");
  });
});

describe("install guide", () => {
  const guide = readFileSync(join(repoRoot, "docs", "start", "install.mdx"), "utf8");

  it("lists the daemon before the steps that read state in the wizard table", () => {
    const at = (needle: string) => guide.indexOf(needle);

    expect(at("| 3. Daemon |")).toBeGreaterThan(-1);
    expect(at("| 3. Daemon |")).toBeLessThan(at("| 4. Agente |"));
    expect(at("| 4. Agente |")).toBeLessThan(at("| 5. Configurações |"));
  });

  it("starts the daemon before it writes any setting on the Slack-only path", () => {
    const section = guide.slice(guide.indexOf("## Run without Omni"));
    const lines = section.split("\n").map((line) => line.trim());
    const daemonStart = lines.findIndex((line) => line.startsWith("ravi daemon start"));
    const settingsSet = lines.findIndex((line) => line.startsWith("ravi settings set"));

    // `ravi settings set` before `ravi daemon start` fails on a new machine: the daemon creates the state it writes to.
    expect(daemonStart).toBeGreaterThanOrEqual(0);
    expect(settingsSet).toBeGreaterThan(daemonStart);
  });
});
