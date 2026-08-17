import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");
const actualRouterDbModule = await import("../../router/router-db.js");

let settingsStore: Record<string, string> = {};
const emitMock = mock(async () => {});

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  subscribe: mock(() => (async function* () {})()),
  nats: {
    emit: emitMock,
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
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
const { ContractError } = await import("../agent-contract.js");
const { getCommandAccessMetadata } = await import("../decorators.js");

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

    expect(output).toContain("Settings (14 returned of 14, limit 50, offset 0):");
    expect(output).toContain("account.main.dmPolicy: pairing");
    expect(output).toContain("section: legacy");
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

  it("registers a strict global model-broker-required switch", () => {
    const commands = new SettingsCommands();
    expect(() => commands.set("runtime.model_broker.required", "yes")).toThrow(/true, false/);
    expect(() => commands.set("runtime.model_broker.required", "true", true)).not.toThrow();
    expect(settingsStore["runtime.model_broker.required"]).toBe("true");
  });

  it("rejects writes to legacy account settings", () => {
    const commands = new SettingsCommands();

    expect(() => commands.set("account.main.dmPolicy", "closed")).toThrow(
      "Legacy setting shadowed by instances: account.main.dmPolicy. Use `ravi instances set main dmPolicy <value>` instead.",
    );
    expect(settingsStore["account.main.dmPolicy"]).toBeUndefined();
  });
});

describe("settings agent-first contract", () => {
  beforeEach(() => {
    settingsStore = {};
    emitMock.mockClear();
  });

  function capture<T>(run: () => T): { thrown?: unknown; result?: T } {
    const originalLog = console.log;
    console.log = () => {};
    try {
      return { result: run() };
    } catch (error) {
      return { thrown: error };
    } finally {
      console.log = originalLog;
    }
  }

  it("emits SETTING_NOT_FOUND envelope with suggestions on get --json (exit 1)", () => {
    const { thrown } = capture(() => new SettingsCommands().get("defaultAgnt", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("settings get");
    expect(envelope.error.code).toBe("SETTING_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("defaultAgent");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("still reads known-but-unset and legacy keys without a not-found envelope", () => {
    settingsStore = { "account.main.dmPolicy": "pairing" };
    const commands = new SettingsCommands();

    const known = capture(() => commands.get("defaultAgent", true));
    expect(known.thrown).toBeUndefined();

    const legacy = capture(() => commands.get("account.other.dmPolicy", true));
    expect(legacy.thrown).toBeUndefined();
  });

  it("blocks settings delete without --execute (dry-run, exit 3, no write)", () => {
    settingsStore = { "custom.password": "SENTINEL_SECRET_7M4Q" };
    const { thrown } = capture(() => new SettingsCommands().delete("custom.password", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(3);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("settings delete");
    expect(envelope.error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(envelope.error.dryRun).toBe(true);
    expect(envelope.error.plan).toEqual({
      key: "custom.password",
      valuePresent: true,
      legacy: false,
      known: false,
    });
    expect(JSON.stringify(envelope.error.plan)).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(settingsStore["custom.password"]).toBe("SENTINEL_SECRET_7M4Q");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("declares the setting value as redacted command input", () => {
    expect(getCommandAccessMetadata(SettingsCommands).get("set")).toMatchObject({
      kind: "mutate",
      resource: "settings",
      action: "set",
      redactions: ["value"],
    });
  });

  it("deletes with --execute and emits config change", () => {
    settingsStore = { "custom.featureFlag": "on" };
    const { thrown, result } = capture(() => new SettingsCommands().delete("custom.featureFlag", true, true));

    expect(thrown).toBeUndefined();
    expect(result).toMatchObject({ status: "deleted", changedCount: 1 });
    expect(settingsStore["custom.featureFlag"]).toBeUndefined();
    expect(emitMock).toHaveBeenCalled();
  });

  it("fails delete of an unset key with SETTING_NOT_FOUND before the brake (exit 1, never 3)", () => {
    settingsStore = { "custom.featureFlag": "on" };
    const { thrown } = capture(() => new SettingsCommands().delete("custom.featureFlg", true));

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as InstanceType<typeof ContractError>;
    expect(contractError.exitCode).toBe(1);
    expect(contractError.envelope().error.code).toBe("SETTING_NOT_FOUND");
    expect(contractError.envelope().error.suggestions).toContain("custom.featureFlag");
  });

  it("supports --fields compact mode on settings list", () => {
    settingsStore = { "custom.featureFlag": "on" };
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      if (typeof value === "string") lines.push(value);
    };
    try {
      new SettingsCommands().list(false, true, undefined, undefined, "key,value");
    } finally {
      console.log = originalLog;
    }
    const payload = JSON.parse(lines.join("\n")) as { items: Array<Record<string, unknown>> };
    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of payload.items) {
      expect(Object.keys(item).sort()).toEqual(["key", "value"]);
    }
  });
});
