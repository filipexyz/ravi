import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudAuthError } from "../cloud-auth/errors.js";
import {
  materializeShipSource,
  requireShipTitle,
  resolveShipContentKind,
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
});
