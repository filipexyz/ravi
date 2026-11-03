// One agent turn of a Page chat, split into the steps the Vercel Workflow runs
// (K11): begin, a model round (streams text to the room), one step per tool
// call, a confirmation for each write, asking the installation's Ravi, finish.
// Every step reloads what it needs from the database, so a retried or resumed
// step sees the same state. Tools run as the speaker (OperationActor), never
// as the agent. See `.ravi/specs/console/pages/chat-rooms/SPEC.md`.

import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { jsonSchema, streamText, tool, type ModelMessage, type ToolSet } from "ai";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  describeOperationChange,
  getOperationDefinition,
  listOperationDefinitions,
  listOperationsForActor,
  PAGES_READ_OPERATION_ID,
  runOperation,
  type OperationActor,
  type OperationSite,
} from "@/server/console/operations";
import { parsePageChatSiteSettings, type PageChatSiteSettings } from "@/server/console/pages/chat/site-settings";
import { KNOWLEDGE_SEARCH_ACTION_ID } from "@/server/console/pages/connectors/catalog";
import { loadUsesSnapshotFromDb } from "@/server/console/pages/connectors/host";
import { listCatalogWidgets } from "@/server/console/widgets/widget-catalog";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { publishRoomEvents, type RoomEventPublisher } from "../events";
import { toChatMessage } from "../reply-policy";
import { chatRoomStoreForDb, type ChatMessageRecord, type ChatRoomRecord, type ChatRoomStore, type ChatTurnRecord } from "../store";
import { raviUiBlockSchema, type ChatPart, type ChatTurnStatus, type RaviUiBlock } from "../types";
import { recordTextTurnUsage, type TextTurnReport } from "../usage";
import { buildSystemPrompt, currentTurnModelMessages, modelMessageStructure, type PromptPerson } from "./prompt";
import { pageChatModelTransport } from "./model-provider";
import { pageChatEngineEnabled, requirePageChatEngine } from "../../chat/engine";

/** Model calls one turn may make before it must answer. */
export const TURN_MAX_ROUNDS = 8;
/** Room messages the model sees before the one it answers. */
export const TURN_HISTORY_MESSAGES = 40;
/** Longest tool output (characters of JSON) the model receives. */
export const TOOL_OUTPUT_MAX_CHARS = 16_000;
export const TURN_MAX_OUTPUT_TOKENS = 2_000;
export const CONFIRMATION_TTL_MS = 10 * 60_000;
/** How long a Page chat ask may wait for the installation's Ravi (the Library request TTL). */
export const ASK_RAVI_TTL_MS = 24 * 60 * 60_000;

export const SHOW_TOOL = "show";
export const ASK_RAVI_TOOL = "ask_ravi";

type CallKind = "run" | "confirm" | "show" | "ask_ravi";

type TurnCallState = {
  toolName: string;
  operationId: string | null;
  input: JsonRecord;
  kind: CallKind;
  done: boolean;
  summary?: string;
  confirmationId?: string;
};

export type TurnState = {
  messages: ModelMessage[];
  calls: Record<string, TurnCallState>;
  rounds: number;
};

export type ModelRoundResult = { kind: "final" } | { kind: "tools"; calls: Array<{ toolCallId: string; kind: Exclude<CallKind, "show"> }> };

