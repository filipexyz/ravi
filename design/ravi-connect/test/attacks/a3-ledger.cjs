// A3: nonce ledger: parallel checks/approves, hand edits, symlinks, stale locks, modes. Real gateway for issuance.
const L = require("./lib.cjs");
const { fs, path, rec, mkReq, mkHome, baseCfg, pair, pairAsync, errc, startGateway, gw, write0600 } = L;
(async () => {
  const G = await startGateway(47901, "ledger");
  try {
    const mkH = (tag) => {
      const h = mkHome(tag, baseCfg());
      const caps = pair(h, ["caps", "local"]).out.trim();
      return { h, caps };
    };
    const { h, caps } = mkH("ledger");
    const iss = await gw(G.url, "context/issue", G.admin, { cliName: "pairing-issuer", allow: caps, ttl: "89d" });
    write0600(path.join(h.dir, "issuer.key"), iss.json.contextKey + "\n");
    const KEYFILE = path.join(h.dir, "issuer.key");
    const newH = (tag) => { const x = mkHome(tag, baseCfg()); fs.copyFileSync(KEYFILE, path.join(x.dir, "issuer.key")); fs.chmodSync(path.join(x.dir, "issuer.key"), 0o600); return x; };
    const ledger = (x) => JSON.parse(fs.readFileSync(x.ledger, "utf8"));
    const countLinks = async () => { const r = await gw(G.url, "context/list", G.admin, {}); return r.json; };

    // 1. parallel checks of the same request
    const r1 = await mkReq();
    const par = await Promise.all(Array.from({ length: 10 }, () => pairAsync(h, ["check", r1.text, "--json"])));
    const okc = par.filter((p) => p.code === 0).length;
    rec("LG-1: 10 parallel checks of one request", okc === 1 ? "held" : "WEAK", { ok: okc, codes: par.map(errc) });
    // 2. parallel approves of the same checked request
    const phrase = par.find((p) => p.code === 0).json.phrase;
    const apps = await Promise.all(Array.from({ length: 6 }, () => pairAsync(h, ["approve", r1.text, "--phrase", phrase, "--json"])));
    const oka = apps.filter((p) => p.code === 0).length;
    rec("LG-2: 6 parallel approves of one checked request", oka === 1 ? "held" : "WEAK", { ok: oka, codes: apps.map(errc), linksInLedger: ledger(h).links.length });
    // 3a. hand-edit the phrase in the ledger between check and approve
    const h3 = newH("edit");
    const r3 = await mkReq();
    const c3 = pair(h3, ["check", r3.text, "--json"]);
    const l3 = ledger(h3); l3.nonces[r3.r.nonce].phrase = "QUALQUER-COISA-SERVE"; fs.writeFileSync(h3.ledger, JSON.stringify(l3));
    const a3 = pair(h3, ["approve", r3.text, "--phrase", "qualquer coisa serve", "--json"]);
    rec("LG-3a: ledger phrase edited by hand -> approve with a phrase the owner never saw", a3.code === 0 ? "WEAK (approve trusts ledger phrase, not the phrase derived from the request hash)" : "held", { realPhrase: c3.json.phrase, approve: errc(a3) });
    // 3b. reset state to checked after a successful approve -> second link for the same request
    const l3b = ledger(h3); l3b.nonces[r3.r.nonce].state = "checked"; l3b.nonces[r3.r.nonce].checkedAt = Date.now(); fs.writeFileSync(h3.ledger, JSON.stringify(l3b));
    const a3b = pair(h3, ["approve", r3.text, "--phrase", "qualquer coisa serve", "--json"]);
    const entry = ledger(h3).links.find((k) => k.nonce === r3.r.nonce);
    rec("LG-3b: state reset by hand -> same request approved twice", a3b.code === 0 ? "WEAK (ledger is the only replay guard; whoever can write it can replay)" : "held", { second: errc(a3b), installsUnderOneEntry: entry && entry.installs.map((i) => i.contextId) });
    // 3c. nonce deleted by hand -> check again
    const l3c = ledger(h3); delete l3c.nonces[r3.r.nonce]; fs.writeFileSync(h3.ledger, JSON.stringify(l3c));
    const c3c = pair(h3, ["check", r3.text, "--json"]);
    rec("LG-3c: nonce removed by hand -> request accepted again (until 10 min)", c3c.code === 0 ? "WEAK (same root cause)" : "held", errc(c3c));
    // 4. symlink at ledger.json.tmp -> write goes through the link, and chmod 600 hits the target
    const h4 = newH("sym");
    const victim = path.join(h4.home, "victim.txt"); fs.writeFileSync(victim, "owner data\n", { mode: 0o644 }); fs.chmodSync(victim, 0o644);
    fs.symlinkSync(victim, h4.ledger + ".tmp");
    const c4 = pair(h4, ["check", (await mkReq()).text, "--json"]);
    const vAfter = fs.readFileSync(victim, "utf8");
    const vMode = (fs.statSync(victim).mode & 0o777).toString(8);
    const ledgerIsLink = fs.lstatSync(h4.ledger).isSymbolicLink();
    rec("LG-4a: symlink planted at ledger.json.tmp", vAfter.includes("nonces") ? "WEAK (target overwritten with ledger JSON and chmod 600; ledger.json becomes the symlink)" : "held", { check: errc(c4), victimOverwritten: vAfter.includes("nonces"), victimMode: vMode, ledgerIsNowSymlink: ledgerIsLink });
    const h4b = newH("sym2");
    const v2 = path.join(h4b.home, "elsewhere.json"); fs.writeFileSync(v2, JSON.stringify({ v: 1, nonces: {}, links: [] }), { mode: 0o644 });
    fs.symlinkSync(v2, h4b.ledger);
    pair(h4b, ["check", (await mkReq()).text, "--json"]);
    rec("LG-4b: symlink at ledger.json", "info", { ledgerStillSymlink: fs.lstatSync(h4b.ledger).isSymbolicLink(), targetMode: (fs.statSync(v2).mode & 0o777).toString(8), note: "rename replaces the link with a regular 0600 file; target was read once and left alone" });
    const h4c = newH("sym3");
    const v3 = path.join(h4c.home, "lockvictim"); fs.writeFileSync(v3, "keep me\n");
    fs.symlinkSync(v3, h4c.ledger + ".lock");
    const c4c = pair(h4c, ["check", (await mkReq()).text, "--json"]);
    rec("LG-4c: symlink at ledger.json.lock", fs.existsSync(v3) && fs.readFileSync(v3, "utf8") === "keep me\n" ? "held (link treated as dead-pid lock and unlinked; target untouched)" : "WEAK", { check: errc(c4c), target: fs.existsSync(v3) ? fs.readFileSync(v3, "utf8").trim() : "gone" });
    // 5. stale locks
    const h5 = newH("lock");
    fs.writeFileSync(h5.ledger + ".lock", `999999 ${Date.now()}\n`);
    const c5 = pair(h5, ["check", (await mkReq()).text, "--json"]);
    fs.writeFileSync(h5.ledger + ".lock", `1 ${Date.now()}\n`); // pid 1 is alive (EPERM or own)
    const t5 = Date.now(); const c5b = pair(h5, ["check", (await mkReq()).text, "--json"]); const ms5 = Date.now() - t5;
    fs.writeFileSync(h5.ledger + ".lock", `1 ${Date.now() - 31000}\n`);
    const c5c = pair(h5, ["check", (await mkReq()).text, "--json"]);
    fs.writeFileSync(h5.ledger + ".lock", "");
    const c5d = pair(h5, ["check", (await mkReq()).text, "--json"]);
    const emptyLeft = fs.existsSync(h5.ledger + ".lock");
    rec("LG-5: dead-pid lock broken; live-pid fresh lock -> LEDGER_LOCKED; live-pid >30 s lock broken; fresh empty lock waits", errc(c5) === "OK" && errc(c5b) === "LEDGER_LOCKED" && errc(c5c) === "OK" ? "held" : "WEAK", { deadPid: errc(c5), livePid: errc(c5b) + ` after ${ms5} ms`, liveOld: errc(c5c), emptyFresh: errc(c5d) });
    if (emptyLeft) fs.rmSync(h5.ledger + ".lock");
    // 5b. stale-lock break race: many processes start while a dead-pid lock exists -> lost updates?
    let lost = 0, runs = 0, detail = [];
    for (let round = 0; round < 8; round++) {
      const hr = newH("race");
      fs.writeFileSync(hr.ledger, JSON.stringify({ v: 1, nonces: {}, links: [] }), { mode: 0o600 });
      fs.writeFileSync(hr.ledger + ".lock", `999999 ${Date.now()}\n`);
      const reqs = await Promise.all(Array.from({ length: 16 }, () => mkReq()));
      const rs = await Promise.all(reqs.map((q) => pairAsync(hr, ["check", q.text, "--json"])));
      const okN = rs.filter((x) => x.code === 0).length;
      const inLedger = Object.keys(ledger(hr).nonces).length;
      runs++; if (inLedger < okN) lost++;
      detail.push(`${okN} ok / ${inLedger} in ledger`);
    }
    rec("LG-5b: stale lock + 16 concurrent checks (8 rounds): every OK check recorded?", lost ? "WEAK (TOCTOU in breakStaleLock: two processes held the lock; consumed nonces lost from the ledger)" : "held", { roundsWithLoss: lost, detail });
    // 6. ledger 0644 before first use
    const h6 = newH("mode");
    fs.writeFileSync(h6.ledger, JSON.stringify({ v: 1, nonces: {}, links: [] }), { mode: 0o644 }); fs.chmodSync(h6.ledger, 0o644);
    const st6 = pair(h6, ["list", "--json"]);
    rec("LG-6: ledger left 0644", "info", { afterList: (fs.statSync(h6.ledger).mode & 0o777).toString(8), note: "no refusal and no warning; any write re-creates it 0600 via tmp+rename (holds no key)" });
    // 7. corrupt ledger
    const h7 = newH("corrupt");
    fs.writeFileSync(h7.ledger, '{"v":1,"nonces":{}, "links": [ rctx_' + "Z".repeat(30) + " ]", { mode: 0o600 });
    const c7 = pair(h7, ["check", (await mkReq()).text]);
    rec("LG-7: corrupt ledger containing a key-looking string", c7.code !== 0 && !c7.all.includes("rctx_") ? "held" : "WEAK", c7.all.trim().slice(0, 200));
  } finally {
    G.stop();
    L.save("a3-results.json");
  }
})().catch((e) => { console.error(e); L.save("a3-results.json"); process.exit(1); });
