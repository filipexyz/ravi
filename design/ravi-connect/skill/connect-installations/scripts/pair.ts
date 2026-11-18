#!/usr/bin/env bun
// pair.ts: lado do agente do protocolo ravi-connect v1. Só Bun e WebCrypto.
//
//   bun pair.ts check   <pedido>             valida, consome o nonce, imprime campos, frase e a mensagem de confirmação
//   bun pair.ts approve <pedido> --phrase <FRASE> [--out-dir <pasta vazia>]
//                                             exige o check no mesmo ledger, a mesma frase (frase errada cancela o
//                                             pedido) e nenhum outro pedido conferido esperando; registra cada
//                                             instalação ANTES de emitir, emite uma chave de link por instalação,
//                                             sela para a chave da página e imprime o envelope
//   bun pair.ts cancel                        cancela todo pedido conferido que ainda espera o "sim"
//   bun pair.ts list                          vínculos registrados (sem chaves)
//   bun pair.ts disconnect <frase|origem> [--install <nome>]   revoga só os contextos que este helper registrou
//   bun pair.ts status [--probe]              configuração, arquivos 0600; com --probe: validade e capacidades das
//                                             emissoras e se a página alcança cada baseUrl com CORS (o túnel)
//   bun pair.ts caps <instalação>             o --allow que a chave emissora daquela instalação precisa ter
//
// <pedido> pode ser o texto "ravi-connect:v1:..." ou "-" para ler da entrada padrão.
// Configuração: $RAVI_CONNECT_CONFIG ou ~/.ravi/pairing/config.json. Ledger: ao lado (ledger.json, 0600).
// Nunca imprime uma chave rctx_. Saída: texto em português; --json para máquina.
// Exit: 0 ok, 1 erro de execução, 2 uso/config inválida, 3 recusado pela política.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REQUEST_PREFIX = "ravi-connect:v1:";
const ENVELOPE_PREFIX = "ravi-envelope:v1:";
const MAX_AGE_MS = 10 * 60 * 1000; // idade máxima do pedido no check, e do check até o approve
const MAX_APPROVE_AGE_MS = 15 * 60 * 1000; // idade máxima do pedido (iat) no approve
const LOCK_STALE_MS = 30 * 1000;
const MAX_SKEW_MS = 60 * 1000;
const MAX_LINK_DAYS = 60;
// Sem view:system:events: aquele stream é o barramento inteiro (todas as conversas de todos os agentes).
// O que cada chave enxerga vem do escopo da instalação na config: access:session:<nome> e view:agent:<id>,
// nomes exatos escolhidos pelo dono, nunca curinga.
const PRESETS: Record<string, { caps: string[]; label: string }> = {
  ver: {
    caps: ["read:context:whoami", "read:sessions:list", "read:sessions:info", "read:agents:list"],
    label: "ver (só leitura, só das sessões e agentes listados abaixo; inclui ver ao vivo o que acontece nessas sessões: texto das conversas, chamadas de ferramentas e seus resultados, pedidos de aprovação)",
  },
  conversar: {
    caps: ["read:context:whoami", "read:sessions:list", "read:sessions:info", "read:agents:list", "mutate:sessions:send"],
    label: "conversar (tudo do ver + mandar mensagens, em seu nome, para as sessões listadas abaixo)",
  },
};
const SCOPE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
type Scope = { sessions: string[]; agents: string[] };
const scopeCaps = (s: Scope) => [...s.sessions.map((n) => `access:session:${n}`), ...s.agents.map((a) => `view:agent:${a}`)];
/** Capacidades da chave de acesso de 1 hora (vão no envelope; a página pede exatamente estas). */
const accessCaps = (inst: Install, preset: string) => [...PRESETS[preset].caps, ...scopeCaps(inst.scope)];
/** Capacidades da chave de link (60 dias): as de acesso + issue. */
const linkCaps = (inst: Install, preset: string) => [LINK_EXTRA_CAP, ...accessCaps(inst, preset)];
const LINK_EXTRA_CAP = "mutate:context:issue"; // a página cria as próprias chaves de acesso de 1 hora
const ISSUER_INFO_CAP = "read:context:info"; // só na emissora: o helper confere se um link já foi revogado (não mostra chave)
const FORBIDDEN = /^admin:|\*|^mutate:context:(revoke|prune|authorize)|^mutate:(agents|routes|settings|instances):/;
const WORDS = "abacate abelha abrigo acucar agulha alface alegria algodao ameixa amora ancora anel anzol arara areia arroz aviao azeite bala balde baleia bambu banana banco barco batata bengala bicho bigode bola bolsa bombom bota brisa burro cabana cabra cacau cadeira cafe caju calor cama camelo caneca caneta canoa capim caqui carta casaco castelo cavalo cebola cedro cenoura cereja chave chuva cidade cinema cipo coco coelho cofre cometa concha coral corda coruja cravo cristal dado dedal degrau deserto diamante disco doce dragao duna elefante enxada escada espelho estrela faca farol fazenda feijao ferro figo fita flauta floresta fogao folha formiga fruta fumaca funil gaivota galho galinha garfo gato gaveta geada gelo girafa girassol goiaba gota grama grilo guarda harpa horta ilha jabuti janela jarra jardim jasmim jangada jipe joia laco lagoa lagarto lama lampada lanterna lapis laranja leao leite lenco lima limao livro lobo lontra lua luva macaco madeira manga mapa mar martelo mel melancia mesa milho mochila moeda moinho montanha morango mosca navio neve ninho noz nuvem oceano oliva onda orvalho ostra ovelha palha panela papel pato pedra peixe pena pera perola piano pipa pirata planeta pomar ponte porta prato praia queijo quiabo raposa regua relogio remo rede rio rocha roda rosa sabao sapato sapo selva semente serra sino sol sorvete tambor tapete tatu teia telhado tesoura tigre tijolo tinta toalha tomate torre trator trem trigo trovao tucano tulipa uva vaca vagalume vale vaso vela vento verao vidro vila viola vulcao xadrez zebra abobora bandeira biscoito bussola cachoeira canela cigarra colmeia esquilo foguete gengibre iogurte mandioca pinguim".split(" ");

// ---------- erros e saída ----------
class Fail extends Error {
  // extra: maybeIssued (a chave pode ter sido criada do outro lado), issued (criada, mas fora do pedido)
  constructor(public exit: number, public code: string, message: string, public extra: { maybeIssued?: boolean; issued?: { contextId: string; parentContextId: string | null; expiresAt: number } } = {}) {
    super(message);
  }
}
const refuse = (code: string, msg: string) => new Fail(3, code, msg);
const usage = (code: string, msg: string) => new Fail(2, code, msg);
let asJson = false;
function emit(obj: Record<string, unknown>, text: string) {
  const out = asJson ? JSON.stringify(obj, null, 2) : text;
  if (out.includes("rctx_")) throw new Fail(1, "LEAK_GUARD", "saída continha uma chave; nada foi impresso");
  console.log(out);
}

