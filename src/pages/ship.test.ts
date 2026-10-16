import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runWithContext } from "../cli/context.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import {
  checkShipLiveData,
  ensureShipBodyLang,
  isReservedPageHostSlug,
  materializeShipSource,
  projectOwnedHostSlug,
  requireShipTitle,
  resolveShipContentKind,
  selectProjectDefaultHost,
  SHIP_BODY_FALLBACK_LANG,
  SHIP_LIVE_DATA_OVERRIDE_WARNING,
  SHIP_LIVE_DATA_REFUSAL_LINES,
  slugifyPageTitle,
  validateShipSourceInput,
  withHtmlLang,
  wrapHtml5Document,
} from "./ship.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("pages ship helpers", () => {
  it("wraps --body in a simple HTML5 document without lang, so the page kit sets the theme's", () => {
    const html = wrapHtml5Document("Weekly <report>", "<h1>OK</h1>");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("\n<html>\n");
    expect(html).not.toContain("lang=");
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

  it("adds lang to the first <html> tag only when it has none", () => {
    expect(withHtmlLang("<!DOCTYPE html>\n<html>\n<head></head></html>", "pt-BR")).toBe(
      '<!DOCTYPE html>\n<html lang="pt-BR">\n<head></head></html>',
    );
    expect(withHtmlLang('<html class="x"><body><html></body></html>', "pt-BR")).toBe(
      '<html lang="pt-BR" class="x"><body><html></body></html>',
    );
    for (const html of ['<html lang="en"><p>x</p>', "<HTML LANG='es'>", "<p>no html tag</p>"]) {
      expect(withHtmlLang(html, "pt-BR")).toBe(html);
    }
  });

  it("gives the --body wrapper the pt-BR fallback when the kit left it without lang", async () => {
    const source = await materializeShipSource({ body: "<p>Olá</p>", entrypoint: "pages/index.html", title: "Oi" });
    tempDirs.push(source.path);
    const path = join(source.path, "pages", "index.html");
    expect(await ensureShipBodyLang(source, "pages/index.html")).toBe(true);
    expect(await readFile(path, "utf8")).toContain(`<html lang="${SHIP_BODY_FALLBACK_LANG}">`);
    expect(SHIP_BODY_FALLBACK_LANG).toBe("pt-BR");

    // The kit already set the theme's locale: kept.
    await writeFile(path, wrapHtml5Document("Oi", "<p>Hi</p>").replace("<html>", '<html lang="en">'));
    expect(await ensureShipBodyLang(source, "pages/index.html")).toBe(false);
    expect(await readFile(path, "utf8")).toContain('<html lang="en">');
  });

  it("never touches lang in --html or --dir files, which are the caller's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ravi-pages-ship-lang-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "index.html"), "<html><p>sem lang</p></html>");
    for (const input of [{ dir }, { html: join(dir, "index.html") }]) {
      const source = await materializeShipSource({ ...input, entrypoint: "index.html", title: "X" });
      tempDirs.push(source.path);
      expect(await ensureShipBodyLang(source, "index.html")).toBe(false);
      expect(await readFile(join(source.path, "index.html"), "utf8")).toBe("<html><p>sem lang</p></html>");
    }
  });

  it("does not copy the temp root into itself when --dir contains the system temp dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ravi-pages-ship-tmproot-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "report.html"), "<h1>R</h1>");
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "a.css"), "a{}");
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    let source: Awaited<ReturnType<typeof materializeShipSource>>;
    try {
      source = await materializeShipSource({ dir, entrypoint: "report.html", title: "R" });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    // The temp root was created inside the source and left out of its own copy.
    expect(dirname(source.path)).toBe(dir);
    expect((await readdir(source.path)).sort()).toEqual(["assets", "report.html"]);
    expect(await readFile(join(source.path, "assets", "a.css"), "utf8")).toBe("a{}");
    await source.cleanup?.();
  });

  it("materializes --dir as a private copy and never writes to the caller's folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ravi-pages-ship-dir-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "index.html"), "<h1>Dir</h1>");
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "app.css"), "body{}");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref");
    await writeFile(join(dir, ".DS_Store"), "x");
    await symlink("index.html", join(dir, "alias.html"));

    const source = await materializeShipSource({ dir, entrypoint: "index.html", title: "Dir" });
    expect(source.kind).toBe("dir");
    expect(source.path).not.toBe(dir);
    expect((await readdir(source.path)).sort()).toEqual(["alias.html", "assets", "index.html"]);
    expect(await readFile(join(source.path, "assets", "app.css"), "utf8")).toBe("body{}");
    // Symlinks stay symlinks, so the package step refuses them as before.
    expect(await readlink(join(source.path, "alias.html"))).toBe("index.html");

    await writeFile(join(source.path, "index.html"), "<h1>Rewritten</h1>");
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>Dir</h1>");
    await source.cleanup?.();
    await expect(readdir(source.path)).rejects.toThrow();
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("<h1>Dir</h1>");
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
