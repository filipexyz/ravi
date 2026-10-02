/**
 * WhatsApp instance provisioning.
 *
 * A WhatsApp instance is served by the `ravi channels` runner when two rows exist:
 * an `instances` row with a transport UUID (`instances.instance_id`) and a non-deleted
 * `channels` row with provider `whatsapp` that binds it (its name, or `defaults.instance`
 * when the instance name is not a valid channel id). `ensureWhatsAppInstance` creates
 * whatever is missing, in one router-DB transaction, and never overwrites an existing
 * transport UUID (an Omni-era UUID is kept so chats, contacts and sessions stay attached).
 *
 * It refuses, before writing anything:
 * - an instance whose channel is not WhatsApp;
 * - a soft-deleted instance with that name (restore it first);
 * - a disabled WhatsApp channel bound to the instance;
 * - a WhatsApp channel named after the instance that binds a different instance.
 * After writing it checks that the instance resolves to a WhatsApp binding; otherwise
 * the transaction is rolled back and nothing is left behind.
 */

import { randomUUID } from "node:crypto";
import { configStore } from "../../config-store.js";
import { nats } from "../../nats.js";
import { loadRouterConfig } from "../../router/config.js";
import {
  type ChannelConfig,
  dbGetChannel,
  dbGetInstance,
  dbListDeletedInstances,
  dbUpdateInstance,
  dbUpsertChannel,
  dbUpsertInstance,
  getDb,
  type InstanceConfig,
} from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import { logger } from "../../utils/logger.js";
import { canonicalChannelId } from "../capabilities.js";
import { whatsappChannelNameFor } from "./channel-name.js";
import {
  WHATSAPP_PROVIDER,
  findWhatsAppChannelForInstance,
  isWhatsAppChannelType,
  resolveWhatsAppBinding,
} from "./contract.js";

const log = logger.child("channels:whatsapp:provisioning");

/** Error code for a provisioning conflict (string constant in a non-command module). */
export const WHATSAPP_INSTANCE_CONFLICT = "WHATSAPP_INSTANCE_CONFLICT";
/** Error code for an instance name that only exists as a soft-deleted row. */
export const WHATSAPP_INSTANCE_DELETED = "WHATSAPP_INSTANCE_DELETED";

export type WhatsAppProvisioningErrorCode = typeof WHATSAPP_INSTANCE_CONFLICT | typeof WHATSAPP_INSTANCE_DELETED;

export class WhatsAppProvisioningError extends Error {
  readonly code: WhatsAppProvisioningErrorCode;
  readonly accountName: string;

  constructor(code: WhatsAppProvisioningErrorCode, accountName: string, message: string) {
    super(message);
    this.name = "WhatsAppProvisioningError";
    this.code = code;
    this.accountName = accountName;
  }
}

export function isWhatsAppProvisioningError(err: unknown): err is WhatsAppProvisioningError {
  return err instanceof WhatsAppProvisioningError;
}

/** Instance settings. On a new instance they seed the row; on an existing one, the given ones are applied. */
export interface WhatsAppInstanceSettings {
  agent?: string;
  dmPolicy?: InstanceConfig["dmPolicy"];
  groupPolicy?: InstanceConfig["groupPolicy"];
  contactIntakeMode?: InstanceConfig["contactIntakeMode"];
}

export interface EnsureWhatsAppInstanceOptions extends WhatsAppInstanceSettings {
  /** Defaults to publishing `ravi.config.changed` (the runner hot-adds the channel). */
  emitConfigChanged?: () => void;
  /** Refresh this process's cached router config. Defaults to `configStore.refresh()`. */
  refreshConfig?: () => void;
  /** Live config after the writes (binding check). Defaults to `loadRouterConfig()`. */
  loadConfig?: () => Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;
}

export interface WhatsAppInstanceResult {
  instanceId: string;
  instance: InstanceConfig;
  channel: ChannelConfig;
  createdInstance: boolean;
  /** A new UUID was minted (new instance, or an existing instance without one). */
  mintedInstanceId: boolean;
  createdChannel: boolean;
  /** An existing instance had settings updated from the options. */
  updatedInstance: boolean;
}

