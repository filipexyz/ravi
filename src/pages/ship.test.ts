import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "../cli/context.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import {
  checkShipLiveData,
  isReservedPageHostSlug,
  materializeShipSource,
  projectOwnedHostSlug,
  requireShipTitle,
  resolveShipContentKind,
  selectProjectDefaultHost,
  SHIP_LIVE_DATA_OVERRIDE_WARNING,
  SHIP_LIVE_DATA_REFUSAL_LINES,
  slugifyPageTitle,
  validateShipSourceInput,
  wrapHtml5Document,
} from "./ship.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("pages ship helpers", () => {
  it("wraps --body in a simple HTML5 document", () => {
    const html = wrapHtml5Document("Weekly <report>", "<h1>OK</h1>");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Weekly &lt;report&gt;</title>");
    expect(html).toContain("<h1>OK</h1>");
    expect(html).toContain("</html>");
  });

  it("slugifies titles and falls back to page", () => {
    expect(slugifyPageTitle("Relatório Semanal")).toBe("relatorio-semanal");
    expect(slugifyPageTitle("  ")).toBe("page");
  });

  it("resolves the project-owned host and ignores a title slug", () => {
    expect(projectOwnedHostSlug("Acme", "proj")).toBe("acme-proj");
    expect(projectOwnedHostSlug("acme", "f983301a-e4b2-4ffc-9b9e-83d4f2bee318")).toBeNull();
    expect(projectOwnedHostSlug("ravi", "bot")).toBe("ravi-bot");
    expect(isReservedPageHostSlug("ravi")).toBe(true);
    expect(isReservedPageHostSlug("ravi-bot")).toBe(true);
    expect(isReservedPageHostSlug("bravo")).toBe(false);

    const sites = [
      { id: "site_title", slug: "relatorio-semanal", isDefault: false },
      { id: "site_default", slug: "acme-proj", isDefault: true, defaultHostname: "acme-proj.ravi.page" },
    ];
    expect(selectProjectDefaultHost(sites, "acme-proj")?.id).toBe("site_default");
    expect(selectProjectDefaultHost([{ slug: "relatorio-semanal", isDefault: false }], "acme-proj")).toBeNull();
    expect(selectProjectDefaultHost([{ id: "by-host", defaultHostname: "acme-proj.ravi.page" }], "acme-proj")?.id).toBe(
      "by-host",
    );
    expect(selectProjectDefaultHost(sites, null)?.id).toBe("site_default");
  });

  it("requires exactly one content source", () => {
    expect(resolveShipContentKind({ body: "<p>x</p>" })).toBe("body");
    expect(() => resolveShipContentKind({})).toThrow(CloudAuthError);
    expect(() => resolveShipContentKind({ body: "<p>x</p>", dir: "./site" })).toThrow(CloudAuthError);
    expect(() => requireShipTitle(undefined)).toThrow(CloudAuthError);
  });

  it("materializes --body as HTML5 index.html", async () => {
    const source = await materializeShipSource({
      body: "<p>Hello</p>",
      entrypoint: "index.html",
      title: "Hello",
    });
    tempDirs.push(source.path);
    const html = await readFile(join(source.path, "index.html"), "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Hello</title>");
    expect(html).toContain("<p>Hello</p>");
    expect(source.kind).toBe("body");
  });

  it("validates --html and --dir before shipping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ravi-pages-ship-src-"));
    tempDirs.push(dir);
    const htmlPath = join(dir, "page.html");
    await writeFile(htmlPath, "<h1>File</h1>");

    await expect(validateShipSourceInput({ html: htmlPath })).resolves.toBe("html");
    await expect(validateShipSourceInput({ dir })).resolves.toBe("dir");
    await expect(validateShipSourceInput({ html: join(dir, "missing.html") })).rejects.toBeInstanceOf(CloudAuthError);
    await expect(validateShipSourceInput({ body: "   " })).rejects.toBeInstanceOf(CloudAuthError);
  });

  it("resolves relative --html against the caller cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ravi-pages-ship-cwd-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "index.html"), "<h1>Caller</h1>");

    await expect(runWithContext({ cwd: dir }, () => validateShipSourceInput({ html: "./index.html" }))).resolves.toBe(
      "html",
    );

    try {
      await validateShipSourceInput({ html: "./ravi-pages-ship-missing-cwd.html" });
      throw new Error("expected missing relative html to fail in the process cwd");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).message).toBe("--html file was not found: ./ravi-pages-ship-missing-cwd.html");
    }
  });

  it("refuses ravi.bases.* uses on a public route and lets --members-best-effort override it", () => {
    const uses = ["ravi.identity.assertion", "ravi.bases.views.describe", "ravi.bases.views.query"];

    expect(checkShipLiveData({ uses, visibility: "public" })).toEqual({
      status: "refused",
      basesUses: ["ravi.bases.views.describe", "ravi.bases.views.query"],
    });
    expect(checkShipLiveData({ uses, visibility: "public", membersBestEffort: true })).toEqual({
      status: "overridden",
      basesUses: ["ravi.bases.views.describe", "ravi.bases.views.query"],
      warning: SHIP_LIVE_DATA_OVERRIDE_WARNING,
    });
  });

  it("leaves private, protected_link and non-bases public ships alone", () => {
    const bases = ["ravi.bases.views.query"];
    expect(checkShipLiveData({ uses: bases, visibility: "private" })).toEqual({ status: "ok" });
    expect(checkShipLiveData({ uses: bases, visibility: "protected_link" })).toEqual({ status: "ok" });
    expect(checkShipLiveData({ uses: ["ravi.identity.assertion"], visibility: "public" })).toEqual({ status: "ok" });
    expect(checkShipLiveData({ uses: undefined, visibility: "public" })).toEqual({ status: "ok" });
    // Only the ravi.bases. prefix counts, not a look-alike id.
    expect(checkShipLiveData({ uses: ["ravi.basesx.query"], visibility: "public" })).toEqual({ status: "ok" });
    // The override flag alone changes nothing when there is nothing to refuse.
    expect(checkShipLiveData({ uses: bases, visibility: "private", membersBestEffort: true })).toEqual({
      status: "ok",
    });
  });

  it("keeps every refusal line under the 200-character issue cap and names both fixes and the override", () => {
    for (const line of SHIP_LIVE_DATA_REFUSAL_LINES) expect(line.length).toBeLessThanOrEqual(200);
    const text = SHIP_LIVE_DATA_REFUSAL_LINES.join("\n");
    expect(text).toContain("route would be public");
    expect(text).toContain("drop --visibility (private is the default)");
    expect(text).toContain("no ravi.bases.* in --uses");
    expect(text).toContain("--members-best-effort");
  });
});