export type ModelCall = (input: {
  diagnosticContext: { turnId: string; round: number };
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  user: string;
  tags: string[];
  onDelta: (text: string) => void;
}) => Promise<{
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  responseMessages: ModelMessage[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}>;

export type TurnDeps = {
  store?: ChatRoomStore;
  publish?: RoomEventPublisher;
  callModel?: ModelCall;
  runOperation?: typeof runOperation;
  loadSite?: (siteId: string) => Promise<(OperationSite & { metadataJson: unknown }) | null>;
  loadUses?: (site: OperationSite) => Promise<Set<string>>;
  loadWidgets?: (site: OperationSite) => Promise<Array<{ ref: string; name: string; description: string | null; fields: string[] }>>;
  sessionActive?: (pagesSessionId: string) => Promise<boolean>;
  recordUsage?: (report: TextTurnReport) => Promise<void>;
  askRavi?: AskRaviDeps;
  /** Copies the room into its Base once the reply is final. */
  project?: (roomId: string) => Promise<void>;
  now?: () => Date;
};

export type AskRaviDeps = {
  createRequest: (input: {
    organizationId: string;
    projectId: string;
    fromUserId: string;
    toInstallationId: string;
    toAgentId: string;
    message: string;
    expiresAt: Date;
  }) => Promise<string | null>;
  readRequest: (id: string) => Promise<{ status: string; reply: string | null; failureReason: string | null } | null>;
};

type TurnContext = {
  turn: ChatTurnRecord;
  room: ChatRoomRecord;
  reply: ChatMessageRecord;
  site: OperationSite;
  settings: PageChatSiteSettings;
  actor: OperationActor;
  speaker: PromptPerson;
  assistantName: string;
};

// ---------------------------------------------------------------------------
// Steps

/** Marks the turn running. False when it already finished (a replayed start). */
export async function beginTurn(turnId: string, deps: TurnDeps = {}): Promise<{ ok: boolean }> {
  if (!pageChatEngineEnabled()) return { ok: false };
  const store = deps.store ?? chatRoomStoreForDb();
  const turn = await store.getTurn(turnId);
  if (!turn || turn.status === "complete" || turn.status === "failed") return { ok: false };
  if (turn.status === "queued") {
    await store.updateTurn(turnId, { status: "running", startedAt: now(deps) });
    await announceStatus(turn, "running", deps);
  }
  return { ok: true };
}

/** One model call: streams its text into the reply and returns the tool calls to run, or final. */
export async function runModelRound(turnId: string, deps: TurnDeps = {}): Promise<ModelRoundResult> {
  requirePageChatEngine();
  const store = deps.store ?? chatRoomStoreForDb();
  const context = await loadTurnContext(turnId, deps);
  const state = readState(context.turn);
  if (state.rounds >= TURN_MAX_ROUNDS) return { kind: "final" };

  const trigger = context.turn.triggerMessageId ? await store.getMessage(context.turn.triggerMessageId) : null;
  if (!trigger || trigger.roomId !== context.room.id || trigger.organizationId !== context.turn.organizationId ||
    trigger.authorType !== "user" || trigger.authorUserId !== context.turn.speakerUserId || trigger.source !== "text" || trigger.deletedAt ||
    !Number.isSafeInteger(trigger.seq) || trigger.seq < 1 || !Number.isSafeInteger(trigger.seq + 1) || trigger.seq >= context.reply.seq) {
    throw new Error("page_chat_current_trigger_unavailable");
  }
  // A concurrent writer may insert messages between this trigger and reply.
  // Keep this actor's request as the boundary, including when the turn resumes.
  const history = (await store.listMessages(context.room.id, { beforeSeq: trigger.seq + 1, limit: TURN_HISTORY_MESSAGES }))
    .filter((message) => message.id !== context.reply.id && message.roomId === context.room.id && message.organizationId === context.turn.organizationId)
    .slice(-TURN_HISTORY_MESSAGES);
  // At most TURN_HISTORY_MESSAGES reads, only for replies already visible in
  // this room. Outcomes remain server-derived even if the prose is stale.
  const historyTurns: ChatTurnRecord[] = [];
  for (const message of history) {
    if (message.authorType !== "agent" || message.source !== "text" || message.deletedAt || !message.turnId) continue;
    const historicalTurn = await store.getTurn(message.turnId);
    if (historicalTurn) historyTurns.push(historicalTurn);
  }
  const people = await store.listAuthors(context.room.id);
  const widgets = await (deps.loadWidgets ?? defaultLoadWidgets)(context.site).catch(() => []);
  const allow = context.room.kind === "shared" ? await sharedRoomAllowList(context.site, deps) : null;
  const operations = listOperationsForActor(context.actor, allow);
  const canAskRavi = Boolean(context.settings.raviAgent) && context.actor.kind === "member";
  const tools = buildToolSet(operations, { canAskRavi });

  const system = buildSystemPrompt({
    assistantName: context.assistantName,
    language: context.settings.language,
    host: context.site.defaultHostname,
    path: context.room.path,
    pageTitle: null,
    roomKind: context.room.kind,
    people,
    speaker: context.speaker,
    siteInstructions: context.settings.instructions,
    widgets,
    canAskRavi,
  });
  const messages = currentTurnModelMessages(history, { roomKind: context.room.kind, turns: historyTurns }, context.reply, context.turn, state.messages);

  const publish = deps.publish ?? publishRoomEvents;
  const host = context.site.defaultHostname;
  const separator = context.reply.body.trim() ? "\n\n" : "";
  let buffered = separator;
  let lastFlush = Date.now();
  let chain: Promise<void> = Promise.resolve();
  let sentAny = false;
  const flush = () => {
    if (!buffered || (!sentAny && buffered === separator)) return;
    const text = buffered;
    buffered = "";
    sentAny = true;
    lastFlush = Date.now();
    chain = chain.then(() => publish({ host, roomId: context.room.id, events: [{ type: "message.delta", messageId: context.reply.id, text }] }));
  };

  const result = await (deps.callModel ?? defaultCallModel)({
    diagnosticContext: { turnId: context.turn.id, round: state.rounds + 1 },
    model: context.turn.model,
    system,
    messages,
    tools,
    user: createHash("sha256").update(`ravi-page-chat:${context.turn.speakerUserId}`).digest("hex").slice(0, 32),
    tags: ["pages_chat", `org:${context.turn.organizationId}`],
    onDelta: (text) => {
      buffered += text;
      if (Date.now() - lastFlush >= 200 || buffered.length >= 400) flush();
    },
  });
  flush();
  await chain;

  const text = result.text.trim();
  const body = text ? `${context.reply.body}${separator}${text}` : context.reply.body;
  const calls: Record<string, TurnCallState> = { ...state.calls };
  const parts: ChatPart[] = [...context.reply.parts];
  const toolResults: ModelMessage[] = [];
  const pending: Array<{ toolCallId: string; kind: Exclude<CallKind, "show"> }> = [];

  for (const call of result.toolCalls) {
    const input = asRecord(call.input);
    if (call.toolName === SHOW_TOOL) {
      const shown = parseBlocks(input.blocks);
      for (const block of shown.blocks) parts.push({ type: "ui", block });
      calls[call.toolCallId] = { toolName: call.toolName, operationId: null, input, kind: "show", done: true };
      toolResults.push(toolResultMessage(call.toolCallId, call.toolName, { shown: shown.blocks.length, rejected: shown.errors }));
      continue;
    }
    if (call.toolName === ASK_RAVI_TOOL && canAskRavi) {
      calls[call.toolCallId] = { toolName: call.toolName, operationId: null, input, kind: "ask_ravi", done: false };
      pending.push({ toolCallId: call.toolCallId, kind: "ask_ravi" });
      continue;
    }
    const operation = operations.find((definition) => toolNameForOperation(definition.id) === call.toolName);
    if (!operation) {
      calls[call.toolCallId] = { toolName: call.toolName, operationId: null, input, kind: "run", done: true };
      toolResults.push(toolResultMessage(call.toolCallId, call.toolName, { error: "tool_not_available" }));
      continue;
    }
    const { summary, ...operationInput } = input;
    const kind: CallKind = operation.needsConfirmation ? "confirm" : "run";
    calls[call.toolCallId] = {
      toolName: call.toolName,
      operationId: operation.id,
      input: operationInput,
      kind,
      done: false,
      ...(typeof summary === "string" && summary.trim() ? { summary: summary.trim().slice(0, 300) } : {}),
    };
    pending.push({ toolCallId: call.toolCallId, kind });
    if (kind === "run") parts.push({ type: "tool", toolCallId: call.toolCallId, title: operation.title, status: "running" });
  }

  const nextState: TurnState = {
    messages: [...state.messages, ...result.responseMessages, ...toolResults],
    calls,
    rounds: state.rounds + 1,
  };
  await store.updateTurn(turnId, {
    state: nextState as unknown as JsonRecord,
    inputTokens: context.turn.inputTokens + result.inputTokens,
    cachedInputTokens: context.turn.cachedInputTokens + result.cachedInputTokens,
    outputTokens: context.turn.outputTokens + result.outputTokens,
    costUsd: result.costUsd === null ? context.turn.costUsd : (context.turn.costUsd ?? 0) + result.costUsd,
    toolCalls: context.turn.toolCalls + result.toolCalls.length,
  });
  const updated = await store.updateMessage(context.reply.id, { body, parts });
  if (updated) await publish({ host, roomId: context.room.id, events: [{ type: "message.updated", message: toChatMessage(updated) }] });

  // A round that only showed blocks still needs a model call to finish its sentence.
  if (pending.length === 0) return toolResults.length > 0 && nextState.rounds < TURN_MAX_ROUNDS ? { kind: "tools", calls: [] } : { kind: "final" };
  return { kind: "tools", calls: pending };
}

/** Runs one read (or the guarded ravi.pages.read) as the speaker and hands the result to the model. */
export async function runToolCall(turnId: string, toolCallId: string, deps: TurnDeps = {}): Promise<void> {
  requirePageChatEngine();
  const context = await loadTurnContext(turnId, deps);
  const state = readState(context.turn);
  const call = state.calls[toolCallId];
  if (!call || call.done || !call.operationId) return;
  const input = context.room.kind === "shared" && call.operationId === PAGES_READ_OPERATION_ID ? { path: context.room.path, cursor: call.input.cursor } : call.input;
  const output = await executeOperation(context, call.operationId, input, { confirmed: false, seed: toolCallId }, deps);
  await completeCall(context, toolCallId, output, deps);
}

/** Puts a confirmation card on the reply for the speaker. */
export async function requestConfirmation(turnId: string, toolCallId: string, deps: TurnDeps = {}): Promise<{ ok: boolean; confirmationId?: string }> {
  requirePageChatEngine();
  const store = deps.store ?? chatRoomStoreForDb();
  const context = await loadTurnContext(turnId, deps);
  const state = readState(context.turn);
  const call = state.calls[toolCallId];
  if (!call || call.done || !call.operationId) return { ok: false };
  const operation = getOperationDefinition(call.operationId);
  if (!operation) {
    await completeCall(context, toolCallId, { error: "tool_not_available" }, deps);
    return { ok: false };
  }
  // A retried step finds the card it already put up.
  if (call.confirmationId) return { ok: true, confirmationId: call.confirmationId };
  const summary = call.summary ?? operation.title;
  const confirmation = await store.insertConfirmation({
    roomId: context.room.id,
    turnId,
    messageId: context.reply.id,
    forUserId: context.turn.speakerUserId,
    toolCallId,
    operationId: call.operationId,
    input: call.input,
    summary,
    expiresAt: new Date(now(deps).getTime() + CONFIRMATION_TTL_MS),
  });
  const parts: ChatPart[] = [
    ...context.reply.parts,
    {
      type: "confirmation",
      confirmationId: confirmation.id,
      forUserId: context.turn.speakerUserId,
      summary,
      changes: describeOperationChange(call.operationId, call.input),
      status: "pending",
    },
  ];
  const updated = await store.updateMessage(context.reply.id, { parts });
  state.calls[toolCallId] = { ...call, confirmationId: confirmation.id };
  await store.updateTurn(turnId, { status: "waiting_confirmation", state: state as unknown as JsonRecord });
  if (updated) {
    await (deps.publish ?? publishRoomEvents)({
      host: context.site.defaultHostname,
      roomId: context.room.id,
      events: [{ type: "message.updated", message: toChatMessage(updated) }],
    });
  }
  await announceStatus(context.turn, "waiting_confirmation", deps, "Esperando sua confirmação");
  return { ok: true, confirmationId: confirmation.id };
}

/**
 * After the speaker decided (or the card expired): runs the write only when
 * the stored confirmation says `confirmed`, never on the hook payload alone.
 */
export async function applyConfirmation(
  turnId: string,
  toolCallId: string,
  confirmationId: string,
  outcome: "confirmed" | "cancelled" | "expired",
  deps: TurnDeps = {},
): Promise<void> {
  requirePageChatEngine();
  const store = deps.store ?? chatRoomStoreForDb();
  const context = await loadTurnContext(turnId, deps);
  const state = readState(context.turn);
  const call = state.calls[toolCallId];
  if (!call || call.done || !call.operationId) return;
  let confirmation = await store.getConfirmation(confirmationId);
  if (confirmation && confirmation.status === "pending" && outcome === "expired") {
    confirmation = (await store.decideConfirmation(confirmationId, "expired", now(deps))) ?? confirmation;
    await setConfirmationPart(context, confirmationId, "expired", deps);
  }
  await store.updateTurn(turnId, { status: "running" });
  await announceStatus(context.turn, "running", deps);
  if (!confirmation || confirmation.status !== "confirmed" || confirmation.turnId !== turnId) {
    await completeCall(
      context,
      toolCallId,
      { status: confirmation?.status ?? "cancelled", note: "The person did not confirm. Nothing changed." },
      deps,
    );
    return;
  }
  const output = await executeOperation(context, call.operationId, confirmation.input, { confirmed: true, seed: confirmationId }, deps);
  await completeCall(context, toolCallId, output, deps);
}

/** Asks the site's installation agent through a Library agent request; null when it can't be asked. */
export async function askRavi(turnId: string, toolCallId: string, deps: TurnDeps = {}): Promise<{ ok: boolean; requestId?: string }> {
  requirePageChatEngine();
  const context = await loadTurnContext(turnId, deps);
  const state = readState(context.turn);
  const call = state.calls[toolCallId];
  if (!call || call.done) return { ok: false };
  const agent = context.settings.raviAgent;
  const question = typeof call.input.question === "string" ? call.input.question.trim().slice(0, 4_000) : "";
  if (!agent || context.actor.kind !== "member" || !question) {
    await completeCall(context, toolCallId, { error: "ask_ravi_unavailable" }, deps);
    return { ok: false };
  }
  const message = [
    `Pergunta de ${context.speaker.displayName} no chat da página https://${context.site.defaultHostname}${context.room.path}:`,
    "",
    question,
    "",
    "Responda em texto. A resposta aparece no chat da página para quem estiver na conversa.",
  ].join("\n");
  const requestId = await (deps.askRavi ?? defaultAskRavi).createRequest({
    organizationId: context.turn.organizationId,
    projectId: context.turn.projectId,
    fromUserId: context.turn.speakerUserId,
    toInstallationId: agent.installationId,
    toAgentId: agent.agentId,
    message,
    expiresAt: new Date(now(deps).getTime() + ASK_RAVI_TTL_MS),
  });
  if (!requestId) {
    await completeCall(context, toolCallId, { error: "ask_ravi_unavailable", note: "The organization's Ravi agent is not taking requests." }, deps);
    return { ok: false };
  }
  return { ok: true, requestId };
}

/** Whether Ravi answered; on the last check, tells the model the answer will come later. */
export async function checkRaviReply(
  turnId: string,
  toolCallId: string,
  requestId: string,
  last: boolean,
  deps: TurnDeps = {},
): Promise<{ answered: boolean; pending: boolean }> {
  requirePageChatEngine();
  const request = await (deps.askRavi ?? defaultAskRavi).readRequest(requestId);
  const context = await loadTurnContext(turnId, deps);
  if (request && (request.status === "answered" || request.status === "failed" || request.status === "expired" || request.status === "cancelled")) {
    await completeCall(
      context,
      toolCallId,
      request.status === "answered" ? { status: "answered", reply: request.reply ?? "" } : { status: request.status, reason: request.failureReason },
      deps,
    );
    return { answered: true, pending: false };
  }
  if (!last) return { answered: false, pending: false };
  await completeCall(
    context,
    toolCallId,
    { status: "pending", note: "Ravi has not answered yet. Its answer will be posted in this conversation when it arrives." },
    deps,
  );
  return { answered: false, pending: true };
}

/** Posts a late answer from the installation's Ravi into the room. True when there is nothing more to wait for. */
export async function postRaviFollowUp(turnId: string, requestId: string, deps: TurnDeps = {}): Promise<{ done: boolean }> {
  if (!pageChatEngineEnabled()) return { done: true };
  const store = deps.store ?? chatRoomStoreForDb();
  const request = await (deps.askRavi ?? defaultAskRavi).readRequest(requestId);
  if (!request) return { done: true };
  if (request.status !== "answered" && request.status !== "failed" && request.status !== "expired" && request.status !== "cancelled") {
    return { done: false };
  }
  const context = await loadTurnContext(turnId, deps);
  const body =
    request.status === "answered"
      ? (request.reply ?? "").trim()
      : `O Ravi da organização não conseguiu responder (${request.status === "failed" ? (request.failureReason ?? "falhou") : "o prazo acabou"}).`;
  const { message } = await store.insertMessage({
    room: context.room,
    authorType: "agent",
    authorUserId: null,
    authorName: context.assistantName,
    authorRole: null,
    body,
    parts: [{ type: "notice", text: `Resposta do Ravi da organização para ${context.speaker.displayName}` }],
    status: "complete",
    source: "text",
    clientMessageId: null,
    anchor: null,
    turnId,
  });
  await (deps.publish ?? publishRoomEvents)({
    host: context.site.defaultHostname,
    roomId: context.room.id,
    events: [{ type: "message.created", message: toChatMessage(message) }],
  });
  return { done: true };
}

/** Closes the turn: final reply status, room event, usage row. */
export async function finishTurn(turnId: string, outcome: "complete" | "failed", error: string | null = null, deps: TurnDeps = {}): Promise<void> {
  // A stale workflow must not mutate preserved chat history after exclusion.
  if (!pageChatEngineEnabled()) return;
  const store = deps.store ?? chatRoomStoreForDb();
  const turn = await store.getTurn(turnId);
  if (!turn || turn.status === "complete" || turn.status === "failed") return;
  const finishedAt = now(deps);
  const reply = turn.replyMessageId ? await store.getMessage(turn.replyMessageId) : null;
  if (reply) {
    const empty = !reply.body.trim() && reply.parts.length === 0;
    const parts = reply.parts.map((part) => (part.type === "tool" && part.status === "running" ? { ...part, status: outcome === "complete" ? "done" : "failed" } : part)) as ChatPart[];
    const updated = await store.updateMessage(reply.id, {
      status: outcome === "complete" ? "complete" : "failed",
      parts,
      ...(outcome === "failed" && empty ? { body: "Não consegui responder agora. Tente de novo em instantes." } : {}),
      ...(outcome === "complete" && empty ? { body: "…" } : {}),
    });
    const room = await store.findRoom(turn.roomId);
    const site = room ? await (deps.loadSite ?? defaultLoadSite)(room.siteId) : null;
    if (updated && site) {
      await (deps.publish ?? publishRoomEvents)({
        host: site.defaultHostname,
        roomId: turn.roomId,
        events: [
          { type: "message.updated", message: toChatMessage(updated) },
          { type: "turn.status", turnId, messageId: updated.id, status: outcome },
        ],
      });
    }
  }
  const finished = await store.updateTurn(turnId, { status: outcome, error, finishedAt });
  const record = finished ?? turn;
  await (deps.recordUsage ?? recordTextTurnUsage)({
    organizationId: record.organizationId,
    projectId: record.projectId,
    siteId: record.siteId,
    roomId: record.roomId,
    turnId,
    speakerUserId: record.speakerUserId,
    model: record.model,
    inputTokens: record.inputTokens,
    cachedInputTokens: record.cachedInputTokens,
    outputTokens: record.outputTokens,
    costUsd: record.costUsd,
    toolCalls: record.toolCalls,
    status: outcome,
    finishedAt,
  }).catch((usageError) => console.error("Page chat turn usage was not recorded", { turnId, error: String(usageError) }));
  await (deps.project ?? defaultProject)(record.roomId);
}

async function defaultProject(roomId: string) {
  const { projectChatRoomIntoBase } = await import("../projection");
  await projectChatRoomIntoBase({ roomId });
}

// ---------------------------------------------------------------------------
// Helpers

/** Model-facing tool name of an operation id (`ravi.bases.views.query` -> `ravi_bases_views_query`). */
export function toolNameForOperation(id: string) {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

const SUMMARY_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: 300,
  description: "One sentence, in the conversation's language, saying what this will change. The person sees it on the confirmation card.",
} as const;

const UI_BLOCKS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["widget", "view", "chart", "actions", "card"] },
          widget: { type: "string", description: "kind widget: a Library widget ref from the list in your instructions." },
          data: { type: "object", description: "kind widget: values for the widget's fields." },
          viewId: { type: "string", description: "kind view: a base view id; each person sees the rows they may see." },
          layout: { type: "string", enum: ["list", "table", "board", "gallery"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          chartId: { type: "string", description: "kind chart: a base chart id." },
          actions: {
            type: "array",
            description: "kind actions: up to 6 buttons; a click comes back to you as a message.",
            items: { type: "object", required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" } } },
          },
          title: { type: "string", description: "kind card." },
          body: { type: "string", description: "kind card: plain text." },
          fields: { type: "array", items: { type: "object", required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } } },
          link: { type: "object", required: ["label", "href"], properties: { label: { type: "string" }, href: { type: "string" } } },
        },
      },
    },
  },
} as const;

