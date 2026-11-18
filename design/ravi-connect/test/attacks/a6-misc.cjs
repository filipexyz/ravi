// A6: shortened links, status blind spots for over-broad issuers, LEAK_GUARD side effect, heavier stale-lock race.
const L = require("./lib.cjs");
const { fs, path, rec, mkReq, mkHome, pair, pairAsync, errc, startGateway, gw, write0600, ORIGIN } = L;
(async () => {
  const G = await startGateway(47905, "misc");
  const A = G.url;
  const mk = (tag, scope = { sessions: ["outro-main"], agents: ["outro"] }) => mkHome(tag, { allowedOrigins: [ORIGIN], linkTtlDays: 60, installations: { local: { baseUrl: A, reach: { type: "http", url: A, issuerKeyFile: "~/.ravi/pairing/issuer.key" }, scope } } });
  try {
    // shortened: issuer of 30 days
    const h = mk("short");
    const caps = pair(h, ["caps", "local"]).out.trim();
    const iss = await gw(A, "context/issue", G.admin, { cliName: "iss", allow: caps, ttl: "30d" });
    write0600(path.join(h.dir, "issuer.key"), iss.json.contextKey + "\n");
    const q = await mkReq(); const c = pair(h, ["check", q.text, "--json"]);
    const a = pair(h, ["approve", q.text, "--phrase", c.json.phrase, "--json"]);
    rec("MS-short: issuer that expires in 30 days; confirmation promised 60", a.json && a.json.shortened.length === 1 ? "held (reply warns after the fact; the confirmation the owner approved still said 60 dias)" : "WEAK", { confirmationSays: (c.json.confirmation.match(/Validade: .*/) || [])[0], shortened: a.json && a.json.shortened, replyHead: a.json && a.json.reply.split("\n").slice(0, 2) });
    // status --probe with an over-broad issuer (extra view:system:events, read:sessions:read, mutate:agents? no: forbidden)
    const h2 = mk("broad");
    const caps2 = pair(h2, ["caps", "local"]).out.trim() + ",view:system:events,read:sessions:read,access:session:segredo";
    const iss2 = await gw(A, "context/issue", G.admin, { cliName: "iss-broad", allow: caps2, ttl: "89d" });
    write0600(path.join(h2.dir, "issuer.key"), iss2.json.contextKey + "\n");
    const st = pair(h2, ["status", "--probe", "--json"]);
    const row = st.json.installations[0];
    rec("MS-status: issuer holding view:system:events + read:sessions:read + an extra session", row.problem ? "held" : "WEAK (status --probe reports no PROBLEMA: it only flags FORBIDDEN and missing caps, not extras; the 'issuer can do at most the scope' claim is unchecked)", { problem: row.problem || null, note: row.note || null, extraHeld: row.issuerCapabilities.filter((x) => !caps.split(",").includes(x)) });
    // scope name beginning with rctx_ -> LEAK_GUARD after the nonce was consumed
    const h3 = mk("guard", { sessions: ["rctx_notes"], agents: [] });
    const q3 = await mkReq(); const c3 = pair(h3, ["check", q3.text, "--json"]); const c3b = pair(h3, ["check", q3.text, "--json"]);
    rec("MS-guard: a session literally named rctx_<x> in the scope", "info", { check: errc(c3), again: errc(c3b), caps: errc(pair(h3, ["caps", "local", "--json"])) });
    // heavier stale-lock race
    let lossRounds = 0; const det = [];
    for (let round = 0; round < 25; round++) {
      const hr = mk("race");
      fs.writeFileSync(hr.ledger, JSON.stringify({ v: 1, nonces: {}, links: [] }), { mode: 0o600 });
      fs.writeFileSync(hr.ledger + ".lock", `999999 ${Date.now()}\n`);
      const reqs = await Promise.all(Array.from({ length: 24 }, () => mkReq()));
      const rs = await Promise.all(reqs.map((x) => pairAsync(hr, ["check", x.text, "--json"])));
      const okN = rs.filter((x) => x.code === 0).length; const inL = Object.keys(JSON.parse(fs.readFileSync(hr.ledger, "utf8")).nonces).length;
      if (inL < okN) lossRounds++; det.push(`${okN}/${inL}`);
    }
    rec("LG-5c: stale lock + 24 concurrent checks x 25 rounds", lossRounds ? "WEAK (lost updates observed)" : "held (TOCTOU window in breakStaleLock exists in code but was not hit)", { lossRounds, det: det.join(" ") });
  } finally { G.stop(); L.save("a6-results.json"); }
})().catch((e) => { console.error(e); L.save("a6-results.json"); process.exit(1); });
