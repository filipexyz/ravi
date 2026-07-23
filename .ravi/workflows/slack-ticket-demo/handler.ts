import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveSlackCredentialConfigFromEnv } from "../../../src/channels/slack/credentials.js";
import { respondToSlackInteraction } from "../../../src/channels/slack/interactions.js";
import { configStore } from "../../../src/config-store.js";
import { nats } from "../../../src/nats.js";
import { dbCreateRoute, dbGetRoute, type ChannelConfig } from "../../../src/router/router-db.js";

interface TriggerEnvelope {
  event?: {
    data?: Record<string, unknown>;
  };
  source?: {
    accountId?: string;
    chatId?: string;
  };
}

interface TicketRecord {
  id: string;
  problemType: string;
  problemLabel: string;
  requesterId: string;
  sourceChannelId: string;
  sourceMessageTs: string;
  dedicatedChannelId: string;
  dedicatedChannelName: string;
  ticketMessageTs?: string;
  assignedAgent: string;
  routeCreated: boolean;
  status: "created" | "closed" | "archived";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  archivedAt?: string;
}

interface TicketStore {
  tickets: Record<string, TicketRecord>;
}

type SlackBlock = Record<string, unknown>;

const WORKFLOW_DIR = join(process.cwd(), ".ravi", "workflows", "slack-ticket-demo");
const ENTRY_CARD_FILE = join(WORKFLOW_DIR, "entry-card.json");
const STATE_FILE = join(WORKFLOW_DIR, "state", "tickets.json");
const DEFAULT_AGENT = process.env.RAVI_TICKET_DEFAULT_AGENT?.trim() || "ravi-channels-migration";
const ROUTE_SESSION_PREFIX = process.env.RAVI_TICKET_ROUTE_SESSION_PREFIX?.trim() || "ravi-ticket";
const CREATE_ROUTE = process.env.RAVI_TICKET_CREATE_ROUTE === "1";

const PROBLEM_TYPES: Record<string, string> = {
  incident: "Incidente ou bug",
  access: "Acesso ou permissao",
  automation: "Automacao",
  question: "Duvida geral",
};

async function main(): Promise<void> {
  const command = process.argv[2] ?? "handle";
  if (command === "seed") {
    const channel = process.argv[3];
    if (!channel) throw new Error("Usage: bun .ravi/workflows/slack-ticket-demo/handler.ts seed <channel>");
    await seed(channel);
    return;
  }

  await handleTrigger();
}

async function seed(channel: string): Promise<void> {
  const raviChannel = resolveSlackChannel();
  const payload = await runRavi([
    "slack",
    "blocks-send",
    channel,
    ENTRY_CARD_FILE,
    "--channel",
    raviChannel.name,
    "--execute",
    "--json",
  ]);
  console.log(JSON.stringify(payload, null, 2));
}

