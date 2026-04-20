/**
 * Settings Commands - Global settings management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { nats } from "../../nats.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}
import {
  dbGetSetting,
  dbSetSetting,
  dbDeleteSetting,
  dbListSettings,
  dbGetAgent,
  dbListAgents,
  DmScopeSchema,
} from "../../router/router-db.js";

const GROUP_POLICIES = ["open", "allowlist", "closed"] as const;
const DM_POLICIES = ["open", "pairing", "closed"] as const;
const INSTANCE_SETTING_FIELDS = new Set(["agent", "instanceId", "dmPolicy", "groupPolicy", "dmScope", "channel"]);

// Validate timezone by trying to use it with Intl
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const KNOWN_SETTINGS: Record<string, { description: string; validate?: (value: string) => void }> = {
  defaultAgent: {
    description: "Default agent when no route matches",
    validate: (value: string) => {
      if (!dbGetAgent(value)) {
        throw new Error(`Agent not found: ${value}`);
      }
    },
  },
  defaultDmScope: {
    description: `Default DM scope (${DmScopeSchema.options.join(", ")})`,
    validate: (value: string) => {
      const result = DmScopeSchema.safeParse(value);
      if (!result.success) {
        throw new Error(`Invalid value: ${value}`);
      }
    },
  },
  defaultTimezone: {
    description: "Default timezone for cron jobs (e.g., America/Sao_Paulo)",
    validate: (value: string) => {
      if (!isValidTimezone(value)) {
        throw new Error(`Invalid timezone: ${value}`);
      }
    },
  },
  "whatsapp.groupPolicy": {
    description: `WhatsApp group policy (${GROUP_POLICIES.join(", ")})`,
    validate: (value: string) => {
      if (!GROUP_POLICIES.includes(value as (typeof GROUP_POLICIES)[number])) {
        throw new Error(`Invalid value. Must be one of: ${GROUP_POLICIES.join(", ")}`);
      }
    },
  },
  "whatsapp.dmPolicy": {
    description: `WhatsApp DM policy (${DM_POLICIES.join(", ")})`,
    validate: (value: string) => {
      if (!DM_POLICIES.includes(value as (typeof DM_POLICIES)[number])) {
        throw new Error(`Invalid value. Must be one of: ${DM_POLICIES.join(", ")}`);
      }
    },
  },
};

function isLegacyAccountSetting(key: string): boolean {
  return key.startsWith("account.");
}

function legacyAccountSettingHint(key: string): string {
  const parts = key.split(".");
  if (parts.length < 3) {
    return "Use `ravi instances` instead.";
  }

  const instanceName = parts[1];
  const field = parts.at(-1);
  if (!instanceName || !field || !INSTANCE_SETTING_FIELDS.has(field)) {
    return "Use `ravi instances` instead.";
  }

  return `Use \`ravi instances set ${instanceName} ${field} <value>\` instead.`;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function knownSettingDefault(key: string): string | null {
  if (key === "defaultAgent") return "main";
  if (key === "defaultDmScope") return "per-peer";
  return null;
}

function serializeSetting(key: string, value: string | null) {
  const legacy = isLegacyAccountSetting(key);
  const meta = KNOWN_SETTINGS[key];
  return {
    key,
    value,
    isSet: value !== null,
    known: Boolean(meta),
    legacy,
    description: meta?.description ?? null,
    defaultValue: value === null ? knownSettingDefault(key) : null,
    hint: legacy ? legacyAccountSettingHint(key) : null,
  };
}

function buildSettingsListPayload(showLegacy: boolean) {
  const settings = dbListSettings();
  const customKeys = Object.keys(settings).filter((key) => !KNOWN_SETTINGS[key]);
  const legacyKeys = customKeys.filter((key) => isLegacyAccountSetting(key));
  const unknownKeys = customKeys.filter((key) => !isLegacyAccountSetting(key));

  return {
    total: Object.keys(settings).length,
    showLegacy,
    knownSettings: Object.entries(KNOWN_SETTINGS).map(([key]) => serializeSetting(key, settings[key] ?? null)),
    customSettings: unknownKeys.map((key) => serializeSetting(key, settings[key] ?? null)),
    legacySettings: {
      total: legacyKeys.length,
      hidden: !showLegacy,
      settings: showLegacy ? legacyKeys.map((key) => serializeSetting(key, settings[key] ?? null)) : [],
    },
  };
}

@Group({
  name: "settings",
  description: "Global settings management",
  scope: "admin",
})
export class SettingsCommands {
  @Command({ name: "list", description: "List live settings (legacy account.* hidden by default)" })
  list(
    @Option({ flags: "--legacy", description: "Show legacy account.* settings shadowed by instances" })
    showLegacy = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const settings = dbListSettings();

    if (asJson) {
      printJson(buildSettingsListPayload(showLegacy));
      return;
    }

    console.log("\nSettings:\n");

    // Show known settings with their current values
    for (const [key, meta] of Object.entries(KNOWN_SETTINGS)) {
      const value = settings[key] ?? "(not set)";
      console.log(`  ${key}: ${value}`);
      console.log(`    ${meta.description}\n`);
    }

    // Hide legacy account.* keys by default so they do not compete with instances.
    const customKeys = Object.keys(settings).filter((k) => !KNOWN_SETTINGS[k]);
    const legacyKeys = customKeys.filter((k) => isLegacyAccountSetting(k));
    const unknownKeys = customKeys.filter((k) => !isLegacyAccountSetting(k));

    if (showLegacy && legacyKeys.length > 0) {
      console.log("  Legacy settings shadowed by instances:");
      for (const key of legacyKeys) {
        console.log(`    ${key}: ${settings[key]}`);
      }
      console.log();
    } else if (legacyKeys.length > 0) {
      console.log(
        `  Legacy account.* settings hidden by default: ${legacyKeys.length} key(s) shadowed by instances. Use --legacy to inspect them.\n`,
      );
    }

    if (unknownKeys.length > 0) {
      console.log("  Custom settings:");
      for (const key of unknownKeys) {
        console.log(`    ${key}: ${settings[key]}`);
      }
      console.log();
    }
  }

  @Command({ name: "get", description: "Get a setting value" })
  get(
    @Arg("key", { description: "Setting key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const value = dbGetSetting(key);
    const legacy = isLegacyAccountSetting(key);

    if (asJson) {
      printJson({ setting: serializeSetting(key, value) });
      return;
    }

    if (value === null) {
      if (legacy) {
        console.log(`Legacy setting not set: ${key}`);
        console.log(`  ${legacyAccountSettingHint(key)}`);
        return;
      }

      console.log(`Setting not set: ${key}`);

      // Show default if known
      if (key === "defaultAgent") {
        console.log("  Default: main");
      } else if (key === "defaultDmScope") {
        console.log("  Default: per-peer");
      }
      return;
    }

    if (legacy) {
      console.log(`Legacy setting shadowed by instances: ${key}: ${value}`);
      console.log(`  ${legacyAccountSettingHint(key)}`);
      return;
    }

    console.log(`${key}: ${value}`);
  }

  @Command({ name: "set", description: "Set a setting value" })
  set(
    @Arg("key", { description: "Setting key" }) key: string,
    @Arg("value", { description: "Setting value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (isLegacyAccountSetting(key)) {
      fail(`Legacy setting shadowed by instances: ${key}. ${legacyAccountSettingHint(key)}`);
    }

    // Validate known settings (exact match first, then pattern-based)
    const meta = KNOWN_SETTINGS[key];
    const validator = meta?.validate;
    if (validator) {
      try {
        validator(value);
      } catch (err) {
        const hint =
          key === "defaultAgent"
            ? `. Available: ${dbListAgents()
                .map((a) => a.id)
                .join(", ")}`
            : key === "defaultDmScope"
              ? `. Valid scopes: ${DmScopeSchema.options.join(", ")}`
              : "";
        fail(`Invalid value for ${key}: ${err instanceof Error ? err.message : err}${hint}`);
      }
    }

    try {
      dbSetSetting(key, value);
      if (asJson) {
        printJson({
          status: "set",
          target: { type: "setting", key },
          changedCount: 1,
          setting: serializeSetting(key, value),
        });
        emitConfigChanged();
        return;
      }
      console.log(`✓ ${key} set: ${value}`);
      emitConfigChanged();
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "delete", description: "Delete a setting" })
  delete(
    @Arg("key", { description: "Setting key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const legacy = isLegacyAccountSetting(key);
    const deleted = dbDeleteSetting(key);
    if (asJson) {
      printJson({
        status: deleted ? "deleted" : "not_found",
        target: { type: "setting", key },
        changedCount: deleted ? 1 : 0,
        setting: serializeSetting(key, null),
      });
      if (deleted) emitConfigChanged();
      return;
    }

    if (deleted) {
      console.log(
        legacy ? `\u2713 Deleted legacy setting shadowed by instances: ${key}` : `\u2713 Setting deleted: ${key}`,
      );
      emitConfigChanged();
    } else {
      console.log(legacy ? `Legacy setting not found: ${key}` : `Setting not found: ${key}`);
    }
  }
}
