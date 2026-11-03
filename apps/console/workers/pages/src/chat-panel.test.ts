import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { chatDockSnippet, chatPanelHtml, containsRaviChatTag, replaceRaviChatTags } from "./chat-panel";

const ROOM = "33333333-3333-4333-8333-333333333333";
const ana = { type: "user", userId: "user_ana", displayName: "Ana Lima", role: "member" };
const bruno = { type: "user", userId: "user_bruno", displayName: "Bruno Costa", role: "guest" };
const agent = { type: "agent", displayName: "Ravi" };

function message(overrides: Record<string, unknown>) {
  return {
    roomId: ROOM,
    parts: [],
    status: "complete",
    source: "text",
    clientMessageId: null,
    anchor: null,
    createdAt: "2026-10-18T12:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    text: "",
    ...overrides,
  };
}

type Call = { name: string; body: Record<string, unknown>; resolve: (status: number, body: unknown) => void };

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let windows: Window[] = [];
afterEach(async () => {
  for (const win of windows) await win.happyDOM.abort();
  windows = [];
  FakeSocket.all = [];
});

/** Boots the panel in happy-dom with a fetch that parks each call until the test answers it. */
async function boot(options: { mode?: "panel" | "page"; open?: Record<string, unknown> } = {}) {
  const win = new Window({ url: "https://demo.ravi.page/_ravi/chat?path=%2Frelatorio", settings: { disableJavaScriptEvaluation: true } });
  windows.push(win);
  const html = chatPanelHtml({
    nonce: "n0nce",
    mode: options.mode ?? "panel",
    kind: "shared",
    path: "/relatorio",
    host: null,
    parentOrigin: null,
    base: "/_ravi/chat",
    loginUrl: "https://console.ravi.bot/api/pages/auth/start?returnTo=x",
  });
  win.document.write(html);
  const calls: Call[] = [];
  const fetchFake = (url: string, init: { body: string }) =>
    new Promise((resolve) => {
      calls.push({
        name: url.replace("/_ravi/chat/", ""),
        body: JSON.parse(init.body),
        resolve: (status, body) => resolve({ ok: status < 400, status, json: async () => body }),
      });
    });
  const script = html.match(/<script nonce="n0nce">([\s\S]*?)<\/script>/)![1]!;
  const raf = (callback: () => void) => setTimeout(callback, 0);
  const run = new Function(
    "window", "document", "location", "fetch", "WebSocket", "sessionStorage", "navigator",
    "requestAnimationFrame", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    script,
  );
  run(win, win.document, win.location, fetchFake, FakeSocket, win.sessionStorage, win.navigator, raf, setTimeout, clearTimeout, setInterval, clearInterval);
  const doc = win.document;
  const answer = async (name: string, status: number, body: unknown) => {
    await settle();
    const call = calls.find((c) => c.name === name && !(c as { done?: boolean }).done);
    if (!call) throw new Error(`no pending ${name} call; have ${calls.map((c) => c.name).join(",")}`);
    (call as { done?: boolean }).done = true;
    call.resolve(status, body);
    await settle();
    return call;
  };
  const panel = {
    win,
    doc,
    calls,
    answer,
    log: () => doc.getElementById("rc-log")!,
    input: () => doc.getElementById("rc-input") as unknown as HTMLTextAreaElement,
    type: async (text: string) => {
      const input = panel.input();
      input.value = text;
      input.dispatchEvent(new win.Event("input") as unknown as Event);
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
      await settle();
    },
    socket: () => FakeSocket.all.at(-1)!,
  };
  if (options.open !== undefined) await answer("open", 200, options.open);
  return panel;
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

function opened(extra: Record<string, unknown> = {}) {
  return {
    room: { id: ROOM, kind: "shared", siteId: "s", routeId: "r", path: "/relatorio", replyPolicy: "mention" },
    viewer: { userId: "user_ana", displayName: "Ana Lima", role: "member" },
    members: [
      { userId: "user_ana", displayName: "Ana Lima", role: "member" },
      { userId: "user_bruno", displayName: "Bruno Costa", role: "guest" },
    ],
    assistantName: "Ravi",
    messages: [],
    lastSeq: 0,
    lastReadSeq: 0,
    voiceEnabled: false,
    ...extra,
  };
}

describe("chat panel", () => {
  test("opens the room for this path, renders agent markdown as DOM only and connects the socket", async () => {
    const panel = await boot();
    expect(panel.calls[0]).toMatchObject({ name: "open", body: { path: "/relatorio", kind: "shared" } });
    await panel.answer(
      "open",
      200,
      opened({
        messages: [
          message({ id: "m1", seq: 1, author: bruno, text: "Oi <img src=x onerror=alert(1)>" }),
          message({
            id: "m2",
            seq: 2,
            author: agent,
            text: "**Pronto**: veja `total`.\n\n- um\n- [doc](https://docs.ravi.bot)\n- [mal](javascript:alert(1))",
          }),
        ],
        lastSeq: 2,
      }),
    );
    const log = panel.log();
    expect(log.querySelectorAll("li.rc-msg")).toHaveLength(2);
    expect(log.querySelector("img")).toBeNull();
    expect(log.textContent).toContain("Oi <img src=x onerror=alert(1)>");
    expect(log.querySelector("li.agent strong")?.textContent).toBe("Pronto");
    expect(log.querySelector("li.agent code")?.textContent).toBe("total");
    const links = [...log.querySelectorAll("li.agent a")];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://docs.ravi.bot");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(log.textContent).toContain("mal");
    expect(log.querySelector("li.other .rc-author")?.textContent).toContain("Bruno Costa");
    expect(log.querySelector("li.other .rc-badge")?.textContent).toBe("convidado");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(panel.input().disabled).toBe(false);
    expect(panel.input().getAttribute("placeholder")).toBe("Fale com o Ravi");
    expect(panel.doc.getElementById("rc-hint")!.textContent).toContain("@Ravi");

    const socket = panel.socket();
    expect(socket.url).toBe(`wss://demo.ravi.page/_ravi/chat/socket?roomId=${ROOM}&path=%2Frelatorio&kind=shared`);
    socket.open();
    await panel.answer("list", 200, { messages: [], lastSeq: 2 });
    expect(panel.calls.at(-1)!.body).toEqual({ roomId: ROOM, afterSeq: 2, limit: 100 });
  });

  test("sends without blocking the composer, keeps failures on the bubble and retries with the same id", async () => {
    const panel = await boot({ open: opened() });
    await panel.type("Primeira linha");
    expect(panel.input().value).toBe("");
    expect(panel.input().disabled).toBe(false);
    const pending = panel.log().querySelector("li.mine")!;
    expect(pending.textContent).toContain("Primeira linha");
    expect(pending.textContent).toContain("Enviando");

    // A second message goes out while the first is still in flight.
    await panel.type("Segunda");
    expect(panel.log().querySelectorAll("li.mine")).toHaveLength(2);
    const firstSend = await panel.answer("send", 429, { error: "chat_rate_limited" });
    const clientMessageId = firstSend.body.clientMessageId as string;
    expect(clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    const failed = panel.log().querySelector("li.failed")!;
    expect(failed.textContent).toContain("Muitas mensagens seguidas");
    const retry = [...failed.querySelectorAll("button")].find((b) => b.textContent === "Tentar de novo")!;
    retry.click();
    await settle();
    const resend = panel.calls.filter((c) => c.name === "send").at(-1)!;
    expect(resend.body).toEqual({ roomId: ROOM, clientMessageId, text: "Primeira linha" });

    // The echo over the socket and the HTTP answer are the same message: one bubble.
    const echoed = message({ id: "m10", seq: 10, author: ana, text: "Primeira linha", clientMessageId });
    panel.socket().push({ type: "event", event: { type: "message.created", message: echoed } });
    await settle();
    await panel.answer("send", 200, { message: echoed, turn: { id: "t1", status: "queued" } });
    const mine = [...panel.log().querySelectorAll("li.mine")];
    expect(mine.filter((li) => li.textContent?.includes("Primeira linha"))).toHaveLength(1);
    expect(mine[0]!.textContent).toContain("Ravi vai responder");
  });

  test("Shift+Enter is a newline and Enter during composition does not send", async () => {
    const panel = await boot({ open: opened() });
    const input = panel.input();
    input.value = "linha";
    input.dispatchEvent(new panel.win.KeyboardEvent("keydown", { key: "Enter", shiftKey: true }) as unknown as Event);
    input.dispatchEvent(new panel.win.KeyboardEvent("keydown", { key: "Enter", isComposing: true }) as unknown as Event);
    await settle();
    expect(panel.calls.filter((c) => c.name === "send")).toHaveLength(0);
    expect(input.value).toBe("linha");
  });

  test("streams agent deltas, shows turn status on the agent bubble and catches up on a seq gap", async () => {
    const panel = await boot({ open: opened({ lastSeq: 3, messages: [message({ id: "m3", seq: 3, author: ana, text: "Quanto vendemos?" })] }) });
    const socket = panel.socket();
    socket.open();
    await panel.answer("list", 200, { messages: [], lastSeq: 3 });

    socket.push({ type: "event", event: { type: "turn.status", turnId: "t1", messageId: "m4", status: "running", label: "consultando a base" } });
    await settle();
    let agentBubble = panel.log().querySelector("li.agent")!;
    expect(agentBubble.textContent).toContain("consultando a base");

    socket.push({ type: "event", event: { type: "message.created", message: message({ id: "m4", seq: 4, author: agent, status: "streaming", text: "" }) } });
    socket.push({ type: "event", event: { type: "message.delta", messageId: "m4", text: "Vendemos " } });
    socket.push({ type: "event", event: { type: "message.delta", messageId: "m4", text: "**R$ 10 mil**." } });
    await settle();
    agentBubble = panel.log().querySelector("li.agent")!;
    expect(panel.log().querySelectorAll("li.agent")).toHaveLength(1);
    expect(agentBubble.querySelector(".rc-text")!.textContent).toContain("Vendemos R$ 10 mil.");
    expect(agentBubble.querySelector("strong")!.textContent).toBe("R$ 10 mil");

    socket.push({ type: "event", event: { type: "turn.status", turnId: "t1", messageId: "m4", status: "complete" } });
    socket.push({ type: "event", event: { type: "message.updated", message: message({ id: "m4", seq: 4, author: agent, text: "Vendemos **R$ 10 mil**." }) } });
    await settle();
    expect(panel.log().querySelector("li.agent .rc-status")).toBeNull();

    socket.push({ type: "event", event: { type: "message.created", message: message({ id: "m7", seq: 7, author: bruno, text: "e ontem?" }) } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const catchUp = panel.calls.filter((c) => c.name === "list").at(-1)!;
    expect(catchUp.body).toEqual({ roomId: ROOM, afterSeq: 7, limit: 100 });
  });

  test("lets only the asked person confirm; others see who it waits on", async () => {
    const confirmation = (forUserId: string) => ({
      type: "confirmation",
      confirmationId: `k-${forUserId}`,
      forUserId,
      summary: "Criar o pedido **#12**",
      status: "pending",
    });
    const panel = await boot({
      open: opened({
        lastSeq: 2,
        messages: [
          message({ id: "m1", seq: 1, author: agent, text: "Posso criar?", parts: [confirmation("user_ana")] }),
          message({ id: "m2", seq: 2, author: agent, text: "E este?", parts: [confirmation("user_bruno")] }),
        ],
      }),
    });
    const [mineCard, otherCard] = [...panel.log().querySelectorAll(".rc-confirm")];
    expect(mineCard!.textContent).toContain("Criar o pedido #12");
    const buttons = [...mineCard!.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Confirmar", "Cancelar"]);
    expect(otherCard!.querySelectorAll("button")).toHaveLength(0);
    expect(otherCard!.textContent).toContain("Esperando Bruno Costa confirmar");

    (mineCard!.querySelector("button") as unknown as HTMLButtonElement).click();
    await settle();
    expect(panel.log().querySelector(".rc-confirm button")!.textContent).toBe("Confirmando…");
    const decided = await panel.answer("confirm", 200, { ok: true });
    expect(decided.body).toEqual({ roomId: ROOM, confirmationId: "k-user_ana", decision: "confirm" });
    expect(panel.log().querySelector(".rc-confirm")!.textContent).toContain("Confirmado");
  });

  test("renders tool chips, action buttons that send an action, cards and widget fallbacks", async () => {
    const panel = await boot({
      open: opened({
        lastSeq: 1,
        messages: [
          message({
            id: "m1",
            seq: 1,
            author: agent,
            text: "Escolha:",
            parts: [
              { type: "tool", toolCallId: "c1", title: "Consultando pedidos", status: "done" },
              { type: "ui", block: { kind: "actions", actions: [{ id: "a1", label: "Ver atrasados" }, { id: "a2", label: "Ver todos" }] } },
              { type: "ui", block: { kind: "card", title: "Pedido #12", fields: [{ label: "Valor", value: "R$ 90" }], link: { label: "Abrir", href: "javascript:x" } } },
              { type: "ui", block: { kind: "widget", widget: "org/kpi", data: { total: 42, label: "Pedidos" } } },
              { type: "ui", block: { kind: "view", viewId: "v1", layout: "table" } },
            ],
          }),
        ],
      }),
    });
    const bubble = panel.log().querySelector("li.agent")!;
    expect(bubble.querySelector(".rc-chip")!.textContent).toBe("Consultando pedidos");
    expect(bubble.querySelector(".rc-card a")).toBeNull();
    expect(bubble.textContent).toContain("R$ 90");
    expect(bubble.querySelector("[data-view-id=v1]")!.textContent).toContain("Ver dados");

    const widgets = await panel.answer("widgets", 200, {
      widgets: [{ v: 1, ref: { itemId: "i1", ref: "org/kpi", version: 2 }, name: "KPI", fields: { total: { type: "number", label: "Total" }, label: { type: "text" } } }],
      themeCss: null,
    });
    expect(widgets.body).toEqual({ refs: ["org/kpi"] });
    const widget = panel.log().querySelector("[data-widget='org/kpi']")!;
    expect(widget.textContent).toContain("KPI");
    expect(widget.textContent).toContain("Total");
    expect(widget.textContent).toContain("42");

    const action = [...bubble.querySelectorAll("button")].find((b) => b.textContent === "Ver atrasados")!;
    action.click();
    await settle();
    const sent = panel.calls.filter((c) => c.name === "send").at(-1)!;
    expect(sent.body).toMatchObject({
      roomId: ROOM,
      text: "Ver atrasados",
      action: { actionId: "a1", label: "Ver atrasados", replyToMessageId: "m1" },
    });
    const after = [...panel.log().querySelector("li.agent")!.querySelectorAll(".rc-row button")] as unknown as HTMLButtonElement[];
    expect(after.every((b) => b.disabled)).toBe(true);
  });

  test("shows presence avatars and who is typing", async () => {
    const panel = await boot({ open: opened() });
    const socket = panel.socket();
    socket.open();
    socket.push({ type: "presence", online: [{ userId: "user_ana", displayName: "Ana Lima" }, { userId: "user_bruno", displayName: "Bruno Costa" }] });
    socket.push({ type: "typing", userId: "user_bruno", displayName: "Bruno Costa" });
    await settle();
    const avatars = [...panel.doc.querySelectorAll("#rc-presence .rc-av")];
    expect(avatars.map((a) => a.textContent)).toEqual(["AL", "BC"]);
    expect(panel.doc.getElementById("rc-typing")!.textContent).toBe("Bruno Costa está digitando…");
    expect(panel.doc.getElementById("rc-sub")!.textContent).toContain("2 pessoas");
  });

  test("asks the viewer to sign in when the Console has no session for them", async () => {
    const panel = await boot();
    await panel.answer("open", 401, { error: "chat_session_required" });
    const gate = panel.doc.getElementById("rc-gate") as unknown as HTMLElement;
    expect(gate.hidden).toBe(false);
    expect(gate.textContent).toContain("Entre para conversar");
    expect(gate.querySelector("a")!.getAttribute("href")).toBe("https://console.ravi.bot/api/pages/auth/start?returnTo=x");
    expect(gate.querySelector("a")!.getAttribute("target")).toBe("_top");
    expect(panel.input().disabled).toBe(true);
  });

  test("switching to Só eu reopens as the private room", async () => {
    const panel = await boot({ open: opened() });
    const privateButton = panel.doc.querySelector('[data-kind="private"]') as unknown as HTMLButtonElement;
    privateButton.click();
    await settle();
    const reopen = panel.calls.filter((c) => c.name === "open").at(-1)!;
    expect(reopen.body).toEqual({ path: "/relatorio", kind: "private" });
    expect(privateButton.getAttribute("aria-checked")).toBe("true");
  });
});

describe("chat dock and <ravi-chat>", () => {
  test("the dock script is ASCII, parses, and points at the chat origin when one is set", () => {
    const local = chatDockSnippet({ chatPath: "/_ravi/chat", chatOrigin: null, voiceUrl: "/_ravi/page-chat", peekUnread: true, barId: null });
    const remote = chatDockSnippet({ chatPath: "/_ravi/chat", chatOrigin: "https://chat.ravi.page", voiceUrl: null, peekUnread: true, barId: null });
    for (const snippet of [local, remote]) {
      const body = snippet.match(/<script data-ravi-chat-dock="1">([\s\S]*?)<\/script>/)![1]!;
      expect(/^[\x00-\x7f]*$/.test(body)).toBe(true);
      expect(body).not.toContain("</");
      expect(() => new Function(body)).not.toThrow();
      expect(body).toContain("event.origin !== origin");
    }
    expect(local).toContain('"peek":true');
    expect(remote).toContain('"chatOrigin":"https://chat.ravi.page"');
    expect(remote).toContain('"peek":false');
  });

  test("opens a docked iframe on toggle and closes on the panel's message from the right origin only", async () => {
    const win = new Window({ url: "https://demo.ravi.page/relatorio?x=1", settings: { disableJavaScriptEvaluation: true } });
    windows.push(win);
    win.document.write("<!doctype html><body><p>Página</p></body>");
    const snippet = chatDockSnippet({ chatPath: "/_ravi/chat", chatOrigin: null, voiceUrl: "/_ravi/page-chat", peekUnread: false, barId: null });
    const body = snippet.match(/<script data-ravi-chat-dock="1">([\s\S]*?)<\/script>/)![1]!;
    new Function("window", "document", "location", "sessionStorage", "CustomEvent", body)(win, win.document, win.location, win.sessionStorage, win.CustomEvent);
    const dock = (win as unknown as { __raviChatDock: { toggle(): void; state(): { open: boolean; unread: number } } }).__raviChatDock;
    const states: Array<{ open: boolean; unread: number }> = [];
    win.addEventListener("ravi-chat:state", (event) => states.push((event as unknown as CustomEvent).detail));
    dock.toggle();
    expect(dock.state().open).toBe(true);
    expect(states.at(-1)).toEqual({ open: true, unread: 0 });
    const host = win.document.getElementById("ravi-chat-dock");
    expect(host).not.toBeNull();
  });

  test("replaces every form of the tag and passes height through", () => {
    const html = replaceRaviChatTags('<ravi-chat height="420"></ravi-chat><ravi-chat/><RAVI-CHAT kind="private">x</RAVI-CHAT>', {
      enabled: true,
      path: "/a b",
      chatPath: "/_ravi/chat",
      chatOrigin: "https://chat.ravi.page",
      host: "demo.ravi.page",
      loginUrl: null,
      signedIn: true,
    });
    expect(html).not.toMatch(/ravi-chat[ >/]/i);
    expect(html.match(/<iframe/g)).toHaveLength(3);
    expect(html).toContain('src="https://chat.ravi.page/_ravi/chat?mode=page&amp;kind=shared&amp;path=%2Fa+b&amp;host=demo.ravi.page"');
    expect(html).toContain("kind=private");
    expect(html).toContain("height:420px");
    expect(html).not.toContain(">x<");
  });

  test("ignores bogus heights and finds the tag in raw bytes", () => {
    const html = replaceRaviChatTags('<ravi-chat height="1px;background:url(x)"></ravi-chat>', {
      enabled: true,
      path: "/",
      chatPath: "/_ravi/chat",
      chatOrigin: null,
      host: "demo.ravi.page",
      loginUrl: null,
      signedIn: true,
    });
    expect(html).toContain("height:600px");
    expect(html).not.toContain("url(x)");
    expect(containsRaviChatTag(new TextEncoder().encode("<p>x</p><RAVI-Chat>"))).toBe(true);
    expect(containsRaviChatTag(new TextEncoder().encode("<p>ravi-chat</p>"))).toBe(false);
  });
});
