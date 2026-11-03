// The Page Chat frame: a same-origin shell that keeps the voice connection
// alive while the site's pages load inside an iframe, and runs the agent's
// page tools against that iframe. Served at /_ravi/page-chat?path=/x.
//
// Keep the client script free of backticks and dollar-brace sequences: it sits
// inside a template literal. Data goes in through escapedJson only.

export function pageChatShellHtml(input: { path: string; reservedPrefix: string }): string {
  const config = escapedJson({
    path: input.path,
    sessionUrl: `${input.reservedPrefix}page-chat/session`,
    closeUrl: `${input.reservedPrefix}page-chat/close`,
    execUrl: `${input.reservedPrefix}connectors/exec`,
    reservedPrefix: input.reservedPrefix,
  });
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Page Chat</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div id="pc-bar" role="toolbar" aria-label="Page Chat">
  <button id="pc-back" type="button" title="Voltar para a pagina" aria-label="Voltar para a pagina">&#8592;</button>
  <span id="pc-dot" aria-hidden="true"></span>
  <span id="pc-status" role="status">Page Chat</span>
  <span id="pc-time" aria-live="off"></span>
  <span class="pc-grow"></span>
  <label class="pc-voice"><span class="pc-sr">Voz</span><select id="pc-voice" aria-label="Voz"></select></label>
  <button id="pc-mute" type="button" disabled>Silenciar</button>
  <button id="pc-talk" type="button" class="pc-primary">Falar</button>
  <button id="pc-log-toggle" type="button" aria-expanded="true" aria-controls="pc-panel">Conversa</button>
</div>
<div id="pc-main">
  <div id="pc-stage"><iframe id="pc-frame" title="Pagina"></iframe><div id="pc-highlight" hidden></div></div>
  <aside id="pc-panel" aria-label="Conversa">
    <div id="pc-actions" aria-live="polite"></div>
    <ol id="pc-log"></ol>
    <form id="pc-form" autocomplete="off">
      <input id="pc-input" type="text" placeholder="Escreva, se preferir" aria-label="Mensagem">
      <button type="submit">Enviar</button>
    </form>
    <p id="pc-note">O audio vai direto para a OpenAI. A org paga por minuto de conversa.</p>
  </aside>
</div>
<audio id="pc-audio" autoplay></audio>
<script>window.__raviPageChatShell = true;</script>
<script>${shellScript(config)}</script>
</body>
</html>`;
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const SHELL_CSS = `
:root{color-scheme:light dark;--bg:#0f1115;--fg:#f4f5f7;--muted:#a3a8b3;--line:#272b33;--accent:#4f7cff;--warn:#f0b429;--panel:#16191f}
@media (prefers-color-scheme: light){:root{--bg:#ffffff;--fg:#14161a;--muted:#5d6370;--line:#e3e5ea;--panel:#f7f8fa}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
#pc-bar{display:flex;align-items:center;gap:8px;height:48px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--panel)}
#pc-bar button,#pc-bar select{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-height:34px;cursor:pointer}
#pc-bar button:disabled{opacity:.45;cursor:default}
#pc-bar .pc-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
#pc-bar .pc-primary.pc-live{background:#d64545;border-color:#d64545}
#pc-dot{width:10px;height:10px;border-radius:50%;background:var(--muted);flex:none}
#pc-dot.pc-on{background:#2fb36b}#pc-dot.pc-speaking{background:var(--accent)}
#pc-status{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
#pc-time{color:var(--muted);font-variant-numeric:tabular-nums}
.pc-grow{flex:1}
.pc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
#pc-main{display:flex;height:calc(100% - 48px)}
#pc-stage{position:relative;flex:1;min-width:0}
#pc-frame{width:100%;height:100%;border:0;display:block;background:#fff}
#pc-highlight{position:absolute;pointer-events:none;border:3px solid var(--accent);border-radius:6px;box-shadow:0 0 0 4000px rgba(0,0,0,.12);transition:all .15s}
#pc-panel{width:340px;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--panel)}
#pc-panel[hidden]{display:none}
#pc-actions{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 0}
.pc-chip{font-size:12px;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.pc-chip.pc-confirm{border-color:var(--warn);color:var(--fg)}
#pc-log{list-style:none;margin:0;padding:10px 12px;flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px}
#pc-log li{padding:8px 10px;border-radius:10px;max-width:92%;white-space:pre-wrap;word-break:break-word}
#pc-log li.pc-user{align-self:flex-end;background:var(--accent);color:#fff}
#pc-log li.pc-agent{align-self:flex-start;border:1px solid var(--line)}
#pc-log li.pc-pending{opacity:.6}
#pc-log li.pc-system{align-self:center;color:var(--muted);font-size:12px;border:0;padding:2px}
#pc-form{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--line)}
#pc-form input{flex:1;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
#pc-form button{font:inherit;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;padding:0 12px}
#pc-note{margin:0;padding:0 12px 10px;color:var(--muted);font-size:12px}
@media (max-width:720px){
  #pc-main{flex-direction:column}
  #pc-panel{width:auto;height:42%;border-left:0;border-top:1px solid var(--line)}
  #pc-log-toggle,.pc-voice{display:none}
  #pc-status{max-width:28vw}
}
`;

function shellScript(config: string): string {
  return `
(function () {
  "use strict";
  var cfg = ${config};
  var $ = function (id) { return document.getElementById(id); };
  var frameEl = $("pc-frame"), statusEl = $("pc-status"), dotEl = $("pc-dot"), timeEl = $("pc-time");
  var talkBtn = $("pc-talk"), muteBtn = $("pc-mute"), voiceSel = $("pc-voice"), logEl = $("pc-log");
  var actionsEl = $("pc-actions"), formEl = $("pc-form"), inputEl = $("pc-input"), audioEl = $("pc-audio");
  var highlightEl = $("pc-highlight"), panelEl = $("pc-panel");

  var VOICES = ["bossa","tempo","marin","quartz","ripple","vesper","willow","stone","gleam","meridian","beacon","delta","cinder"];
  var MAX_RESULT = 6000, MAX_SNAPSHOT = 12000, CONFIRM_TTL_MS = 120000, ACTION_TIMEOUT_MS = 15000;
  var AFFIRM = /(^|[^a-z\\u00e0-\\u00fc])(sim|pode|pode sim|confirmo|confirma|confirmado|isso|ok|okay|claro|manda|faz|yes|yeah|sure|go ahead|do it)([^a-z\\u00e0-\\u00fc]|$)/gi;
  var DENY = /(^|[^a-z\\u00e0-\\u00fc])(n\\u00e3o|nao|nope|cancela|cancelar|espera|pare)([^a-z\\u00e0-\\u00fc]|$)/gi;
  var WRITE_WORDS = /(salvar|enviar|excluir|apagar|deletar|remover|criar|confirmar|publicar|arquivar|pagar|comprar|assinar|save|send|delete|remove|create|submit|publish|archive|pay|buy|confirm)/i;

  var live = null; // { pc, dc, mic, chatSessionId, frame, startedAt, maxSeconds, ready, closing }
  var refs = new Map(), refSeq = 0;
  var pending = new Map(); // confirmationId -> { summary, createdAt, run }
  var heard = []; // { at, text } viewer speech and typed messages
  var delegations = new Map(); // delegation_id -> { calls: Map(call_id -> done), completed, continued }
  var queuedTyped = []; // typed messages waiting for the backend to be free
  var currentAgentLine = null, currentUserLine = null, lastSpeaker = null;
  var rooms = {}; // path -> Promise of the shared chat room id (null when the site has no text chat)
  var voice = "bossa";
  try { voice = localStorage.getItem("ravi.pageChat.voice") || voice; } catch (e) {}

  VOICES.forEach(function (name) {
    var opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    if (name === voice) opt.selected = true;
    voiceSel.appendChild(opt);
  });

  frameEl.src = cfg.path;
  frameEl.addEventListener("load", onFrameLoad);
  $("pc-back").addEventListener("click", function () { endConversation("viewer_closed"); location.href = framePath(); });
  $("pc-log-toggle").addEventListener("click", function () {
    var hide = !panelEl.hidden; panelEl.hidden = hide; this.setAttribute("aria-expanded", String(!hide));
  });
  talkBtn.addEventListener("click", function () { live ? endConversation("viewer_closed") : startConversation(); });
  muteBtn.addEventListener("click", toggleMute);
  voiceSel.addEventListener("change", function () {
    voice = voiceSel.value;
    try { localStorage.setItem("ravi.pageChat.voice", voice); } catch (e) {}
    if (live) { system("Trocando a voz..."); endConversation("viewer_closed", function () { startConversation(); }); }
  });
  formEl.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    sendTyped(text);
  });
  window.addEventListener("pagehide", function () { if (live) endConversation("viewer_closed"); });

  function framePath() {
    try { var l = frameEl.contentWindow.location; return l.pathname + l.search + l.hash; } catch (e) { return cfg.path; }
  }
  function frameDoc() { try { return frameEl.contentDocument; } catch (e) { return null; } }

  function onFrameLoad() {
    refs = new Map(); refSeq = 0; hideHighlight();
    var path = framePath();
    try { history.replaceState(null, "", cfg.reservedPrefix + "page-chat?path=" + encodeURIComponent(path)); } catch (e) {}
    var doc = frameDoc();
    if (doc && doc.title) document.title = doc.title + " \\u00b7 Page Chat";
    if (live && live.ready) {
      think("The person is now on " + path + (doc && doc.title ? " (" + doc.title + ")" : "") + ". Call page_read before referring to its contents.");
    }
  }

  function setStatus(text, state) {
    statusEl.textContent = text;
    dotEl.className = state ? "pc-" + state : "";
  }

  function line(kind, text) {
    var li = document.createElement("li");
    li.className = "pc-" + kind;
    li.textContent = text;
    logEl.appendChild(li);
    logEl.scrollTop = logEl.scrollHeight;
    return li;
  }
  function system(text) { lastSpeaker = null; return line("system", text); }

  function chip(text, kind) {
    var el = document.createElement("span");
    el.className = "pc-chip" + (kind ? " pc-" + kind : "");
    el.textContent = text;
    actionsEl.prepend(el);
    while (actionsEl.children.length > 4) actionsEl.lastChild.remove();
    return el;
  }

  // ----- connection ---------------------------------------------------------

  function startConversation() {
    if (live) return;
    talkBtn.disabled = true;
    setStatus("Conectando...", "");
    var pc = new RTCPeerConnection();
    var state = { pc: pc, dc: null, mic: null, ready: false, closing: false, chatSessionId: null };
    live = state;
    pc.addEventListener("track", function (event) {
      audioEl.srcObject = new MediaStream([event.track]);
      audioEl.play().catch(function () { system("Toque em qualquer lugar para ouvir."); document.addEventListener("click", function once() { audioEl.play(); document.removeEventListener("click", once); }); });
    });
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (mic) {
        state.mic = mic;
        mic.getAudioTracks().forEach(function (track) { pc.addTrack(track, mic); });
        var dc = pc.createDataChannel("oai-events");
        state.dc = dc;
        dc.addEventListener("message", function (event) { onEvent(state, event.data); });
        dc.addEventListener("close", function () { if (live === state && !state.closing) cleanup(state, "A conexao caiu.", "disconnected"); });
        return pc.createOffer();
      })
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return waitForIce(pc); })
      .then(function () {
        return fetch(cfg.sessionUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sdp: pc.localDescription.sdp, path: framePath(), voice: voice })
        });
      })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error(errorText(body && body.error));
          return body;
        });
      })
      .then(function (body) {
        state.chatSessionId = body.chatSessionId;
        state.frame = body.frame || {};
        state.maxSeconds = body.sessionMaxSeconds || 600;
        state.startedAt = Date.now();
        state.timer = setInterval(function () { tick(state); }, 1000);
        state.hardStop = setTimeout(function () { if (live === state) endConversation("limit_reached"); }, (state.maxSeconds + 20) * 1000);
        return pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
      })
      .catch(function (error) {
        system(error && error.message ? error.message : "Nao consegui iniciar a conversa.");
        cleanup(state, null, "error");
      });
  }

  function waitForIce(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () { pc.removeEventListener("icegatheringstatechange", check); reject(new Error("A rede demorou para responder.")); }, 10000);
      function check() { if (pc.iceGatheringState === "complete") { clearTimeout(timeout); pc.removeEventListener("icegatheringstatechange", check); resolve(); } }
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  function errorText(code) {
    var map = {
      page_chat_session_required: "Entre no site para falar com o assistente.",
      page_chat_disabled_for_site: "O Page Chat esta desligado neste site.",
      feature_unavailable: "O Page Chat nao esta ligado nesta organizacao.",
      org_concurrency_limit: "Muitas conversas abertas na organizacao agora. Tente em instantes.",
      org_budget_exhausted: "O limite de voz da organizacao neste mes acabou.",
      viewer_daily_limit: "Voce usou todo o tempo de voz de hoje.",
      page_chat_busy: "O servico de voz esta ocupado. Tente em instantes.",
      page_chat_not_configured: "O Page Chat ainda nao foi configurado neste servidor."
    };
    return map[code] || "Nao consegui iniciar a conversa.";
  }

  function tick(state) {
    if (live !== state || !state.startedAt) return;
    var left = Math.max(0, state.maxSeconds - Math.floor((Date.now() - state.startedAt) / 1000));
    timeEl.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  }

  function endConversation(reason, then) {
    var state = live;
    if (!state) { if (then) then(); return; }
    if (state.closing) return;
    state.closing = true;
    setStatus("Encerrando...", "");
    send(state, { type: "session.close" });
    notifyClose(state, reason);
    state.afterClose = then || null;
    state.closeTimer = setTimeout(function () { cleanup(state, null); }, 8000);
  }

  // Tells the Worker the conversation ended, once, so it stops billing the clock.
  function notifyClose(state, reason) {
    if (!state.chatSessionId || state.closeNotified) return;
    state.closeNotified = true;
    fetch(cfg.closeUrl, {
      method: "POST", credentials: "same-origin", keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatSessionId: state.chatSessionId, reason: reason })
    }).catch(function () {});
  }

  // The call is a mode of the page's conversation: each finished line goes into its shared room.
  function roomFor(path) {
    if (!rooms[path]) {
      rooms[path] = fetch(cfg.reservedPrefix + "chat/open", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path, kind: "shared" })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) { return body && body.room ? body.room.id : null; })
        .catch(function () { delete rooms[path]; return null; });
    }
    return rooms[path];
  }
  function mirrorLine(el, speaker) {
    if (!el || el.mirrored) return;
    el.mirrored = true;
    var text = String(el.textContent || "").trim();
    if (!text) return;
    roomFor(framePath().split(/[?#]/)[0] || "/").then(function (roomId) {
      if (!roomId) return;
      fetch(cfg.reservedPrefix + "chat/send", {
        method: "POST", credentials: "same-origin", keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: roomId, clientMessageId: "voice_" + Math.random().toString(36).slice(2), text: text.slice(0, 4000), source: "voice", speaker: speaker })
      }).catch(function () {});
    });
  }

  function cleanup(state, message, reason) {
    if (state.cleaned) return;
    state.cleaned = true;
    mirrorLine(currentUserLine, "user"); mirrorLine(currentAgentLine, "assistant");
    notifyClose(state, reason || "disconnected");
    clearInterval(state.timer); clearTimeout(state.hardStop); clearTimeout(state.closeTimer);
    if (state.mic) state.mic.getTracks().forEach(function (t) { t.stop(); });
    try { state.dc && state.dc.close(); } catch (e) {}
    try { state.pc.close(); } catch (e) {}
    audioEl.srcObject = null;
    if (live === state) live = null;
    pending.clear(); delegations.clear();
    talkBtn.disabled = false; talkBtn.textContent = "Falar"; talkBtn.classList.remove("pc-live");
    muteBtn.disabled = true; muteBtn.textContent = "Silenciar";
    timeEl.textContent = "";
    setStatus("Conversa encerrada", "");
    if (message) system(message);
    queuedTyped.forEach(function (item) { item.el.classList.remove("pc-pending"); item.el.title = "Nao entregue"; });
    queuedTyped = [];
    if (state.afterClose) state.afterClose();
  }

  function toggleMute() {
    if (!live || !live.mic) return;
    var track = live.mic.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    muteBtn.textContent = track.enabled ? "Silenciar" : "Ativar mic";
  }

  function send(state, event) {
    if (!state || !state.dc || state.dc.readyState !== "open") return false;
    if (!event.event_id) event.event_id = "pc_" + Math.random().toString(36).slice(2);
    state.dc.send(JSON.stringify(event));
    return true;
  }
  function think(content) {
    send(live, { type: "session.thinking.append", delegation_id: null, content: String(content).slice(0, 1500) });
  }

  // ----- events --------------------------------------------------------------

  function onEvent(state, data) {
    var event;
    try { event = JSON.parse(data); } catch (e) { return; }
    if (live !== state) return;
    switch (event.type) {
      case "session.started":
        state.ready = true;
        talkBtn.disabled = false; talkBtn.textContent = "Encerrar"; talkBtn.classList.add("pc-live");
        muteBtn.disabled = false;
        setStatus((state.frame && state.frame.assistantName) || "Ravi", "on");
        send(state, { type: "session.instructions.append", delegation_id: null, content: "Greet the person in one short sentence and ask how you can help on this page." });
        flushTyped(state);
        break;
      case "session.input_transcript.delta":
        remember(String(event.delta || ""));
        if (lastSpeaker !== "user" || !currentUserLine) { mirrorLine(currentAgentLine, "assistant"); currentUserLine = line("user", ""); lastSpeaker = "user"; }
        currentUserLine.textContent += event.delta || "";
        break;
      case "session.output_transcript.delta":
        if (lastSpeaker !== "agent" || !currentAgentLine) { mirrorLine(currentUserLine, "user"); currentAgentLine = line("agent", ""); lastSpeaker = "agent"; }
        currentAgentLine.textContent += event.delta || "";
        logEl.scrollTop = logEl.scrollHeight;
        setStatus((state.frame && state.frame.assistantName) || "Ravi", "speaking");
        clearTimeout(state.speakTimer);
        state.speakTimer = setTimeout(function () { if (live === state) setStatus((state.frame && state.frame.assistantName) || "Ravi", "on"); }, 900);
        break;
      case "response.event":
        onResponseEvent(state, event.delegation_id, event.event || {});
        break;
      case "session.closed":
        cleanup(state, "Conversa encerrada.");
        break;
      case "error":
        if (event.error && event.error.message) system("Erro: " + event.error.message);
        break;
    }
  }

  function delegationFor(id) {
    var key = id || "_";
    var d = delegations.get(key);
    if (!d) { d = { calls: new Map(), completed: false }; delegations.set(key, d); }
    return d;
  }

  function onResponseEvent(state, delegationId, nested) {
    var d = delegationFor(delegationId);
    if (nested.type === "response.created") { d.completed = false; d.calls = new Map(); markTypedDelivered(); return; }
    if (nested.type === "response.output_item.done" && nested.item && nested.item.type === "function_call") {
      var item = nested.item;
      d.calls.set(item.call_id, false);
      runTool(item.name, item.arguments).then(function (result) {
        if (live !== state) return;
        send(state, { type: "response.item.create", item: { type: "function_call_output", call_id: item.call_id, output: clip(JSON.stringify(result), MAX_RESULT) } });
        d.calls.set(item.call_id, true);
        maybeContinue(state, d);
      });
      return;
    }
    if (nested.type === "response.completed" || nested.type === "response.failed" || nested.type === "response.incomplete") {
      d.completed = true;
      maybeContinue(state, d);
    }
  }

  function maybeContinue(state, d) {
    if (!d.completed || d.calls.size === 0) { if (d.completed && d.calls.size === 0) flushTyped(state); return; }
    var all = true;
    d.calls.forEach(function (done) { if (!done) all = false; });
    if (!all) return;
    d.calls = new Map();
    d.completed = false;
    send(state, { type: "response.create" });
  }

  // A Responses turn waiting for tool results cannot take a new user message.
  function backendBusy() {
    var busy = false;
    delegations.forEach(function (d) { if (d.calls.size > 0) busy = true; });
    return busy;
  }

  // Sending never blocks the box: a typed message shows at once as pending and
  // goes to the backend as soon as no tool result is outstanding.
  function remember(text) {
    heard.push({ at: Date.now(), text: text });
    if (heard.length > 400) heard.splice(0, heard.length - 400);
  }

  function sendTyped(text) {
    remember(text);
    var el = line("user", text);
    el.classList.add("pc-pending");
    el.title = "Pendente";
    lastSpeaker = null;
    queuedTyped.push({ text: text, el: el, sent: false });
    if (!live) { startConversation(); return; }
    flushTyped(live);
  }

  function flushTyped(state) {
    if (!state || !state.ready || backendBusy()) return;
    var toSend = queuedTyped.filter(function (item) { return !item.sent; });
    if (!toSend.length) return;
    toSend.forEach(function (item) {
      item.sent = true;
      send(state, { type: "response.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: item.text }] } });
    });
    send(state, { type: "response.create" });
  }

  function markTypedDelivered() {
    queuedTyped = queuedTyped.filter(function (item) {
      if (!item.sent) return true;
      item.el.classList.remove("pc-pending"); item.el.title = "";
      return false;
    });
  }

  // ----- tools ---------------------------------------------------------------

  function runTool(name, rawArgs) {
    var args;
    try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch (e) { return Promise.resolve({ error: "invalid_arguments" }); }
    var tools = {
      page_read: pageRead, page_navigate: pageNavigate, page_point: pagePoint, page_fill: pageFill,
      page_click: pageClick, page_act: pageAct, bases_call: basesCall,
      confirm_pending: confirmPending, cancel_pending: cancelPending
    };
    var tool = tools[name];
    if (!tool) return Promise.resolve({ error: "unknown_tool" });
    return Promise.resolve().then(function () { return tool(args || {}); }).catch(function (error) {
      return { error: "tool_failed", message: String(error && error.message || error).slice(0, 300) };
    });
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function refFor(el) {
    var found = null;
    refs.forEach(function (value, key) { if (value === el) found = key; });
    if (found) return found;
    refSeq += 1;
    var ref = "e" + refSeq;
    refs.set(ref, el);
    return ref;
  }

  function labelOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var text = labelledBy.split(/\\s+/).map(function (id) { var n = el.ownerDocument.getElementById(id); return n ? n.textContent : ""; }).join(" ").trim();
      if (text) return text;
    }
    if (el.id) {
      var lab = el.ownerDocument.querySelector("label[for=\\"" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + "\\"]");
      if (lab) return lab.textContent.trim();
    }
    var parentLabel = el.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    return (el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "").trim();
  }

  function short(text, max) { text = String(text || "").replace(/\\s+/g, " ").trim(); return text.length > max ? text.slice(0, max - 1) + "\\u2026" : text; }
  function clip(text, max) { return text.length > max ? text.slice(0, max) : text; }

  function registeredActions() {
    try {
      var list = frameEl.contentWindow.ravi && frameEl.contentWindow.ravi.pageChat && frameEl.contentWindow.ravi.pageChat.actions;
      if (!Array.isArray(list)) return [];
      return list.filter(function (a) { return a && typeof a.name === "string" && typeof a.run === "function" && /^[A-Za-z0-9_-]{1,64}$/.test(a.name); });
    } catch (e) { return []; }
  }

  function pageRead() {
    var doc = frameDoc();
    if (!doc || !doc.body) return { error: "page_not_ready" };
    refs = new Map(); refSeq = 0;
    var lines = [];
    var size = 0;
    var interactive = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=menuitem],[contenteditable=true]";
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    var node = walker.currentNode;
    while (node && size < MAX_SNAPSHOT) {
      var el = node;
      var tag = el.tagName.toLowerCase();
      var entry = null;
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") { node = nextSkipping(walker, el); continue; }
      if (!isVisible(el)) { node = nextSkipping(walker, el); continue; }
      if (/^h[1-6]$/.test(tag)) entry = "heading" + tag.slice(1) + " \\"" + short(el.textContent, 160) + "\\"";
      else if (el.matches(interactive)) {
        var role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input:" + (el.getAttribute("type") || "text") : tag);
        var value = tag === "select" ? (el.options[el.selectedIndex] || {}).text : (tag === "input" || tag === "textarea") && el.type !== "password" ? el.value : "";
        entry = "[" + refFor(el) + "] " + role + " \\"" + short(labelOf(el) || el.textContent, 120) + "\\"" + (value ? " value=\\"" + short(value, 80) + "\\"" : "") + (el.disabled ? " disabled" : "") + (tag === "a" ? " -> " + short(el.getAttribute("href"), 120) : "");
      } else if (tag.indexOf("ravi-") === 0) {
        entry = "[" + refFor(el) + "] " + tag + " " + short(el.getAttribute("view") || el.getAttribute("base") || "", 80);
      } else if ((tag === "p" || tag === "li" || tag === "td" || tag === "th" || tag === "dd" || tag === "dt" || tag === "figcaption" || tag === "label" || tag === "caption") && !el.querySelector(interactive)) {
        var text = short(el.textContent, 240);
        if (text) entry = "text \\"" + text + "\\"";
        if (entry) { lines.push(entry); size += entry.length; node = nextSkipping(walker, el); continue; }
      }
      if (entry) { lines.push(entry); size += entry.length; }
      node = walker.nextNode();
    }
    var actions = registeredActions().map(function (a) {
      return { name: a.name, description: short(a.description, 200), kind: a.kind === "write" ? "write" : "read", parameters: a.parameters || {} };
    });
    return {
      path: framePath(),
      title: doc.title || "",
      truncated: size >= MAX_SNAPSHOT,
      snapshot: lines.join("\\n"),
      actions: actions,
      routes: (live && live.frame && live.frame.routes) || []
    };
  }

  function nextSkipping(walker, el) {
    var next = el;
    while (next) {
      if (next.nextElementSibling) { walker.currentNode = next.nextElementSibling; return walker.currentNode; }
      next = next.parentElement;
      if (!next || next === walker.root) return null;
    }
    return null;
  }

  function elementFor(ref) {
    var el = refs.get(String(ref || ""));
    if (!el || !el.isConnected) return null;
    return el;
  }

  function pageNavigate(args) {
    var path = String(args.path || "");
    if (!/^\\/(?!\\/)/.test(path) || path.indexOf(cfg.reservedPrefix) === 0) return { error: "path_not_allowed" };
    chip("Abrindo " + short(path, 40));
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (done) return; done = true; frameEl.removeEventListener("load", finish); var d = frameDoc(); resolve({ ok: true, path: framePath(), title: d ? d.title : "" }); }
      frameEl.addEventListener("load", finish);
      setTimeout(finish, 10000);
      frameEl.src = path;
    });
  }

  function hideHighlight() { highlightEl.hidden = true; }
  function pagePoint(args) {
    var el = elementFor(args.ref);
    if (!el) return { error: "ref_not_found", hint: "Call page_read again." };
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(function () {
      var r = el.getBoundingClientRect();
      highlightEl.style.left = (r.left - 4) + "px"; highlightEl.style.top = (r.top - 4) + "px";
      highlightEl.style.width = (r.width + 8) + "px"; highlightEl.style.height = (r.height + 8) + "px";
      highlightEl.hidden = false;
      clearTimeout(pagePoint.timer);
      pagePoint.timer = setTimeout(hideHighlight, 4000);
    }, 350);
    chip("Mostrando " + short(labelOf(el) || el.textContent, 30));
    return { ok: true };
  }

  function pageFill(args) {
    var el = elementFor(args.ref);
    if (!el) return { error: "ref_not_found", hint: "Call page_read again." };
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "file" || type === "hidden") return { error: "field_not_allowed" };
    var value = String(args.value == null ? "" : args.value);
    var win = el.ownerDocument.defaultView;
    if (tag === "select") {
      var match = Array.prototype.find.call(el.options, function (o) { return o.value === value || o.text.trim().toLowerCase() === value.trim().toLowerCase(); });
      if (!match) return { error: "option_not_found", options: Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).slice(0, 30) };
      el.value = match.value;
    } else if (type === "checkbox" || type === "radio") {
      el.checked = /^(true|1|sim|yes|on|marcar|checked)$/i.test(value.trim());
    } else if (tag === "input" || tag === "textarea") {
      var proto = tag === "textarea" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else return { error: "not_a_field" };
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    chip("Preenchendo " + short(labelOf(el), 30));
    return { ok: true };
  }

  function clickIsWrite(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    var declared = el.closest("[data-ravi-chat-kind]");
    if (declared) return declared.getAttribute("data-ravi-chat-kind") === "write";
    var form = el.form || el.closest("form");
    if ((tag === "button" && (type === "" || type === "submit") && form) || (tag === "input" && (type === "submit" || type === "image"))) return true;
    return WRITE_WORDS.test(labelOf(el) || el.textContent || "");
  }

  function pageClick(args) {
    var el = elementFor(args.ref);
    if (!el) return { error: "ref_not_found", hint: "Call page_read again." };
    if (el.tagName.toLowerCase() === "a") {
      var href = el.getAttribute("href") || "";
      try {
        var target = new URL(href, el.ownerDocument.baseURI);
        if (target.origin !== location.origin) return { error: "outside_site", url: target.href };
        if (target.pathname.indexOf(cfg.reservedPrefix) === 0) return { error: "path_not_allowed" };
      } catch (e) {}
    }
    var label = short(labelOf(el) || el.textContent, 60);
    var run = function () {
      el.click();
      return new Promise(function (resolve) { setTimeout(function () { resolve({ ok: true, path: framePath() }); }, 600); });
    };
    if (clickIsWrite(el)) return propose("Pressionar \\"" + label + "\\" em " + framePath(), run);
    chip("Tocando " + short(label, 30));
    return run();
  }

  function pageAct(args) {
    var action = registeredActions().filter(function (a) { return a.name === args.name; })[0];
    if (!action) return { error: "action_not_found", actions: registeredActions().map(function (a) { return a.name; }) };
    var input = {};
    try { input = args.args ? JSON.parse(args.args) : {}; } catch (e) { return { error: "invalid_arguments" }; }
    var run = function () {
      chip("Executando " + action.name);
      return Promise.race([
        Promise.resolve().then(function () { return action.run(input); }),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error("timeout")); }, ACTION_TIMEOUT_MS); })
      ]).then(function (result) { return { ok: true, result: result === undefined ? null : result }; });
    };
    if (action.kind === "write") return propose(short(action.description || action.name, 160) + " " + short(args.args || "", 300), run);
    return run();
  }

  function basesCall(args) {
    var actions = (live && live.frame && live.frame.connectorActions) || [];
    var spec = actions.filter(function (a) { return a.id === args.id; })[0];
    if (!spec) return { error: "action_not_allowed", allowed: actions.map(function (a) { return a.id; }) };
    var input;
    try { input = args.input ? JSON.parse(args.input) : {}; } catch (e) { return { error: "invalid_input" }; }
    var run = function () {
      chip(spec.title || spec.id);
      return fetch(cfg.execUrl, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: spec.id, input: input })
      }).then(function (response) { return response.json().catch(function () { return { error: "connector_unavailable" }; }); });
    };
    if (spec.class !== "read") return propose((spec.title || spec.id) + ": " + short(JSON.stringify(input), 300), run);
    return run();
  }

  function propose(summary, run) {
    var id = "c" + Math.random().toString(36).slice(2, 10);
    pending.set(id, { summary: summary, createdAt: Date.now(), run: run, chip: chip("Aguardando sim: " + short(summary, 50), "confirm") });
    return { status: "confirmation_required", confirmationId: id, summary: summary, say: "Read this summary to the person and ask them to confirm." };
  }

  function confirmedSince(at) {
    var text = heard.filter(function (h) { return h.at >= at; }).map(function (h) { return h.text; }).join(" ").toLowerCase();
    var lastYes = -1, lastNo = -1, m;
    AFFIRM.lastIndex = 0; while ((m = AFFIRM.exec(text))) lastYes = m.index;
    DENY.lastIndex = 0; while ((m = DENY.exec(text))) lastNo = m.index;
    return lastYes >= 0 && lastYes > lastNo;
  }

  function confirmPending(args) {
    var item = pending.get(String(args.confirmationId || ""));
    if (!item) return { error: "confirmation_unknown" };
    if (Date.now() - item.createdAt > CONFIRM_TTL_MS) { pending.delete(args.confirmationId); return { error: "confirmation_expired", hint: "Propose the change again." }; }
    if (!confirmedSince(item.createdAt)) return { error: "not_confirmed", hint: "The person has not said yes since hearing the summary. Ask again, then wait." };
    pending.delete(args.confirmationId);
    if (item.chip) item.chip.remove();
    return item.run();
  }

  function cancelPending(args) {
    var item = pending.get(String(args.confirmationId || ""));
    if (item) { pending.delete(args.confirmationId); if (item.chip) item.chip.remove(); }
    return { ok: true };
  }
})();
`;
}