// ---------- base64url, hash, frase ----------
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as Uint8Array).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const subtle = globalThis.crypto.subtle;
const sha256 = async (s: string) => new Uint8Array(await subtle.digest("SHA-256", enc.encode(s)));
const phraseFromHash = (h: Uint8Array) => [WORDS[h[0]], WORDS[h[1]], WORDS[h[2]]].join("-").toUpperCase();
const codeFromHash = (h: Uint8Array) => Array.from(h.slice(3, 11), (b) => b.toString(16).padStart(2, "0")).join("");
// acento e cedilha do teclado do celular não importam: RELÓGIO = RELOGIO, "a - b" = "A-B".
// No approve, um "sim" na frente também é aceito ("sim cedro farol uva"); "sim" não é uma das 256 palavras.
const normPhrase = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");

// ---------- caminhos e arquivos 0600 ----------
const HOME = process.env.HOME ?? "";
const expand = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p);
function readSecretFile(path: string, what: string): string {
  const p = expand(path);
  if (!existsSync(p)) throw new Fail(1, "KEY_FILE_MISSING", `${what}: arquivo não existe (${path})`);
  const mode = statSync(p).mode & 0o777;
  if (mode & 0o077) throw refuse("KEY_FILE_MODE", `${what}: ${path} tem modo ${mode.toString(8)}; use chmod 600`);
  const v = readFileSync(p, "utf8").trim();
  if (!/^rctx_[A-Za-z0-9_-]+$/.test(v)) throw new Fail(1, "KEY_FILE_INVALID", `${what}: ${path} não contém uma chave de contexto`);
  return v;
}

// ---------- configuração ----------
type Reach = { type: "http"; url: string; issuerKeyFile: string } | { type: "ssh"; alias: string; issuerKeyFile: string; ravi?: string };
type Revoke = { via: "http" | "cli" | "manual"; keyFile?: string };
type Install = { baseUrl: string; reach: Reach; revoke?: Revoke; scope: Scope };
type Config = { allowedOrigins: string[]; linkTtlDays: number; installations: Record<string, Install>; chat?: Record<string, string>; ledger?: string };
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const configPath = () => expand(process.env.RAVI_CONNECT_CONFIG || "~/.ravi/pairing/config.json");
function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) throw usage("CONFIG_MISSING", `configuração não encontrada: ${p} (veja references/instalacao.md)`);
  const c = JSON.parse(readFileSync(p, "utf8")) as Config;
  if (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.length === 0 || !c.allowedOrigins.every((o) => ORIGIN_RE.test(o)))
    throw usage("CONFIG_ORIGINS", "allowedOrigins: lista de origens https://<host> exatas, sem barra, porta ou caminho");
  if (!Number.isInteger(c.linkTtlDays) || c.linkTtlDays <= 0) throw refuse("TTL_ZERO", "linkTtlDays precisa ser um inteiro maior que zero (ttl 0 herda a validade inteira do pai)");
  if (c.linkTtlDays > MAX_LINK_DAYS) throw refuse("TTL_TOO_LONG", `linkTtlDays acima de ${MAX_LINK_DAYS} dias não é permitido`);
  if (!c.installations || typeof c.installations !== "object" || Object.keys(c.installations).length === 0) throw usage("CONFIG_INSTALLS", "installations vazio");
  for (const [name, i] of Object.entries(c.installations)) {
    if (!NAME_RE.test(name)) throw usage("CONFIG_INSTALLS", `nome de instalação inválido: ${name}`);
    if (!LOOPBACK_RE.test(i.baseUrl ?? "")) throw usage("CONFIG_INSTALLS", `${name}.baseUrl: só loopback (http://127.0.0.1:<porta>, a porta local ou a do túnel)`);
    const sc = i.scope as Scope | undefined;
    if (!sc || typeof sc !== "object" || Object.keys(sc).sort().join(",") !== "agents,sessions" || !Array.isArray(sc.sessions) || !Array.isArray(sc.agents))
      throw usage("CONFIG_SCOPE", `${name}.scope: { "sessions": [nomes], "agents": [ids] } (pode ser lista vazia)`);
    for (const n of [...sc.sessions, ...sc.agents]) if (typeof n !== "string" || !SCOPE_NAME_RE.test(n) || n.includes("rctx_")) throw usage("CONFIG_SCOPE", `${name}.scope: nome inválido ou curinga: ${String(n).slice(0, 40).replace(/rctx_/g, "rctx-")}`);
    if (sc.sessions.length + sc.agents.length > 40) throw usage("CONFIG_SCOPE", `${name}.scope: no máximo 40 nomes`);
    if (i.reach?.type === "http") {
      if (!LOOPBACK_RE.test(i.reach.url ?? "")) throw usage("CONFIG_INSTALLS", `${name}.reach.url: só loopback (http://127.0.0.1:<porta>)`);
    } else if (i.reach?.type === "ssh") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(i.reach.alias ?? "")) throw usage("CONFIG_INSTALLS", `${name}.reach.alias inválido`);
      if (i.reach.ravi && !/^[A-Za-z0-9_./~-]+$/.test(i.reach.ravi)) throw usage("CONFIG_INSTALLS", `${name}.reach.ravi inválido`);
    } else throw usage("CONFIG_INSTALLS", `${name}.reach.type: http ou ssh`);
    if (!i.reach.issuerKeyFile || !/^[A-Za-z0-9_./~-]+$/.test(i.reach.issuerKeyFile)) throw usage("CONFIG_INSTALLS", `${name}.reach.issuerKeyFile inválido`);
    if (i.revoke && !["http", "cli", "manual"].includes(i.revoke.via)) throw usage("CONFIG_INSTALLS", `${name}.revoke.via: http, cli ou manual`);
    if (i.revoke?.via === "http" && (i.reach.type !== "http" || !i.revoke.keyFile)) throw usage("CONFIG_INSTALLS", `${name}.revoke via http exige reach http e keyFile`);
    if (i.revoke?.keyFile && !/^[A-Za-z0-9_./~-]+$/.test(i.revoke.keyFile)) throw usage("CONFIG_INSTALLS", `${name}.revoke.keyFile inválido`);
  }
  return c;
}

