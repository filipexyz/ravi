import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createWhatsAppClient } from "./channels/whatsapp/client.js";
import { createWhatsAppGroupMetadataFetcher } from "./channels/whatsapp/group-metadata.js";
import type { requestWhatsAppRpc } from "./channels/whatsapp/rpc-client.js";
import { Gateway } from "./gateway.js";
import type { RouterConfig } from "./router/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

const WA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GROUP = "120363400000000002@g.us";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-whatsapp-mentions-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** Router config with one WhatsApp channel bound to WA_ID (account "wa-main"). */
function boundConfig(): Pick<RouterConfig, "instances" | "channels" | "instanceToAccount"> {
  return {
    instances: { "wa-main": { name: "wa-main", instanceId: WA_ID, channel: "whatsapp-baileys" } },
    channels: {
      "wa-main": { name: "wa-main", provider: "whatsapp", enabled: true },
    },
    instanceToAccount: { [WA_ID]: "wa-main" },
  } as unknown as Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;
}

function makeGateway(request: unknown) {
  const client = createWhatsAppClient({
    getConfig: boundConfig,
    request: request as typeof requestWhatsAppRpc,
  });
  return new Gateway({
    sender: {} as never,
    presenceTargets: {} as never,
    groupMetadataFetcher: createWhatsAppGroupMetadataFetcher(client),
  });
}

type PrepareMentions = (input: {
  accountId: string;
  instanceId: string;
  chatId: string;
  channel: string;
  text: string;
}) => Promise<{ text: string; mentions?: Array<{ id: string; type: string }> }>;

describe("Gateway outbound mentions for WhatsApp", () => {
  it("resolves @Name mentions from group metadata fetched over the runner RPC", async () => {
    const request = mock(async (_ref: string, _method: string, _params: unknown, _options?: unknown) => ({
      groupJid: GROUP,
      subject: "grupo",
      participants: [
        {
          platformUserId: "5511947879044@s.whatsapp.net",
          phoneJid: "5511947879044@s.whatsapp.net",
          displayName: "Luis Filipe",
          role: "admin" as const,
        },
      ],
      fetchedAt: Date.now(),
    }));
    const gateway = makeGateway(request);
    const prepare = (gateway as unknown as { prepareOutboundMentionMessage: PrepareMentions })
      .prepareOutboundMentionMessage;

    const prepared = await prepare.call(gateway, {
      accountId: "wa-main",
      instanceId: WA_ID,
      chatId: GROUP,
      channel: "whatsapp-baileys",
      text: "oi @Luis Filipe",
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.slice(0, 3)).toEqual([WA_ID, "groups.metadata", { groupJid: GROUP }]);
    expect(prepared.mentions).toEqual([{ id: "5511947879044@s.whatsapp.net", type: "user" }]);
    expect(prepared.text).not.toContain("@Luis Filipe");
  });

  it("does not call the runner RPC for instances not bound to a WhatsApp channel", async () => {
    const request = mock(async () => {
      throw new Error("should not be called");
    });
    const gateway = makeGateway(request);
    const prepare = (gateway as unknown as { prepareOutboundMentionMessage: PrepareMentions })
      .prepareOutboundMentionMessage;

    const prepared = await prepare.call(gateway, {
      accountId: "unbound-account",
      instanceId: "unbound-instance",
      chatId: GROUP,
      channel: "whatsapp-baileys",
      text: "oi @Luis Filipe",
    });

    expect(prepared.text).toBe("oi @Luis Filipe");
    expect(request).not.toHaveBeenCalled();
  });
});
