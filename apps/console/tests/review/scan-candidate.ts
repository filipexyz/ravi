/** Full publishable tree, never ignored env/build/private data. No blanket test allowlist. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, lstat, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
const binary = process.env.FLEET_GITLEAKS_BIN;
if (!binary) throw new Error("Set FLEET_GITLEAKS_BIN to the verified scanner");
const root = await mkdtemp(join(tmpdir(), "fleet-candidate-scan-")), source = join(root, "source");
const list = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { stdout: "pipe", stderr: "pipe" });
const files = [...new Set((await new Response(list.stdout).text()).split("\0").filter(Boolean))];
if (await list.exited) throw new Error("Cannot enumerate candidate");
for (const file of files) {
  if (file.split("/").some(part => [".private", "node_modules", "backups"].includes(part)) || file.startsWith(".env") && !file.endsWith(".example")) throw new Error(`Publication exclusion: ${file}`);
  const stat = await lstat(file); if (!stat.isFile()) throw new Error(`Non-file candidate: ${file}`);
  await mkdir(dirname(join(source, file)), { recursive: true }); await copyFile(file, join(source, file));
}
const report = join(root, "redacted.json");
const child = Bun.spawn([binary, "dir", source, "--redact=100", "--ignore-gitleaks-allow", "--report-format=json", `--report-path=${report}`], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
await writeFile(join(root, "scan.log"), stdout + stderr, { mode: 0o600 });
if (code !== 0 && code !== 1) throw new Error(`Scanner failed (${code}); ${root}`);
const known = JSON.parse(await readFile("docs/SECRET-SCAN-REVIEW.json", "utf8")).findings as { path: string; rule: string; lineSha256: string }[];
const findings = JSON.parse(await readFile(report, "utf8")) as { File: string; RuleID: string; StartLine: number }[];
const classified = [];
for (const finding of findings) {
  const path = finding.File.startsWith(source) ? relative(source, finding.File) : finding.File;
  const line = (await readFile(join(source, path), "utf8")).split("\n")[finding.StartLine - 1] ?? "";
  const lineSha256 = createHash("sha256").update(line).digest("hex");
  classified.push({ path, line: finding.StartLine, rule: finding.RuleID, lineSha256,
    previouslyReviewed: known.some(item => item.path === path && item.rule === finding.RuleID && item.lineSha256 === lineSha256) });
}
const summary = { root, files: files.length, scannerExit: code, findings: classified,
  unclassified: classified.filter(item => !item.previouslyReviewed).length };
await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary)); if (summary.unclassified) process.exitCode = 1;
