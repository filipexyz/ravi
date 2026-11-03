import { describe, expect, test } from "bun:test";

import { CliApiError } from "@/server/cli/errors";

import { handleLibraryCliRequest } from "./cli";
import { isLibrarySlug, isSafeLibraryPath, libraryContentHash, LIBRARY_LIMITS, prepareLibraryFiles } from "./files";
import { isReservedLibrarySlug } from "./reserved";
import { buildLibraryTsQuery, librarySearchParts, normalizeLibrarySearchText } from "./search";

const skill = (content = "---\nname: agenda\ndescription: Agenda\n---\nbody") => ({ path: "SKILL.md", content });

function caught(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error as CliApiError;
  }
  throw new Error("expected an error");
}

describe("library files", () => {
  test("slugs are 1-64 lowercase letters, digits and inner dashes", () => {
    expect(isLibrarySlug("a")).toBe(true);
    expect(isLibrarySlug("agenda-semanal")).toBe(true);
    expect(isLibrarySlug("a".repeat(64))).toBe(true);
    expect(isLibrarySlug("a".repeat(65))).toBe(false);
    expect(isLibrarySlug("-agenda")).toBe(false);
    expect(isLibrarySlug("agenda-")).toBe(false);
    expect(isLibrarySlug("Agenda")).toBe(false);
    expect(isLibrarySlug("agenda_semanal")).toBe(false);
  });

  test("paths are relative and never climb", () => {
    expect(isSafeLibraryPath("SKILL.md")).toBe(true);
    expect(isSafeLibraryPath("references/api.md")).toBe(true);
    for (const path of ["", "/SKILL.md", "a//b", "../x", "a/../b", "./a", "a/.", "a b.md", "a\\b"]) {
      expect(isSafeLibraryPath(path)).toBe(false);
    }
  });

  test("a version needs SKILL.md, unique paths and stays within the limits", () => {
    expect(caught(() => prepareLibraryFiles([])).code).toBe("PAYLOAD_INVALID");
    expect(caught(() => prepareLibraryFiles([{ path: "README.md", content: "x" }])).message).toContain("SKILL.md");
    expect(caught(() => prepareLibraryFiles([skill(), skill()])).message).toContain("Duplicate");
    const big = "x".repeat(LIBRARY_LIMITS.maxFileBytes + 1);
    expect(caught(() => prepareLibraryFiles([skill(big)])).message).toContain("KiB");
    const chunk = "y".repeat(LIBRARY_LIMITS.maxFileBytes);
    const many = [skill(), ...[1, 2, 3, 4].map((n) => ({ path: `references/${n}.md`, content: chunk }))];
    expect(caught(() => prepareLibraryFiles(many)).message).toContain("MiB");
    const tooMany = [skill(), ...Array.from({ length: LIBRARY_LIMITS.maxFiles }, (_, n) => ({ path: `r/${n}.md`, content: "" }))];
    expect(caught(() => prepareLibraryFiles(tooMany)).message).toContain("files");
  });

  test("the content hash ignores file order and counts UTF-8 bytes", () => {
    const a = prepareLibraryFiles([skill("é"), { path: "references/a.md", content: "a" }]);
    const b = prepareLibraryFiles([{ path: "references/a.md", content: "a" }, skill("é")]);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.files.map((file) => file.path)).toEqual(["SKILL.md", "references/a.md"]);
    expect(a.totalBytes).toBe(3);
    expect(libraryContentHash(a.files)).toBe(a.contentHash);
    expect(prepareLibraryFiles([skill("è")]).contentHash).not.toBe(prepareLibraryFiles([skill("é")]).contentHash);
  });

  test("Ravi's own skill names and the ravi- prefix are reserved", () => {
    expect(isReservedLibrarySlug("pages")).toBe(true);
    expect(isReservedLibrarySlug("solucoes")).toBe(true);
    expect(isReservedLibrarySlug("ravi-anything")).toBe(true);
    expect(isReservedLibrarySlug("agenda-semanal")).toBe(false);
  });
});

describe("library search text", () => {
  test("normalizes case, accents and punctuation", () => {
    expect(normalizeLibrarySearchText("Relatório Semanal: Clínica!")).toBe("relatorio semanal clinica");
  });

  test("builds an OR of prefix terms with no operator from the query", () => {
    expect(buildLibraryTsQuery("Relatório  semanal")).toBe("relatorio:* | semanal:*");
    expect(buildLibraryTsQuery("a & b | !c:*")).toBe("a:* | b:* | c:*");
    expect(buildLibraryTsQuery("  !!  ")).toBeNull();
    expect(buildLibraryTsQuery(Array.from({ length: 20 }, (_, n) => `t${n}`).join(" "))?.split(" | ")).toHaveLength(12);
  });

  test("splits the slug and name from the description and body", () => {
    const parts = librarySearchParts({ slug: "agenda-semanal", name: "Agenda", description: "Marca consultas", body: "Corpo" });
    expect(parts.head).toBe("agenda semanal agenda");
    expect(parts.description).toBe("marca consultas");
    expect(parts.body).toBe("corpo");
  });
});

describe("library CLI envelope", () => {
  const auth = (scopes: string[]) => ({
    scopes,
    user: { id: "u" },
    organization: { id: "o" },
    membership: { role: "owner" },
    // authenticateCliRequest always carries the verified installation, session and token id.
    localInstallation: { id: "i" },
    cliSession: { id: "s" },
    accessTokenJti: "j",
  });

  test("reads need console.projects.read and writes need console.projects.link", async () => {
    const read = handleLibraryCliRequest({
      auth: auth(["console.projects.link"]) as never,
      requestId: "r",
      origin: "https://console.test",
      method: "GET",
      segments: ["skills"],
      body: {},
      searchParams: new URLSearchParams(),
    });
    await expect(read).rejects.toMatchObject({ status: 403, message: expect.stringContaining("console.projects.read") });
    const write = handleLibraryCliRequest({
      auth: auth(["console.projects.read"]) as never,
      requestId: "r",
      origin: "https://console.test",
      method: "POST",
      segments: ["skills"],
      body: {},
      searchParams: new URLSearchParams(),
    });
    await expect(write).rejects.toMatchObject({ status: 403, message: expect.stringContaining("console.projects.link") });
  });

  test("unknown kinds are not found", async () => {
    for (const segment of ["gadgets", "constructor"]) {
      const request = handleLibraryCliRequest({
        auth: auth(["console.projects.read"]) as never,
        requestId: "r",
        origin: "https://console.test",
        method: "GET",
        segments: [segment],
        body: {},
        searchParams: new URLSearchParams(),
      });
      await expect(request).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  });
});
