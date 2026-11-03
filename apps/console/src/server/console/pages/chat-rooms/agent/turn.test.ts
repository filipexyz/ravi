import { describe, expect, test } from "bun:test";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText, type ModelMessage } from "ai";

import { listOperationsForActor, type OperationSite } from "@/server/console/operations";

import { memoryChatRoomStore } from "../store-memory";
import type { RoomEvent } from "../types";
import type { TextTurnReport } from "../usage";
import {
  applyConfirmation,
  askRavi,
  beginTurn,
  buildToolSet,
  checkRaviReply,
  finishTurn,
  pageChatToolDiagnostics,
  parseBlocks,
  postRaviFollowUp,
  requestConfirmation,
  runModelRound,
  runToolCall,
  toolNameForOperation,
  type ModelCall,
  type TurnDeps,
} from "./turn";
import { currentTurnExecutionContext, currentTurnModelMessages, historyToModelMessages } from "./prompt";

const SPEAKER = "11111111-1111-4111-8111-111111111111";
const VIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const site: OperationSite & { metadataJson: unknown } = {
  id: "55555555-5555-4555-8555-555555555555",
  organizationId: "66666666-6666-4666-8666-666666666666",
  projectId: "77777777-7777-4777-8777-777777777777",
  defaultHostname: "acme-site.ravi.page",
  defaultVisibility: "private",
  activeReleaseId: "88888888-8888-4888-8888-888888888888",
  metadataJson: { pageChat: { assistantName: "Lia", raviAgent: { installationId: "99999999-9999-4999-8999-999999999999", agentId: "main" } } },
};

async function setup(options: { kind?: "shared" | "private"; uses?: string[] } = {}) {
  const store = memoryChatRoomStore({ [SPEAKER]: { displayName: "Ana", email: "ana@acme.test" } });
  const room = await store.getOrCreateRoom({
    organizationId: site.organizationId,
    projectId: site.projectId,
    siteId: site.id,
    routeId: "44444444-4444-4444-8444-444444444444",
    kind: options.kind ?? "private",
    ownerUserId: options.kind === "shared" ? null : SPEAKER,
    path: "/relatorio",
  });
  const question = await store.insertMessage({
    room,
    authorType: "user",
    authorUserId: SPEAKER,
    authorName: "Ana",
    authorRole: "member",
    body: "Quantos pedidos abertos?",
    parts: [],
    status: "complete",
    source: "text",
    clientMessageId: "c1",
    anchor: null,
    turnId: null,
  });
  const turn = await store.insertTurn({
    roomId: room.id,
    organizationId: site.organizationId,
    projectId: site.projectId,
    siteId: site.id,
    triggerMessageId: question.message.id,
    speakerUserId: SPEAKER,
    speakerKind: "member",
    speakerOrgRole: "developer",
    pagesSessionId: "session-id",
    status: "queued",
    model: "anthropic/claude-sonnet-5.5",
  });
  const reply = await store.insertMessage({
    room,
    authorType: "agent",
    authorUserId: null,
    authorName: "Lia",
    authorRole: null,
    body: "",
    parts: [],
    status: "streaming",
    source: "text",
    clientMessageId: null,
    anchor: null,
    turnId: turn.id,
  });
  await store.updateTurn(turn.id, { replyMessageId: reply.message.id });

  const events: RoomEvent[] = [];
  const operations: Array<{ id: string; input: unknown; confirmed?: boolean; seed?: string }> = [];
  const usage: TextTurnReport[] = [];
  const modelCalls: Array<Parameters<ModelCall>[0]> = [];
  const script: Array<Awaited<ReturnType<ModelCall>>> = [];
  const requests = new Map<string, { status: string; reply: string | null; failureReason: string | null }>();
  const deps: TurnDeps = {
    store,
    publish: async ({ events: batch }) => {
      events.push(...batch);
    },
    loadSite: async () => site,
    loadUses: async () => new Set(options.uses ?? []),
    loadWidgets: async () => [{ ref: "org/pedido", name: "Pedido", description: null, fields: ["numero"] }],
    sessionActive: async () => true,
    runOperation: async (input) => {
      operations.push({ id: input.id, input: input.input, confirmed: input.confirmed, seed: input.idempotencySeed });
      return { id: input.id, class: "read", output: { rows: [{ id: "r1" }] } };
    },
    recordUsage: async (report) => {
      usage.push(report);
    },
    project: async () => {},
    callModel: async (input) => {
      modelCalls.push(input);
      const next = script.shift();
      if (!next) throw new Error("no scripted model reply");
      for (const piece of next.text.match(/.{1,5}/g) ?? []) input.onDelta(piece);
      return next;
    },
    askRavi: {
      createRequest: async () => {
        requests.set("req-1", { status: "pending", reply: null, failureReason: null });
        return "req-1";
      },
      readRequest: async (id) => requests.get(id) ?? null,
    },
  };
  return { store, room, turn, question: question.message, reply: reply.message, deps, events, operations, usage, modelCalls, script, requests };
}

const reply = (overrides: Partial<Awaited<ReturnType<ModelCall>>> = {}): Awaited<ReturnType<ModelCall>> => ({
  text: "",
  toolCalls: [],
  responseMessages: [],
  inputTokens: 100,
  cachedInputTokens: 20,
  outputTokens: 30,
  costUsd: 0.001,
  ...overrides,
});

function currentReceipt(call: Parameters<ModelCall>[0] | undefined) {
  expect(call).toBeDefined();
  const matches = call!.messages.filter((item) => item.role === "system" && item.content.startsWith("CURRENT TURN EXECUTION RECEIPT"));
  expect(matches).toHaveLength(1);
  expect(call!.system).not.toContain("CURRENT TURN EXECUTION RECEIPT");
  return matches[0]!.content as string;
}

