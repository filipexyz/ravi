/**
 * Settings Commands - Global settings management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { fail } from "../context.js";
import { notif } from "../../notif.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  notif.emit("ravi.config.changed", {}).catch(() => {});
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
      if (!GROUP_POLICIES.includes(value as typeof GROUP_POLICIES[number])) {
        throw new Error(`Invalid value. Must be one of: ${GROUP_POLICIES.join(", ")}`);
      }
    },
  },
  "whatsapp.dmPolicy": {
    description: `WhatsApp DM policy (${DM_POLICIES.join(", ")})`,
    validate: (value: string) => {
      if (!DM_POLICIES.includes(value as typeof DM_POLICIES[number])) {
        throw new Error(`Invalid value. Must be one of: ${DM_POLICIES.join(", ")}`);
      }
    },
  },
};

@Group({
  name: "settings",
  description: "Global settings management",
})
export class SettingsCommands {
  @Command({ name: "list", description: "List all settings" })
  list() {
    const settings = dbListSettings();

    console.log("\nSettings:\n");

    // Show known settings with their current values
    for (const [key, meta] of Object.entries(KNOWN_SETTINGS)) {
      const value = settings[key] ?? "(not set)";
      console.log(`  ${key}: ${value}`);
      console.log(`    ${meta.description}\n`);
    }

    // Show any additional custom settings
    const customKeys = Object.keys(settings).filter(k => !KNOWN_SETTINGS[k]);
    if (customKeys.length > 0) {
      console.log("  Custom settings:");
      for (const key of customKeys) {
        console.log(`    ${key}: ${settings[key]}`);
      }
      console.log();
    }
  }

  @Command({ name: "get", description: "Get a setting value" })
  get(@Arg("key", { description: "Setting key" }) key: string) {
    const value = dbGetSetting(key);

    if (value === null) {
      console.log(`Setting not set: ${key}`);

      // Show default if known
      if (key === "defaultAgent") {
        console.log("  Default: main");
      } else if (key === "defaultDmScope") {
        console.log("  Default: per-peer");
      }
      return;
    }

    console.log(`${key}: ${value}`);
  }

  @Command({ name: "set", description: "Set a setting value" })
  set(
    @Arg("key", { description: "Setting key" }) key: string,
    @Arg("value", { description: "Setting value" }) value: string
  ) {
    // Validate known settings
    const meta = KNOWN_SETTINGS[key];
    if (meta?.validate) {
      try {
        meta.validate(value);
      } catch (err) {
        const hint = key === "defaultAgent"
          ? `. Available: ${dbListAgents().map(a => a.id).join(", ")}`
          : key === "defaultDmScope"
            ? `. Valid scopes: ${DmScopeSchema.options.join(", ")}`
            : "";
        fail(`Invalid value for ${key}: ${err instanceof Error ? err.message : err}${hint}`);
      }
    }

    try {
      dbSetSetting(key, value);
      console.log(`✓ ${key} set: ${value}`);
      emitConfigChanged();
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "delete", description: "Delete a setting" })
  delete(@Arg("key", { description: "Setting key" }) key: string) {
    const deleted = dbDeleteSetting(key);
    if (deleted) {
      console.log(`\u2713 Setting deleted: ${key}`);
      emitConfigChanged();
    } else {
      console.log(`Setting not found: ${key}`);
    }
  }
}
