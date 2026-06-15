/**
 * Settings Commands - Global settings management CLI
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { cliOffsetPaginationSchema, commandTargetSchema } from "../return-schemas.js";
import { nats } from "../../nats.js";
import { parseDurationMs } from "../../cron/schedule.js";

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

const settingReturnSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
  isSet: z.boolean(),
  known: z.boolean(),
  legacy: z.boolean(),
  description: z.string().nullable(),
  defaultValue: z.string().nullable(),
  hint: z.string().nullable(),
});

const settingsListReturnSchema = z.object({
  total: z.number(),
  showLegacy: z.boolean(),
  knownSettings: z.array(settingReturnSchema),
  customSettings: z.array(settingReturnSchema),
  legacySettings: z.object({
    total: z.number(),
    hidden: z.boolean(),
    settings: z.array(settingReturnSchema),
  }),
  pagination: cliOffsetPaginationSchema,
  items: z.array(settingReturnSchema.extend({ section: z.string() })),
});

const settingsGetReturnSchema = z.object({
  setting: settingReturnSchema,
});

const settingsMutationReturnSchema = z.object({
  status: z.string(),
  target: commandTargetSchema,
  changedCount: z.number(),
  setting: settingReturnSchema,
});

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
  "image.provider": {
    description: "Global default image provider (gemini or openai)",
    validate: (value: string) => {
      if (!["gemini", "openai"].includes(value)) {
        throw new Error("Invalid value. Must be one of: gemini, openai");
      }
    },
  },
  "image.model": {
    description: "Global default image model override",
  },
  "image.mode": {
    description: "Global default image mode (fast or quality)",
    validate: (value: string) => {
      if (!["fast", "quality"].includes(value)) {
        throw new Error("Invalid value. Must be one of: fast, quality");
      }
    },
  },
  "image.quality": {
    description: "Global default OpenAI image quality (low, medium, high, auto)",
    validate: (value: string) => {
      if (!["low", "medium", "high", "auto"].includes(value)) {
        throw new Error("Invalid value. Must be one of: low, medium, high, auto");
      }
    },
  },
  "image.format": {
    description: "Global default OpenAI image output format (png, jpeg, webp)",
    validate: (value: string) => {
      if (!["png", "jpeg", "webp"].includes(value)) {
        throw new Error("Invalid value. Must be one of: png, jpeg, webp");
      }
    },
  },
  "tasks.sessionTtl": {
    description: "Default TTL for task work sessions (duration like 1d, 12h, or off)",
    validate: (value: string) => {
      const normalized = value.trim().toLowerCase();
      if (["off", "false", "disabled", "none", "0"].includes(normalized)) return;
      parseDurationMs(normalized);
    },
  },
  "tasks.sessionTtl.knowledgeEngineer": {
    description: "TTL for knowledge-engineer-* task work sessions (duration like 5m, 1h, or off)",
    validate: (value: string) => {
      const normalized = value.trim().toLowerCase();
      if (["off", "false", "disabled", "none", "0"].includes(normalized)) return;
      parseDurationMs(normalized);
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
  if (key === "image.mode") return "fast";
  if (key === "tasks.sessionTtl") return "1d";
  if (key === "tasks.sessionTtl.knowledgeEngineer") return "5m";
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
  @CommandAccess({ kind: "read", resource: "settings", action: "list", risk: "low" })
  @Returns(settingsListReturnSchema)
  list(
    @Option({ flags: "--legacy", description: "Show legacy account.* settings shadowed by instances" })
    showLegacy = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching settings to skip (default: 0)" }) offset?: string,
  ) {
    const basePayload = buildSettingsListPayload(showLegacy);
    const settingItems = [
      ...basePayload.knownSettings.map((setting) => ({ ...setting, section: "known" })),
      ...basePayload.customSettings.map((setting) => ({ ...setting, section: "custom" })),
      ...(showLegacy ? basePayload.legacySettings.settings.map((setting) => ({ ...setting, section: "legacy" })) : []),
    ];
    const page = paginateCliItems(settingItems, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "settings", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [showLegacy ? "--legacy" : null],
    });
    const payload = {
      ...basePayload,
      total: page.total,
      pagination,
      items: page.items,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `\nSettings (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
      );
      for (const item of page.items) {
        const meta = KNOWN_SETTINGS[item.key];
        console.log(`  ${item.key}: ${item.value ?? "(not set)"}`);
        if (meta) console.log(`    ${meta.description}`);
        console.log(`    section: ${item.section}\n`);
      }
      if (basePayload.legacySettings.hidden && basePayload.legacySettings.total > 0) {
        console.log(
          `  Legacy account.* settings hidden by default: ${basePayload.legacySettings.total} key(s) shadowed by instances. Use --legacy to inspect them.\n`,
        );
      }
      if (pagination.nextCommand) {
        console.log("Next page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "get", description: "Get a setting value" })
  @CommandAccess({ kind: "read", resource: "settings", action: "get", risk: "low" })
  @Returns(settingsGetReturnSchema)
  get(
    @Arg("key", { description: "Setting key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const value = dbGetSetting(key);
    const legacy = isLegacyAccountSetting(key);
    const payload = { setting: serializeSetting(key, value) };

    if (asJson) {
      printJson(payload);
    } else if (value === null) {
      if (legacy) {
        console.log(`Legacy setting not set: ${key}`);
        console.log(`  ${legacyAccountSettingHint(key)}`);
      } else {
        console.log(`Setting not set: ${key}`);
        if (key === "defaultAgent") {
          console.log("  Default: main");
        } else if (key === "defaultDmScope") {
          console.log("  Default: per-peer");
        }
      }
    } else if (legacy) {
      console.log(`Legacy setting shadowed by instances: ${key}: ${value}`);
      console.log(`  ${legacyAccountSettingHint(key)}`);
    } else {
      console.log(`${key}: ${value}`);
    }
    return payload;
  }

  @Command({ name: "set", description: "Set a setting value" })
  @CommandAccess({ kind: "mutate", resource: "settings", action: "set", risk: "medium" })
  @Returns(settingsMutationReturnSchema)
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
      const payload = {
        status: "set" as const,
        target: { type: "setting" as const, key },
        changedCount: 1,
        setting: serializeSetting(key, value),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ ${key} set: ${value}`);
      }
      emitConfigChanged();
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "delete", description: "Delete a setting" })
  @CommandAccess({ kind: "mutate", resource: "settings", action: "delete", risk: "destructive" })
  @Returns(settingsMutationReturnSchema)
  delete(
    @Arg("key", { description: "Setting key" }) key: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const legacy = isLegacyAccountSetting(key);
    const deleted = dbDeleteSetting(key);
    const payload = {
      status: deleted ? ("deleted" as const) : ("not_found" as const),
      target: { type: "setting" as const, key },
      changedCount: deleted ? 1 : 0,
      setting: serializeSetting(key, null),
    };
    if (asJson) {
      printJson(payload);
    } else if (deleted) {
      console.log(
        legacy ? `\u2713 Deleted legacy setting shadowed by instances: ${key}` : `\u2713 Setting deleted: ${key}`,
      );
    } else {
      console.log(legacy ? `Legacy setting not found: ${key}` : `Setting not found: ${key}`);
    }
    if (deleted) emitConfigChanged();
    return payload;
  }
}
