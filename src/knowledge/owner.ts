// Where Knowledge writes to the operator (morning DM, write-after-read card):
// the direct chat of the one contact tagged `permission-owner` (contract
// §10.3). More than one tagged contact, or none, is null: fail closed.
// The setting `knowledge.owner.target` only picks among that contact's own
// identities; any other value is ignored.

import { findContactsByTag, getContactDetails, type PlatformIdentity } from "../contacts.js";
import { dbGetInstance, dbGetInstanceByInstanceId, dbGetSetting, dbListInstances } from "../router/router-db.js";
import type { InstanceConfig } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { normalizePhone, phoneToJid } from "../utils/phone.js";

const log = logger.child("knowledge:owner");

export const OWNER_CONTACT_TAG = "permission-owner";
export const OWNER_TARGET_SETTING = "knowledge.owner.target";

export interface OwnerDirectTarget {
  channel: string;
  /** The OSS instance name (`instances.name`). */
  accountId: string;
  to: string;
  chatId: string;
  contactId: string;
}

export interface OwnerTargetDeps {
  /** Contacts tagged `permission-owner`. */
  listOwnerContactIds?: () => string[];
  identitiesForContact?: (contactId: string) => PlatformIdentity[];
  /** The raw `knowledge.owner.target` setting. */
  readTargetSetting?: () => string | null;
  listInstances?: () => InstanceConfig[];
}

export function resolveOwnerDirectTarget(deps: OwnerTargetDeps = {}): OwnerDirectTarget | null {
  try {
    const owners = [...new Set((deps.listOwnerContactIds ?? defaultOwnerContactIds)())];
    if (owners.length !== 1) return null;
    const contactId = owners[0] as string;
    const identities = (deps.identitiesForContact ?? defaultIdentities)(contactId);
    const instances = (deps.listInstances ?? dbListInstances)();
    const candidates = identities
      .map((identity) => targetForIdentity(identity, contactId, instances))
      .filter((target): target is OwnerDirectTarget => target !== null);
    if (candidates.length === 0) return null;

    const setting = (deps.readTargetSetting ?? defaultTargetSetting)()?.trim();
    if (setting) {
      const chosen = pickBySetting(setting, candidates, instances);
      if (chosen) return chosen;
      log.warn("knowledge.owner.target names no identity of the owner contact; ignored");
    }
    return candidates.find((target) => target.channel === "whatsapp") ?? candidates[0] ?? null;
  } catch (error) {
    log.warn("owner target unresolved", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function defaultOwnerContactIds(): string[] {
  return findContactsByTag(OWNER_CONTACT_TAG).map((contact) => contact.id);
}

function defaultIdentities(contactId: string): PlatformIdentity[] {
  return getContactDetails(contactId)?.platformIdentities ?? [];
}

function defaultTargetSetting(): string | null {
  return dbGetSetting(OWNER_TARGET_SETTING);
}

function targetForIdentity(
  identity: PlatformIdentity,
  contactId: string,
  instances: InstanceConfig[],
): OwnerDirectTarget | null {
  if (identity.ownerType && identity.ownerType !== "contact") return null;
  const channel = identity.channel?.trim().toLowerCase();
  if (!channel || channel === "phone" || channel === "email") return null;
  const accountId = instanceNameFor(identity.instanceId, channel, instances);
  if (!accountId) return null;
  const raw = identity.platformUserId?.trim() || identity.normalizedPlatformUserId?.trim();
  if (!raw) return null;
  const to = channel === "whatsapp" ? (raw.includes("@") ? raw : phoneToJid(raw)) : raw;
  if (!to) return null;
  return { channel, accountId, to, chatId: to, contactId };
}

function instanceNameFor(instanceId: string, channel: string, instances: InstanceConfig[]): string | null {
  const id = instanceId?.trim();
  if (id) {
    const byName = instances.find((instance) => instance.name === id) ?? safeLookup(() => dbGetInstance(id));
    if (byName) return byName.name;
    const byOmniId =
      instances.find((instance) => instance.instanceId === id) ?? safeLookup(() => dbGetInstanceByInstanceId(id));
    if (byOmniId) return byOmniId.name;
  }
  const sameChannel = instances.filter((instance) => instance.channel === channel && instance.enabled !== false);
  return sameChannel[0]?.name ?? null;
}

function safeLookup(lookup: () => InstanceConfig | null): InstanceConfig | null {
  try {
    return lookup();
  } catch {
    return null;
  }
}

/** `<channel>:<accountId>:<to>`, accepted only when `<to>` is one of the owner's identities on that channel. */
function pickBySetting(
  setting: string,
  candidates: OwnerDirectTarget[],
  instances: InstanceConfig[],
): OwnerDirectTarget | null {
  const first = setting.indexOf(":");
  const second = first < 0 ? -1 : setting.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) return null;
  const channel = setting.slice(0, first).trim().toLowerCase();
  const accountId = setting.slice(first + 1, second).trim();
  const to = setting.slice(second + 1).trim();
  if (!to) return null;
  const match = candidates.find((candidate) => candidate.channel === channel && sameAddress(candidate.to, to));
  if (!match) return null;
  // The account only switches to another instance of the same channel.
  const instance = instances.find((item) => item.name === accountId && item.channel === channel);
  return { ...match, accountId: instance ? instance.name : match.accountId };
}

function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return Boolean(left) && left === right;
}