// ---------- ledger (0600, com trava) ----------
type NonceEntry = { hash: string; origin: string; preset: string; installs: string[]; phrase: string; iat: number; checkedAt: number; state: "checked" | "approving" | "approved" | "failed" | "cancelled" };
// pending: registrada antes de emitir; se continua pending, a emissão foi interrompida e pode ter criado o contexto lá
type LinkInstall = { name: string; contextId: string; cliName: string; parentContextId: string | null; expiresAt: number; revokedAt?: number; pending?: boolean };
type LinkEntry = { phrase: string; origin: string; hash: string; nonce: string; preset: string; createdAt: number; installs: LinkInstall[] };
type Ledger = { v: 1; nonces: Record<string, NonceEntry>; links: LinkEntry[] };
const ledgerPath = (c: Config) => expand(c.ledger || join(dirname(configPath()), "ledger.json"));
function withLedger<T>(c: Config, fn: (l: Ledger) => T): T {
  const p = ledgerPath(c);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const lock = p + ".lock";
  let fd = -1;
  for (let i = 0; i < 100 && fd < 0; i++) {
    try {
      fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
    } catch {
      if (breakStaleLock(lock)) continue;
      if (i === 99) throw new Fail(1, "LEDGER_LOCKED", `ledger travado por outro processo vivo: ${lock}`);
      Bun.sleepSync(50);
    }
  }
  if (fd < 0) throw new Fail(1, "LEDGER_LOCKED", `não consegui a trava do ledger: ${lock}`);
  try {
    const l: Ledger = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { v: 1, nonces: {}, links: [] };
    const r = fn(l);
    // arquivo temporário novo (wx): nunca segue um link simbólico deixado no lugar
    const tmp = `${p}.${process.pid}.${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}.tmp`;
    const tfd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(tfd, JSON.stringify(l, null, 2));
    } finally {
      closeSync(tfd);
    }
    renameSync(tmp, p);
    return r;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Trava largada por processo morto (pid que não existe mais) ou mais velha que 30 s: remove. */
function breakStaleLock(lock: string): boolean {
  try {
    const [pidS, atS] = readFileSync(lock, "utf8").trim().split(" ");
    const pid = Number(pidS);
    const at = Number(atS);
    let alive = Number.isInteger(pid) && pid > 0;
    if (alive) {
      try {
        process.kill(pid, 0);
      } catch (e: any) {
        alive = e?.code === "EPERM";
      }
    }
    const old = !Number.isFinite(at) || Date.now() - at > LOCK_STALE_MS;
    // arquivo vazio: o dono acabou de criar e ainda não escreveu; só quebra se for velho
    if ((pidS && !alive) || (atS && old) || (!atS && statSync(lock).mtimeMs < Date.now() - LOCK_STALE_MS)) {
      unlinkSync(lock);
      return true;
    }
  } catch {}
  return false;
}

// ---------- pedido ----------
type Req = { v: 1; kind: "ravi-connect"; origin: string; pub: { x: string; y: string }; preset: string; installs: string[]; nonce: string; iat: number };
const canonical = (r: Req) => JSON.stringify({ v: r.v, kind: r.kind, origin: r.origin, pub: { x: r.pub.x, y: r.pub.y }, preset: r.preset, installs: r.installs, nonce: r.nonce, iat: r.iat });
async function readArg(arg: string | undefined): Promise<string> {
  if (!arg) throw usage("USAGE", "faltou o pedido (texto ravi-connect:v1:... ou - para stdin)");
  return arg === "-" ? (await Bun.stdin.text()).trim() : arg.trim();
}
async function parseRequest(text: string, c: Config, checkAge = true) {
  const t = text.replace(/\s+/g, "");
  if (!t.startsWith(REQUEST_PREFIX)) throw refuse("NOT_A_REQUEST", "o texto não é um pedido ravi-connect:v1");
  const body = t.slice(REQUEST_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{20,2000}$/.test(body)) throw refuse("SCHEMA", "pedido malformado");
  const raw = Buffer.from(body, "base64url").toString("utf8");
  let r: Req;
  try {
    r = JSON.parse(raw);
  } catch {
    throw refuse("SCHEMA", "pedido não é JSON");
  }
  const keys = r && typeof r === "object" ? Object.keys(r).sort().join(",") : "";
  if (keys !== "iat,installs,kind,nonce,origin,preset,pub,v") throw refuse("SCHEMA", "pedido com campos a mais ou a menos");
  if (r.v !== 1 || r.kind !== "ravi-connect") throw refuse("SCHEMA", "versão ou tipo desconhecido");
  if (typeof r.origin !== "string" || !ORIGIN_RE.test(r.origin)) throw refuse("SCHEMA", "origem malformada");
  if (!r.pub || Object.keys(r.pub).sort().join(",") !== "x,y" || !/^[A-Za-z0-9_-]{43}$/.test(r.pub.x) || !/^[A-Za-z0-9_-]{43}$/.test(r.pub.y)) throw refuse("SCHEMA", "chave pública malformada");
  if (typeof r.preset !== "string" || !Object.hasOwn(PRESETS, r.preset)) throw refuse("UNKNOWN_PRESET", `preset desconhecido; só ${Object.keys(PRESETS).join(" ou ")}`);
  if (!Array.isArray(r.installs) || r.installs.length < 1 || r.installs.length > 8 || !r.installs.every((n) => typeof n === "string" && NAME_RE.test(n)) || new Set(r.installs).size !== r.installs.length)
    throw refuse("SCHEMA", "lista de instalações malformada");
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(r.nonce)) throw refuse("SCHEMA", "nonce malformado");
  if (!Number.isSafeInteger(r.iat)) throw refuse("SCHEMA", "iat malformado");
  if (canonical(r) !== raw) throw refuse("SCHEMA", "pedido fora da forma canônica");
  try {
    await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: r.pub.x, y: r.pub.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw refuse("SCHEMA", "chave pública não é um ponto P-256 válido");
  }
  // política
  if (!c.allowedOrigins.includes(r.origin)) throw refuse("ORIGIN_NOT_ALLOWED", `origem fora da lista do dono: ${r.origin}`);
  const unknown = r.installs.filter((n) => !Object.hasOwn(c.installations, n));
  if (unknown.length) throw refuse("UNKNOWN_INSTALL", `instalação desconhecida: ${unknown.join(", ")}`);
  const age = Date.now() - r.iat;
  if (checkAge && age > MAX_AGE_MS) throw refuse("REQUEST_TOO_OLD", `pedido com ${Math.round(age / 60000)} minutos; o limite é 10. Peça para clicar em Conectar de novo`);
  if (age < -MAX_SKEW_MS) throw refuse("REQUEST_FROM_FUTURE", "pedido com horário no futuro");
  for (const n of r.installs) for (const cap of linkCaps(c.installations[n], r.preset)) if (cap !== LINK_EXTRA_CAP && FORBIDDEN.test(cap)) throw new Fail(1, "PRESET_BROKEN", `capacidade proibida no preset ou escopo: ${cap}`);
  const h = await sha256(raw);
  return { r, hash: b64u(h), phrase: phraseFromHash(h), code: codeFromHash(h) };
}
function confirmation(p: { r: Req; phrase: string }, c: Config) {
  const until = new Date(Date.now() + c.linkTtlDays * 86400000).toISOString().slice(0, 10);
  return [
    "Pedido de conexão",
    `Página: ${p.r.origin}`,
    `Instalações: ${p.r.installs.join(", ")}`,
    `Permissões: ${PRESETS[p.r.preset].label}`,
    ...p.r.installs.map((n) => {
      const sc = c.installations[n].scope;
      return `- ${n}: sessões ${sc.sessions.length ? sc.sessions.join(", ") : "(nenhuma)"}; agentes ${sc.agents.length ? sc.agents.join(", ") : "(só o próprio)"}`;
    }),
    `Validade: ${c.linkTtlDays} dias (até ${until}), ou menos se a chave emissora de uma instalação vencer antes`,
    `Frase: ${p.phrase}`,
    `A frase é igual à que aparece na página? Para aprovar, responda "sim ${p.phrase}". Para recusar, "não".`,
  ].join("\n");
}