async function handleTrigger(): Promise<void> {
  const eventFile = process.env.RAVI_TRIGGER_EVENT_FILE;
  if (!eventFile) throw new Error("RAVI_TRIGGER_EVENT_FILE is required");

  const envelope = JSON.parse(await readFile(eventFile, "utf8")) as TriggerEnvelope;
  const data = envelope.event?.data ?? {};
  const actionId = stringField(data, "actionId");
  if (actionId === "ravi_ticket_open") {
    await sendProblemTypeEphemeral(data);
    console.log("sent problem type ephemeral");
    return;
  }

  if (actionId === "ravi_ticket_close") {
    await closeTicket(data);
    return;
  }

  if (actionId === "ravi_ticket_archive") {
    await archiveTicketChannel(data);
    return;
  }

  if (actionId !== "ravi_ticket_problem_type") {
    console.log(`ignored action ${actionId || "(missing)"}`);
    return;
  }

  const problemType = selectedValue(data);
  const problemLabel = PROBLEM_TYPES[problemType] ?? "Outro";
  const requesterId = stringField(data, "userId");
  const sourceChannelId = stringField(data, "channelId");
  const sourceMessageTs = stringField(data, "messageTs");
  const responseUrlId = stringField(data, "responseUrlId");
  if (!problemType || !requesterId || !sourceChannelId) {
    throw new Error("Missing problemType, requesterId or sourceChannelId");
  }

  const now = new Date().toISOString();
  const store = await readStore();
  const existing = findDuplicateSelectionTicket(store, {
    requesterId,
    sourceChannelId,
    sourceMessageTs,
  });
  if (existing) {
    await sendTicketCreatedConfirmation({
      responseUrlId,
      sourceChannelId,
      requesterId,
      ticketId: existing.id,
      problemLabel: existing.problemLabel,
      dedicatedChannelId: existing.dedicatedChannelId,
      assignedAgent: existing.assignedAgent,
      routeCreated: existing.routeCreated,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          duplicate: true,
          id: existing.id,
          channel: existing.dedicatedChannelId,
          channelName: existing.dedicatedChannelName,
          requesterId,
          problemType: existing.problemType,
          assignedAgent: existing.assignedAgent,
          routeCreated: existing.routeCreated,
        },
        null,
        2,
      ),
    );
    return;
  }

  const id = `ticket-${Date.now().toString(36)}`;
  const dedicatedChannelName = slackChannelName(`ravi-ticket-${problemType}-${id.slice(-6)}`);
  const createResult = await slackApi("conversations.create", {
    name: dedicatedChannelName,
    is_private: "false",
  });
  const dedicatedChannelId = extractSlackChannelId(createResult);

  await slackApi("conversations.invite", {
    channel: dedicatedChannelId,
    users: requesterId,
  });

  const routeCreated = CREATE_ROUTE
    ? await createRoute({
        channelId: dedicatedChannelId,
        ticketId: id,
        agent: DEFAULT_AGENT,
      })
    : false;

  const channelMessage = await slackApi("chat.postMessage", {
    channel: dedicatedChannelId,
    text: [
      `Ticket ${id} criado.`,
      `Tipo: ${problemLabel}`,
      `Solicitante: <@${requesterId}>`,
      `Agent padrao: ${DEFAULT_AGENT}`,
      routeCreated ? "Route Ravi criada para este canal." : "Route Ravi nao criada neste demo.",
    ].join("\n"),
    blocks: JSON.stringify(
      ticketChannelBlocks({
        ticketId: id,
        problemLabel,
        requesterId,
        assignedAgent: DEFAULT_AGENT,
        routeCreated,
        status: "created",
      }),
    ),
  });
  const ticketMessageTs = stringField(channelMessage, "ts");

  store.tickets[id] = {
    id,
    problemType,
    problemLabel,
    requesterId,
    sourceChannelId,
    sourceMessageTs,
    dedicatedChannelId,
    dedicatedChannelName,
    ticketMessageTs,
    assignedAgent: DEFAULT_AGENT,
    routeCreated,
    status: "created",
    createdAt: now,
    updatedAt: now,
  };
  await writeStore(store);

  await sendTicketCreatedConfirmation({
    responseUrlId,
    sourceChannelId,
    requesterId,
    ticketId: id,
    problemLabel,
    dedicatedChannelId,
    assignedAgent: DEFAULT_AGENT,
    routeCreated,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        id,
        channel: dedicatedChannelId,
        channelName: dedicatedChannelName,
        requesterId,
        problemType,
        assignedAgent: DEFAULT_AGENT,
        routeCreated,
      },
      null,
      2,
    ),
  );
}

async function closeTicket(data: Record<string, unknown>): Promise<void> {
  const ticketId = actionValue(data);
  const user = stringField(data, "userId");
  const channel = stringField(data, "channelId");
  const messageTs = stringField(data, "messageTs");
  const store = await readStore();
  const ticket = findTicket(store, ticketId, channel);
  if (!ticket) {
    if (channel && user) {
      await postEphemeral({
        channel,
        user,
        text: "Ticket nao encontrado no state local.",
        blocks: simpleEphemeralBlocks("Ticket nao encontrado no state local."),
      });
    }
    console.log(`ticket not found for close: ${ticketId || channel || "(missing)"}`);
    return;
  }

  const now = new Date().toISOString();
  ticket.status = "closed";
  ticket.updatedAt = now;
  ticket.closedAt = now;
  await writeStore(store);

  const ts = messageTs || ticket.ticketMessageTs;
  if (ts) {
    await slackApi("chat.update", {
      channel: ticket.dedicatedChannelId,
      ts,
      text: `Ticket ${ticket.id} fechado.`,
      blocks: JSON.stringify(
        ticketChannelBlocks({
          ticketId: ticket.id,
          problemLabel: ticket.problemLabel,
          requesterId: ticket.requesterId,
          assignedAgent: ticket.assignedAgent,
          routeCreated: ticket.routeCreated,
          status: ticket.status,
        }),
      ),
    });
  }
  if (channel && user) {
    await postEphemeral({
      channel,
      user,
      text: `Ticket ${ticket.id} fechado.`,
      blocks: simpleEphemeralBlocks(`Ticket ${ticket.id} fechado.`),
    });
  }
  console.log(`closed ${ticket.id}`);
}

