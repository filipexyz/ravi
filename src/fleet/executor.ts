import { dbListChannels } from "../router/router-db.js";
import { configureNativeChannel } from "../channels/management.js";
import { channelSchema, type RuntimeOperation, type OperationResult } from "@ravi/operation-contracts/console";
import manifest from "../../package.json" with { type: "json" };
import { inspectNativeConnections, verifyNativeChannelOwner } from "./channels.js";

function safeChannel(channel: ReturnType<typeof dbListChannels>[number]) {
  return channelSchema.parse({
    name: channel.name,
    provider: channel.provider,
    enabled: channel.enabled !== false,
    credentialConnection: channel.credentialConnection ?? null,
  });
}
/** Deliberately bounded management surface; never evaluates code or accepts shell/tool commands. */
export async function executeFleetOperation(command: RuntimeOperation): Promise<OperationResult> {
  switch (command.kind) {
    case "channels.inspect":
      return {
        kind: "channels.inspect",
        connections: await inspectNativeConnections(),
        channels: dbListChannels().slice(0, 500).map(safeChannel),
      };
    case "health":
      return {
        kind: "health",
        health: {
          version: manifest.version,
          platform: `${process.platform}-${process.arch}`,
          channels: dbListChannels().slice(0, 500).map(safeChannel),
        },
      };
    case "channel.configure":
      await verifyNativeChannelOwner(command);
      return {
        kind: "channel.configure",
        channel: safeChannel(
          configureNativeChannel({
            name: command.name,
            provider: command.provider,
            credentialConnection: command.credentialConnection,
            enabled: command.enabled,
          }),
        ),
      };
  }
}