// ---------- emissão por instalação ----------
type Issued = { contextId: string; contextKey: string; expiresAt: number; parentContextId: string | null; capabilities: string[] };
const capString = (c: any) => (typeof c === "string" ? c : `${c.permission}:${c.objectType}:${c.objectId}`);
const HTTP_TIMEOUT_MS = 15 * 1000;
const SSH_TIMEOUT_MS = Number(process.env.RAVI_CONNECT_SSH_TIMEOUT_MS) > 0 ? Number(process.env.RAVI_CONNECT_SSH_TIMEOUT_MS) : 45 * 1000; // limite total de cada ssh
async function gatewayCall(url: string, key: string, command: string, body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${url}/api/v1/${command}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e: any) {
    // tempo esgotado: o gateway pode ter recebido e executado o comando
    const timeout = e?.name === "TimeoutError";
    throw new Fail(1, "GATEWAY_UNREACHABLE", `${command}: sem resposta de ${url} (${timeout ? "tempo esgotado" : "daemon parado ou porta errada"})`, { maybeIssued: timeout });
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Fail(1, j?.error?.code || `HTTP_${res.status}`, `${command}: ${res.status} ${j?.error?.code ?? ""} ${j?.error?.message ?? ""}`.trim());
  return j;
}
/** O CLI imprime um objeto JSON (com --json, indentado). Procura, do fim para o começo, o objeto de nível superior
 * que tem os campos esperados (ou é um erro do CLI), sem tropeçar em linhas de aviso ou de log antes ou depois dele. */
