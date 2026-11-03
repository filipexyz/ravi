import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Sql } from "postgres";
import type { ProjectPolicy } from "../../src/server/console/authorization/policy";
import type { ApiKeyInventory, ApiKeyReceipt } from "../../src/shared/api-keys";

// Called only inside the real Next/PG/local-IdP fixture. No bearer route or mock
// administration: every call below traverses the production browser adapter.
export async function apiKeysBrowser(input: { page: Page; sql: Sql; origin: string; root: string;
  org: string; actor: string; target: string; project: string; document: ProjectPolicy; publish: () => Promise<void>;
  call: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }> }) {
  const { page, sql, origin, root, org, actor, target, project, document: policy, publish, call } = input;
  const path = "/api/console/fleet/api-keys", url = `${origin}/browser-fixture/api-keys`;
  const mutation = () => ({ operationId: randomUUID(), reason: "Isolated HTTP acceptance" });
  const issue = () => ({ ...mutation(), name: "HTTP personal", subject: { kind: "user", id: target }, projectId: project,
    scopes: ["project.read"], expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const inventory = async () => { const response = await call(path); expect(response.status).toBe(200); return response.body as ApiKeyInventory; };
  expect((await call(path)).status).toBe(403);
  await page.goto(url); await page.getByText("Acesso não concedido", { exact: true }).waitFor();
  await sql`update organization_memberships set status='active',updated_at=clock_timestamp() where organization_id=${org} and user_id=${target}`;
  policy.organizationRules!.push({ id: "browser-keys", effect: "allow", principals: [{ kind: "user", id: actor }], actions: ["organization.api_keys.read"] });
  policy.rules.push({ id: "browser-key-holder", effect: "allow", projects: [project], principals: [{ kind: "user", id: target }], actions: ["project.read"] });
  await publish();
  expect((await inventory()).keys).toEqual([]);
  expect((await call(`${path}/issue`, issue())).status).toBe(403);
  // UI-only availability injection, not a server acceptance result. Hold the
  // read so loading is observable, then restore the real route before retry.
  let releaseRead!: () => void;
  const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
  await page.route(`${origin}${path}`, async route => {
    await heldRead;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "authorization_unavailable" }) });
  });
  try {
    await page.reload(); await page.getByRole("status", { name: "Loading", exact: true }).waitFor();
    await page.screenshot({ path: join(root, "keys-loading.png"), fullPage: true });
    releaseRead(); await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
    await page.screenshot({ path: join(root, "keys-unavailable.png"), fullPage: true });
  } finally { releaseRead(); await page.unroute(`${origin}${path}`); }
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("Nenhuma chave cadastrada.", { exact: false }).waitFor();
  await page.reload(); await page.getByText("Somente consulta", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Nova chave", exact: true }).count()).toBe(0);
  policy.organizationRules!.find(r => r.id === "browser-keys")!.actions.push("organization.api_keys.manage");
  await publish(); await page.reload();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Nova chave", exact: true }).waitFor();
    await page.screenshot({ path: join(root, `keys-empty-${width}.png`), fullPage: true });
    const button = page.getByRole("button", { name: "Nova chave", exact: true });
    await button.focus(); await page.keyboard.press("Enter");
    expect(await page.getByLabel("Nome", { exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
    await page.getByLabel("Nome", { exact: true }).fill("Browser personal key");
    await page.getByLabel("Titular", { exact: true }).selectOption(target);
    await page.getByLabel("Escopo", { exact: true }).selectOption(project);
    await page.getByLabel("Read project resources", { exact: true }).check();
    await page.getByLabel("Vencimento", { exact: true }).fill(new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 16));
    await page.getByLabel("Motivo", { exact: true }).fill("Isolated browser acceptance");
    expect(await page.getByRole("button", { name: "Confirmar", exact: true }).isEnabled()).toBe(false);
    await page.screenshot({ path: join(root, `keys-form-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (width === 1280) {
      await page.getByRole("button", { name: "Cancelar", exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.textContent === "Chaves de API");
    }
  }
  await page.getByLabel("Revisei o titular, o escopo e a consequência desta ação.", { exact: true }).check();
  const responsePromise = page.waitForResponse(r => new URL(r.url()).pathname === `${path}/issue` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  const response = await responsePromise; expect(response.status()).toBe(200);
  const created = await response.json() as ApiKeyReceipt;
  expect(created.key!.subjectId).toBe(target); expect(created.token).toMatch(/^rvk_/);
  const secretDialog = page.getByRole("dialog", { name: "Guarde a nova chave", exact: true }); await secretDialog.waitFor();
  expect(await secretDialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(await page.getByLabel("Chave emitida", { exact: true }).inputValue()).toBe(created.token!);
  await page.getByRole("button", { name: "Guardei a chave", exact: true }).click();
  expect(await page.getByLabel("Chave emitida", { exact: true }).count()).toBe(0);
  await page.waitForFunction(() => document.activeElement?.textContent === "Chaves de API");
  expect((await call(`${path}/issue`, response.request().postDataJSON())).body).not.toHaveProperty("token");
  for (const body of [{ ...issue(), organizationId: randomUUID() }, { ...issue(), role: "owner" }, { ...issue(), actorId: actor }])
    expect((await call(`${path}/issue`, body)).status).toBe(400);
  expect((await call(`${path}/issue`, { ...issue(), projectId: randomUUID() })).status).toBe(403);
  expect((await call(path, undefined, { "x-ravi-org": randomUUID() })).status).toBe(403);
  expect((await call(`${path}/revoke`, { ...mutation(), id: created.key!.id, expectedRevision: 99 })).status).toBe(409);

  // Real stale-CAS response from the production route; preserve intent until the
  // operator explicitly refreshes, then restore a stable keyboard destination.
  const createdRow = page.getByRole("list", { name: "Chaves", exact: true }).getByRole("listitem")
    .filter({ hasText: "Browser personal key" });
  await createdRow.getByRole("button", { name: "Revogar", exact: true }).click();
  expect(await page.getByLabel("Motivo", { exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
  await page.getByLabel("Motivo", { exact: true }).fill("Review conflict before revoking");
  await page.getByLabel("Revisei o titular, o escopo e a consequência desta ação.", { exact: true }).check();
  await sql`update api_keys set revision=revision+1 where id=${created.key!.id}`;
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Este item mudou" }).waitFor();
  expect(await page.getByLabel("Motivo", { exact: true }).inputValue()).toBe("Review conflict before revoking");
  await page.screenshot({ path: join(root, "keys-conflict-390.png"), fullPage: true });
  await page.getByRole("button", { name: "Atualizar e revisar", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === "Chaves de API");
  expect(await page.getByRole("form", { name: "Revogar chave", exact: true }).count()).toBe(0);
  expect((await inventory()).keys.find(k => k.id === created.key!.id)!.status).toBe("active");

  // Expiry presentation changes while the inventory is open, without resetting
  // a form or granting anything. The server remains authoritative for all use.
  await sql`update api_keys set expires_at=clock_timestamp()+interval '3 seconds' where id=${created.key!.id}`;
  await page.reload(); await createdRow.getByText("Expirada", { exact: true }).waitFor();
  expect(await createdRow.getByText("Ativa", { exact: true }).count()).toBe(0);

  // Legacy classification never assumes the author is its holder or preserves
  // an unknown hash. Classification and rotation are separate audited requests.
  const legacy = randomUUID();
  await sql`insert into api_keys(id,organization_id,name,key_prefix,key_hash,created_by_user_id)
    values(${legacy},${org},'Legacy fixture','old',${randomUUID()},${actor})`;
  expect((await inventory()).unresolved).toBe(1);
  const { name: _name, ...binding } = issue();
  const classified = await call(`${path}/classify`, { ...binding, id: legacy, expectedRevision: 1 });
  expect(classified.status).toBe(200); expect((classified.body as ApiKeyReceipt).key!.rotationRequired).toBe(true);
  const rotated = await call(`${path}/rotate`, { ...mutation(), id: legacy, expectedRevision: 2, expiresAt: issue().expiresAt });
  expect(rotated.status).toBe(200); expect((rotated.body as ApiKeyReceipt).token).toMatch(/^rvk_/);
  expect((await inventory()).unresolved).toBe(0);
  expect((await call(`${path}/revoke`, { ...mutation(), id: legacy, expectedRevision: 3 })).status).toBe(200);

  const serviceResponse = await call(`${path}/services/create`, { ...mutation(), name: "Institutional fixture" });
  expect(serviceResponse.status).toBe(200);
  const principal = (serviceResponse.body as ApiKeyReceipt).service!;
  const serviceInput = { ...issue(), subject: { kind: "service", id: principal.id } };
  expect((await call(`${path}/issue`, serviceInput)).status).toBe(403);
  policy.rules.push({ id: "browser-service", effect: "allow", projects: [project], principals: [{ kind: "service", id: principal.id }], actions: ["project.read"] });
  await publish(); // Includes real policy reference validation and impact preview.
  const serviceKey = await call(`${path}/issue`, serviceInput); expect(serviceKey.status).toBe(200);
  await page.reload();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByText("Institucional · Institutional fixture", { exact: true }).waitFor();
    await page.screenshot({ path: join(root, `keys-inventory-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  expect((await call(`${path}/services/revoke`, { ...mutation(), id: principal.id, expectedRevision: 1 })).status).toBe(200);
  expect((await inventory()).keys.find(k => k.id === (serviceKey.body as ApiKeyReceipt).key!.id)!.status).toBe("revoked");
  const tokens = [created.token!, (rotated.body as ApiKeyReceipt).token!, (serviceKey.body as ApiKeyReceipt).token!];
  const audit = JSON.stringify(await sql`select * from audit_events where organization_id=${org}`);
  const receipts = JSON.stringify(await sql`select * from fleet_mutation_receipts where organization_id=${org}`);
  const listed = JSON.stringify(await inventory());
  expect(tokens.some(token => audit.includes(token) || receipts.includes(token) || listed.includes(token))).toBe(false);
  policy.rules = policy.rules.filter(r => r.id !== "browser-service");
  policy.organizationRules!.find(r => r.id === "browser-keys")!.actions = ["organization.api_keys.read"];
  await publish();
  expect((await call(`${path}/issue`, response.request().postDataJSON())).status).toBe(403);
  return tokens; // The caller scans private server logs without printing secrets.
}
