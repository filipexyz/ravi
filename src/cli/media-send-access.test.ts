import { describe, expect, it } from "bun:test";

import { runWithContext } from "./context.js";
import { enforceCliCommandAuthorization } from "./command-access.js";
import {
  capabilitiesAllowMediaSend,
  MEDIA_SEND_COMMAND_ACCESS,
  MEDIA_SEND_PERMISSION_DENIED_REASON,
  overlayMediaSendAvailability,
  resolveRuntimeMediaSendCapabilities,
} from "./media-send-access.js";
import type { ChatActionAvailability } from "../channels/chat-actions.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";

const GROUP_SOURCE = {
  channel: "whatsapp",
  accountId: "main",
  instanceId: "main",
  chatId: "120363424772797713@g.us",
};

const DM_SOURCE = {
  channel: "whatsapp",
  accountId: "main",
  instanceId: "main",
  chatId: "5511999999999",
};

const EXPLICIT_MEDIA_INPUT = {
  filePath: "/tmp/corrected.pdf",
  account: "main",
  to: "120363424772797713@g.us",
};

const WHATSAPP_AVAILABLE: ChatActionAvailability = {
  actionId: "media.send",
  surfaceId: "chat_group",
  status: "available",
  executionMode: "legacy",
  scopeVerification: "not_required",
};

const SLACK_AVAILABLE: ChatActionAvailability = {
  actionId: "media.send",
  surfaceId: "chat_slack",
  status: "available",
  executionMode: "provider_confirmed",
  requiredScopes: ["files:write"],
  scopeVerification: "deferred",
};

const CHANNEL_UNAVAILABLE: ChatActionAvailability = {
  actionId: "media.send",
  surfaceId: "",
  status: "unavailable",
  scopeVerification: "not_required",
  unavailableReason: {
    code: "no_surface",
    message: "No current, attached, or recent chat surface was found for this session.",
  },
};

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId };
}

function contextRecord(capabilities: ContextCapability[]): ContextRecord {
  return {
    contextId: "ctx_media_send_access",
    contextKey: "rctx_media_send_access",
    kind: "turn-runtime",
    agentId: "dev",
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: 0,
  };
}

function authorizeMediaSend(input: {
  capabilities: ContextCapability[];
  source: typeof GROUP_SOURCE | typeof DM_SOURCE;
  commandInput?: Record<string, unknown>;
}) {
  return runWithContext(
    {
      agentId: "dev",
      source: input.source,
      context: contextRecord(input.capabilities),
    },
    () =>
      enforceCliCommandAuthorization({
        group: "media",
        command: "send",
        access: MEDIA_SEND_COMMAND_ACCESS,
        source: "gateway",
        scope: "open",
        input: input.commandInput ?? EXPLICIT_MEDIA_INPUT,
      }),
  );
}

describe("media send access snapshot", () => {
  it("treats no runtime snapshot as unknown rather than a deny", () => {
    expect(resolveRuntimeMediaSendCapabilities(undefined)).toBeUndefined();
    expect(resolveRuntimeMediaSendCapabilities(null)).toBeUndefined();
    expect(resolveRuntimeMediaSendCapabilities({ capabilities: [] })).toEqual([]);
    expect(overlayMediaSendAvailability(WHATSAPP_AVAILABLE, undefined)).toEqual(WHATSAPP_AVAILABLE);
  });

  it("accepts the same command-access candidates used at the gateway", () => {
    expect(capabilitiesAllowMediaSend([cap("mutate", "media", "send")])).toBe(true);
    expect(capabilitiesAllowMediaSend([cap("mutate", "media", "*")])).toBe(true);
    expect(capabilitiesAllowMediaSend([cap("mutate", "media.send", "*")])).toBe(true);
    expect(capabilitiesAllowMediaSend([cap("execute", "group", "media_send")])).toBe(true);
    expect(capabilitiesAllowMediaSend([cap("execute", "group", "media")])).toBe(true);
    expect(capabilitiesAllowMediaSend([cap("execute", "group", "*")])).toBe(true);
    expect(capabilitiesAllowMediaSend([cap("admin", "system", "*")])).toBe(true);
  });

  it("does not treat bootstrap or empty snapshots as media authority", () => {
    expect(capabilitiesAllowMediaSend([])).toBe(false);
    expect(capabilitiesAllowMediaSend([cap("execute", "group", "sessions")])).toBe(false);
    expect(capabilitiesAllowMediaSend([cap("execute", "group", "tasks")])).toBe(false);
    expect(capabilitiesAllowMediaSend([cap("use", "tool", "*")])).toBe(false);
  });

  it("overlays permission_denied only on currently available surfaces", () => {
    const denied = overlayMediaSendAvailability(WHATSAPP_AVAILABLE, [cap("execute", "group", "sessions")]);
    expect(denied).toMatchObject({
      status: "unavailable",
      unavailableReason: MEDIA_SEND_PERMISSION_DENIED_REASON,
    });
    expect(denied).not.toHaveProperty("command");
    expect(overlayMediaSendAvailability(CHANNEL_UNAVAILABLE, [])).toEqual(CHANNEL_UNAVAILABLE);
    expect(overlayMediaSendAvailability(WHATSAPP_AVAILABLE, [cap("mutate", "media", "send")])).toEqual(
      WHATSAPP_AVAILABLE,
    );
    expect(overlayMediaSendAvailability(SLACK_AVAILABLE, [])).toMatchObject({
      status: "unavailable",
      requiredScopes: ["files:write"],
      unavailableReason: MEDIA_SEND_PERMISSION_DENIED_REASON,
    });
  });

  it("evaluates group and DM snapshots identically, ignoring explicit account/target", () => {
    const granted = [cap("mutate", "media", "send")];
    const bootstrap = [cap("execute", "group", "sessions"), cap("execute", "group", "tasks")];

    const groupGranted = authorizeMediaSend({ capabilities: granted, source: GROUP_SOURCE });
    const dmGranted = authorizeMediaSend({ capabilities: granted, source: DM_SOURCE });
    const groupDenied = authorizeMediaSend({ capabilities: bootstrap, source: GROUP_SOURCE });
    const dmDenied = authorizeMediaSend({
      capabilities: bootstrap,
      source: DM_SOURCE,
      commandInput: { ...EXPLICIT_MEDIA_INPUT, account: "main", to: "5511999999999" },
    });
    const groupWithoutTarget = authorizeMediaSend({
      capabilities: granted,
      source: GROUP_SOURCE,
      commandInput: {},
    });

    expect(groupGranted.allowed).toBe(true);
    expect(dmGranted.allowed).toBe(true);
    expect(groupWithoutTarget.allowed).toBe(true);
    expect(groupDenied.allowed).toBe(false);
    expect(dmDenied.allowed).toBe(false);
    expect(groupDenied.errorMessage).toContain("media send");
    expect(dmDenied.errorMessage).toContain("media send");
  });
});