export function buildToolSet(operations: ReturnType<typeof listOperationsForActor>, options: { canAskRavi: boolean }): ToolSet {
  const tools: ToolSet = {};
  for (const operation of operations) {
    const schema = structuredClone(operation.inputSchema("page_chat")) as Record<string, unknown> & {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    if (operation.needsConfirmation) {
      schema.properties = { ...(schema.properties ?? {}), summary: SUMMARY_PROPERTY };
      schema.required = [...(schema.required ?? []), "summary"];
    }
    tools[toolNameForOperation(operation.id)] = tool({
      description: `${operation.title}. ${operation.description}${operation.needsConfirmation ? " Changes data: the person confirms on a card before it runs." : ""}`.slice(0, 1_000),
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
    });
  }
  tools[SHOW_TOOL] = tool({
    description: "Show interface in your reply: Library widgets, base views or charts, buttons or cards. Text goes in your normal answer, not here.",
    inputSchema: jsonSchema(UI_BLOCKS_JSON_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]),
  });
  if (options.canAskRavi) {
    tools[ASK_RAVI_TOOL] = tool({
      description: "Ask the organization's own Ravi agent (its installation). Use for anything the Console tools cannot answer.",
      inputSchema: jsonSchema({
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: { question: { type: "string", minLength: 1, maxLength: 4000, description: "The question, with the context Ravi needs." } },
      }),
    });
  }
  return tools;
}

