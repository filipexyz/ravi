import { randomUUID, createHash } from "node:crypto";
import { readCloudCredentials } from "../cloud-auth/storage.js";
import { eventSubject, getWatchConnector, resolveEventTypes } from "./connectors.js";
import {
  createConsoleWatch,
  deleteConsoleWatch,
  getWatchCapabilities,
  setConsoleWatchEnabled,
} from "./console-client.js";
import { WatchApiError } from "./errors.js";
import { deleteWatch, getWatch, listWatches, updateWatchStatus, upsertWatch } from "./watch-db.js";
import type {
  ConsoleWatch,
  WatchCapabilities,
  WatchCreateInput,
  WatchListPage,
  WatchPlacement,
  WatchProvider,
  WatchRecord,
  WatchStatus,
} from "./types.js";

export interface WatchCreateResult {
  watch: WatchRecord;
  capabilities?: WatchCapabilities;
  createdRemote: boolean;
}

export function listWatchRecords(input: {
  provider?: string | null;
  status?: WatchStatus | "all" | null;
  limit?: number;
  offset?: number;
}): WatchListPage {
  return listWatches(input);
}

export function showWatch(id: string): WatchRecord | null {
  return getWatch(id);
}

export async function createWatch(input: WatchCreateInput): Promise<WatchCreateResult> {
  const connector = getWatchConnector(input.provider);
  if (!connector) throw new WatchApiError("WATCH_CAPABILITY_UNAVAILABLE", `Unknown watch provider: ${input.provider}`);

  const eventTypes = resolveEventTypes(input.provider, input.eventTypes);
  const requestedPlacement = input.placement ?? connector.defaultPlacement;
  const placement = normalizePlacement(requestedPlacement);

  if (placement === "console") {
    return createRemoteWatchWithCapabilities(input, eventTypes);
  }

  if (placement === "local") {
    return {
      watch: upsertWatch({
        id: localWatchId(input.provider, input.resourceRef, eventTypes),
        name: input.name ?? defaultWatchName(input.provider, input.resourceRef),
        provider: input.provider,
        placement: "local",
        status: "active",
        resourceRef: input.resourceRef,
        providerInstallationId: input.providerInstallationId ?? null,
        providerResourceId: input.providerResourceId ?? null,
        eventTypes,
        filters: input.filters ?? {},
        delivery: null,
        eventSubjects: eventTypes.map((eventType) => eventSubject(input.provider, eventType)),
      }),
      createdRemote: false,
    };
  }

  if (input.provider === "github") {
    const credentials = readCloudCredentials();
    if (!credentials) {
      throw new WatchApiError(
        "AUTH_REQUIRED",
        "GitHub webhook watches require Console login. Run `ravi login`, or use `--placement local` explicitly for polling fallback.",
      );
    }

    const capabilities = await getWatchCapabilities({ provider: input.provider, eventTypes });
    const blocker = capabilityBlocker(capabilities, eventTypes);
    if (blocker) throw blocker;
    if (capabilities.recommendedPlacement === "console" || capabilities.placements?.includes("console")) {
      return createRemoteWatch(input, eventTypes, capabilities);
    }

    throw new WatchApiError(
      "WATCH_CAPABILITY_UNAVAILABLE",
      "Console did not report GitHub console placement as available. Use `--placement local` explicitly for polling fallback.",
      { details: { capabilities } },
    );
  }

  return {
    watch: upsertWatch({
      id: localWatchId(input.provider, input.resourceRef, eventTypes),
      name: input.name ?? defaultWatchName(input.provider, input.resourceRef),
      provider: input.provider,
      placement: "local",
      status: "active",
      resourceRef: input.resourceRef,
      eventTypes,
      filters: input.filters ?? {},
      delivery: null,
      eventSubjects: eventTypes.map((eventType) => eventSubject(input.provider, eventType)),
    }),
    createdRemote: false,
  };
}

async function createRemoteWatchWithCapabilities(
  input: WatchCreateInput,
  eventTypes: string[],
): Promise<WatchCreateResult> {
  if (input.provider !== "github") {
    return createRemoteWatch(input, eventTypes);
  }

  const capabilities = await getWatchCapabilities({ provider: input.provider, eventTypes });
  const blocker = capabilityBlocker(capabilities, eventTypes);
  if (blocker) throw blocker;
  return createRemoteWatch(input, eventTypes, capabilities);
}

export async function setWatchEnabled(id: string, enabled: boolean): Promise<WatchRecord> {
  const existing = getWatch(id);
  if (!existing) throw new WatchApiError("PROVIDER_RESOURCE_UNAVAILABLE", `Watch not found: ${id}`);
  if (existing.placement === "console") {
    const remote = await setConsoleWatchEnabled(id, enabled);
    return upsertWatchFromConsole(remote, existing.resourceRef);
  }
  return updateWatchStatus(id, enabled ? "active" : "disabled");
}

export async function removeWatch(id: string): Promise<boolean> {
  const existing = getWatch(id);
  if (!existing) return false;
  if (existing.placement === "console") {
    await deleteConsoleWatch(id);
  }
  return deleteWatch(id);
}

function normalizePlacement(placement: WatchPlacement): WatchPlacement {
  if (placement === "auto" || placement === "local" || placement === "console") return placement;
  throw new WatchApiError("PAYLOAD_INVALID", `Invalid watch placement: ${placement}`);
}

