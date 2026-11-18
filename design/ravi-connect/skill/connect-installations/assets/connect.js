// connect.js: liga uma Ravi Page a uma ou mais instalações do Ravi do dono, com aprovação no chat do agente.
// Módulo ES sem dependências. Protocolo ravi-connect v1 (o mesmo de scripts/pair.ts).
//
// Guarda em IndexedDB só: a chave privada ECDH P-256 NÃO extraível da página, o pedido (público) e o
// envelope selado. Chaves rctx_ (link e acesso) existem só em memória. Chave de acesso dura no máximo 1 hora.
// Cada pedido fica guardado pelo hash ("p:<hash>") por 15 minutos: duas abas, ou um envelope falso colado antes,
// não impedem o envelope verdadeiro de abrir.
//
// Uso mínimo (o endereço de cada instalação fica fixo aqui; envelope que aponte para outro é recusado):
//   import { createConnect } from "./connect.js";
//   const conn = createConnect({ installations: { local: "http://127.0.0.1:4211", "vps-a": "http://127.0.0.1:7801" }, preset: "ver" });
//   conn.mount(document.getElementById("conectar"));
//   const insts = await conn.session();          // [{ name, baseUrl, state, key(), fetch(), call(), stream() }]
//   const who = await insts[0].call("context/whoami");

export const PROTOCOL = "ravi-connect";
export const REQUEST_PREFIX = "ravi-connect:v1:";
export const ENVELOPE_PREFIX = "ravi-envelope:v1:";
// Mesmos presets de scripts/pair.ts. O envelope traz, por instalação, estas capacidades mais o escopo escolhido
// pelo dono (access:session:<nome>, view:agent:<id>, nunca curinga); a página confere antes de usar.
export const PRESETS = {
  ver: ["read:context:whoami", "read:sessions:list", "read:sessions:info", "read:agents:list"],
  conversar: ["read:context:whoami", "read:sessions:list", "read:sessions:info", "read:agents:list", "mutate:sessions:send"],
};
const SCOPE_CAP_RE = /^(access:session|view:agent):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
/** Capacidades de acesso que um envelope pode trazer: todo o preset e, além dele, só escopo nomeado. */
export function validAccessCaps(caps, preset) {
  if (!Array.isArray(caps) || caps.length > 60 || !caps.every((c) => typeof c === "string")) return false;
  const base = PRESETS[preset];
  return base.every((c) => caps.includes(c)) && caps.every((c) => base.includes(c) || SCOPE_CAP_RE.test(c)) && new Set(caps).size === caps.length;
}
// 256 palavras: 3 palavras = 24 bits do hash do pedido. A MESMA lista está em scripts/pair.ts.
export const WORDS = ("abacate abelha abrigo acucar agulha alface alegria algodao ameixa amora ancora anel anzol arara areia arroz aviao azeite bala balde baleia bambu banana banco barco batata bengala bicho bigode bola bolsa bombom bota brisa burro cabana cabra cacau cadeira cafe caju calor cama camelo caneca caneta canoa capim caqui carta casaco castelo cavalo cebola cedro cenoura cereja chave chuva cidade cinema cipo coco coelho cofre cometa concha coral corda coruja cravo cristal dado dedal degrau deserto diamante disco doce dragao duna elefante enxada escada espelho estrela faca farol fazenda feijao ferro figo fita flauta floresta fogao folha formiga fruta fumaca funil gaivota galho galinha garfo gato gaveta geada gelo girafa girassol goiaba gota grama grilo guarda harpa horta ilha jabuti janela jarra jardim jasmim jangada jipe joia laco lagoa lagarto lama lampada lanterna lapis laranja leao leite lenco lima limao livro lobo lontra lua luva macaco madeira manga mapa mar martelo mel melancia mesa milho mochila moeda moinho montanha morango mosca navio neve ninho noz nuvem oceano oliva onda orvalho ostra ovelha palha panela papel pato pedra peixe pena pera perola piano pipa pirata planeta pomar ponte porta prato praia queijo quiabo raposa regua relogio remo rede rio rocha roda rosa sabao sapato sapo selva semente serra sino sol sorvete tambor tapete tatu teia telhado tesoura tigre tijolo tinta toalha tomate torre trator trem trigo trovao tucano tulipa uva vaca vagalume vale vaso vela vento verao vidro vila viola vulcao xadrez zebra abobora bandeira biscoito bussola cachoeira canela cigarra colmeia esquilo foguete gengibre iogurte mandioca pinguim").split(" ");

