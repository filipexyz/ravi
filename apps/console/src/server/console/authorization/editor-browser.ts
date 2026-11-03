/** Isolated browser acceptance. Authentication is a synthetic HTTP-only session,
 * not SSO; handler, policy store, editor and PostgreSQL are real. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { browserBinary } from "../../../../tests/fleet/binaries";
import { chromium } from "playwright";
import { handlePolicyRequest } from "./http";
import type { AuthorizationActor } from "./identity";
import type { createAuthorizationStore } from "./store";

export async function testPolicyEditor(input: {
  store: ReturnType<typeof createAuthorizationStore>; admin: AuthorizationActor;
  reader: AuthorizationActor; projectA: string; projectB: string;
}) {
  assert(process.env.RAVI_POLICY_TEST_CLUSTER && process.env.PGHOST === process.env.RAVI_POLICY_TEST_CLUSTER);
  const output = await mkdtemp(join(tmpdir(), "fleet-policy-editor-"));
  const bundle = await Bun.build({ entrypoints: ["scripts/policy-editor-entry.tsx"], target: "browser", minify: true,
    // Next normally replaces these compile-time flags. This standalone build
    // supplies empty defaults, never the operator's environment. No links/router
    // are exercised here; the actual Next/SSO shell is a separate integration.
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  assert(bundle.success, bundle.logs.map(String).join("\n"));
  const js = await bundle.outputs[0]!.text();
  const css = (await postcss([tailwind()]).process(await readFile("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") })).css;
  const cookie = crypto.randomUUID();
  const readOnlyCookie = crypto.randomUUID();
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Policy acceptance</title><style>${css}\n:root {--font-inter: system-ui,sans-serif;--font-ibm-plex-mono: monospace;}</style><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/entry.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (url.pathname.startsWith("/api/console/authorization")) {
      return handlePolicyRequest(request, url.pathname.slice("/api/console/authorization".length).split("/").filter(Boolean), {
        authenticate: async () => request.headers.get("cookie") === `policy_test=${cookie}` ? input.admin
          : request.headers.get("cookie") === `policy_test=${readOnlyCookie}` ? input.reader : null,
        canonicalOrigin: () => url.origin, store: input.store,
      });
    }
    return new Response(html, { headers: { "content-type": "text/html" } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ executablePath: browserBinary(), headless: true });
  const checks: string[] = [];
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: "policy_test", value: cookie, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page.on("pageerror", (error) => { errors.push(error.message); console.error("Browser error:", error.message); });
    page.on("response", (response) => { if (response.status() >= 400) console.error("HTTP refused", new URL(response.url()).pathname, response.status()); });
    await page.goto(origin);
    await page.getByRole("button", { name: "Edit policy", exact: true }).click();
    await page.getByText("Roles and assignments", { exact: true }).click();
    await page.getByLabel("Role 1 name", { exact: true }).fill("Project A reviewers renamed");
    const ruleNumber = (await input.store.read(input.admin)).active!.document.rules.length + 1;
    await page.getByRole("button", { name: "Add rule", exact: true }).click();
    const rule = page.locator(`section[aria-label="Rule ${ruleNumber}"]`);
    const name = rule.getByLabel(`Rule ${ruleNumber} name`);
    await name.fill("browser-grant-b");
    // Name edits must not remount the control or lose keyboard focus.
    assert(await name.evaluate((node) => node === document.activeElement));
    const who = rule.getByRole("group", { name: "Who", exact: true });
    await who.locator("summary").click();
    await who.getByLabel("owner@policy.invalid", { exact: true }).uncheck();
    await who.getByLabel("reader@policy.invalid", { exact: true }).check();
    const projects = rule.getByRole("group", { name: "Projects", exact: true });
    await projects.locator("summary").click();
    for (const checked of await projects.locator('input:checked').all()) await checked.uncheck();
    await projects.getByLabel("B", { exact: true }).check();
    const actionChoices = rule.getByRole("group", { name: "Actions", exact: true });
    await actionChoices.locator("summary").click();
    const restrictedWrite = actionChoices.getByLabel("Write through permitted Base views only", { exact: true });
    await restrictedWrite.focus(); await page.keyboard.press("Space"); assert(await restrictedWrite.isChecked());
    await page.keyboard.press("Space"); assert.equal(await restrictedWrite.isChecked(), false);
    checks.push("restricted Base-view write action is named separately and keyboard selectable, without publishing it");
    await page.getByLabel("Reason for this change").fill("Browser grants reader B without deployment");
    await page.screenshot({ path: join(output, "draft-1280.png"), fullPage: true });
    assert.equal((await input.store.decide(input.reader, input.projectB, "project.read")).allowed, false);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText("Draft saved. Active access is unchanged.", { exact: true }).waitFor();
    assert.equal((await input.store.decide(input.reader, input.projectB, "project.read")).allowed, false);
    checks.push("draft does not grant access");
    await page.getByLabel("Person", { exact: true }).selectOption(input.reader.userId);
    await page.getByLabel("Project", { exact: true }).selectOption(input.projectB);
    await page.getByRole("button", { name: "Check draft access", exact: true }).click();
    await page.getByText("Allowed by draft", { exact: true }).waitFor();
    checks.push("simulation uses the saved draft, not an executed action");
    await page.getByRole("button", { name: "Review impact", exact: true }).click();
    await page.getByLabel("Impact review").waitFor();
    assert(await page.getByRole("button", { name: "3. Publish policy", exact: true }).isDisabled());
    await page.getByLabel("I reviewed the impact and want to activate this exact draft.").check();
    await page.getByRole("button", { name: "3. Publish policy", exact: true }).click();
    await page.getByText("Policy published. New access decisions now use this revision.", { exact: true }).waitFor();
    assert.equal((await input.store.decide(input.reader, input.projectB, "project.read")).allowed, true);
    assert.equal((await input.store.decide(input.reader, input.projectB, "project.write")).allowed, false);
    assert.equal((await input.store.decide(input.reader, input.projectA, "project.read")).allowed, true);
    assert.equal((await input.store.read(input.admin)).active!.document.roles![0]!.name, "Project A reviewers renamed");
    checks.push("role rename in browser preserves explicit A grant and stable identity");
    checks.push("publish changes B read, never B write, without code/redeploy");
    assert.equal(await page.getByRole("button", { name: "Save draft", exact: true }).count(), 0);
    checks.push("completed editor collapses after publication");
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole("button", { name: "Edit policy", exact: true }).click();
    await page.getByRole("button", { name: `Remove rule ${ruleNumber}`, exact: true }).click();
    await page.getByLabel("Reason for this change").fill("Remove temporary B grant after mobile review");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText("Draft saved. Active access is unchanged.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Review impact", exact: true }).click();
    await page.getByLabel("Impact review").waitFor();
    await page.screenshot({ path: join(output, "review-390.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByLabel("I reviewed the impact and want to activate this exact draft.").check();
    await page.getByRole("button", { name: "3. Publish policy", exact: true }).click();
    await page.getByText("Policy published. New access decisions now use this revision.", { exact: true }).waitFor();
    assert.equal((await input.store.decide(input.reader, input.projectB, "project.read")).allowed, false);
    assert.equal((await input.store.decide(input.reader, input.projectA, "project.read")).allowed, true);
    checks.push("mobile publication revokes B while preserving A");
    await page.getByRole("button", { name: "Edit policy", exact: true }).click();
    await page.getByLabel("Rule scope", { exact: true }).selectOption("organization");
    await page.getByText("Roles and assignments", { exact: true }).click();
    await page.getByRole("button", { name: "Add role", exact: true }).click();
    await page.getByLabel("Role 2 name", { exact: true }).fill("Configuration reviewers");
    const roleCard = page.getByRole("region", { name: "Role 2", exact: true });
    const assigned = roleCard.getByRole("group", { name: "Assigned members", exact: true });
    await assigned.locator("summary").click();
    await assigned.getByLabel("reader@policy.invalid", { exact: true }).check();
    await page.getByRole("button", { name: "Add organization rule", exact: true }).click();
    const orgRule = page.getByRole("region", { name: "Organization rule 1", exact: true });
    const orgWho = orgRule.getByRole("group", { name: "Who", exact: true });
    await orgWho.locator("summary").click();
    await orgWho.getByLabel("owner@policy.invalid", { exact: true }).uncheck();
    await orgWho.getByLabel("Role: Configuration reviewers", { exact: true }).check();
    const orgActions = orgRule.getByRole("group", { name: "Organization actions", exact: true });
    await orgActions.locator("summary").click();
    await orgActions.getByLabel("View access policies", { exact: true }).check();
    const directoryRead = orgActions.getByLabel("View member directory", { exact: true });
    await directoryRead.focus();
    await page.keyboard.press("Space");
    assert(await directoryRead.isChecked());
    assert.equal(await orgActions.getByLabel("Manage membership (not access roles)", { exact: true }).isChecked(), false);
    await page.getByLabel("Reason for this change").fill("Grant metadata, directory and read-only policy review through custom role");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText("Draft saved. Active access is unchanged.", { exact: true }).waitFor();
    await page.getByLabel("Person", { exact: true }).selectOption(input.reader.userId);
    await page.getByLabel("Organization action", { exact: true }).selectOption("organization.members.read");
    await page.getByRole("button", { name: "Check draft access", exact: true }).click();
    await page.getByText("Allowed by draft", { exact: true }).waitFor();
    assert.equal((await input.store.decideOrganization(input.reader, "organization.settings.read")).allowed, false);
    assert.equal((await input.store.decideOrganization(input.reader, "organization.members.read")).allowed, false);
    await page.getByRole("button", { name: "Review impact", exact: true }).click();
    await page.getByLabel("Impact review").waitFor();
    await page.screenshot({ path: join(output, "organization-review-390.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: join(output, "organization-review-1280.png"), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByLabel("I reviewed the impact and want to activate this exact draft.").check();
    await page.getByRole("button", { name: "3. Publish policy", exact: true }).click();
    await page.getByText("Policy published. New access decisions now use this revision.", { exact: true }).waitFor();
    assert.equal((await input.store.decideOrganization(input.reader, "organization.settings.read")).allowed, true);
    assert.equal((await input.store.decideOrganization(input.reader, "organization.settings.manage")).allowed, false);
    assert.equal((await input.store.decideOrganization(input.reader, "organization.members.read")).allowed, true);
    assert.equal((await input.store.decideOrganization(input.reader, "organization.members.manage")).allowed, false);
    checks.push("member directory grant selected by keyboard, simulated and published without membership management");
    assert.equal((await input.store.decide(input.reader, input.projectB, "project.read")).allowed, false);
    checks.push("custom org role assigned, simulated, reviewed and published without project escalation");
    const viewerContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await viewerContext.addCookies([{ name: "policy_test", value: readOnlyCookie, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const viewer = await viewerContext.newPage();
    await viewer.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await viewer.goto(origin);
    await viewer.getByText("Read-only policy access. Editing requires an explicit policy management grant.", { exact: true }).waitFor();
    assert.equal(await viewer.getByRole("button", { name: "Edit policy", exact: true }).count(), 0);
    assert.equal(await viewer.getByRole("button", { name: "Restore as draft", exact: true }).count(), 0);
    const forbidden = await viewer.evaluate(async () => (await fetch("/api/console/authorization/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGeneration: 0 }) })).status);
    assert.equal(forbidden, 403);
    await viewer.screenshot({ path: join(output, "read-only-390.png"), fullPage: true });
    await viewerContext.close();
    checks.push("read-only policy viewer cannot edit through UI or direct API");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(output, `published-${width}.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
    checks.push("1280/390 no overflow or browser errors");
    const denied = await fetch(`${origin}/api/console/authorization`);
    assert.equal(denied.status, 401);
    checks.push("HTTP without test session is rejected");
    await writeFile(join(output, "result.json"), JSON.stringify({ status: "PASS", checks, auth: "synthetic_http_session_not_SSO" }, null, 2));
    console.log(`PASS browser ${checks.length} scenarios; screenshots ${output}`);
  } catch (error) {
    await writeFile(join(output, "failure.json"), JSON.stringify({ checksPassed: checks, error: String(error), browserErrors: errors }, null, 2));
    for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
    console.error(`Browser evidence including failure: ${output}`);
    throw error;
  } finally { await browser.close(); server.stop(true); }
}
