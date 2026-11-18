// A4: issuance paths: ssh timeout orphans, pipe holders, out-dir, disconnect edge cases, leaks (stdout/stderr/json/ledger/
// out-dir file/process arguments). Real gateway; the "VPS" is the same gateway reached through an ssh stand-in that runs
// the REAL CLI source entrypoint.
const L = require("./lib.cjs");
const { fs, path, rec, mkReq, mkHome, pair, pairAsync, errc, startGateway, gw, write0600, ORIGIN } = L;
const capStr = (c) => (typeof c === "string" ? c : `${c.permission}:${c.objectType}:${c.objectId}`);
(async () => {
  const G = await startGateway(47902, "issue");
  const REMOTE_HOME = fs.mkdtempSync(path.join(L.S, "atk-remote-"));
  const SSH_LOG = path.join(G.run, "ssh.log");
  const env = { PATH: path.join(L.AT, "bin-ssh") + ":" + process.env.PATH, ATK_SSH_LOG: SSH_LOG, ATK_REMOTE_HOME: REMOTE_HOME, ATK_REMOTE_BIN: path.join(L.AT, "bin-remote"), ATK_RAVI_COPY: L.RAVI_COPY, ATK_REMOTE_STATE: G.state, ATK_REMOTE_GW: G.url };
  const cfg = { allowedOrigins: [ORIGIN], linkTtlDays: 60, installations: {
    local: { baseUrl: G.url, reach: { type: "http", url: G.url, issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope: { sessions: ["outro-main"], agents: ["outro"] } },
    vps1: { baseUrl: "http://127.0.0.1:47999", reach: { type: "ssh", alias: "vps1", issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope: { sessions: ["main"], agents: [] } } } };
  const h = mkHome("issue", cfg);
  const caps = pair(h, ["caps", "local"], env).out.trim();
  const capsV = pair(h, ["caps", "vps1"], env).out.trim();
  const issL = await gw(G.url, "context/issue", G.admin, { cliName: "pairing-issuer", allow: caps, ttl: "89d" });
  const issV = await gw(G.url, "context/issue", G.admin, { cliName: "pairing-issuer-vps", allow: capsV, ttl: "89d" });
  write0600(path.join(h.dir, "issuer.key"), issL.json.contextKey + "\n");
  write0600(path.join(REMOTE_HOME, ".ravi", "pairing", "issuer.key"), issV.json.contextKey + "\n");
  const KEYS = [G.admin, issL.json.contextKey, issV.json.contextKey];
  const allOut = [];
  const P = (args, extra = {}, input) => { const r = pair(h, args, { ...env, ...extra }, input); allOut.push(r.all); return r; };
  const flow = async (installs, approveExtra = [], extraEnv = {}) => {
    const q = await mkReq({ installs });
    const c = P(["check", q.text, "--json"]);
    const a = P(["approve", q.text, "--phrase", c.json.phrase, "--json", ...approveExtra], extraEnv);
    return { q, c, a };
  };
  const connectCtx = async () => {
    const r = await gw(G.url, "context/list", G.admin, {});
    const list = (r.json && (r.json.contexts || r.json.items || r.json)) || [];
    return Array.isArray(list) ? list.filter((x) => String(x.issuedFor || x.cliName || "").startsWith("connect:")) : list;
  };
  try {
    const st = P(["status", "--probe", "--json"]);
    rec("setup: status --probe both installations (vps1 through ssh stand-in + REAL CLI)", st.json && st.json.installations.every((i) => !i.problem || /a página não alcança http:\/\/127\.0\.0\.1:47999/.test(i.problem)) ? "ok (vps1 baseUrl 47999 is a fake tunnel port: status --probe now reports it)" : "setup-problem", st.json ? st.json.installations.map((i) => `${i.name}:${i.problem || "ok"}:${i.note || ""}`) : st.all.slice(0, 300));
    // --- process arguments while running: scan /proc/*/cmdline during an ssh issue that stalls 3 s
    const q0 = await mkReq({ installs: ["local", "vps1"] });
    const c0 = P(["check", q0.text, "--json"]);
    const running = pairAsync(h, ["approve", q0.text, "--phrase", c0.json.phrase, "--json"], { ...env, ATK_SSH_MODE: "stall:3" });
    const seen = new Set(); let scans = 0;
    const until = Date.now() + 3500;
    while (Date.now() < until) {
      for (const pid of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
        try { const cl = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); if (cl.includes("rctx_")) seen.add(cl.slice(0, 120)); } catch {}
      }
      scans++; await new Promise((r) => setTimeout(r, 20));
    }
    const a0 = await running; allOut.push(a0.all);
    rec("LK-ps: any process argv containing rctx_ while approve (http + ssh/real CLI) runs", seen.size === 0 ? "held" : "WEAK", { scans, hits: [...seen], approve: errc(a0) });
    // --- ssh stall longer than the total timeout AFTER the remote issue -> orphan link
    const before = (await connectCtx()).length;
    const t = Date.now();
    const o = await flow(["vps1"], [], { ATK_SSH_MODE: "stall:6", RAVI_CONNECT_SSH_TIMEOUT_MS: "2500" });
    const after = await connectCtx();
    const led = JSON.parse(fs.readFileSync(h.ledger, "utf8"));
    const recorded = led.links.some((k) => k.nonce === o.q.r.nonce);
    const orphan = after.filter((x) => String(x.issuedFor || x.cliName).endsWith(o.q.r.nonce.slice(0, 8)));
    rec("IS-orphan: ssh times out after the remote `context issue` ran", orphan.length && !recorded ? "WEAK (live 60-day link on the VPS, not in the ledger, so list/disconnect cannot see it; nonce marked failed)" : "held", { approve: errc(o.a), ms: Date.now() - t, contextsBefore: before, orphanOnGateway: orphan.map((x) => ({ id: x.contextId || x.id, issuedFor: x.issuedFor || x.cliName, status: x.status })), inLedger: recorded, nonceState: led.nonces[o.q.r.nonce].state });
    // --- a background child holding the pipes after ssh exits 0 (ControlPersist-like)
    const t2 = Date.now();
    const o2 = await flow(["vps1"], [], { ATK_SSH_MODE: "hold:8", RAVI_CONNECT_SSH_TIMEOUT_MS: "3000" });
    const led2 = JSON.parse(fs.readFileSync(h.ledger, "utf8"));
    rec("IS-hold: ssh exits 0 with the JSON, but a child keeps stdout open (ControlPersist / ProxyCommand child)", errc(o2.a) !== "OK" ? "WEAK (waits for EOF, then the timer reports SSH_TIMEOUT although the link was issued; orphan as above)" : "held", { approve: errc(o2.a), ms: Date.now() - t2, inLedger: led2.links.some((k) => k.nonce === o2.q.r.nonce), sshMode: "hold:8", timeoutMs: 3000 });
    // --- out-dir
    const od = fs.mkdtempSync(path.join(L.S, "atk-out-"));
    const victim = path.join(od, "precious.html"); fs.writeFileSync(victim, "<h1>owner page</h1>\n", { mode: 0o644 });
    fs.symlinkSync(victim, path.join(od, "index.html"));
    const o3 = await flow(["local"], ["--out-dir", od]);
    rec("OD-1: --out-dir whose index.html is a symlink to another file", fs.readFileSync(victim, "utf8").includes("ravi-connect-envelope") ? "WEAK (target overwritten through the link, mode stays 644)" : "held", { approve: errc(o3.a), victim: fs.readFileSync(victim, "utf8").slice(0, 80), mode: (fs.statSync(victim).mode & 0o777).toString(8) });
    const fileAsDir = path.join(od, "plainfile"); fs.writeFileSync(fileAsDir, "x");
    const o4 = await flow(["local"], ["--out-dir", fileAsDir]);
    const led4 = JSON.parse(fs.readFileSync(h.ledger, "utf8"));
    rec("OD-2: --out-dir is an existing regular file", errc(o4.a) !== "OK" && led4.links.some((k) => k.nonce === o4.q.r.nonce) ? "WEAK (link issued and recorded, then approve dies: no envelope, no reply; owner sees an error while a 60-day link is live)" : "held", { approve: errc(o4.a), msg: o4.a.all.slice(0, 160), linkRecorded: led4.links.some((k) => k.nonce === o4.q.r.nonce) });
    const pageDir = fs.mkdtempSync(path.join(L.S, "atk-painel-")); fs.writeFileSync(path.join(pageDir, "index.html"), "<h1>painel</h1>");
    const o5 = await flow(["local"], ["--out-dir", pageDir]);
    rec("OD-3: --out-dir pointing at the page folder (agent mistake)", fs.readFileSync(path.join(pageDir, "index.html"), "utf8").includes("envelope") ? "WEAK (page index.html replaced silently)" : "held", errc(o5.a));
    // the OD cases are now refused before the request is used: those requests stay checked, so cancel them
    P(["cancel", "--json"]);
    // --- disconnect edge cases (manual default)
    const d = await flow(["local", "vps1"]);
    const PH = d.c.json.phrase;
    const dUnknown = P(["disconnect", PH, "--install", "vps-b", "--json"]);
    rec("DC-1: disconnect --install <unknown name>", dUnknown.json && dUnknown.json.ok === true && /Nada a revogar|"results": \[\]/.test(dUnknown.all) ? "WEAK (ok:true, 'Nada a revogar (já revogado)'; nothing was revoked)" : "held", dUnknown.all.slice(0, 200));
    const dSlash = P(["disconnect", ORIGIN + "/", "--json"]);
    const dCase = P(["disconnect", ORIGIN.toUpperCase().replace("HTTPS", "https"), "--json"]);
    const dScheme = P(["disconnect", "HTTPS://exemplo-painel.ravi.page", "--json"]);
    const dTwoSlash = P(["disconnect", ORIGIN + "//", "--json"]);
    rec("DC-2: origin with trailing slash / upper-case host / upper-case scheme / two slashes", "info", { slash: errc(dSlash) + " " + (dSlash.json && dSlash.json.results ? dSlash.json.results.length + " rows" : ""), upperHost: errc(dCase), upperScheme: errc(dScheme), twoSlashes: errc(dTwoSlash) });
    const manualRow = dSlash.json && dSlash.json.results.find((r) => r.result.startsWith("manual"));
    // owner runs the printed command with the admin key, then repeats
    const ctxId = manualRow && manualRow.contextId;
    if (ctxId) await gw(G.url, "context/revoke", G.admin, { contextId: ctxId, reason: "owner" });
    const dAgain = P(["disconnect", ORIGIN, "--install", manualRow ? manualRow.name : "local", "--json"]);
    rec("DC-3: manual revoke by the owner, repeated disconnect verifies via context info", dAgain.json && dAgain.json.results.some((r) => r.contextId === ctxId && r.result === "revogada") ? "held" : "WEAK", dAgain.json ? dAgain.json.results : dAgain.all.slice(0, 200));
    // manual + ledger contextId swapped by hand to an already revoked context of someone else -> marked revoked while the real link lives?
    const e = await flow(["local"]);
    const other = await gw(G.url, "context/issue", issL.json.contextKey, { cliName: "x", allow: "read:context:whoami", ttl: "1h" });
    await gw(G.url, "context/revoke", G.admin, { contextId: other.json.contextId, reason: "t" });
    const le = JSON.parse(fs.readFileSync(h.ledger, "utf8"));
    const ent = le.links.find((k) => k.nonce === e.q.r.nonce); if (!ent) console.error("DC-4 flow", errc(e.a), e.a.all.slice(0, 300)); const realId = ent.installs[0].contextId; ent.installs[0].contextId = other.json.contextId; fs.writeFileSync(h.ledger, JSON.stringify(le));
    const dSwap = P(["disconnect", e.c.json.phrase, "--json"]);
    const realInfo = await gw(G.url, "context/info", G.admin, { contextId: realId });
    rec("DC-4: ledger contextId swapped to a revoked context with another issuedFor", dSwap.json && dSwap.json.results.every((r) => r.result !== "revogada") ? "held (issuedFor must equal the recorded cliName)" : "WEAK", { results: dSwap.json && dSwap.json.results.map((r) => r.result.slice(0, 40)), realLinkStatus: realInfo.json && realInfo.json.status });
    // phrase that matches several links: hand-copy the phrase onto a second entry (stands for a ground collision)
    const f1 = await flow(["local"]); const f2 = await flow(["local"]);
    const lf = JSON.parse(fs.readFileSync(h.ledger, "utf8")); lf.links.find((k) => k.nonce === f2.q.r.nonce).phrase = f1.c.json.phrase; fs.writeFileSync(h.ledger, JSON.stringify(lf));
    const dMulti = P(["disconnect", f1.c.json.phrase, "--json"]);
    rec("DC-5: one phrase matching two links", "info", { rows: dMulti.json && dMulti.json.results.length, note: "both are acted on (here: two manual commands); no prompt that more than one link matched" });
    // --- leaks everywhere
    const files = [h.ledger, path.join(od, "precious.html"), path.join(pageDir, "index.html")].filter(fs.existsSync).map((f) => fs.readFileSync(f, "utf8"));
    const sshLog = fs.readFileSync(SSH_LOG, "utf8");
    const blob = allOut.join("\n") + files.join("\n") + sshLog;
    rec("LK-all: rctx_ in any stdout/stderr/--json/error output, ledger, out-dir file or ssh argv log of this run", !blob.includes("rctx_") && !KEYS.some((k) => blob.includes(k.slice(5))) ? "held" : "WEAK", { bytesScanned: blob.length, outputs: allOut.length });
  } finally {
    G.stop();
    L.save("a4-results.json");
  }
})().catch((e) => { console.error(e); L.save("a4-results.json"); process.exit(1); });