const PENDING_MAX_MS = 15 * 60 * 1000; // o mesmo limite do approve no helper (iat de até 15 minutos)
const REFRESH_MARGIN_MS = 60 * 1000;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- utilidades ----------
export const b64u = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));

/** Serialização canônica: ordem fixa de campos. O agente refaz exatamente esta string. */
export function canonicalRequest(r) {
  return JSON.stringify({ v: r.v, kind: r.kind, origin: r.origin, pub: { x: r.pub.x, y: r.pub.y }, preset: r.preset, installs: r.installs, nonce: r.nonce, iat: r.iat });
}
/** Frase (3 palavras) e código de rota (16 hex) derivados do hash do pedido inteiro. */
export function phraseFromHash(h) {
  return [WORDS[h[0]], WORDS[h[1]], WORDS[h[2]]].join("-").toUpperCase();
}
export function codeFromHash(h) {
  return Array.from(h.slice(3, 11), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- IndexedDB (só chave não extraível, pedido público e envelope selado) ----------
const DB_NAME = "ravi-connect";
const STORE = "kv";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const q = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(q && q.result);
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}
const dbGet = (k) => kv("readonly", (s) => s.get(k));
const dbPut = (k, v) => kv("readwrite", (s) => s.put(v, k));
const dbDel = (k) => kv("readwrite", (s) => s.delete(k));
const dbKeys = () => kv("readonly", (s) => s.getAllKeys());
const dbClear = () => kv("readwrite", (s) => s.clear());
/** Apaga os pedidos guardados há mais de 15 minutos. */
async function dropOldPendings() {
  for (const k of (await dbKeys()) || []) {
    if (typeof k !== "string" || !k.startsWith("p:")) continue;
    const p = await dbGet(k);
    if (!p || Date.now() - p.request.iat > PENDING_MAX_MS) await dbDel(k);
  }
}

// ---------- pedido ----------
export async function createRequest({ installs, preset }) {
  if (!PRESETS[preset]) throw new Error("preset desconhecido: " + preset);
  if (!Array.isArray(installs) || installs.length === 0) throw new Error("nenhuma instalação pedida");
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const request = { v: 1, kind: PROTOCOL, origin: location.origin, pub: { x: jwk.x, y: jwk.y }, preset, installs: [...installs], nonce: b64u(crypto.getRandomValues(new Uint8Array(16))), iat: Date.now() };
  const canon = canonicalRequest(request);
  const h = await sha256(canon);
  const pending = { request, text: REQUEST_PREFIX + b64u(enc.encode(canon)), hash: b64u(h), phrase: phraseFromHash(h), code: codeFromHash(h), privateKey: pair.privateKey };
  await dropOldPendings();
  await dbPut("p:" + pending.hash, pending); // para abrir o envelope deste pedido, mesmo que outra aba crie outro
  await dbPut("pending", pending); // o pedido que o cartão mostra
  return pending;
}

async function openEnvelope(env, privateKey, request, hashB64, pins) {
  if (!env || env.v !== 1 || env.h !== hashB64) throw new Error("envelope não é deste pedido");
  const epk = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: env.epk.x, y: env.epk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: unb64u(hashB64), info: enc.encode("ravi-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const aad = enc.encode(`ravi-connect-v1|${hashB64}|${request.origin}`);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(env.iv), additionalData: aad }, aes, unb64u(env.ct));
  const grant = JSON.parse(dec.decode(plain));
  if (grant.v !== 1 || grant.origin !== location.origin || grant.origin !== request.origin || grant.preset !== request.preset || grant.hash !== hashB64) throw new Error("envelope não confere com o pedido");
  if (!Array.isArray(grant.installs)) throw new Error("envelope malformado");
  for (const i of grant.installs) {
    if (!request.installs.includes(i.name)) throw new Error("envelope traz instalação não pedida");
    // o endereço vem da página, não do envelope: um envelope que mande a página para outro servidor é recusado
    if (!pins || !Object.hasOwn(pins, i.name) || String(i.baseUrl).replace(/\/$/, "") !== pins[i.name]) throw new Error("envelope aponta " + i.name + " para outro endereço");
    if (!validAccessCaps(i.caps, request.preset)) throw new Error("envelope traz permissões fora do preset " + request.preset);
  }
  return grant;
}

/** Aceita o texto colado (ravi-envelope:v1:...), JSON cru ou o HTML da rota /_link/<código>. */
export function parseEnvelopeText(text) {
  let t = String(text || "").trim();
  if (t.startsWith("<")) {
    const doc = new DOMParser().parseFromString(t, "text/html");
    const el = doc.getElementById("ravi-connect-envelope");
    if (!el) return null;
    t = el.textContent.trim();
  }
  if (t.startsWith(ENVELOPE_PREFIX)) t = dec.decode(unb64u(t.slice(ENVELOPE_PREFIX.length)));
  try {
    const env = JSON.parse(t);
    return env && env.v === 1 && env.epk && env.iv && env.ct ? env : null;
  } catch {
    return null;
  }
}

/** Abre o envelope com a chave do pedido dele (pelo hash) e guarda só o envelope (ainda selado). */
export async function acceptEnvelope(text, pins) {
  const env = parseEnvelopeText(text);
  if (!env) throw new Error("texto não é um envelope ravi-connect");
  const pending = typeof env.h === "string" ? await dbGet("p:" + env.h) : null;
  if (!pending || Date.now() - pending.request.iat > PENDING_MAX_MS) throw new Error("não há pedido pendente deste envelope neste navegador (ou passou de 15 minutos)");
  const grant = await openEnvelope(env, pending.privateKey, pending.request, pending.hash, pins); // prova que é para esta chave
  const links = (await dbGet("links")) || [];
  links.push({ hash: pending.hash, request: pending.request, privateKey: pending.privateKey, envelope: env, at: Date.now() });
  // descarta vínculos antigos que não são mais o mais novo de nenhuma instalação. "Mais novo" é o do pedido mais
  // recente (iat), e só no empate o aberto por último: colar de novo um envelope antigo nunca toma o lugar de um novo.
  const newer = (a, b) => a.request.iat > b.request.iat || (a.request.iat === b.request.iat && a.at >= b.at);
  const newest = new Map();
  for (const l of links) for (const n of l.request.installs) if (!newest.has(n) || newer(l, newest.get(n))) newest.set(n, l);
  const keep = links.filter((l) => [...newest.values()].includes(l));
  await dbPut("links", keep);
  // "p:<hash>" fica até vencer: se este envelope era falso, o verdadeiro do mesmo pedido ainda abre e passa a valer
  const cur = await dbGet("pending");
  if (cur && cur.hash === pending.hash) await dbDel("pending");
  return grant.installs.map((i) => i.name);
}

export async function forgetBrowser() {
  await dbClear();
}

/** O que está guardado em repouso (para inspeção e teste): nada de rctx_ em claro. */
export async function storedSummary() {
  const links = (await dbGet("links")) || [];
  const pending = await dbGet("pending");
  const keys = ((await dbKeys()) || []).filter((k) => typeof k === "string" && k.startsWith("p:"));
  const kept = await Promise.all(keys.map((k) => dbGet(k)));
  const text = JSON.stringify({ links: links.map((l) => ({ request: l.request, envelope: l.envelope })), pending: pending && { request: pending.request, text: pending.text }, kept: kept.map((p) => p && { request: p.request, text: p.text }) });
  return { links: links.length, pending: !!pending, keptRequests: keys.length, keysExtractable: links.some((l) => l.privateKey.extractable) || kept.some((p) => p && p.privateKey.extractable), hasRctx: text.includes("rctx_") };
}

// ---------- erros ----------
export class ConnectError extends Error {
  constructor(state, message, status, code) {
    super(message);
    this.state = state; // "offline" | "reconnect" | "error"
    this.status = status;
    this.code = code;
  }
}
async function errorCode(res) {
  try {
    const j = await res.clone().json();
    return (j && j.error && j.error.code) || (j && j.code) || null;
  } catch {
    return null;
  }
}

// ---------- uma instalação ligada ----------
function makeInstallation(conn, grantInst) {
  const link = { key: grantInst.linkKey, expiresAt: grantInst.expiresAt }; // só em memória
  let access = null; // { key, expiresAt } só em memória
  let minting = null;
  let dead = false;
  const inst = {
    name: grantInst.name,
    baseUrl: grantInst.baseUrl.replace(/\/$/, ""),
    linkExpiresAt: grantInst.expiresAt,
    state: "linked",
    mints: 0,
  };
  const setState = (s) => {
    if (inst.state !== s) {
      inst.state = s;
      conn._changed();
    }
  };
  async function mint() {
    inst.mints++;
    let res;
    try {
      res = await fetch(inst.baseUrl + "/api/v1/context/issue", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + link.key },
        // ttl explícito e curto: ttl 0 herdaria os 60 dias do link
        body: JSON.stringify({ cliName: location.host + "-acesso", allow: grantInst.caps.join(","), ttl: conn.options.accessTtl }),
      });
    } catch {
      setState("offline");
      throw new ConnectError("offline", "instalação fora do ar: " + inst.name);
    }
    if (res.status === 401 || res.status === 403) {
      dead = true; // link expirou, foi revogado ou perdeu permissão: só uma nova aprovação resolve
      setState("reconnect");
      throw new ConnectError("reconnect", "aprovação necessária para " + inst.name, res.status, await errorCode(res));
    }
    if (!res.ok) throw new ConnectError("error", "falha ao gerar chave de acesso (" + res.status + ")", res.status, await errorCode(res));
    const j = await res.json();
    access = { key: j.contextKey, expiresAt: Number(j.expiresAt) };
    setState("linked");
    return access.key;
  }
  /** Chave de acesso válida (até 1 hora). Só cria outra perto do fim ou depois de 401 CONTEXT_EXPIRED. */
  inst.key = async function key() {
    if (dead) throw new ConnectError("reconnect", "aprovação necessária para " + inst.name);
    if (access && access.expiresAt - Date.now() > REFRESH_MARGIN_MS) return access.key;
    if (!minting) minting = mint().finally(() => (minting = null));
    return minting;
  };
  /** fetch autenticado. path relativo ao baseUrl ("/api/v1/...") ou URL absoluta do mesmo baseUrl. */
  inst.fetch = async function authFetch(path, init = {}) {
    const url = path.startsWith("http") ? path : inst.baseUrl + path;
    if (!url.startsWith(inst.baseUrl + "/")) throw new Error("URL fora desta instalação");
    for (let attempt = 0; attempt < 2; attempt++) {
      const k = await inst.key();
      const headers = new Headers(init.headers || {});
      headers.set("authorization", "Bearer " + k);
      let res;
      try {
        res = await fetch(url, { ...init, headers });
      } catch (e) {
        if (init.signal && init.signal.aborted) throw e;
        setState("offline");
        throw new ConnectError("offline", "instalação fora do ar: " + inst.name);
      }
      if (inst.state === "offline") setState("linked");
      if (res.status !== 401) return res;
      const code = await errorCode(res);
      if (code === "CONTEXT_EXPIRED" && attempt === 0) {
        access = null; // a chave de acesso venceu: cria outra e tenta uma vez
        continue;
      }
      dead = true; // AUTH_REQUIRED (revogada) ou outra 401: nunca cria outra chave
      access = null;
      setState("reconnect");
      throw new ConnectError("reconnect", "aprovação necessária para " + inst.name, 401, code);
    }
  };
  /** Chama um comando do gateway: call("sessions/list", { limit: "20" }). */
  inst.call = async function call(command, body = {}) {
    const res = await inst.fetch("/api/v1/" + command.replace(/^\/+/, ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new ConnectError("error", (j && j.error && j.error.message) || "erro " + res.status, res.status, j && j.error && j.error.code);
    return j;
  };
  /** Stream SSE de uma sessão do escopo: stream("sessions/<nome>", {}, (evento) => ..., signal). Termina quando a chave expira ou é revogada. */
  inst.stream = async function stream(channel, params, onEvent, signal) {
    const qs = new URLSearchParams(params || {}).toString();
    const res = await inst.fetch("/api/v1/_stream/" + channel + (qs ? "?" + qs : ""), { method: "GET", headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new ConnectError("error", "stream recusado (" + res.status + ")", res.status, await errorCode(res));
    const reader = res.body.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {}
        onEvent(parsed);
      }
    }
  };
  /** Para um SDK: new RaviClient(createHttpTransport({ baseUrl: inst.baseUrl, contextKey: "-", fetch: inst.sdkFetch })); inst.fetch troca o cabeçalho. */
  inst.sdkFetch = (url, init) => inst.fetch(String(url), init);
  /** "Esquecer este navegador": apaga o link e a chave de acesso da memória; este objeto não chama mais nada. */
  inst._forget = () => {
    dead = true;
    link.key = "";
    access = null;
    inst.state = "not-linked";
  };
  return inst;
}

// ---------- conexão (várias instalações) ----------
export function createConnect(options) {
  const opts = {
    installations: {},
    preset: "ver",
    accessTtl: "60m",
    stageB: false,
    chat: {},
    pollMs: 3000,
    title: "Conectar instalações do Ravi",
    labels: {},
    ...options,
  };
  if (!Object.hasOwn(PRESETS, opts.preset)) throw new Error("preset desconhecido: " + opts.preset);
  // installations: { nome: "http://127.0.0.1:<porta>" }. Fixa o endereço de cada instalação (só loopback).
  if (!opts.installations || Array.isArray(opts.installations) || typeof opts.installations !== "object") throw new Error('installations: { nome: "http://127.0.0.1:<porta>" }');
  const pins = {};
  for (const [name, url] of Object.entries(opts.installations)) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error("nome de instalação inválido: " + name);
    if (typeof url !== "string" || !LOOPBACK_RE.test(url.replace(/\/$/, ""))) throw new Error(name + ": endereço só loopback (http://127.0.0.1:<porta>)");
    pins[name] = url.replace(/\/$/, "");
  }
  const names = Object.keys(pins);
  if (!names.length) throw new Error("nenhuma instalação");
  if (!/^([1-9]|[1-5][0-9]|60)m$/.test(opts.accessTtl)) throw new Error("accessTtl deve ser de 1m a 60m");
  const listeners = new Set();
  const conn = {
    options: opts,
    pins,
    installs: new Map(), // name -> instalação ligada
    states: new Map(), // name -> estado
    pending: null,
    _changed() {
      for (const name of names) {
        const i = conn.installs.get(name);
        conn.states.set(name, i ? i.state : conn.pending && conn.pending.request.installs.includes(name) ? "waiting" : "not-linked");
      }
      for (const f of listeners) {
        try {
          f(conn.snapshot());
        } catch {}
      }
    },
  };
  conn.onChange = (f) => (listeners.add(f), () => listeners.delete(f));
  conn.snapshot = () => names.map((name) => ({ name, state: conn.states.get(name) || "not-linked", linkExpiresAt: conn.installs.get(name)?.linkExpiresAt ?? null }));

  /** Abre os envelopes guardados e testa cada instalação (cria uma chave de acesso de 1 hora por instalação). */
  conn.session = async function session() {
    const links = (await dbGet("links")) || [];
    const pending = await dbGet("pending");
    conn.pending = pending && Date.now() - pending.request.iat < PENDING_MAX_MS ? pending : null;
    const fresh = new Map();
    for (const l of [...links].sort((a, b) => a.request.iat - b.request.iat || a.at - b.at)) {
      let grant;
      try {
        grant = await openEnvelope(l.envelope, l.privateKey, l.request, l.hash, pins);
      } catch {
        continue;
      }
      for (const gi of grant.installs) {
        if (!names.includes(gi.name)) continue;
        const old = conn.installs.get(gi.name);
        fresh.set(gi.name, old && old.linkExpiresAt === gi.expiresAt && old.baseUrl === gi.baseUrl.replace(/\/$/, "") ? old : makeInstallation(conn, gi));
      }
    }
    conn.installs = fresh;
    await Promise.all([...fresh.values()].map((i) => i.key().catch(() => {})));
    conn._changed();
    return names.map((name) => {
      const i = fresh.get(name);
      if (i) return i;
      const state = conn.states.get(name);
      const fail = () => Promise.reject(new ConnectError(state === "waiting" ? "waiting" : "reconnect", "instalação não conectada: " + name));
      return { name, baseUrl: null, state, key: fail, fetch: fail, call: fail, stream: fail };
    });
  };

  /** Inicia um pedido para as instalações que não estão ligadas (ou todas, se `all`). */
  conn.connect = async function connect(all = false) {
    const want = names.filter((n) => all || !conn.installs.has(n) || conn.installs.get(n).state === "reconnect");
    if (want.length === 0) return null;
    conn.pending = await createRequest({ installs: want, preset: opts.preset });
    conn._changed();
    return conn.pending;
  };
  conn.cancel = async () => {
    if (conn.pending) await dbDel("p:" + conn.pending.hash);
    await dbDel("pending");
    conn.pending = null;
    conn._changed();
  };
  conn.accept = async (text) => {
    const got = await acceptEnvelope(text, pins);
    conn.pending = null;
    await conn.session();
    return got;
  };
  conn.forget = async () => {
    for (const i of conn.installs.values()) i._forget();
    await forgetBrowser();
    conn.installs = new Map();
    conn.pending = null;
    conn._changed();
  };
  /** Etapa B: busca o envelope publicado na rota privada /_link/<código> do próprio host. */
  conn.pollOnce = async () => {
    if (!conn.pending) return false;
    if (Date.now() - conn.pending.request.iat > PENDING_MAX_MS) return false;
    let res;
    try {
      res = await fetch("/_link/" + conn.pending.code, { cache: "no-store", credentials: "same-origin" });
    } catch {
      return false;
    }
    if (!res.ok) return false;
    const text = await res.text();
    if (!parseEnvelopeText(text)) return false;
    await conn.accept(text);
    return true;
  };
  /** Links do chat (etapa B). O texto do pedido não tem segredo: chave pública, nonce e campos. */
  conn.chatLinks = () => {
    if (!conn.pending) return {};
    const out = {};
    if (opts.chat.whatsapp) out.whatsapp = opts.chat.whatsapp.split("?")[0] + "?text=" + encodeURIComponent(conn.pending.text);
    if (opts.chat.slack) out.slack = opts.chat.slack;
    return out;
  };
  conn.mount = (root) => mountCard(conn, root);
  return conn;
}

// ---------- cartão acessível ----------
const STATE_TEXT = {
  "not-linked": "não conectada",
  waiting: "aguardando aprovação",
  linked: "conectada",
  offline: "offline (sem resposta; confira o túnel ou o daemon)",
  reconnect: "precisa reconectar",
};
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString("pt-BR") : "");

