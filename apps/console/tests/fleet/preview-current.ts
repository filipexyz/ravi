import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserBinary } from "./binaries";
import { ORGANIZATION_ACTIONS } from "../../src/shared/project-authorization";

const root = resolve(import.meta.dir, "../..");
const output = await mkdtemp(join(tmpdir(), "fleet-ui-before-"));
const tab = process.argv[2] ?? "settings";
const scenario = process.argv[3] ?? "default";
if (!["default", "conflict", "readonly", "denied", "policyonly"].includes(scenario) || (scenario === "conflict" && tab !== "onboarding") || (scenario === "policyonly" && tab !== "permissions")) throw new Error("Unknown preview scenario");
if (!["members", "settings", "credentials", "installations", "sso", "onboarding", "setup", "permissions", "new-project", "projects"].includes(tab)) throw new Error("Unknown preview tab");
const build = await Bun.build({ entrypoints: [join(import.meta.dir, "preview-current.tsx")], target: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{
  name: "preview-navigation-only", setup(builder) {
    builder.onResolve({ filter: /^next\/(navigation|link)$/ }, ({ path }) => ({ path, namespace: "preview" }));
    builder.onLoad({ filter: /.*/, namespace: "preview" }, ({ path }) => ({ loader: "jsx", contents: path.endsWith("link")
      ? 'import React from "react";export default function Link({children,...props}){return <a {...props}>{children}</a>}'
      : 'export const useRouter=()=>({push(){},replace(){},refresh(){},prefetch(){}});export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams();' }));
  },
}] });
if (!build.success) throw new Error(`Preview build failed: ${build.logs.map(x => x.message).join("; ")}`);
const css = await postcss([tailwind()]).process(await readFile(join(root, "src/app/globals.css"), "utf8"), { from: join(root, "src/app/globals.css") });
const js = await build.outputs[0]!.text();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/preview.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (path === "/preview.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
  // Next/font is absent in this component fixture; explicit system fallbacks avoid
  // an invalid font variable making AppShell serif. Full Next checks actual fonts.
  return new Response('<!doctype html><html lang="pt-BR" data-rv-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><style>:root{--font-inter:ui-sans-serif;--font-sora:ui-sans-serif;--font-plex-mono:ui-monospace}body{background:var(--rv-canvas)}</style><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>', { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch({ executablePath: browserBinary(), headless: true, chromiumSandbox: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: "light" });
    const submissions: Array<{ operationId: string; snapshot: string }> = [];
    let refreshes = 0;
    const unexpectedApi: string[] = [];
    const refreshedGuide = { completed: false, name: "Acme atualizada", slug: "acme", login: "bootstrap",
      storedCredentials: 0, activeTransports: 0, pendingTransports: 1, snapshot: "b".repeat(64) };
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (url.pathname === "/api/console/fleet/access") return route.fulfill({ contentType: "application/json", body: JSON.stringify({
        actions: Object.fromEntries(ORGANIZATION_ACTIONS.map(action => [action, scenario === "policyonly" ? action === "organization.authorization.read" : scenario !== "denied" && (scenario !== "readonly" || action.endsWith(".read"))])),
        generation: 1, revisionId: "00000000-0000-4000-8000-000000000010",
      }) });
      if (scenario === "conflict" && url.pathname === "/api/console/fleet/onboarding/finish") {
        submissions.push(route.request().postDataJSON());
        if (submissions.length === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "version_conflict" }) });
        if (submissions.length === 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fleet_unavailable" }) });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...refreshedGuide, completed: true }) });
      }
      if (scenario === "conflict" && url.pathname === "/api/console/fleet/onboarding") {
        if (++refreshes === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fleet_unavailable" }) });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(refreshedGuide) });
      }
      if (url.pathname.startsWith("/api/")) { unexpectedApi.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/acme/${tab}?tab=${tab}&scenario=${scenario}`);
    await page.getByRole("heading", { name: tab === "members" ? "Members" : tab === "projects" ? "Projects" : tab === "new-project" ? (scenario === "denied" ? "You can't create projects" : "New project") : tab === "setup" ? "Primeiro acesso" : "Settings", exact: true }).waitFor();
    await page.screenshot({ path: join(output, `${tab}-${width}.png`), fullPage: true });
    if (tab === "permissions") {
      const settings = page.locator("header").getByRole("link", { name: "Settings", exact: true });
      if (scenario === "policyonly") {
        await settings.waitFor();
        if (await settings.getAttribute("href") !== "/acme/permissions") throw new Error("Policy-only reader must reach permissions without project/legacy feature");
        const policy = page.getByRole("navigation", { name: "Organization settings", exact: true }).getByRole("link", { name: "Políticas de acesso", exact: true });
        await policy.focus();
        if (!await policy.evaluate(el => el === document.activeElement) || await policy.getAttribute("aria-current") !== "page") throw new Error("Policy tab must preserve focus and active indication");
        if (await page.getByRole("link", { name: "General", exact: true }).count() || await page.getByRole("link", { name: "Members", exact: true }).count()) throw new Error("No implicit organization grants");
      } else if (scenario === "denied" && await settings.count()) throw new Error("Denied reader must not have a policy settings entry");
    }
    if (scenario === "denied") {
      if (!["new-project", "projects"].includes(tab)) await page.getByText("Acesso não concedido", { exact: true }).waitFor();
      if (await page.locator("input,select,textarea").count()) throw new Error("Denied page must not expose forms");
    } else if (scenario === "readonly") {
      await page.getByText("Somente consulta", { exact: true }).waitFor();
      if (await page.getByRole("button", { name: /Adicionar|Nova conexão|Concluir revisão|^Save$|Testar|Ativar|Suspender|Reativar|Remover acesso/ }).count()) throw new Error("Read-only exposes write action");
      if (tab === "settings" && await page.locator("input:not([readonly])").count()) throw new Error("Settings inputs must be read-only");
    }
    if (["credentials", "installations", "sso"].includes(tab) && !["readonly", "denied"].includes(scenario)) {
      await page.getByRole("button", { name: tab === "credentials" ? "Adicionar credencial" : tab === "sso" ? "Nova conexão OIDC" : "Adicionar instalação" }).click();
      if (tab === "sso") await page.getByLabel("Restringir entrada por grupos do IdP").check();
      if (tab === "credentials") await page.getByLabel("Tipo", { exact: true }).selectOption("oidc_client_secret");
      await page.screenshot({ path: join(output, `${tab}-form-${width}.png`), fullPage: true });
      if (tab === "installations" && await page.getByRole("button", { name: "Salvar configuração" }).isEnabled()) throw new Error("Unconfirmed fingerprint must not enable save");
      await page.getByLabel("Nome", { exact: true }).focus();
      if (!(await page.getByLabel("Nome", { exact: true }).evaluate(el => el === document.activeElement))) throw new Error("Label/focus failed");
    }
    if (tab === "setup") {
      if (await page.getByRole("button", { name: "Continuar para o login" }).isEnabled()) throw new Error("Setup requires a bounded code");
      const code = page.getByLabel("Código de configuração");
      await code.focus();
      if (!(await code.evaluate(el => el === document.activeElement))) throw new Error("Setup label/focus failed");
      if (await code.getAttribute("type") !== "password") throw new Error("Setup code must be masked");
    }
    if(tab === "members" && scenario === "default") {
      const control=page.getByRole("button",{name:"Reativar",exact:true});
      await control.focus(); await page.keyboard.press("Enter");
      const dialog=page.getByRole("dialog",{name:"Reativar?",exact:true}); await dialog.waitFor();
      await page.getByText("Permissões já publicadas para esta pessoa podem voltar a valer.",{exact:false}).waitFor();
      if(!await dialog.evaluate(el=>el.contains(document.activeElement))) throw new Error("Dialog must receive focus");
      await page.screenshot({path:join(output,`members-review-${width}.png`),fullPage:true});
      await page.keyboard.press("Escape");
      if(await dialog.isVisible() || !await control.evaluate(el=>el===document.activeElement)) throw new Error("Dialog close/focus restoration failed");
    }
    if (tab === "onboarding" && !["readonly", "denied"].includes(scenario)) {
      const complete = page.getByRole("button", { name: "Concluir revisão" });
      if (await complete.isEnabled()) throw new Error("Guide requires explicit review");
      await page.getByRole("checkbox").check();
      if (!await complete.isEnabled()) throw new Error("Reviewed guide should be actionable");
      await page.getByRole("link", { name: "Revisar organização" }).focus();
      await page.keyboard.press("Tab");
      if (!await page.getByRole("link", { name: "Revisar login" }).evaluate(el => el === document.activeElement)) throw new Error("Guide keyboard order failed");
      if (scenario === "conflict") {
        await complete.click();
        await page.getByText("A configuração mudou. Atualize e revise antes de concluir.", { exact: true }).waitFor();
        await page.screenshot({ path: join(output, `${tab}-conflict-${width}.png`), fullPage: true });
        if (await complete.isEnabled() || await page.getByRole("checkbox").isChecked()) throw new Error("Stale review must be cleared and disabled");
        const refresh = page.getByRole("button", { name: "Atualizar e revisar" });
        await refresh.focus(); await page.keyboard.press("Enter");
        await page.getByText("Não foi possível atualizar. Tente novamente antes de revisar.", { exact: true }).waitFor();
        if (await complete.isEnabled()) throw new Error("Failed refresh must not approve stale data");
        await refresh.click();
        await page.getByText("Acme atualizada", { exact: true }).waitFor();
        if (await page.getByRole("checkbox").isChecked() || await complete.isEnabled()) throw new Error("New snapshot requires a new review");
        await page.getByRole("checkbox").check();
        await complete.click();
        await page.getByText("Não foi possível concluir a revisão. Tente novamente.", { exact: true }).waitFor();
        await complete.click();
        await page.getByText("Revisão inicial concluída", { exact: true }).waitFor();
        if (submissions.length !== 3 || refreshes !== 2 || submissions[0]!.operationId === submissions[1]!.operationId
          || submissions[1]!.operationId !== submissions[2]!.operationId || submissions[0]!.snapshot !== "a".repeat(64)
          || submissions[1]!.snapshot !== refreshedGuide.snapshot || submissions[2]!.snapshot !== refreshedGuide.snapshot) throw new Error("Intent/retry/snapshot contract failed");
        await page.screenshot({ path: join(output, `${tab}-complete-${width}.png`), fullPage: true });
        console.log(JSON.stringify({ scenario, width, checks: ["stale-disabled", "refresh-failure", "refresh-keyboard", "new-review", "new-intent", "retry-same-intent", "completion"], screenshot: join(output, `${tab}-conflict-${width}.png`), completed: join(output, `${tab}-complete-${width}.png`) }));
      }
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length || unexpectedApi.length) throw new Error(`Render failed: ${JSON.stringify({ overflow, errors, unexpectedApi })}`);
    await page.screenshot({ path: join(output, `${tab}-${width}.png`), fullPage: true });
    console.log(JSON.stringify({ tab, scenario, width, screenshot: join(output, `${tab}-${width}.png`), form: ["credentials", "installations", "sso"].includes(tab) && !["readonly", "denied"].includes(scenario) ? join(output, `${tab}-form-${width}.png`) : null, errors, overflow }));
    await page.close();
  }
} finally { await browser.close(); server.stop(true); }
