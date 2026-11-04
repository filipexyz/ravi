/** Visual fixture: render the real Block Kit composition with fake metadata. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCredentialIntakeModal, buildCredentialIntakeStatus } from "../src/channels/slack/credential-intake.js";
import type { IntakeRequest } from "../src/credentials/intake.js";

const out = process.argv[2] ?? "/tmp/ravi-credential-intake-preview";
mkdirSync(out, { recursive: true });
const request: IntakeRequest = {
  id: "visual-fixture", target: "connection:slack:suporte", accountId: "slack-test", teamId: "TTEST", userId: "UTEST", channelId: "CTEST",
  reason: "Conectar o workspace de suporte para consultar os canais autorizados.", label: "Workspace de suporte", backend: "file",
  status: "open", createdAt: 0, expiresAt: 0,
};
const views = {
  form: buildCredentialIntakeModal(request),
  saving: buildCredentialIntakeStatus("saving"),
  stored: buildCredentialIntakeStatus("stored", { fingerprint: "a13bcf99718e".repeat(6).slice(0, 64), daemonReloadRequired: false }),
  failed: buildCredentialIntakeStatus("failed"),
  verify: buildCredentialIntakeStatus("verify"),
};
const escape = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const textOf = (value: unknown) => escape((value as { text?: string } | undefined)?.text);
for (const [state, view] of Object.entries(views)) {
  const blocks = view.blocks as Array<Record<string, unknown>>;
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Credential intake visual fixture</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#3f3446;font:15px/1.47 system-ui,-apple-system,sans-serif;color:#1d1c1d;display:grid;place-items:center;padding:24px}.modal{background:white;width:100%;max-width:540px;border-radius:12px;box-shadow:0 20px 70px #0005;overflow:hidden}header{padding:22px 24px 12px;display:flex;justify-content:space-between;align-items:center}h1{font-size:21px;line-height:1.25;margin:0;font-weight:750}.x{font-size:22px;color:#555}.content{padding:8px 24px 24px}.section{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 20px}.section:nth-child(3){font-size:13px;color:#515151}label{display:block;font-weight:650;margin-bottom:8px}input{width:100%;height:40px;border:1px solid #777;border-radius:4px;font:inherit;padding:10px}small{display:block;color:#555;font-size:12px;margin-top:5px;margin-bottom:20px}footer{display:flex;justify-content:flex-end;gap:12px;padding:16px 24px;border-top:1px solid #ddd}button{font:650 14px system-ui;padding:9px 17px;border:1px solid #aaa;border-radius:4px;background:#fff;color:#1d1c1d}.primary{background:#007a5a;color:white;border-color:#007a5a}@media(max-width:480px){body{padding:12px}.modal{border-radius:8px}header,.content{padding-left:20px;padding-right:20px}h1{font-size:20px}footer{padding:16px 20px}}</style>
<main class="modal" role="dialog" aria-labelledby="title"><header><h1 id="title">${textOf(view.title)}</h1><span class="x" aria-hidden="true">×</span></header><div class="content">${blocks.map((block, index) => block.type === "input" ? `<label for="token-${index}">${textOf(block.label)}</label><input id="token-${index}" aria-describedby="hint-${index}" spellcheck="false"><small id="hint-${index}">${textOf(block.hint)}</small>` : `<p class="section">${textOf(block.text)}</p>`).join("")}</div><footer><button>${textOf(view.close)}</button>${view.submit ? `<button class="primary">${textOf(view.submit)}</button>` : ""}</footer></main></html>`;
  writeFileSync(join(out, `${state}.html`), html);
}
console.log(out);
