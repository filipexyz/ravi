const L = require("./lib.cjs");
const h = L.mkHome("long", L.baseCfg());
const t0 = Date.now();
const r = L.pair(h, ["check", "-", "--json"], {}, "ravi-connect:v1:" + "A".repeat(5_000_000));
const r2 = L.pair(h, ["check", "-", "--json"], {}, "ravi-connect:v1:" + "A".repeat(2000));
L.rec("P-long: 5 MB body on stdin / exactly 2000 'A' (valid b64, not JSON)", r.code === 3 && r2.code === 3 ? "held" : "WEAK", { big: L.errc(r), ms: Date.now() - t0, b2000: L.errc(r2) });
L.save("a1b-results.json");
