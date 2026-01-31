/**
 * Settings Commands - Global settings management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import {
  dbGetSetting,
  dbSetSetting,
  dbDeleteSetting,
  dbListSettings,
  dbGetAgent,
  dbListAgents,
  DmScopeSchema,
} from "../../router/router-db.js";

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
        console.error(`Invalid value for ${key}: ${err instanceof Error ? err.message : err}`);

        // Show helpful hints
        if (key === "defaultAgent") {
          console.log("\nAvailable agents:");
          for (const a of dbListAgents()) {
            console.log(`  - ${a.id}`);
          }
        } else if (key === "defaultDmScope") {
          console.log(`\nValid scopes: ${DmScopeSchema.options.join(", ")}`);
        }
        process.exit(1);
      }
    }

    try {
      dbSetSetting(key, value);
      console.log(`\u2713 ${key} set: ${value}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "delete", description: "Delete a setting" })
  delete(@Arg("key", { description: "Setting key" }) key: string) {
    const deleted = dbDeleteSetting(key);
    if (deleted) {
      console.log(`\u2713 Setting deleted: ${key}`);
    } else {
      console.log(`Setting not found: ${key}`);
    }
  }
}