function mountCard(conn, root) {
  const opts = conn.options;
  const uid = "rc" + Math.random().toString(36).slice(2, 8);
  let message = "";
  let envDraft = "";
  let forgetArmed = false;
  let pollTimer = null;
  const style = el("style", {}, `
.ravi-connect{border:1px solid var(--color-border,#c9ced6);border-radius:12px;padding:16px;max-width:560px;font:inherit;color:var(--color-text-primary,#17202a);background:var(--color-surface,#fff)}
.ravi-connect h2{font-size:1.1rem;margin:0 0 8px}
.ravi-connect ul{list-style:none;padding:0;margin:8px 0}
.ravi-connect li{padding:4px 0}
.ravi-connect .rc-phrase{font-size:1.4rem;font-weight:700;letter-spacing:.04em;margin:8px 0}
.ravi-connect textarea{width:100%;box-sizing:border-box;min-height:4.5em;font-family:ui-monospace,monospace;font-size:.8rem}
.ravi-connect button,.ravi-connect a.rc-btn{margin:4px 8px 4px 0;padding:8px 12px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;font:inherit;text-decoration:none;display:inline-block}
.ravi-connect button:focus-visible,.ravi-connect a:focus-visible,.ravi-connect textarea:focus-visible{outline:3px solid var(--color-focus,#2563eb);outline-offset:2px}
.ravi-connect .rc-hint{font-size:.9rem;opacity:.85}`);
  const card = el("section", { class: "ravi-connect", "aria-labelledby": uid + "-t" });
  root.replaceChildren(style, card);

  const say = (m) => {
    message = m;
    render();
  };
  async function copyRequest() {
    const t = conn.pending && conn.pending.text;
    if (!t) return false;
    try {
      await navigator.clipboard.writeText(t);
      say("Pedido copiado. Cole na conversa com o seu agente.");
      return true;
    } catch {
      const ta = card.querySelector("textarea[data-rc=request]");
      if (ta) {
        ta.focus();
        ta.select();
      }
      say("Não deu para copiar sozinho: o pedido está selecionado, copie com Ctrl+C.");
      return false;
    }
  }
  function startPolling() {
    stopPolling();
    if (!opts.stageB || !conn.pending) return;
    pollTimer = setInterval(async () => {
      try {
        if (await conn.pollOnce()) {
          stopPolling();
          envDraft = "";
          say("Conectado.");
        } else if (conn.pending && Date.now() - conn.pending.request.iat > PENDING_MAX_MS) {
          stopPolling();
          say("O pedido expirou (15 minutos). Clique em Conectar de novo.");
        }
      } catch (e) {
        stopPolling();
        say("O envelope publicado não abriu neste navegador: " + e.message);
      }
    }, opts.pollMs);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function render() {
    const snap = conn.snapshot();
    const children = [el("h2", { id: uid + "-t" }, opts.title)];
    children.push(el("p", { role: "status", "aria-live": "polite", "data-rc": "status" }, message || summary(snap)));
    children.push(
      el("ul", { "aria-label": "Instalações" }, ...snap.map((s) => el("li", { "data-rc-install": s.name, "data-rc-state": s.state }, `${(Object.hasOwn(opts.labels, s.name) && opts.labels[s.name]) || s.name}: ${STATE_TEXT[s.state] || s.state}` + (s.state === "linked" && s.linkExpiresAt ? ` (até ${fmtDate(s.linkExpiresAt)})` : "")))),
    );
    const needs = snap.some((s) => s.state === "not-linked" || s.state === "reconnect");
    if (conn.pending) {
      const p = conn.pending;
      children.push(el("p", {}, "Frase de conferência (o agente vai mostrar a mesma):"));
      children.push(el("p", { class: "rc-phrase", "data-rc": "phrase" }, p.phrase));
      children.push(el("label", { for: uid + "-req" }, "Pedido (não tem segredo; mande para o seu agente):"));
      children.push(el("textarea", { id: uid + "-req", readonly: true, "data-rc": "request", rows: 3 }, p.text));
      const actions = [el("button", { type: "button", "data-rc": "copy", on: { click: copyRequest } }, "Copiar pedido")];
      if (opts.stageB) {
        const links = conn.chatLinks();
        if (links.whatsapp) actions.push(el("a", { class: "rc-btn", href: links.whatsapp, target: "_blank", rel: "noopener noreferrer", "data-rc": "whatsapp" }, "Abrir no WhatsApp"));
        if (links.slack) actions.push(el("a", { class: "rc-btn", href: links.slack, target: "_blank", rel: "noopener noreferrer", "data-rc": "slack", on: { click: () => copyRequest() } }, "Copiar e abrir o Slack"));
      }
      children.push(el("div", {}, ...actions));
      children.push(el("p", { class: "rc-hint" }, opts.stageB ? "Depois do seu \"sim\" com a frase, esta página recebe a conexão sozinha. Se preferir, cole o envelope abaixo." : "Depois do seu \"sim\" com a frase, o agente responde com um envelope. Cole o envelope abaixo e clique em \"Usar este envelope\"."));
      children.push(el("label", { for: uid + "-env" }, "Envelope devolvido pelo agente:"));
      // o cartão é redesenhado a cada mudança de estado: o texto já colado fica em envDraft para não se perder
      const envBox = el("textarea", { id: uid + "-env", "data-rc": "envelope", rows: 3, on: { input: () => (envDraft = envBox.value) } });
      envBox.value = envDraft;
      children.push(envBox);
      children.push(
        el(
          "div",
          {},
          el("button", { type: "button", "data-rc": "paste", on: { click: async () => {
            try {
              const names = await conn.accept(envBox.value);
              envDraft = "";
              stopPolling();
              say("Conectado: " + names.join(", ") + ".");
            } catch (e) {
              say("Envelope recusado: " + e.message);
            }
          } } }, "Usar este envelope"),
          el("button", { type: "button", "data-rc": "cancel", on: { click: async () => ((envDraft = ""), stopPolling(), await conn.cancel(), say("Pedido cancelado.")) } }, "Cancelar pedido"),
        ),
      );
    } else if (needs) {
      children.push(el("button", { type: "button", "data-rc": "connect", on: { click: async () => {
        envDraft = "";
        await conn.connect();
        say("Pedido criado. Mande para o seu agente e confira a frase.");
      } } }, "Conectar"));
    }
    if (snap.some((s) => s.state !== "not-linked") || conn.pending) {
      children.push(el("button", { type: "button", "data-rc": "forget", on: { click: async () => {
        if (!forgetArmed) {
          forgetArmed = true;
          return say("Clique de novo em \"Esquecer este navegador\" para confirmar. Para cortar o acesso de verdade, peça ao agente: desconectar <frase>.");
        }
        forgetArmed = false;
        envDraft = "";
        stopPolling();
        await conn.forget();
        say("Este navegador esqueceu a conexão.");
      } } }, "Esquecer este navegador"));
    }
    card.replaceChildren(...children);
  }
  function summary(snap) {
    if (conn.pending) return "Aguardando a sua aprovação no chat.";
    if (snap.every((s) => s.state === "linked")) return "Tudo conectado.";
    if (snap.some((s) => s.state === "reconnect")) return "Alguma instalação precisa de nova aprovação.";
    if (snap.some((s) => s.state === "offline")) return "Alguma instalação está offline.";
    return "Nenhuma instalação conectada neste navegador.";
  }
  conn.onChange(() => {
    message = "";
    if (conn.pending && !pollTimer) startPolling();
    if (!conn.pending) stopPolling();
    render();
  });
  render();
  if (conn.pending) startPolling();
  return { render, copyRequest, stop: stopPolling };
}