/** Valid UI blocks from the model's `show` input; invalid ones come back as errors for the model. */
export function parseBlocks(value: unknown): { blocks: RaviUiBlock[]; errors: string[] } {
  const blocks: RaviUiBlock[] = [];
  const errors: string[] = [];
  const list = Array.isArray(value) ? value.slice(0, 6) : [];
  for (const [index, item] of list.entries()) {
    const parsed = raviUiBlockSchema.safeParse(item);
    if (parsed.success) blocks.push(parsed.data);
    else errors.push(`block ${index}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  if (!Array.isArray(value)) errors.push("blocks must be an array");
  return { blocks, errors };
}

async function executeOperation(
  context: TurnContext,
  operationId: string,
  input: JsonRecord,
  options: { confirmed: boolean; seed: string },
  deps: TurnDeps,
): Promise<unknown> {
  if (context.actor.pagesSessionId && !(await (deps.sessionActive ?? defaultSessionActive)(context.actor.pagesSessionId))) {
    return { error: "session_expired", note: "The person's Pages session ended; ask them to reload the page." };
  }
  try {
    const result = await (deps.runOperation ?? runOperation)({
      id: operationId,
      actor: context.actor,
      input,
      confirmed: options.confirmed,
      idempotencySeed: options.seed,
    });
    return result.output;
  } catch (error) {
    if (error instanceof ConsoleApiError) return { error: error.payload.error, ...pickDetails(error.payload) };
    return { error: "operation_unavailable" };
  }
}

async function completeCall(context: TurnContext, toolCallId: string, output: unknown, deps: TurnDeps) {
  const store = deps.store ?? chatRoomStoreForDb();
  const fresh = await store.getTurn(context.turn.id);
  if (!fresh) return;
  const state = readState(fresh);
  const call = state.calls[toolCallId];
  if (!call || call.done) return;
  state.calls[toolCallId] = { ...call, done: true };
  state.messages.push(toolResultMessage(toolCallId, call.toolName, output));
  await store.updateTurn(fresh.id, { state: state as unknown as JsonRecord });

  const failed = Boolean(output && typeof output === "object" && "error" in (output as Record<string, unknown>));
  const reply = await store.getMessage(context.reply.id);
  if (!reply) return;
  const parts = reply.parts.map((part) =>
    part.type === "tool" && part.toolCallId === toolCallId ? { ...part, status: failed ? "failed" : "done" } : part,
  ) as ChatPart[];
  if (parts.some((part, index) => part !== reply.parts[index])) {
    const updated = await store.updateMessage(reply.id, { parts });
    if (updated) {
      await (deps.publish ?? publishRoomEvents)({
        host: context.site.defaultHostname,
        roomId: context.room.id,
        events: [{ type: "message.updated", message: toChatMessage(updated) }],
      });
    }
  }
}

async function setConfirmationPart(context: TurnContext, confirmationId: string, status: "expired", deps: TurnDeps) {
  const store = deps.store ?? chatRoomStoreForDb();
  const reply = await store.getMessage(context.reply.id);
  if (!reply) return;
  const parts = reply.parts.map((part) => (part.type === "confirmation" && part.confirmationId === confirmationId ? { ...part, status } : part)) as ChatPart[];
  const updated = await store.updateMessage(reply.id, { parts });
  if (updated) {
    await (deps.publish ?? publishRoomEvents)({
      host: context.site.defaultHostname,
      roomId: context.room.id,
      events: [{ type: "message.updated", message: toChatMessage(updated) }],
    });
  }
}

function toolResultMessage(toolCallId: string, toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value: boundedJson(output) } }],
  } as ModelMessage;
}

/** Tool output as JSON the model can take: cut to TOOL_OUTPUT_MAX_CHARS, marked when cut. */
export function boundedJson(value: unknown): never {
  const text = JSON.stringify(value ?? null) ?? "null";
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return JSON.parse(text) as never;
  return { truncated: true, preview: text.slice(0, TOOL_OUTPUT_MAX_CHARS) } as never;
}

function pickDetails(payload: Record<string, unknown>) {
  const details: Record<string, unknown> = {};
  if (payload.fieldErrors) details.fieldErrors = payload.fieldErrors;
  if (payload.current) details.current = payload.current;
  return details;
}

function readState(turn: ChatTurnRecord): TurnState {
  const raw = turn.state as Partial<TurnState>;
  return {
    messages: Array.isArray(raw.messages) ? (raw.messages as ModelMessage[]) : [],
    calls: raw.calls && typeof raw.calls === "object" ? (raw.calls as Record<string, TurnCallState>) : {},
    rounds: typeof raw.rounds === "number" ? raw.rounds : 0,
  };
}

async function loadTurnContext(turnId: string, deps: TurnDeps): Promise<TurnContext> {
  const store = deps.store ?? chatRoomStoreForDb();
  const turn = await store.getTurn(turnId);
  if (!turn) throw new Error(`page chat turn ${turnId} not found`);
  const room = await store.findRoom(turn.roomId);
  if (!room) throw new Error(`page chat room ${turn.roomId} not found`);
  const reply = turn.replyMessageId ? await store.getMessage(turn.replyMessageId) : null;
  if (!reply) throw new Error(`page chat turn ${turnId} has no reply message`);
  const loaded = await (deps.loadSite ?? defaultLoadSite)(room.siteId);
  if (!loaded) throw new Error(`page chat site ${room.siteId} not found`);
  const { metadataJson, ...site } = loaded;
  const settings = parsePageChatSiteSettings(metadataJson);
  const display = await store.findUserDisplay(turn.speakerUserId);
  const speaker: PromptPerson = { userId: turn.speakerUserId, displayName: display?.displayName ?? "Pessoa", role: turn.speakerKind };
  return {
    turn,
    room,
    reply,
    site,
    settings,
    speaker,
    assistantName: settings.assistantName ?? "Ravi",
    actor: {
      kind: turn.speakerKind,
      organizationId: turn.organizationId,
      userId: turn.speakerUserId,
      email: display?.email ?? null,
      orgRole: turn.speakerOrgRole,
      surface: "page_chat",
      requestId: `page-chat-turn:${turn.id}`,
      site,
      pagesSessionId: turn.pagesSessionId,
    },
  };
}

/** K5: in a shared room, the operations the Page itself uses, plus the site's knowledge and reading this page. */
async function sharedRoomAllowList(site: OperationSite, deps: TurnDeps): Promise<Set<string>> {
  const uses = await (deps.loadUses ?? defaultLoadUses)(site);
  uses.add(KNOWLEDGE_SEARCH_ACTION_ID);
  uses.add(PAGES_READ_OPERATION_ID);
  return uses;
}

async function announceStatus(turn: ChatTurnRecord, status: ChatTurnStatus, deps: TurnDeps, label?: string) {
  if (!turn.replyMessageId) return;
  const store = deps.store ?? chatRoomStoreForDb();
  const room = await store.findRoom(turn.roomId);
  const site = room ? await (deps.loadSite ?? defaultLoadSite)(room.siteId) : null;
  if (!site) return;
  await (deps.publish ?? publishRoomEvents)({
    host: site.defaultHostname,
    roomId: turn.roomId,
    events: [{ type: "turn.status", turnId: turn.id, messageId: turn.replyMessageId, status, ...(label ? { label } : {}) }],
  });
}

function now(deps: TurnDeps) {
  return (deps.now ?? (() => new Date()))();
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

// ---------------------------------------------------------------------------
// Production defaults

/** Opt-in observations of the actual SDK boundary, not transcript/operation evidence. */
export function pageChatToolDiagnostics(
  context: { turnId: string; round: number },
  options: { enabled?: boolean; write?: (line: string) => void } = {},
) {
  if (!(options.enabled ?? process.env.PAGE_CHAT_TOOL_DIAGNOSTICS === "1")
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.turnId)
    || !Number.isInteger(context.round) || context.round < 1 || context.round > TURN_MAX_ROUNDS) return {};
  const known = new Set([SHOW_TOOL, ASK_RAVI_TOOL, ...listOperationDefinitions().map((definition) => toolNameForOperation(definition.id))]);
  const knownName = (name: unknown) => typeof name === "string" && known.has(name) ? name : "unrecognized_tool";
  const write = options.write ?? ((line: string) => console.info(line));
  const emit = (observation: Record<string, unknown>) => {
    try {
      write(JSON.stringify({ event: "page_chat.model_tools", turnId: context.turnId, round: context.round, ...observation }));
    } catch { /* Diagnostic output must not change a model call's outcome. */ }
  };
  const schemaHash = (value: unknown): string | null => {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return createHash("sha256").update(JSON.stringify(value)).digest("hex");
    } catch { return null; }
  };
  let invocation = 0;
  return {
    onLanguageModelCallStart(event: { tools: ReadonlyArray<Record<string, unknown>> | undefined; messages?: unknown }) {
      invocation++;
      const tools = event.tools ?? [];
      emit({ phase: "sdk_start", invocation, toolCount: tools.length, tools: tools.slice(0, 128).map((entry) => {
        const name = knownName(entry.name);
        return { name, schemaHash: name !== "unrecognized_tool" ? schemaHash(entry.inputSchema) : null };
      }), truncated: tools.length > 128, messageStructure: modelMessageStructure(event.messages) });
    },
    onLanguageModelCallEnd(event: { finishReason: string; content: ReadonlyArray<{ type: string; toolName?: string }> }) {
      const calls = event.content.filter((part) => part.type === "tool-call");
      const finishReason = ["stop", "length", "content-filter", "tool-calls", "error", "other"].includes(event.finishReason) ? event.finishReason : "unclassified";
      emit({ phase: "sdk_end", invocation, finishReason, toolCallCount: calls.length,
        toolCalls: calls.slice(0, 128).map((call) => knownName(call.toolName)), truncated: calls.length > 128 });
    },
  };
}

const defaultCallModel: ModelCall = async (input) => {
  const result = streamText({
    ...pageChatModelTransport(input.model, { user: input.user, tags: input.tags }),
    system: input.system,
    messages: input.messages,
    // Transcript prose is never system context; only server-generated
    // historical and current-turn execution receipts use that role.
    allowSystemInMessages: true,
    tools: input.tools,
    maxOutputTokens: TURN_MAX_OUTPUT_TOKENS,
    ...pageChatToolDiagnostics(input.diagnosticContext),
  });
  for await (const delta of result.textStream) input.onDelta(delta);
  const [text, toolCalls, response, usage, providerMetadata] = await Promise.all([
    result.text,
    result.toolCalls,
    result.response,
    result.usage,
    result.providerMetadata,
  ]);
  const gatewayCost = Number((providerMetadata?.gateway as Record<string, unknown> | undefined)?.cost);
  return {
    text,
    toolCalls: toolCalls.map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })),
    responseMessages: response.messages as ModelMessage[],
    inputTokens: usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: Number.isFinite(gatewayCost) ? gatewayCost : null,
  };
};

async function defaultLoadSite(siteId: string) {
  const [row] = await db
    .select({
      id: schema.pageSites.id,
      organizationId: schema.pageSites.organizationId,
      projectId: schema.pageSites.projectId,
      defaultHostname: schema.pageSites.defaultHostname,
      defaultVisibility: schema.pageSites.defaultVisibility,
      activeReleaseId: schema.pageSites.activeReleaseId,
      metadataJson: schema.pageSites.metadataJson,
    })
    .from(schema.pageSites)
    .where(eq(schema.pageSites.id, siteId))
    .limit(1);
  return row ? { ...row, defaultVisibility: row.defaultVisibility as OperationSite["defaultVisibility"] } : null;
}

async function defaultLoadUses(site: OperationSite) {
  const snapshot = await loadUsesSnapshotFromDb({ releaseId: site.activeReleaseId, siteId: site.id });
  return new Set((snapshot?.uses ?? []).map((item) => item.id));
}

async function defaultLoadWidgets(site: OperationSite) {
  const [project] = await db
    .select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.id, site.projectId))
    .limit(1);
  const widgets = await listCatalogWidgets({ organizationId: site.organizationId, project: project ?? null });
  return widgets.slice(0, 30).map((widget) => ({
    ref: widget.ref,
    name: widget.name,
    description: widget.description ?? null,
    fields: Object.keys(widget.fields ?? {}).slice(0, 12),
  }));
}

async function defaultSessionActive(pagesSessionId: string) {
  const [row] = await db
    .select({ status: schema.pagesSessions.status, expiresAt: schema.pagesSessions.expiresAt })
    .from(schema.pagesSessions)
    .where(eq(schema.pagesSessions.id, pagesSessionId))
    .limit(1);
  return Boolean(row && row.status === "active" && row.expiresAt.getTime() > Date.now());
}

const defaultAskRavi: AskRaviDeps = {
  async createRequest(input) {
    const [target] = await db
      .select({ agentId: schema.installationAgents.agentId })
      .from(schema.installationAgents)
      .innerJoin(schema.localInstallations, eq(schema.localInstallations.id, schema.installationAgents.localInstallationId))
      .where(
        and(
          eq(schema.installationAgents.organizationId, input.organizationId),
          eq(schema.installationAgents.localInstallationId, input.toInstallationId),
          eq(schema.installationAgents.agentId, input.toAgentId),
          eq(schema.installationAgents.acceptsRequests, true),
          eq(schema.localInstallations.status, "active"),
          isNull(schema.localInstallations.revokedAt),
        ),
      )
      .limit(1);
    if (!target) return null;
    const created = new Date();
    const [row] = await db
      .insert(schema.agentRequests)
      .values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        fromInstallationId: null,
        fromAgentId: "page-chat",
        fromUserId: input.fromUserId,
        toInstallationId: input.toInstallationId,
        toAgentId: input.toAgentId,
        message: input.message,
        expiresAt: input.expiresAt,
        createdAt: created,
        updatedAt: created,
      })
      .returning({ id: schema.agentRequests.id });
    return row?.id ?? null;
  },
  async readRequest(id) {
    const [row] = await db
      .select({ status: schema.agentRequests.status, reply: schema.agentRequests.reply, failureReason: schema.agentRequests.failureReason, expiresAt: schema.agentRequests.expiresAt })
      .from(schema.agentRequests)
      .where(eq(schema.agentRequests.id, id))
      .limit(1);
    if (!row) return null;
    const expired = (row.status === "pending" || row.status === "delivered") && row.expiresAt.getTime() <= Date.now();
    return { status: expired ? "expired" : row.status, reply: row.reply, failureReason: row.failureReason };
  },
};
