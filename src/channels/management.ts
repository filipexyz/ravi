import { getCredentialConnection } from "../credentials/index.js";
import { dbUpsertChannel } from "../router/router-db.js";
import { nats } from "../nats.js";

/** Shared config effect for CLI and Console-managed nodes. The existing runner owns adapters. */
export function configureNativeChannel(input: {
  name: string;
  provider: string;
  credentialConnection?: string;
  enabled?: boolean;
}) {
  if (input.enabled !== false && input.credentialConnection) {
    const connection = getCredentialConnection(input.provider, input.credentialConnection);
    if (!connection || connection.status !== "active") throw new Error("Channel credential connection is unavailable");
  }
  const channel = dbUpsertChannel(input);
  void nats.emit("ravi.config.changed", {}).catch(() => {});
  return channel;
}