async function archiveTicketChannel(data: Record<string, unknown>): Promise<void> {
  const ticketId = actionValue(data);
  const user = stringField(data, "userId");
  const channel = stringField(data, "channelId");
  const store = await readStore();
  const ticket = findTicket(store, ticketId, channel);
  if (!ticket) {
    if (channel && user) {
      await postEphemeral({
        channel,
        user,
        text: "Ticket nao encontrado no state local.",
        blocks: simpleEphemeralBlocks("Ticket nao encontrado no state local."),
      });
    }
    console.log(`ticket not found for archive: ${ticketId || channel || "(missing)"}`);
    return;
  }

  if (channel && user) {
    await postEphemeral({
      channel,
      user,
      text: `Arquivando ${ticket.id}.`,
      blocks: simpleEphemeralBlocks(`Arquivando ${ticket.id}.`),
    });
  }

  const now = new Date().toISOString();
  ticket.status = "archived";
  ticket.updatedAt = now;
  ticket.archivedAt = now;
  if (!ticket.closedAt) ticket.closedAt = now;
  await writeStore(store);

  await slackApi("conversations.archive", {
    channel: ticket.dedicatedChannelId,
  });
  console.log(`archived ${ticket.id}`);
}

async function sendProblemTypeEphemeral(data: Record<string, unknown>): Promise<void> {
  const channel = stringField(data, "channelId");
  const user = stringField(data, "userId");
  if (!channel || !user) throw new Error("Missing channelId or userId for ephemeral ticket form");

  await postEphemeral({
    channel,
    user,
    text: "Escolha o tipo de problema",
    blocks: problemTypeBlocks(),
  });
}

function problemTypeBlocks(): SlackBlock[] {
  return [
    {
      type: "section",
      block_id: "ravi_ticket_ephemeral_intro",
      text: {
        type: "mrkdwn",
        text: "*Abrir ticket*\nEscolha apenas o tipo de problema. O workflow cria o canal e roteia para o agent padrao.",
      },
    },
    {
      type: "actions",
      block_id: "ravi_ticket_problem",
      elements: [
        {
          type: "static_select",
          action_id: "ravi_ticket_problem_type",
          placeholder: {
            type: "plain_text",
            text: "Tipo de problema",
            emoji: true,
          },
          options: Object.entries(PROBLEM_TYPES).map(([value, label]) => ({
            text: {
              type: "plain_text",
              text: label,
              emoji: true,
            },
            value,
          })),
        },
      ],
    },
    {
      type: "context",
      block_id: "ravi_ticket_ephemeral_context",
      elements: [
        {
          type: "mrkdwn",
          text: "Mensagem ephemeral: so voce ve este passo.",
        },
      ],
    },
  ];
}

function ticketCreatedBlocks(input: {
  ticketId: string;
  problemLabel: string;
  dedicatedChannelId: string;
  assignedAgent: string;
  routeCreated: boolean;
}): SlackBlock[] {
  return [
    {
      type: "section",
      block_id: "ravi_ticket_created_summary",
      text: {
        type: "mrkdwn",
        text: [
          `*Ticket criado:* ${input.ticketId}`,
          `*Tipo:* ${input.problemLabel}`,
          `*Canal:* <#${input.dedicatedChannelId}>`,
          `*Agent:* ${input.assignedAgent}`,
          input.routeCreated ? "*Route:* criada" : "*Route:* nao criada",
        ].join("\n"),
      },
    },
    {
      type: "actions",
      block_id: "ravi_ticket_created_actions",
      elements: [
        {
          type: "button",
          action_id: "ravi_ticket_open_channel",
          text: {
            type: "plain_text",
            text: "Abrir canal",
            emoji: true,
          },
          url: `https://slack.com/app_redirect?channel=${input.dedicatedChannelId}`,
          value: input.dedicatedChannelId,
        },
      ],
    },
  ];
}

