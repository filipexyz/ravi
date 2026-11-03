import { listCredentialConnections } from "../credentials/index.js";
import { dbListChannels } from "../router/router-db.js";
import { SlackWebApiClient } from "../channels/slack/client.js";
import { resolveSlackCredentialConfigFromEnv } from "../channels/slack/credentials.js";
import { slackIdentitySchema } from "@ravi/operation-contracts/console";

/** Resolve through the native broker; only public bot identity crosses into Console. */
export async function inspectSlackConnection(connection: string) {
  const credentials = await resolveSlackCredentialConfigFromEnv(process.env, {
    channel: {
      name: "fleet-inspection",
      provider: "slack",
      credentialConnection: connection,
      createdAt: 0,
      updatedAt: 0,
    },
  });
  if (!credentials) throw new Error("Channel connection unavailable");
  const result = await new SlackWebApiClient(credentials).authTest({ signal: AbortSignal.timeout(4000) });
  if (!result.ok || !result.bot_id) throw new Error("A Slack bot connection is required");
  return slackIdentitySchema.parse({ teamId: result.team_id, botUserId: result.user_id });
}

export async function inspectNativeConnections() {
  // Bounded read-only discovery. A broken connection cannot consume the whole execution grant.
  const connections = listCredentialConnections({ provider: "slack", limit: 20 }).items;
  return Promise.all(
    connections.map(async ({ connection }) => {
      const timer = AbortSignal.timeout(5000);
      try {
        const identity = await Promise.race([
          inspectSlackConnection(connection),
          new Promise<never>((_, reject) =>
            timer.addEventListener("abort", () => reject(new Error("Inspection timed out")), { once: true }),
          ),
        ]);
        return { connection, identity, available: true };
      } catch {
        return { connection, identity: null, available: false };
      }
    }),
  );
}

export async function verifyNativeChannelOwner(input: {
  name: string;
  credentialConnection: string;
  identity: { teamId: string; botUserId: string };
  enabled: boolean;
}) {
  if (!input.enabled) return;
  const identity = await inspectSlackConnection(input.credentialConnection);
  if (identity.teamId !== input.identity.teamId || identity.botUserId !== input.identity.botUserId)
    throw new Error("Channel identity changed");
  if (
    dbListChannels().some(
      (channel) =>
        channel.name !== input.name &&
        channel.enabled !== false &&
        channel.provider === "slack" &&
        channel.credentialConnection === input.credentialConnection,
    )
  ) {
    throw new Error("This connection already has a listener on this installation");
  }
}
