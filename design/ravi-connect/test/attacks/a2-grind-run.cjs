// Victim request -> check (phrase P). Attacker grinds a request with phrase P and its own key; owner pastes the forged
// one by mistake: check shows the SAME phrase, approve with "sim P" succeeds... only if no other request is pending.
const L = require("./lib.cjs");
const { spawnSync } = require("child_process");
(async () => {
  const h = L.mkHome("grind", L.baseCfg());
  const victim = await L.mkReq();
  const cv = L.pair(h, ["check", victim.text, "--json"]);
  const t0 = Date.now();
  const g = spawnSync("bun", ["--no-env-file", require("path").join(L.AT, "a2-grind.ts"), victim.text], { encoding: "utf8", timeout: 600000 });
  const forged = JSON.parse(g.stdout);
  const cf = L.pair(h, ["check", forged.text, "--json"]);
  L.rec("PH-grind: second request with the SAME phrase, attacker's own public key", cf.json && cf.json.phrase === cv.json.phrase ? "demonstrated (known limit, limites.md)" : "failed", { victimPhrase: cv.json.phrase, forgedPhrase: cf.json && cf.json.phrase, stats: g.stderr.trim(), wallSeconds: (Date.now() - t0) / 1000 });
  const ap = L.pair(h, ["approve", forged.text, "--phrase", cv.json.phrase, "--json"]);
  L.rec("PH-grind-approve: both checked -> approve with the shared phrase refused", L.errc(ap) === "MULTIPLE_PENDING" ? "held" : "WEAK", L.errc(ap));
  L.save("a2-results.json");
})();
