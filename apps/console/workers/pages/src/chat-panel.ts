// The Page chat panel: a self-contained HTML shell served at /_ravi/chat, the
// small dock script the Worker injects into chat-enabled pages (bar entry and
// guest button open it), and the `<ravi-chat>` tag replacement.
//
// The panel script is a String.raw literal: write ordinary JavaScript, but no
// backticks and no dollar-brace sequences (a backtick in a regex is \x60).
// Data reaches it only through the JSON block built by escapedJson. Author and
// agent text is always written with textContent / DOM nodes, never innerHTML.

export type ChatPanelMode = "panel" | "page";
export type ChatPanelKind = "shared" | "private";

export function chatPanelHtml(input: {
  nonce: string;
  mode: ChatPanelMode;
  kind: ChatPanelKind;
  path: string;
  /** The page host when the panel is served from the isolated chat origin; null on the page's own host. */
  host: string | null;
  /** The parent page's origin when it differs from the panel's; null = same origin. */
  parentOrigin: string | null;
  /** `/_ravi/chat` */
  base: string;
  loginUrl: string | null;
}): string {
  const config = escapedJson({
    mode: input.mode,
    kind: input.kind,
    path: input.path,
    host: input.host,
    parentOrigin: input.parentOrigin,
    base: input.base,
    loginUrl: input.loginUrl,
  });
  const nonce = escapeAttribute(input.nonce);
  return `<!doctype html>
<html lang="pt-BR" class="mode-${input.mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>Conversa</title>
<style nonce="${nonce}">${PANEL_CSS}</style>
</head>
<body>
<div id="rc" class="rc">
  <header class="rc-head">
    <div class="rc-title">
      <h1 class="rc-name" id="rc-name">Conversa</h1>
      <p class="rc-sub" id="rc-sub">Esta página</p>
    </div>
    <div class="rc-presence" id="rc-presence" role="group" aria-label="Quem está aqui"></div>
    <div class="rc-kind" id="rc-kind" role="radiogroup" aria-label="Tipo de conversa">
      <button type="button" role="radio" data-kind="shared" aria-checked="true" title="Conversa com todos que veem esta página">Sala</button>
      <button type="button" role="radio" data-kind="private" aria-checked="false" title="Conversa só sua com o Ravi">Só eu</button>
    </div>
    <button type="button" class="rc-icon" id="rc-voice" hidden aria-label="Falar por voz" title="Falar por voz"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
    <button type="button" class="rc-icon" id="rc-close" aria-label="Fechar conversa" title="Fechar"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  </header>
  <div class="rc-conn" id="rc-conn" role="status" hidden></div>
  <main class="rc-scroll" id="rc-scroll">
    <div class="rc-column">
      <div class="rc-older-wrap"><button type="button" class="rc-older" id="rc-older" hidden>Ver mensagens anteriores</button></div>
      <div class="rc-empty" id="rc-empty" hidden></div>
      <ol class="rc-log" id="rc-log" aria-live="polite" aria-relevant="additions text" aria-label="Mensagens"></ol>
    </div>
  </main>
  <div class="rc-gate" id="rc-gate" role="status" aria-live="polite">
    <div class="rc-gate-box"><span class="rc-spin" aria-hidden="true"></span><p id="rc-gate-text">Abrindo a conversa…</p><div id="rc-gate-actions" class="rc-gate-actions"></div></div>
  </div>
  <div class="rc-foot">
    <div class="rc-column">
      <button type="button" class="rc-jump" id="rc-jump" hidden>Novas mensagens <span aria-hidden="true">↓</span></button>
      <div class="rc-typing" id="rc-typing" aria-live="polite"></div>
      <form class="rc-composer" id="rc-form" autocomplete="off" novalidate>
        <label for="rc-input" class="rc-sr">Mensagem para a conversa</label>
        <textarea id="rc-input" rows="1" maxlength="4000" placeholder="Fale com o Ravi" enterkeyhint="send" aria-describedby="rc-hint" disabled></textarea>
        <button type="submit" class="rc-send" id="rc-send" aria-label="Enviar" title="Enviar (Enter)" disabled><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h13M12 5l7 7-7 7"/></svg></button>
      </form>
      <p class="rc-hint" id="rc-hint">Enter envia · Shift+Enter quebra a linha</p>
    </div>
  </div>
</div>
<script type="application/json" id="rc-config">${config}</script>
<script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
}

/** Strict CSP for the panel shell: only its own nonce'd script and style run. */
export function chatPanelPolicy(input: { nonce: string; socketOrigin: string; frameAncestors: string }): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${input.nonce}'`,
    `style-src 'nonce-${input.nonce}'`,
    "img-src 'self' data:",
    `connect-src 'self' ${input.socketOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${input.frameAncestors}`,
  ].join("; ");
}

/**
 * The dock: a fixed iframe panel on the right (a bottom sheet under 640px)
 * that the bar's "Fale com o Ravi" entry and the guest button open. Exposes
 * `window.__raviChatDock` and fires `ravi-chat:state` on window. The panel
 * talks back only through postMessage, checked by origin and source.
 * Pure ASCII, safe in any page charset.
 */
export function chatDockSnippet(input: {
  chatPath: string;
  chatOrigin: string | null;
  voiceUrl: string | null;
  /** Ask the Console once after load whether the shared room has unread messages. */
  peekUnread: boolean;
  /** Element id of the Pages bar the dock sits under, when the bar is on the page. */
  barId: string | null;
}): string {
  const data = escapedJson({
    chatPath: input.chatPath,
    chatOrigin: input.chatOrigin,
    voiceUrl: input.voiceUrl,
    peek: input.peekUnread && !input.chatOrigin,
    barId: input.barId,
  });
  const script = `(function(){var d=${data};${DOCK_SCRIPT}})();`;
  return `<script data-ravi-chat-dock="1">${script.replace(/<\//g, "<\\/")}</script>`;
}

/**
 * Replaces `<ravi-chat></ravi-chat>`, `<ravi-chat/>` and `<ravi-chat ...>`
 * with the chat iframe when the viewer may chat, or with a small note when
 * not. `height` passes through (default 600px); `kind="private"` opens the
 * viewer's own room.
 */
export function replaceRaviChatTags(
  html: string,
  input: {
    excluded?: boolean;
    enabled: boolean;
    path: string;
    chatPath: string;
    chatOrigin: string | null;
    host: string;
    loginUrl: string | null;
    signedIn: boolean;
  },
): string {
  if (!/<ravi-chat\b/i.test(html)) return html;
  const replace = (_match: string, attributes: string) => input.excluded ? "" : raviChatReplacement(parseTagAttributes(attributes), input);
  // `<ravi-chat/>` is taken as self-closing (what authors mean), then pairs, then lone tags.
  return html
    .replace(/<ravi-chat\b([^>]*?)\/>/gi, replace)
    .replace(/<ravi-chat\b([^>]*)>[\s\S]*?<\/ravi-chat\s*>/gi, replace)
    .replace(/<ravi-chat\b([^>]*)>/gi, replace)
    .replace(/<\/ravi-chat\s*>/gi, "");
}

