/** Render the existing member experience with synthetic data BEFORE changing UX. */
import { mock } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright";

const output = await mkdtemp(join(tmpdir(), "fleet-policy-baseline-"));
const member = (id: string, name: string, role: string) => ({ id, membershipId: id, name, email: `${name.toLowerCase()}@example.invalid`, role, status: "active", joined: "2026-10-23T00:00:00Z" });
const data = { currentRole: "owner", currentUserId: "owner", canManageMembers: true,
  members: [member("owner", "Alice", "owner"), member("reader", "Bruno", "viewer")], organization: { id: "org", name: "Example" } };
const noop = () => ({ isPending: false, isError: false, mutate() {}, reset() {}, error: null });
mock.module("@/features/org/queries", () => ({ useOrgSettings: () => ({ data, isPending: false, isError: false }),
  useOrgInvites: () => ({ data: { invites: [] }, isPending: false, isError: false }),
  useCreateInvite: noop, useRemoveMember: noop, useRevokeInvite: noop, useUpsertMember: noop }));
mock.module("@/features/shell/workspace", () => ({
  useWorkspace: () => ({ organization: { id: "org", name: "Example organization", slug: "example", role: "owner" },
    features: { byKey: { "console.settings": { enabled: true, visible: true } } } }),
  roleLabel: (role: string) => role[0]!.toUpperCase() + role.slice(1), featureEnabled: () => true,
}));
const { OrgMembersScreen } = await import("../src/features/org/members-screen");
const css = (await postcss([tailwind()]).process(await readFile("src/app/globals.css", "utf8"), { from: resolve("src/app/globals.css") })).css;
const markup = renderToStaticMarkup(<main className="rv-app mx-auto max-w-5xl px-5 py-8"><OrgMembersScreen /></main>);
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${markup}</body></html>`;
await writeFile(join(output, "baseline.html"), html);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.screenshot({ path: join(output, `members-${width}.png`), fullPage: true });
    console.log(JSON.stringify({ width, overflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), title: await page.locator("h1").allTextContents() }));
    await page.close();
  }
} finally { await browser.close(); server.stop(true); }
console.log(`Synthetic baseline captured: ${output}`);