async function sendTicketCreatedConfirmation(input: {
  responseUrlId?: string;
  sourceChannelId: string;
  requesterId: string;
  ticketId: string;
  problemLabel: string;
  dedicatedChannelId: string;
  assignedAgent: string;
  routeCreated: boolean;
}): Promise<void> {
  const text = `Ticket ${input.ticketId} criado`;
  const blocks = ticketCreatedBlocks({
    ticketId: input.ticketId,
    problemLabel: input.problemLabel,
    dedicatedChannelId: input.dedicatedChannelId,
    assignedAgent: input.assignedAgent,
    routeCreated: input.routeCreated,
  });
  if (input.responseUrlId) {
    await respondToSlackInteraction({
      responseUrlId: input.responseUrlId,
      payload: {
        replace_original: true,
        text,
        blocks,
      },
    });
    return;
  }

  await postEphemeral({
    channel: input.sourceChannelId,
    user: input.requesterId,
    text,
    blocks,
  });
}

function ticketChannelBlocks(input: {
  ticketId: string;
  problemLabel: string;
  requesterId: string;
  assignedAgent: string;
  routeCreated: boolean;
  status: "created" | "closed" | "archived";
}): SlackBlock[] {
  const statusLabel =
    input.status === "archived" ? "Arquivado" : input.status === "closed" ? "Fechado" : "Aberto";
  const actions: SlackBlock[] = [
    {
      type: "button",
      action_id: "ravi_ticket_archive",
      text: {
        type: "plain_text",
        text: "Arquivar canal",
        emoji: true,
      },
      style: "danger",
      value: input.ticketId,
      confirm: {
        title: {
          type: "plain_text",
          text: "Arquivar canal?",
          emoji: true,
        },
        text: {
          type: "mrkdwn",
          text: "Isso fecha o ticket e arquiva este canal no Slack.",
        },
        confirm: {
          type: "plain_text",
          text: "Arquivar",
          emoji: true,
        },
        deny: {
          type: "plain_text",
          text: "Cancelar",
          emoji: true,
        },
      },
    },
  ];

  if (input.status === "created") {
    actions.unshift({
      type: "button",
      action_id: "ravi_ticket_close",
      text: {
        type: "plain_text",
        text: "Fechar ticket",
        emoji: true,
      },
      style: "primary",
      value: input.ticketId,
    });
  }

  return [
    {
      type: "header",
      block_id: "ravi_ticket_channel_header",
      text: {
        type: "plain_text",
        text: `Ticket ${input.ticketId}`,
        emoji: true,
      },
    },
    {
      type: "section",
      block_id: "ravi_ticket_channel_summary",
      fields: [
        {
          type: "mrkdwn",
          text: `*Status:*\n${statusLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*Tipo:*\n${input.problemLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*Solicitante:*\n<@${input.requesterId}>`,
        },
        {
          type: "mrkdwn",
          text: `*Agent:*\n${input.assignedAgent}`,
        },
        {
          type: "mrkdwn",
          text: `*Route:*\n${input.routeCreated ? "criada" : "nao criada"}`,
        },
      ],
    },
    {
      type: "actions",
      block_id: "ravi_ticket_channel_actions",
      elements: actions,
    },
  ];
}

function simpleEphemeralBlocks(text: string): SlackBlock[] {
  return [
    {
      type: "section",
      block_id: "ravi_ticket_ephemeral_notice",
      text: {
        type: "mrkdwn",
        text,
      },
    },
  ];
}

async function createRoute(input: { channelId: string; ticketId: string; agent: string }): Promise<boolean> {
  const raviChannel = resolveSlackChannel();
  const session = slackChannelName(`${ROUTE_SESSION_PREFIX}-${input.ticketId}`).slice(0, 60);
  const pattern = `group:${input.channelId}`.toLowerCase();
  const existing = dbGetRoute(pattern, raviChannel.name);
  if (existing) return true;

  dbCreateRoute({
    accountId: raviChannel.name,
    pattern,
    agent: input.agent,
    priority: 50,
    session,
    channel: "slack",
  });
  await nats.emit("ravi.config.changed", {}).catch(() => {});
  await nats.close({ drainTimeoutMs: 500 }).catch(() => {});
  return true;
}