async function createRemoteWatch(
  input: WatchCreateInput,
  eventTypes: string[],
  capabilities?: WatchCapabilities,
): Promise<WatchCreateResult> {
  const providerResource = input.provider === "github" ? parseGithubRepo(input.resourceRef) : undefined;
  const clientRequestId = randomUUID();
  const remote = await createConsoleWatch({
    provider: input.provider,
    placement: "console",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.providerInstallationId ? { providerInstallationId: input.providerInstallationId } : {}),
    ...(input.providerResourceId ? { providerResourceId: input.providerResourceId } : {}),
    ...(providerResource ? { providerResource } : {}),
    eventTypes,
    filters: input.filters ?? {},
    delivery: { type: "inbox" },
    clientRequestId,
    idempotencyKey: clientRequestId,
  });
  return {
    watch: upsertWatchFromConsole(remote, input.resourceRef, input.name),
    capabilities,
    createdRemote: true,
  };
}

function upsertWatchFromConsole(
  remote: ConsoleWatch,
  fallbackResourceRef: string,
  fallbackName?: string | null,
): WatchRecord {
  const provider = remote.provider;
  const eventTypes = remote.effectiveEventTypes?.length ? remote.effectiveEventTypes : (remote.eventTypes ?? []);
  const resourceRef =
    remote.providerResourceRef ??
    remote.resourceRef ??
    fallbackResourceRef ??
    String(remote.providerResourceId ?? remote.id);
  return upsertWatch({
    id: remote.id,
    name: fallbackName ?? null,
    provider,
    placement: remote.placement === "local" ? "local" : "console",
    status: remote.status ?? "active",
    resourceRef,
    providerInstallationId: remote.providerInstallationId ?? null,
    providerResourceId: remote.providerResourceId ?? null,
    eventTypes,
    filters: remote.filters ?? {},
    delivery: remote.delivery ?? { type: "inbox" },
    eventSubjects: remote.eventSubjects?.length
      ? remote.eventSubjects
      : eventTypes.map((eventType) => eventSubject(provider, eventType)),
    remoteWatch: remote,
    lastEventAt: remote.lastEventAt ?? null,
    lastDeliveryAt: remote.lastDeliveryAt ?? null,
    lastErrorCode: remote.lastErrorCode ?? null,
  });
}

export function capabilityBlocker(capabilities: WatchCapabilities, eventTypes: string[]): WatchApiError | null {
  const unsupported = capabilities.unsupportedEventTypes?.filter(Boolean) ?? [];
  if (unsupported.length > 0) {
    return new WatchApiError(
      "WATCH_UNSUPPORTED_EVENT",
      `Console does not support GitHub watch event type(s): ${unsupported.map(displayGithubEventType).join(", ")}`,
      {
        details: {
          unsupportedEventTypes: unsupported,
          ...(capabilities.supportedEventTypes ? { supportedEventTypes: capabilities.supportedEventTypes } : {}),
          requestedEventTypes: eventTypes,
          ...pickActionable(capabilities),
        },
      },
    );
  }

  if (capabilities.installNeeded) {
    return new WatchApiError("INSTALLATION_MISSING", "GitHub App installation is required for this watch.", {
      details: pickActionable(capabilities),
    });
  }
  if (capabilities.inboxAvailable === false) {
    return new WatchApiError("INBOX_SUBSCRIPTION_MISSING", "Console inbox delivery is not available for watches.", {
      details: pickActionable(capabilities),
    });
  }
  const missing = [...(capabilities.missingCapabilities ?? []), ...(capabilities.missingPermissions ?? [])];
  for (const eventType of eventTypes) {
    const eventCaps = capabilities.eventTypes?.[eventType];
    if (eventCaps?.missing?.length) missing.push(...eventCaps.missing);
  }
  if (missing.length > 0) {
    return new WatchApiError("PROVIDER_PERMISSION_MISSING", "GitHub watch is missing required permissions.", {
      details: { missing: [...new Set(missing)], ...pickActionable(capabilities) },
    });
  }
  return null;
}

function pickActionable(capabilities: WatchCapabilities): Record<string, unknown> {
  return {
    ...(capabilities.installUrl ? { installUrl: capabilities.installUrl } : {}),
    ...(capabilities.connectUrl ? { connectUrl: capabilities.connectUrl } : {}),
    ...(capabilities.unsupportedEventTypes ? { unsupportedEventTypes: capabilities.unsupportedEventTypes } : {}),
    ...(capabilities.missingCapabilities ? { missingCapabilities: capabilities.missingCapabilities } : {}),
    ...(capabilities.missingPermissions ? { missingPermissions: capabilities.missingPermissions } : {}),
  };
}

function displayGithubEventType(eventType: string): string {
  return eventType.startsWith("watch.github.") ? eventType.slice("watch.github.".length) : eventType;
}

function parseGithubRepo(resourceRef: string): { owner: string; repo: string } {
  const [owner, repo] = resourceRef.split("/");
  if (!owner || !repo || resourceRef.split("/").length !== 2) {
    throw new WatchApiError("PAYLOAD_INVALID", "GitHub watch resource must be in owner/repo form.");
  }
  return { owner, repo };
}

function localWatchId(provider: WatchProvider, resourceRef: string, eventTypes: string[]): string {
  const hash = createHash("sha256")
    .update(`${provider}\0${resourceRef}\0${eventTypes.sort().join(",")}`)
    .digest("hex");
  return `watch_${hash.slice(0, 24)}`;
}

function defaultWatchName(provider: WatchProvider, resourceRef: string): string {
  return `${provider}:${resourceRef}`;
}
