// Shared helpers for the attack scripts. Never touches ~/.ravi: every run gets a temp HOME and config.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");
const { webcrypto } = require("crypto");
const AT = __dirname;
// Work area for temp HOMEs and gateway states: $ATK_WORK, or a new folder under the system temp dir (run-all.cjs
// creates one and deletes it at the end). Ravi source: $RAVI_SRC, default the repository this folder is in.
const S = process.env.ATK_WORK ? path.resolve(process.env.ATK_WORK) : fs.mkdtempSync(path.join(os.tmpdir(), "ravi-connect-atk-"));
fs.mkdirSync(S, { recursive: true });
const SKILL = path.join(AT, "..", "..", "skill", "connect-installations");
const PAIR = path.join(SKILL, "scripts", "pair.ts");
const CONNECT_JS = path.join(SKILL, "assets", "connect.js");
const RAVI_COPY = path.resolve(process.env.RAVI_SRC || path.join(AT, "..", "..", "..", ".."));
const ORIGIN = "https://exemplo-painel.ravi.page";
const cleanEnv = { ...process.env };
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete cleanEnv[k];
const results = [];
const rec = (name, verdict, evidence) => {
  const ev = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  results.push({ name, verdict, evidence: ev });
  console.error(`[${verdict}] ${name} :: ${ev.slice(0, 500)}`);
};
const b64u = (b) => Buffer.from(b).toString("base64url");
const canon = (r) => JSON.stringify({ v: r.v, kind: r.kind, origin: r.origin, pub: { x: r.pub.x, y: r.pub.y }, preset: r.preset, installs: r.installs, nonce: r.nonce, iat: r.iat });
async function mkReq(o = {}) {
  const k = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const j = await webcrypto.subtle.exportKey("jwk", k.publicKey);
  const r = { v: 1, kind: "ravi-connect", origin: o.origin || ORIGIN, pub: o.pub || { x: j.x, y: j.y }, preset: o.preset || "ver", installs: o.installs || ["local"], nonce: o.nonce || b64u(webcrypto.getRandomValues(new Uint8Array(16))), iat: o.iat ?? Date.now() };
  const raw = o.rawText ? o.rawText(r) : canon(r);
  return { text: "ravi-connect:v1:" + b64u(Buffer.from(raw)), raw, r, priv: k.privateKey };
}
function mkHome(tag, cfg) {
  const home = fs.mkdtempSync(path.join(S, `atk-${tag}-`));
  const dir = path.join(home, ".ravi", "pairing");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const conf = path.join(dir, "config.json");
  fs.writeFileSync(conf, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { home, dir, conf, ledger: path.join(dir, "ledger.json") };
}
const baseCfg = (installs) => ({ allowedOrigins: [ORIGIN], linkTtlDays: 60, installations: installs || { local: { baseUrl: "http://127.0.0.1:47901", reach: { type: "http", url: "http://127.0.0.1:47901", issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope: { sessions: ["outro-main"], agents: ["outro"] } } } });
function pair(h, args, extraEnv = {}, input) {
  const r = spawnSync("bun", ["--no-env-file", PAIR, ...args], { env: { ...cleanEnv, HOME: h.home, RAVI_CONNECT_CONFIG: h.conf, ...extraEnv }, cwd: h.home, encoding: "utf8", input, timeout: 120000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, out: r.stdout, err: r.stderr, all: (r.stdout || "") + (r.stderr || "") };
}
function pairAsync(h, args, extraEnv = {}) {
  return new Promise((res) => {
    const p = spawn("bun", ["--no-env-file", PAIR, ...args], { env: { ...cleanEnv, HOME: h.home, RAVI_CONNECT_CONFIG: h.conf, ...extraEnv }, cwd: h.home });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => { let json = null; try { json = JSON.parse(out); } catch {} res({ code, json, out, err, all: out + err, pid: p.pid }); });
  });
}
const errc = (r) => (r.json && r.json.error ? r.json.error.code : r.json && r.json.ok ? "OK" : (r.err.match(/\(([A-Z_]+)\)/) || [])[1] || `exit${r.code}`);
// real gateway (gateway2.ts from the e2e) on a fixed port, isolated state
async function startGateway(port, tag) {
  const state = fs.mkdtempSync(path.join(S, `state-atk-${tag}-`));
  const run = fs.mkdtempSync(path.join(S, `run-atk-${tag}-`));
  const ready = path.join(run, "ready"), adminFile = path.join(run, "admin.key");
  const p = spawn("bun", ["--no-env-file", path.join(AT, "..", "e2e", "gateway2.ts")], { cwd: RAVI_COPY, env: { ...cleanEnv, RAVI_COPY, GW_PORT: String(port), READY_FILE: ready, ADMIN_KEY_FILE: adminFile, RAVI_STATE_DIR: state, NATS_URL: "nats://127.0.0.1:1", RAVI_SUPPRESS_AUDIT_EVENTS: "1", RAVI_CORS_ORIGINS: ORIGIN, KEEP_MS: "1200000" }, stdio: ["ignore", fs.openSync(path.join(run, "gw.log"), "a"), fs.openSync(path.join(run, "gw.log"), "a")] });
  for (let i = 0; i < 150; i++) { if (fs.existsSync(ready)) break; await new Promise((r) => setTimeout(r, 200)); }
  if (!fs.existsSync(ready)) throw new Error("gateway did not start " + tag);
  return { url: `http://127.0.0.1:${port}`, admin: fs.readFileSync(adminFile, "utf8").trim(), state, run, proc: p, stop: () => p.kill("SIGKILL") };
}
const gw = async (base, cmd, key, body = {}) => {
  const r = await fetch(`${base}/api/v1/${cmd}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const write0600 = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, v, { mode: 0o600 }); fs.chmodSync(f, 0o600); };
function save(file) { fs.writeFileSync(path.join(AT, file), JSON.stringify(results, null, 2).split(S).join("<work>").replace(/rctx_[A-Za-z0-9_-]+/g, "[key]")); }
module.exports = { fs, path, os, spawnSync, spawn, webcrypto, S, AT, SKILL, PAIR, CONNECT_JS, RAVI_COPY, ORIGIN, cleanEnv, results, rec, b64u, canon, mkReq, mkHome, baseCfg, pair, pairAsync, errc, startGateway, gw, write0600, save };