async function readStore(): Promise<TicketStore> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<TicketStore>;
    return { tickets: parsed.tickets ?? {} };
  } catch {
    return { tickets: {} };
  }
}

async function writeStore(store: TicketStore): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function runRavi(args: string[]): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["bun", "dist/bundle/index.js", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ravi ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function postEphemeral(input: {
  channel: string;
  user: string;
  text: string;
  blocks: SlackBlock[];
}): Promise<Record<string, unknown>> {
  return slackApi("chat.postEphemeral", {
    channel: input.channel,
    user: input.user,
    text: input.text,
    blocks: JSON.stringify(input.blocks),
  });
}

async function slackApi(method: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const channel = resolveSlackChannel();
  const config = await resolveSlackCredentialConfigFromEnv(process.env, {
    action: method,
    channel,
    channels: { [channel.name]: channel },
  });
  if (!config) throw new Error("Missing Slack credential config");

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.botToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const payload = (await res.json()) as Record<string, unknown>;
  if (!res.ok || payload.ok !== true) {
    const error = typeof payload.error === "string" ? payload.error : `${res.status} ${res.statusText}`;
    throw new Error(`Slack ${method} failed: ${error}`);
  }
  return payload;
}

function resolveSlackChannel(): ChannelConfig {
  const selector =
    process.env.RAVI_TICKET_SLACK_CHANNEL?.trim() || process.env.RAVI_TRIGGER_SOURCE_ACCOUNT_ID?.trim();
  if (!selector) {
    throw new Error("Missing Slack channel. Set RAVI_TICKET_SLACK_CHANNEL or run from a Slack trigger source.");
  }
  const channel = Object.values(configStore.getConfig().channels ?? {}).find(
    (item) => item.enabled !== false && item.provider === "slack" && item.name === selector,
  );
  if (!channel) {
    throw new Error(`Slack channel not found for selector: ${selector}`);
  }
  if (!channel.credentialConnection) {
    throw new Error(
      `Slack channel ${channel.name} has no credentialConnection. Run: ravi channels set ${channel.name} credentialConnection <connection-id>`,
    );
  }
  return channel;
}

function selectedValue(data: Record<string, unknown>): string {
  const direct = data.selectedOption;
  if (typeof direct === "string") return direct;
  const actions = data.actions;
  if (!Array.isArray(actions)) return "";
  const first = actions.find((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  const selected = first?.selectedOption ?? first?.selected_option;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return "";
  return stringField(selected as Record<string, unknown>, "value");
}

function actionValue(data: Record<string, unknown>): string {
  const direct = stringField(data, "value");
  if (direct) return direct;
  const actions = data.actions;
  if (!Array.isArray(actions)) return "";
  const first = actions.find((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  return first ? stringField(first, "value") : "";
}

function findTicket(store: TicketStore, ticketId: string, channelId: string): TicketRecord | undefined {
  if (ticketId && store.tickets[ticketId]) return store.tickets[ticketId];
  return Object.values(store.tickets).find((ticket) => ticket.dedicatedChannelId === channelId);
}

function findDuplicateSelectionTicket(
  store: TicketStore,
  input: { requesterId: string; sourceChannelId: string; sourceMessageTs: string },
): TicketRecord | undefined {
  if (!input.sourceMessageTs) return undefined;
  return Object.values(store.tickets).find(
    (ticket) =>
      ticket.requesterId === input.requesterId &&
      ticket.sourceChannelId === input.sourceChannelId &&
      ticket.sourceMessageTs === input.sourceMessageTs &&
      ticket.status !== "archived",
  );
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function extractSlackChannelId(payload: Record<string, unknown>): string {
  const item = recordField(payload, "item");
  const raw = recordField(payload, "raw");
  const channel = recordField(payload, "channel") ?? recordField(raw, "channel") ?? item;
  const id = channel ? stringField(channel, "id") : "";
  if (!id) throw new Error(`Could not extract Slack channel id from ${JSON.stringify(payload)}`);
  return id;
}

function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function slackChannelName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || `ravi-ticket-${Date.now().toString(36)}`;
}

await main();