function defaultEmitConfigChanged(): void {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

/** Any channels row with that name, any provider, deleted or not (the channel-name rule). */
function isChannelNameTaken(name: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM channels WHERE name = ?").get(name));
}

function conflict(accountName: string, message: string): WhatsAppProvisioningError {
  return new WhatsAppProvisioningError(WHATSAPP_INSTANCE_CONFLICT, accountName, message);
}

function boundInstanceOf(channel: ChannelConfig): string {
  const override = channel.defaults?.instance;
  return typeof override === "string" && override.trim() ? override.trim() : channel.name;
}

function settingsToApply(
  instance: InstanceConfig,
  settings: WhatsAppInstanceSettings,
): Partial<Pick<InstanceConfig, "agent" | "dmPolicy" | "groupPolicy" | "contactIntakeMode">> {
  const updates: Partial<Pick<InstanceConfig, "agent" | "dmPolicy" | "groupPolicy" | "contactIntakeMode">> = {};
  if (settings.agent && settings.agent !== instance.agent) updates.agent = settings.agent;
  if (settings.dmPolicy && settings.dmPolicy !== instance.dmPolicy) updates.dmPolicy = settings.dmPolicy;
  if (settings.groupPolicy && settings.groupPolicy !== instance.groupPolicy) updates.groupPolicy = settings.groupPolicy;
  if (settings.contactIntakeMode && settings.contactIntakeMode !== instance.contactIntakeMode) {
    updates.contactIntakeMode = settings.contactIntakeMode;
  }
  return updates;
}

/**
 * Validate everything that can make provisioning fail, before any write. Returns the
 * existing bound channel (if any) so the write phase only creates what is missing.
 */
function preflight(accountName: string): { instance: InstanceConfig | null; channel: ChannelConfig | null } {
  const instance = dbGetInstance(accountName);
  if (!instance && dbListDeletedInstances().some((deleted) => deleted.name === accountName)) {
    throw new WhatsAppProvisioningError(
      WHATSAPP_INSTANCE_DELETED,
      accountName,
      `Instance "${accountName}" was deleted; restore it first with \`ravi instances restore ${accountName}\``,
    );
  }
  if (instance && !isWhatsAppChannelType(instance.channel)) {
    throw conflict(accountName, `Instance "${accountName}" uses channel "${instance.channel}", not WhatsApp`);
  }

  const channel = findWhatsAppChannelForInstance(loadRouterConfig(), accountName);
  if (channel) {
    if (channel.enabled === false) {
      throw conflict(
        accountName,
        `WhatsApp channel "${channel.name}" of instance "${accountName}" is disabled; enable it with \`ravi instances enable ${accountName}\``,
      );
    }
    return { instance, channel };
  }

  const sameName = dbGetChannel(accountName);
  if (sameName && canonicalChannelId(sameName.provider) === WHATSAPP_PROVIDER) {
    throw conflict(
      accountName,
      `WhatsApp channel "${accountName}" is bound to instance "${boundInstanceOf(sameName)}", not "${accountName}"`,
    );
  }
  return { instance, channel: null };
}

/**
 * Make `name` a WhatsApp instance served by the runner (see the module doc). Emits
 * `ravi.config.changed` when anything was written and refreshes this process's config cache.
 */
export function ensureWhatsAppInstance(
  name: string,
  options: EnsureWhatsAppInstanceOptions = {},
): WhatsAppInstanceResult {
  const accountName = name.trim();
  if (!accountName) throw conflict(name, "Instance name is required");
  const loadConfig = options.loadConfig ?? (() => loadRouterConfig());

  const result = getDb().transaction((): WhatsAppInstanceResult => {
    const checked = preflight(accountName);

    let instance = checked.instance;
    let createdInstance = false;
    let mintedInstanceId = false;
    let updatedInstance = false;
    if (!instance) {
      instance = dbUpsertInstance({
        name: accountName,
        instanceId: randomUUID(),
        channel: WHATSAPP_PROVIDER,
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.dmPolicy ? { dmPolicy: options.dmPolicy } : {}),
        ...(options.groupPolicy ? { groupPolicy: options.groupPolicy } : {}),
        ...(options.contactIntakeMode ? { contactIntakeMode: options.contactIntakeMode } : {}),
      });
      createdInstance = true;
      mintedInstanceId = true;
    } else {
      const updates = settingsToApply(instance, options);
      if (!instance.instanceId?.trim()) {
        instance = dbUpdateInstance(accountName, { ...updates, instanceId: randomUUID() });
        mintedInstanceId = true;
        updatedInstance = Object.keys(updates).length > 0;
      } else if (Object.keys(updates).length > 0) {
        instance = dbUpdateInstance(accountName, updates);
        updatedInstance = true;
      }
    }

    // Read the row back: a write that did not land (e.g. a conflicting row) must not
    // leave a channel behind.
    const stored = dbGetInstance(accountName);
    const instanceId = stored?.instanceId?.trim();
    if (!stored || !instanceId) {
      throw conflict(accountName, `Instance "${accountName}" could not be stored with a transport instance id`);
    }

    let channel = checked.channel;
    let createdChannel = false;
    if (!channel) {
      const channelName = whatsappChannelNameFor(accountName, instanceId, isChannelNameTaken);
      channel = dbUpsertChannel({
        name: channelName,
        provider: WHATSAPP_PROVIDER,
        ...(channelName === accountName ? {} : { defaults: { instance: accountName } }),
      });
      createdChannel = true;
    }

    const binding = resolveWhatsAppBinding(loadConfig(), accountName);
    if (!binding || binding.instanceId !== instanceId) {
      throw conflict(
        accountName,
        `Instance "${accountName}" does not resolve to a WhatsApp channel after provisioning (channel "${channel.name}")`,
      );
    }

    return {
      instanceId,
      instance: stored,
      channel,
      createdInstance,
      mintedInstanceId,
      createdChannel,
      updatedInstance,
    };
  })();

  if (result.createdInstance || result.mintedInstanceId || result.createdChannel || result.updatedInstance) {
    (options.emitConfigChanged ?? defaultEmitConfigChanged)();
  }
  (options.refreshConfig ?? (() => configStore.refresh()))();

  log.info("WhatsApp instance ready", {
    accountName,
    instanceId: result.instanceId,
    channel: result.channel.name,
    createdInstance: result.createdInstance,
    createdChannel: result.createdChannel,
  });
  return result;
}
