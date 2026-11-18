// A1: request parsing, phrase normalisation, key files, config injection. No gateway needed (check + status without probe).
const L = require("./lib.cjs");
const { fs, path, rec, mkReq, mkHome, baseCfg, pair, errc, b64u, canon, write0600, webcrypto } = L;
(async () => {
  const h = mkHome("parse", baseCfg());
  const chk = (text) => pair(h, ["check", text, "--json"]);
  // --- parsing
  const good = await mkReq();
  const ws = good.text.slice(0, 30) + " \n\t  ﻿" + good.text.slice(30);
  const r1 = chk(ws);
  rec("P-ws: ASCII + Unicode whitespace (NBSP, U+2028, BOM) inside the text is stripped and accepted", r1.code === 0 ? "held (accepted as same request; benign)" : "info", errc(r1));
  const g2 = await mkReq();
  const zw = g2.text.slice(0, 30) + "​" + g2.text.slice(30);
  rec("P-zw: zero-width space inside the text", chk(zw).code === 3 ? "held" : "WEAK", errc(chk(zw)));
  const homo = (await mkReq()).text.replace("ravi-connect", "ravі-connect"); // Cyrillic i
  rec("P-homoglyph prefix", chk(homo).code === 3 ? "held" : "WEAK", errc(chk(homo)));
  const dup = await mkReq({ rawText: (r) => canon(r).replace(/}$/, `,"iat":${r.iat + 1}}`) });
  rec("P-dupkey: duplicate iat key", chk(dup.text).code === 3 ? "held" : "WEAK", errc(chk(dup.text)));
  const dupI = await mkReq({ rawText: (r) => canon(r).replace('{"v":1,', '{"v":1,"installs":["local","vps1"],') });
  rec("P-dupkey2: installs given twice (first wins? last wins?)", chk(dupI.text).code === 3 ? "held" : "WEAK", errc(chk(dupI.text)));
  const strs = {};
  for (const [k, f] of Object.entries({ v: (r) => canon(r).replace('"v":1', '"v":"1"'), iat: (r) => canon(r).replace(`"iat":${r.iat}`, `"iat":"${r.iat}"`), iatExp: (r) => canon(r).replace(`"iat":${r.iat}`, `"iat":${r.iat / 1000}e3`), iatFloat: (r) => canon(r).replace(`"iat":${r.iat}`, `"iat":${r.iat}.0`), negZero: (r) => canon({ ...r, iat: 0 }).replace('"iat":0', '"iat":-0') }))
    strs[k] = errc(chk((await mkReq({ rawText: f })).text));
  rec("P-numstr: numbers as strings / exponent / .0 / -0", Object.values(strs).every((c) => ["SCHEMA", "REQUEST_TOO_OLD"].includes(c)) ? "held" : "WEAK", strs);
  const proto = {};
  for (const n of ["__proto__", "constructor", "toString", "hasownproperty", "prototype"]) proto[n] = errc(chk((await mkReq({ installs: [n] })).text));
  const protoKey = await mkReq({ rawText: (r) => canon(r).replace('"v":1', '"__proto__":{"v":1},"v":1') });
  proto.protoKeyInObject = errc(chk(protoKey.text));
  const ctor = await mkReq({ preset: "constructor" });
  proto.presetConstructor = errc(chk(ctor.text));
  proto.presetProto = errc(chk((await mkReq({ preset: "__proto__" })).text));
  rec("P-proto: __proto__/constructor as installation names, preset, extra key", Object.values(proto).every((c) => c !== "OK") ? "held" : "WEAK", proto);
  // 2000-char body
  const pad = "x".repeat(1);
  const bigR = await mkReq({ installs: ["local", "a1", "a2", "a3", "a4", "a5", "a6", "a7"] });
  const long = "ravi-connect:v1:" + "A".repeat(2001);
  rec("P-long: body of 2001 chars (1 MB and 5 MB go through stdin in a1b: a 1 MB argv is refused by the OS)", chk(long).code === 3 ? "held" : "WEAK", [errc(chk(long)), bigR.text.length]);
  // public key off the curve / infinity / x=p
  const pts = { zero: { x: b64u(Buffer.alloc(32)), y: b64u(Buffer.alloc(32)) }, offCurve: { ...good.r.pub, y: b64u(Buffer.alloc(32, 7)) }, xEqP: { x: b64u(Buffer.from("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", "hex")), y: good.r.pub.y } };
  const ptRes = {};
  for (const [k, pub] of Object.entries(pts)) ptRes[k] = errc(chk((await mkReq({ pub })).text));
  rec("P-curve: public key (0,0)=infinity encoding, off-curve y, x=p", Object.values(ptRes).every((c) => c === "SCHEMA") ? "held" : "WEAK", ptRes);
  const iats = { past: errc(chk((await mkReq({ iat: 1 })).text)), future: errc(chk((await mkReq({ iat: Date.now() + 120000 })).text)), negative: errc(chk((await mkReq({ iat: -5 })).text)), huge: errc(chk((await mkReq({ iat: Number.MAX_SAFE_INTEGER })).text)), skew50s: errc(chk((await mkReq({ iat: Date.now() + 50000 })).text)) };
  rec("P-iat: far past, far future, negative, MAX_SAFE_INTEGER, +50s skew", iats.past === "REQUEST_TOO_OLD" && iats.future === "REQUEST_FROM_FUTURE" && iats.huge === "REQUEST_FROM_FUTURE" && iats.negative === "REQUEST_TOO_OLD" ? "held" : "WEAK", iats);
  // --- phrase normalisation (approve without gateway: reach unreachable so it fails after phrase check; we only look at PHRASE_MISMATCH vs not)
  const ph = await mkReq();
  const c = chk(ph.text);
  const P = c.json.phrase;
  const accent = (s) => s.replace(/A/g, "Á").replace(/O/g, "Ó");
  const variants = { lower: P.toLowerCase(), spaces: P.replace(/-/g, " "), underscores: P.replace(/-/g, "_"), spacedHyphen: P.replace(/-/g, " - "), doubleSpace: P.replace(/-/g, "  "), accents: accent(P), cyrillicA: P.replace(/A/g, "А"), fullwidth: P.replace(/[A-Z]/g, (x) => String.fromCharCode(x.charCodeAt(0) + 0xfee0)), zeroWidth: P.replace("-", "​-"), dotlessI: P.toLowerCase().replace(/i/g, "ı"), longS: P.toLowerCase().replace(/s/g, "ſ"), nbsp: P.replace(/-/g, " "), quote: P + "'", trailingDot: P + "." };
  const vr = {};
  // Lock-free probe: approve fails at PHRASE_MISMATCH before any issue; with a matching phrase it goes on and fails at issue (no key file) -> ISSUE_FAILED. Each matching attempt burns the nonce, so each variant gets its own request.
  for (const [k, v] of Object.entries(variants)) {
    // A fresh request whose phrase we know only after check -> re-derive the variant from its phrase
    const q = await mkReq();
    const cq = chk(q.text);
    const vv = variants[k] === undefined ? null : Object.entries({ [k]: null }) && ({ lower: (x) => x.toLowerCase(), spaces: (x) => x.replace(/-/g, " "), underscores: (x) => x.replace(/-/g, "_"), spacedHyphen: (x) => x.replace(/-/g, " - "), doubleSpace: (x) => x.replace(/-/g, "  "), accents: accent, cyrillicA: (x) => x.replace(/A/g, "А"), fullwidth: (x) => x.replace(/[A-Z]/g, (y) => String.fromCharCode(y.charCodeAt(0) + 0xfee0)), zeroWidth: (x) => x.replace("-", "​-"), dotlessI: (x) => x.toLowerCase().replace(/i/g, "ı"), longS: (x) => x.toLowerCase().replace(/s/g, "ſ"), nbsp: (x) => x.replace(/-/g, " "), quote: (x) => x + "'", trailingDot: (x) => x + "." })[k](cq.json.phrase);
    const a = pair(h, ["approve", q.text, "--phrase", vv, "--json"]);
    vr[k] = { phrase: vv, result: errc(a) === "PHRASE_MISMATCH" ? "refused" : "accepted(" + errc(a) + ")" };
    pair(h, ["cancel"]);
  }
  fs.writeFileSync(path.join(L.AT, "a1-phrase-variants.json"), JSON.stringify(vr, null, 2));
  const acc = Object.fromEntries(Object.entries(vr).map(([k, v]) => [k, v.result]));
  rec("PH-norm: phrase variants (accepted = passed the phrase check)", "info", acc);
  // --- key files (status without --probe reads the http issuer key)
  const kf = path.join(h.dir, "issuer.key");
  const real = "rctx_" + "A".repeat(40);
  const kres = {};
  const tgt644 = path.join(h.home, "k644"); fs.writeFileSync(tgt644, real + "\n", { mode: 0o644 }); fs.chmodSync(tgt644, 0o644);
  const st = () => { const r = pair(h, ["status", "--json"]); return { code: r.code, problem: r.json && r.json.installations ? r.json.installations[0].problem || r.json.installations[0].issuerKeyFile : r.all.slice(0, 160), leak: r.all.includes("rctx_") }; };
  fs.rmSync(kf, { force: true }); fs.symlinkSync(tgt644, kf); kres.symlinkTo0644 = st();
  fs.rmSync(kf); write0600(kf, real + "\nrctx_" + "B".repeat(40) + "\n"); kres.twoLines = st();
  write0600(kf, real + "   \n"); kres.trailingSpaces = st();
  write0600(kf, "  " + real + "\t\n"); kres.leadingSpaces = st();
  fs.rmSync(kf); fs.mkdirSync(kf, { mode: 0o700 }); kres.directory = st();
  fs.rmSync(kf, { recursive: true }); write0600(kf, "not a key but a secret-looking string SECRET123\n"); kres.garbageNoEcho = st();
  fs.rmSync(kf); fs.symlinkSync("/dev/zero", kf); kres.devZero = "skipped (would hang readFileSync)";
  fs.rmSync(kf); fs.mkfifo ? 0 : 0;
  write0600(kf, real + "\n");
  rec("KF: key file attacks via status (symlink->0644, two lines, spaces, directory, garbage)", /modo 644/.test(kres.symlinkTo0644.problem || "") && /KEY_FILE_INVALID|não contém/.test(JSON.stringify(kres.twoLines)) && !Object.values(kres).some((x) => x.leak) && !JSON.stringify(kres).includes("SECRET123") ? "held" : "WEAK", kres);
  // --- config injection
  const inj = {};
  const tryCfg = (tag, inst) => { const hh = mkHome("cfg", baseCfg({ x1: inst })); const r = pair(hh, ["status", "--json"]); return `${r.code}:${errc(r)}`; };
  const sshI = (o) => ({ baseUrl: "http://127.0.0.1:7801", reach: { type: "ssh", alias: "vps", issuerKeyFile: "~/.ravi/pairing/issuer.key", ...o }, scope: { sessions: ["a"], agents: [] } });
  inj.aliasDash = tryCfg("a", sshI({ alias: "-oProxyCommand=touch /tmp/pwn" }));
  inj.aliasSpace = tryCfg("a", sshI({ alias: "vps -oX" }));
  inj.raviSpace = tryCfg("a", sshI({ ravi: "/opt/my ravi" }));
  inj.raviSubst = tryCfg("a", sshI({ ravi: "$(touch /tmp/pwn)" }));
  inj.raviBacktick = tryCfg("a", sshI({ ravi: "`id`" }));
  inj.keyQuote = tryCfg("a", sshI({ issuerKeyFile: "~/.ravi/x'; id; '" }));
  inj.keyDollar = tryCfg("a", sshI({ issuerKeyFile: "~/$HOME/x" }));
  inj.scopeStar = tryCfg("a", { ...sshI({}), scope: { sessions: ["*"], agents: [] } });
  inj.scopeColon = tryCfg("a", { ...sshI({}), scope: { sessions: ["a:b"], agents: [] } });
  inj.scopeComma = tryCfg("a", { ...sshI({}), scope: { sessions: ["a,admin:system:*"], agents: [] } });
  inj.scopeShell = tryCfg("a", { ...sshI({}), scope: { sessions: ["a;id"], agents: [] } });
  inj.scopeExtraKey = tryCfg("a", { ...sshI({}), scope: { sessions: [], agents: [], extra: ["x"] } });
  inj.baseUrlCreds = tryCfg("a", { ...sshI({}), baseUrl: "http://u:p@127.0.0.1:7801" });
  inj.baseUrlPath = tryCfg("a", { ...sshI({}), baseUrl: "http://127.0.0.1:7801/x" });
  inj.baseUrlEvil = tryCfg("a", { ...sshI({}), baseUrl: "http://127.0.0.1.evil.com:7801" });
  inj.httpUrlRemote = tryCfg("a", { baseUrl: "http://127.0.0.1:1", reach: { type: "http", url: "http://10.0.0.1:1", issuerKeyFile: "~/k" }, scope: { sessions: [], agents: [] } });
  inj.protoName = (() => { const hh = mkHome("cfg", { ...baseCfg(), installations: JSON.parse('{"__proto__":' + JSON.stringify(sshI({})) + "}") }); const r = pair(hh, ["status", "--json"]); return `${r.code}:${errc(r)}`; })();
  inj.revokeViaEval = tryCfg("a", { ...sshI({}), revoke: { via: "cli", keyFile: "~/k;id" } });
  // ravi with relative traversal is accepted (owner-controlled, info only)
  inj.raviTraversal = tryCfg("a", sshI({ ravi: "../../../../tmp/x" }));
  rec("CFG: config values trying to inject ssh options or shell", Object.entries(inj).filter(([k]) => k !== "raviTraversal").every(([, v]) => /^2:/.test(v)) ? "held" : "WEAK", inj);
  // --- out-dir: does not run approve (needs gateway); a2 covers it
  L.save("a1-results.json");
})().catch((e) => { console.error(e); L.save("a1-results.json"); process.exit(1); });
