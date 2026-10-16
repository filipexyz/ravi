/** Test-only fake Console Library (spec `console/library` CLI contract). */

import { createHash } from "node:crypto";

import { ConsoleApiClient } from "../cloud-auth/client.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { LibraryClient, type LibrarySession } from "./client.js";
import { libraryContentHash } from "./package.js";
import type { LibraryItem, LibraryVersionFile } from "./types.js";

export const FAKE_CONSOLE_URL = "https://console.test";

export function fakeCredentials(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    version: 1,
    consoleUrl: FAKE_CONSOLE_URL,
    installationId: "inst-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: null,
    scopes: ["console.projects.read", "console.projects.link"],
    user: { id: "user-1", email: "op@example.com", name: "Op" },
    organization: { id: "org-1", slug: "acme", name: "Acme" },
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

export interface FakeLibrarySkill {
  item: LibraryItem;
  files: LibraryVersionFile[];
}

export function fakeSkill(input: {
  slug: string;
  project?: string | null;
  description?: string;
  version?: number;
  externalAllowed?: boolean;
  body?: string;
}): FakeLibrarySkill {
  const content = `---\nname: ${input.slug}\ndescription: ${input.description ?? `About ${input.slug}`}\n---\n\n${input.body ?? `# ${input.slug}\n`}`;
  const files: LibraryVersionFile[] = [
    { path: "SKILL.md", content, bytes: Buffer.byteLength(content), sha256: sha(content) },
    {
      path: "references/guia.md",
      content: "# Guia\n",
      bytes: 7,
      sha256: sha("# Guia\n"),
    },
  ];
  const project = input.project ? { id: `p-${input.project}`, slug: input.project, name: input.project } : null;
  return {
    item: {
      ref: project ? `${project.slug}/${input.slug}` : `org/${input.slug}`,
      kind: "skill",
      scope: project ? "project" : "org",
      project,
      slug: input.slug,
      name: input.slug,
      description: input.description ?? `About ${input.slug}`,
      externalAllowed: input.externalAllowed === true,
      version: input.version ?? 1,
      contentHash: libraryContentHash(files),
      publishedAt: "2026-10-13T00:00:00.000Z",
      publishedBy: { name: "Op" },
      archived: false,
      updatedAt: "2026-10-13T00:00:00.000Z",
    },
    files,
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface FakeConsole {
  skills: FakeLibrarySkill[];
  requests: Array<{ method: string; path: string; body?: unknown; authorization?: string | null }>;
  offline: boolean;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake Console answering the Library routes; `offline` makes every call throw like a dead network. */
export function createFakeConsole(skills: FakeLibrarySkill[] = []): FakeConsole {
  const state: FakeConsole = {
    skills,
    requests: [],
    offline: false,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers);
      state.requests.push({
        method,
        path: `${parsed.pathname}${parsed.search}`,
        body,
        authorization: headers.get("authorization"),
      });
      if (state.offline) throw new TypeError("fetch failed: connect ECONNREFUSED");
      const root = "/api/cli/library/skills";
      if (!parsed.pathname.startsWith(root)) return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
      const rest = parsed.pathname
        .slice(root.length)
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      const project = parsed.searchParams.get("project");
      const inView = (skill: FakeLibrarySkill) =>
        skill.item.scope === "org" || (project !== null && skill.item.project?.slug === project);
      if (method === "GET" && rest.length === 0) {
        const q = (parsed.searchParams.get("q") ?? "").toLowerCase();
        const items = state.skills
          .filter(inView)
          .filter(
            (skill) => !q || skill.item.slug.includes(q.split(" ")[0] ?? "") || skill.files[0]!.content.includes(q),
          )
          .map((skill) => ({ ...skill.item, score: 0.5 }));
        return json(200, { items, query: q, project: project ? { slug: project } : null });
      }
      const show = (skill: FakeLibrarySkill | undefined) =>
        skill
          ? json(200, {
              item: skill.item,
              version: {
                number: skill.item.version,
                note: null,
                contentHash: skill.item.contentHash,
                publishedAt: skill.item.publishedAt,
                files: skill.files,
              },
            })
          : json(404, { error: { code: "NOT_FOUND", message: "Library skill not found." } });
      if (method === "GET" && rest.length === 1) {
        return show(state.skills.find((skill) => skill.item.slug === rest[0] && inView(skill)));
      }
      if (method === "GET" && rest.length === 2) {
        const [scope, slug] = rest as [string, string];
        return show(
          state.skills.find(
            (skill) =>
              skill.item.slug === slug &&
              (scope === "org" ? skill.item.scope === "org" : skill.item.project?.slug === scope),
          ),
        );
      }
      if (method === "POST" && rest.length === 0) {
        const input = body as {
          scope: "org" | "project";
          project?: string;
          slug: string;
          description: string;
          externalAllowed: boolean;
          baseVersion: number;
          files: Array<{ path: string; content: string }>;
        };
        const existing = state.skills.find(
          (skill) =>
            skill.item.slug === input.slug &&
            (input.scope === "org" ? skill.item.scope === "org" : skill.item.project?.slug === input.project),
        );
        const current = existing?.item.version ?? 0;
        if (input.baseVersion !== current) {
          return json(409, {
            error: {
              code: "CONFLICT",
              message: "The published version changed.",
              details: { reason: "stale_base", currentVersion: current },
            },
          });
        }
        const files = input.files.map((file) => ({
          ...file,
          bytes: Buffer.byteLength(file.content),
          sha256: sha(file.content),
        }));
        const contentHash = libraryContentHash(files);
        if (existing && existing.item.contentHash === contentHash) {
          return json(200, {
            item: existing.item,
            version: { number: current, contentHash },
            unchanged: true,
          });
        }
        const next = fakeSkill({
          slug: input.slug,
          project: input.scope === "project" ? (input.project ?? null) : null,
          description: input.description,
          version: current + 1,
          externalAllowed: input.externalAllowed,
        });
        next.files = files;
        next.item.contentHash = contentHash;
        state.skills = [...state.skills.filter((skill) => skill !== existing), next];
        return json(201, { item: next.item, version: { number: next.item.version, contentHash }, unchanged: false });
      }
      return json(404, { error: { code: "NOT_FOUND", message: "nope" } });
    },
  };
  return state;
}

/** A session over the fake Console, bound to a project (or none). */
export function fakeSession(
  fake: FakeConsole,
  project: { slug: string; id?: string } | null = null,
  orgId = "org-1",
): LibrarySession {
  const credentials = fakeCredentials();
  return {
    client: new LibraryClient({
      client: new ConsoleApiClient({ consoleUrl: FAKE_CONSOLE_URL, fetch: fake.fetch }),
      credentials,
      write: () => {},
      delete: () => {},
    }),
    consoleUrl: FAKE_CONSOLE_URL,
    orgId,
    project: project ? { ref: project.slug, slug: project.slug, id: project.id ?? `p-${project.slug}` } : null,
  };
}
