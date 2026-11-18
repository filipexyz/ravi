// End-to-end test of the ravi-connect bundle: the bundle's real connect.js in Chromium (ravi.page CSP,
// local-network permission granted) + the bundle's real scripts/pair.ts under Bun, against TWO processes of the
// real gateway code (Ravi source at $RAVI_SRC), each with its own isolated RAVI_STATE_DIR: "local" (gateway A,
// reached by the helper over loopback HTTP) and "vps1" (gateway B, reached by the helper through an ssh STAND-IN).
// Behind the stand-in everything is real: a clean non-interactive remote shell, a remote HOME whose `ravi` is a
// wrapper (like the installed one, it execs `bun` from PATH) around the REAL CLI source entrypoint, which talks to
// gateway B through RAVI_GATEWAY_URL. The page reaches gateway B on its loopback port (the autossh tunnel's role).
// Run: ./run-e2e.sh (see README.md). Everything lives under a fresh directory in the system temp dir and is deleted
// at the end (set E2E_KEEP=1 to keep it). Result: e2e-result.json next to this file.
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { webcrypto, createHash } = require("crypto");
const { chromium } = require("playwright");

const E = __dirname;
const SKILL = path.resolve(process.env.RAVI_CONNECT_SKILL || path.join(E, "..", "..", "skill", "connect-installations"));
const PAIR = path.join(SKILL, "scripts", "pair.ts");
const CONNECT_JS = path.join(SKILL, "assets", "connect.js");
const RAVI_SRC = path.resolve(process.env.RAVI_SRC || path.join(E, "..", "..", "..", ".."));
const ORIGIN = "https://exemplo-painel.ravi.page";
const CSP = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
for (const f of [PAIR, CONNECT_JS, path.join(RAVI_SRC, "src", "cli", "index.ts")]) if (!fs.existsSync(f)) (console.error("missing: " + f + " (set RAVI_SRC / RAVI_CONNECT_SKILL)"), process.exit(2));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ravi-connect-e2e-"));
const RUN = path.join(ROOT, "run");
fs.mkdirSync(RUN, { recursive: true });
let PA, PB, A, B;
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const cleanEnv = { ...process.env };
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL", "RAVI_STATE_DIR", "RAVI_CONNECT_CONFIG", "RAVI_CONNECT_SSH_TIMEOUT_MS"]) delete cleanEnv[k];