type Want = (j: any) => boolean;
const isCliError: Want = (j) => j.success === false && !!j.error && typeof j.error === "object";
const WANT = {
  issue: ((j) => typeof j.contextKey === "string" && typeof j.contextId === "string") as Want,
  info: ((j) => typeof j.contextId === "string" && typeof j.status === "string") as Want,
  whoami: ((j) => Array.isArray(j.capabilities)) as Want,
  revoke: ((j) => j.revokedAt !== undefined || (!!j.context && typeof j.context === "object")) as Want,
};
function extractJson(out: string, want: Want): any {
  const lines = out.split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!lines[start].startsWith("{")) continue;
    for (let end = lines.length - 1; end >= start; end--) {
      if (!lines[end].trimEnd().endsWith("}")) continue;
      try {
        const j = JSON.parse(lines.slice(start, end + 1).join("\n"));
        if (j && typeof j === "object" && (want(j) || isCliError(j))) return j;
      } catch {}
    }
  }
  return null;
}
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const remotePath = (p: string) => (p.startsWith("~/") ? `"$HOME"/${sq(p.slice(2))}` : sq(p));
// O `ravi` instalado é um wrapper que chama `bun`; o shell não interativo do ssh costuma não ter ~/.bun/bin no PATH.
const REMOTE_PATH = 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; ';
async function sshRun(alias: string, remote: string, want: Want): Promise<any> {
  // -a: sem agent forwarding; -x/ForwardX11=no: sem X11; ClearAllForwardings: não abre os LocalForward do ssh_config;
  // ControlMaster=no/ControlPath=none: nunca usa nem deixa uma conexão mestre segurando a saída;
  // BatchMode: nunca pede senha; ConnectTimeout + limite total: uma VPS muda não trava o approve
  const p = Bun.spawn(["ssh", "-a", "-x", "-T", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", alias, REMOTE_PATH + remote], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const bufs = ["", ""];
  const readers = [p.stdout.getReader(), p.stderr.getReader()];
  const pumps = readers.map(async (r, k) => {
    const d = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        bufs[k] += d.decode(value, { stream: true });
      }
    } catch {}
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((res) => (timer = setTimeout(res, SSH_TIMEOUT_MS, "timeout")));
  let drained = false;
  Promise.all(pumps).then(() => (drained = true));
  // fim: o ssh saiu e as saídas fecharam, ou já chegou a resposta, ou passaram 2 s
  // (um processo filho que segura a saída aberta não trava o approve)
  const finished = p.exited.then(async () => {
    for (let t = 0; t < 2000 && !drained && !extractJson(bufs[0], want); t += 50) await Bun.sleep(50);
    return "done" as const;
  });
  const how = await Promise.race([finished, limit]);
  clearTimeout(timer);
  if (how === "timeout") p.kill("SIGKILL");
  for (const r of readers) r.cancel().catch(() => {});
  if (how === "timeout") throw new Fail(1, "SSH_TIMEOUT", `ssh ${alias}: sem resposta em ${SSH_TIMEOUT_MS / 1000} s`, { maybeIssued: true });
  const code = p.exitCode;
  const j = extractJson(bufs[0], want);
  if (code !== 0 || !j || isCliError(j)) {
    const e = j?.error;
    // 255 sem resposta: o ssh nem conectou. Outra saída sem JSON: o comando pode ter rodado lá.
    throw new Fail(1, e?.code || "SSH_FAILED", `ssh ${alias}: exit ${code} ${e?.code ?? ""} ${(e?.message ?? bufs[1].replace(/rctx_[A-Za-z0-9_-]+/g, "[chave]")).slice(0, 300)}`.trim(), { maybeIssued: !j && code !== 255 });
  }
  return j;
}
/** Trecho de shell que confere o modo do arquivo de chave (600 ou 400) e põe a chave só no ambiente do comando. */
function keyEnv(path: string): string {
  const bad = sq(JSON.stringify({ success: false, error: { code: "KEY_FILE_MODE", message: "arquivo de chave ausente ou com modo diferente de 600" } }));
  return `f=${remotePath(path)}; m=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null); case "$m" in [4-6]00) ;; *) printf '%s\\n' ${bad}; exit 3 ;; esac; RAVI_CONTEXT_KEY="$(cat "$f")" `;
}
const raviCmd = (inst: Install) => {
  const ravi = inst.reach.type === "ssh" && inst.reach.ravi ? inst.reach.ravi : "ravi";
  return ravi.startsWith("~/") ? remotePath(ravi) : sq(ravi);
};
async function issueLink(name: string, inst: Install, cliName: string, caps: string[], ttlDays: number): Promise<Issued> {
  if (!Number.isInteger(ttlDays) || ttlDays <= 0 || ttlDays > MAX_LINK_DAYS) throw refuse("TTL", "ttl inválido");
  const allow = caps.join(",");
  const ttl = `${ttlDays}d`;
  let j: any;
  if (inst.reach.type === "http") {
    const key = readSecretFile(inst.reach.issuerKeyFile, `chave emissora de ${name}`);
    j = await gatewayCall(inst.reach.url, key, "context/issue", { cliName, allow, ttl });
  } else {
    const remote = `${keyEnv(inst.reach.issuerKeyFile)}${raviCmd(inst)} context issue ${sq(cliName)} --allow ${sq(allow)} --ttl ${sq(ttl)} --json`;
    j = await sshRun(inst.reach.alias, remote, WANT.issue);
  }
  const got = (j.capabilities || []).map(capString).sort();
  const want = [...caps].sort();
  if (typeof j.contextKey !== "string" || !j.contextKey.startsWith("rctx_") || JSON.stringify(got) !== JSON.stringify(want))
    throw new Fail(1, "ISSUE_MISMATCH", `${name}: a chave emitida (${j.contextId}) não tem exatamente as capacidades pedidas; ela não vai para a página, desconecte esta conexão para revogá-la`, typeof j.contextId === "string" ? { issued: { contextId: j.contextId, parentContextId: j.parentContextId ?? null, expiresAt: Number(j.expiresAt) } } : { maybeIssued: true });
  return { contextId: j.contextId, contextKey: j.contextKey, expiresAt: Number(j.expiresAt), parentContextId: j.parentContextId ?? null, capabilities: got };
}

// ---------- selo ----------
async function seal(r: Req, hash: string, grant: unknown) {
  const pagePub = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: r.pub.x, y: r.pub.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "ECDH", public: pagePub }, eph.privateKey, 256);
  const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: unb64u(hash), info: enc.encode("ravi-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`ravi-connect-v1|${hash}|${r.origin}`) }, aes, enc.encode(JSON.stringify(grant)));
  const epk = (await subtle.exportKey("jwk", eph.publicKey)) as JsonWebKey;
  const env = { v: 1, h: hash, epk: { x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(ct) };
  return ENVELOPE_PREFIX + b64u(enc.encode(JSON.stringify(env)));
}

// ---------- subcomandos ----------
async function cmdCheck(arg?: string) {
  const c = loadConfig();
  const p = await parseRequest(await readArg(arg), c);
  // consome o nonce ANTES de perguntar ao dono
  withLedger(c, (l) => {
    if (l.nonces[p.r.nonce]) throw refuse("NONCE_REUSED", "este pedido já foi usado; peça para clicar em Conectar de novo");
    l.nonces[p.r.nonce] = { hash: p.hash, origin: p.r.origin, preset: p.r.preset, installs: p.r.installs, phrase: p.phrase, iat: p.r.iat, checkedAt: Date.now(), state: "checked" };
  });
  const msg = confirmation(p, c);
  emit(
    { ok: true, origin: p.r.origin, installs: p.r.installs, preset: p.r.preset, capabilities: Object.fromEntries(p.r.installs.map((n) => [n, accessCaps(c.installations[n], p.r.preset)])), ttlDays: c.linkTtlDays, phrase: p.phrase, code: p.code, confirmation: msg },
    `OK: pedido válido; nonce consumido.\n\nMande ao dono exatamente esta mensagem:\n\n${msg}`,
  );
}

const freshChecked = (n: NonceEntry, now: number) => n.state === "checked" && now - n.checkedAt <= MAX_AGE_MS;

/** --out-dir: pasta vazia que já existe (mktemp -d) ou que ainda não existe; nunca um link simbólico. Confere antes de emitir. */
function checkOutDir(dir: string) {
  if (!existsSync(dir)) {
    if (!existsSync(dirname(dir)) || !lstatSync(dirname(dir)).isDirectory()) throw usage("OUT_DIR", `--out-dir: a pasta de cima não existe (${dirname(dir)})`);
    return;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw usage("OUT_DIR", "--out-dir precisa ser uma pasta (não um arquivo nem um link simbólico); use \"$(mktemp -d)\"");
  if (readdirSync(dir).length) throw usage("OUT_DIR", "--out-dir precisa estar vazia; use \"$(mktemp -d)\"");
}
function writeEnvelopeFile(dir: string, envelope: string): string | null {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    checkOutDir(dir);
    const file = join(dir, "index.html");
    const fd = openSync(file, "wx", 0o600); // wx: nunca sobrescreve nem segue link
    try {
      writeFileSync(fd, `<!doctype html><meta charset="utf-8"><title>ravi-connect</title><script type="application/json" id="ravi-connect-envelope">${envelope}</script>\n`);
    } finally {
      closeSync(fd);
    }
    return file;
  } catch {
    return null; // sem arquivo: o envelope vai na resposta, como na etapa A
  }
}

async function cmdApprove(arg: string | undefined, phrase: string | undefined, outDir?: string) {
  if (!phrase) throw usage("USAGE", "faltou --phrase <FRASE>: a frase que o dono escreveu junto com o sim");
  const c = loadConfig();
  if (outDir) checkOutDir(outDir);
  // no approve vale: pedido (iat) de até 15 minutos e check de até 10 minutos atrás
  const parsed = await parseRequest(await readArg(arg), c, false);
  if (Date.now() - parsed.r.iat > MAX_APPROVE_AGE_MS) throw refuse("REQUEST_TOO_OLD", "o pedido tem mais de 15 minutos; peça para clicar em Conectar de novo");
  const host = new URL(parsed.r.origin).host;
  const cliName = `connect:${host}:${parsed.r.nonce.slice(0, 8)}`;
  const wantUntil = Date.now() + c.linkTtlDays * 86400000;
  const verdict = withLedger(c, (l) => {
    const now = Date.now();
    const n = l.nonces[parsed.r.nonce];
    if (!n) throw refuse("NOT_CHECKED", "rode check com este pedido antes (o check consome o nonce e gera a confirmação)");
    if (n.hash !== parsed.hash) throw refuse("NOT_CHECKED", "o pedido não é o mesmo que passou pelo check");
    if (n.state !== "checked") throw refuse("NONCE_REUSED", `este pedido já está em estado ${n.state}`);
    if (now - n.checkedAt > MAX_AGE_MS) throw refuse("APPROVAL_TOO_LATE", "a confirmação tem mais de 10 minutos; peça um novo pedido");
    // a frase vem do próprio pedido (hash), nunca do que está escrito no ledger
    if (normPhrase(phrase).replace(/^SIM-/, "") !== parsed.phrase) {
      n.state = "cancelled"; // frase de outro pedido: este não vale mais
      return "mismatch";
    }
    const others = Object.entries(l.nonces).filter(([k, v]) => k !== parsed.r.nonce && freshChecked(v, now));
    if (others.length) throw refuse("MULTIPLE_PENDING", "há outro pedido conferido esperando resposta; rode cancel e peça para clicar em Conectar de novo");
    n.state = "approving";
    // cada instalação entra no ledger ANTES de emitir: se o ssh travar ou o processo morrer no meio, list e
    // disconnect ainda acham o que pode ter sido criado lá (pelo cliName)
    l.links.push({ phrase: parsed.phrase, origin: parsed.r.origin, hash: parsed.hash, nonce: parsed.r.nonce, preset: parsed.r.preset, createdAt: now, installs: parsed.r.installs.map((name) => ({ name, contextId: "", cliName, parentContextId: null, expiresAt: wantUntil, pending: true })) });
    return "ok";
  });
  if (verdict === "mismatch") throw refuse("PHRASE_MISMATCH", "a frase do sim não é a deste pedido; nada foi emitido e o pedido foi cancelado. Peça para clicar em Conectar de novo");
  const issued: Array<{ name: string; baseUrl: string; i: Issued }> = [];
  const failed: Array<{ name: string; code: string; message: string; maybeIssued: boolean }> = [];
  const unrecorded: Array<{ name: string; contextId: string }> = [];
  /** Atualiza a linha da instalação no ledger (null: remove, porque com certeza nada foi criado lá). */
  const update = (name: string, li: Partial<LinkInstall> | null) => {
    try {
      withLedger(c, (l) => {
        const entry = l.links.find((k) => k.nonce === parsed.r.nonce);
        const row = entry?.installs.find((x) => x.name === name);
        if (!entry || !row) return;
        if (li === null) entry.installs = entry.installs.filter((x) => x !== row);
        else {
          Object.assign(row, li);
          delete row.pending;
        }
        if (!entry.installs.length) l.links = l.links.filter((k) => k !== entry);
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const name of parsed.r.installs) {
    const inst = c.installations[name];
    try {
      const i = await issueLink(name, inst, cliName, linkCaps(inst, parsed.r.preset), c.linkTtlDays);
      if (!update(name, { contextId: i.contextId, parentContextId: i.parentContextId, expiresAt: i.expiresAt })) unrecorded.push({ name, contextId: i.contextId });
      issued.push({ name, baseUrl: inst.baseUrl, i });
    } catch (e) {
      const f = e instanceof Fail ? e : new Fail(1, "ERROR", String((e as Error)?.message ?? e));
      if (f.extra.issued) update(name, f.extra.issued); // criada com outras capacidades: fica registrada para o disconnect
      else if (!f.extra.maybeIssued) update(name, null);
      failed.push({ name, code: f.code, message: f.message.replace(/rctx_[A-Za-z0-9_-]+/g, "[chave]"), maybeIssued: !!f.extra.maybeIssued || !!f.extra.issued });
    }
  }
  withLedger(c, (l) => {
    l.nonces[parsed.r.nonce].state = issued.length ? "approved" : "failed";
  });
  const failLines = failed.map((f) => `Não conectou ${f.name}: ${f.code}.` + (f.maybeIssued ? ` A chave pode ter sido criada lá mesmo assim; ela está no registro como "emissão interrompida" e sai com "desconectar ${parsed.phrase}".` : ""));
  if (!issued.length) throw new Fail(1, "ISSUE_FAILED", "nenhuma instalação emitiu chave. " + failLines.join(" ") + " Confira o daemon e o ssh e peça para clicar em Conectar de novo.");
  // O link nunca vive mais que a chave emissora: se ela vence antes, o link sai mais curto que o combinado.
  const shortened = issued.filter(({ i }) => i.expiresAt < wantUntil - 3600 * 1000).map(({ name }) => name);
  const grant = { v: 1, origin: parsed.r.origin, hash: parsed.hash, preset: parsed.r.preset, installs: issued.map(({ name, baseUrl, i }) => ({ name, baseUrl, linkKey: i.contextKey, contextId: i.contextId, expiresAt: i.expiresAt, caps: accessCaps(c.installations[name], parsed.r.preset) })) };
  const envelope = await seal(parsed.r, parsed.hash, grant);
  for (const g of grant.installs) g.linkKey = ""; // apaga da memória o que não precisa mais
  const route = `/_link/${parsed.code}`;
  const file = outDir ? writeEnvelopeFile(outDir, envelope) : null;
  const summary = issued.map(({ name, i }) => `${name} até ${new Date(i.expiresAt).toISOString().slice(0, 10)}`).join(", ");
  const reply =
    `Conectado: ${summary}.` +
    (failLines.length ? `\n${failLines.join("\n")} Para tentar de novo, clique em Conectar na página: ela pede só o que falta.` : "") +
    (shortened.length ? `\nAtenção: ${shortened.join(", ")} vale menos que os ${c.linkTtlDays} dias combinados, porque a chave emissora de lá vence antes. Faça a Rotação de references/instalacao.md e reconecte.` : "") +
    (unrecorded.length ? `\nAtenção: não consegui registrar ${unrecorded.map((u) => `${u.name} (${u.contextId})`).join(", ")} no ledger; para revogar, rode na instalação: ravi context revoke <id> --reason ravi-connect.` : "") +
    `\nPara desconectar: "desconectar ${parsed.phrase}".` +
    (file ? "" : `\n\nCole este envelope na página (ele só abre naquele navegador):\n${envelope}`);
  emit(
    { ok: true, phrase: parsed.phrase, origin: parsed.r.origin, route, envelope: file ? undefined : envelope, envelopeFile: file, installs: issued.map(({ name, i }) => ({ name, contextId: i.contextId, expiresAt: i.expiresAt })), failed, shortened, unrecorded, reply },
    (outDir && !file ? `ATENÇÃO: não consegui gravar em ${outDir}; o envelope vai na resposta (etapa A).\n\n` : "") +
      (file ? `Envelope gravado em ${file}. Publique na rota privada ${route} (veja o SKILL.md) e depois responda ao dono:\n\n${reply}` : `Responda ao dono com:\n\n${reply}`),
  );
}

function cmdCancel() {
  const c = loadConfig();
  const now = Date.now();
  const n = withLedger(c, (l) => {
    let k = 0;
    for (const v of Object.values(l.nonces))
      if (freshChecked(v, now)) {
        v.state = "cancelled";
        k++;
      }
    return k;
  });
  emit({ ok: true, cancelled: n }, n ? `Cancelados: ${n} pedido(s). Peça para clicar em Conectar de novo.` : "Nenhum pedido esperando.");
}

function cmdList() {
  const c = loadConfig();
  const l = withLedger(c, (x) => x);
  const now = Date.now();
  const rows = l.links.map((k) => ({
    phrase: k.phrase,
    origin: k.origin,
    preset: k.preset,
    createdAt: k.createdAt,
    installs: k.installs.map((i) => ({ name: i.name, contextId: i.contextId, expiresAt: i.expiresAt, state: i.revokedAt ? "revogada" : i.expiresAt < now ? "expirada" : i.pending ? `emissão interrompida (pode existir lá como ${i.cliName})` : i.expiresAt - now < 7 * 86400000 ? "vence em menos de 7 dias" : "ativa" })),
  }));
  const text = rows.length
    ? rows.map((r) => `${r.phrase}  ${r.origin}  [${r.preset}]\n` + r.installs.map((i) => `  - ${i.name}: ${i.state}, até ${new Date(i.expiresAt).toISOString().slice(0, 10)}`).join("\n")).join("\n")
    : "Nenhuma conexão registrada.";
  emit({ ok: true, links: rows }, text);
}

/** Revogação manual: confere com a chave emissora (read:context:info) se o dono já revogou este link. */
async function alreadyRevoked(name: string, inst: Install, li: LinkInstall): Promise<boolean> {
  try {
    const j: any =
      inst.reach.type === "http"
        ? await gatewayCall(inst.reach.url, readSecretFile(inst.reach.issuerKeyFile, `chave emissora de ${name}`), "context/info", { contextId: li.contextId })
        : await sshRun(inst.reach.alias, `${keyEnv(inst.reach.issuerKeyFile)}${raviCmd(inst)} context info ${sq(li.contextId)} --json`, WANT.info);
    return j?.status === "revoked" && j.issuedFor === li.cliName;
  } catch {
    return false; // sem read:context:info na emissora, ou instalação fora do ar: não dá para afirmar
  }
}

async function revokeOne(name: string, inst: Install, li: LinkInstall): Promise<string> {
  const rv = inst.revoke ?? { via: "manual" }; // sem chave de revogação configurada, quem revoga é o dono
  const where = inst.reach.type === "ssh" ? `na VPS (ssh ${inst.reach.alias})` : "no seu terminal";
  if (li.pending)
    // a emissão foi interrompida: o helper não sabe o id; só a lista da instalação mostra se o contexto existe
    return `manual: a emissão em ${name} foi interrompida e pode ter criado o contexto ${li.cliName}. Rode ${where}: ravi context list --json --fields contextId,issuedFor  e, se aparecer ${li.cliName}, ravi context revoke <contextId> --reason ravi-connect . Esta linha some do registro quando a data dela passa (${new Date(li.expiresAt).toISOString().slice(0, 10)})`;
  if (rv.via === "manual") {
    if (await alreadyRevoked(name, inst, li)) return "revogada";
    return `manual: rode ${where}: ravi context revoke ${li.contextId} --reason ravi-connect  e depois repita o "desconectar" para eu conferir`;
  }
  let info: any;
  if (rv.via === "http" && inst.reach.type === "http") {
    const key = readSecretFile(rv.keyFile!, `chave de revogação de ${name}`);
    info = await gatewayCall(inst.reach.url, key, "context/info", { contextId: li.contextId });
    check(info);
    await gatewayCall(inst.reach.url, key, "context/revoke", { contextId: li.contextId, reason: "ravi-connect disconnect" });
    return "revogada";
  }
  const prefix = rv.keyFile ? keyEnv(rv.keyFile) : "";
  const raviQ = raviCmd(inst);
  const run = async (args: string, want: Want) => {
    const cmd = `${prefix}${raviQ} ${args} --json`;
    if (inst.reach.type === "ssh") return sshRun(inst.reach.alias, cmd, want);
    const p = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const j = extractJson(out, want);
    if (code !== 0 || !j || isCliError(j)) throw new Fail(1, j?.error?.code || "CLI_FAILED", `${name}: ravi ${args.split(" ")[1]} falhou (exit ${code})`);
    return j;
  };
  info = await run(`context info ${sq(li.contextId)}`, WANT.info);
  check(info);
  await run(`context revoke ${sq(li.contextId)} --reason ${sq("ravi-connect disconnect")}`, WANT.revoke);
  return "revogada";
  function check(j: any) {
    // só revoga o contexto que este helper registrou: mesmo nome e mesmo pai
    const ours = typeof j.issuedFor === "string" && j.issuedFor.startsWith("connect:") && j.issuedFor === li.cliName && !!li.parentContextId && j.parentContextId === li.parentContextId;
    if (!ours) throw refuse("NOT_OURS", `${name}: o contexto ${li.contextId} não confere com o registro; nada foi revogado`);
  }
}

async function cmdDisconnect(target: string | undefined, onlyInstall?: string) {
  if (!target) throw usage("USAGE", "uso: disconnect <frase|origem> [--install <nome>]");
  const c = loadConfig();
  const l = withLedger(c, (x) => x);
  const isOrigin = /^https:\/\//i.test(target);
  const matches = l.links.filter((k) => (isOrigin ? k.origin === target.toLowerCase().replace(/\/$/, "") : k.phrase === normPhrase(target)));
  if (!matches.length) throw new Fail(1, "NOT_FOUND", "nenhuma conexão registrada com essa frase ou origem");
  if (onlyInstall && !matches.some((k) => k.installs.some((li) => li.name === onlyInstall))) throw new Fail(1, "NOT_FOUND", `essa conexão não tem a instalação ${onlyInstall}`);
  const now = Date.now();
  const results: Array<{ phrase: string; name: string; contextId: string; result: string }> = [];
  for (const k of matches)
    for (const li of k.installs) {
      if (li.revokedAt || (onlyInstall && li.name !== onlyInstall) || (li.pending && li.expiresAt < now)) continue;
      const inst = c.installations[li.name];
      let result: string;
      try {
        result = inst ? await revokeOne(li.name, inst, li) : "instalação não está mais na configuração";
      } catch (e) {
        result = `falhou (${e instanceof Fail ? e.code : "ERROR"}): ${(e as Error).message.replace(/rctx_[A-Za-z0-9_-]+/g, "[chave]")}`;
      }
      if (result === "revogada") li.revokedAt = Date.now();
      results.push({ phrase: k.phrase, name: li.name, contextId: li.contextId, result });
    }
  const revoked = new Map(matches.flatMap((k) => k.installs.filter((li) => li.revokedAt).map((li) => [li.contextId, li.revokedAt!] as const)));
  withLedger(c, (x) => {
    for (const k of x.links) for (const li of k.installs) if (!li.revokedAt && revoked.has(li.contextId)) li.revokedAt = revoked.get(li.contextId);
  });
  emit({ ok: results.every((r) => r.result === "revogada"), results }, results.length ? results.map((r) => `${r.phrase} ${r.name}: ${r.result}`).join("\n") : "Nada a revogar (já revogado).");
}

/** O que a página faz: GET <baseUrl>/api/v1/_meta/version com o Origin do projeto. Confere túnel/daemon e CORS. */
async function probePage(baseUrl: string, origins: string[]): Promise<string | null> {
  for (const origin of origins) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/v1/_meta/version`, { headers: { origin }, signal: AbortSignal.timeout(5000) });
    } catch {
      return `a página não alcança ${baseUrl} (túnel caído, daemon parado ou porta errada)`;
    }
    if (!res.ok) return `${baseUrl} respondeu ${res.status} em _meta/version`;
    if (res.headers.get("access-control-allow-origin") !== origin) return `${baseUrl} não libera ${origin} no CORS (RAVI_CORS_ORIGINS, passo 1 de instalacao.md)`;
  }
  return null;
}

async function cmdStatus(probe: boolean) {
  const c = loadConfig();
  const rows: any[] = [];
  for (const [name, i] of Object.entries(c.installations)) {
    const row: any = { name, baseUrl: i.baseUrl, reach: i.reach.type === "http" ? `http ${i.reach.url}` : `ssh ${i.reach.alias}`, revoke: (i.revoke ?? { via: "manual" }).via, scope: i.scope };
    const need = linkCaps(i, "ver");
    const allowed = new Set([ISSUER_INFO_CAP, ...linkCaps(i, "conversar")]); // exatamente o que `caps` imprime
    try {
      let w: any = null;
      if (i.reach.type === "http") {
        const key = readSecretFile(i.reach.issuerKeyFile, `chave emissora de ${name}`);
        row.issuerKeyFile = "ok (0600)";
        if (probe) w = await gatewayCall(i.reach.url, key, "context/whoami", {});
      } else if (probe) w = await sshRun(i.reach.alias, `${keyEnv(i.reach.issuerKeyFile)}${raviCmd(i)} context whoami --json`, WANT.whoami);
      if (w) {
        row.issuerContextId = w.contextId ?? null;
        row.issuerExpiresAt = w.expiresAt ?? null;
        row.issuerCapabilities = (w.capabilities || []).map(capString);
      }
    } catch (e) {
      row.problem = (e as Error).message;
    }
    if (row.issuerCapabilities) {
      const missing = need.filter((x) => !row.issuerCapabilities.includes(x));
      const forbidden = row.issuerCapabilities.filter((x: string) => FORBIDDEN.test(x));
      const extra = row.issuerCapabilities.filter((x: string) => !allowed.has(x));
      if (forbidden.length) row.problem = `chave emissora com capacidade proibida: ${forbidden.join(", ")}; revogue-a e crie outra com pair.ts caps ${name}`;
      else if (extra.length) row.problem = `chave emissora com capacidade a mais: ${extra.join(", ")}; revogue-a e crie outra com pair.ts caps ${name}`;
      else if (missing.length && !row.problem) row.problem = `chave emissora sem ${missing.join(", ")}; refaça com pair.ts caps ${name}`;
      else if (!row.issuerCapabilities.includes("mutate:sessions:send")) row.note = "emissora sem mutate:sessions:send: só o preset ver funciona aqui";
      if (!row.issuerCapabilities.includes(ISSUER_INFO_CAP) && (i.revoke ?? { via: "manual" }).via === "manual")
        row.note = (row.note ? row.note + "; " : "") + "emissora sem read:context:info: depois de uma revogação manual o helper não consegue conferir";
    }
    if (probe) {
      const p = await probePage(i.baseUrl, c.allowedOrigins);
      row.page = p ? "PROBLEMA" : "ok";
      if (p) row.problem = row.problem ? `${row.problem}; ${p}` : p;
    }
    if (!i.scope.sessions.length) row.warning = "escopo sem sessões: a página não verá nenhuma sessão";
    if (row.issuerExpiresAt && row.issuerExpiresAt - Date.now() < 14 * 86400000) row.warning = "chave emissora vence em menos de 14 dias, e os links dela junto: faça a Rotação de instalacao.md e reconecte as páginas";
    rows.push(row);
  }
  const l = withLedger(c, (x) => x);
  const now = Date.now();
  const soon = l.links.flatMap((k) => k.installs.filter((i) => !i.revokedAt && !i.pending && i.expiresAt > now && i.expiresAt - now < 7 * 86400000).map((i) => `${k.phrase} ${i.name}`));
  const interrupted = l.links.flatMap((k) => k.installs.filter((i) => !i.revokedAt && i.pending && i.expiresAt > now).map((i) => `${k.phrase} ${i.name}`));
  emit(
    { ok: rows.every((r) => !r.problem), config: configPath(), allowedOrigins: c.allowedOrigins, linkTtlDays: c.linkTtlDays, installations: rows, renewSoon: soon, interrupted },
    [
      `Config: ${configPath()}`,
      `Origens permitidas: ${c.allowedOrigins.join(", ")}`,
      `Validade dos links: ${c.linkTtlDays} dias`,
      ...rows.map((r) => `- ${r.name}: ${r.reach}; página usa ${r.baseUrl}${r.page ? ` (${r.page})` : ""}; revoga via ${r.revoke}; sessões ${r.scope.sessions.join(", ") || "(nenhuma)"}; agentes ${r.scope.agents.join(", ") || "(só o próprio)"}` + (r.issuerKeyFile ? `; ${r.issuerKeyFile}` : "") + (r.issuerExpiresAt ? `; emissora ${r.issuerContextId ?? ""} até ${new Date(r.issuerExpiresAt).toISOString().slice(0, 10)}` : "") + (r.problem ? `; PROBLEMA: ${r.problem}` : "") + (r.warning ? `; ATENÇÃO: ${r.warning}` : "") + (r.note ? `; ${r.note}` : "")),
      soon.length ? `Renovar em breve: ${soon.join(", ")}` : "Nenhum link vence nos próximos 7 dias.",
      ...(interrupted.length ? [`Emissão interrompida (confira com "desconectar <frase>"): ${interrupted.join(", ")}`] : []),
    ].join("\n"),
  );
}

// ---------- main ----------
async function main() {
  const argv = process.argv.slice(2);
  asJson = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const opt = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    if (!v) throw usage("USAGE", `faltou valor para ${flag}`);
    return v;
  };
  const sub = args.shift();
  if (sub === "check") return cmdCheck(args[0]);
  if (sub === "approve") {
    const out = opt("--out-dir");
    const phrase = opt("--phrase");
    return cmdApprove(args[0], phrase, out);
  }
  if (sub === "cancel") return cmdCancel();
  if (sub === "caps") {
    const c = loadConfig();
    const inst = args[0] && Object.hasOwn(c.installations, args[0]) ? c.installations[args[0]] : null;
    if (!inst) throw usage("USAGE", "uso: pair.ts caps <instalação da config>");
    const allow = [ISSUER_INFO_CAP, ...linkCaps(inst, "conversar")].join(",");
    return emit({ ok: true, install: args[0], allow }, allow);
  }
  if (sub === "list") return cmdList();
  if (sub === "disconnect") {
    const only = opt("--install");
    return cmdDisconnect(args.join(" ") || undefined, only);
  }
  if (sub === "status") return cmdStatus(args.includes("--probe"));
  throw usage("USAGE", "uso: pair.ts check|approve|cancel|list|disconnect|status|caps (veja o topo do arquivo)");
}
main().catch((e) => {
  const f = e instanceof Fail ? e : new Fail(1, "ERROR", String(e?.message ?? e));
  const msg = f.message.replace(/rctx_[A-Za-z0-9_-]+/g, "[chave]");
  if (asJson) console.log(JSON.stringify({ ok: false, error: { code: f.code, message: msg } }));
  else console.error(`${f.exit === 3 ? "RECUSADO" : "ERRO"} (${f.code}): ${msg}`);
  process.exit(f.exit);
});