describe("Page chat agent turn", () => {
  test("normal first-round wire is exactly the OLLO current-last transformation", async () => {
    const t = await setup({ kind: "shared", uses: ["ravi.bases.views.query"] });
    t.script.push(reply({ text: "Synthetic transport response." }));
    await runModelRound(t.turn.id, t.deps);
    const input = t.modelCalls[0]!;
    const receipt = currentReceipt(input);
    const index = input.messages.findIndex((item) => item.role === "system" && item.content === receipt);
    const previousMessages = [...input.messages.slice(0, index), ...input.messages.slice(index + 1)];
    const wires: Array<Record<string, unknown>> = [];
    const provider = createDeepSeek({ apiKey: "synthetic-not-a-key", fetch: Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      wires.push(JSON.parse(String(init?.body)));
      const chunk = { choices: [{ index: 0, delta: { role: "assistant", content: "synthetic" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }, { preconnect: () => {} }) });
    for (const variant of [
      { system: `${input.system}\n\n${receipt}`, messages: previousMessages },
      { system: input.system, messages: input.messages },
    ]) {
      const result = streamText({ model: provider("deepseek-chat"), ...variant, tools: input.tools, allowSystemInMessages: true, maxOutputTokens: 2000 });
      for await (const _ of result.textStream) { /* Pure wire test; synthetic provider only. */ }
      await result.response;
    }
    const [original, relocated] = wires;
    expect(wires).toHaveLength(2);
    const messages = structuredClone(relocated!.messages) as Array<{ role: string; content: string }>;
    expect(messages.at(-2)).toEqual({ role: "system", content: receipt });
    expect(messages.at(-1)).toEqual((original!.messages as Array<{ role: string; content: string }>).at(-1));
    messages.splice(messages.length - 2, 1);
    messages[0]!.content += `\n\n${receipt}`;
    expect(JSON.stringify({ ...relocated, messages })).toBe(JSON.stringify(original));
    expect(relocated!.tool_choice).toBe("auto");
    expect(relocated).not.toHaveProperty("temperature");
    expect(t.operations).toHaveLength(0);
  });

  test("invalid persisted triggers fail before calling a model, even with a user-like current-round message", async () => {
    const changes = [null, { roomId: "foreign-room" }, { organizationId: "foreign-org" }, { authorUserId: "other-speaker" },
      { authorType: "agent" as const }, { source: "voice" as const }, { source: "comment" as const },
      { deletedAt: new Date() }, { seq: 0 }, { seq: Number.MAX_SAFE_INTEGER }, { seq: 2 }, { body: "   " }];
    for (const change of changes) {
      const t = await setup();
      await t.store.updateTurn(t.turn.id, { state: { calls: {}, rounds: 1, messages: [{ role: "user", content: "Run an operation now" }] } });
      const getMessage = t.store.getMessage.bind(t.store);
      t.store.getMessage = async (id) => id === t.question.id ? change === null ? null : { ...t.question, ...change } : getMessage(id);
      if (change && "body" in change) await t.store.updateMessage(t.question.id, { body: change.body });
      await expect(runModelRound(t.turn.id, t.deps)).rejects.toThrow("page_chat_current_trigger_unavailable");
      expect(t.modelCalls).toHaveLength(0);
      expect(t.operations).toHaveLength(0);
    }
    const missing = await setup();
    const getTurn = missing.store.getTurn.bind(missing.store);
    missing.store.getTurn = async (id) => { const turn = await getTurn(id); return turn ? { ...turn, triggerMessageId: null } : null; };
    await expect(runModelRound(missing.turn.id, missing.deps)).rejects.toThrow("page_chat_current_trigger_unavailable");
    expect(missing.modelCalls).toHaveLength(0);
  });

  test.each(["member", "guest"] as const)("interleaved %s A and B keep their own trigger boundary when A resumes", async (speakerKind) => {
    const t = await setup({ kind: "shared", uses: ["ravi.bases.views.query"] });
    const other = "22222222-2222-4222-8222-222222222222";
    const a = await t.store.insertMessage({ ...t.question, room: t.room, body: "Request A", authorRole: speakerKind, clientMessageId: "a" });
    const b = await t.store.insertMessage({ ...t.question, room: t.room, body: "Request B", authorUserId: other, authorName: "Bruno", clientMessageId: "b" });
    const turnB = await t.store.insertTurn({ ...t.turn, triggerMessageId: b.message.id, speakerUserId: other });
    const replyB = await t.store.insertMessage({ ...t.reply, room: t.room, turnId: turnB.id });
    await t.store.updateTurn(turnB.id, { replyMessageId: replyB.message.id });
    const turnA = await t.store.insertTurn({ ...t.turn, triggerMessageId: a.message.id, speakerKind });
    const replyA = await t.store.insertMessage({ ...t.reply, room: t.room, turnId: turnA.id });
    await t.store.updateTurn(turnA.id, { replyMessageId: replyA.message.id });
    expect(a.message.seq).toBeLessThan(b.message.seq);
    expect(b.message.seq).toBeLessThan(replyB.message.seq);
    expect(replyB.message.seq).toBeLessThan(replyA.message.seq);
    const protocol: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "Response A" }] }];
    t.script.push(reply({ text: "Response A", responseMessages: protocol }));
    await runModelRound(turnA.id, t.deps);
    const firstA = t.modelCalls.at(-1)!;
    expect(JSON.stringify(firstA.messages)).toContain("Request A");
    expect(JSON.stringify(firstA.messages)).not.toContain("Request B");
    const lastUser = firstA.messages.findLastIndex((item) => item.role === "user");
    expect(firstA.messages[lastUser - 1]).toEqual({ role: "system", content: currentReceipt(firstA) });
    t.script.push(reply({ text: "Response B" }));
    await runModelRound(turnB.id, t.deps);
    expect(JSON.stringify(t.modelCalls.at(-1)!.messages)).toContain("Request A");
    expect(JSON.stringify(t.modelCalls.at(-1)!.messages)).toContain("Request B");
    t.script.push(reply({ text: "Response A resumed" }));
    await runModelRound(turnA.id, { ...t.deps });
    const resumed = t.modelCalls.at(-1)!;
    expect(JSON.stringify(resumed.messages)).not.toContain("Request B");
    expect(resumed.messages.slice(-protocol.length)).toEqual(protocol);
    expect(resumed.messages.slice(0, -protocol.length)).toEqual(firstA.messages);
    expect((await t.store.getMessage(a.message.id))?.body).toBe("Request A");
    expect((await t.store.getMessage(b.message.id))?.body).toBe("Request B");
    expect((await t.store.getMessage(replyB.message.id))?.body).toBe("Response B");
    expect(t.operations).toHaveLength(0);
  });

  test("tool diagnostics are opt-in and reject invalid correlation fields", () => {
    const context = { turnId: SPEAKER, round: 1 };
    expect(pageChatToolDiagnostics(context, { enabled: false })).toEqual({});
    expect(pageChatToolDiagnostics({ ...context, turnId: "sensitive-not-a-uuid" }, { enabled: true })).toEqual({});
    for (const round of [0, 9, 1.5]) expect(pageChatToolDiagnostics({ ...context, round }, { enabled: true })).toEqual({});
    const previous = process.env.PAGE_CHAT_TOOL_DIAGNOSTICS;
    delete process.env.PAGE_CHAT_TOOL_DIAGNOSTICS;
    try { expect(pageChatToolDiagnostics(context)).toEqual({}); }
    finally {
      if (previous === undefined) delete process.env.PAGE_CHAT_TOOL_DIAGNOSTICS;
      else process.env.PAGE_CHAT_TOOL_DIAGNOSTICS = previous;
    }
  });

  test("tool diagnostics log only allowlisted metadata, redact unknowns and never affect execution", () => {
    const lines: string[] = [];
    const hooks = pageChatToolDiagnostics({ turnId: SPEAKER, round: 2 }, { enabled: true, write: (line) => { lines.push(line); } });
    const secret = "sensitive-payload-must-not-leak";
    const start = { tools: [
      { name: "ravi_bases_views_query", inputSchema: { type: "object", description: secret }, description: secret },
      { name: secret, inputSchema: { description: secret } },
    ], messages: [{ content: secret }], instructions: secret, headers: { Authorization: secret } };
    hooks.onLanguageModelCallStart?.(start);
    const end = { finishReason: secret, content: [
      { type: "text", text: secret },
      { type: "tool-call", toolName: "ravi_bases_views_query", input: { secret } },
      { type: "tool-call", toolName: secret, input: { secret } },
    ] };
    hooks.onLanguageModelCallEnd?.(end);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(secret);
    const [before, after] = lines.map((line) => JSON.parse(line));
    expect(before).toEqual({ event: "page_chat.model_tools", turnId: SPEAKER, round: 2, phase: "sdk_start", invocation: 1,
      toolCount: 2, tools: [{ name: "ravi_bases_views_query", schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { name: "unrecognized_tool", schemaHash: null }], truncated: false,
      messageStructure: { available: true, count: 1, truncated: false, sequence: [
        { role: "unclassified", contentKind: "string", partCount: 1, truncated: false, parts: [{ type: "text" }] },
      ] } });
    expect(after).toEqual({ event: "page_chat.model_tools", turnId: SPEAKER, round: 2, phase: "sdk_end", invocation: 1,
      finishReason: "unclassified", toolCallCount: 2, toolCalls: ["ravi_bases_views_query", "unrecognized_tool"], truncated: false });
    const failing = pageChatToolDiagnostics({ turnId: SPEAKER, round: 1 }, { enabled: true, write: () => { throw new Error(secret); } });
    expect(() => failing.onLanguageModelCallStart?.(start)).not.toThrow();
    expect(() => failing.onLanguageModelCallEnd?.({ finishReason: "stop", content: [] })).not.toThrow();
  });

  test("tool diagnostics keep exact counts when bounded metadata is truncated", () => {
    const lines: string[] = [];
    const hooks = pageChatToolDiagnostics({ turnId: SPEAKER, round: 1 }, { enabled: true, write: (line) => { lines.push(line); } });
    hooks.onLanguageModelCallStart?.({ tools: Array.from({ length: 129 }, () => ({ name: "show", inputSchema: { type: "object" } })) });
    hooks.onLanguageModelCallEnd?.({ finishReason: "tool-calls", content: Array.from({ length: 129 }, () => ({ type: "tool-call", toolName: "show" })) });
    const [before, after] = lines.map((line) => JSON.parse(line));
    expect(before).toMatchObject({ toolCount: 129, truncated: true });
    expect(before.tools).toHaveLength(128);
    expect(after).toMatchObject({ toolCallCount: 129, truncated: true });
    expect(after.toolCalls).toHaveLength(128);
  });

  test("real DeepSeek adapter sends offered tools and newest request, and preserves a streamed tool call", async () => {
    const t = await setup({ kind: "shared", uses: ["ravi.bases.views.query", "ravi.bases.views.rows.create"] });
    const history = await t.store.listMessages(t.room.id, { beforeSeq: t.reply.seq, limit: 40 });
    const staleClaim = "Consultei antes, sem uma chamada real.";
    const oldReply = { ...t.reply, body: staleClaim };
    const oldTurn = { ...t.turn, replyMessageId: t.reply.id, toolCalls: 0, state: { calls: {}, messages: [], rounds: 1 } };
    const messages = historyToModelMessages([...history, oldReply], { roomKind: "shared", turns: [oldTurn] });
    const toolName = toolNameForOperation("ravi.bases.views.query");
    const requestText = `Consulte agora a view ${VIEW_ID} usando ${toolName} com limit 10.`;
    messages.push({ role: "user", content: requestText });
    const tools = buildToolSet(listOperationsForActor({ kind: "member", surface: "page_chat", site }, new Set(["ravi.bases.views.query", "ravi.bases.views.rows.create"])), { canAskRavi: false });
    let wire: Record<string, unknown> | undefined;
    const provider = createDeepSeek({ apiKey: "synthetic-not-a-key", fetch: Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      wire = JSON.parse(String(init?.body));
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-read", type: "function", function: { name: toolName, arguments: JSON.stringify({ viewId: VIEW_ID, limit: 10 }) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }, { preconnect: () => {} }) });
    const diagnostics: string[] = [];
    const result = streamText({ model: provider("deepseek-chat"), system: "Use the offered tools when requested.", messages, tools, maxOutputTokens: 2000, allowSystemInMessages: true,
      ...pageChatToolDiagnostics({ turnId: t.turn.id, round: 1 }, { enabled: true, write: (line) => { diagnostics.push(line); } }) });
    for await (const _ of result.textStream) { /* Consume exactly as production. */ }
    const calls = await result.toolCalls;
    expect(calls).toMatchObject([{ toolCallId: "call-read", toolName, input: { viewId: VIEW_ID, limit: 10 } }]);
    expect(wire?.tool_choice).toBe("auto");
    const offered = wire?.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>;
    expect(offered.map((entry) => entry.function.name)).toEqual([toolName, "ravi_bases_views_rows_create", "show"]);
    expect(offered[0]?.function.parameters.properties).toHaveProperty("viewId");
    expect(offered[0]?.function.parameters.properties).toHaveProperty("limit");
    expect((wire?.messages as Array<{ role: string; content: string }>).at(-1)).toEqual({ role: "user", content: requestText });
    expect(JSON.stringify(wire?.messages)).toContain("none_recorded");
    const sent = wire?.messages as Array<{ role: string; content: string; tool_calls?: unknown }>;
    expect(sent.some((item) => item.role === "system" && item.content.includes("none_recorded"))).toBe(true);
    expect(sent.some((item) => item.role === "tool" || item.tool_calls !== undefined)).toBe(false);
    expect(JSON.stringify(sent)).not.toContain("page_chat_history");
    expect((wire?.messages as Array<{ role: string; content: string }>).some((item) => item.role === "assistant" && item.content === staleClaim)).toBe(true);
    expect((await result.response).messages[0]).toMatchObject({ role: "assistant", content: [{ type: "tool-call", toolName }] });
    const [before, after] = diagnostics.map((line) => JSON.parse(line));
    expect(before).toMatchObject({ phase: "sdk_start", turnId: t.turn.id, round: 1, toolCount: 3 });
    expect(before.messageStructure.available).toBe(true);
    expect(before.messageStructure.sequence.at(-1).role).toBe("user");
    expect(before.messageStructure.sequence.some((message: { receipt?: { evidence?: string } }) => message.receipt?.evidence === "none_recorded")).toBe(true);
    expect(before.tools.map((entry: { name: string }) => entry.name)).toEqual([toolName, "ravi_bases_views_rows_create", "show"]);
    expect(before.tools.every((entry: { schemaHash: string }) => /^[0-9a-f]{64}$/.test(entry.schemaHash))).toBe(true);
    expect(after).toMatchObject({ phase: "sdk_end", finishReason: "tool-calls", toolCallCount: 1, toolCalls: [toolName] });
    expect(diagnostics.join("\n")).not.toContain(VIEW_ID);
    expect(diagnostics.join("\n")).not.toContain(requestText);
    // This call/result pair came from the adapter response, unlike the removed
    // historical pseudo-calls. A subsequent round must preserve it verbatim.
    const responseMessages = (await result.response).messages;
    const resumed = streamText({ model: provider("deepseek-chat"), tools, allowSystemInMessages: true,
      messages: [...messages, ...responseMessages, { role: "tool", content: [{ type: "tool-result", toolCallId: "call-read",
        toolName, output: { type: "json", value: { rows: [] } } }] }] });
    for await (const _ of resumed.textStream) { /* Synthetic wire observation, no operation is executed. */ }
    await resumed.response;
    const resumedWire = wire?.messages as Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }>;
    expect(resumedWire.filter((item) => item.tool_calls !== undefined)).toEqual([
      expect.objectContaining({ role: "assistant", tool_calls: [{ id: "call-read", type: "function",
        function: { name: toolName, arguments: JSON.stringify({ viewId: VIEW_ID, limit: 10 }) } }] }),
    ]);
    expect(resumedWire.at(-1)).toEqual({ role: "tool", tool_call_id: "call-read", content: JSON.stringify({ rows: [] }) });
    expect(JSON.stringify(resumedWire)).not.toContain("page_chat_history");
  });

  test("real adapter diagnostics observe a text-only stop without inventing tool calls", async () => {
    const diagnostics: string[] = [];
    const provider = createDeepSeek({ apiKey: "synthetic-not-a-key", fetch: Object.assign(async () => {
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic false read claim" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }, { preconnect: () => {} }) });
    const tools = buildToolSet(listOperationsForActor({ kind: "member", surface: "page_chat", site }, new Set(["ravi.bases.views.query"])), { canAskRavi: false });
    const result = streamText({ model: provider("deepseek-chat"), prompt: "Synthetic fresh read request", tools,
      ...pageChatToolDiagnostics({ turnId: SPEAKER, round: 1 }, { enabled: true, write: (line) => { diagnostics.push(line); } }) });
    for await (const _ of result.textStream) { /* Same consumer as production. */ }
    expect(await result.toolCalls).toEqual([]);
    expect(diagnostics.map((line) => JSON.parse(line))).toMatchObject([
      { phase: "sdk_start", toolCount: 2 }, { phase: "sdk_end", finishReason: "stop", toolCallCount: 0, toolCalls: [] },
    ]);
    expect(diagnostics.join("\n")).not.toContain("Synthetic");
  });

  test("streams text into the reply and finishes with usage", async () => {
    const t = await setup();
    t.script.push(reply({ text: "São 12 pedidos abertos." }));
    expect(await beginTurn(t.turn.id, t.deps)).toEqual({ ok: true });
    expect(await runModelRound(t.turn.id, t.deps)).toEqual({ kind: "final" });
    await finishTurn(t.turn.id, "complete", null, t.deps);

    const deltas = t.events.filter((event) => event.type === "message.delta").map((event) => (event.type === "message.delta" ? event.text : ""));
    expect(deltas.join("")).toBe("São 12 pedidos abertos.");
    const message = await t.store.getMessage(t.reply.id);
    expect(message?.body).toBe("São 12 pedidos abertos.");
    expect(message?.status).toBe("complete");
    expect(t.usage[0]).toMatchObject({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, costUsd: 0.001, status: "complete" });
    expect(t.modelCalls[0]?.system).toContain("You are Lia");
    expect(t.modelCalls[0]?.messages[0]).toEqual({ role: "system", content: currentReceipt(t.modelCalls[0]) });
    expect(t.modelCalls[0]?.messages[1]).toEqual({ role: "user", content: "Quantos pedidos abertos?" });
    // A finished turn is not finished twice.
    await finishTurn(t.turn.id, "complete", null, t.deps);
    expect(t.usage).toHaveLength(1);
  });

  test("runs a read as the speaker and hands the result back to the model", async () => {
    const t = await setup();
    const name = toolNameForOperation("ravi.bases.views.query");
    const responseMessages: ModelMessage[] = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: name, input: { viewId: VIEW_ID } }] }];
    t.script.push(reply({ toolCalls: [{ toolCallId: "call-1", toolName: name, input: { viewId: VIEW_ID } }], responseMessages }));
    const round = await runModelRound(t.turn.id, t.deps);
    expect(t.modelCalls[0]?.diagnosticContext).toEqual({ turnId: t.turn.id, round: 1 });
    expect(round).toEqual({ kind: "tools", calls: [{ toolCallId: "call-1", kind: "run" }] });
    await runToolCall(t.turn.id, "call-1", t.deps);
    await runToolCall(t.turn.id, "call-1", t.deps);
    expect(t.operations).toEqual([{ id: "ravi.bases.views.query", input: { viewId: VIEW_ID }, confirmed: false, seed: "call-1" }]);
    const state = (await t.store.getTurn(t.turn.id))!.state as { messages: ModelMessage[] };
    expect(state.messages.at(-1)?.role).toBe("tool");
    const message = await t.store.getMessage(t.reply.id);
    expect(message?.parts).toEqual([{ type: "tool", toolCallId: "call-1", title: expect.any(String), status: "done" }]);
    expect(currentReceipt(t.modelCalls[0])).toContain('{"scope":"current_turn_only","operations":[]}');
    t.script.push(reply({ text: "Consulta concluída." }));
    await runModelRound(t.turn.id, t.deps);
    expect(currentReceipt(t.modelCalls[1])).toContain('{"scope":"current_turn_only","operations":[{"operation":"ravi.bases.views.query","status":"succeeded"}]}');
    expect(t.modelCalls[1]?.diagnosticContext).toEqual({ turnId: t.turn.id, round: 2 });
    expect(t.modelCalls[1]?.messages.slice(-state.messages.length)).toEqual(state.messages);
    expect(t.modelCalls[1]?.messages[0]).toEqual({ role: "system", content: currentReceipt(t.modelCalls[1]) });
    expect(t.modelCalls[1]?.messages[1]).toEqual({ role: "user", content: t.question.body });
    expect(t.operations).toHaveLength(1);
  });

  test("a shared room only offers what the page uses", async () => {
    const t = await setup({ kind: "shared", uses: ["ravi.bases.views.query"] });
    t.script.push(reply({ toolCalls: [{ toolCallId: "call-1", toolName: toolNameForOperation("ravi.projects.list"), input: {} }] }));
    await runModelRound(t.turn.id, t.deps);
    const tools = Object.keys(t.modelCalls[0]!.tools);
    expect(tools).toContain(toolNameForOperation("ravi.bases.views.query"));
    expect(tools).not.toContain(toolNameForOperation("ravi.projects.list"));
    expect(t.modelCalls[0]?.system).toContain("everything you write is visible to all of them");
    expect(t.operations).toHaveLength(0);
  });

  test("show puts valid blocks on the reply and reports the invalid ones", async () => {
    const t = await setup();
    t.script.push(
      reply({
        text: "Veja:",
        toolCalls: [
          {
            toolCallId: "call-ui",
            toolName: "show",
            input: { blocks: [{ kind: "view", viewId: VIEW_ID, layout: "table" }, { kind: "card" }] },
          },
        ],
      }),
    );
    const round = await runModelRound(t.turn.id, t.deps);
    expect(round).toEqual({ kind: "tools", calls: [] });
    const message = await t.store.getMessage(t.reply.id);
    expect(message?.parts).toEqual([{ type: "ui", block: { kind: "view", viewId: VIEW_ID, layout: "table" } }]);
    expect(parseBlocks([{ kind: "card", title: "Oi", link: { label: "x", href: "javascript:alert(1)" } }]).blocks).toHaveLength(0);
  });

  test("a write waits for the stored confirmation, not the hook payload", async () => {
    const t = await setup();
    const name = toolNameForOperation("ravi.bases.views.rows.create");
    t.script.push(
      reply({ toolCalls: [{ toolCallId: "call-w", toolName: name, input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar o pedido Novo" } }] }),
    );
    const round = await runModelRound(t.turn.id, t.deps);
    expect(round).toEqual({ kind: "tools", calls: [{ toolCallId: "call-w", kind: "confirm" }] });
    const pending = await requestConfirmation(t.turn.id, "call-w", t.deps);
    expect(pending.ok).toBe(true);
    expect(await requestConfirmation(t.turn.id, "call-w", t.deps)).toEqual(pending);
    const card = (await t.store.getMessage(t.reply.id))?.parts.find((part) => part.type === "confirmation");
    expect(card).toMatchObject({ summary: "Criar o pedido Novo", status: "pending", forUserId: SPEAKER, changes: [{ label: "titulo", value: "Novo" }] });

    // The hook says confirmed but the record is still pending: nothing runs.
    await applyConfirmation(t.turn.id, "call-w", pending.confirmationId!, "confirmed", t.deps);
    expect(t.operations).toHaveLength(0);

    const t2 = await setup();
    t2.script.push(reply({ toolCalls: [{ toolCallId: "call-w", toolName: name, input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar" } }] }));
    await runModelRound(t2.turn.id, t2.deps);
    const second = await requestConfirmation(t2.turn.id, "call-w", t2.deps);
    await t2.store.decideConfirmation(second.confirmationId!, "confirmed", new Date());
    await applyConfirmation(t2.turn.id, "call-w", second.confirmationId!, "confirmed", t2.deps);
    expect(t2.operations).toEqual([
      { id: "ravi.bases.views.rows.create", input: { viewId: VIEW_ID, values: { titulo: "Novo" } }, confirmed: true, seed: second.confirmationId },
    ]);
  });

  test("an expired card marks itself expired and tells the model nothing changed", async () => {
    const t = await setup();
    const name = toolNameForOperation("ravi.bases.views.rows.create");
    t.script.push(reply({ toolCalls: [{ toolCallId: "call-w", toolName: name, input: { viewId: VIEW_ID, values: {}, summary: "Criar" } }] }));
    await runModelRound(t.turn.id, t.deps);
    const pending = await requestConfirmation(t.turn.id, "call-w", t.deps);
    await applyConfirmation(t.turn.id, "call-w", pending.confirmationId!, "expired", t.deps);
    expect((await t.store.getConfirmation(pending.confirmationId!))?.status).toBe("expired");
    const state = (await t.store.getTurn(t.turn.id))!.state as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(state.messages.at(-1))).toContain("Nothing changed");
  });

  test.each(["", "O pedido foi criado."])("post-confirmation model text is preserved exactly (%j)", async (finalText) => {
    const t = await setup();
    t.script.push(reply({ text: "Proponho criar. Confirme no cartão.", toolCalls: [{ toolCallId: "write", toolName: toolNameForOperation("ravi.bases.views.rows.create"), input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar" } }] }));
    await runModelRound(t.turn.id, t.deps);
    const pending = await requestConfirmation(t.turn.id, "write", t.deps);
    await t.store.decideConfirmation(pending.confirmationId!, "confirmed", new Date());
    const decidedReply = (await t.store.getMessage(t.reply.id))!;
    await t.store.updateMessage(t.reply.id, { parts: decidedReply.parts.map((part) => part.type === "confirmation" ? { ...part, status: "confirmed" } : part) });
    await applyConfirmation(t.turn.id, "write", pending.confirmationId!, "confirmed", t.deps);
    t.script.push(reply({ text: finalText }));
    expect(await runModelRound(t.turn.id, t.deps)).toEqual({ kind: "final" });
    expect(JSON.stringify(t.modelCalls[1]?.messages)).toContain('"tool-result"');
    expect(currentReceipt(t.modelCalls[1])).toContain('{"scope":"current_turn_only","operations":[{"operation":"ravi.bases.views.rows.create","status":"succeeded","confirmation":"confirmed"}]}');
    await finishTurn(t.turn.id, "complete", null, t.deps);
    expect((await t.store.getMessage(t.reply.id))?.body).toBe(`Proponho criar. Confirme no cartão.${finalText ? `\n\n${finalText}` : ""}`);
  });

  test.each(["confirmed", "failed", "cancelled", "expired"] as const)("resumed %s write refreshes receipt without rewriting protocol or repeating the operation", async (outcome) => {
    const t = await setup();
    const toolName = toolNameForOperation("ravi.bases.views.rows.create");
    const protocol: ModelMessage[] = [{ role: "assistant", content: [
      { type: "reasoning", text: "Synthetic reasoning: never add this to system context." },
      { type: "tool-call", toolCallId: "write", toolName, input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar" } },
    ] }];
    t.script.push(reply({ text: "Proponho criar. Confirme no cartão.", responseMessages: protocol,
      toolCalls: [{ toolCallId: "write", toolName, input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar" } }] }));
    await runModelRound(t.turn.id, t.deps);
    const pending = await requestConfirmation(t.turn.id, "write", t.deps);
    const pendingTurn = (await t.store.getTurn(t.turn.id))!;
    const pendingReply = (await t.store.getMessage(t.reply.id))!;
    const history = await t.store.listMessages(t.room.id, { beforeSeq: t.question.seq + 1, limit: 40 });
    const pendingMessages = currentTurnModelMessages(history, { roomKind: "private" }, pendingReply, pendingTurn, protocol);
    expect(pendingMessages[0]).toEqual({ role: "system", content: currentTurnExecutionContext(pendingReply, pendingTurn) });
    expect(pendingMessages[0]?.content).toContain('"status":"awaiting_confirmation"');
    expect(t.operations).toHaveLength(0);
    const decision = outcome === "failed" ? "confirmed" : outcome;
    if (decision !== "expired") {
      await t.store.decideConfirmation(pending.confirmationId!, decision, new Date());
      await t.store.updateMessage(t.reply.id, { parts: pendingReply.parts.map((part) => part.type === "confirmation" ? { ...part, status: decision } : part) });
    }
    let attempts = 0;
    const runOperation = t.deps.runOperation!;
    t.deps.runOperation = async (input) => { attempts++; if (outcome === "failed") throw new Error("Synthetic secret failure payload"); return runOperation(input); };
    await applyConfirmation(t.turn.id, "write", pending.confirmationId!, decision, { ...t.deps });
    const afterCompletion = (await t.store.getTurn(t.turn.id))!;
    const saved = afterCompletion.state as { messages: ModelMessage[]; calls: Record<string, unknown>; rounds: number };
    expect(saved.messages.slice(0, protocol.length)).toEqual(protocol);
    await applyConfirmation(t.turn.id, "write", pending.confirmationId!, decision, { ...t.deps });
    expect((await t.store.getTurn(t.turn.id))?.state).toEqual(afterCompletion.state);
    expect(attempts).toBe(decision === "confirmed" ? 1 : 0);
    t.script.push(reply({ text: "Synthetic final response", responseMessages: [{ role: "assistant", content: "Synthetic final response" }] }));
    await runModelRound(t.turn.id, { ...t.deps });
    const resumed = t.modelCalls.at(-1)!;
    const current = currentReceipt(resumed);
    expect(current).toContain(`"status":"${outcome === "confirmed" ? "succeeded" : outcome}"`);
    expect(current).not.toContain("Synthetic reasoning");
    expect(current).not.toContain("Synthetic secret failure payload");
    expect(resumed.messages[0]).toEqual({ role: "system", content: current });
    expect(resumed.messages[1]).toEqual({ role: "user", content: t.question.body });
    expect(resumed.messages.slice(2)).toEqual(saved.messages);
    const finished = (await t.store.getTurn(t.turn.id))!.state as typeof saved;
    expect(finished.messages.slice(0, saved.messages.length)).toEqual(saved.messages);
    expect(finished.calls).toEqual(saved.calls);
    expect(finished.rounds).toBe(saved.rounds + 1);
    expect(attempts).toBe(decision === "confirmed" ? 1 : 0);
  });

  test("next turn loads durable historical result even though write has no tool UI part", async () => {
    const t = await setup();
    await t.store.updateMessage(t.question.id, { body: "Crie um registro com título Novo." });
    t.script.push(reply({ text: "Confirme no cartão.", toolCalls: [{ toolCallId: "write", toolName: toolNameForOperation("ravi.bases.views.rows.create"), input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar" } }] }));
    await runModelRound(t.turn.id, t.deps);
    const pending = await requestConfirmation(t.turn.id, "write", t.deps);
    await t.store.decideConfirmation(pending.confirmationId!, "confirmed", new Date());
    await applyConfirmation(t.turn.id, "write", pending.confirmationId!, "confirmed", t.deps);
    // The service persists the decided card, separately from the workflow.
    const oldReply = (await t.store.getMessage(t.reply.id))!;
    await t.store.updateMessage(t.reply.id, { parts: oldReply.parts.map((part) => part.type === "confirmation" ? { ...part, status: "confirmed" } : part) });
    await finishTurn(t.turn.id, "complete", null, t.deps);
    const nextQuestion = await t.store.insertMessage({ ...oldReply, room: t.room, authorType: "user", authorUserId: SPEAKER, body: "Qual título acabou de gravar?", parts: [], clientMessageId: "followup", turnId: null, status: "complete" });
    const nextTurn = await t.store.insertTurn({ roomId: t.room.id, organizationId: site.organizationId, projectId: site.projectId, siteId: site.id, triggerMessageId: nextQuestion.message.id, speakerUserId: SPEAKER, speakerKind: "member", speakerOrgRole: "developer", pagesSessionId: "session-id", status: "queued", model: t.turn.model });
    const nextReply = await t.store.insertMessage({ ...oldReply, room: t.room, body: "", parts: [], clientMessageId: null, turnId: nextTurn.id, status: "streaming" });
    await t.store.updateTurn(nextTurn.id, { replyMessageId: nextReply.message.id });
    t.script.push(reply({ text: "O título foi Novo." }));
    await runModelRound(nextTurn.id, t.deps);
    const supplied = t.modelCalls.at(-1)!.messages;
    expect(currentReceipt(t.modelCalls.at(-1))).toContain('{"scope":"current_turn_only","operations":[]}');
    expect(t.operations).toHaveLength(1);
    const receipts = supplied.filter((item) => item.role === "system").map((item) => item.content).join("\n");
    expect(receipts).toContain('"status":"succeeded"');
    expect(receipts).toContain('"confirmation":"confirmed"');
    expect(supplied.some((item) => item.role === "user" && typeof item.content === "string" && item.content.includes("título Novo"))).toBe(true);
    expect(supplied.at(-2)).toEqual({ role: "system", content: currentReceipt(t.modelCalls.at(-1)) });
    expect(JSON.stringify(supplied)).not.toContain('"rows"');
    expect(supplied.some((item) => item.role === "system")).toBe(true);
  });

  test.each(["ravi.bases.views.query", "ravi.bases.views.rows.create"])("fresh %s request remains distinct from historical success", async (operationId) => {
    const t = await setup();
    t.script.push(reply({ toolCalls: [{ toolCallId: "old-read", toolName: toolNameForOperation("ravi.bases.views.query"), input: { viewId: VIEW_ID } }] }));
    await runModelRound(t.turn.id, t.deps);
    await runToolCall(t.turn.id, "old-read", t.deps);
    await finishTurn(t.turn.id, "complete", null, t.deps);
    const oldReply = (await t.store.getMessage(t.reply.id))!;
    const newText = operationId.endsWith("query") ? "Consulte agora de novo." : "Crie um novo registro.";
    const question = await t.store.insertMessage({ ...oldReply, room: t.room, authorType: "user", authorUserId: SPEAKER, body: newText, parts: [], clientMessageId: "new-request", turnId: null, status: "complete" });
    const turn = await t.store.insertTurn({ roomId: t.room.id, organizationId: site.organizationId, projectId: site.projectId, siteId: site.id, triggerMessageId: question.message.id, speakerUserId: SPEAKER, speakerKind: "member", speakerOrgRole: "developer", pagesSessionId: "session-id", status: "queued", model: t.turn.model });
    const answer = await t.store.insertMessage({ ...oldReply, room: t.room, body: "", parts: [], clientMessageId: null, turnId: turn.id, status: "streaming" });
    await t.store.updateTurn(turn.id, { replyMessageId: answer.message.id });
    t.script.push(reply({ toolCalls: [{ toolCallId: "new-call", toolName: toolNameForOperation(operationId), input: { viewId: VIEW_ID, values: { titulo: "Novo" }, summary: "Criar" } }] }));
    const round = await runModelRound(turn.id, t.deps);
    expect(round).toEqual({ kind: "tools", calls: [{ toolCallId: "new-call", kind: operationId.endsWith("query") ? "run" : "confirm" }] });
    const call = t.modelCalls.at(-1)!;
    expect(currentReceipt(call)).toContain('{"scope":"current_turn_only","operations":[]}');
    expect(call.messages.filter((item) => item.role === "system").map((item) => item.content).join("\n")).toContain('"status":"succeeded"');
    expect(call.messages.at(-1)).toEqual({ role: "user", content: newText });
    expect(t.operations).toHaveLength(1); // Only the historical read, no new effect.
    if (operationId.endsWith("query")) {
      await runToolCall(turn.id, "new-call", t.deps);
      expect(t.operations).toHaveLength(2);
    } else {
      const pending = await requestConfirmation(turn.id, "new-call", t.deps);
      expect(pending.ok).toBe(true);
      expect((await t.store.getConfirmation(pending.confirmationId!))?.status).toBe("pending");
      expect(t.operations).toHaveLength(1);
    }
  });

  test.each(["Consulte agora a view.", "Crie um novo registro.", "O que aconteceu no pedido anterior?"])("durable zero-call history is explicit before %j without forcing any operation", async (request) => {
    const t = await setup({ kind: "shared", uses: ["ravi.bases.views.query", "ravi.bases.views.rows.create"] });
    const staleClaim = "Consultei agora. Confirme no cartão para criar.";
    t.script.push(reply({ text: staleClaim, responseMessages: [{ role: "assistant", content: [{ type: "text", text: staleClaim }] }] }));
    await runModelRound(t.turn.id, t.deps);
    await finishTurn(t.turn.id, "complete", null, t.deps);
    const oldReply = (await t.store.getMessage(t.reply.id))!;
    const oldTurn = (await t.store.getTurn(t.turn.id))!;
    expect(oldTurn.toolCalls).toBe(0);
    const question = await t.store.insertMessage({ ...oldReply, room: t.room, authorType: "user", authorUserId: SPEAKER,
      authorName: "Ana", body: request, parts: [], clientMessageId: "next", turnId: null, status: "complete" });
    const nextTurn = await t.store.insertTurn({ roomId: t.room.id, organizationId: site.organizationId, projectId: site.projectId,
      siteId: site.id, triggerMessageId: question.message.id, speakerUserId: SPEAKER, speakerKind: "member", speakerOrgRole: "developer",
      pagesSessionId: "session-id", status: "queued", model: t.turn.model });
    const nextReply = await t.store.insertMessage({ ...oldReply, room: t.room, body: "", parts: [], clientMessageId: null,
      turnId: nextTurn.id, status: "streaming" });
    await t.store.updateTurn(nextTurn.id, { replyMessageId: nextReply.message.id });
    t.script.push(reply({ text: "Synthetic transport response; not acceptance of a model decision." }));
    await runModelRound(nextTurn.id, t.deps);
    const messages = t.modelCalls.at(-1)!.messages;
    expect(messages.some((item) => item.role === "assistant" && item.content === staleClaim)).toBe(true);
    expect(messages.filter((item) => item.role === "system").map((item) => item.content).join("\n")).toContain('"operationEvidence":"none_recorded"');
    expect(messages.at(-1)).toEqual({ role: "user", content: `[Ana] ${request}` });
    expect(Object.keys(t.modelCalls.at(-1)!.tools)).toContain("ravi_bases_views_query");
    expect(Object.keys(t.modelCalls.at(-1)!.tools)).toContain("ravi_bases_views_rows_create");
    expect((await t.store.getMessage(t.reply.id))?.body).toBe(staleClaim);
    expect((await t.store.getTurn(t.turn.id))?.state).toEqual(oldTurn.state);
    expect(t.operations).toHaveLength(0);
    expect((await t.store.getMessage(nextReply.message.id))?.parts).toEqual([]);
  });

  test("historical state reads are bounded and exclude other rooms, deleted replies and transcripts", async () => {
    const t = await setup();
    const historical: Array<typeof t.reply> = Array.from({ length: 45 }, (_, index) => ({ ...t.reply, id: `history-${index}`, turnId: `historical-turn-${index}` }));
    historical.push(
      { ...t.reply, id: "other-room", turnId: "must-not-read-room", roomId: "foreign-room" },
      { ...t.reply, id: "other-org", turnId: "must-not-read-org", organizationId: "foreign-org" },
      { ...t.reply, id: "deleted", turnId: "must-not-read-deleted", deletedAt: new Date() },
      { ...t.reply, id: "voice", turnId: "must-not-read-voice", source: "voice" },
      t.question,
    );
    const read = t.store.getTurn.bind(t.store);
    const fetched: string[] = [];
    t.store.getTurn = async (id) => { fetched.push(id); return read(id); };
    t.store.listMessages = async () => historical;
    t.script.push(reply({ text: "Sem executar nada." }));
    await runModelRound(t.turn.id, t.deps);
    expect(fetched[0]).toBe(t.turn.id);
    expect(fetched.length).toBeLessThanOrEqual(41);
    expect(fetched.some((id) => id.startsWith("must-not-read"))).toBe(false);
    expect(t.operations).toHaveLength(0);
  });

  test("asks the installation's Ravi and posts a late answer", async () => {
    const t = await setup();
    t.script.push(reply({ toolCalls: [{ toolCallId: "call-r", toolName: "ask_ravi", input: { question: "Qual o status do deploy?" } }] }));
    const round = await runModelRound(t.turn.id, t.deps);
    expect(round).toEqual({ kind: "tools", calls: [{ toolCallId: "call-r", kind: "ask_ravi" }] });
    const asked = await askRavi(t.turn.id, "call-r", t.deps);
    expect(asked).toEqual({ ok: true, requestId: "req-1" });
    expect(await checkRaviReply(t.turn.id, "call-r", "req-1", false, t.deps)).toEqual({ answered: false, pending: false });
    expect(await checkRaviReply(t.turn.id, "call-r", "req-1", true, t.deps)).toEqual({ answered: false, pending: true });
    expect(await postRaviFollowUp(t.turn.id, "req-1", t.deps)).toEqual({ done: false });
    t.requests.set("req-1", { status: "answered", reply: "Deploy ok às 14h.", failureReason: null });
    expect(await postRaviFollowUp(t.turn.id, "req-1", t.deps)).toEqual({ done: true });
    const messages = await t.store.listMessages(t.room.id, { limit: 10 });
    expect(messages.at(-1)).toMatchObject({ authorType: "agent", body: "Deploy ok às 14h." });
  });

  test("a failed turn says so on an empty reply", async () => {
    const t = await setup();
    await finishTurn(t.turn.id, "failed", "model_error", t.deps);
    expect((await t.store.getMessage(t.reply.id))?.status).toBe("failed");
    expect((await t.store.getMessage(t.reply.id))?.body).toContain("Não consegui responder");
    expect(t.usage[0]?.status).toBe("failed");
  });
});