const results = [];
const problems = [];
const ok = (name, cond, evidence) => {
  const ev = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  results.push({ name, result: cond ? "pass" : "FAIL", evidence: (ev || "").replace(/rctx_[A-Za-z0-9_-]+/g, "[key]") });
  console.error((cond ? "pass " : "FAIL ") + name + " :: " + (ev || "").replace(/rctx_[A-Za-z0-9_-]+/g, "[key]").slice(0, 400));
};
const note = (p) => (problems.push(p), console.error("NOTE " + JSON.stringify(p)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- gateways ----------
const states = { A: path.join(ROOT, "state-A"), B: path.join(ROOT, "state-B") };
const procs = {};
const adminFile = (w) => path.join(RUN, `admin-${w}.key`);
async function startGw(which) {
  const port = which === "A" ? PA : PB;
  const ready = path.join(RUN, `ready-${which}-${Date.now()}`);
  const p = spawn("bun", ["--no-env-file", path.join(E, "gateway2.ts")], {
    cwd: RAVI_SRC,
    env: { ...cleanEnv, HOME: path.join(ROOT, "home-gw"), RAVI_SRC, GW_PORT: String(port), READY_FILE: ready, ADMIN_KEY_FILE: adminFile(which), RAVI_STATE_DIR: states[which], NATS_URL: "nats://127.0.0.1:1", RAVI_SUPPRESS_AUDIT_EVENTS: "1", RAVI_CORS_ORIGINS: ORIGIN, KEEP_MS: "1800000" },
    stdio: ["ignore", fs.openSync(path.join(RUN, `gw-${which}.log`), "a"), fs.openSync(path.join(RUN, `gw-${which}.log`), "a")],
  });
  procs[which] = p;
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(ready)) return fs.readFileSync(adminFile(which), "utf8").trim();
    await sleep(200);
  }
  throw new Error("gateway " + which + " did not start");
}
async function stopGw(which) {
  const p = procs[which];
  if (!p || p.exitCode !== null) return;
  p.kill("SIGKILL");
  await new Promise((r) => p.once("exit", r));
}
const gw = async (base, cmd, key, body = {}) => {
  const r = await fetch(`${base}/api/v1/${cmd}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const capStr = (c) => (typeof c === "string" ? c : `${c.permission}:${c.objectType}:${c.objectId}`);
const capsOf = (j) => (j && j.capabilities ? j.capabilities.map(capStr).sort() : null);
const write0600 = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, v + "\n", { mode: 0o600 });
  fs.chmodSync(f, 0o600);
};
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// ---------- homes: the owner's computer (helper) and the "VPS" ----------
const HOME_L = path.join(ROOT, "home-local");
const HOME_R = path.join(ROOT, "home-remote");
const HOME_O = path.join(ROOT, "home-owner-terminal");
const CONF = path.join(HOME_L, ".ravi", "pairing", "config.json");
const LEDGER = path.join(HOME_L, ".ravi", "pairing", "ledger.json");
const SSH_LOG = path.join(RUN, "ssh.log");
const SSH_MODE = path.join(RUN, "ssh-mode");
const SSH_HANG_PIDS = path.join(RUN, "ssh-hang.pids");
const LOCAL_RAVI_BIN = path.join(RUN, "bin-local-ravi");
const NOISE = path.join(HOME_R, ".e2e-noise");
// `ravi` wrapper: execs `bun` from PATH (as the installed wrapper does) on the REAL CLI source entrypoint.
const raviWrapper = (state, url) => `#!/bin/sh
# Test wrapper standing in for the INSTALLED ravi (a wrapper that execs bun). What runs is the REAL CLI source
# entrypoint, against this installation's own gateway (RAVI_GATEWAY_URL) and state.
noise=$(cat "$HOME/.e2e-noise" 2>/dev/null)
[ "$noise" = text ] && printf '%s\\n' 'aviso: este CLI e de outra versao que o daemon {v}' '{ isto nao e JSON'
cd ${shq(RAVI_SRC)} || exit 70
RAVI_STATE_DIR=${shq(state)} RAVI_GATEWAY_URL=${shq(url)} NATS_URL=nats://127.0.0.1:1 RAVI_SUPPRESS_AUDIT_EVENTS=1 bun --no-env-file src/cli/index.ts "$@"
rc=$?
[ "$noise" = text ] && printf '%s\\n' 'aviso: fim da saida }'
[ "$noise" = jsonlog ] && printf '%s\\n' '{"level":"warn","msg":"cli desatualizado"}'
exit $rc
`;
function setupHomes() {
  const bunPath = execFileSync("sh", ["-c", "command -v bun"], { env: cleanEnv, encoding: "utf8" }).trim();
  fs.mkdirSync(path.join(HOME_R, ".bun", "bin"), { recursive: true });
  fs.symlinkSync(fs.realpathSync(bunPath), path.join(HOME_R, ".bun", "bin", "bun"));
  fs.mkdirSync(path.join(HOME_R, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(HOME_R, ".local", "bin", "ravi"), raviWrapper(states.B, B), { mode: 0o755 });
  fs.mkdirSync(path.join(HOME_R, ".ravi", "pairing"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOCAL_RAVI_BIN, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_RAVI_BIN, "ravi"), raviWrapper(states.A, A), { mode: 0o755 });
  fs.mkdirSync(HOME_O, { recursive: true });
  fs.writeFileSync(SSH_MODE, "");
}
const pairEnv = (extra = {}) => ({ ...cleanEnv, HOME: HOME_L, RAVI_CONNECT_CONFIG: CONF, PATH: path.join(E, "bin-local") + ":" + LOCAL_RAVI_BIN + ":" + cleanEnv.PATH, E2E_SSH_LOG: SSH_LOG, E2E_SSH_MODE_FILE: SSH_MODE, E2E_SSH_HANG_PIDS: SSH_HANG_PIDS, E2E_REMOTE_HOME: HOME_R, ...extra });
const pair = (args, extra = {}) => {
  try {
    const out = execFileSync("bun", ["--no-env-file", PAIR, ...args, "--json"], { env: pairEnv(extra), cwd: RUN, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
    return { code: 0, json: JSON.parse(out), raw: out };
  } catch (e) {
    let json = null;
    try {
      json = JSON.parse(e.stdout);
    } catch {}
    return { code: e.status, json, raw: (e.stdout || "") + (e.stderr || "") };
  }
};
// check + approve with the phrase the helper showed (what the owner types back: "sim <FRASE>")
const checkApprove = (text, extra = [], env = {}) => {
  const c = pair(["check", text], env);
  if (c.code !== 0) return { check: c, approve: c };
  return { check: c, approve: pair(["approve", text, "--phrase", c.json.phrase, ...extra], env) };
};
// The owner, in a terminal of that installation, with the admin key the operator CLI uses (env, never argv).
const ownerCli = (which, args, adminKey) => {
  const bin = which === "B" ? path.join(HOME_R, ".local", "bin", "ravi") : path.join(LOCAL_RAVI_BIN, "ravi");
  try {
    const out = execFileSync(bin, args, { env: { ...cleanEnv, HOME: HOME_O, RAVI_CONTEXT_KEY: adminKey }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
};
// "manual: rode ...: ravi context revoke <id> --reason ravi-connect  e depois ..." -> the literal command
const manualCmd = (line) => {
  const m = /:\s(ravi context revoke \S+ --reason \S+)\s/.exec(line || "");
  return m ? m[1].split(/\s+/) : null;
};
const killHangs = () => {
  if (!fs.existsSync(SSH_HANG_PIDS)) return;
  for (const p of fs.readFileSync(SSH_HANG_PIDS, "utf8").split("\n").filter(Boolean)) try { process.kill(Number(p), "SIGKILL"); } catch {}
  fs.rmSync(SSH_HANG_PIDS, { force: true });
};
const readLedger = () => JSON.parse(fs.readFileSync(LEDGER, "utf8"));
const readLedgerSafe = () => { try { return readLedger(); } catch { return {}; } };
const errc = (r) => (r.json && r.json.error ? r.json.error.code : `exit${r.code}`);
const b64u = (b) => Buffer.from(b).toString("base64url");
const canon = (r) => JSON.stringify({ v: r.v, kind: r.kind, origin: r.origin, pub: { x: r.pub.x, y: r.pub.y }, preset: r.preset, installs: r.installs, nonce: r.nonce, iat: r.iat });
async function nodeRequest({ origin = ORIGIN, preset = "ver", installs = ["local"], iat = Date.now(), extra = null, raw = false } = {}) {
  const k = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const j = await webcrypto.subtle.exportKey("jwk", k.publicKey);
  const r = { v: 1, kind: "ravi-connect", origin, pub: { x: j.x, y: j.y }, preset, installs, nonce: b64u(webcrypto.getRandomValues(new Uint8Array(16))), iat };
  let text = raw ? JSON.stringify({ ...r, ...extra }) : canon(r);
  if (extra && !raw) text = JSON.stringify({ ...JSON.parse(text), ...extra });
  return { text: "ravi-connect:v1:" + b64u(Buffer.from(text)), priv: k.privateKey, req: r, canonText: text };
}
async function nodeOpen(envelopeText, priv, canonText, origin) {
  const env = JSON.parse(Buffer.from(envelopeText.slice("ravi-envelope:v1:".length), "base64url").toString());
  const epk = await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: env.epk.x, y: env.epk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await webcrypto.subtle.deriveBits({ name: "ECDH", public: epk }, priv, 256);
  const hk = await webcrypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await webcrypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.from(env.h, "base64url"), info: Buffer.from("ravi-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(env.iv, "base64url"), additionalData: Buffer.from(`ravi-connect-v1|${env.h}|${origin}`) }, aes, Buffer.from(env.ct, "base64url"));
  return JSON.parse(Buffer.from(pt).toString());
}

async function nodeSeal(reqText, grant) {
  const raw = Buffer.from(reqText.slice("ravi-connect:v1:".length), "base64url").toString();
  const r = JSON.parse(raw);
  const hash = Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(raw))).toString("base64url");
  const pub = await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: r.pub.x, y: r.pub.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256);
  const hk = await webcrypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await webcrypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.from(hash, "base64url"), info: Buffer.from("ravi-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const g = { v: 1, origin: r.origin, hash, preset: r.preset, ...grant };
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(`ravi-connect-v1|${hash}|${r.origin}`) }, aes, Buffer.from(JSON.stringify(g)));
  const epk = await webcrypto.subtle.exportKey("jwk", eph.publicKey);
  return "ravi-envelope:v1:" + b64u(Buffer.from(JSON.stringify({ v: 1, h: hash, epk: { x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(Buffer.from(ct)) })));
}

// ---------- browser ----------
const pageHtml = (preset, stageB) => `<!doctype html><meta charset=utf-8><title>painel</title><main><div id=c></div></main>
<script type=module>
import { createConnect, storedSummary } from '/connect.js';
const conn = createConnect({ installations: { local: ${JSON.stringify(A)}, vps1: ${JSON.stringify(B)} }, preset: ${JSON.stringify(preset)}, stageB: ${stageB ? "true" : "false"}, pollMs: 300,
  chat: { whatsapp: "https://wa.me/5500000000000", slack: "https://example-workspace.slack.com/app_redirect?channel=D0000000000" } });
conn.mount(document.getElementById("c"));
window.conn = conn; window.storedSummary = storedSummary;
window.ready = conn.session();
</script>`;
const published = new Map(); // stage B: what the agent "shipped" on private routes /_link/<code> of the page's host
async function setupContext(ctx) {
  await ctx.grantPermissions(["local-network-access"], { origin: ORIGIN }).catch((e) => note({ severity: "info", where: "test harness", problem: "grantPermissions local-network-access failed: " + e.message }));
  await ctx.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/connect.js") return route.fulfill({ status: 200, contentType: "text/javascript", headers: { "content-security-policy": CSP }, body: fs.readFileSync(CONNECT_JS, "utf8") });
    if (url.pathname.startsWith("/_link/")) return published.has(url.pathname) ? route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: published.get(url.pathname) }) : route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: pageHtml(url.searchParams.get("preset") || "ver", url.searchParams.get("b") === "1") });
  });
  return ctx;
}
const visit = async (ctx, q = "") => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.error("pageerror", e.message));
  await p.goto(ORIGIN + "/" + q);
  await p.waitForFunction(() => window.ready);
  await p.evaluate(() => window.ready);
  return p;
};
const stateOf = (p) => p.evaluate(() => Object.fromEntries(window.conn.snapshot().map((s) => [s.name, s.state])));
// Raw dump of EVERY IndexedDB database/store + local/sessionStorage, CryptoKeys summarized.
const dumpStorage = (p) =>
  p.evaluate(async () => {
    const ser = (v) =>
      JSON.stringify(v, (k, x) => (x instanceof CryptoKey ? { cryptoKey: true, extractable: x.extractable, type: x.type } : x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? Array.from(new Uint8Array(x.buffer || x)) : x));
    const out = { dbs: {}, ls: {}, ss: {} };
    for (const d of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open(d.name);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      for (const st of db.objectStoreNames) {
        const vals = await new Promise((res) => {
          const tx = db.transaction(st);
          const q = tx.objectStore(st).getAll();
          const kq = tx.objectStore(st).getAllKeys();
          tx.oncomplete = () => res({ keys: kq.result, vals: q.result });
        });
        out.dbs[d.name + "/" + st] = { keys: vals.keys, text: ser(vals.vals) };
      }
      db.close();
    }
    for (let i = 0; i < localStorage.length; i++) out.ls[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
    for (let i = 0; i < sessionStorage.length; i++) out.ss[sessionStorage.key(i)] = sessionStorage.getItem(sessionStorage.key(i));
    return out;
  });

(async () => {
  PA = Number(process.env.PORT_A) || (await freePort());
  PB = Number(process.env.PORT_B) || (await freePort());
  A = `http://127.0.0.1:${PA}`;
  B = `http://127.0.0.1:${PB}`;
  setupHomes();
  const adminA = await startGw("A");
  const adminB = await startGw("B");
  const admin = { local: [A, adminA], vps1: [B, adminB] };
  ok("setup: two separate real gateway processes up (own state dirs)", states.A !== states.B, { A, B, stateA: path.basename(states.A), stateB: path.basename(states.B) });

  // ---- owner setup per instalacao.md: config with scope first, then issuer (pair caps) + revoker, explicit ttl ----
  const SCOPE = { local: { sessions: ["outro-main"], agents: ["outro"] }, vps1: { sessions: ["main", "outro-main"], agents: [] } };
  // mode "revoker": the optional revoker key (http on local, cli over ssh on vps1); mode "manual": no revoke field (the default)
  const config = (over = {}, inst = {}, mode = "revoker") => ({
    allowedOrigins: [ORIGIN],
    linkTtlDays: 60,
    chat: { whatsapp: "https://wa.me/5500000000000", slack: "https://example-workspace.slack.com/app_redirect?channel=D0000000000" },
    installations: {
      local: { baseUrl: A, reach: { type: "http", url: A, issuerKeyFile: "~/.ravi/pairing/local.issuer.key" }, revoke: mode === "manual" ? undefined : { via: "http", keyFile: "~/.ravi/pairing/revoker.key" }, scope: SCOPE.local, ...(inst.local || {}) },
      vps1: { baseUrl: B, reach: { type: "ssh", alias: "vps1", issuerKeyFile: "~/.ravi/pairing/issuer.key", ravi: "ravi" }, revoke: mode === "manual" ? undefined : { via: "cli", keyFile: "~/.ravi/pairing/revoker.key" }, scope: SCOPE.vps1, ...(inst.vps1 || {}) },
    },
    ...over,
  });
  write0600(CONF, JSON.stringify(config(), null, 2));
  const capsA = pair(["caps", "local"]);
  const capsB = pair(["caps", "vps1"]);
  const CAPS_A = capsA.json && capsA.json.allow;
  const CAPS_B = capsB.json && capsB.json.allow;
  ok("S1 pair caps: issuer --allow per installation = read:context:info + issue + conversar + named scope, no wildcard, no events, no revoke", CAPS_A === "read:context:info,mutate:context:issue,read:context:whoami,read:sessions:list,read:sessions:info,read:agents:list,mutate:sessions:send,access:session:outro-main,view:agent:outro" && CAPS_B === "read:context:info,mutate:context:issue,read:context:whoami,read:sessions:list,read:sessions:info,read:agents:list,mutate:sessions:send,access:session:main,access:session:outro-main", { CAPS_A, CAPS_B });
  const issA = await gw(A, "context/issue", adminA, { cliName: "pairing-issuer", allow: CAPS_A, ttl: "89d" });
  const issB = await gw(B, "context/issue", adminB, { cliName: "pairing-issuer", allow: CAPS_B, ttl: "89d" });
  const rvA = await gw(A, "context/issue", adminA, { cliName: "pairing-revoker", allow: "mutate:context:revoke,read:context:info", ttl: "89d" });
  const rvB = await gw(B, "context/issue", adminB, { cliName: "pairing-revoker", allow: "mutate:context:revoke,read:context:info", ttl: "89d" });
  ok("setup: issuer and revoker (2 caps) keys on each gateway", [issA, issB, rvA, rvB].every((x) => x.status === 200), [issA, issB, rvA, rvB].map((x) => x.status + "/" + (x.json && x.json.capabilitiesCount)));
  write0600(path.join(HOME_L, ".ravi", "pairing", "local.issuer.key"), issA.json.contextKey);
  write0600(path.join(HOME_L, ".ravi", "pairing", "revoker.key"), rvA.json.contextKey);
  write0600(path.join(HOME_R, ".ravi", "pairing", "issuer.key"), issB.json.contextKey);
  write0600(path.join(HOME_R, ".ravi", "pairing", "revoker.key"), rvB.json.contextKey);
  const st0 = pair(["status", "--probe"]);
  ok("pair status --probe: both installations reachable, no PROBLEMA, no key printed", st0.code === 0 && st0.json.installations.every((i) => !i.problem && i.issuerExpiresAt) && !st0.raw.includes("rctx_"), st0.json ? st0.json.installations.map((i) => `${i.name}:${i.reach}:${i.problem || "ok"}`) : st0.raw.slice(0, 200));

  const browser = await chromium.launch();
  const prof1 = await setupContext(await browser.newContext());

  // ================= 1. link once with preset ver =================
  let page = await visit(prof1);
  ok("T1a first visit: both not-linked", JSON.stringify(await stateOf(page)) === JSON.stringify({ local: "not-linked", vps1: "not-linked" }), await stateOf(page));
  await page.click("[data-rc=connect]");
  await page.waitForSelector("[data-rc=phrase]");
  let phrase1 = (await page.textContent("[data-rc=phrase]")).trim();
  let req1 = await page.inputValue("[data-rc=request]");
  let c1 = pair(["check", req1]);
  ok("T1b check: same 3-word phrase as the page, confirmation from parsed fields (origin, local+vps1, ver, per-installation scope, 60 dias, 'sim <FRASE>')", c1.code === 0 && c1.json.phrase === phrase1 && /Página: https:\/\/exemplo-painel\.ravi\.page/.test(c1.json.confirmation) && c1.json.confirmation.includes("Instalações: local, vps1") && c1.json.confirmation.includes("60 dias") && c1.json.confirmation.includes("- local: sessões outro-main; agentes outro") && c1.json.confirmation.includes("- vps1: sessões main, outro-main; agentes (só o próprio)") && c1.json.confirmation.includes(`"sim ${phrase1}"`) && c1.json.confirmation.includes("texto das conversas"), { page: phrase1, helper: c1.json && c1.json.phrase, confirmation: c1.json && c1.json.confirmation });
  const p0 = pair(["approve", req1]);
  const p1 = pair(["approve", req1, "--phrase", "CEDRO-FAROL-UVA"]);
  const p1b = pair(["approve", req1, "--phrase", phrase1]);
  ok("P1 approve without --phrase: usage error (exit 2); with a different phrase: PHRASE_MISMATCH (exit 3), nothing issued, and the request is cancelled (the right phrase afterwards -> NONCE_REUSED)", p0.code === 2 && p1.code === 3 && errc(p1) === "PHRASE_MISMATCH" && p1b.code === 3 && errc(p1b) === "NONCE_REUSED" && !(readLedgerSafe().links || []).some((l) => l.phrase === phrase1), [p0.code, errc(p0), p1.code, errc(p1), errc(p1b)]);
  // the page: cancel, Conectar again (new request, new phrase)
  await page.click("[data-rc=cancel]");
  await page.click("[data-rc=connect]");
  await page.waitForSelector("[data-rc=phrase]");
  phrase1 = (await page.textContent("[data-rc=phrase]")).trim();
  req1 = await page.inputValue("[data-rc=request]");
  c1 = pair(["check", req1]);
  const a1 = pair(["approve", req1, "--phrase", phrase1.toLowerCase().replace(/-/g, " ")]);
  ok("T1c approve: one link per installation, ~60 days, no rctx_ in helper output", a1.code === 0 && a1.json.installs.length === 2 && a1.json.failed.length === 0 && !a1.raw.includes("rctx_") && a1.json.installs.every((i) => Math.abs((i.expiresAt - Date.now()) / 86400000 - 60) < 0.01), a1.json ? a1.json.installs.map((i) => `${i.name}:${((i.expiresAt - Date.now()) / 86400000).toFixed(3)}d`) : a1.raw.slice(0, 300));
  const linkIds = Object.fromEntries(a1.json.installs.map((i) => [i.name, i.contextId]));
  // link context as seen by each gateway's admin
  const infoL = await gw(A, "context/info", adminA, { contextId: linkIds.local });
  const infoV = await gw(B, "context/info", adminB, { contextId: linkIds.vps1 });
  const crossV = await gw(A, "context/info", adminA, { contextId: linkIds.vps1 });
  const VER = ["read:agents:list", "read:context:whoami", "read:sessions:info", "read:sessions:list"];
  const scopeCaps = (n) => [...SCOPE[n].sessions.map((x) => "access:session:" + x), ...SCOPE[n].agents.map((x) => "view:agent:" + x)];
  const wantAccess = (n, extra = []) => [...VER, ...extra, ...scopeCaps(n)].sort();
  const wantLinkOf = (n, extra = []) => ["mutate:context:issue", ...wantAccess(n, extra)].sort();
  ok("T1d link contexts live on their own gateway with exactly issue + ver + that installation's named scope; parent = that gateway's issuer", infoL.status === 200 && infoV.status === 200 && JSON.stringify(capsOf(infoL.json)) === JSON.stringify(wantLinkOf("local")) && JSON.stringify(capsOf(infoV.json)) === JSON.stringify(wantLinkOf("vps1")) && infoL.json.parentContextId === issA.json.contextId && infoV.json.parentContextId === issB.json.contextId && crossV.status !== 200, { local: capsOf(infoL.json), vps1parent: infoV.json && infoV.json.parentContextId === issB.json.contextId, vps1OnA: crossV.status });
  const sshLog = fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, "utf8") : "";
  ok("T1e vps1 issued through the ssh stand-in (real CLI behind it) with -a, -x, ForwardX11=no, ClearAllForwardings, BatchMode, ConnectTimeout; PATH prefix; remote key mode checked before cat; no key in ssh argv", sshLog.includes("-o BatchMode=yes -o ConnectTimeout=10") && sshLog.includes(' -- vps1 PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; ') && sshLog.includes("-a -x") && sshLog.includes("ForwardX11=no") && sshLog.includes("ClearAllForwardings=yes") && sshLog.includes("vps1") && !sshLog.includes("rctx_") && sshLog.includes("--ttl '60d'") && /stat -c %a "\$f"/.test(sshLog), sshLog.split("\n")[0].slice(0, 260));

  await page.fill("[data-rc=envelope]", a1.json.envelope);
  await page.click("[data-rc=paste]");
  await page.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 10000 });
  const who1 = await page.evaluate(async () => {
    const out = {};
    for (const i of window.conn.installs.values()) {
      const w = await i.call("context/whoami");
      const ag = await i.call("agents/list");
      const se = await i.call("sessions/list");
      const pick = (j) => (Array.isArray(j) ? j : j.sessions || j.agents || j.items || []).map((x) => x.name || x.id || x.sessionKey).sort();
      let infoOut = null;
      try {
        await i.call("sessions/info", { nameOrKey: "segredo" });
        infoOut = "visible";
      } catch (e) {
        infoOut = e.status + " " + e.code;
      }
      const infoIn = await i.call("sessions/info", { nameOrKey: "outro-main" }).then(() => 200, (e) => e.status + " " + e.code);
      out[i.name] = { id: w.contextId, parent: w.parentContextId, issuedFor: w.issuedFor, caps: w.capabilities.map((c) => (typeof c === "string" ? c : `${c.permission}:${c.objectType}:${c.objectId}`)).sort(), ttlMin: (w.expiresAt - Date.now()) / 60000, agents: pick(ag), sessions: pick(se), infoOutOfScope: infoOut, infoInScope: infoIn };
    }
    return out;
  });
  ok("T1f both installations give working <=1h access keys (children of their link) with exactly ver + that installation's scope", ["local", "vps1"].every((n) => who1[n] && who1[n].parent === linkIds[n] && JSON.stringify(who1[n].caps) === JSON.stringify(wantAccess(n)) && who1[n].ttlMin <= 60 && who1[n].ttlMin > 58) && who1.local.id !== who1.vps1.id, Object.fromEntries(Object.entries(who1).map(([k, v]) => [k, { parentIsLink: v.parent === linkIds[k], ttlMin: v.ttlMin.toFixed(1), caps: v.caps }])));
  ok("T1h scoping: sessions list = exactly the configured sessions (not 'segredo'), agents list = own agent (bootstrap) + configured agents, info in scope 200, out of scope not found", JSON.stringify(who1.local.sessions) === '["outro-main"]' && JSON.stringify(who1.vps1.sessions) === '["main","outro-main"]' && JSON.stringify(who1.local.agents) === '["bootstrap","outro"]' && JSON.stringify(who1.vps1.agents) === '["bootstrap"]' && who1.local.infoInScope === 200 && who1.vps1.infoInScope === 200 && /^422/.test(who1.local.infoOutOfScope) && /^422/.test(who1.vps1.infoOutOfScope), Object.fromEntries(Object.entries(who1).map(([k, v]) => [k, { sessions: v.sessions, agents: v.agents, infoIn: v.infoInScope, infoOut: v.infoOutOfScope }])));
  // streams: the events firehose is refused; a scoped session stream opens; an out-of-scope one is refused
  const streamStatus = async (base, key, ch) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    try {
      const r = await fetch(`${base}/api/v1/_stream/${ch}`, { headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" }, signal: ac.signal });
      ac.abort();
      return r.status;
    } catch (e) {
      return "abort";
    } finally {
      clearTimeout(t);
    }
  };
  const accKeys = await page.evaluate(async () => Object.fromEntries(await Promise.all([...window.conn.installs.values()].map(async (i) => [i.name, await i.key()]))));
  const strm = {};
  for (const [n, base] of [["local", A], ["vps1", B]]) strm[n] = { events: await streamStatus(base, accKeys[n], "events"), inScope: await streamStatus(base, accKeys[n], "sessions/outro-main"), outOfScope: await streamStatus(base, accKeys[n], "sessions/segredo") };
  ok("T1i streams: events (whole bus) 403 on both; sessions/outro-main (in scope) 200; sessions/segredo 403", ["local", "vps1"].every((n) => strm[n].events === 403 && strm[n].inScope === 200 && strm[n].outOfScope === 403), strm);
  const esc1 = await page.evaluate(async () => {
    const out = {};
    for (const i of window.conn.installs.values()) {
      const post = (c, b) => i.fetch("/api/v1/" + c, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.status);
      out[i.name] = [await post("context/issue", { cliName: "x", allow: "admin:system:*", ttl: "1h" }), await post("context/revoke", { contextId: "ctx_x" }), await post("sessions/send", { nameOrKey: "outro-main", prompt: "oi" }), await post("context/issue", { cliName: "x", allow: "access:session:segredo", ttl: "1h" })];
    }
    return out;
  });
  ok("T1g access key under ver: issue admin 403, context revoke 403, sessions send (in-scope session) 403, issuing itself an out-of-scope session 403, on both", ["local", "vps1"].every((n) => esc1[n].every((s) => s === 403)), esc1);

  // ================= 2. nothing containing rctx_ at rest =================
  const dump = await dumpStorage(page);
  const allText = JSON.stringify(dump);
  ok("T2 no rctx_ anywhere in IndexedDB (all dbs/stores), localStorage, sessionStorage; stored private key non-extractable", !allText.includes("rctx_") && Object.keys(dump.ls).length === 0 && Object.keys(dump.ss).length === 0 && Object.values(dump.dbs).some((v) => v.text.includes('"extractable":false')) && !Object.values(dump.dbs).some((v) => v.text.includes('"extractable":true')), { stores: Object.fromEntries(Object.entries(dump.dbs).map(([k, v]) => [k, v.keys])), bytes: allText.length, ls: Object.keys(dump.ls).length, hasRctx: allText.includes("rctx_"), keyMarks: (allText.match(/cryptoKey[^}]*}/g) || []).slice(0, 3), sample: Object.values(dump.dbs)[0].text.slice(0, 300) });
  await page.close();

  // ================= 3. second visit, same profile =================
  page = await visit(prof1);
  const back = await page.evaluate(async () => ({ st: window.conn.snapshot().map((s) => s.state), pending: !!window.conn.pending, ids: Object.fromEntries(await Promise.all([...window.conn.installs.values()].map(async (i) => [i.name, (await i.call("context/whoami")).contextId]))) }));
  ok("T3a second visit (new tab, same profile): linked with no approval, fresh access keys", back.st.every((s) => s === "linked") && !back.pending && back.ids.local !== who1.local.id && back.ids.vps1 !== who1.vps1.id, back);
  await page.close();
  // Real browser restart: persistent profile on disk, closed and reopened.
  try {
    const udd = fs.mkdtempSync(path.join(RUN, "profile-"));
    let pc = await setupContext(await chromium.launchPersistentContext(udd));
    let pp = await visit(pc);
    await pp.click("[data-rc=connect]");
    await pp.waitForSelector("[data-rc=phrase]");
    const rq = await pp.inputValue("[data-rc=request]");
    const ap = checkApprove(rq).approve;
    await pp.fill("[data-rc=envelope]", ap.json.envelope);
    await pp.click("[data-rc=paste]");
    await pp.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 10000 });
    await pc.close();
    pc = await setupContext(await chromium.launchPersistentContext(udd));
    pp = await visit(pc);
    const st = await stateOf(pp);
    ok("T3b browser fully closed and reopened (persistent profile on disk): still linked, no approval", st.local === "linked" && st.vps1 === "linked", st);
    await pc.close();
    fs.rmSync(udd, { recursive: true, force: true });
    pair(["disconnect", ap.json.phrase]);
  } catch (e) {
    ok("T3b browser fully closed and reopened (persistent profile on disk): still linked, no approval", false, "could not run: " + e.message.slice(0, 200));
  }

  // ================= 4. another browser profile cannot open the envelope =================
  const prof2 = await setupContext(await browser.newContext());
  const p2 = await visit(prof2);
  const noPending = await p2.evaluate(async (env) => {
    try {
      await window.conn.accept(env);
      return "OPENED";
    } catch (e) {
      return "refused: " + e.message;
    }
  }, a1.json.envelope);
  const hash1 = JSON.parse(Buffer.from(a1.json.envelope.slice(17), "base64url").toString()).h;
  const reqObj1 = JSON.parse(Buffer.from(req1.slice(16), "base64url").toString());
  const withPending = await p2.evaluate(
    async ({ request, hash, env }) => {
      await window.conn.connect();
      const db = await new Promise((res) => {
        const q = indexedDB.open("ravi-connect", 1);
        q.onsuccess = () => res(q.result);
      });
      const pend = await new Promise((res) => {
        const q = db.transaction("kv").objectStore("kv").get("pending");
        q.onsuccess = () => res(q.result);
      });
      pend.request = request; // the owner's public request, attacker's own private key
      pend.hash = hash;
      await new Promise((res) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(pend, "pending");
        tx.oncomplete = res;
      });
      db.close();
      try {
        await window.conn.accept(env);
        return "OPENED";
      } catch (e) {
        return "refused: " + e.name + " " + e.message;
      }
    },
    { request: reqObj1, hash: hash1, env: a1.json.envelope },
  );
  const p2state = await stateOf(p2);
  ok("T4 another browser profile cannot open the owner's envelope (with no pending, and with the owner's request forged into its pending)", noPending.startsWith("refused") && withPending.startsWith("refused") && p2state.local !== "linked", { noPending, withPending, p2state });
  await prof2.close();

  // ================= 5..10 hostile requests and config =================
  const r5 = pair(["check", req1]);
  const r5b = pair(["approve", req1, "--phrase", phrase1]);
  ok("T5 reused request refused: check -> NONCE_REUSED, approve -> refused (exit 3)", r5.code === 3 && errc(r5) === "NONCE_REUSED" && r5b.code === 3, [errc(r5), errc(r5b)]);
  const old11 = await nodeRequest({ iat: Date.now() - 11 * 60 * 1000, installs: ["local", "vps1"] });
  const old10 = await nodeRequest({ iat: Date.now() - 10 * 60 * 1000 + 3000 });
  const r6 = pair(["check", old11.text]);
  const r6b = pair(["check", old10.text]);
  ok("T6 request older than 10 minutes refused (REQUEST_TOO_OLD); 9m57s accepted", r6.code === 3 && errc(r6) === "REQUEST_TOO_OLD" && r6b.code === 0, [errc(r6), r6b.code]);
  // P2: two checked requests waiting -> approve refused; cancel clears both
  const second = await nodeRequest();
  const c2 = pair(["check", second.text]);
  const multi = pair(["approve", second.text, "--phrase", c2.json.phrase]);
  const canc = pair(["cancel"]);
  const afterCancel = pair(["approve", old10.text, "--phrase", r6b.json.phrase]);
  ok("P2 two checked requests waiting: approve refused MULTIPLE_PENDING; cancel cancels both; approving a cancelled one -> NONCE_REUSED", multi.code === 3 && errc(multi) === "MULTIPLE_PENDING" && canc.code === 0 && canc.json.cancelled === 2 && afterCancel.code === 3 && errc(afterCancel) === "NONCE_REUSED", { multi: errc(multi), cancelled: canc.json && canc.json.cancelled, afterCancel: errc(afterCancel) });
  // P3: approve requires iat <= 15 min even if the check was recent (ledger forged to look freshly checked)
  {
    const oldR = await nodeRequest({ iat: Date.now() - 16 * 60 * 1000 });
    const raw = Buffer.from(oldR.text.slice(16), "base64url").toString();
    const hash = Buffer.from(require("crypto").createHash("sha256").update(raw).digest()).toString("base64url");
    const lp = path.join(HOME_L, ".ravi", "pairing", "ledger.json");
    const L = JSON.parse(fs.readFileSync(lp, "utf8"));
    L.nonces[oldR.req.nonce] = { hash, origin: ORIGIN, preset: "ver", installs: ["local"], phrase: "X-Y-Z", iat: oldR.req.iat, checkedAt: Date.now(), state: "checked" };
    fs.writeFileSync(lp, JSON.stringify(L), { mode: 0o600 });
    const late = pair(["approve", oldR.text, "--phrase", "X-Y-Z"]);
    pair(["cancel"]);
    ok("P3 approve refuses a request whose iat is older than 15 minutes (REQUEST_TOO_OLD), even with a fresh check", late.code === 3 && errc(late) === "REQUEST_TOO_OLD", errc(late));
  }
  const origins = ["https://outro-projeto.ravi.page", "https://exemplo-painel.ravi.page.evil.example", "http://exemplo-painel.ravi.page", "https://EXEMPLO-painel.ravi.page", "https://exemplo-painel.ravi.page:443", "https://exemplo-painel.ravi.page/"];
  const r7 = [];
  for (const o of origins) r7.push(errc(pair(["check", (await nodeRequest({ origin: o })).text])));
  ok("T7 origin outside the allowlist refused (other project, suffix look-alike, http, case, port, trailing slash)", r7.every((c) => c === "ORIGIN_NOT_ALLOWED" || c === "SCHEMA"), Object.fromEntries(origins.map((o, i) => [o, r7[i]])));
  const bad = {
    preset_admin: (await nodeRequest({ preset: "admin" })).text,
    preset_admin_cap: (await nodeRequest({ preset: "admin:system:*" })).text,
    preset_proto: (await nodeRequest({ preset: "constructor" })).text,
    preset_proto2: (await nodeRequest({ preset: "__proto__" })).text,
    extra_caps_field: (await nodeRequest({ extra: { caps: ["admin:system:*"] } })).text,
    extra_allow_field: (await nodeRequest({ extra: { allow: "admin:system:*" } })).text,
    install_wildcard: (await nodeRequest({ installs: ["*"] })).text,
    install_unknown: (await nodeRequest({ installs: ["prod-db"] })).text,
  };
  const r8 = Object.fromEntries(Object.entries(bad).map(([k, t]) => [k, pair(["check", t])]));
  ok("T8 unknown preset and every way to add admin:system:* refused at check (exit 3)", Object.values(r8).every((r) => r.code === 3), Object.fromEntries(Object.entries(r8).map(([k, r]) => [k, errc(r)])));
  // ttl
  const ttlCases = { "0": 0, "61": 61, "-1": -1, "60.5": 60.5, '"60"': "60", "1e3": 1000 };
  const r9 = {};
  for (const [k, v] of Object.entries(ttlCases)) {
    write0600(CONF, JSON.stringify(config({ linkTtlDays: v })));
    const rq = await nodeRequest();
    r9[k] = pair(["check", rq.text]);
  }
  write0600(CONF, JSON.stringify(config(), null, 2));
  ok("T9 link ttl of 0, above 60 days, negative, fractional, string refused before any issue", Object.values(r9).every((r) => r.code === 3 || r.code === 2), Object.fromEntries(Object.entries(r9).map(([k, r]) => [k, errc(r)])));

  // ================= 10. a link key cannot call context revoke =================
  const nr = await nodeRequest({ installs: ["local", "vps1"] });
  const na = checkApprove(nr.text).approve;
  const grant = await nodeOpen(na.json.envelope, nr.priv, nr.canonText, ORIGIN);
  const t10 = {};
  for (const gi of grant.installs) {
    const [base, adm] = admin[gi.name];
    const target = gi.name === "local" ? issA.json.contextId : issB.json.contextId;
    const rev = await gw(base, "context/revoke", gi.linkKey, { contextId: target, reason: "attack" });
    const revSelf = await gw(base, "context/revoke", gi.linkKey, { contextId: gi.contextId });
    const issAdm = await gw(base, "context/issue", gi.linkKey, { cliName: "x", allow: "admin:system:*", ttl: "1h" });
    const issRev = await gw(base, "context/issue", gi.linkKey, { cliName: "x", allow: "mutate:context:revoke", ttl: "1h" });
    const prune = await gw(base, "context/prune", gi.linkKey, {});
    const issuerAlive = await gw(base, "context/whoami", gi.name === "local" ? issA.json.contextKey : issB.json.contextKey, {});
    // design probe: ttl 0 / long ttl from the link key
    const t0 = await gw(base, "context/issue", gi.linkKey, { cliName: "x", allow: "read:context:whoami", ttl: "0m" });
    const t90 = await gw(base, "context/issue", gi.linkKey, { cliName: "x", allow: "read:context:whoami,mutate:context:issue", ttl: "59d" });
    t10[gi.name] = { revokeIssuer: rev.status, revokeSelf: revSelf.status, issueAdmin: issAdm.status, issueRevoke: issRev.status, prune: prune.status, issuerAlive: issuerAlive.status, ttl0Days: t0.json && t0.json.expiresAt ? ((t0.json.expiresAt - Date.now()) / 86400000).toFixed(2) : t0.status, ttl59dDays: t90.json && t90.json.expiresAt ? ((t90.json.expiresAt - Date.now()) / 86400000).toFixed(2) : t90.status };
  }
  ok("T10 the link key itself (opened from the envelope) cannot context revoke (issuer or itself), cannot mint admin or revoke children, cannot prune", ["local", "vps1"].every((n) => t10[n].revokeIssuer === 403 && t10[n].revokeSelf === 403 && t10[n].issueAdmin === 403 && t10[n].issueRevoke === 403 && [403, 404].includes(t10[n].prune) && t10[n].issuerAlive === 200), t10);
  if (Number(t10.local.ttl0Days) > 1 || Number(t10.local.ttl59dDays) > 1)
    note({ severity: "medium", where: "design (link key holds mutate:context:issue) / assets/connect.js mint()", problem: `The '1-hour access key' is enforced only by connect.js. Anyone holding the opened link key (any script on the project origin, see limites.md) can call context/issue with ttl '0m' (inherits the link's 60 days: got ${t10.local.ttl0Days} d) or '59d' (got ${t10.local.ttl59dDays} d), and can delegate mutate:context:issue onward, so stolen children outlive a later page reload; revoking the link does cascade and kill them.`, fix: "Document it in limites.md next to 'O link aberto é portador'; longer term needs a gateway-side max child ttl per context (PEDIDO-LUIS.md)." });
  pair(["disconnect", na.json.phrase]);

  // ================= 11. stop one gateway: offline vs linked =================
  page = await visit(prof1);
  await stopGw("B");
  const live = await page.evaluate(async () => {
    const out = {};
    for (const i of window.conn.installs.values()) {
      try {
        await i.call("context/whoami");
        out[i.name] = "ok";
      } catch (e) {
        out[i.name] = e.state;
      }
    }
    return { calls: out, st: window.conn.snapshot().map((s) => s.name + ":" + s.state) };
  });
  const vpsText = await page.textContent("[data-rc-install=vps1]");
  await page.close();
  page = await visit(prof1);
  const reload = await stateOf(page);
  ok("T11a gateway B process stopped: vps1 offline (live call and fresh reload), local stays linked; card text says offline", live.calls.vps1 === "offline" && live.calls.local === "ok" && reload.vps1 === "offline" && reload.local === "linked" && /offline/.test(vpsText), { live, reload, vpsText });
  // partial approval while vps1 is down
  const pr = await nodeRequest({ installs: ["local", "vps1"] });
  const pa = checkApprove(pr.text).approve;
  ok("T11b approve while vps1 is down: local link issued, vps1 reported failed, no key in output", pa.code === 0 && pa.json.installs.length === 1 && pa.json.installs[0].name === "local" && pa.json.failed.length === 1 && pa.json.failed[0].name === "vps1" && !pa.raw.includes("rctx_"), pa.json ? { installs: pa.json.installs.map((i) => i.name), failed: pa.json.failed } : pa.raw.slice(0, 300));
  pair(["disconnect", pa.json.phrase]);
  await startGw("B");
  const recovered = await page.evaluate(async () => {
    const v = window.conn.installs.get("vps1");
    await v.key();
    const w = await v.call("context/whoami");
    return { st: v.state, ok: !!w.contextId };
  });
  ok("T11c gateway B restarted on the same port/state: vps1 back to linked without approval (link survived the restart)", recovered.st === "linked" && recovered.ok, recovered);

  // ================= 12. disconnect =================
  const d1 = pair(["disconnect", phrase1.toLowerCase().replace(/-/g, " "), "--install", "vps1"]);
  const afterD1 = await page.evaluate(async () => {
    const v = window.conn.installs.get("vps1");
    const l = window.conn.installs.get("local");
    const m0 = v.mints;
    let err = null;
    try {
      await v.call("context/whoami");
    } catch (e) {
      err = e.state + " " + e.code;
    }
    try {
      await v.call("context/whoami");
    } catch {}
    const lw = await l.call("context/whoami");
    return { err, mintsDelta: v.mints - m0, vps: v.state, local: l.state, localOk: !!lw.contextId };
  });
  const vpsLinkInfo = await gw(B, "context/info", adminB, { contextId: linkIds.vps1 });
  ok("T12a disconnect <phrase as typed in chat> --install vps1 (revoked on gateway B via ssh stand-in): vps1 -> reconnect (AUTH_REQUIRED, no new mint), local still linked", d1.code === 0 && afterD1.err === "reconnect AUTH_REQUIRED" && afterD1.mintsDelta === 0 && afterD1.vps === "reconnect" && afterD1.local === "linked", { d1: d1.json ? d1.json.results : d1.raw.slice(0, 200), afterD1, vpsLinkRevoked: vpsLinkInfo.json && (vpsLinkInfo.json.revokedAt || vpsLinkInfo.json.revoked || vpsLinkInfo.status) });
  const cardBtn = await page.$("[data-rc=connect]");
  // independent re-link of vps1 only
  await page.click("[data-rc=connect]");
  await page.waitForSelector("[data-rc=phrase]");
  const reqV = await page.inputValue("[data-rc=request]");
  const reqVobj = JSON.parse(Buffer.from(reqV.slice(16), "base64url").toString());
  const aV = checkApprove(reqV).approve;
  await page.fill("[data-rc=envelope]", aV.json.envelope);
  await page.click("[data-rc=paste]");
  await page.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 10000 });
  ok("T12b page offers Conectar for the revoked one; new request asks only vps1; after paste both linked again", !!cardBtn && JSON.stringify(reqVobj.installs) === '["vps1"]' && aV.code === 0, { installs: reqVobj.installs, newPhrase: aV.json.phrase !== phrase1 });
  const d2 = pair(["disconnect", ORIGIN]);
  const oldAccess = await page.evaluate(async () => window.conn.installs.get("local").key());
  const deadOld = await gw(A, "context/whoami", oldAccess, {});
  await page.close();
  page = await visit(prof1);
  const st12 = await stateOf(page);
  const txt12 = await page.textContent("[data-rc=status]");
  const hasConnect = !!(await page.$("[data-rc=connect]"));
  ok("T12c disconnect <origin>: every recorded link on both gateways revoked; open access key 401; reload shows 'precisa reconectar' for both and a Conectar button", d2.code === 0 && d2.json.results.every((r) => r.result === "revogada") && deadOld.status === 401 && st12.local === "reconnect" && st12.vps1 === "reconnect" && hasConnect, { results: d2.json && d2.json.results.map((r) => r.name + ":" + r.result), deadOld: deadOld.status + " " + (deadOld.json && deadOld.json.error && deadOld.json.error.code), st12, txt12 });
  const issuersAlive = [(await gw(A, "context/whoami", issA.json.contextKey)).status, (await gw(B, "context/whoami", issB.json.contextKey)).status];
  ok("T12d disconnect revoked only link contexts (issuer keys on both gateways alive)", issuersAlive.every((s) => s === 200), issuersAlive);
  const again = pair(["disconnect", phrase1]);
  ok("T12e disconnect again: nothing to revoke, exit 0", again.code === 0, again.json ? again.json.results : again.raw.slice(0, 200));
  await page.close();

  // ================= 13. preset conversar =================
  const prof3 = await setupContext(await browser.newContext());
  page = await visit(prof3, "?preset=conversar");
  await page.click("[data-rc=connect]");
  await page.waitForSelector("[data-rc=phrase]");
  const reqC = await page.inputValue("[data-rc=request]");
  const { check: cC, approve: aC } = checkApprove(reqC);
  await page.fill("[data-rc=envelope]", aC.json.envelope);
  await page.click("[data-rc=paste]");
  await page.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 10000 });
  const whoC = await page.evaluate(async () => {
    const out = {};
    for (const i of window.conn.installs.values()) {
      const w = await i.call("context/whoami");
      const sendTo = async (nameOrKey) => {
        try {
          const r = await i.fetch("/api/v1/sessions/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nameOrKey, prompt: "oi" }), signal: AbortSignal.timeout(8000) });
          return r.status + " " + ((await r.json().catch(() => ({}))).error?.code || "");
        } catch (e) {
          return "timeout (authorization passed; no NATS here)";
        }
      };
      const rev = await i.fetch("/api/v1/context/revoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contextId: "ctx_x" }) });
      out[i.name] = { caps: w.capabilities.map((c) => (typeof c === "string" ? c : `${c.permission}:${c.objectType}:${c.objectId}`)).sort(), sendIn: await sendTo("outro-main"), sendOut: await sendTo("segredo"), revoke: rev.status };
    }
    return out;
  });
  const linkC = {};
  for (const i of aC.json.installs) linkC[i.name] = capsOf((await gw(admin[i.name][0], "context/info", admin[i.name][1], { contextId: i.contextId })).json);
  const sendPassed = (x) => /SESSION_RELAY_FAILED|timeout/.test(x) && !/^403/.test(x);
  ok("T13 preset conversar: access caps = ver + mutate:sessions:send + scope (both gateways); link = that + issue; send to an in-scope session passes authorization, to an out-of-scope one 422 not found; revoke still 403", cC.code === 0 && cC.json.confirmation.includes("conversar") && ["local", "vps1"].every((n) => JSON.stringify(whoC[n].caps) === JSON.stringify(wantAccess(n, ["mutate:sessions:send"])) && JSON.stringify(linkC[n]) === JSON.stringify(wantLinkOf(n, ["mutate:sessions:send"])) && sendPassed(whoC[n].sendIn) && /^422/.test(whoC[n].sendOut) && whoC[n].revoke === 403), { local: whoC.local, vps1: { sendIn: whoC.vps1.sendIn, sendOut: whoC.vps1.sendOut, revoke: whoC.vps1.revoke }, linkCaps: [linkC.local.length, linkC.vps1.length] });
  pair(["disconnect", aC.json.phrase]);

  // ================= fixes from review: pinning, forged grants, config, lock, remote mode, status, NOT_OURS, stage B =================
  const prof4 = await setupContext(await browser.newContext());
  page = await visit(prof4);
  await page.click("[data-rc=connect]");
  await page.waitForSelector("[data-rc=phrase]");
  const req4 = await page.inputValue("[data-rc=request]");
  const tryAccept = (env) => page.evaluate(async (e) => window.conn.accept(e).then(() => "OPENED", (x) => "refused: " + x.message), env);
  const forgedCaps = await nodeSeal(req4, { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_falsa", contextId: "ctx_x", expiresAt: Date.now() + 1e9, caps: [...VER, "admin:system:*"] }] });
  const forgedUrl = await nodeSeal(req4, { installs: [{ name: "local", baseUrl: "https://coletor.example", linkKey: "rctx_falsa", contextId: "ctx_x", expiresAt: Date.now() + 1e9, caps: [...VER] }] });
  const forgedWild = await nodeSeal(req4, { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_falsa", contextId: "ctx_x", expiresAt: Date.now() + 1e9, caps: [...VER, "access:session:*"] }] });
  const fr = [await tryAccept(forgedCaps), await tryAccept(forgedUrl), await tryAccept(forgedWild)];
  ok("F1 page refuses a validly sealed but forged envelope: caps outside the preset (admin), a baseUrl other than the pinned one, a wildcard scope", fr.every((x) => x.startsWith("refused")) && /fora do preset/.test(fr[0]) && /outro endereço/.test(fr[1]) && /fora do preset/.test(fr[2]), fr);
  // the real helper, but configured with another loopback port for local: the pinned page refuses
  write0600(CONF, JSON.stringify(config({}, { local: { baseUrl: "http://127.0.0.1:47899" } })));
  const ap4 = checkApprove(req4).approve;
  write0600(CONF, JSON.stringify(config(), null, 2));
  const fr2 = await tryAccept(ap4.json.envelope);
  const st4 = await stateOf(page);
  ok("F2 helper envelope pointing local to another address: page refuses, nothing linked", ap4.code === 0 && /outro endereço/.test(fr2) && st4.local !== "linked" && st4.vps1 !== "linked", { fr2, st4 });
  pair(["disconnect", ap4.json.phrase]);
  const bad4 = await page.evaluate(async () => {
    const m = await import("/connect.js");
    const t = (o) => { try { m.createConnect(o); return "accepted"; } catch (e) { return "refused"; } };
    return [t({ installations: ["local"] }), t({ installations: { local: "https://coletor.example" } }), t({ installations: { local: "http://10.0.0.5:4211" } }), t({ installations: { local: "http://127.0.0.1:4211" }, preset: "admin" })];
  });
  ok("F3 createConnect refuses the array form, a non-loopback address and an unknown preset", bad4.every((x) => x === "refused"), bad4);
  await page.close();
  await prof4.close();

  // config validation
  const cfgCases = {
    scope_wildcard: config({}, { local: { scope: { sessions: ["*"], agents: [] } } }),
    scope_relation: config({}, { local: { scope: { sessions: ["access:session:x"], agents: [] } } }),
    scope_missing: config({}, { local: { scope: undefined } }),
    baseUrl_remote: config({}, { local: { baseUrl: "https://coletor.example" } }),
  };
  const cfgR = {};
  for (const [k, v] of Object.entries(cfgCases)) {
    write0600(CONF, JSON.stringify(v));
    cfgR[k] = pair(["check", (await nodeRequest()).text]);
  }
  write0600(CONF, JSON.stringify(config(), null, 2));
  ok("F4 config refused (exit 2) for a wildcard or relation-shaped scope name, a missing scope, a non-loopback baseUrl", Object.values(cfgR).every((r) => r.code === 2), Object.fromEntries(Object.entries(cfgR).map(([k, r]) => [k, errc(r)])));

  // stale lock
  const lockP = path.join(HOME_L, ".ravi", "pairing", "ledger.json.lock");
  fs.writeFileSync(lockP, `999999 ${Date.now()}\n`);
  const lk1 = pair(["list"]);
  fs.writeFileSync(lockP, `${process.pid} ${Date.now() - 60000}\n`);
  const lk2 = pair(["list"]);
  fs.writeFileSync(lockP, `${process.pid} ${Date.now()}\n`);
  const lk3 = pair(["list"]);
  fs.rmSync(lockP, { force: true });
  ok("F5 ledger lock: dead pid -> broken; live pid but older than 30 s -> broken; live and fresh -> LEDGER_LOCKED (exit 1)", lk1.code === 0 && lk2.code === 0 && lk3.code === 1 && errc(lk3) === "LEDGER_LOCKED", [lk1.code, lk2.code, errc(lk3)]);

  // remote key file mode is checked before cat
  const remoteIssuer = path.join(HOME_R, ".ravi", "pairing", "issuer.key");
  fs.chmodSync(remoteIssuer, 0o644);
  const m6 = checkApprove((await nodeRequest({ installs: ["vps1"] })).text).approve;
  fs.chmodSync(remoteIssuer, 0o600);
  ok("F6 remote issuer key with mode 644: nothing issued on vps1 (KEY_FILE_MODE), no key printed", m6.code === 1 && /KEY_FILE_MODE/.test(m6.raw) && !m6.raw.includes("rctx_"), m6.raw.slice(0, 220));

  // status --probe catches an issuer without the scope relations
  const narrow = await gw(A, "context/issue", adminA, { cliName: "pairing-issuer-old", allow: "mutate:context:issue,read:context:whoami,read:sessions:list,read:sessions:info,read:agents:list", ttl: "1h" });
  write0600(path.join(HOME_L, ".ravi", "pairing", "old.issuer.key"), narrow.json.contextKey);
  write0600(CONF, JSON.stringify(config({}, { local: { reach: { type: "http", url: A, issuerKeyFile: "~/.ravi/pairing/old.issuer.key" } } })));
  const st7 = pair(["status", "--probe"]);
  write0600(CONF, JSON.stringify(config(), null, 2));
  const row7 = st7.json && st7.json.installations.find((i) => i.name === "local");
  ok("F7 status --probe flags an issuer without the scope relations as PROBLEMA; vps1 probe over ssh (remote path quoting) works", !!row7 && /access:session:outro-main/.test(row7.problem || "") && st7.json.installations.find((i) => i.name === "vps1").issuerExpiresAt > 0, { local: row7 && row7.problem, vps1: st7.json && st7.json.installations.find((i) => i.name === "vps1").problem });

  // NOT_OURS: a ledger entry without a parent is never revoked
  const n8 = checkApprove((await nodeRequest({ installs: ["local"] })).text).approve;
  const lp8 = path.join(HOME_L, ".ravi", "pairing", "ledger.json");
  const L8 = JSON.parse(fs.readFileSync(lp8, "utf8"));
  const e8 = L8.links.find((l) => l.phrase === n8.json.phrase);
  const parent8 = e8.installs[0].parentContextId;
  e8.installs[0].parentContextId = null;
  fs.writeFileSync(lp8, JSON.stringify(L8), { mode: 0o600 });
  const d8 = pair(["disconnect", n8.json.phrase]);
  const alive8 = await gw(A, "context/info", adminA, { contextId: n8.json.installs[0].contextId });
  const L8b = JSON.parse(fs.readFileSync(lp8, "utf8"));
  L8b.links.find((l) => l.phrase === n8.json.phrase).installs[0].parentContextId = parent8;
  fs.writeFileSync(lp8, JSON.stringify(L8b), { mode: 0o600 });
  const d8b = pair(["disconnect", n8.json.phrase]);
  ok("F8 disconnect refuses (NOT_OURS) a recorded link whose parent is missing, leaving the context alive; with the parent restored it revokes", d8.json && /NOT_OURS/.test(d8.json.results[0].result) && alive8.status === 200 && !alive8.json.revokedAt && d8b.json && d8b.json.results[0].result === "revogada", { first: d8.json && d8.json.results[0].result.slice(0, 80), alive: alive8.status, second: d8b.json && d8b.json.results[0].result });

  // stage B: chat links + envelope shipped on the private route /_link/<code> of the page's own host, polled same-origin
  const profB = await setupContext(await browser.newContext());
  page = await visit(profB, "?b=1");
  await page.click("[data-rc=connect]");
  await page.waitForSelector("[data-rc=whatsapp]");
  const wa = await page.getAttribute("[data-rc=whatsapp]", "href");
  const slack = await page.getAttribute("[data-rc=slack]", "href");
  const reqB = await page.inputValue("[data-rc=request]");
  const codeB = await page.evaluate(() => window.conn.pending.code);
  ok("B1 stage B: wa.me link carries the request prefilled; Slack copy+open link present", wa === "https://wa.me/5500000000000?text=" + encodeURIComponent(reqB) && slack.includes("app_redirect"), { wa: wa.slice(0, 50) + "...", slack });
  const outDir = path.join(RUN, "link-" + codeB);
  const ab = checkApprove(reqB, ["--out-dir", outDir]).approve;
  ok("B2 stage B approve: envelope only in a 0600 file, route /_link/<code> matches the page, reply has no envelope", ab.code === 0 && ab.json.route === "/_link/" + codeB && (fs.statSync(ab.json.envelopeFile).mode & 0o777) === 0o600 && !ab.raw.includes("rctx_") && !ab.json.envelope && !ab.json.reply.includes("ravi-envelope"), { route: ab.json && ab.json.route });
  await page.fill("[data-rc=envelope]", "texto-colado-antes"); // owner started pasting, then stage B delivered by itself
  published.set("/_link/" + codeB, fs.readFileSync(ab.json.envelopeFile, "utf8"));
  let linkedB = true;
  try {
    await page.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 15000 });
  } catch {
    linkedB = false;
  }
  ok("B3 stage B: page polled its own /_link/<code> and linked both installations with no paste", linkedB, await stateOf(page));
  // B4 probe: after a stage-B delivery, does the old draft reappear in the box of the NEXT request?
  await page.evaluate(() => window.conn.connect(true));
  await page.waitForSelector("[data-rc=envelope]");
  const staleDraft = await page.inputValue("[data-rc=envelope]");
  await page.evaluate(() => window.conn.cancel());
  ok("B4 after a stage-B delivery by polling, the envelope box of the NEXT request is empty (old draft cleared)", staleDraft === "", { boxValue: staleDraft });
  published.set("/_link/" + codeB, "<!doctype html><p>removido</p>");
  fs.rmSync(outDir, { recursive: true, force: true });
  // forget button
  await page.click("[data-rc=forget]");
  await page.click("[data-rc=forget]");
  await page.waitForFunction(() => window.conn.snapshot().every((x) => x.state === "not-linked"));
  const forgot = await page.evaluate(async () => window.storedSummary());
  ok("G1 'Esquecer este navegador' (two clicks): IndexedDB emptied, card back to not linked", forgot.links === 0 && !forgot.pending, forgot);
  await page.close();
  await profB.close();
  pair(["disconnect", ab.json.phrase]);

  // ---------- extra probes ----------
  const ls = pair(["list"]);
  ok("X1 pair list: no keys printed, every link revoked after disconnects", ls.code === 0 && !ls.raw.includes("rctx_") && ls.json.links.every((l) => l.installs.every((i) => i.state === "revogada")), ls.json ? ls.json.links.map((l) => l.phrase + ":" + l.installs.map((i) => i.name + "=" + i.state).join(",")) : ls.raw.slice(0, 200));
  const ledgerMode = (fs.statSync(path.join(HOME_L, ".ravi", "pairing", "ledger.json")).mode & 0o777).toString(8);
  const ledgerText = fs.readFileSync(path.join(HOME_L, ".ravi", "pairing", "ledger.json"), "utf8");
  ok("X2 ledger 0600, no rctx_ in ledger", ledgerMode === "600" && !ledgerText.includes("rctx_"), { ledgerMode });
  // request embedded in chatter (as pasted in WhatsApp with a greeting)
  const chatty = await nodeRequest();
  const rChat = pair(["check", "Oi, segue o pedido: " + chatty.text]);
  const rWrapped = pair(["check", chatty.text.slice(0, 60) + "\n" + chatty.text.slice(60)]);
  ok("X3 request text with a line break inside (chat wrapping) still accepted; text with a leading greeting refused", rWrapped.code === 0 && rChat.code === 3, { wrapped: errc(rWrapped), greeting: errc(rChat) });
  pair(["cancel"]);

  // race: two approve runs of the same checked request in parallel -> exactly one issues
  const race = await nodeRequest({ installs: ["local", "vps1"] });
  const raceC = pair(["check", race.text]);
  const { spawn: sp } = require("child_process");
  const runAsync = () => new Promise((res) => { const p = sp("bun", ["--no-env-file", PAIR, "approve", race.text, "--phrase", raceC.json.phrase, "--json"], { env: pairEnv(), cwd: RUN }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("exit", (c) => res({ code: c, o })); });
  const [ra, rb] = await Promise.all([runAsync(), runAsync()]);
  const linksAfter = JSON.parse(fs.readFileSync(path.join(HOME_L, ".ravi", "pairing", "ledger.json"), "utf8")).links.filter((l) => l.nonce === race.req.nonce).length;
  ok("X4 two parallel approve runs of one checked request: exactly one issues links", [ra.code, rb.code].sort().join(",") === "0,3" && linksAfter === 1, { codes: [ra.code, rb.code], linksAfter });
  pair(["disconnect", ORIGIN]);

  // ================= N. what the moderator changed (default config: revoke manual) =================
  const MANUAL = () => write0600(CONF, JSON.stringify(config({}, {}, "manual"), null, 2));
  MANUAL();
  const PREFIX = 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; ';
  // N1 PATH prefix, ConnectTimeout, BatchMode on every remote call; without the prefix the wrapper is not found
  fs.writeFileSync(SSH_LOG, "");
  const n1r = await nodeRequest({ installs: ["vps1"] });
  const n1 = checkApprove(n1r.text).approve;
  pair(["status", "--probe"]);
  const n1log = fs.readFileSync(SSH_LOG, "utf8").trim().split("\n").filter(Boolean);
  let bare;
  try {
    execFileSync(path.join(E, "bin-local", "ssh"), ["-a", "-o", "ClearAllForwardings=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "vps1", "ravi context whoami --json"], { env: pairEnv(), stdio: ["ignore", "pipe", "pipe"] });
    bare = 0;
  } catch (e) {
    bare = e.status;
  }
  ok("N1 every ssh call carries ConnectTimeout=10 and BatchMode=yes and the remote command starts with the PATH prefix; issue over the real CLI works; the same command without the prefix fails (exit 127, ravi not found in a clean ssh shell)", n1.code === 0 && n1log.length >= 2 && n1log.every((l) => l.includes("-o ConnectTimeout=10") && l.includes("-o BatchMode=yes") && l.includes(" -- vps1 " + PREFIX)) && bare === 127, { approve: n1.code, calls: n1log.length, first: (n1log[0] || "").slice(0, 200), withoutPrefixExit: bare });

  // N2 a hanging VPS: SSH_TIMEOUT; the other installation is still issued, recorded and usable
  fs.writeFileSync(SSH_MODE, "hang");
  const n2r = await nodeRequest({ installs: ["vps1", "local"] });
  const n2t0 = Date.now();
  const n2 = checkApprove(n2r.text, [], { RAVI_CONNECT_SSH_TIMEOUT_MS: "3000" }).approve;
  const n2ms = Date.now() - n2t0;
  fs.writeFileSync(SSH_MODE, "");
  killHangs();
  const n2entry = readLedger().links.find((l) => l.nonce === n2r.req.nonce);
  let n2use = null;
  if (n2.code === 0) {
    const g = await nodeOpen(n2.json.envelope, n2r.priv, n2r.canonText, ORIGIN);
    n2use = (await gw(A, "context/whoami", g.installs[0].linkKey)).status;
  }
  ok("N2 remote that hangs (vps1 first in the request): vps1 fails SSH_TIMEOUT after the configured 3 s (kept in the ledger as pending: it may exist there), local is still issued, recorded and its link works", n2.code === 0 && n2.json.failed.length === 1 && n2.json.failed[0].name === "vps1" && n2.json.failed[0].code === "SSH_TIMEOUT" && n2.json.installs.map((i) => i.name).join() === "local" && n2entry && n2entry.installs.map((i) => i.name + (i.pending ? ":pending" : "")).join() === "vps1:pending,local" && n2use === 200 && n2ms < 30000, { code: n2.code, failed: n2.json && n2.json.failed, installs: n2.json && n2.json.installs.map((i) => i.name), ledger: n2entry && n2entry.installs.map((i) => i.name + (i.pending ? ":pending" : "")), linkWhoami: n2use, ms: n2ms });

  // N2b the remote command finished (link created on the VPS) but the connection hung before the answer came back
  fs.writeFileSync(SSH_MODE, "hang-after");
  const n2br = await nodeRequest({ installs: ["vps1"] });
  const n2bt0 = Date.now();
  const n2b = checkApprove(n2br.text, [], { RAVI_CONNECT_SSH_TIMEOUT_MS: "15000" }).approve;
  const n2bms = Date.now() - n2bt0;
  fs.writeFileSync(SSH_MODE, "");
  killHangs();
  const cliName2b = `connect:${new URL(ORIGIN).host}:${n2br.req.nonce.slice(0, 8)}`;
  const listB = await gw(B, "context/list", adminB, {});
  const ctxs = (listB.json && (listB.json.contexts || listB.json.items || listB.json.data)) || (Array.isArray(listB.json) ? listB.json : []);
  const orphan = ctxs.filter((c) => c.issuedFor === cliName2b && c.status === "active");
  const row2b = (readLedger().links.find((l) => l.nonce === n2br.req.nonce) || { installs: [] }).installs.find((i) => i.name === "vps1");
  const list2b = pair(["list"]);
  const st2b = pair(["status"]);
  const phrase2b = (n2b.raw.match(/desconectar ([A-Z]+-[A-Z]+-[A-Z]+)/) || [])[1] || "x";
  const dc2b = pair(["disconnect", phrase2b]);
  const dcLine2b = dc2b.json && dc2b.json.results[0] && dc2b.json.results[0].result;
  // the owner follows the printed instruction with the real CLI: list, find the cliName, revoke it
  const ownList = ownerCli("B", ["context", "list", "--json", "--fields", "contextId,issuedFor"], adminB);
  const found2b = (() => { try { const j = JSON.parse(ownList.out); return (j.items || j.contexts || []).find((c) => c.issuedFor === cliName2b); } catch { return null; } })();
  const ownRev2b = found2b ? ownerCli("B", ["context", "revoke", found2b.contextId, "--reason", "ravi-connect"], adminB) : { code: "not found" };
  ok("N2b remote issue completed but ssh hung before the answer: SSH_TIMEOUT within the limit; the vps1 row was recorded BEFORE issuing (pending, cliName), the reply says it may exist there; list shows 'emissão interrompida', status lists it; disconnect prints the manual 'context list' + 'context revoke' instruction with that cliName; the owner finds it with the real CLI and revokes it", n2b.code !== 0 && /SSH_TIMEOUT/.test(n2b.raw) && /pode ter sido criada/.test(n2b.raw) && n2bms < 20000 && orphan.length === 1 && row2b && row2b.pending === true && row2b.cliName === cliName2b && list2b.json.links.some((l) => l.installs.some((i) => /emissão interrompida/.test(i.state))) && st2b.json && st2b.json.interrupted.includes(phrase2b + " vps1") && /^manual: a emissão em vps1 foi interrompida/.test(dcLine2b || "") && (dcLine2b || "").includes(cliName2b) && ownRev2b.code === 0, { code: n2b.code, err: errc(n2b), ms: n2bms, activeOnVps: orphan.length, row: row2b, disconnect: (dcLine2b || "").slice(0, 120), ownerRevoke: ownRev2b.code });

  // N3 helper killed while the second installation is being issued: the first link is in the ledger; disconnect handles it
  fs.writeFileSync(SSH_MODE, "hang");
  const n3r = await nodeRequest({ installs: ["local", "vps1"] });
  const n3c = pair(["check", n3r.text]);
  const n3p = spawn("bun", ["--no-env-file", PAIR, "approve", n3r.text, "--phrase", n3c.json.phrase, "--json"], { env: pairEnv({ RAVI_CONNECT_SSH_TIMEOUT_MS: "120000" }), cwd: RUN, stdio: "ignore" });
  let n3seen = false;
  for (let i = 0; i < 200 && !n3seen; i++) {
    await sleep(100);
    try {
      n3seen = readLedger().links.some((l) => l.nonce === n3r.req.nonce && l.installs.some((i) => i.name === "local" && i.contextId && !i.pending)) && fs.existsSync(SSH_HANG_PIDS);
    } catch {}
  }
  n3p.kill("SIGKILL");
  await new Promise((r) => (n3p.exitCode !== null || n3p.signalCode ? r() : n3p.once("exit", r)));
  fs.writeFileSync(SSH_MODE, "");
  killHangs();
  const n3L = readLedger();
  const n3entry = n3L.links.find((l) => l.nonce === n3r.req.nonce);
  const n3lock = fs.existsSync(LEDGER + ".lock");
  const n3list = pair(["list"]);
  const n3d1 = pair(["disconnect", n3c.json.phrase]);
  const n3cmd = n3d1.json && manualCmd(n3d1.json.results[0] && n3d1.json.results[0].result);
  const n3own = n3cmd ? ownerCli("A", n3cmd.slice(1), adminA) : { code: "no command" };
  const n3d2 = pair(["disconnect", n3c.json.phrase]);
  const n3after = readLedger().links.find((l) => l.nonce === n3r.req.nonce);
  ok("N3 helper SIGKILLed while vps1 is being issued: local link already in the ledger, vps1 recorded as pending (no lock left), list shows local 'ativa', disconnect prints the manual command, the owner runs it, the second disconnect answers 'revogada' and marks the ledger", n3seen && n3entry && n3entry.installs.map((i) => i.name + (i.pending ? ":pending" : "")).join() === "local,vps1:pending" && !n3lock && n3list.json.links.some((l) => l.phrase === n3c.json.phrase && l.installs[0].state === "ativa") && n3cmd && n3own.code === 0 && n3d2.json && n3d2.json.results[0].result === "revogada" && n3after.installs[0].revokedAt > 0, { seenBeforeKill: n3seen, ledger: n3entry && n3entry.installs.map((i) => i.name + (i.pending ? ":pending" : "")), nonceState: n3L.nonces[n3r.req.nonce] && n3L.nonces[n3r.req.nonce].state, lockLeft: n3lock, first: n3d1.json && n3d1.json.results.map((r) => r.result.slice(0, 120)), owner: n3own.code, second: n3d2.json && n3d2.json.results.map((r) => r.result) });
  if (n3L.nonces[n3r.req.nonce] && n3L.nonces[n3r.req.nonce].state === "approving")
    note({ severity: "info", where: "scripts/pair.ts cmdApprove", problem: "After a crash mid-approve the nonce stays in state 'approving' forever and the envelope for the already-issued link is lost; the page must send a new request (expected, but the owner sees no reply). The orphaned link is listed and can be disconnected (N3)." });

  // N4 CLI output with warning lines before and after the JSON
  fs.writeFileSync(NOISE, "text");
  const n4r = await nodeRequest({ installs: ["vps1"] });
  const n4 = checkApprove(n4r.text).approve;
  const n4s = pair(["status", "--probe"]);
  const n4row = n4s.json && n4s.json.installations.find((i) => i.name === "vps1");
  const n4own = ownerCli("B", ["context", "revoke", n4.json.installs[0].contextId, "--reason", "ravi-connect"], adminB);
  const n4d = pair(["disconnect", n4.json.phrase]);
  fs.writeFileSync(NOISE, "");
  ok("N4 remote CLI prints warning lines (one starting with '{', one ending with '}') before and after its JSON: issue, whoami (status --probe) and info (manual-revoke check) are all still parsed", n4.code === 0 && n4.json.installs[0].name === "vps1" && n4row && n4row.issuerExpiresAt > 0 && !n4row.problem && n4own.code === 0 && n4d.json && n4d.json.results[0].result === "revogada", { issue: n4.code, probe: n4row && (n4row.problem || "ok"), disconnectAfterOwnerRevoke: n4d.json && n4d.json.results[0].result });
  // N4b probe: a one-line JSON log printed after the CLI's JSON
  fs.writeFileSync(NOISE, "jsonlog");
  const n4br = await nodeRequest({ installs: ["vps1"] });
  const n4b = checkApprove(n4br.text).approve;
  fs.writeFileSync(NOISE, "");
  const cliName4b = `connect:${new URL(ORIGIN).host}:${n4br.req.nonce.slice(0, 8)}`;
  const list4b = await gw(B, "context/list", adminB, {});
  const ctx4b = ((list4b.json && (list4b.json.contexts || list4b.json.items || list4b.json.data)) || []).filter((c) => c.issuedFor === cliName4b && c.status === "active");
  const row4b = (readLedger().links.find((l) => l.nonce === n4br.req.nonce) || { installs: [] }).installs[0];
  ok("N4b a one-line JSON log printed after the CLI's JSON: extractJson picks the object with the expected fields; approve succeeds and the ledger row has the contextId", n4b.code === 0 && ctx4b.length === 1 && row4b && row4b.contextId === ctx4b[0].contextId && !row4b.pending, { code: n4b.code, err: errc(n4b), active: ctx4b.length, ledger: row4b && { contextId: !!row4b.contextId, pending: !!row4b.pending } });
  // clean any stray connect context for later counts
  for (const c of ctx4b) await gw(B, "context/revoke", adminB, { contextId: c.contextId, reason: "e2e cleanup" });
  for (const c of orphan) await gw(B, "context/revoke", adminB, { contextId: c.contextId, reason: "e2e cleanup" }).catch(() => {});

  // N5 issuer key with ~30 days left: link shorter than the configured 60 days -> warning + shortened
  const n5iss = await gw(B, "context/issue", adminB, { cliName: "pairing-issuer-30d", allow: CAPS_B, ttl: "30d" });
  write0600(path.join(HOME_R, ".ravi", "pairing", "short.issuer.key"), n5iss.json.contextKey);
  write0600(CONF, JSON.stringify(config({}, { vps1: { reach: { type: "ssh", alias: "vps1", issuerKeyFile: "~/.ravi/pairing/short.issuer.key", ravi: "ravi" } } }, "manual"), null, 2));
  const n5r = await nodeRequest({ installs: ["local", "vps1"] });
  const n5c = pair(["check", n5r.text]);
  const n5 = pair(["approve", n5r.text, "--phrase", n5c.json.phrase]);
  MANUAL();
  const n5days = n5.json ? Object.fromEntries(n5.json.installs.map((i) => [i.name, +((i.expiresAt - Date.now()) / 86400000).toFixed(2)])) : null;
  ok("N5 vps1 issuer with 30 days left: vps1 link ~30 d, local ~60 d, shortened = [vps1], reply warns 'vps1 vale menos que os 60 dias'", n5.code === 0 && JSON.stringify(n5.json.shortened) === '["vps1"]' && Math.abs(n5days.vps1 - 30) < 0.05 && Math.abs(n5days.local - 60) < 0.05 && /Atenção: vps1 vale menos que os 60 dias/.test(n5.json.reply), { days: n5days, shortened: n5.json && n5.json.shortened, reply: n5.json && n5.json.reply.split("\n").slice(0, 2) });
  ok("N5b the confirmation the owner approves already says the link can be shorter than the issuer key allows", n5c.json && /Validade: 60 dias \(até \d{4}-\d\d-\d\d\), ou menos se a chave emissora de uma instalação vencer antes/.test(n5c.json.confirmation), n5c.json && n5c.json.confirmation.split("\n").find((l) => l.startsWith("Validade")));

  // N6 default manual revoke: disconnect prints the command; after the owner revokes with the admin key, 'revogada' + ledger
  const n6r = await nodeRequest({ installs: ["local", "vps1"] });
  const n6 = checkApprove(n6r.text).approve;
  const n6g = await nodeOpen(n6.json.envelope, n6r.priv, n6r.canonText, ORIGIN);
  const n6d1 = pair(["disconnect", n6.json.phrase]);
  const n6res = Object.fromEntries((n6d1.json ? n6d1.json.results : []).map((r) => [r.name, r.result]));
  const n6live = [];
  for (const gi of n6g.installs) n6live.push((await gw(gi.name === "local" ? A : B, "context/whoami", gi.linkKey)).status);
  const n6marked1 = readLedger().links.find((l) => l.nonce === n6r.req.nonce).installs.some((i) => i.revokedAt);
  const n6own = {};
  for (const [name, line] of Object.entries(n6res)) {
    const cmd = manualCmd(line);
    n6own[name] = cmd && cmd[0] === "ravi" ? ownerCli(name === "local" ? "A" : "B", cmd.slice(1), name === "local" ? adminA : adminB).code : "no command";
  }
  const n6d2 = pair(["disconnect", n6.json.phrase]);
  const n6L = readLedger().links.find((l) => l.nonce === n6r.req.nonce);
  const n6d3 = pair(["disconnect", n6.json.phrase]);
  const n6dead = [];
  for (const gi of n6g.installs) n6dead.push((await gw(gi.name === "local" ? A : B, "context/whoami", gi.linkKey)).status);
  ok("N6 default revoke 'manual': first disconnect prints 'manual: rode no seu terminal / na VPS (ssh vps1): ravi context revoke <id> --reason ravi-connect' (exit 0, ok:false), links still work, ledger untouched; the owner runs exactly that command with the admin key (real CLI); second disconnect answers 'revogada' for both and marks the ledger; third: nothing to revoke", n6d1.code === 0 && n6d1.json.ok === false && /^manual: rode no seu terminal: ravi context revoke ctx_\S+ --reason ravi-connect/.test(n6res.local || "") && /^manual: rode na VPS \(ssh vps1\): ravi context revoke ctx_\S+ --reason ravi-connect/.test(n6res.vps1 || "") && n6live.every((s) => s === 200) && !n6marked1 && n6own.local === 0 && n6own.vps1 === 0 && n6d2.json.results.every((r) => r.result === "revogada") && n6L.installs.every((i) => i.revokedAt > 0) && n6d3.json && n6d3.json.results.length === 0 && n6dead.every((s) => s === 401), { first: n6res, exitFirst: n6d1.code, okFirst: n6d1.json && n6d1.json.ok, live: n6live, owner: n6own, second: n6d2.json && n6d2.json.results.map((r) => r.name + ":" + r.result), third: n6d3.json && n6d3.json.results.length, linkAfter: n6dead });
  if (n6d1.code === 0 && n6d1.json && n6d1.json.ok === false)
    note({ severity: "info", where: "scripts/pair.ts cmdDisconnect", problem: "A disconnect that only printed 'manual: ...' exits 0 with ok:false; the SKILL handles it by text ('manual: ...' lines), so this is consistent, but an agent keying on the exit code alone would report success." });

  // N7 issuer without read:context:info: after the owner revokes it stays 'manual'; status --probe says so
  const capsNoInfo = CAPS_B.split(",").filter((c) => c !== "read:context:info").join(",");
  const n7iss = await gw(B, "context/issue", adminB, { cliName: "pairing-issuer-noinfo", allow: capsNoInfo, ttl: "89d" });
  write0600(path.join(HOME_R, ".ravi", "pairing", "noinfo.issuer.key"), n7iss.json.contextKey);
  write0600(CONF, JSON.stringify(config({}, { vps1: { reach: { type: "ssh", alias: "vps1", issuerKeyFile: "~/.ravi/pairing/noinfo.issuer.key", ravi: "ravi" } } }, "manual"), null, 2));
  const n7r = await nodeRequest({ installs: ["vps1"] });
  const n7 = checkApprove(n7r.text).approve;
  const n7own = ownerCli("B", ["context", "revoke", n7.json.installs[0].contextId, "--reason", "ravi-connect"], adminB);
  const n7d = pair(["disconnect", n7.json.phrase]);
  const n7s = pair(["status", "--probe"]);
  const n7row = n7s.json && n7s.json.installations.find((i) => i.name === "vps1");
  MANUAL();
  const n7info = await gw(B, "context/info", adminB, { contextId: n7.json.installs[0].contextId });
  ok("N7 issuer without read:context:info: link revoked by the owner, disconnect still answers 'manual: ...' (cannot verify), ledger not marked; status --probe notes 'emissora sem read:context:info'", n7.code === 0 && n7own.code === 0 && n7info.json && n7info.json.status === "revoked" && n7d.json && /^manual:/.test(n7d.json.results[0].result) && !readLedger().links.find((l) => l.nonce === n7r.req.nonce).installs[0].revokedAt && n7row && /sem read:context:info/.test(n7row.note || ""), { actual: n7info.json && n7info.json.status, disconnect: n7d.json && n7d.json.results[0].result.slice(0, 80), note: n7row && n7row.note, problem: n7row && n7row.problem });

  // N8 optional revoker key: over http (local) and over the cli through ssh (vps1, real CLI) the helper revokes directly
  write0600(CONF, JSON.stringify(config(), null, 2));
  const m8r = await nodeRequest({ installs: ["local", "vps1"] });
  const m8 = checkApprove(m8r.text).approve;
  const m8d = pair(["disconnect", m8.json.phrase]);
  const m8st = [];
  for (const i of m8.json.installs) m8st.push((await gw(i.name === "local" ? A : B, "context/info", i.name === "local" ? adminA : adminB, { contextId: i.contextId })).json.status);
  // and revoke via cli on the local installation (sh -c on the owner's computer, real CLI)
  write0600(CONF, JSON.stringify(config({}, { local: { revoke: { via: "cli", keyFile: "~/.ravi/pairing/revoker.key" } } }), null, 2));
  const m8br = await nodeRequest({ installs: ["local"] });
  const m8b = checkApprove(m8br.text).approve;
  const m8bd = pair(["disconnect", m8b.json.phrase]);
  const m8bst = (await gw(A, "context/info", adminA, { contextId: m8b.json.installs[0].contextId })).json.status;
  MANUAL();
  ok("N8 revoker key: revoke via http (local) and via cli over ssh (vps1) -> 'revogada' directly, both contexts revoked; via cli on the local installation too", m8d.code === 0 && m8d.json.ok === true && m8d.json.results.every((r) => r.result === "revogada") && m8st.every((s) => s === "revoked") && m8bd.json && m8bd.json.results[0].result === "revogada" && m8bst === "revoked", { results: m8d.json && m8d.json.results.map((r) => r.name + ":" + r.result), status: m8st, localCli: m8bd.json && m8bd.json.results[0].result, localCliStatus: m8bst });


  // ================= R. round-2 fixes =================
  write0600(CONF, JSON.stringify(config(), null, 2)); // revoker config: disconnect revokes directly
  // R1 accents and spaced hyphens from a phone keyboard are the same phrase
  const xr1r = await nodeRequest({ installs: ["local"] });
  const xr1c = pair(["check", xr1r.text]);
  const typed = xr1c.json.phrase.toLowerCase().replace(/a/g, "á").replace(/o/g, "ó").replace(/e/g, "ê").replace(/c/g, "ç").replace(/-/g, " - ");
  const xr1 = pair(["approve", xr1r.text, "--phrase", typed]);
  ok("R1 'sim' with accents, cedilla and ' - ' between words (phone keyboard) is accepted as the same phrase", xr1.code === 0 && xr1.json.installs.length === 1, { typed, code: xr1.code, err: errc(xr1) });
  // R2 disconnect --install with a name the connection does not have: NOT_FOUND (not 'nada a revogar')
  const xr2 = pair(["disconnect", xr1c.json.phrase, "--install", "vps9"]);
  const xr2b = pair(["disconnect", typed, "--install", "local"]);
  ok("R2 disconnect <frase> --install <unknown>: exit 1 NOT_FOUND, nothing revoked; the phrase typed with accents then revokes 'local'", xr2.code === 1 && errc(xr2) === "NOT_FOUND" && xr2b.code === 0 && xr2b.json.results.length === 1 && xr2b.json.results[0].result === "revogada", { unknown: errc(xr2), accented: xr2b.json && xr2b.json.results.map((r) => r.result) });
  // R3 --out-dir is checked BEFORE anything is consumed or issued
  const xr3r = await nodeRequest({ installs: ["local"] });
  const xr3c = pair(["check", xr3r.text]);
  const realDir = fs.mkdtempSync(path.join(RUN, "od-real-"));
  const linkDir = path.join(RUN, "od-link-" + Date.now());
  fs.symlinkSync(realDir, linkDir);
  const fullDir = fs.mkdtempSync(path.join(RUN, "od-full-"));
  fs.writeFileSync(path.join(fullDir, "index.html"), "<p>página do dono</p>");
  const fileOd = path.join(RUN, "od-file-" + Date.now());
  fs.writeFileSync(fileOd, "x");
  const xr3a = ["link", "full", "file"].map((k) => pair(["approve", xr3r.text, "--phrase", xr3c.json.phrase, "--out-dir", { link: linkDir, full: fullDir, file: fileOd }[k]]));
  const newDir = path.join(RUN, "od-new-" + Date.now());
  const xr3ok = pair(["approve", xr3r.text, "--phrase", xr3c.json.phrase, "--out-dir", newDir]);
  const xr3file = xr3ok.json && xr3ok.json.envelopeFile;
  ok("R3 --out-dir that is a symlink, a non-empty folder or a file: exit 2 OUT_DIR before the request is used (folder contents untouched); then a new folder works and the envelope file is 0600", xr3a.every((r) => r.code === 2 && errc(r) === "OUT_DIR") && fs.readFileSync(path.join(fullDir, "index.html"), "utf8") === "<p>página do dono</p>" && fs.readdirSync(realDir).length === 0 && xr3ok.code === 0 && xr3file === path.join(newDir, "index.html") && (fs.statSync(xr3file).mode & 0o777) === 0o600, { refused: xr3a.map(errc), ok: xr3ok.code });
  pair(["disconnect", xr3ok.json.phrase]);
  // R4 a symlink planted where an old fixed temp name was: never followed (unique temp file opened with wx)
  const victim = path.join(RUN, "victim.txt");
  fs.writeFileSync(victim, "intocado", { mode: 0o644 });
  fs.symlinkSync(victim, LEDGER + ".tmp");
  const xr4 = pair(["list"]);
  const xr4v = { text: fs.readFileSync(victim, "utf8"), mode: (fs.statSync(victim).mode & 0o777).toString(8) };
  fs.rmSync(LEDGER + ".tmp", { force: true });
  const leftTmp = fs.readdirSync(path.dirname(LEDGER)).filter((f) => f.endsWith(".tmp"));
  ok("R4 symlink at ledger.json.tmp: target untouched (text and 0644 mode), list works, no temp file left", xr4.code === 0 && xr4v.text === "intocado" && xr4v.mode === "644" && leftTmp.length === 0, { xr4v, leftTmp });
  // R5 status --probe: extra issuer capability, CORS for another origin, the page path (tunnel) and the issuer id
  const wide = await gw(A, "context/issue", adminA, { cliName: "pairing-issuer-wide", allow: CAPS_A + ",read:sessions:read,access:session:segredo", ttl: "1h" });
  write0600(path.join(HOME_L, ".ravi", "pairing", "wide.issuer.key"), wide.json.contextKey);
  write0600(CONF, JSON.stringify(config({}, { local: { reach: { type: "http", url: A, issuerKeyFile: "~/.ravi/pairing/wide.issuer.key" } } }), null, 2));
  const xr5a = pair(["status", "--probe"]);
  write0600(CONF, JSON.stringify(config({ allowedOrigins: [ORIGIN, "https://outro-projeto.ravi.page"] }), null, 2));
  const xr5b = pair(["status", "--probe"]);
  write0600(CONF, JSON.stringify(config({}, { vps1: { baseUrl: "http://127.0.0.1:9" } }), null, 2));
  const xr5c = pair(["status", "--probe"]);
  write0600(CONF, JSON.stringify(config(), null, 2));
  const xr5d = pair(["status", "--probe"]);
  const rowOf = (r, n) => r.json && r.json.installations.find((i) => i.name === n);
  ok("R5 status --probe: issuer with an extra capability (read:sessions:read, an out-of-config session) -> PROBLEMA 'capacidade a mais'; an allowed origin missing from the gateway CORS -> PROBLEMA; a baseUrl nothing answers (tunnel down) -> PROBLEMA; all fine -> ok:true, page ok, issuer contextId shown; never a key", /capacidade a mais: .*read:sessions:read.*access:session:segredo/.test((rowOf(xr5a, "local") || {}).problem || "") && xr5a.json.ok === false && /não libera https:\/\/outro-projeto\.ravi\.page/.test((rowOf(xr5b, "local") || {}).problem || "") && /não alcança http:\/\/127\.0\.0\.1:9/.test((rowOf(xr5c, "vps1") || {}).problem || "") && xr5d.json.ok === true && xr5d.json.installations.every((i) => i.page === "ok" && /^ctx_/.test(i.issuerContextId || "")) && ![xr5a, xr5b, xr5c, xr5d].some((r) => r.raw.includes("rctx_")), { extra: (rowOf(xr5a, "local") || {}).problem, cors: (rowOf(xr5b, "local") || {}).problem, tunnel: (rowOf(xr5c, "vps1") || {}).problem, fine: xr5d.json && xr5d.json.installations.map((i) => i.name + ":" + i.page) });
  await gw(A, "context/revoke", adminA, { contextId: wide.json.contextId, reason: "e2e" });
  // R6 a scope name containing rctx_ is refused as config (it would trip the leak guard after the nonce is spent)
  write0600(CONF, JSON.stringify(config({}, { local: { scope: { sessions: ["rctx_sessao"], agents: [] } } }), null, 2));
  const xr6 = pair(["check", (await nodeRequest()).text]);
  write0600(CONF, JSON.stringify(config(), null, 2));
  ok("R6 scope name containing 'rctx_' refused at config load (exit 2), before any nonce is used", xr6.code === 2 && errc(xr6) === "CONFIG_SCOPE" && !xr6.raw.includes("rctx_"), errc(xr6));
  // R10 ssh exits 0 but a background child keeps stdout open: the answer is used right after exit (+2 s drain)
  fs.writeFileSync(SSH_MODE, "hold");
  const xr10r = await nodeRequest({ installs: ["vps1"] });
  const xr10t = Date.now();
  const xr10 = checkApprove(xr10r.text, [], { RAVI_CONNECT_SSH_TIMEOUT_MS: "20000" }).approve;
  const xr10ms = Date.now() - xr10t;
  fs.writeFileSync(SSH_MODE, "");
  killHangs();
  ok("R10 ssh exits 0 while a child still holds stdout (ControlPersist-like): approve succeeds well before the 20 s limit", xr10.code === 0 && xr10.json.installs[0].name === "vps1" && xr10ms < 15000, { code: xr10.code, err: errc(xr10), ms: xr10ms });
  if (xr10.code === 0) pair(["disconnect", xr10.json.phrase]);

  // R7..R9 the page
  const profR = await setupContext(await browser.newContext());
  const t1 = await visit(profR);
  const t2 = await visit(profR); // both tabs open before either clicks Conectar
  await t1.click("[data-rc=connect]");
  await t1.waitForSelector("[data-rc=phrase]");
  const t1req = await t1.inputValue("[data-rc=request]");
  await t2.click("[data-rc=connect]");
  await t2.waitForSelector("[data-rc=phrase]");
  const t1a = checkApprove(t1req).approve;
  const t1acc = await t1.evaluate(async (e) => window.conn.accept(e).then((n) => "OPENED " + n.join(","), (x) => "refused: " + x.message), t1a.json.envelope);
  const t1st = await stateOf(t1);
  ok("R7 two tabs: tab 2 made a newer request; tab 1 still opens the envelope of ITS request and links", t1a.code === 0 && t1acc === "OPENED local,vps1" && t1st.local === "linked" && t1st.vps1 === "linked", { t1acc, t1st });
  await t2.evaluate(() => window.conn.cancel());
  await t2.close();
  pair(["disconnect", t1a.json.phrase]);
  await t1.close();
  // R8 a forged envelope built from the public request text is accepted first (known limit), but no longer
  //    blocks the real envelope of the same request, which then opens and wins
  const t3 = await visit(profR);
  await t3.click("[data-rc=connect]");
  await t3.waitForSelector("[data-rc=phrase]");
  const t3req = await t3.inputValue("[data-rc=request]");
  const forged = await nodeSeal(t3req, { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_" + "falsa", contextId: "ctx_x", expiresAt: Date.now() + 1e9, caps: [...VER, "access:session:outro-main", "view:agent:outro"] }] });
  const t3f = await t3.evaluate(async (e) => window.conn.accept(e).then(() => "OPENED", (x) => "refused: " + x.message), forged);
  const t3fst = await stateOf(t3);
  const t3a = checkApprove(t3req).approve;
  const t3r = await t3.evaluate(async (e) => window.conn.accept(e).then((n) => "OPENED " + n.join(","), (x) => "refused: " + x.message), t3a.json.envelope);
  const t3st = await stateOf(t3);
  ok("R8 forged envelope (public request text, pinned address, preset caps) is accepted and fails at mint (reconnect); the real envelope of the same request is NOT refused afterwards and links both", t3f === "OPENED" && t3fst.local === "reconnect" && t3r === "OPENED local,vps1" && t3st.local === "linked" && t3st.vps1 === "linked", { forged: t3f, afterForged: t3fst, real: t3r, after: t3st });
  // R9 'Esquecer este navegador' also kills installation handles already given to the page code
  const t3forget = await t3.evaluate(async () => {
    const h = window.conn.installs.get("local");
    const before = (await h.call("context/whoami")).contextId ? "ok" : "?";
    await window.conn.forget();
    const after = await h.call("context/whoami").then(() => "STILL WORKS", (e) => "refused " + e.state);
    return { before, after, state: h.state, stored: await window.storedSummary() };
  });
  ok("R9 forget(): a handle obtained before keeps no key (call refused 'reconnect', state not-linked), IndexedDB holds nothing (links, pending, kept requests)", t3forget.before === "ok" && t3forget.after === "refused reconnect" && t3forget.state === "not-linked" && t3forget.stored.links === 0 && !t3forget.stored.pending && t3forget.stored.keptRequests === 0, t3forget);
  pair(["disconnect", t3a.json.phrase]);
  await t3.close();
  await profR.close();
  MANUAL();

  // ================= O. the owner's real flow, once, in ONE persistent browser profile (default manual config) =================
  MANUAL();
  const udd = fs.mkdtempSync(path.join(ROOT, "profile-owner-"));
  let oc = await setupContext(await chromium.launchPersistentContext(udd));
  let op = await visit(oc);
  const o0 = await stateOf(op);
  await op.click("[data-rc=connect]");
  await op.waitForSelector("[data-rc=phrase]");
  const oPhrase = (await op.textContent("[data-rc=phrase]")).trim();
  const oReq = await op.inputValue("[data-rc=request]");
  const oBtn = (await op.textContent("[data-rc=paste]")).trim();
  const oHint = await op.textContent(".rc-hint");
  const oc1 = pair(["check", oReq]);
  const oa1 = pair(["approve", oReq, "--phrase", oPhrase.toLowerCase().replace(/-/g, " ")]); // owner: "sim cedro farol uva"
  ok("O1a owner flow: card offers Conectar on a fresh profile; same phrase on page and in the confirmation; approve with 'sim <frase>' in lowercase with spaces; button reads 'Usar este envelope'", JSON.stringify(o0) === '{"local":"not-linked","vps1":"not-linked"}' && oc1.code === 0 && oc1.json.phrase === oPhrase && oa1.code === 0 && oa1.json.installs.length === 2 && oBtn === "Usar este envelope" && /Usar este envelope/.test(oHint), { states: o0, phrase: oPhrase === (oc1.json && oc1.json.phrase), approve: oa1.code, button: oBtn });
  // P1: what the owner pasted survives a re-render (state change) before clicking the button
  await op.fill("[data-rc=envelope]", oa1.json.envelope);
  await op.evaluate(() => (document.querySelector("[data-rc=envelope]").dataset.old = "1"));
  await op.evaluate(() => window.conn.session()); // re-reads storage and emits a state change -> the card is redrawn
  const kept = await op.evaluate(() => { const t = document.querySelector("[data-rc=envelope]"); return { redrawn: t.dataset.old !== "1", same: t.value.length }; });
  ok("P1 text pasted in the envelope box survives a state change (card redrawn: new textarea, same text)", kept.redrawn && kept.same === oa1.json.envelope.length, kept);
  // P1b partial typing survives too, and a cancel clears it
  await op.click("[data-rc=paste]");
  await op.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 15000 });
  const oSeen = await op.evaluate(async () => {
    const out = {};
    for (const i of window.conn.installs.values()) {
      const se = await i.call("sessions/list");
      const w = await i.call("context/whoami");
      out[i.name] = { sessions: (se.sessions || se.items || se).map((x) => x.name).sort(), parent: w.parentContextId };
    }
    return out;
  });
  const oLinks = Object.fromEntries(oa1.json.installs.map((i) => [i.name, i.contextId]));
  ok("O1b after 'Usar este envelope' (the button clicked after the redraw): both linked, each lists only its scoped sessions, access keys are children of the two links", oSeen.local && JSON.stringify(oSeen.local.sessions) === '["outro-main"]' && JSON.stringify(oSeen.vps1.sessions) === '["main","outro-main"]' && oSeen.local.parent === oLinks.local && oSeen.vps1.parent === oLinks.vps1, oSeen);
  await op.reload();
  await op.waitForFunction(() => window.ready);
  await op.evaluate(() => window.ready);
  const oR = await stateOf(op);
  await oc.close();
  oc = await setupContext(await chromium.launchPersistentContext(udd));
  op = await visit(oc);
  const oR2 = await stateOf(op);
  ok("O2 reload, then browser closed and reopened on the same profile: linked both times, no approval", oR.local === "linked" && oR.vps1 === "linked" && oR2.local === "linked" && oR2.vps1 === "linked", { reload: oR, reopen: oR2 });
  const oOther = await setupContext(await browser.newContext());
  const oop = await visit(oOther);
  const oRef = await oop.evaluate(async (env) => { try { await window.conn.connect(); await window.conn.accept(env); return "OPENED"; } catch (e) { return "refused: " + e.message; } }, oa1.json.envelope);
  const oOtherSt = await stateOf(oop);
  await oOther.close();
  ok("O3 another browser profile pasting the owner's envelope (with its own pending request): refused, nothing linked", oRef.startsWith("refused") && oOtherSt.local !== "linked" && oOtherSt.vps1 !== "linked", { oRef, oOtherSt });
  // O4 disconnect only vps1 (manual): command printed, access continues until the owner runs it; then 'revogada'
  const od1 = pair(["disconnect", oPhrase.toLowerCase().replace(/-/g, " "), "--install", "vps1"]);
  const odLine = od1.json && od1.json.results.length === 1 && od1.json.results[0].name === "vps1" ? od1.json.results[0].result : null;
  const stillV = await op.evaluate(async () => window.conn.installs.get("vps1").call("context/whoami").then(() => "ok", (e) => e.state));
  const odCmd = manualCmd(odLine);
  const odOwn = odCmd ? ownerCli("B", odCmd.slice(1), adminB) : { code: "no command" };
  const afterRevoke = await op.evaluate(async () => {
    const v = window.conn.installs.get("vps1");
    const l = window.conn.installs.get("local");
    const r = await v.call("context/whoami").then(() => "ok", (e) => e.state + " " + e.code);
    return { vps1: r, local: await l.call("context/whoami").then(() => "ok", (e) => e.state) };
  });
  const od2 = pair(["disconnect", oPhrase, "--install", "vps1"]);
  const oList = pair(["list"]);
  const oRow = oList.json.links.find((l) => l.phrase === oPhrase);
  const oCard = await op.textContent("[data-rc-install=vps1]");
  ok("O4 'desconectar <frase> na vps1' (manual): only vps1 answered with the command, page still works until the owner runs it; after it: vps1 'precisa reconectar' (AUTH_REQUIRED), local linked; repeat -> 'revogada'; list: local ativa, vps1 revogada", /^manual: rode na VPS \(ssh vps1\)/.test(odLine || "") && stillV === "ok" && odOwn.code === 0 && afterRevoke.vps1 === "reconnect AUTH_REQUIRED" && afterRevoke.local === "ok" && od2.json && od2.json.results[0].result === "revogada" && oRow && oRow.installs.find((i) => i.name === "local").state === "ativa" && oRow.installs.find((i) => i.name === "vps1").state === "revogada" && /precisa reconectar/.test(oCard), { first: (odLine || "").slice(0, 90), beforeOwner: stillV, owner: odOwn.code, after: afterRevoke, second: od2.json && od2.json.results, card: oCard });
  // O5 reconnect vps1 with a new request while local stays linked
  await op.click("[data-rc=connect]");
  await op.waitForSelector("[data-rc=phrase]");
  const oPhrase2 = (await op.textContent("[data-rc=phrase]")).trim();
  const oReq2 = await op.inputValue("[data-rc=request]");
  const oReq2obj = JSON.parse(Buffer.from(oReq2.slice(16), "base64url").toString());
  const oa2 = checkApprove(oReq2).approve;
  // partial text typed, a real state change happens (local's access key minted again on session()), text still there
  await op.fill("[data-rc=envelope]", oa2.json.envelope.slice(0, 40));
  await op.evaluate(() => (document.querySelector("[data-rc=envelope]").dataset.old = "1"));
  await op.evaluate(() => window.conn.session());
  const kept2 = await op.evaluate(() => { const t = document.querySelector("[data-rc=envelope]"); return { redrawn: t.dataset.old !== "1", value: t.value }; });
  await op.fill("[data-rc=envelope]", oa2.json.envelope);
  await op.click("[data-rc=paste]");
  await op.waitForFunction(() => window.conn.snapshot().every((s) => s.state === "linked"), null, { timeout: 15000 });
  const parents = await op.evaluate(async () => Object.fromEntries(await Promise.all([...window.conn.installs.values()].map(async (i) => [i.name, (await i.call("context/whoami")).parentContextId]))));
  await op.reload();
  await op.waitForFunction(() => window.ready);
  await op.evaluate(() => window.ready);
  const oR3 = await stateOf(op);
  const oList2 = pair(["list"]);
  ok("O5 reconnect vps1: new request asks only vps1 with a new phrase; partial text survives a redraw; after paste both linked; local still on its ORIGINAL link, vps1 on the new one; after reload both linked; list has the new vps1 link 'ativa'", JSON.stringify(oReq2obj.installs) === '["vps1"]' && oPhrase2 !== oPhrase && oa2.code === 0 && kept2.redrawn && kept2.value === oa2.json.envelope.slice(0, 40) && parents.local === oLinks.local && parents.vps1 === oa2.json.installs[0].contextId && oR3.local === "linked" && oR3.vps1 === "linked" && oList2.json.links.some((l) => l.phrase === oPhrase2 && l.installs[0].name === "vps1" && l.installs[0].state === "ativa"), { installs: oReq2obj.installs, newPhrase: oPhrase2 !== oPhrase, kept2: { redrawn: kept2.redrawn, len: kept2.value.length }, parents: { localSame: parents.local === oLinks.local, vps1New: parents.vps1 === (oa2.json.installs[0] || {}).contextId }, reload: oR3 });
  const oStore = await op.evaluate(async () => window.storedSummary());
  ok("O6 at rest after the whole flow: two stored links (local's old one, vps1's new one), no rctx_, keys non-extractable", oStore.links === 2 && !oStore.hasRctx && !oStore.keysExtractable && !oStore.pending, oStore);
  await oc.close();
  fs.rmSync(udd, { recursive: true, force: true });

  await browser.close();
  await stopGw("A");
  await stopGw("B");
  const pass = results.filter((r) => r.result === "pass").length;
  const out = { pass, total: results.length, ravi_src: path.basename(RAVI_SRC), results, problems };
  fs.writeFileSync(path.join(E, "e2e-result.json"), JSON.stringify(out, null, 1).replace(/rctx_[A-Za-z0-9_-]+/g, "[key]"));
  console.log(JSON.stringify({ pass, total: results.length }));
  cleanup();
  process.exit(pass === results.length ? 0 : 1);
})().catch(async (e) => {
  console.error("CRASH", e);
  fs.writeFileSync(path.join(E, "e2e-result.json"), JSON.stringify({ crash: String(e && e.stack), results, problems }, null, 1).replace(/rctx_[A-Za-z0-9_-]+/g, "[key]"));
  await stopGw("A").catch(() => {});
  await stopGw("B").catch(() => {});
  cleanup();
  process.exit(2);
});

// Deletes browser profiles, key files, states and homes (everything under ROOT) unless E2E_KEEP=1.
function cleanup() {
  killHangs();
  if (process.env.E2E_KEEP === "1") return console.error("kept " + ROOT);
  fs.rmSync(ROOT, { recursive: true, force: true });
}
process.on("SIGINT", () => { for (const p of Object.values(procs)) try { p.kill("SIGKILL"); } catch {} cleanup(); process.exit(130); });
