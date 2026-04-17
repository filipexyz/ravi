import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");
const actualRouterDbModule = await import("../../router/router-db.js");

let settingsStore: Record<string, string> = {};
const emitMock = mock(async () => {});

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: emitMock,
  },
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbGetSetting: (key: string) => settingsStore[key] ?? null,
  dbSetSetting: (key: string, value: string) => {
    settingsStore[key] = value;
  },
  dbDeleteSetting: (key: string) => {
    const exists = key in settingsStore;
    if (exists) {
      delete settingsStore[key];
    }
    return exists;
  },
  dbListSettings: () => ({ ...settingsStore }),
  dbGetAgent: (id: string) => (id === "main" || id === "sales" ? { id } : null),
  dbListAgents: () => [{ id: "main" }, { id: "sales" }],
  DmScopeSchema: {
    options: ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"],
    safeParse: (value: string) =>
      ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"].includes(value)
        ? { success: true }
        : { success: false },
  },
}));

const { SettingsCommands } = await import("./settings.js");

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

describe("SettingsCommands", () => {
  beforeEach(() => {
    settingsStore = {};
    emitMock.mockClear();
  });

  it("hides legacy account settings from the default list output", () => {
    settingsStore = {
      "account.main.dmPolicy": "pairing",
      "custom.featureFlag": "on",
    };

    const output = captureLogs(() => {
      new SettingsCommands().list();
    });

    expect(output).toContain("Legacy account.* settings hidden by default");
    expect(output).not.toContain("account.main.dmPolicy: pairing");
    expect(output).toContain("custom.featureFlag: on");
  });

  it("shows legacy account settings only when --legacy is requested", () => {
    settingsStore = {
      "account.main.dmPolicy": "pairing",
    };

    const output = captureLogs(() => {
      new SettingsCommands().list(true);
    });

    expect(output).toContain("Legacy settings shadowed by instances:");
    expect(output).toContain("account.main.dmPolicy: pairing");
  });

  it("labels legacy reads as shadowed by instances", () => {
    settingsStore = {
      "account.main.dmPolicy": "pairing",
    };

    const output = captureLogs(() => {
      new SettingsCommands().get("account.main.dmPolicy");
    });

    expect(output).toContain("Legacy setting shadowed by instances: account.main.dmPolicy: pairing");
    expect(output).toContain("Use `ravi instances set main dmPolicy <value>` instead.");
  });

  it("rejects writes to legacy account settings", () => {
    const commands = new SettingsCommands();

    expect(() => commands.set("account.main.dmPolicy", "closed")).toThrow(
      "Legacy setting shadowed by instances: account.main.dmPolicy. Use `ravi instances set main dmPolicy <value>` instead.",
    );
    expect(settingsStore["account.main.dmPolicy"]).toBeUndefined();
  });
});
