// A4b: process arguments and environments while approve runs (http "local" + ssh stand-in "vps1" with the REAL CLI).
// Matches only real-looking keys (rctx_ + 20 chars) so the harness's own command text is not a hit.
const L = require("./lib.cjs");
const { fs, path, rec, mkReq, mkHome, pair, pairAsync, errc, startGateway, gw, write0600, ORIGIN } = L;
(async () => {
  const G = await startGateway(47903, "ps");
  const RH = fs.mkdtempSync(path.join(L.S, "atk-remote-"));
  const env = { PATH: path.join(L.AT, "bin-ssh") + ":" + process.env.PATH, ATK_SSH_LOG: path.join(G.run, "ssh.log"), ATK_REMOTE_HOME: RH, ATK_REMOTE_BIN: path.join(L.AT, "bin-remote"), ATK_RAVI_COPY: L.RAVI_COPY, ATK_REMOTE_STATE: G.state, ATK_REMOTE_GW: G.url, ATK_SSH_MODE: "stall:3" };
  const cfg = { allowedOrigins: [ORIGIN], linkTtlDays: 60, installations: { local: { baseUrl: G.url, reach: { type: "http", url: G.url, issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope: { sessions: ["outro-main"], agents: [] } }, vps1: { baseUrl: "http://127.0.0.1:47999", reach: { type: "ssh", alias: "vps1", issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope: { sessions: ["main"], agents: [] } } } };
  const h = mkHome("ps", cfg);
  for (const [n, home] of [["local", h.home], ["vps1", RH]]) {
    const caps = pair(h, ["caps", n], env).out.trim();
    const i = await gw(G.url, "context/issue", G.admin, { cliName: "iss-" + n, allow: caps, ttl: "89d" });
    write0600(path.join(home, ".ravi", "pairing", "issuer.key"), i.json.contextKey + "\n");
  }
  try {
    const q = await mkReq({ installs: ["local", "vps1"] });
    const c = pair(h, ["check", q.text, "--json"], env);
    const run = pairAsync(h, ["approve", q.text, "--phrase", c.json.phrase, "--json"], env);
    const argvHits = new Set(), envHits = new Set(); let scans = 0;
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      for (const pid of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
        try { const cl = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); if (/rctx_[A-Za-z0-9_-]{20,}/.test(cl)) argvHits.add(cl.slice(0, 100)); } catch {}
        try { const en = fs.readFileSync(`/proc/${pid}/environ`, "utf8"); if (/RAVI_CONTEXT_KEY=rctx_/.test(en)) envHits.add(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").slice(0, 80)); } catch {}
      }
      scans++; await new Promise((r) => setTimeout(r, 10));
    }
    const a = await run;
    rec("LK-ps: real-looking key in any process argv during approve", argvHits.size === 0 ? "held" : "WEAK", { scans, argvHits: [...argvHits], approve: errc(a) });
    rec("LK-env: processes carrying RAVI_CONTEXT_KEY in their environment (same-user readable /proc/<pid>/environ)", "info", { envHits: [...envHits], note: "only the remote `ravi` (by design: key in env, not argv); readable only by the same uid" });
  } finally { G.stop(); L.save("a4b-results.json"); }
})();
