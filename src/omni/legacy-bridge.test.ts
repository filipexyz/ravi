import { afterEach, describe, expect, it } from "bun:test";
import type { ChannelInboundHandler } from "../channels/inbound/types.js";
import { OmniLegacyInboundSource } from "./inbound-source.js";
import { createLegacyOmniBridge } from "./legacy-bridge.js";
import { OmniSender } from "./sender.js";

const handler: ChannelInboundHandler = { handle: async () => {} };
const savedEnv = { url: process.env.OMNI_API_URL, key: process.env.OMNI_API_KEY };

function restoreEnv(name: "OMNI_API_URL" | "OMNI_API_KEY", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("OMNI_API_URL", savedEnv.url);
  restoreEnv("OMNI_API_KEY", savedEnv.key);
});

describe("createLegacyOmniBridge", () => {
  it("returns null when Omni is not configured", () => {
    expect(createLegacyOmniBridge(null)).toBeNull();
  });

  it("builds an Omni REST sender and describes the connection without the key", () => {
    const bridge = createLegacyOmniBridge({ apiUrl: "http://omni.local", apiKey: "secret", source: "env" });
    if (!bridge) throw new Error("expected a bridge");

    expect(bridge.sender).toBeInstanceOf(OmniSender);
    expect(bridge.describe()).toEqual({ apiUrl: "http://omni.local", source: "env" });
    expect(JSON.stringify(bridge.describe())).not.toContain("secret");
  });

  it("creates the Omni inbound source over the given handler, connection and NATS seam", () => {
    const bridge = createLegacyOmniBridge({ apiUrl: "http://omni.local", apiKey: "secret", source: "omni-config" });
    if (!bridge) throw new Error("expected a bridge");
    const natsConnection = {
      jetstream: () => {
        throw new Error("not used");
      },
      jetstreamManager: async () => {
        throw new Error("not used");
      },
    };

    const source = bridge.createInboundSource(handler, { natsConnection });

    expect(source).toBeInstanceOf(OmniLegacyInboundSource);
    expect(source.id).toBe("omni");
    const omni = source as OmniLegacyInboundSource;
    expect(omni["handler"]).toBe(handler);
    expect(omni["options"]).toMatchObject({ apiUrl: "http://omni.local", apiKey: "secret" });
    expect(omni["options"].natsConnection).toBe(natsConnection);
  });

  it("resolves the connection from the environment by default", () => {
    process.env.OMNI_API_URL = "http://env-omni.local";
    process.env.OMNI_API_KEY = "env-key";

    const bridge = createLegacyOmniBridge();

    expect(bridge?.describe()).toEqual({ apiUrl: "http://env-omni.local", source: "env" });
  });
});