/** True when the bytes contain `<ravi-chat` (ASCII, any case). Lets the Worker skip decoding pages without it. */
export function containsRaviChatTag(bytes: Uint8Array): boolean {
  const needle = [0x3c, 0x72, 0x61, 0x76, 0x69, 0x2d, 0x63, 0x68, 0x61, 0x74]; // "<ravi-chat"
  outer: for (let index = 0; index + needle.length <= bytes.length; index += 1) {
    if (bytes[index] !== 0x3c) continue;
    for (let offset = 1; offset < needle.length; offset += 1) {
      const byte = bytes[index + offset]!;
      const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
      if (lower !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function parseTagAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function raviChatReplacement(
  attributes: Record<string, string>,
  input: { enabled: boolean; path: string; chatPath: string; chatOrigin: string | null; host: string; loginUrl: string | null; signedIn: boolean },
): string {
  if (!input.enabled) {
    const style =
      "margin:16px 0;padding:14px 16px;border:1px solid rgba(127,127,127,.3);border-radius:12px;" +
      "font:15px/1.4 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
    if (!input.signedIn && input.loginUrl) {
      return `<p class="ravi-chat-note" style="${style}"><a href="${escapeAttribute(input.loginUrl)}">Entre para conversar</a></p>`;
    }
    return `<p class="ravi-chat-note" style="${style}">A conversa n&atilde;o est&aacute; dispon&iacute;vel nesta p&aacute;gina.</p>`;
  }
  const height = safeFrameHeight(attributes.height);
  const kind = attributes.kind === "private" ? "private" : "shared";
  const query = new URLSearchParams({ mode: "page", kind, path: input.path });
  if (input.chatOrigin) query.set("host", input.host);
  const src = `${input.chatOrigin ?? ""}${input.chatPath}?${query.toString()}`;
  return (
    `<iframe class="ravi-chat-frame" src="${escapeAttribute(src)}" title="Conversa com o Ravi" loading="lazy" allow="clipboard-write"` +
    ` style="display:block;width:100%;height:${height};min-height:320px;border:0;border-radius:12px;color-scheme:normal"></iframe>`
  );
}

function safeFrameHeight(value: string | undefined): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (/^\d{2,4}$/.test(trimmed)) return `${trimmed}px`;
  if (/^\d{2,4}px$/.test(trimmed) || /^\d{1,3}(vh|%)$/.test(trimmed)) return trimmed;
  return "600px";
}

function escapedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PANEL_CSS = String.raw`
:root{color-scheme:light dark;--bg:#ffffff;--fg:#15171c;--muted:#636a77;--faint:#8b919c;--line:#e5e7eb;--soft:#f5f6f8;--other:#f1f2f4;--other-fg:#15171c;--agent:#ffffff;--mine:#1c2330;--mine-fg:#ffffff;--accent:#2563eb;--accent-soft:rgba(37,99,235,.1);--danger:#c62828;--ok:#15803d;--focus:#2563eb;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#101217;--fg:#eceef2;--muted:#a0a6b1;--faint:#767c88;--line:#262a32;--soft:#171a20;--other:#1d2028;--other-fg:#eceef2;--agent:#151820;--mine:#e7e9ee;--mine-fg:#101217;--accent:#7aa7ff;--accent-soft:rgba(122,167,255,.14);--danger:#ff8a80;--ok:#6ee7a1;--focus:#7aa7ff;--shadow:none}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.mode-page body{font-size:16px}
button,textarea{font:inherit;color:inherit}
button{cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
:focus{outline:none}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.rc-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.rc{display:flex;flex-direction:column;height:100%;min-height:0}
.rc-head{display:flex;align-items:center;gap:8px;flex:none;min-height:56px;padding:8px 10px 8px 16px;border-bottom:1px solid var(--line);background:var(--bg)}
.mode-page .rc-head{padding:10px max(16px,calc((100% - 760px)/2)) 10px max(16px,calc((100% - 760px)/2))}
.rc-title{flex:1 1 auto;min-width:0}
.rc-name{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-sub{margin:1px 0 0;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-presence{display:flex;align-items:center;flex:none}
.rc-presence .rc-av{width:26px;height:26px;margin-left:-6px;border:2px solid var(--bg);font-size:10.5px}
.rc-presence .rc-av:first-child{margin-left:0}
.rc-more{display:grid;place-items:center;height:26px;min-width:26px;margin-left:-6px;padding:0 6px;border:2px solid var(--bg);border-radius:999px;background:var(--soft);color:var(--muted);font-size:11px;font-weight:650}
.rc-kind{display:inline-flex;flex:none;padding:2px;border:1px solid var(--line);border-radius:999px;background:var(--soft)}
.rc-kind button{min-height:28px;padding:0 11px;border:0;border-radius:999px;background:transparent;color:var(--muted);font-size:12.5px;font-weight:600}
.rc-kind button[aria-checked=true]{background:var(--bg);color:var(--fg);box-shadow:var(--shadow)}
@media (prefers-color-scheme:dark){.rc-kind button[aria-checked=true]{background:#2a2e38}}
.rc-icon{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:transparent;color:var(--muted)}
.rc-icon svg,.rc-send svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mode-page #rc-close{display:none}
.rc-conn{flex:none;padding:6px 16px;background:var(--soft);border-bottom:1px solid var(--line);color:var(--muted);font-size:12.5px;text-align:center}
.rc-scroll{position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:auto}
.rc-column{width:100%;max-width:760px;margin:0 auto}
.rc-scroll .rc-column{padding:12px 14px 8px}
.mode-page .rc-scroll .rc-column{padding:20px 16px 12px}
.rc-older-wrap{display:flex;justify-content:center}
.rc-older{margin:4px 0 12px;min-height:32px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font-size:13px}
.rc-empty{margin:18vh auto 0;max-width:320px;color:var(--muted);text-align:center}
.rc-empty strong{display:block;margin-bottom:4px;color:var(--fg);font-size:16px;font-weight:650}
.rc-log{margin:0;padding:0;list-style:none}
.rc-msg{display:flex;align-items:flex-end;gap:8px;margin-top:14px}
.rc-msg.cont{margin-top:3px}
.rc-msg.mine{justify-content:flex-end}
.rc-av{display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:999px;background:var(--av,#64748b);color:#fff;font-size:11px;font-weight:700;letter-spacing:.02em;user-select:none;-webkit-user-select:none}
.rc-msg .rc-av{align-self:flex-start;margin-top:2px}
.rc-msg.cont .rc-av{visibility:hidden;height:0}
.rc-av.agent{background:var(--fg);color:var(--bg)}
.rc-col{display:flex;flex-direction:column;align-items:flex-start;min-width:0;max-width:min(82%,620px)}
.mode-page .rc-col{max-width:min(80%,640px)}
.rc-msg.mine .rc-col{align-items:flex-end}
.rc-bubble{position:relative;max-width:100%;padding:8px 12px;border-radius:12px;background:var(--other);color:var(--other-fg);overflow-wrap:anywhere;word-break:normal}
.rc-msg.agent .rc-bubble{border:1px solid var(--line);background:var(--agent);box-shadow:var(--shadow)}
.rc-msg.mine .rc-bubble{background:var(--mine);color:var(--mine-fg)}
.rc-msg.system .rc-bubble{background:transparent;color:var(--muted);font-size:13px;text-align:center}
.rc-msg.system{justify-content:center}
.rc-msg:not(.cont):not(.mine) .rc-bubble{border-top-left-radius:4px}
.rc-msg.mine:not(.cont) .rc-bubble{border-top-right-radius:4px}
.rc-msg.pending .rc-bubble{opacity:.72}
.rc-msg.failed .rc-bubble{opacity:1;box-shadow:0 0 0 1.5px var(--danger)}
.rc-author{display:flex;align-items:center;gap:6px;margin:0 0 2px;font-size:12.5px;font-weight:650;color:var(--muted)}
.rc-msg.agent .rc-author{color:var(--fg)}
.rc-badge{padding:1px 6px;border-radius:999px;background:var(--soft);color:var(--muted);font-size:11px;font-weight:600}
.rc-msg.mine .rc-badge{background:rgba(255,255,255,.16);color:inherit}
.rc-text p{margin:0}
.rc-text p+p,.rc-text p+ul,.rc-text p+ol,.rc-text ul+p,.rc-text ol+p,.rc-text pre+p,.rc-text p+pre{margin-top:8px}
.rc-text ul,.rc-text ol{margin:4px 0;padding-left:20px}
.rc-text li+li{margin-top:2px}
.rc-text .rc-h{font-weight:700}
.rc-text code{padding:1px 5px;border-radius:5px;background:rgba(127,127,127,.16);font:.9em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.rc-text pre{margin:6px 0;padding:10px 12px;overflow-x:auto;border-radius:8px;background:rgba(127,127,127,.12)}
.rc-text pre code{padding:0;background:none}
.rc-text a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.rc-msg.mine .rc-text a{color:inherit}
.rc-text:empty{display:none}
.rc-caret{display:inline-block;width:7px;height:1em;margin-left:2px;vertical-align:-2px;border-radius:1px;background:currentColor;opacity:.55}
.rc-status{display:flex;align-items:center;gap:7px;margin-top:4px;color:var(--muted);font-size:12.5px}
.rc-text:empty+.rc-status,.rc-bubble>.rc-status:first-child{margin-top:0}
.rc-status.failed{color:var(--danger)}
.rc-dots{display:inline-flex;gap:3px}
.rc-dots i{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.4}
.rc-parts:empty{display:none}
.rc-parts{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.rc-text:empty+.rc-status+.rc-parts,.rc-text:empty+.rc-parts{margin-top:2px}
.rc-tools{display:flex;flex-wrap:wrap;gap:6px}
.rc-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 9px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-chip i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--faint)}
.rc-chip.done i{background:var(--ok)}
.rc-chip.failed i{background:var(--danger)}
.rc-card{padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
.rc-card-t{margin:0 0 4px;font-size:14px;font-weight:650}
.rc-card-b{color:var(--fg)}
.rc-card-m{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.rc-fields{display:grid;grid-template-columns:minmax(80px,max-content) 1fr;gap:4px 12px;margin:8px 0 0;font-size:13.5px}
.rc-fields dt{color:var(--muted)}
.rc-fields dd{margin:0;overflow-wrap:anywhere}
.rc-card-l{display:inline-block;margin-top:8px;color:var(--accent);font-size:13.5px;font-weight:600}
.rc-card.ph{border-style:dashed}
.rc-confirm{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.rc-confirm-q{margin:0 0 4px;color:var(--muted);font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.04em}
.rc-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.rc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 14px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg);font-size:13.5px;font-weight:600}
.rc-btn.primary{border-color:var(--fg);background:var(--fg);color:var(--bg)}
.rc-btn:disabled{opacity:.5;cursor:default}
.rc-btn.chosen{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);opacity:1}
.rc-note{margin:8px 0 0;color:var(--muted);font-size:12.5px}
.rc-note.err{color:var(--danger)}
.rc-note.ok{color:var(--ok)}
.rc-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-height:0;margin:3px 2px 0;color:var(--faint);font-size:11.5px}
.rc-meta:empty{display:none}
.rc-meta .err{color:var(--danger);font-weight:600}
.rc-link{min-height:24px;padding:0 2px;border:0;background:transparent;color:var(--accent);font-size:12px;font-weight:600}
.rc-link.del{color:var(--faint)}
.rc-link.del.armed{color:var(--danger)}
.rc-msg .rc-link.del{opacity:0}
.rc-msg:hover .rc-link.del,.rc-msg:focus-within .rc-link.del,.rc-link.del.armed{opacity:1}
.rc-gate{position:absolute;inset:56px 0 0;z-index:3;display:grid;place-items:center;padding:24px;background:var(--bg)}
.rc-gate[hidden]{display:none}
.rc-gate-box{max-width:320px;color:var(--muted);text-align:center}
.rc-gate-box p{margin:10px 0 0}
.rc-gate-actions{display:flex;justify-content:center;gap:8px;margin-top:14px}
.rc-gate-actions a{display:inline-flex;align-items:center;min-height:40px;padding:0 16px;border-radius:10px;background:var(--fg);color:var(--bg);font-weight:600;text-decoration:none}
.rc-spin{display:inline-block;width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--muted);border-radius:50%}
.rc-gate.idle .rc-spin{display:none}
.rc-foot{flex:none;padding:0 12px calc(10px + env(safe-area-inset-bottom,0px));background:var(--bg)}
.mode-page .rc-foot{padding:0 16px calc(14px + env(safe-area-inset-bottom,0px))}
.rc-foot .rc-column{position:relative}
.rc-jump{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);min-height:32px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--fg);font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.12)}
.rc-typing{min-height:20px;padding:2px 6px;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-composer{display:flex;align-items:flex-end;gap:6px;padding:6px 6px 6px 14px;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:var(--shadow)}
.rc-composer:focus-within{border-color:color-mix(in srgb,var(--focus) 60%,var(--line));box-shadow:0 0 0 3px var(--accent-soft)}
.rc-composer textarea{flex:1 1 auto;min-width:0;min-height:24px;max-height:160px;margin:0;padding:6px 0;border:0;background:transparent;resize:none;line-height:1.45;outline:none}
.rc-composer textarea:focus-visible{outline:none}
.rc-composer textarea::placeholder{color:var(--faint)}
.rc-send{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:0;border:0;border-radius:10px;background:var(--fg);color:var(--bg)}
.rc-send:disabled{background:var(--soft);color:var(--faint);cursor:default}
.rc-hint{margin:6px 4px 0;color:var(--faint);font-size:11.5px}
.mode-page .rc-hint{font-size:12px}
.rc-hint:empty{display:none}
@media (hover:hover){.rc-icon:hover{background:var(--soft);color:var(--fg)}.rc-btn:hover:not(:disabled){border-color:var(--faint)}.rc-btn.primary:hover:not(:disabled){opacity:.88}.rc-older:hover{color:var(--fg)}.rc-link:hover{text-decoration:underline}.rc-kind button:hover{color:var(--fg)}}
@media (pointer:coarse){.rc-icon,.rc-send{width:44px;height:44px}.rc-kind button{min-height:40px;padding:0 14px}.rc-btn{min-height:44px}.rc-link{min-height:44px;padding:0 6px}.rc-older,.rc-jump{min-height:44px}.rc-msg .rc-link.del{opacity:1}.rc-composer textarea{font-size:16px}}
@media (max-width:380px){.rc-presence{display:none}}
@media (prefers-reduced-motion:no-preference){
.rc-msg.enter{animation:rc-in .16s ease-out}
.rc-dots i{animation:rc-dot 1.2s infinite ease-in-out}.rc-dots i:nth-child(2){animation-delay:.15s}.rc-dots i:nth-child(3){animation-delay:.3s}
.rc-caret{animation:rc-blink 1s steps(2,start) infinite}
.rc-spin{animation:rc-spin .8s linear infinite}
}
@keyframes rc-in{from{opacity:0;transform:translateY(4px)}}
@keyframes rc-dot{0%,80%,100%{opacity:.25}40%{opacity:.9}}
@keyframes rc-blink{to{visibility:hidden}}
@keyframes rc-spin{to{transform:rotate(360deg)}}
`;

const PANEL_SCRIPT = String.raw`
(function () {
  "use strict";
  var cfg = JSON.parse(document.getElementById("rc-config").textContent || "{}");
  var parentOrigin = cfg.parentOrigin || location.origin;
  var embedded = window.parent !== window;
  var MAX_TEXT = 4000;
  var PING = '{"type":"ping"}';
  var TYPING = '{"type":"typing"}';
  var $ = function (id) { return document.getElementById(id); };
  var ui = {
    root: document.documentElement, name: $("rc-name"), sub: $("rc-sub"), presence: $("rc-presence"), kind: $("rc-kind"),
    voice: $("rc-voice"), close: $("rc-close"), conn: $("rc-conn"), scroll: $("rc-scroll"), older: $("rc-older"),
    empty: $("rc-empty"), log: $("rc-log"), gate: $("rc-gate"), gateText: $("rc-gate-text"), gateActions: $("rc-gate-actions"),
    jump: $("rc-jump"), typing: $("rc-typing"), form: $("rc-form"), input: $("rc-input"), send: $("rc-send"), hint: $("rc-hint")
  };
  var ERR = {
    chat_rate_limited: "Muitas mensagens seguidas. Espere um pouco.",
    chat_budget_exhausted: "O limite de uso do Ravi acabou por agora.",
    chat_session_required: "Sua sessão expirou. Entre de novo.",
    chat_forbidden: "Você não pode escrever nesta conversa.",
    chat_disabled_for_site: "A conversa está desligada neste site.",
    chat_room_not_found: "Esta conversa não existe mais.",
    payload_invalid: "Mensagem inválida.",
    network: "Sem conexão.",
    chat_unavailable: "Não foi possível enviar."
  };
  var STATUS = { queued: "na fila", running: "pensando", waiting_confirmation: "esperando sua confirmação" };
  var COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0d9488", "#16a34a", "#9333ea", "#0891b2", "#b45309", "#4f46e5"];

  var S;
  function fresh() {
    return {
      gen: (S ? S.gen : 0) + 1,
      kind: S ? S.kind : (cfg.kind === "private" ? "private" : "shared"),
      room: null, viewer: null, members: {}, assistant: "Ravi", voice: false, replyPolicy: null,
      msgs: new Map(), pending: new Map(), turns: new Map(), waiting: new Map(), agentStatus: new Map(), deltas: new Map(),
      deciding: {}, decideError: {}, widgets: {}, widgetQueue: [], armed: null,
      lastSeq: 0, lastReadSeq: 0, readSent: 0, minSeq: 0, hasOlder: false,
      online: [], typing: new Map(), ws: null, attempts: 0, reconnectTimer: 0, pingTimer: 0, typingTimer: 0,
      lastTypingSent: 0, catching: false, catchAgain: false, visible: true, nodes: new Map(), dirty: new Set(), entered: new Set()
    };
  }
  S = fresh();
  try {
    var savedKind = sessionStorage.getItem("ravi-chat:kind:" + cfg.path);
    if (cfg.mode === "panel" && (savedKind === "shared" || savedKind === "private")) S.kind = savedKind;
  } catch (e) {}

  /* ---------- small helpers ---------- */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    var first = parts[0] ? parts[0].charAt(0) : "?";
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return (first + last).toUpperCase();
  }
  function colorFor(key) {
    var h = 0; key = String(key || "");
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return COLORS[Math.abs(h) % COLORS.length];
  }
  function avatar(name, key, agent) {
    var a = el("span", "rc-av" + (agent ? " agent" : ""), agent ? "R" : initials(name));
    if (!agent) a.style.setProperty("--av", colorFor(key));
    a.setAttribute("aria-hidden", "true");
    return a;
  }
  function timeText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try { return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function nameOf(userId) {
    if (S.viewer && userId === S.viewer.userId) return "você";
    var m = S.members[userId];
    if (m && m.displayName) return m.displayName;
    for (var i = 0; i < S.online.length; i++) if (S.online[i].userId === userId) return S.online[i].displayName;
    return "outra pessoa";
  }
  function isMine(m) { return Boolean(m.author && m.author.type === "user" && S.viewer && m.author.userId === S.viewer.userId); }
  function authorKey(m) { var a = m.author || {}; return a.type === "user" ? "u:" + a.userId : String(a.type || "system"); }
  function errText(code) { return ERR[code] || ERR.chat_unavailable; }
  function post(message) { if (embedded) try { window.parent.postMessage(message, parentOrigin); } catch (e) {} }

  function api(name, body) {
    var headers = { "content-type": "application/json", accept: "application/json" };
    if (cfg.host) headers["x-ravi-chat-host"] = cfg.host;
    return fetch(cfg.base + "/" + name, { method: "POST", headers: headers, body: JSON.stringify(body || {}), credentials: "same-origin", cache: "no-store" })
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          if (!response.ok) { var err = new Error("chat"); err.code = (data && data.error) || "chat_unavailable"; err.status = response.status; throw err; }
          return data || {};
        });
      }, function () { var err = new Error("network"); err.code = "network"; err.status = 0; throw err; });
  }

  /* ---------- markdown subset, built as DOM nodes ---------- */
  function safeHref(href) {
    href = String(href || "").trim();
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return { href: href, external: true };
    if (href.charAt(0) === "/" && href.charAt(1) !== "/" && href.indexOf("\\") < 0) {
      return { href: cfg.host ? "https://" + cfg.host + href : href, external: false };
    }
    if (href.charAt(0) === "#") return null;
    return null;
  }
  function link(label, href, into) {
    var safe = safeHref(href);
    if (!safe) { into.appendChild(document.createTextNode(label)); return; }
    var a = el("a", null, label);
    a.href = safe.href;
    a.target = safe.external ? "_blank" : "_top";
    a.rel = "noopener noreferrer";
    into.appendChild(a);
  }
  var INLINE = /(\x60[^\x60\n]+\x60)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s\n][^*\n]*\*)|(\b_[^_\s\n][^_\n]*_\b)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
  function inline(text, into) {
    // A fresh regex per call: bold and em recurse, and a shared lastIndex would loop forever.
    var pattern = new RegExp(INLINE.source, "g");
    var last = 0, match;
    while ((match = pattern.exec(text))) {
      if (match.index > last) into.appendChild(document.createTextNode(text.slice(last, match.index)));
      var token = match[0];
      if (match[1]) into.appendChild(el("code", null, token.slice(1, -1)));
      else if (match[2] || match[3]) { var b = el("strong"); inline(token.slice(2, -2), b); into.appendChild(b); }
      else if (match[4] || match[5]) { var i = el("em"); inline(token.slice(1, -1), i); into.appendChild(i); }
      else if (match[6]) { var close = token.indexOf("]("); link(token.slice(1, close), token.slice(close + 2, -1), into); }
      else if (match[7]) link(token, token, into);
      last = match.index + token.length;
    }
    if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
  }
  function markdown(text) {
    var frag = document.createDocumentFragment();
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    var para = [], list = null, i = 0;
    function flushPara() {
      if (!para.length) return;
      var p = el("p");
      para.forEach(function (line, index) { if (index) p.appendChild(el("br")); inline(line, p); });
      frag.appendChild(p); para = [];
    }
    function flushList() { if (list) { frag.appendChild(list.node); list = null; } }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*\x60\x60\x60/.test(line)) {
        flushPara(); flushList();
        var code = []; i++;
        while (i < lines.length && !/^\s*\x60\x60\x60/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        var pre = el("pre"); pre.appendChild(el("code", null, code.join("\n"))); frag.appendChild(pre);
        continue;
      }
      var item = line.match(/^\s*(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/);
      if (item) {
        flushPara();
        var ordered = !item[1];
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered: ordered, node: el(ordered ? "ol" : "ul") };
          if (ordered && item[2] !== "1") list.node.start = Number(item[2]);
        }
        var li = el("li"); inline(item[3], li); list.node.appendChild(li);
        i++; continue;
      }
      if (!line.trim()) { flushPara(); flushList(); i++; continue; }
      var heading = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (heading) { flushPara(); flushList(); var h = el("p", "rc-h"); inline(heading[1], h); frag.appendChild(h); i++; continue; }
      flushList(); para.push(line); i++;
    }
    flushPara(); flushList();
    return frag;
  }

  /* ---------- blocks (ravi.ui/v1) ---------- */
  // Plug-in point for the Pages runtime: window.raviChat.blockRenderers[kind] = function (block, message) { return node | null; }
  var RC = window.raviChat = window.raviChat || {};
  RC.blockRenderers = RC.blockRenderers || {};
  RC.renderBlock = renderBlock;

  function card(title, cls) {
    var c = el("div", "rc-card" + (cls ? " " + cls : ""));
    if (title) c.appendChild(el("p", "rc-card-t", title));
    return c;
  }
  function fieldList(pairs) {
    var dl = el("dl", "rc-fields");
    pairs.forEach(function (pair) { dl.appendChild(el("dt", null, pair[0])); dl.appendChild(el("dd", null, pair[1])); });
    return dl;
  }
  function plain(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  function renderBlock(block, message) {
    if (!block || typeof block.kind !== "string") return null;
    var plug = RC.blockRenderers[block.kind];
    if (typeof plug === "function") {
      try { var custom = plug(block, message); if (custom) return custom; } catch (e) {}
    }
    if (block.kind === "actions") return actionsBlock(block, message);
    if (block.kind === "card") return cardBlock(block);
    if (block.kind === "widget") return widgetBlock(block);
    if (block.kind === "view") return viewBlock(block);
    if (block.kind === "chart") return chartBlock(block);
    return null;
  }
  function actionsBlock(block, message) {
    var row = el("div", "rc-row");
    var chosen = chosenAction(message.id);
    (Array.isArray(block.actions) ? block.actions : []).slice(0, 8).forEach(function (action) {
      if (!action || typeof action.label !== "string") return;
      var b = el("button", "rc-btn", action.label);
      b.type = "button";
      if (chosen) { b.disabled = true; if (chosen === action.id) b.className += " chosen"; }
      b.addEventListener("click", function () {
        send({ text: action.label, action: { actionId: String(action.id), label: action.label, replyToMessageId: message.id } });
      });
      row.appendChild(b);
    });
    return row.childNodes.length ? row : null;
  }
  function chosenAction(messageId) {
    var found = null;
    S.msgs.forEach(function (m) {
      (m.parts || []).forEach(function (p) { if (p && p.type === "action" && p.replyToMessageId === messageId) found = p.actionId; });
    });
    S.pending.forEach(function (p) { if (p.action && p.action.replyToMessageId === messageId && p.state !== "failed") found = p.action.actionId; });
    return found;
  }
  function cardBlock(block) {
    var c = card(typeof block.title === "string" ? block.title : "");
    if (typeof block.body === "string" && block.body) { var body = el("div", "rc-card-b rc-text"); body.appendChild(markdown(block.body)); c.appendChild(body); }
    if (Array.isArray(block.fields) && block.fields.length) {
      c.appendChild(fieldList(block.fields.slice(0, 24).filter(Boolean).map(function (f) { return [plain(f.label), plain(f.value)]; })));
    }
    if (block.link && typeof block.link.href === "string") {
      var safe = safeHref(block.link.href);
      if (safe) {
        var a = el("a", "rc-card-l", plain(block.link.label) || "Abrir");
        a.href = safe.href; a.target = safe.external ? "_blank" : "_top"; a.rel = "noopener noreferrer";
        c.appendChild(a);
      }
    }
    return c;
  }
  function widgetBlock(block) {
    var ref = String(block.widget || "");
    var entry = S.widgets[ref];
    if (!entry) { entry = S.widgets[ref] = { state: "loading", widget: null }; queueWidget(ref); }
    var widget = entry.widget;
    var c = card(widget && widget.name ? plain(widget.name) : ref || "Widget", entry.state === "loading" ? "ph" : "");
    c.setAttribute("data-widget", ref);
    var data = block.data && typeof block.data === "object" ? block.data : {};
    var pairs = [];
    // CompiledWidget.fields: { key: { type, label? } } (an array of keys is accepted too).
    var fields = widget && widget.fields && typeof widget.fields === "object" ? widget.fields : null;
    var keys = fields ? (Array.isArray(fields) ? fields.map(function (f) { return typeof f === "string" ? f : f && (f.key || f.name); }) : Object.keys(fields)) : [];
    if (keys.length) {
      keys.slice(0, 24).forEach(function (key) {
        if (!key || data[key] == null || data[key] === "") return;
        var spec = !Array.isArray(fields) && fields[key] && typeof fields[key] === "object" ? fields[key] : null;
        pairs.push([plain((spec && spec.label) || key), plain(data[key])]);
      });
    } else {
      Object.keys(data).slice(0, 24).forEach(function (key) { pairs.push([key, plain(data[key])]); });
    }
    if (pairs.length) c.appendChild(fieldList(pairs));
    else if (entry.state === "loading") c.appendChild(el("p", "rc-card-m", "Carregando…"));
    return c;
  }
  function queueWidget(ref) {
    if (!ref) return;
    S.widgetQueue.push(ref);
    if (S.widgetQueue.length > 1) return;
    var gen = S.gen;
    setTimeout(function () {
      var refs = S.widgetQueue.splice(0, S.widgetQueue.length).slice(0, 20);
      api("widgets", { refs: refs }).then(function (res) {
        if (gen !== S.gen) return;
        var list = res && Array.isArray(res.widgets) ? res.widgets : [];
        refs.forEach(function (r) {
          var match = null;
          list.forEach(function (w) { if (widgetMatches(w, r)) match = w; });
          S.widgets[r] = { state: "ready", widget: match };
        });
        refreshWidgets(refs);
      }, function () {
        if (gen !== S.gen) return;
        refs.forEach(function (r) { S.widgets[r] = { state: "ready", widget: null }; });
        refreshWidgets(refs);
      });
    }, 0);
  }
  function widgetMatches(w, r) {
    if (!w) return false;
    var bare = String(r).split("@")[0];
    var ref = w.ref && typeof w.ref === "object" ? w.ref : null;
    return Boolean((ref && (ref.ref === r || ref.ref === bare || ref.itemId === r)) || w.ref === r || w.name === r || w.name === bare);
  }
  function refreshWidgets(refs) {
    S.msgs.forEach(function (m) {
      (m.parts || []).forEach(function (p) {
        if (p && p.type === "ui" && p.block && p.block.kind === "widget" && refs.indexOf(String(p.block.widget || "")) >= 0) S.dirty.add("m:" + m.id);
      });
    });
    render();
  }
  function viewBlock(block) {
    var c = card("Ver dados", "ph");
    c.setAttribute("data-view-id", String(block.viewId || ""));
    var meta = [];
    if (block.layout) meta.push({ list: "Lista", table: "Tabela", board: "Quadro", gallery: "Galeria" }[block.layout] || String(block.layout));
    if (block.limit) meta.push(block.limit + " itens");
    c.appendChild(el("p", "rc-card-m", meta.length ? meta.join(" · ") : "Dados da base desta página"));
    return c;
  }
  function chartBlock(block) {
    var c = card("Gráfico", "ph");
    c.setAttribute("data-chart-id", String(block.chartId || ""));
    c.appendChild(el("p", "rc-card-m", "O gráfico aparece aqui."));
    return c;
  }

  /* ---------- parts ---------- */
  function toolChip(part) {
    var chip = el("span", "rc-chip " + (part.status || "running"));
    chip.appendChild(el("i"));
    chip.appendChild(document.createTextNode(plain(part.title) || "Ferramenta"));
    chip.title = part.status === "failed" ? "Falhou" : part.status === "done" ? "Concluído" : "Em andamento";
    return chip;
  }
  function confirmCard(part) {
    var c = card("", "rc-confirm");
    c.appendChild(el("p", "rc-confirm-q", "Confirmação"));
    var summary = el("div", "rc-card-b rc-text"); summary.appendChild(markdown(part.summary || "")); c.appendChild(summary);
    var id = part.confirmationId;
    var status = part.status || "pending";
    var forMe = Boolean(S.viewer && part.forUserId === S.viewer.userId);
    if (status === "pending") {
      if (forMe) {
        var row = el("div", "rc-row");
        var deciding = S.deciding[id];
        var yes = el("button", "rc-btn primary", deciding === "confirm" ? "Confirmando…" : "Confirmar");
        var no = el("button", "rc-btn", deciding === "cancel" ? "Cancelando…" : "Cancelar");
        yes.type = no.type = "button";
        yes.disabled = no.disabled = Boolean(deciding);
        yes.addEventListener("click", function () { decide(part, "confirm"); });
        no.addEventListener("click", function () { decide(part, "cancel"); });
        row.appendChild(yes); row.appendChild(no); c.appendChild(row);
        if (S.decideError[id]) c.appendChild(el("p", "rc-note err", S.decideError[id]));
      } else {
        c.appendChild(el("p", "rc-note", "Esperando " + nameOf(part.forUserId) + " confirmar."));
      }
    } else {
      var text = status === "confirmed" ? "Confirmado" : status === "cancelled" ? "Cancelado" : "Expirou sem confirmação";
      c.appendChild(el("p", "rc-note" + (status === "confirmed" ? " ok" : ""), text));
    }
    return c;
  }
  function decide(part, decision) {
    var id = part.confirmationId;
    if (S.deciding[id] || !S.room) return;
    S.deciding[id] = decision; delete S.decideError[id];
    dirtyPart(id); render();
    var gen = S.gen;
    api("confirm", { roomId: S.room.id, confirmationId: id, decision: decision }).then(function () {
      if (gen !== S.gen) return;
      delete S.deciding[id];
      part.status = decision === "confirm" ? "confirmed" : "cancelled";
      dirtyPart(id); render();
    }, function (err) {
      if (gen !== S.gen) return;
      delete S.deciding[id];
      S.decideError[id] = err.code === "network" ? "Sem conexão. Tente de novo." : "Não deu para registrar sua resposta. Tente de novo.";
      dirtyPart(id); render();
    });
  }
  function dirtyPart(confirmationId) {
    S.msgs.forEach(function (m) {
      (m.parts || []).forEach(function (p) { if (p && p.confirmationId === confirmationId) S.dirty.add("m:" + m.id); });
    });
  }

  /* ---------- message model ---------- */
  function upsert(m, opts) {
    if (!m || typeof m.id !== "string") return;
    if (S.room && m.roomId && m.roomId !== S.room.id) return;
    if (m.deletedAt) { removeMessage(m.id, m.seq); return; }
    var existing = S.msgs.get(m.id);
    if (existing && existing.status === "streaming" && m.status === "streaming" && typeof existing.text === "string" &&
        typeof m.text === "string" && existing.text.length > m.text.length && existing.text.indexOf(m.text) === 0) {
      m.text = existing.text;
    }
    if (typeof m.text !== "string") m.text = "";
    if (!Array.isArray(m.parts)) m.parts = [];
    var buffered = S.deltas.get(m.id);
    if (buffered) { S.deltas.delete(m.id); if (m.status === "streaming" && m.text.slice(-buffered.length) !== buffered) m.text += buffered; }
    if (!existing && !(opts && opts.history)) S.entered.add("m:" + m.id);
    S.msgs.set(m.id, m);
    if (m.clientMessageId && S.pending.has(m.clientMessageId)) {
      S.pending.delete(m.clientMessageId);
      dropNode("p:" + m.clientMessageId);
    }
    if (typeof m.seq === "number") {
      if (m.seq > S.lastSeq) S.lastSeq = m.seq;
      if (!S.minSeq || m.seq < S.minSeq) S.minSeq = m.seq;
    }
    if (m.author && m.author.type === "agent") {
      S.waiting.forEach(function (_turn, userMessageId) {
        var u = S.msgs.get(userMessageId);
        if (!u || typeof u.seq !== "number" || u.seq < m.seq) { S.waiting.delete(userMessageId); S.dirty.add("m:" + userMessageId); }
      });
      var st = S.agentStatus.get(m.id);
      if (m.status !== "streaming" && st && (st.status === "queued" || st.status === "running")) S.agentStatus.delete(m.id);
    }
    if (m.author && m.author.type === "user" && S.typing.has(m.author.userId)) { S.typing.delete(m.author.userId); renderTyping(); }
    // An action reply disables the buttons it answers.
    (m.parts || []).forEach(function (p) { if (p && p.type === "action" && p.replyToMessageId) S.dirty.add("m:" + p.replyToMessageId); });
    S.dirty.add("m:" + m.id);
  }
  function removeMessage(id, seq) {
    if (typeof seq === "number" && seq > S.lastSeq) S.lastSeq = seq;
    if (!S.msgs.has(id)) return;
    S.msgs.delete(id);
    S.agentStatus.delete(id);
    S.waiting.delete(id);
    dropNode("m:" + id);
  }
  function applyDelta(id, text) {
    if (typeof text !== "string" || !text) return;
    var m = S.msgs.get(id);
    if (!m) { S.deltas.set(id, (S.deltas.get(id) || "") + text); scheduleCatchUp(); return; }
    m.text = (m.text || "") + text;
    if (m.status !== "streaming") m.status = "streaming";
    S.dirty.add("m:" + id);
  }
  function setTurn(ev) {
    var turn = S.turns.get(ev.turnId) || {};
    turn.status = ev.status; turn.messageId = ev.messageId; S.turns.set(ev.turnId, turn);
    if (turn.userMessageId && S.waiting.has(turn.userMessageId) && ev.messageId) {
      S.waiting.delete(turn.userMessageId); S.dirty.add("m:" + turn.userMessageId);
    }
    if (!ev.messageId) return;
    var known = S.msgs.get(ev.messageId);
    if (ev.status === "complete" && known && known.ghost) { removeMessage(ev.messageId); return; }
    if (ev.status === "complete") S.agentStatus.delete(ev.messageId);
    else S.agentStatus.set(ev.messageId, { status: ev.status, label: typeof ev.label === "string" ? ev.label : "" });
    if (!S.msgs.has(ev.messageId) && (ev.status === "queued" || ev.status === "running")) {
      // The status can arrive before the message: show a thinking bubble in its place.
      S.msgs.set(ev.messageId, {
        id: ev.messageId, roomId: S.room ? S.room.id : "", seq: S.lastSeq + 0.5, ghost: true,
        author: { type: "agent", displayName: S.assistant }, text: "", parts: [], status: "streaming",
        source: "text", clientMessageId: null, anchor: null, createdAt: new Date().toISOString(), editedAt: null, deletedAt: null
      });
      S.entered.add("m:" + ev.messageId);
    }
    S.dirty.add("m:" + ev.messageId);
  }
  function handleEvent(ev) {
    if (!ev || typeof ev.type !== "string") return;
    if (ev.type === "message.created" || ev.type === "message.updated") {
      var m = ev.message;
      if (!m) return;
      if (ev.type === "message.created" && typeof m.seq === "number" && S.lastSeq && m.seq > S.lastSeq + 1 && !S.msgs.has(m.id)) scheduleCatchUp();
      upsert(m);
    } else if (ev.type === "message.delta") applyDelta(ev.messageId, ev.text);
    else if (ev.type === "message.deleted") removeMessage(ev.messageId, ev.seq);
    else if (ev.type === "turn.status") setTurn(ev);
    render();
  }

  /* ---------- rendering ---------- */
  function items() {
    var list = [];
    S.msgs.forEach(function (m) { list.push({ key: "m:" + m.id, seq: typeof m.seq === "number" ? m.seq : Infinity, at: 0, m: m }); });
    S.pending.forEach(function (p) { list.push({ key: "p:" + p.cid, seq: Infinity, at: p.at, p: p }); });
    list.sort(function (a, b) { return a.seq - b.seq || a.at - b.at; });
    return list;
  }
  function dropNode(key) {
    var node = S.nodes.get(key);
    if (node && node.parentNode) node.parentNode.removeChild(node);
    S.nodes.delete(key);
  }
  function agentStatusLine(m) {
    var st = S.agentStatus.get(m.id);
    if (!st && m.status !== "streaming") return null;
    var text = st ? st.label || STATUS[st.status] || "" : "";
    if (st && st.status === "waiting_confirmation" && !st.label) {
      var conf = (m.parts || []).filter(function (p) { return p && p.type === "confirmation" && p.status === "pending"; })[0];
      if (conf && S.viewer && conf.forUserId !== S.viewer.userId) text = "esperando " + nameOf(conf.forUserId);
    }
    if (st && st.status === "failed") {
      var failed = el("div", "rc-status failed", st.label || "Não consegui terminar esta resposta.");
      return failed;
    }
    if (!text && m.text) return null;
    var line = el("div", "rc-status");
    if (!st || st.status !== "waiting_confirmation") {
      var dots = el("span", "rc-dots"); dots.appendChild(el("i")); dots.appendChild(el("i")); dots.appendChild(el("i"));
      dots.setAttribute("aria-hidden", "true");
      line.appendChild(dots);
    }
    line.appendChild(el("span", null, text || "pensando"));
    return line;
  }
  function renderMessage(item) {
    var m = item.m, p = item.p;
    var mine = p ? true : isMine(m);
    var type = p ? "user" : (m.author && m.author.type) || "system";
    var li = el("li", "rc-msg " + (mine ? "mine" : type === "agent" ? "agent" : type === "system" ? "system" : "other"));
    li.setAttribute("data-key", item.key);
    if (p) li.className += p.state === "failed" ? " failed" : " pending";
    // Streaming bubbles are re-rendered per delta: screen readers read them once, when complete.
    if (m && m.status === "streaming") li.setAttribute("aria-busy", "true");
    if (S.entered.has(item.key)) { li.className += " enter"; S.entered.delete(item.key); }
    if (!mine && type !== "system") li.appendChild(avatar(m.author.displayName, authorKey(m), type === "agent"));
    var col = el("div", "rc-col");
    var bubble = el("div", "rc-bubble");
    if (!mine && type !== "system") {
      var author = el("div", "rc-author", type === "agent" ? m.author.displayName || S.assistant : m.author.displayName || "Visitante");
      if (m.author && m.author.role === "guest") author.appendChild(el("span", "rc-badge", "convidado"));
      bubble.appendChild(author);
    }
    var source = m && m.source;
    if (mine && (source === "voice" || source === "comment")) {
      var badgeRow = el("div", "rc-author"); badgeRow.appendChild(el("span", "rc-badge", source === "voice" ? "voz" : "comentário")); bubble.appendChild(badgeRow);
    } else if (!mine && type !== "system" && (source === "voice" || source === "comment")) {
      bubble.firstChild.appendChild(el("span", "rc-badge", source === "voice" ? "voz" : "comentário"));
    }
    var text = el("div", "rc-text");
    text.appendChild(markdown(p ? p.text : m.text));
    if (m && m.status === "streaming" && m.text) { var last = text.lastChild || text; if (last.tagName === "UL" || last.tagName === "OL" || last.tagName === "PRE") last = last.lastChild || last; last.appendChild(el("span", "rc-caret")); }
    bubble.appendChild(text);
    if (m && type === "agent") { var status = agentStatusLine(m); if (status) bubble.appendChild(status); }
    if (m && m.parts.length) {
      var parts = el("div", "rc-parts");
      var tools = null;
      m.parts.forEach(function (part) {
        if (!part || typeof part.type !== "string") return;
        if (part.type === "tool") { if (!tools) { tools = el("div", "rc-tools"); parts.appendChild(tools); } tools.appendChild(toolChip(part)); }
        else if (part.type === "confirmation") parts.appendChild(confirmCard(part));
        else if (part.type === "ui") { var node = renderBlock(part.block, m); if (node) parts.appendChild(node); }
      });
      bubble.appendChild(parts);
    }
    col.appendChild(bubble);
    col.appendChild(metaLine(item, mine));
    li.appendChild(col);
    return li;
  }
  function metaLine(item, mine) {
    var meta = el("div", "rc-meta");
    var p = item.p, m = item.m;
    if (p) {
      if (p.state === "sending") meta.appendChild(el("span", null, "Enviando…"));
      else {
        meta.appendChild(el("span", "err", "Não enviada. " + errText(p.error)));
        meta.appendChild(linkButton("Tentar de novo", function () { send({ cid: p.cid, text: p.text, action: p.action }); }));
        meta.appendChild(linkButton("Editar", function () { editPending(p); }));
        meta.appendChild(linkButton("Descartar", function () { S.pending.delete(p.cid); dropNode("p:" + p.cid); render(); }));
      }
      return meta;
    }
    meta.setAttribute("data-time", "1");
    if (m.ghost) return meta;
    var time = timeText(m.createdAt);
    if (time) meta.appendChild(el("span", "rc-time", time));
    if (m.editedAt) meta.appendChild(el("span", null, "editada"));
    if (mine && S.waiting.has(m.id)) {
      var turn = S.turns.get(S.waiting.get(m.id)) || {};
      meta.appendChild(el("span", null, (turn.status === "queued" ? S.assistant + " vai responder" : S.assistant + " está pensando") + "…"));
    }
    if (mine && !m.ghost) {
      var armed = S.armed === m.id;
      var del = linkButton(armed ? "Apagar mesmo?" : "Apagar", function () { askDelete(m); });
      del.className += " del" + (armed ? " armed" : "");
      del.setAttribute("aria-label", armed ? "Confirmar: apagar mensagem" : "Apagar mensagem");
      meta.appendChild(del);
    }
    return meta;
  }
  function linkButton(label, onClick) {
    var b = el("button", "rc-link", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function askDelete(m) {
    if (S.armed !== m.id) {
      var previous = S.armed; S.armed = m.id;
      if (previous) S.dirty.add("m:" + previous);
      S.dirty.add("m:" + m.id); render(true);
      setTimeout(function () { if (S.armed === m.id) { S.armed = null; S.dirty.add("m:" + m.id); render(true); } }, 4000);
      return;
    }
    S.armed = null;
    if (!S.room) return;
    var gen = S.gen;
    api("delete", { roomId: S.room.id, messageId: m.id }).then(function () {
      if (gen !== S.gen) return;
      removeMessage(m.id); render();
    }, function () {
      if (gen !== S.gen) return;
      S.dirty.add("m:" + m.id); render(true);
      announce("Não deu para apagar a mensagem.");
    });
  }
  /** Re-rendering a bubble must not drop the focus of a button inside it. */
  function keepFocus(previous, next) {
    var active = document.activeElement;
    if (!previous || !active || !previous.contains(active)) return;
    var before = Array.prototype.slice.call(previous.querySelectorAll("button,a[href]"));
    var index = before.indexOf(active);
    if (index < 0) return;
    setTimeout(function () {
      var after = next.querySelectorAll("button,a[href]")[index];
      var target = after && !after.disabled ? after : next.querySelector("button:not([disabled]),a[href]");
      if (target) try { target.focus({ preventScroll: true }); } catch (e) {}
    }, 0);
  }
  function regroup(list) {
    var prev = null;
    list.forEach(function (item) {
      var node = S.nodes.get(item.key);
      if (!node) return;
      var m = item.m;
      var key = item.p ? "u:" + (S.viewer ? S.viewer.userId : "") : authorKey(m);
      var at = item.p ? item.p.at : Date.parse(m.createdAt) || 0;
      var cont = Boolean(prev && prev.key === key && key !== "system" && at - prev.at < 5 * 60 * 1000);
      node.classList.toggle("cont", cont);
      if (prev && prev.node) {
        // Only the last bubble of a group shows the time.
        var prevMeta = prev.node.querySelector(".rc-time");
        if (prevMeta) prevMeta.hidden = cont;
      }
      prev = { key: key, at: at, node: node };
    });
    if (prev && prev.node) { var t = prev.node.querySelector(".rc-time"); if (t) t.hidden = false; }
  }
  function nearBottom() { return ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 96; }
  function toBottom() { ui.scroll.scrollTop = ui.scroll.scrollHeight; ui.jump.hidden = true; }
  var frame = 0;
  function render(keepScroll) {
    if (frame) return;
    frame = requestAnimationFrame(function () { frame = 0; paint(keepScroll); });
  }
  function paint(keepScroll) {
    var stick = nearBottom();
    var list = items();
    var appendedOther = false;
    var cursor = ui.log.firstChild;
    list.forEach(function (item) {
      var node = S.nodes.get(item.key);
      if (!node || S.dirty.has(item.key)) {
        var built = renderMessage(item);
        keepFocus(node, built);
        if (!node && !(item.p || (item.m && isMine(item.m)))) appendedOther = true;
        if (node && node.parentNode) node.parentNode.replaceChild(built, node);
        if (cursor === node) cursor = built;
        S.nodes.set(item.key, built);
        node = built;
      }
      if (node !== cursor) ui.log.insertBefore(node, cursor);
      cursor = node.nextSibling;
    });
    S.dirty.clear();
    regroup(list);
    ui.empty.hidden = list.length > 0 || !S.room;
    ui.older.hidden = !S.hasOlder;
    if (!keepScroll && stick) toBottom();
    else if (appendedOther && !stick) ui.jump.hidden = false;
    markRead();
  }
  function renderHeader() {
    var shared = S.kind === "shared";
    ui.name.textContent = shared ? "Conversa da página" : "Você e " + S.assistant;
    var humans = S.online.length;
    ui.sub.textContent = shared ? (humans > 1 ? humans + " pessoas aqui agora" : "Todos que veem esta página veem esta sala") : "Só você vê esta conversa";
    Array.prototype.forEach.call(ui.kind.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-checked", b.getAttribute("data-kind") === S.kind ? "true" : "false");
      b.tabIndex = b.getAttribute("data-kind") === S.kind ? 0 : -1;
    });
    ui.voice.hidden = !(S.voice && cfg.mode === "panel" && embedded);
    ui.close.hidden = !(cfg.mode === "panel" && embedded);
    ui.input.placeholder = "Fale com o " + S.assistant;
    var hint = touch ? "" : "Enter envia · Shift+Enter quebra a linha";
    var memberCount = Object.keys(S.members).length;
    if (shared && S.replyPolicy !== "always" && memberCount > 1) hint = "Na sala, mencione @" + S.assistant + " para chamar o assistente" + (touch ? "" : " · Shift+Enter quebra a linha");
    ui.hint.textContent = hint;
    while (ui.empty.firstChild) ui.empty.removeChild(ui.empty.firstChild);
    ui.empty.appendChild(el("strong", null, shared ? "Comece a conversa" : "Pergunte ao " + S.assistant));
    ui.empty.appendChild(document.createTextNode(shared
      ? "Pergunte qualquer coisa sobre esta página. Quem estiver aqui vê a conversa."
      : "Só você e o " + S.assistant + " veem esta conversa."));
    renderPresence();
  }
  function renderPresence() {
    while (ui.presence.firstChild) ui.presence.removeChild(ui.presence.firstChild);
    var shown = S.online.slice(0, 4);
    shown.forEach(function (person) {
      var a = avatar(person.displayName, "u:" + person.userId, false);
      a.removeAttribute("aria-hidden");
      a.setAttribute("role", "img");
      a.setAttribute("aria-label", person.displayName + (S.viewer && person.userId === S.viewer.userId ? " (você)" : ""));
      a.title = person.displayName;
      ui.presence.appendChild(a);
    });
    if (S.online.length > shown.length) ui.presence.appendChild(el("span", "rc-more", "+" + (S.online.length - shown.length)));
    ui.presence.hidden = S.kind !== "shared" || S.online.length < 1;
  }
  function renderTyping() {
    var now = Date.now(), names = [];
    S.typing.forEach(function (t, userId) { if (t.until > now) names.push(t.name); else S.typing.delete(userId); });
    ui.typing.textContent = !names.length ? "" : names.length === 1 ? names[0] + " está digitando…"
      : names.length === 2 ? names[0] + " e " + names[1] + " estão digitando…" : "Várias pessoas estão digitando…";
    clearTimeout(S.typingTimer);
    if (names.length) S.typingTimer = setTimeout(renderTyping, 1000);
  }
  var announcer = el("div", "rc-sr"); announcer.setAttribute("role", "status"); document.body.appendChild(announcer);
  function announce(text) { announcer.textContent = ""; setTimeout(function () { announcer.textContent = text; }, 30); }
  function gate(state, text, actions) {
    ui.gate.hidden = state === "none";
    ui.gate.classList.toggle("idle", state !== "loading");
    ui.gateText.textContent = text || "";
    while (ui.gateActions.firstChild) ui.gateActions.removeChild(ui.gateActions.firstChild);
    (actions || []).forEach(function (node) { ui.gateActions.appendChild(node); });
    var ready = state === "none";
    ui.input.disabled = !ready;
    syncSend();
  }
  function setConn(state) {
    if (state === "open" || state === "idle") { ui.conn.hidden = true; ui.conn.textContent = ""; return; }
    ui.conn.hidden = false;
    ui.conn.textContent = state === "connecting" ? "Conectando…" : navigator.onLine === false ? "Sem internet. Suas mensagens esperam a conexão voltar." : "Reconectando…";
  }

  /* ---------- unread / read ---------- */
  function unreadCount() {
    var n = 0;
    S.msgs.forEach(function (m) { if (!m.ghost && typeof m.seq === "number" && m.seq > S.lastReadSeq && !isMine(m)) n += 1; });
    return n;
  }
  var readTimer = 0;
  function markRead() {
    if (S.room && S.visible && document.visibilityState === "visible" && nearBottom()) {
      var seq = Math.floor(S.lastSeq);
      if (seq > S.lastReadSeq) S.lastReadSeq = seq;
      if (S.lastReadSeq > S.readSent) {
        clearTimeout(readTimer);
        var gen = S.gen;
        readTimer = setTimeout(function () {
          if (gen !== S.gen || !S.room || S.lastReadSeq <= S.readSent) return;
          S.readSent = S.lastReadSeq;
          api("read", { roomId: S.room.id, seq: S.readSent }).catch(function () { S.readSent = 0; });
        }, 700);
      }
    }
    post({ type: "ravi-chat:unread", count: unreadCount() });
  }

  /* ---------- open, catch up, history ---------- */
  function openRoom(silent) {
    var gen = S.gen;
    if (!silent) gate("loading", "Abrindo a conversa…");
    return api("open", { path: cfg.path, kind: S.kind }).then(function (res) {
      if (gen !== S.gen) return;
      if (!res || !res.room || typeof res.room.id !== "string") throw Object.assign(new Error("chat"), { code: "chat_unavailable" });
      if (S.room && S.room.id !== res.room.id) { resetRoom(); return openRoom(false); }
      S.room = res.room;
      S.replyPolicy = res.room.replyPolicy || null;
      S.viewer = res.viewer || null;
      S.assistant = typeof res.assistantName === "string" && res.assistantName.trim() ? res.assistantName.trim() : "Ravi";
      S.voice = Boolean(res.voiceEnabled);
      S.members = {};
      (Array.isArray(res.members) ? res.members : []).forEach(function (member) { if (member && member.userId) S.members[member.userId] = member; });
      if (typeof res.lastReadSeq === "number" && res.lastReadSeq > S.lastReadSeq) { S.lastReadSeq = res.lastReadSeq; S.readSent = res.lastReadSeq; }
      var messages = Array.isArray(res.messages) ? res.messages : [];
      if (!silent) S.hasOlder = messages.length >= 50;
      messages.forEach(function (m) { upsert(m, { history: true }); });
      if (typeof res.lastSeq === "number" && res.lastSeq > S.lastSeq && silent) scheduleCatchUp();
      renderHeader();
      gate("none");
      render();
      if (!silent) { connect(); if (cfg.mode === "page" || document.hasFocus()) focusComposer(); }
    }, function (err) {
      if (gen !== S.gen) return;
      if (silent && err.code !== "chat_session_required" && err.code !== "chat_forbidden" && err.code !== "chat_disabled_for_site") return;
      closeSocket();
      S.room = null;
      showOpenError(err.code);
    });
  }
  function showOpenError(code) {
    if (code === "chat_session_required") {
      var actions = [];
      if (cfg.loginUrl) { var a = el("a", null, "Entrar"); a.href = cfg.loginUrl; a.target = "_top"; a.rel = "noopener"; actions.push(a); }
      gate("idle", "Entre para conversar sobre esta página.", actions);
      return;
    }
    if (code === "chat_forbidden") return gate("idle", "Você não tem acesso a esta conversa.");
    if (code === "chat_disabled_for_site") return gate("idle", "A conversa está desligada neste site.");
    if (code === "chat_room_not_found") return gate("idle", "Esta página não tem conversa.");
    var retry = el("button", "rc-btn", "Tentar de novo"); retry.type = "button";
    retry.addEventListener("click", function () { openRoom(false); });
    gate("idle", code === "chat_rate_limited" ? "Muita gente abrindo a conversa agora. Tente em instantes." : code === "network" ? "Sem conexão com o Ravi." : "Não foi possível abrir a conversa.", [retry]);
  }
  var catchTimer = 0;
  function scheduleCatchUp() { clearTimeout(catchTimer); catchTimer = setTimeout(catchUp, 120); }
  function catchUp() {
    if (!S.room) return;
    if (S.catching) { S.catchAgain = true; return; }
    S.catching = true;
    var gen = S.gen;
    api("list", { roomId: S.room.id, afterSeq: Math.floor(S.lastSeq), limit: 100 }).then(function (res) {
      if (gen !== S.gen) return;
      var messages = res && Array.isArray(res.messages) ? res.messages : [];
      messages.forEach(function (m) { upsert(m); });
      S.catching = false;
      render();
      if (messages.length >= 100 || S.catchAgain) { S.catchAgain = false; catchUp(); }
    }, function () { if (gen === S.gen) S.catching = false; });
  }
  function loadOlder() {
    if (!S.room || !S.minSeq) return;
    ui.older.disabled = true;
    var gen = S.gen;
    api("list", { roomId: S.room.id, beforeSeq: S.minSeq, limit: 50 }).then(function (res) {
      if (gen !== S.gen) return;
      var messages = res && Array.isArray(res.messages) ? res.messages : [];
      var before = ui.scroll.scrollHeight;
      messages.forEach(function (m) { upsert(m, { history: true }); });
      S.hasOlder = messages.length >= 50;
      ui.older.disabled = false;
      paint(true);
      ui.scroll.scrollTop += ui.scroll.scrollHeight - before;
    }, function () { ui.older.disabled = false; });
  }

  /* ---------- socket ---------- */
  function socketUrl() {
    var q = "roomId=" + encodeURIComponent(S.room.id) + "&path=" + encodeURIComponent(cfg.path) + "&kind=" + encodeURIComponent(S.kind);
    if (cfg.host) q += "&host=" + encodeURIComponent(cfg.host);
    return (location.protocol === "http:" ? "ws://" : "wss://") + location.host + cfg.base + "/socket?" + q;
  }
  function connect() {
    if (!S.room || S.ws) return;
    clearTimeout(S.reconnectTimer);
    var gen = S.gen, ws;
    try { ws = new WebSocket(socketUrl()); } catch (e) { reconnectLater(); return; }
    S.ws = ws;
    setConn(S.attempts ? "offline" : "connecting");
    ws.onopen = function () {
      if (gen !== S.gen) { ws.close(); return; }
      S.attempts = 0;
      setConn("open");
      clearInterval(S.pingTimer);
      S.pingTimer = setInterval(function () { if (ws.readyState === 1) ws.send(PING); }, 25000);
      catchUp();
    };
    ws.onmessage = function (event) {
      if (gen !== S.gen || typeof event.data !== "string") return;
      var frame;
      try { frame = JSON.parse(event.data); } catch (e) { return; }
      if (!frame) return;
      if (frame.type === "event") handleEvent(frame.event);
      else if (frame.type === "presence" && Array.isArray(frame.online)) { S.online = frame.online.filter(function (p) { return p && p.userId; }); renderHeader(); }
      else if (frame.type === "typing" && frame.userId && !(S.viewer && frame.userId === S.viewer.userId)) {
        S.typing.set(frame.userId, { name: String(frame.displayName || "Alguém"), until: Date.now() + 4500 }); renderTyping();
      }
    };
    ws.onclose = function () {
      if (S.ws !== ws) return;
      S.ws = null;
      clearInterval(S.pingTimer);
      if (gen === S.gen) reconnectLater();
    };
  }
  function reconnectLater() {
    S.attempts += 1;
    setConn("offline");
    var delay = Math.min(30000, 1000 * Math.pow(2, Math.min(S.attempts - 1, 5))) * (0.75 + Math.random() * 0.5);
    clearTimeout(S.reconnectTimer);
    var gen = S.gen;
    S.reconnectTimer = setTimeout(function () {
      if (gen !== S.gen) return;
      // After a few failed handshakes, ask the Console again: the session may have expired.
      if (S.attempts >= 3) openRoom(true).then(function () { if (gen === S.gen && S.room) connect(); });
      else connect();
    }, delay);
  }
  function reconnectNow() {
    if (!S.room || S.ws) return;
    S.attempts = Math.min(S.attempts, 1);
    clearTimeout(S.reconnectTimer);
    connect();
  }
  function closeSocket() {
    clearTimeout(S.reconnectTimer);
    clearInterval(S.pingTimer);
    var ws = S.ws; S.ws = null;
    if (ws) try { ws.close(1000, "bye"); } catch (e) {}
  }
  function resetRoom() {
    closeSocket();
    S.nodes.forEach(function (_node, key) { dropNode(key); });
    while (ui.log.firstChild) ui.log.removeChild(ui.log.firstChild);
    var kind = S.kind, visible = S.visible;
    S = fresh(); S.kind = kind; S.visible = visible;
    ui.typing.textContent = "";
    ui.jump.hidden = true;
    setConn("idle");
  }

  /* ---------- composer ---------- */
  function syncSend() { ui.send.disabled = ui.input.disabled || !ui.input.value.trim(); }
  function autosize() {
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 160) + "px";
  }
  function focusComposer() { if (!ui.input.disabled) try { ui.input.focus({ preventScroll: true }); } catch (e) { ui.input.focus(); } }
  function submit() {
    var text = ui.input.value.replace(/\s+$/, "").replace(/^\n+/, "");
    if (!text.trim() || !S.room) return;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    ui.input.value = "";
    autosize(); syncSend();
    send({ text: text });
    focusComposer();
  }
  function send(o) {
    if (!S.room) return;
    var cid = o.cid || uuid();
    var p = S.pending.get(cid) || { cid: cid, at: Date.now() };
    if (!S.pending.has(cid)) S.entered.add("p:" + cid);
    p.text = o.text; p.action = o.action || null; p.state = "sending"; p.error = null;
    S.pending.set(cid, p);
    S.dirty.add("p:" + cid);
    if (p.action) S.dirty.add("m:" + p.action.replyToMessageId);
    render(true);
    requestAnimationFrame(function () { requestAnimationFrame(toBottom); });
    var body = { roomId: S.room.id, clientMessageId: cid, text: p.text };
    if (p.action) body.action = p.action;
    var gen = S.gen;
    api("send", body).then(function (res) {
      if (gen !== S.gen) return;
      if (!res || !res.message) { fail(cid, "chat_unavailable"); return; }
      upsert(res.message);
      if (res.turn && res.turn.id) {
        var turn = S.turns.get(res.turn.id) || {};
        turn.userMessageId = res.message.id; if (!turn.status) turn.status = res.turn.status;
        S.turns.set(res.turn.id, turn);
        if (!turn.messageId && !agentAfter(res.message)) { S.waiting.set(res.message.id, res.turn.id); S.dirty.add("m:" + res.message.id); }
      }
      render();
    }, function (err) {
      if (gen !== S.gen) return;
      if (err.code === "chat_session_required") showOpenError(err.code);
      fail(cid, err.code);
    });
  }
  function agentAfter(m) {
    var found = false;
    S.msgs.forEach(function (x) { if (x.author && x.author.type === "agent" && typeof x.seq === "number" && x.seq > m.seq) found = true; });
    return found;
  }
  function fail(cid, code) {
    var p = S.pending.get(cid);
    if (!p) return;
    p.state = "failed"; p.error = code;
    S.dirty.add("p:" + cid);
    if (p.action) S.dirty.add("m:" + p.action.replyToMessageId);
    render(true);
    announce("Mensagem não enviada. " + errText(code));
  }
  function editPending(p) {
    S.pending.delete(p.cid);
    dropNode("p:" + p.cid);
    var current = ui.input.value;
    ui.input.value = current ? p.text + "\n" + current : p.text;
    autosize(); syncSend(); render(true);
    focusComposer();
    try { ui.input.setSelectionRange(p.text.length, p.text.length); } catch (e) {}
  }
  function signalTyping() {
    var now = Date.now();
    if (!S.ws || S.ws.readyState !== 1 || !ui.input.value.trim() || now - S.lastTypingSent < 2500) return;
    S.lastTypingSent = now;
    try { S.ws.send(TYPING); } catch (e) {}
  }

  /* ---------- wiring ---------- */
  ui.form.addEventListener("submit", function (event) { event.preventDefault(); submit(); });
  // On touch keyboards Enter is a newline and the send button sends.
  var touch = Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  ui.input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !touch && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      submit();
    }
  });
  ui.input.addEventListener("input", function () { autosize(); syncSend(); signalTyping(); });
  ui.scroll.addEventListener("scroll", function () { if (nearBottom()) { ui.jump.hidden = true; markRead(); } }, { passive: true });
  ui.jump.addEventListener("click", function () { toBottom(); markRead(); focusComposer(); });
  ui.older.addEventListener("click", loadOlder);
  ui.close.addEventListener("click", function () { post({ type: "ravi-chat:close" }); });
  ui.voice.addEventListener("click", function () { post({ type: "ravi-chat:voice" }); });
  ui.kind.addEventListener("click", function (event) {
    var b = event.target && event.target.closest ? event.target.closest("button[data-kind]") : null;
    if (b) switchKind(b.getAttribute("data-kind"));
  });
  ui.kind.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    var next = S.kind === "shared" ? "private" : "shared";
    switchKind(next);
    var target = ui.kind.querySelector('button[data-kind="' + next + '"]');
    if (target) target.focus();
  });
  function switchKind(kind) {
    if ((kind !== "shared" && kind !== "private") || kind === S.kind) return;
    var draft = ui.input.value;
    resetRoom();
    S.kind = kind;
    try { sessionStorage.setItem("ravi-chat:kind:" + cfg.path, kind); } catch (e) {}
    renderHeader();
    openRoom(false).then(function () { if (draft && !ui.input.value) { ui.input.value = draft; autosize(); syncSend(); } });
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !event.isComposing && cfg.mode === "panel" && embedded) post({ type: "ravi-chat:close" });
  });
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || typeof data.type !== "string") return;
    if (data.type === "ravi-chat:visibility") { S.visible = Boolean(data.open); if (S.visible) { render(); reconnectNow(); } }
    else if (data.type === "ravi-chat:focus") { focusComposer(); markRead(); }
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") { reconnectNow(); markRead(); } });
  window.addEventListener("online", function () { setConn(S.ws ? "open" : "offline"); reconnectNow(); });
  window.addEventListener("offline", function () { if (!S.ws) setConn("offline"); });

  ui.root.classList.add("mode-" + (cfg.mode === "page" ? "page" : "panel"));
  renderHeader();
  openRoom(false);
})();
`;

const DOCK_SCRIPT = String.raw`
var w = window;
if (w.__raviChatDock) return;
try { if (w.parent !== w && w.parent.__raviPageChatShell) return; } catch (e) {}
var current = document.currentScript;
var origin = d.chatOrigin || location.origin;
var OPEN_KEY = "ravi-chat:open";
var st = { open: false, unread: 0, frame: null, opener: null };
var host = document.createElement("div");
host.id = "ravi-chat-dock";
host.setAttribute("data-ravi-operator-ui", "chat");
var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
var css = [
  ":host{all:initial}",
  ".scrim{position:fixed;inset:0;z-index:2147483645;display:none;background:rgba(9,9,11,.36)}",
  ".dock{position:fixed;top:var(--ravi-chat-top,0px);right:0;bottom:0;z-index:2147483646;display:none;width:400px;max-width:100vw;" +
    "background:#fff;border-left:1px solid rgba(15,23,42,.12);box-shadow:-10px 0 32px rgba(15,23,42,.14);overflow:hidden}",
  ".open .dock{display:block}",
  "iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}",
  "@media (max-width:639px){.dock{top:auto;left:0;right:0;width:auto;height:min(86vh,760px);height:min(86dvh,760px);" +
    "border-left:0;border-top:1px solid rgba(15,23,42,.12);border-radius:16px 16px 0 0;box-shadow:0 -10px 32px rgba(15,23,42,.2)}" +
    ".open .scrim{display:block}}",
  "@media (prefers-color-scheme:dark){.dock{background:#101217;border-color:rgba(255,255,255,.1)}}",
  "@media (prefers-reduced-motion:no-preference){.open .dock{animation:ravi-chat-in .18s ease-out}}",
  "@keyframes ravi-chat-in{from{opacity:0;transform:translateX(18px)}}",
  "@media (prefers-reduced-motion:no-preference) and (max-width:639px){.open .dock{animation-name:ravi-chat-up}}",
  "@keyframes ravi-chat-up{from{opacity:0;transform:translateY(24px)}}",
  "@media print{.dock,.scrim{display:none!important}}"
].join("");
var style = document.createElement("style");
style.textContent = css;
var wrap = document.createElement("div");
var scrim = document.createElement("div");
scrim.className = "scrim";
var dock = document.createElement("div");
dock.className = "dock";
dock.setAttribute("role", "dialog");
dock.setAttribute("aria-label", "Conversa com o Ravi");
wrap.appendChild(scrim);
wrap.appendChild(dock);
root.appendChild(style);
root.appendChild(wrap);

function pagePath() { return location.pathname + location.search; }
function src() {
  return origin + d.chatPath + "?mode=panel&kind=shared&path=" + encodeURIComponent(pagePath()) +
    (d.chatOrigin ? "&host=" + encodeURIComponent(location.hostname) : "");
}
function placeTop() {
  var top = 0;
  try {
    var tb = d.barId ? document.getElementById(d.barId) : null;
    var bar = tb && tb.shadowRoot && tb.shadowRoot.querySelector('[data-k="bar"]');
    if (bar) { var r = bar.getBoundingClientRect(); if (r.height > 0 && r.bottom > 0) top = Math.round(r.bottom); }
  } catch (e) {}
  host.style.setProperty("--ravi-chat-top", top + "px");
}
function tell(message) {
  if (st.frame && st.frame.contentWindow) try { st.frame.contentWindow.postMessage(message, origin); } catch (e) {}
}
function emit() {
  try { w.dispatchEvent(new CustomEvent("ravi-chat:state", { detail: { open: st.open, unread: st.unread } })); } catch (e) {}
}
function remember(open) { try { sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch (e) {} }
function open(opener, quiet) {
  if (opener) st.opener = opener;
  if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  placeTop();
  if (!st.frame) {
    st.frame = document.createElement("iframe");
    st.frame.title = "Conversa com o Ravi";
    st.frame.setAttribute("allow", "clipboard-write");
    st.frame.src = src();
    st.frame.addEventListener("load", function () { tell({ type: "ravi-chat:visibility", open: st.open }); if (st.open && !quiet) tell({ type: "ravi-chat:focus" }); });
    dock.appendChild(st.frame);
  }
  st.open = true;
  wrap.className = "open";
  remember(true);
  tell({ type: "ravi-chat:visibility", open: true });
  if (!quiet) { tell({ type: "ravi-chat:focus" }); try { st.frame.focus(); } catch (e) {} }
  emit();
}
function close(fromPanel) {
  if (!st.open) return;
  st.open = false;
  wrap.className = "";
  remember(false);
  tell({ type: "ravi-chat:visibility", open: false });
  emit();
  if (fromPanel && st.opener && st.opener.focus) try { st.opener.focus({ preventScroll: true }); } catch (e) {}
}
function toggle(opener) { if (st.open) close(false); else open(opener, false); }
scrim.addEventListener("click", function () { close(true); });
w.addEventListener("message", function (event) {
  if (!st.frame || event.source !== st.frame.contentWindow || event.origin !== origin) return;
  var m = event.data;
  if (!m || typeof m.type !== "string") return;
  if (m.type === "ravi-chat:close") close(true);
  else if (m.type === "ravi-chat:unread") { var n = Number(m.count) || 0; st.unread = n > 0 ? Math.min(999, Math.floor(n)) : 0; emit(); }
  else if (m.type === "ravi-chat:voice" && d.voiceUrl) location.href = d.voiceUrl + "?path=" + encodeURIComponent(location.pathname + location.search + location.hash);
});
w.addEventListener("resize", function () { if (st.open) placeTop(); });
w.__raviChatDock = {
  open: function (opener) { open(opener, false); },
  close: function () { close(false); },
  toggle: toggle,
  state: function () { return { open: st.open, unread: st.unread }; }
};
var reopen = false;
try { reopen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch (e) {}
function start() {
  if (reopen) { open(null, true); return; }
  if (!d.peek) return;
  // One quiet look at the shared room for the unread dot; the panel takes over once opened.
  setTimeout(function () {
    if (st.frame) return;
    fetch(d.chatPath + "/open", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ path: pagePath(), kind: "shared" })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (res) {
      if (!res || st.frame) return;
      var me = res.viewer && res.viewer.userId, seen = Number(res.lastReadSeq) || 0, n = 0;
      (Array.isArray(res.messages) ? res.messages : []).forEach(function (m) {
        if (m && !m.deletedAt && typeof m.seq === "number" && m.seq > seen && !(m.author && m.author.type === "user" && m.author.userId === me)) n += 1;
      });
      st.unread = n; emit();
    }).catch(function () {});
  }, 1500);
}
if (document.readyState === "complete") start(); else w.addEventListener("load", start);
if (current) current.remove();
`;
