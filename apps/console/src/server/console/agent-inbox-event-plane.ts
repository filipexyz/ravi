import { spawn } from "node:child_process";

import type {
  AgentInboxEventPlanePublisher,
  AgentInboxOutboxPublishEnvelope,
} from "@/server/console/agent-inbox";
import type { JsonRecord } from "@/server/db/schema";

const DEFAULT_NATS_PATH = "nats";
const DEFAULT_TIMEOUT = "8s";

export type AgentInboxNatsCliPublisherConfig = {
  credsFile: string;
  jsDomain: string | null;
  natsPath: string;
  server: string;
  subject: string | null;
  timeout: string;
  tlsCaFile: string | null;
};

export function agentInboxNatsCliPublisherConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentInboxNatsCliPublisherConfig | null {
  const server = firstCsv(
    env.RAVI_AGENT_INBOX_EVENT_PLANE_NATS_SERVER
      ?? env.RAVI_EVENT_PLANE_NATS_SERVER
      ?? env.RAVI_EVENT_PLANE_NATS_SERVERS,
  );
  const credsFile = optionalString(
    env.RAVI_AGENT_INBOX_EVENT_PLANE_CREDS_FILE
      ?? env.RAVI_AGENT_INBOX_EVENT_PLANE_CREDS
      ?? env.RAVI_EVENT_PLANE_BRIDGE_CREDS_FILE,
  );
  if (!server || !credsFile) return null;

  return {
    credsFile,
    jsDomain: optionalString(
      env.RAVI_AGENT_INBOX_EVENT_PLANE_JS_DOMAIN
        ?? env.RAVI_EVENT_PLANE_JS_DOMAIN,
    ),
    natsPath: optionalString(env.RAVI_AGENT_INBOX_EVENT_PLANE_NATS_PATH) ?? DEFAULT_NATS_PATH,
    server,
    subject: optionalString(env.RAVI_AGENT_INBOX_EVENT_PLANE_SUBJECT),
    timeout: optionalString(env.RAVI_AGENT_INBOX_EVENT_PLANE_TIMEOUT) ?? DEFAULT_TIMEOUT,
    tlsCaFile: optionalString(
      env.RAVI_AGENT_INBOX_EVENT_PLANE_TLS_CA_FILE
        ?? env.RAVI_EVENT_PLANE_TLS_CA_FILE,
    ),
  };
}

export function createAgentInboxNatsCliPublisher(
  config: AgentInboxNatsCliPublisherConfig,
): AgentInboxEventPlanePublisher {
  return {
    async publish(envelope) {
      const subject = config.subject ?? envelope.subject;
      const payload = JSON.stringify(eventPlanePayload(envelope));
      const result = await runNatsCli(
        config.natsPath,
        agentInboxNatsCliPublishArgs(config, envelope, subject, payload),
      );
      if (result.exitCode !== 0) {
        const error = new Error("agent_inbox_event_plane_publish_failed") as Error & { code: string };
        error.code = "EVENT_PLANE_PUBLISH_FAILED";
        throw error;
      }
      return {
        providerMessageId: null,
        trace: {
          eventPlaneProvider: "nats_cli",
          subject,
          jsDomain: config.jsDomain,
        },
      };
    },
  };
}

export function createAgentInboxNatsCliPublisherFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentInboxEventPlanePublisher | null {
  const config = agentInboxNatsCliPublisherConfigFromEnv(env);
  return config ? createAgentInboxNatsCliPublisher(config) : null;
}

export function agentInboxNatsCliPublishArgs(
  config: AgentInboxNatsCliPublisherConfig,
  envelope: AgentInboxOutboxPublishEnvelope,
  subject: string,
  payload: string,
): string[] {
  return [
    "--timeout",
    config.timeout,
    "--server",
    config.server,
    ...(config.tlsCaFile ? ["--tlsca", config.tlsCaFile] : []),
    "--creds",
    config.credsFile,
    ...(config.jsDomain ? ["--js-domain", config.jsDomain] : []),
    "pub",
    "-J",
    "-H",
    `Nats-Msg-Id:${envelope.idempotencyKey}`,
    subject,
    payload,
  ];
}

function eventPlanePayload(envelope: AgentInboxOutboxPublishEnvelope): JsonRecord {
  return {
    ...envelope.payload,
    correlation: {
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      idempotencyKey: envelope.idempotencyKey,
      inboxItemId: envelope.inboxItemId,
      outboxId: envelope.outboxId,
    },
    trace: {
      ...envelope.trace,
      attempt: envelope.attempt,
      subject: envelope.subject,
    },
  };
}

function runNatsCli(program: string, args: string[]) {
  return new Promise<{ exitCode: number }>((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function firstCsv(value: string | undefined) {
  return optionalString(value?.split(",")[0]);
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
