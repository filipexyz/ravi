// Runs every attack script in turn (env without proxies) and merges their results into ALL-results.json.
//   node run-all.cjs
// RAVI_SRC: Ravi source checkout with dependencies (default: the repository this folder is in).
// ATK_WORK: folder for temp HOMEs and states (default: a new folder under the system temp dir, deleted at the end).
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const env = { ...process.env };
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) delete env[k];
// one work folder for every script; created here unless ATK_WORK names one, and then deleted at the end
const ownWork = !env.ATK_WORK;
if (ownWork) env.ATK_WORK = fs.mkdtempSync(path.join(os.tmpdir(), "ravi-connect-atk-"));
const scripts = [["a1-parse-phrase-config.cjs", "a1-results.json"], ["a1b-long.cjs", "a1b-results.json"], ["a2-grind-run.cjs", "a2-results.json"], ["a3-ledger.cjs", "a3-results.json"], ["a4-issue-disconnect-leaks.cjs", "a4-results.json"], ["a4b-ps.cjs", "a4b-results.json"], ["a5-page.cjs", "a5-results.json"], ["a6-misc.cjs", "a6-results.json"]];
const all = [];
for (const [s, out] of scripts) {
  const t = Date.now();
  const r = spawnSync("node", [path.join(__dirname, s)], { env, cwd: __dirname, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 900000 });
  console.error(`${s}: exit ${r.status} in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  if (r.status !== 0) console.error((r.stderr || "").split("\n").filter((l) => !l.startsWith("[")).slice(-8).join("\n"));
  for (const x of JSON.parse(fs.readFileSync(path.join(__dirname, out), "utf8"))) all.push({ file: out, ...x });
}
fs.writeFileSync(path.join(__dirname, "ALL-results.json"), JSON.stringify(all, null, 2));
if (ownWork) fs.rmSync(env.ATK_WORK, { recursive: true, force: true });
const weak = all.filter((x) => /^WEAK/.test(x.verdict));
console.log(JSON.stringify({ cases: all.length, weak: weak.map((x) => x.name + " :: " + x.verdict.slice(0, 120)) }, null, 1));
